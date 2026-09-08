//
//  transport.hpp
//  super-log C++ SDK
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  The batching half of the SDK: events go into a bounded queue from any
//  thread, one worker thread drains them into NDJSON chunks and POSTs each
//  chunk to superlogd. Producers never block on the network - the queue is
//  bounded and drops oldest, counted, exactly the trade the ts-moveables
//  logger makes and for the same reason.
//
//  The POST itself is a deliberately small blocking HTTP/1.1 client written
//  here rather than imported: ts-moveables ships a WebSocket client but no
//  plain HTTP client, the hub is one connect() away on the dev LAN, and only
//  the worker thread ever pays the latency. When the hub grows a WebSocket
//  ingest route (HANDOFF.md, M5) this file is where the transport swaps.
//

#ifndef super_log_transport_hpp
#define super_log_transport_hpp

#include "mode.hpp"             // DEVELOPMENT xor PRODUCTION, enforced

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <cstring>
#include <deque>
#include <mutex>
#include <string>
#include <thread>
#include <utility>

#ifdef _WIN32
#  include <winsock2.h>
#  include <ws2tcpip.h>
#  if defined(_MSC_VER)
#    pragma comment(lib, "ws2_32.lib")   // auto-link Winsock under MSVC
#  endif
#else
#  include <netdb.h>
#  include <sys/socket.h>
#  include <sys/types.h>
#  include <unistd.h>
#endif

namespace superlog {

struct transport_config {
    std::string host = "127.0.0.1";
    std::uint16_t port = 7333;
    std::string topic = "cpp.app";                  // see PROTOCOL.md topic table
    std::size_t max_batch = 256;                    // events per POST
    std::chrono::milliseconds flush_interval{250};
    std::size_t max_queue = 8192;                   // events in flight
};

namespace detail {

// One socket type and a handful of helpers so the POST below reads the same
// on POSIX and Windows. Winsock's socket is an unsigned handle (INVALID_SOCKET,
// closesocket) and needs a process-wide WSAStartup; POSIX is an int fd.
#ifdef _WIN32
using socket_t = SOCKET;
inline bool socket_valid(socket_t s) { return s != INVALID_SOCKET; }
inline void socket_close(socket_t s) { ::closesocket(s); }
inline const socket_t bad_socket = INVALID_SOCKET;
// A function-local static inits Winsock exactly once, thread-safely, and
// tears it down at process exit - no burden on the call site.
inline void ensure_winsock() {
    static struct wsa_guard {
        wsa_guard() { WSADATA d; ::WSAStartup(MAKEWORD(2, 2), &d); }
        ~wsa_guard() { ::WSACleanup(); }
    } guard;
    (void)guard;
}
#else
using socket_t = int;
inline bool socket_valid(socket_t s) { return s >= 0; }
inline void socket_close(socket_t s) { ::close(s); }
inline const socket_t bad_socket = -1;
inline void ensure_winsock() {}
#endif

// One POST, one connection. Returns true on any 2xx. Connection: close keeps
// this at "read a little, done" - keep-alive is an optimisation for later,
// measured first.
inline bool http_post(const std::string& host, std::uint16_t port,
                      const std::string& path, const std::string& body)
{
    ensure_winsock();
    addrinfo hints{};
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    addrinfo* res = nullptr;
    if (::getaddrinfo(host.c_str(), std::to_string(port).c_str(), &hints, &res) != 0)
        return false;
    socket_t fd = bad_socket;
    for (addrinfo* a = res; a; a = a->ai_next) {
        fd = ::socket(a->ai_family, a->ai_socktype, a->ai_protocol);
        if (!socket_valid(fd))
            continue;
        if (::connect(fd, a->ai_addr, static_cast<int>(a->ai_addrlen)) == 0)
            break;
        socket_close(fd);
        fd = bad_socket;
    }
    ::freeaddrinfo(res);
    if (!socket_valid(fd))
        return false;
#ifdef SO_NOSIGPIPE
    // A hub restart between our write()s must be a failed POST, not SIGPIPE
    int one = 1;
    ::setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, reinterpret_cast<const char*>(&one), sizeof one);
#endif
    std::string req = "POST " + path + " HTTP/1.1\r\nHost: " + host +
                      "\r\nContent-Type: application/x-ndjson\r\nContent-Length: " +
                      std::to_string(body.size()) + "\r\nConnection: close\r\n\r\n" + body;
    std::size_t off = 0;
    while (off < req.size()) {
        const std::size_t left = req.size() - off;
#ifdef _WIN32
        const int n = ::send(fd, req.data() + off, static_cast<int>(left), 0);
#elif defined(MSG_NOSIGNAL)
        const ssize_t n = ::send(fd, req.data() + off, left, MSG_NOSIGNAL);
#else
        const ssize_t n = ::send(fd, req.data() + off, left, 0);
#endif
        if (n <= 0) {
            socket_close(fd);
            return false;
        }
        off += static_cast<std::size_t>(n);
    }
    char buf[64];
#ifdef _WIN32
    const int n = ::recv(fd, buf, static_cast<int>(sizeof buf), 0);
#else
    const ssize_t n = ::recv(fd, buf, sizeof buf, 0);
#endif
    socket_close(fd);
    // "HTTP/1.1 2xx ..." - the status class is all we need
    return n >= 10 && buf[9] == '2';
}

} // namespace detail

// The worker. Create one per process (or per topic), share it between sinks
// via shared_ptr, declare it BEFORE any logger whose sink captures it - the
// same lifetime rule as ts-moveables sinks, for the same reason. In
// PRODUCTION builds (mode.hpp) it is an inert shell: no thread, no socket,
// enqueue discards - call sites do not change, the wire just goes silent.
class batcher {
public:
    explicit batcher(transport_config cfg)
        : cfg_(std::move(cfg)), path_("/ingest/" + cfg_.topic)
    {
#if SUPERLOG_ENABLED
        // Started in the body, not the init list: run() must see every
        // member built.
        worker_ = std::thread([this] { run(); });
#endif
    }

    ~batcher()
    {
        {
            std::lock_guard<std::mutex> g(m_);
            stop_ = true;
        }
        cv_.notify_all();
        if (worker_.joinable())
            worker_.join();
    }

    batcher(const batcher&) = delete;
    batcher& operator=(const batcher&) = delete;

    // Any thread. Never blocks on the network; drops oldest when full.
    void enqueue(std::string ndjson_line)
    {
#if !SUPERLOG_ENABLED
        (void)ndjson_line;
#else
        bool wake = false;
        {
            std::lock_guard<std::mutex> g(m_);
            if (q_.size() >= cfg_.max_queue) {
                q_.pop_front();
                dropped_.fetch_add(1, std::memory_order_relaxed);
            }
            q_.push_back(std::move(ndjson_line));
            wake = q_.size() >= cfg_.max_batch;
        }
        if (wake)
            cv_.notify_one();
#endif
    }

    // Drain what is queued now, from the calling thread, up to a deadline.
    // For the dying process: terminate handlers and shutdown paths, where
    // waiting for the worker's next tick is a tick that never comes. Safe
    // to call from anywhere EXCEPT a signal handler (it locks and
    // allocates - see exceptions.hpp on why crashes get stderr instead).
    void flush_now(std::chrono::milliseconds budget = std::chrono::milliseconds(1500))
    {
#if SUPERLOG_ENABLED
        const auto deadline = std::chrono::steady_clock::now() + budget;
        for (;;) {
            std::unique_lock<std::mutex> lk(m_);
            if (q_.empty())
                return;
            drain_one(lk);                      // unlocks around the POST
            lk.unlock();
            if (std::chrono::steady_clock::now() >= deadline)
                return;
        }
#else
        (void)budget;
#endif
    }

    std::uint64_t dropped() const noexcept { return dropped_.load(std::memory_order_relaxed); }
    std::uint64_t post_failures() const noexcept { return failures_.load(std::memory_order_relaxed); }

private:
    void run()
    {
        std::unique_lock<std::mutex> lk(m_);
        while (!stop_) {
            cv_.wait_for(lk, cfg_.flush_interval,
                         [this] { return stop_ || q_.size() >= cfg_.max_batch; });
            drain_one(lk);
        }
        while (!q_.empty())                       // final flush: nothing queued is lost on exit
            drain_one(lk);
    }

    // Called with lk held; unlocks around the POST so producers never wait on it
    void drain_one(std::unique_lock<std::mutex>& lk)
    {
        if (q_.empty())
            return;
        std::string body;
        for (std::size_t n = 0; !q_.empty() && n < cfg_.max_batch; ++n) {
            body += q_.front();
            body += '\n';
            q_.pop_front();
        }
        lk.unlock();
        if (!detail::http_post(cfg_.host, cfg_.port, path_, body))
            failures_.fetch_add(1, std::memory_order_relaxed);
        lk.lock();
    }

    transport_config cfg_;
    std::string path_;
    mutable std::mutex m_;
    std::condition_variable cv_;
    std::deque<std::string> q_;
    bool stop_ = false;
    std::atomic<std::uint64_t> dropped_{0}, failures_{0};
    std::thread worker_;                          // default; started by the ctor body
};

} // namespace superlog

#endif /* super_log_transport_hpp */
