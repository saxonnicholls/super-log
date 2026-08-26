//
//  clock.cu - the CUDA demo client
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  The GPU half of the same argument the Metal demo makes: super-log has no
//  CUDA support and does not need any. CUDA already reports its own errors
//  and can already time its own kernels; the integration is forwarding
//  those, and it is about twenty lines.
//
//    cmake --build build --target superlog_clock_cuda -j
//    ./build/demo/cuda/superlog_clock_cuda
//
//  Three things it puts on the bench that a host-side log cannot:
//
//    1. KERNEL TIME, from CUDA events. cudaEventElapsedTime measures the
//       GPU's own clock between two points in the stream, so a kernel that
//       takes 0.4 ms reads as 0.4 ms even when the host blocked for 12 ms.
//       Wrapping the launch in std::chrono times your thread, not the GPU.
//
//    2. PRINTF FROM INSIDE THE KERNEL. Device-side printf goes to a FIFO
//       that is flushed at synchronisation, so a thread can say something
//       and the host sees it. It is guarded by thread index here, because
//       unguarded it is one line per thread and a modest launch is a
//       million lines - which is how the feature gets a bad name.
//
//    3. ASYNCHRONOUS ERRORS. A kernel that faults does not fail at launch;
//       the error surfaces at the next synchronise, often attributed to
//       whatever ran afterwards. Checking after the sync and saying which
//       kernel it was is most of the value.
//
//  Publishes to cuda.clock. Topic namespace from SUPER_LOG_TOPIC_NS.
//
//  NOT VERIFIED: written against the CUDA runtime API but never compiled or
//  run - there is no NVIDIA GPU and no nvcc on the bench it was written on.
//  Treat the first run as a bring-up, not a regression test.
//

#include "event/time_master.hpp"   // ts-moveables: the Legendary TimeMaster
#include <super_log/forward_sink.hpp>

#include <cuda_runtime.h>

#include <atomic>
#include <chrono>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <memory>
#include <string>
#include <vector>

namespace {

std::atomic<bool> g_stop{false};
void on_signal(int) { g_stop.store(true, std::memory_order_relaxed); }

superlog::transport_config config_for(const char* suffix)
{
    superlog::transport_config cfg;
    const char* ns = std::getenv("SUPER_LOG_TOPIC_NS");
    cfg.topic = std::string(ns && *ns ? ns : "cuda") + suffix;
    // SUPER_LOG_URL is what every other SDK here reads.
    if (const char* u = std::getenv("SUPER_LOG_URL"); u && *u) {
        std::string rest = u;
        if (const auto at = rest.find("://"); at != std::string::npos)
            rest = rest.substr(at + 3);
        rest = rest.substr(0, rest.find('/'));
        if (const auto colon = rest.rfind(':'); colon != std::string::npos) {
            cfg.host = rest.substr(0, colon);
            cfg.port = static_cast<std::uint16_t>(std::strtol(rest.c_str() + colon + 1, nullptr, 10));
        } else if (!rest.empty()) {
            cfg.host = rest;
        }
    }
    if (const char* h = std::getenv("SUPER_LOG_HOST"))
        cfg.host = h;
    if (const char* p = std::getenv("SUPER_LOG_PORT"))
        cfg.port = static_cast<std::uint16_t>(std::strtol(p, nullptr, 10));
    return cfg;
}

} // namespace

// A kernel with something to say. The guard is the whole point: without it
// this is one line per thread, and 256K threads is 256K lines that arrive
// as one wall of text after the next synchronise.
__global__ void saxpy(float a, const float* x, float* y, int n, int tick)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n)
        y[i] = a * x[i] + y[i];

    if (i == 0)
        printf("[kernel] tick %d: saxpy over %d elements, a=%.2f\n", tick, n, a);

    // A value a host-side log can never see, because it exists only on the
    // device: the first element after the update.
    if (i == 0 && n > 0)
        printf("[kernel] tick %d: y[0] = %.4f\n", tick, y[0]);
}

// A kernel that faults on purpose, once, so the demo has a red row. The
// fault does NOT appear at launch - it appears at the next synchronise, and
// that asymmetry is the thing worth demonstrating.
__global__ void out_of_bounds(float* p, int n)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    // Deliberately past the end of the allocation.
    p[n + i * 4096] = 1.0f;
}

int main()
{
    auto bat = std::make_shared<superlog::batcher>(config_for(".clock"));
    superlog::origin who;
    who.runtime = "cuda";
    who.app = "clock";

    const std::string session = superlog::make_session();
    std::uint64_t seq = 0;

    auto say = [&](const char* level, const std::string& msg,
                   std::vector<std::pair<std::string, std::string>> fields = {}) {
        bat->enqueue(superlog::make_event_json(level, msg, who, session, seq++,
                                               "cuda", std::string(), fields));
    };
    auto measure = [&](const std::string& name, double value,
                       std::vector<std::pair<std::string, std::string>> fields = {}) {
        bat->enqueue(superlog::make_metric_json(name, value, who, session, seq++,
                                                "cuda", fields));
    };

    int devices = 0;
    if (const cudaError_t e = cudaGetDeviceCount(&devices); e != cudaSuccess || devices == 0) {
        // A machine with no CUDA device is a fact to report, not a crash.
        say("ERROR", std::string("no CUDA device: ") + cudaGetErrorString(e));
        return 1;
    }

    cudaDeviceProp prop{};
    cudaGetDeviceProperties(&prop, 0);
    std::size_t freeB = 0, totalB = 0;
    cudaMemGetInfo(&freeB, &totalB);
    say("INFO", std::string("cuda up on ") + prop.name,
        {{"device", prop.name},
         {"compute", std::to_string(prop.major) + "." + std::to_string(prop.minor)},
         {"sms", std::to_string(prop.multiProcessorCount)},
         {"vram_mb", std::to_string(totalB / (1024 * 1024))},
         {"devices", std::to_string(devices)}});

    // Device printf goes to a fixed-size FIFO. The default is 1MB, which a
    // chatty kernel exhausts silently - output is dropped with no error, and
    // "my printf stopped appearing" is a bad afternoon. Ask for more.
    cudaDeviceSetLimit(cudaLimitPrintfFifoSize, 8u * 1024 * 1024);

    constexpr int N = 1 << 20;             // 1M elements
    constexpr int THREADS = 256;
    const int blocks = (N + THREADS - 1) / THREADS;

    float *dx = nullptr, *dy = nullptr;
    if (cudaMalloc(&dx, N * sizeof(float)) != cudaSuccess ||
        cudaMalloc(&dy, N * sizeof(float)) != cudaSuccess) {
        say("CRITICAL", "cudaMalloc failed for the working set");
        return 1;
    }
    cudaMemset(dx, 0, N * sizeof(float));
    cudaMemset(dy, 0, N * sizeof(float));

    // A deliberate refusal, so a successful run still has one ERROR row: ask
    // for four times the card's memory.
    {
        void* absurd = nullptr;
        const std::size_t want = totalB * 4;
        if (const cudaError_t e = cudaMalloc(&absurd, want); e != cudaSuccess) {
            say("ERROR",
                "cudaMalloc refused " + std::to_string(want / (1024 * 1024)) +
                    " MiB on a " + std::to_string(totalB / (1024 * 1024)) +
                    " MiB card: " + cudaGetErrorString(e),
                {{"requested_mb", std::to_string(want / (1024 * 1024))},
                 {"available_mb", std::to_string(totalB / (1024 * 1024))}});
            cudaGetLastError();      // clear it, or it haunts the next check
        } else {
            cudaFree(absurd);
        }
    }

    cudaEvent_t start{}, stop{};
    cudaEventCreate(&start);
    cudaEventCreate(&stop);

    std::signal(SIGINT, on_signal);
    std::signal(SIGTERM, on_signal);

    // The tick is time_master's job, exactly as in demo/cpp: drift-free
    // periodic scheduling is already written, and a sleep loop drifts by the
    // cost of its own body. run_once with a bounded wait polls the signal
    // atomic without the handler ever touching the scheduler.
    snicholls::time_master tm;
    int tick = 0;
    bool fatal = false;

    tm.add_event(std::chrono::seconds(1), [&] {
        if (fatal)
            return;
        ++tick;

        cudaEventRecord(start);
        saxpy<<<blocks, THREADS>>>(2.0f, dx, dy, N, tick);
        cudaEventRecord(stop);

        // Launch errors are synchronous; faults are not. Both are checked,
        // separately, because they mean different things.
        if (const cudaError_t e = cudaGetLastError(); e != cudaSuccess)
            say("ERROR", std::string("kernel launch failed: ") + cudaGetErrorString(e),
                {{"kernel", "saxpy"}, {"tick", std::to_string(tick)}});

        if (const cudaError_t e = cudaEventSynchronize(stop); e != cudaSuccess) {
            say("CRITICAL", std::string("kernel faulted: ") + cudaGetErrorString(e),
                {{"kernel", "saxpy"}, {"tick", std::to_string(tick)}});
            fatal = true;            // the context is unusable after a fault
            g_stop.store(true, std::memory_order_relaxed);
            return;
        }

        float ms = 0.0f;
        cudaEventElapsedTime(&ms, start, stop);
        // The GPU's own clock, not the host's wait.
        measure("cuda.kernel_ms", ms, {{"kernel", "saxpy"}, {"tick", std::to_string(tick)}});
        // saxpy touches x once and y twice, so three float accesses per element.
        measure("cuda.bandwidth_gib_s",
                (3.0 * N * sizeof(float)) / (ms / 1000.0) / 1073741824.0);

        cudaMemGetInfo(&freeB, &totalB);
        measure("cuda.vram_free_mb", static_cast<double>(freeB) / (1024.0 * 1024.0));

        char msg[128];
        std::snprintf(msg, sizeof msg, "tick %d: saxpy took %.3fms on the GPU", tick, ms);
        say("INFO", msg, {{"tick", std::to_string(tick)}, {"blocks", std::to_string(blocks)}});

        // Once, near the start: prove that an out-of-bounds write surfaces at
        // the SYNCHRONISE and not at the launch. After this the context is
        // dead, so it is the last thing the demo does - which is itself the
        // honest shape of a CUDA fault.
        if (tick == 5 && std::getenv("SUPER_LOG_CUDA_FAULT")) {
            say("WARN", "about to run a deliberately out-of-bounds kernel");
            out_of_bounds<<<1, 32>>>(dy, N);
            const cudaError_t launch = cudaGetLastError();
            say(launch == cudaSuccess ? "INFO" : "ERROR",
                std::string("launch returned: ") + cudaGetErrorString(launch),
                {{"note", "a fault does not appear here"}});
            const cudaError_t sync = cudaDeviceSynchronize();
            say(sync == cudaSuccess ? "WARN" : "CRITICAL",
                std::string("synchronise returned: ") + cudaGetErrorString(sync),
                {{"note", "this is where a fault appears"}});
            fatal = true;
            g_stop.store(true, std::memory_order_relaxed);
            return;
        }
    });

    while (!g_stop.load(std::memory_order_relaxed))
        tm.run_once(std::chrono::milliseconds(200));
    tm.stop();

    say("INFO", "cuda clock down after " + std::to_string(tick) + " ticks",
        {{"ticks", std::to_string(tick)}});

    cudaEventDestroy(start);
    cudaEventDestroy(stop);
    cudaFree(dx);
    cudaFree(dy);
    cudaDeviceReset();               // flushes the printf FIFO
    return 0;
}
