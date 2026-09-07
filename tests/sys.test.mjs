//
//  tests/sys.test.mjs - superlog-sys against synthetic reports and a
//  stand-in diskutil.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  A real crash cannot be scheduled and a real panic should not be, so the
//  DiagnosticReports directory is a temp dir this file writes .ips files
//  into, and diskutil is a script replaying captured DiskArbitration lines.
//  Two assertions earn this file: a crash report becomes ONE parsed event
//  at the level the report deserves (ERROR for a crash, CRITICAL for a
//  panic) rather than a filename nobody opens; and a volume RENAME is a
//  WARN, because a rename moves every path on the volume at once - it is
//  how a 100GB write died on this bench, recorded by nothing.
//

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  assertValidEvent, removeDir, start, startHub, tempDir, waitFor,
} from './harness.mjs';

const darwin = process.platform === 'darwin';

let hub, work;
let benchSeq = 0;

/** A PATH of stand-ins: diskutil replays captured activity, log and sysctl
 *  stay quiet unless a case says otherwise. */
function bench(tools) {
  const dir = join(work, `bin${benchSeq += 1}`);
  mkdirSync(dir);
  for (const u of ['sh', 'cat', 'sleep', 'echo']) {
    for (const d of ['/bin', '/usr/bin']) {
      if (existsSync(join(d, u))) { symlinkSync(join(d, u), join(dir, u)); break; }
    }
  }
  const quiet = { log: 'exit 0', sysctl: 'exit 0', diskutil: 'exec sleep 600' };
  for (const [name, body] of Object.entries({ ...quiet, ...tools })) {
    const p = join(dir, name);
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
  }
  return dir;
}

// A modern .ips: one JSON summary line, then a JSON body.
const CRASH_IPS = JSON.stringify({
  app_name: 'corpus_build', bug_type: '309', os_version: 'macOS 26.6',
  timestamp: '2026-08-31 18:00:00.00 +1000',
}) + '\n' + JSON.stringify({
  uptime: 4000,
  exception: { type: 'EXC_CRASH', signal: 'SIGABRT' },
  termination: { indicator: 'Abort trap: 6', byProc: 'corpus_build' },
});

const PANIC_IPS = JSON.stringify({
  app_name: 'kernel', bug_type: '210', os_version: 'macOS 26.6',
}) + '\n' + JSON.stringify({ panicString: 'panic(cpu 4): watchdog timeout' });

const DA_LINES = `***DAIdle (no activity)
***DiskMounted ('disk4s1', DAVolumeKind = 'apfs', DAVolumeName = 'Data2TB', DAVolumePath = '/Volumes/Data2TB')
***DiskRenamed ('disk4s1', DAVolumeName = 'Archive2TB', DAVolumePath = '/Volumes/Archive2TB')
***DiskUnmounted ('disk4s1', DAVolumeName = 'Archive2TB')`;

before(async () => {
  hub = await startHub();
  work = tempDir('superlog-sys-');
});

after(async () => {
  await hub?.stop();
  removeDir(work);
});

async function sys(name, tools, prime) {
  const reports = join(work, `reports-${name}`);
  mkdirSync(reports);
  prime?.(reports);
  const topic = `sys.t-${name}`;
  const h = start('superlog-sys.mjs',
    ['--reports', reports, '--topic', topic, '--interval', '5', '--url', hub.url],
    { env: { PATH: bench(tools) } });
  return { reports, topic, tool: h };
}

const kind = (k) => (rs) => rs.some((r) => r.event?.fields?.kind === k);
const of = (recs, k) => recs.filter((r) => r.event.fields?.kind === k).map((r) => r.event);

describe('superlog-sys', { skip: !darwin }, () => {
  it('a crash report is one parsed ERROR; a panic is CRITICAL; the backfill catches pre-reboot reports', async () => {
    // Both reports exist BEFORE the tailer starts - the reboot-then-start
    // order every real crash produces - and land via the 1h backfill.
    const { topic, tool } = await sys('crash', {}, (dir) => {
      writeFileSync(join(dir, 'corpus_build-2026-08-31-180000.ips'), CRASH_IPS);
      writeFileSync(join(dir, 'panic-full-2026-08-31-180100.ips'), PANIC_IPS);
    });
    const recs = await waitFor(hub.url, (rs) => of(rs, 'crash').length && of(rs, 'panic').length,
                               { topic, timeoutMs: 15000 });
    await tool.stop();
    recs.forEach((r, i) => assertValidEvent(r.event, `${topic}[${i}]`));

    const crash = of(recs, 'crash')[0];
    assert.equal(crash.level, 'ERROR');
    assert.match(crash.msg, /crash: corpus_build - EXC_CRASH \(SIGABRT\) Abort trap: 6/);
    assert.equal(crash.fields.process, 'corpus_build');
    assert.equal(crash.fields.signal, 'SIGABRT');

    const panic = of(recs, 'panic')[0];
    assert.equal(panic.level, 'CRITICAL');
    assert.match(panic.msg, /panic: kernel/);
  });

  it('a volume rename is a WARN that says why, an unmount too, a mount is INFO', async () => {
    const { topic, tool } = await sys('vols', {
      diskutil: `cat <<'DA'\n${DA_LINES}\nDA\nexec sleep 600`,
    });
    const recs = await waitFor(hub.url, (rs) => of(rs, 'volume').length >= 3,
                               { topic, timeoutMs: 15000 });
    await tool.stop();

    const vols = of(recs, 'volume');
    const byChange = (c) => vols.find((e) => e.fields.change === c);
    assert.equal(byChange('mounted').level, 'INFO');
    assert.equal(byChange('mounted').fields.volume, 'Data2TB');
    const renamed = byChange('renamed');
    assert.equal(renamed.level, 'WARN');
    assert.match(renamed.msg, /every path on it just moved/);
    assert.equal(renamed.fields.volume, 'Archive2TB');
    assert.equal(byChange('unmounted').level, 'WARN');
  });

  it('an unclean shutdown cause is one ERROR with the code translated', async () => {
    const { topic, tool } = await sys('cause', {
      log: `echo "2026-08-31 09:00:00.000 Db kernel: Previous shutdown cause: -128"`,
    });
    const recs = await waitFor(hub.url, kind('shutdown'), { topic, timeoutMs: 15000 });
    await tool.stop();
    const s = of(recs, 'shutdown')[0];
    assert.equal(s.level, 'ERROR');
    assert.match(s.msg, /uncontrolled power loss \(cause -128\)/);
    assert.equal(s.fields.cause, '-128');
  });
});
