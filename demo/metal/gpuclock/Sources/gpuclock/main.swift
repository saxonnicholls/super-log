//
//  demo/metal/gpuclock - GPU work on the bench, with no GPU logger.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  The point of this demo is what is NOT here. There is no Metal support in
//  super-log, no GPU plugin, and nothing graphics-shaped in the Swift SDK -
//  because a graphics API already hands you a severity and a message, and
//  forwarding it is the whole integration. This is that integration, and it
//  is about fifteen lines.
//
//  What it adds over logging "frame done" is the number that actually
//  matters: `gpuStartTime` and `gpuEndTime` are the GPU's own clock, so a
//  pass that takes 0.7 ms on the card reads as 0.7 ms even when the CPU
//  blocked for 12 ms waiting on it. Wall-clock timing around `commit()`
//  measures your thread, not the GPU.
//
//    swift run --package-path demo/metal/gpuclock gpuclock
//    SUPER_LOG_URL=http://127.0.0.1:7333 swift run ... gpuclock
//
//  Blit copies are used rather than a compute kernel on purpose: they are
//  real GPU work, they saturate memory bandwidth, and they need no compiled
//  shader - so this runs on a clean machine without the Metal shader
//  toolchain, which is a separate multi-gigabyte download.
//
//  Publishes to gpu.metal.clock. For the card itself - utilisation, memory,
//  temperature, and the same over ssh - see `superlog-gpu`, which needs no
//  code in your app at all.
//

import Metal
import Foundation
import SuperLog

let hub = ProcessInfo.processInfo.environment["SUPER_LOG_URL"] ?? "http://127.0.0.1:7333"
let log = try SuperLog(topic: "gpu.metal.clock", app: "gpuclock",
                       url: hub, development: true)

guard let device = MTLCreateSystemDefaultDevice(),
      let queue = device.makeCommandQueue() else {
    // A machine with no Metal device is a fact to report, not a crash.
    log.error("no Metal device available")
    log.flush(timeout: 2.0)
    log.close()
    exit(1)
}

log.info("metal up on \(device.name)", fields: [
    "device": device.name,
    "vram_mb": "\(device.recommendedMaxWorkingSetSize / 1048576)",
    "unified_memory": "\(device.hasUnifiedMemory)",
    "max_threads_per_group": "\(device.maxThreadsPerThreadgroup.width)",
])

// A deliberate failure, because a demo in which nothing ever goes wrong
// demonstrates nothing about a logger. Asking for four times the card's
// memory is refused by the driver rather than by a crash.
let absurd = device.recommendedMaxWorkingSetSize * 4
if device.makeBuffer(length: Int(absurd), options: .storageModePrivate) == nil {
    log.error("buffer allocation refused: \(absurd / 1048576) MiB requested, " +
              "card has \(device.recommendedMaxWorkingSetSize / 1048576) MiB",
              fields: ["requested_mb": "\(absurd / 1048576)",
                       "available_mb": "\(device.recommendedMaxWorkingSetSize / 1048576)"])
}

let sizesMiB = [4, 16, 64, 128, 256]
let rounds = Int(ProcessInfo.processInfo.environment["SUPER_LOG_ROUNDS"] ?? "") ?? 4
var buffers = 0

for round in 1...max(1, rounds) {
    for mib in sizesMiB {
        let bytes = mib * 1024 * 1024
        guard let src = device.makeBuffer(length: bytes, options: .storageModePrivate),
              let dst = device.makeBuffer(length: bytes, options: .storageModePrivate),
              let cb = queue.makeCommandBuffer(),
              let blit = cb.makeBlitCommandEncoder() else {
            log.warn("skipped a \(mib) MiB copy - allocation failed", fields: ["mb": "\(mib)"])
            continue
        }
        buffers += 1
        cb.label = "blit-\(mib)MiB"
        blit.copy(from: src, sourceOffset: 0, to: dst, destinationOffset: 0, size: bytes)
        blit.endEncoding()

        // THIS is the integration. Everything above is just having something
        // for the GPU to do.
        cb.addCompletedHandler { done in
            if let e = done.error {
                // Where a device removal, a timeout and an out-of-memory all
                // arrive - the three GPU failures worth waking up for.
                log.error("GPU command buffer failed: \(e.localizedDescription)",
                          fields: ["label": done.label ?? "?"])
                return
            }
            let ms = (done.gpuEndTime - done.gpuStartTime) * 1000.0
            let gibs = Double(bytes) / (ms / 1000.0) / 1_073_741_824.0
            log.metric("gpu.commandbuffer_ms", ms)
            log.metric("gpu.copy_gib_s", gibs)
            log.info("\(done.label ?? "command buffer") took " +
                     "\(String(format: "%.3f", ms))ms on the GPU " +
                     "(\(String(format: "%.1f", gibs)) GiB/s)",
                     fields: ["label": done.label ?? "?",
                              "round": "\(round)",
                              "mb": "\(mib)",
                              "allocated_mb": "\(device.currentAllocatedSize / 1048576)"])
        }
        cb.commit()
        cb.waitUntilCompleted()
        Thread.sleep(forTimeInterval: 0.6)
    }
    log.metric("gpu.allocated_mb", Double(device.currentAllocatedSize) / 1048576.0)
}

log.info("metal clock down after \(buffers) command buffers", fields: ["buffers": "\(buffers)"])
log.flush(timeout: 3.0)
log.close()
