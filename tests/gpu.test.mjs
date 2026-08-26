//
//  tests/gpu.test.mjs - superlog-gpu against stand-ins for four vendors.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  Only one GPU is ever present on the machine running this, so the vendor
//  tools are played by shell scripts on PATH emitting real captured output.
//  That exercises the whole path a real card takes - the probe, the sh
//  wrapper, the command detection, the parse and the thresholds - and it is
//  the only way the NVIDIA, ROCm and Raspberry Pi branches get tested at all.
//
//  Two assertions earn this file. A vendor that does not report a reading
//  must produce NO metric rather than a zero: charting "the sensor is absent"
//  as "the GPU is at 0C" is a lie that looks like data. And the thresholds
//  are edge-triggered, so a card sitting at 90C says so once and says so
//  again when it recovers - a watcher that repeats itself every poll is one
//  people mute, which makes it worse than absent.
//

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  assertValidEvent, removeDir, run, startHub, tempDir, waitFor,
} from './harness.mjs';

let hub, work;
let binSeq = 0;

/** A PATH containing ONLY the tools named, plus a shell. `command -v` is how
 *  the probe chooses a vendor, so a stand-in that merely exits 1 still counts
 *  as present and the probe never falls through to the next one - absence has
 *  to be real absence. */
function bench(tools) {
  const dir = join(work, `bin${binSeq += 1}`);
  mkdirSync(dir);
  // A shell and the handful of utilities the probe and the stand-ins use.
  // Deliberately NOT a whole PATH: the GPU tools must be genuinely absent,
  // and deliberately not empty either, or the stand-ins cannot run.
  for (const u of ['sh', 'cat', 'sed', 'head', 'tr', 'grep', 'echo']) {
    for (const d of ['/bin', '/usr/bin']) {
      if (existsSync(join(d, u))) { symlinkSync(join(d, u), join(dir, u)); break; }
    }
  }
  for (const [name, body] of Object.entries(tools)) {
    const p = join(dir, name);
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
  }
  return dir;
}

before(async () => {
  hub = await startHub();
  work = tempDir('superlog-gpu-');
});

after(async () => {
  await hub?.stop();
  removeDir(work);
});

/** Run the watcher with the fake vendor tools ahead of the real ones. */
async function gpu(topic, argv, { timeoutMs = 20000, path } = {}) {
  await run('superlog-gpu.mjs', ['--topic', topic, ...argv], {
    url: hub.url,
    timeoutMs,
    // Replaces PATH rather than prepending: see bench().
    env: { PATH: path },
  });
  const recs = await waitFor(hub.url, (r) => r.length > 0, { topic, timeoutMs: 15000 });
  recs.forEach((r, i) => assertValidEvent(r.event, `${topic}[${i}]`));
  return recs.map((r) => r.event);
}

describe('superlog-gpu', () => {
  it('reads nvidia-smi, and turns each reading into a metric', async () => {
    // The real --query-gpu CSV: index, name, util, mem used, mem total,
    // temperature, power.
    const path = bench({
      'nvidia-smi': 'echo "0, NVIDIA GeForce RTX 4090, 47, 8192, 24564, 63, 210.55"',
    });
    const evs = await gpu('gpu.test.nvidia', ['--once'], { path });

    const line = evs.find((e) => /^gpu 0:/.test(e.msg));
    assert.ok(line, 'the inventory line should be published');
    assert.match(line.msg, /RTX 4090/, 'and should name the card');
    assert.match(line.msg, /47% used/);
    assert.match(line.msg, /8192\/24564 MiB/);
    assert.match(line.msg, /63C/);
  });

  it('emits no metric for a reading the vendor did not report', async () => {
    // macOS reports 0 for a card with no exposed temperature sensor, and a
    // running GPU is never at 0C - so that is an absent reading, not a cold
    // one. Only ioreg exists here, so the probe falls through to it.
    const path = bench({
      ioreg: "cat <<'EOF'\n" +
        '    "IOGLBundleName" = "TestDriver"\n' +
        '    "PerformanceStatistics" = {"Device Utilization %"=33,"inUseVidMemoryBytes"=1048576,"Temperature(C)"=0}\n' +
        'EOF',
    });
    const evs = await gpu('gpu.test.nosensor', ['--interval', '2'], { timeoutMs: 6000, path });

    assert.equal(evs.filter((e) => e.metric?.name === 'gpu.temperature_c').length, 0,
                 'an absent sensor must not become a 0C reading');
    const util = evs.find((e) => e.metric?.name === 'gpu.utilization_pct');
    assert.ok(util, 'the readings it DOES have should still arrive');
    assert.equal(util.metric.value, 33);
    assert.equal(util.level, 'DEBUG', 'readings stay out of a default INFO view');
  });

  it('says a Raspberry Pi is browning out, which the Pi will not', async () => {
    // 0x50005: under-voltage now, currently throttled, and both "has
    // occurred" bits. Undervoltage is the commonest cause of a Pi behaving
    // strangely and it is invisible unless you ask.
    const path = bench({
      vcgencmd: 'case "$1" in\n' +
        "  measure_temp) echo \"temp=67.9'C\" ;;\n" +
        '  measure_clock) echo "frequency(46)=500000000" ;;\n' +
        '  get_throttled) echo "throttled=0x50005" ;;\n' +
        'esac',
    });
    const evs = await gpu('gpu.test.pi', ['--interval', '2'], { timeoutMs: 6000, path });

    const thr = evs.find((e) => e.fields?.change === 'throttle');
    assert.ok(thr, 'a throttling Pi must say so');
    assert.equal(thr.level, 'ERROR', 'under-voltage now is not a warning');
    assert.match(thr.msg, /under-voltage now/);
    assert.match(thr.msg, /currently throttled/);

    const temp = evs.find((e) => e.metric?.name === 'gpu.temperature_c');
    assert.equal(temp.metric.value, 67.9, 'the Pi reports tenths and they should survive');
  });

  it('reports a heat crossing once, and reports the recovery too', async () => {
    // Hot on the first poll, cool afterwards. A file is the counter, because
    // the stand-in has no other memory.
    const counter = join(work, 'polls');
    const path = bench({
      'nvidia-smi':
        `n=$(cat ${counter} 2>/dev/null || echo 0); echo $((n+1)) > ${counter}\n` +
        'if [ "$n" -lt 1 ]; then t=97; else t=55; fi\n' +
        'echo "0, Test Card, 10, 100, 1000, $t, 50.0"',
    });
    const evs = await gpu('gpu.test.heat', ['--interval', '1'], { timeoutMs: 8000, path });

    const crossings = evs.filter((e) => e.fields?.change === 'temperature');
    assert.ok(crossings.length >= 2, 'it should report going over AND coming back');
    assert.equal(crossings[0].level, 'ERROR', '97C is past the error threshold');
    assert.match(crossings[0].msg, /97C/);
    assert.equal(crossings[1].level, 'INFO', 'recovery is news too');
    assert.match(crossings[1].msg, /back under/);

    assert.equal(crossings.filter((e) => e.level === 'ERROR').length, 1,
                 'a hot card says so once, not every poll');
  });

  it('says so once when the machine has no GPU tooling at all', async () => {
    const path = bench({});     // a shell and nothing else
    const evs = await gpu('gpu.test.none', ['--interval', '1'], { timeoutMs: 6000, path });

    const none = evs.filter((e) => e.fields?.change === 'no-tooling');
    assert.equal(none.length, 1, 'a box with no GPU is a fact, not a recurring complaint');
    assert.equal(none[0].level, 'WARN');
    assert.match(none[0].msg, /nvidia-smi/, 'it should say what it looked for');
  });

  // Found by this file: a vendor tool that exists but reports nothing left
  // the watcher publishing absolutely nothing, so an empty stream could mean
  // an idle GPU or a broken watcher and there was no way to tell.
  it('distinguishes a tool that reports no cards from having no tool', async () => {
    const path = bench({ 'nvidia-smi': 'exit 0' });   // present, says nothing
    const evs = await gpu('gpu.test.empty', ['--interval', '1'], { timeoutMs: 6000, path });

    const empty = evs.filter((e) => e.fields?.change === 'no-cards');
    assert.equal(empty.length, 1, 'reported once, not every poll');
    assert.equal(empty[0].level, 'WARN');
    assert.match(empty[0].msg, /reported no GPUs/,
                 'the message must separate "no tool" from "no cards"');
    assert.match(empty[0].msg, /nvidia-smi is installed/,
                 'and name the tool that came back empty');
  });
});
