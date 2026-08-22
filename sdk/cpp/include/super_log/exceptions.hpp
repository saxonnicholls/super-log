//
//  exceptions.hpp
//  super-log C++ SDK
//
//  Copyright 2026 Saxon Herschel Nicholls
//
//  Catch what nobody caught. Two hooks, both chaining rather than
//  replacing, so whatever diagnostics you already had still happen:
//
//      superlog::install_terminate_handler(bat, who);   // uncaught exceptions
//      superlog::install_crash_handler(bat);            // SIGSEGV and friends
//
//  What each can honestly promise is different, and the difference matters:
//
//    - terminate: a real handler. std::current_exception() gives us the
//      exception, so the message and type reach the bench, and the batcher
//      is still alive to POST it before the previous handler ends the
//      process.
//    - crash: a SIGNAL handler, where almost nothing is legal - not
//      malloc, not std::string, not a mutex, and therefore not our batcher
//      (POSIX async-signal-safety; a logger that deadlocks the crashing
//      process is worse than one that says nothing). So it does the only
//      safe thing: write(2) a fixed line to stderr and re-raise with the
//      default handler, so the core dump and exit status are unchanged.
//      The line names the signal; the bench gets nothing, on purpose.
//      For real crash capture use a dedicated reporter that writes a
//      minidump from a separate process - that is not this tool's job.
//

#ifndef super_log_exceptions_hpp
#define super_log_exceptions_hpp

#include "event.hpp"
#include "transport.hpp"

#include <csignal>
#include <cstring>
#include <exception>
#include <memory>
#include <string>
#include <typeinfo>
#include <unistd.h>
#include <utility>
#include <vector>

#if defined(__has_include)
#if __has_include(<execinfo.h>) && __has_include(<cxxabi.h>)
#define SUPERLOG_HAS_BACKTRACE 1
#include <cxxabi.h>
#include <execinfo.h>
#include <cstdlib>
#endif
#endif
#ifndef SUPERLOG_HAS_BACKTRACE
#define SUPERLOG_HAS_BACKTRACE 0
#endif

namespace superlog {

// A demangled backtrace of the calling thread - what boost::stacktrace
// gives you, from execinfo.h and cxxabi.h, which macOS and glibc both
// ship, so it costs no dependency.
//
// Two things to know, both about symbol quality rather than correctness:
//   - Build with -g, and on Linux link with -rdynamic (or
//     -Wl,--export-dynamic), or static and internal functions come back as
//     "image + offset" with no name. On macOS exported symbols resolve
//     without extra flags.
//   - Inlined frames do not appear; they are not on the stack to find.
//     -O0/-Og during a debugging session is the honest fix.
//
// Safe to call anywhere EXCEPT a signal handler: it allocates.
inline std::string stacktrace(int skip = 1, int max_frames = 64)
{
#if !SUPERLOG_HAS_BACKTRACE
    (void)skip;
    (void)max_frames;
    return {};
#else
    if (max_frames > 256)
        max_frames = 256;
    std::vector<void*> frames(static_cast<std::size_t>(max_frames));
    const int n = ::backtrace(frames.data(), max_frames);
    if (n <= skip)
        return {};
    char** symbols = ::backtrace_symbols(frames.data(), n);
    if (!symbols)
        return {};
    std::string out;
    int printed = 0;
    for (int i = skip; i < n; ++i) {
        std::string line = symbols[i] ? symbols[i] : "";
        // macOS prints "idx image addr _Zmangled + off"; glibc prints
        // "image(_Zmangled+0x..) [0x..]". Rather than parse either format,
        // find the Itanium-mangled token and swap it for the real name.
        const std::size_t at = line.find("_Z");
        if (at != std::string::npos) {
            std::size_t end = at;
            while (end < line.size() && (std::isalnum(static_cast<unsigned char>(line[end])) ||
                                         line[end] == '_' || line[end] == '$' || line[end] == '.'))
                ++end;
            int status = 0;
            char* pretty = abi::__cxa_demangle(line.substr(at, end - at).c_str(),
                                               nullptr, nullptr, &status);
            if (status == 0 && pretty) {
                line = line.substr(0, at) + pretty + line.substr(end);
                std::free(pretty);
            }
        }
        if (!out.empty())
            out += '\n';
        out += line;
        if (++printed >= max_frames)
            break;
    }
    std::free(symbols);
    return out;
#endif
}

namespace detail {

// Drop the leading frames that belong to the C++ runtime's unwinder, so the
// trace starts at the code that actually threw. Only leading ones: the same
// names deeper down are real frames of a program that calls into them.
inline std::string trim_runtime_frames(const std::string& trace)
{
    static const char* runtime[] = {"libc++abi", "libstdc++", "libgcc_s",
                                    "__cxa_", "_Unwind_", "std::terminate"};
    std::string out;
    bool leading = true;
    std::size_t from = 0;
    while (from <= trace.size()) {
        const std::size_t nl = trace.find('\n', from);
        const std::string line = trace.substr(from, nl == std::string::npos ? std::string::npos : nl - from);
        if (leading) {
            bool is_runtime = false;
            for (const char* r : runtime)
                if (line.find(r) != std::string::npos) {
                    is_runtime = true;
                    break;
                }
            if (is_runtime) {
                if (nl == std::string::npos)
                    break;
                from = nl + 1;
                continue;
            }
            leading = false;
        }
        if (!out.empty())
            out += '\n';
        out += line;
        if (nl == std::string::npos)
            break;
        from = nl + 1;
    }
    return out;
}

inline std::terminate_handler& previous_terminate()
{
    static std::terminate_handler h = nullptr;
    return h;
}

inline std::shared_ptr<batcher>& terminate_batcher()
{
    static std::shared_ptr<batcher> b;
    return b;
}

inline origin& terminate_origin()
{
    static origin o;
    return o;
}

inline std::string& terminate_session()
{
    static std::string s;
    return s;
}

inline void on_terminate()
{
    // What was thrown, if anything - terminate is also reached by a bare
    // std::terminate() call, where there is no active exception.
    std::string what = "std::terminate called with no active exception";
    if (auto e = std::current_exception()) {
        try {
            std::rethrow_exception(e);
        } catch (const std::exception& ex) {
            what = std::string("uncaught ") + typeid(ex).name() + ": " + ex.what();
        } catch (...) {
            what = "uncaught exception of non-std type";
        }
    }
    // The stack is still intact here: for an uncaught exception the
    // implementation calls terminate *without* unwinding, so the throwing
    // frames are on it (verified on libc++ - the throwing function, its
    // callers and main are all present). Between us and the throw sit a
    // few unwinder frames; how many is implementation detail, so drop them
    // by image rather than by a magic count.
    std::vector<std::pair<std::string, std::string>> fields{{"where", "uncaught"}};
    // skip 2: stacktrace() itself and this handler; trim then eats the
    // unwinder frames between here and the throw.
    if (std::string trace = detail::trim_runtime_frames(stacktrace(/*skip=*/2)); !trace.empty())
        fields.emplace_back("stack", std::move(trace));

    if (auto& b = detail::terminate_batcher()) {
        b->enqueue(make_event_json("CRITICAL", what, detail::terminate_origin(),
                                   detail::terminate_session(), 0, "exception",
                                   std::string(), fields));
        // The batcher's worker drains on its own clock; this process is
        // about to end, so give the POST a moment rather than none.
        b->flush_now(std::chrono::milliseconds(1500));
    }
    if (detail::previous_terminate())
        detail::previous_terminate()();
    std::abort();
}

// Signal handlers may only call async-signal-safe functions. write() is;
// snprintf, string and our batcher are not.
inline void on_fatal_signal(int sig)
{
    const char* name = sig == SIGSEGV ? "SIGSEGV" : sig == SIGBUS ? "SIGBUS"
                     : sig == SIGFPE  ? "SIGFPE"  : sig == SIGILL ? "SIGILL"
                     : sig == SIGABRT ? "SIGABRT" : "signal";
    const char* pre = "super-log: fatal ";
    const char* post = " - not logged to the hub (signal handlers cannot allocate)\n";
    ssize_t r = ::write(STDERR_FILENO, pre, std::strlen(pre));
    r = ::write(STDERR_FILENO, name, std::strlen(name));
    r = ::write(STDERR_FILENO, post, std::strlen(post));
    (void)r;
    // Restore the default and re-raise, so the core dump and exit status
    // are exactly what they would have been.
    std::signal(sig, SIG_DFL);
    std::raise(sig);
}

} // namespace detail

// Log uncaught exceptions as CRITICAL, then chain to the handler that was
// already installed. Call once at startup, after the batcher exists.
inline void install_terminate_handler(std::shared_ptr<batcher> b, origin o,
                                      std::string session = make_session())
{
    detail::terminate_batcher() = std::move(b);
    detail::terminate_origin() = std::move(o);
    detail::terminate_session() = std::move(session);
    detail::previous_terminate() = std::set_terminate(&detail::on_terminate);
}

// Say on stderr that a fatal signal happened, then die exactly as before.
// Deliberately does NOT reach the hub - see the header comment.
inline void install_crash_handler()
{
    for (int sig : {SIGSEGV, SIGBUS, SIGFPE, SIGILL})
        std::signal(sig, &detail::on_fatal_signal);
}

} // namespace superlog

#endif /* super_log_exceptions_hpp */
