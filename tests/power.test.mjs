//
//  tests/power.test.mjs - superlog-power against a stand-in powermetrics.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  powermetrics requires root, and a test suite must not - so the sudo and
//  the wrapper are played by scripts emitting real plist shapes, which is
//  also the only way the Intel and Apple Silicon dialects can both be
//  exercised on one machine. Three assertions earn this file: milliwatts
//  and watts both come out as watts; running without privilege produces an
//  EXPLICIT power_unavailable rather than silence or a crash; and SIGTERM
//  leaves no powermetrics behind - a leaked child here burns the very watts
//  the tool exists to count.
//

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  assertValidEvent, removeDir, run, start, startHub, tempDir, waitFor,
} from './harness.mjs';

const darwin = process.platform === 'darwin';

let hub, work;
let benchSeq = 0;

/** A PATH containing only a shell, a few real utilities, and the stand-ins.
 *  sudo in particular must be OURS: the real one would sit waiting for a
 *  password, which is exactly what the tailer promises never to do. */
function bench(tools) {
  const dir = join(work, `bin${benchSeq += 1}`);
  mkdirSync(dir);
  for (const u of ['sh', 'cat', 'echo', 'sleep', 'grep']) {
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

// The interesting parts of real -f plist output, both dialects. Intel says
// watts by name; Apple Silicon says milliwatts and does not say so.
const INTEL_DOC = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>is_delta</key><true/>
  <key>hw_model</key><string>MacPro7,1</string>
  <key>tasks</key>
  <array>
    <dict>
      <key>pid</key><integer>4242</integer>
      <key>name</key><string>Code Helper (Plugin)</string>
      <key>energy_impact</key><real>412.5</real>
      <key>cputime_ms_per_s</key><real>11020.0</real>
    </dict>
    <dict>
      <key>pid</key><integer>77</integer>
      <key>name</key><string>kernel_task</string>
      <key>energy_impact</key><real>88.1</real>
      <key>cputime_ms_per_s</key><real>950.0</real>
    </dict>
    <dict>
      <key>pid</key><integer>-1</integer>
      <key>name</key><string>ALL_TASKS</string>
      <key>energy_impact</key><real>500.6</real>
    </dict>
  </array>
  <key>processor</key>
  <dict>
    <key>package_watts</key><real>187.25</real>
  </dict>
  <key>smc</key>
  <dict>
    <key>fan</key><real>1878.5</real>
    <key>cpu_die</key><real>67.0</real>
    <key>cpu_die_fan_target</key><real>0.0</real>
    <key>gpu_die</key><real>59.5</real>
    <key>gpu_die_fan_target</key><real>0.0</real>
    <key>simulated_cpu_thermal_level</key><integer>0</integer>
  </dict>
</dict>
</plist>`;

const ARM_DOC = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>hw_model</key><string>Mac14,12</string>
  <key>thermal_pressure</key><string>Nominal</string>
  <key>processor</key>
  <dict>
    <key>cpu_power</key><real>2450.0</real>
    <key>gpu_power</key><real>512.0</real>
    <key>ane_power</key><real>12.0</real>
    <key>combined_power</key><real>8123.5</real>
  </dict>
  <key>tasks</key>
  <array>
    <dict>
      <key>pid</key><integer>901</integer>
      <key>name</key><string>WindowServer</string>
      <key>energy_impact</key><real>55.0</real>
      <key>cputime_ms_per_s</key><real>310.0</real>
    </dict>
  </array>
</dict>
</plist>`;

// pmset -g therm as a real Mac prints it, and ps summing to the incident
// this tailer was written after: 1258% aggregate, eleven of those cores in
// one extension host.
const THERM = `Note: No thermal warning level has been recorded
2026-08-31 14:21:16 +1000 CPU Power notify
\tCPU_Scheduler_Limit \t= 100
\tCPU_Available_CPUs \t= 32
\tCPU_Speed_Limit \t= 100`;

const PS = ` 4242 1102.4 /Applications/Code.app/Code Helper (Plugin)
  901   88.3 /System/Library/WindowServer
   77   45.6 kernel_task
  510   21.7 /usr/local/bin/node`;

const STANDINS = {
  sudo: '[ "$1" = "-n" ] && shift\nexec "$@"',
  pmset: `cat <<'THERM'\n${THERM}\nTHERM`,
  ps: `cat <<'PS'\n${PS}\nPS`,
  uname: 'echo x86_64',
};

/** A wrapper that emits one captured plist document, NUL-terminated the way
 *  the real -f plist stream is, then lives on like the real long-lived
 *  child would. */
const emit = (docFile, extra = '') =>
  `${extra}cat "${docFile}"\nprintf '\\0'\nexec sleep 600`;

before(async () => {
  hub = await startHub();
  work = tempDir('superlog-power-');
  writeFileSync(join(work, 'intel.plist'), INTEL_DOC);
  writeFileSync(join(work, 'arm.plist'), ARM_DOC);
});

after(async () => {
  await hub?.stop();
  removeDir(work);
});

async function power(topic, argv, path, { timeoutMs = 25000 } = {}) {
  await run('superlog-power.mjs', ['--topic', topic, ...argv], {
    url: hub.url, timeoutMs, env: { PATH: path },
  });
  const recs = await waitFor(hub.url, (r) => r.length > 0, { topic, timeoutMs: 15000 });
  recs.forEach((r, i) => assertValidEvent(r.event, `${topic}[${i}]`));
  return recs.map((r) => r.event);
}

const metric = (evs, name) => evs.find((e) => e.metric?.name === name);

describe('superlog-power', { skip: !darwin }, () => {
  it('reads the Intel dialect: watts by name, both die temperatures, fans, top consumers', async () => {
    const wrapper = join(work, 'wrapper-intel');
    writeFileSync(wrapper, `#!/bin/sh\n${emit(join(work, 'intel.plist'))}\n`);
    chmodSync(wrapper, 0o755);
    const evs = await power('power.t-intel', ['--once', '--wrapper', wrapper, '--top', '3'],
                            bench(STANDINS));

    assert.equal(metric(evs, 'power.package_w')?.metric.value, 187.25);
    assert.equal(metric(evs, 'power.cpu_die_c')?.metric.value, 67);
    assert.equal(metric(evs, 'power.gpu_die_c')?.metric.value, 59.5);
    const fan = metric(evs, 'power.fan_rpm');
    assert.equal(fan?.metric.value, 1879);
    // The *_fan_target setpoints must not appear as dead fans beside it.
    assert.equal(fan.fields.fans, '1879');

    // Aggregate CPU is ONE number, from ps, and it is the incident's number.
    assert.equal(metric(evs, 'power.cpu_pct')?.metric.value, 1258);

    // Ranked by energy impact, aggregate rows (pid -1) excluded.
    const top = evs.find((e) => e.fields?.by === 'energy');
    assert.ok(top, 'no top-consumers event');
    assert.equal(top.fields.p1_cmd, 'Code Helper (Plugin)');
    assert.equal(top.fields.p1_cpu_pct, '1102.0');
    assert.ok(!Object.values(top.fields).includes('ALL_TASKS'));

    // Eleven cores in one process is a WARN even though 39% of a Mac Pro's
    // aggregate capacity looks fine - that mismatch is why this tool exists.
    const hog = evs.find((e) => e.level === 'WARN' && /in one process/.test(e.msg));
    assert.ok(hog, 'no single-process WARN');
    assert.equal(hog.fields.pid, '4242');

    // Privileged run: nothing may claim power is unavailable.
    assert.ok(!evs.some((e) => e.fields?.power_unavailable), 'power_unavailable on a privileged run');
  });

  it('reads the Apple Silicon dialect: milliwatts become watts', async () => {
    const wrapper = join(work, 'wrapper-arm');
    writeFileSync(wrapper, `#!/bin/sh\n${emit(join(work, 'arm.plist'))}\n`);
    chmodSync(wrapper, 0o755);
    const evs = await power('power.t-arm', ['--once', '--wrapper', wrapper],
                            bench({ ...STANDINS, uname: 'echo arm64' }));

    assert.equal(metric(evs, 'power.package_w')?.metric.value, 8.12);
    assert.equal(metric(evs, 'power.cpu_w')?.metric.value, 2.45);
    assert.equal(metric(evs, 'power.gpu_w')?.metric.value, 0.51);
  });

  it('degrades without root: explicit power_unavailable, thermals and cpu still flow', async () => {
    const wrapper = join(work, 'wrapper-refused');
    writeFileSync(wrapper, '#!/bin/sh\nexit 1\n');
    chmodSync(wrapper, 0o755);
    const evs = await power('power.t-deg', ['--once', '--wrapper', wrapper],
                            bench({ ...STANDINS,
                                    sudo: 'echo "sudo: a password is required" >&2\nexit 1' }));

    const warn = evs.find((e) => e.level === 'WARN' && /powermetrics unavailable/.test(e.msg));
    assert.ok(warn, 'no unavailable WARN');
    assert.equal(warn.fields.power_unavailable, 'not root');

    // The readings that need no root still arrive, and the cpu reading says
    // in-band why the watts beside it are missing.
    const cpu = metric(evs, 'power.cpu_pct');
    assert.equal(cpu?.metric.value, 1258);
    assert.equal(cpu.fields.power_unavailable, 'not root');
    assert.equal(metric(evs, 'power.speed_limit_pct')?.metric.value, 100);
    assert.ok(evs.find((e) => e.fields?.by === 'cpu'), 'no top-by-cpu fallback');
    assert.ok(!metric(evs, 'power.package_w'), 'watts invented without powermetrics');
  });

  it('kills the powermetrics child on SIGTERM - no orphan', async () => {
    const pidFile = join(work, 'pm.pid');
    const wrapper = join(work, 'wrapper-orphan');
    writeFileSync(wrapper,
      `#!/bin/sh\n${emit(join(work, 'intel.plist'), `echo $$ > "${pidFile}"\n`)}\n`);
    chmodSync(wrapper, 0o755);

    const h = start('superlog-power.mjs',
      ['--topic', 'power.t-orphan', '--wrapper', wrapper, '--interval', '1'],
      { url: hub.url, env: { PATH: bench(STANDINS) } });
    await waitFor(hub.url, (r) => r.length > 0, { topic: 'power.t-orphan', timeoutMs: 15000 });

    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    assert.ok(pid > 0, 'stand-in never started');
    process.kill(pid, 0);                       // alive while the tailer is

    await h.stop();
    // ESRCH is the pass; a survivor here would be a root process burning
    // the watts this tool exists to count.
    for (let i = 0; i < 100; i++) {
      try {
        process.kill(pid, 0);
      } catch {
        return;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.fail(`powermetrics stand-in (pid ${pid}) survived SIGTERM`);
  });
});
