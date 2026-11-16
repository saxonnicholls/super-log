//
//  tests/cuda.test.mjs - superlog-cuda, against a real hub.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  The tailer links no CUDA and runs nothing GPU-specific here: it reads what
//  a CUDA program, the driver, compute-sanitizer and nsys ALREADY print. So
//  the thing to test is the reading - fed the exact strings seen debugging
//  snicholls-gpu (driver faults, NVRTC, a toolchain mismatch, the wrapped
//  exceptions, an nsys kernel table, and the hardest case, a host-side crash
//  the sanitizer passes), does the right event reach the hub at the right
//  level, edge-triggered. The actual ssh/nsys/compute-sanitizer/gdb SPAWNING
//  is exercised on the GPU box, not in CI; its command strings are not CUDA.
//
//  The one path that needs no GPU and must work is the host-crash verdict: a
//  wrapped process that dies on a signal is a signal here as much as on a
//  Blackwell, so that is wrapped for real.
//

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { assertValidEvent, freePort, recent, run, startHub, waitFor } from './harness.mjs';

let hub;
before(async () => { hub = await startHub(); });
after(async () => { await hub?.stop(); });

const feed = (app, stdin, args = []) =>
  run('superlog-cuda.mjs', ['--app', app, ...args], { url: hub.url, stdin, timeoutMs: 20000 });

describe('superlog-cuda', () => {
  it('reports a driver fault once (edge-triggered), with the device output as DEBUG', async () => {
    const topic = 'cuda.t_fault';
    await feed('t_fault',
      'booting\n' +
      'CUDA error at kern.cu:42 code=700(cudaErrorIllegalAddress) "cudaDeviceSynchronize()"\n' +
      'CUDA error at kern.cu:42 code=700(cudaErrorIllegalAddress) "cudaDeviceSynchronize()"\n' +
      'still alive\n');

    const recs = await waitFor(hub.url, (rs) => rs.some((r) => r.event.msg === 'still alive'), { topic });
    const evs = recs.map((r) => r.event);
    evs.forEach((e, i) => assertValidEvent(e, `${topic}[${i}]`));

    const errors = evs.filter((e) => e.level === 'ERROR');
    assert.equal(errors.length, 1, 'the same fault twice is one edge-triggered ERROR');
    assert.equal(errors[0].fields.error, 'cudaErrorIllegalAddress');
    assert.equal(errors[0].fields.file, 'kern.cu');
    assert.ok(evs.filter((e) => e.level === 'DEBUG').length >= 2, 'ordinary lines ride at DEBUG');
  });

  it('turns a compute-sanitizer finding into an ERROR + metric, and a clean pass into recovery', async () => {
    const topic = 'cuda.t_san';
    await feed('t_san',
      '========= COMPUTE-SANITIZER\n' +
      '========= Invalid __global__ read of size 4\n' +
      '========= ERROR SUMMARY: 2 errors\n' +
      '========= ERROR SUMMARY: 0 errors\n');

    const recs = await waitFor(hub.url, (rs) => rs.some((r) => r.event.fields?.change === 'recovered'), { topic });
    const evs = recs.map((r) => r.event);
    assert.ok(evs.some((e) => e.level === 'ERROR' && e.fields?.kind === 'sanitizer'));
    assert.ok(evs.some((e) => e.metric?.name === 'cuda.sanitizer_errors'));
    assert.ok(evs.some((e) => e.level === 'INFO' && e.fields?.change === 'recovered'));
  });

  it('lifts the nsys cuda_gpu_kern_sum CSV into per-kernel metrics', async () => {
    const topic = 'cuda.t_nsys';
    await feed('t_nsys',
      'launching bench\n' +
      '@@SLCUDA_STATS@@\n' +
      ' ** CUDA GPU Kernel Summary (cuda_gpu_kern_sum):\n\n' +
      'Time (%),Total Time (ns),Instances,Avg (ns),Med (ns),Min (ns),Max (ns),StdDev (ns),Name\n' +
      '38.1,227016424,36,6306011.8,6300000.0,6200000,6400000,50000.0,attend_backward_keys\n' +
      '20.0,100000000,10,10000000.0,10000000,9000000,11000000,100000.0,"void cutlass::Kernel<float, float>"\n');

    const recs = await waitFor(hub.url,
      (rs) => rs.some((r) => r.event.metric?.name === 'cuda.kernel_ms' && r.event.fields?.kernel === 'attend_backward_keys'),
      { topic });
    const ms = recs.find((r) => r.event.metric?.name === 'cuda.kernel_ms' && r.event.fields?.kernel === 'attend_backward_keys').event;
    assert.ok(Math.abs(ms.metric.value - 6.3060118) < 1e-3, 'avg ns -> ms');
    assert.ok(recs.some((r) => r.event.metric?.name === 'cuda.kernel_pct' && Math.abs(r.event.metric.value - 38.1) < 1e-6));
    // A kernel name with a comma inside quotes must stay one field.
    assert.ok(recs.some((r) => r.event.fields?.full_name === 'void cutlass::Kernel<float, float>'),
              'quoted comma in a kernel name was mis-split');
  });

  it('tells a host-side crash apart from a device fault (and no GPU is needed to prove it)', async () => {
    const topic = 'cuda.t_crash';
    const r = await feed('t_crash', '', ['--', 'sh', '-c', 'echo working; kill -SEGV $$']);
    assert.notEqual(r.code, 0, 'a crashed child is a nonzero exit');

    const recs = await waitFor(hub.url, (rs) => rs.some((r2) => r2.event.fields?.kind === 'host-crash'), { topic });
    const crash = recs.find((r2) => r2.event.fields?.kind === 'host-crash').event;
    assertValidEvent(crash, topic);
    assert.equal(crash.level, 'ERROR');
    assert.match(crash.fields.signal, /SIGSEGV/);
    assert.match(crash.msg, /not a device fault/);
  });

  it('reads NVRTC compile errors in nvcc format as one ERROR', async () => {
    const topic = 'cuda.t_nvrtc';
    await feed('t_nvrtc',
      'snicholls_gpu_ops.cu(140): error: identifier "INFINITY" is undefined\n' +
      '3 errors detected in the compilation of "snicholls_gpu_ops.cu".\n');

    const recs = await waitFor(hub.url, (rs) => rs.some((r) => r.event.fields?.kind === 'nvrtc'), { topic });
    const evs = recs.map((r) => r.event);
    assert.equal(evs.filter((e) => e.level === 'ERROR').length, 1, 'one ERROR for one failed compile');
    const nv = evs.find((e) => e.fields?.kind === 'nvrtc');
    assert.equal(nv.fields.file, 'snicholls_gpu_ops.cu');
    assert.equal(nv.fields.line, '140');
  });

  it('flags a driver/toolkit toolchain mismatch with the driver-older hint', async () => {
    const topic = 'cuda.t_tool';
    await feed('t_tool',
      'snicholls::gpu::cuda_kernels: cudaLibraryGetKernel(fill): the provided PTX was compiled with an unsupported toolchain.\n');

    const recs = await waitFor(hub.url, (rs) => rs.some((r) => r.event.fields?.kind === 'toolchain'), { topic });
    const ev = recs.find((r) => r.event.fields?.kind === 'toolchain').event;
    assert.equal(ev.level, 'ERROR');
    assert.match(ev.fields.hint, /driver older/);
  });

  it('levels the wrapped exceptions right: invalid-argument launch WARN, cudaMemcpy ERROR', async () => {
    const topic = 'cuda.t_api';
    await feed('t_api',
      'snicholls::gpu: cudaLaunchKernel(attend) [invalid argument] failed with CUDA code 1\n' +
      'snicholls::gpu: cudaMemcpy failed with CUDA code 1\n');

    const recs = await waitFor(hub.url, (rs) => rs.some((r) => r.event.fields?.call === 'cudaMemcpy'), { topic });
    const evs = recs.map((r) => r.event);
    assert.ok(evs.some((e) => e.level === 'WARN' && /invalid argument/.test(e.fields?.reason ?? '')),
              'an invalid-argument launch is recoverable: WARN');
    assert.ok(evs.some((e) => e.level === 'ERROR' && e.fields?.call === 'cudaMemcpy'),
              'a copy fault is ERROR - and the WARN before it must not have muted it');
  });

  it('reads gtest results: the PASSED summary at INFO, plain and per-test lines at DEBUG', async () => {
    const topic = 'cuda.t_ok';
    await feed('t_ok',
      'allocating\nrunning\nwarming up\n' +
      '[ RUN      ] Fill.Basic\n[       OK ] Fill.Basic (2 ms)\n' +
      '[  PASSED  ] 42 tests.\n');
    const recs = await waitFor(hub.url, (rs) => rs.some((r) => /PASSED/.test(r.event.msg)), { topic });
    const evs = recs.map((r) => r.event);
    assert.equal(evs.filter((e) => e.level === 'ERROR').length, 0, 'a clean run has no ERROR');
    const passed = evs.find((e) => /PASSED/.test(e.msg));
    assert.equal(passed.level, 'INFO', 'the gtest PASSED summary is lifted above DEBUG');
    assert.equal(passed.fields?.kind, 'test');
    assert.ok(evs.filter((e) => e.level === 'DEBUG').length >= 3, 'plain and per-test lines stay DEBUG');
  });

  it('makes a gtest [ FAILED ] line an ERROR (kind=test) without arming the device-fault edge', async () => {
    const topic = 'cuda.t_gtfail';
    await feed('t_gtfail',
      '[ RUN      ] Attend.Backward\n' +
      '[  FAILED  ] Attend.Backward (5 ms)\n' +
      '[  PASSED  ] 41 tests.\n');
    const recs = await waitFor(hub.url, (rs) => rs.some((r) => /PASSED/.test(r.event.msg)), { topic });
    const evs = recs.map((r) => r.event);
    assert.ok(evs.some((e) => e.level === 'ERROR' && e.fields?.kind === 'test'), 'a failing gtest case is an ERROR');
    assert.ok(!evs.some((e) => e.fields?.change === 'recovered'), 'a test failure is not a device fault, so no recovery');
  });

  it('exits cleanly with the hub down and sends nothing to the live hub', async () => {
    const dead = `http://127.0.0.1:${await freePort()}`;
    const r = await run('superlog-cuda.mjs', ['--app', 't_nohub'],
                        { url: dead, stdin: 'CUDA error at k.cu:1 code=700(cudaErrorIllegalAddress) "x"\n', timeoutMs: 20000 });
    assert.equal(r.code, 0, 'a missing hub must not fail the tailer in stdin mode');
    const stray = await recent(hub.url, { topic: 'cuda.t_nohub' });
    assert.equal(stray.length, 0, 'nothing should have reached the live hub');
  });
});
