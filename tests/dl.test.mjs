//
//  tests/dl.test.mjs - superlog-dl against stand-ins for three progress bars.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  The bars are played by shell scripts emitting captured shapes - tqdm,
//  curl's meter, wget - carriage returns and all, because \r is the whole
//  reason superlog-tee cannot do this job. Three assertions earn this file:
//  a \r-rewritten bar parses even though no line ever ends; --watch measures
//  the destination itself and needs no bar at all; and a stall says so ONCE
//  while the transfer is stuck and once when it moves - hours before the
//  wrapped tool's own patience runs out.
//

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  assertValidEvent, removeDir, run, startHub, tempDir, waitFor,
} from './harness.mjs';

let hub, work;
let toolSeq = 0;

/** A stand-in downloader: a sh script whose "progress" is the body given. */
function tool(body) {
  const p = join(work, `tool${toolSeq += 1}.sh`);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

before(async () => {
  hub = await startHub();
  work = tempDir('superlog-dl-');
});

after(async () => {
  await hub?.stop();
  removeDir(work);
});

async function dl(topic, argv, { timeoutMs = 25000 } = {}) {
  const res = await run('superlog-dl.mjs', ['--topic', topic, '--interval', '1', ...argv],
                        { url: hub.url, timeoutMs });
  const recs = await waitFor(hub.url, (r) => r.length > 0, { topic, timeoutMs: 15000 });
  recs.forEach((r, i) => assertValidEvent(r.event, `${topic}[${i}]`));
  return { res, evs: recs.map((r) => r.event) };
}

const metrics = (evs, name) => evs.filter((e) => e.metric?.name === name);

describe('superlog-dl', () => {
  it('reads a tqdm/hf bar rewritten with \\r, and stays transparent', async () => {
    // One physical line, rewritten four times - the shape a pipe actually
    // sees from tqdm. stdout says something unrelated that must survive.
    const t = tool(`echo "resolving model"
printf 'model.safetensors:  10%%|#         | 566M/5.53G [00:12<01:51, 44.6MB/s]\\r' >&2
sleep 1
printf 'model.safetensors:  42%%|####      | 2.31G/5.53G [01:12<01:38, 32.1MB/s]\\r' >&2
sleep 1
printf 'model.safetensors: 100%%|##########| 5.53G/5.53G [02:49<00:00, 33.4MB/s]\\n' >&2
exit 0`);
    const { res, evs } = await dl('dl.t-tqdm', ['--label', 'tqdm-model', '--', t]);

    assert.equal(res.code, 0);
    assert.match(res.stdout, /resolving model/);        // passthrough, untouched
    assert.match(res.stderr, /42%/);

    const pcts = metrics(evs, 'dl.pct').map((e) => e.metric.value);
    assert.ok(pcts.includes(100), `never reached 100%: ${pcts}`);
    // 5.53G parsed as bytes: 5.53 * 2^30 / 2^20 MiB.
    const mbs = metrics(evs, 'dl.mb').map((e) => e.metric.value);
    assert.ok(mbs.includes(Number((5.53 * 1024).toFixed(1))), `bytes not parsed: ${mbs}`);
    assert.ok(metrics(evs, 'dl.rate_mbs').length, 'no rate metric');

    const doneEv = evs.find((e) => e.level === 'INFO' && /^done:/.test(e.msg));
    assert.ok(doneEv, 'no done verdict');
  });

  it('reads curl\'s meter rows', async () => {
    const t = tool(`printf ' 42 5300M   42 2229M    0     0  31.2M      0  0:02:49  0:01:11  0:01:38 33.4M\\r' >&2
sleep 1
printf '100 5300M  100 5300M    0     0  32.0M      0  0:02:45  0:02:45 --:--:-- 33.1M\\n' >&2
exit 0`);
    const { evs } = await dl('dl.t-curl', ['--label', 'curl-file', '--', t]);
    const pcts = metrics(evs, 'dl.pct').map((e) => e.metric.value);
    assert.ok(pcts.includes(100), `curl meter not read: ${pcts}`);
    assert.ok(metrics(evs, 'dl.mb').some((e) => e.metric.value > 5e6 / 1024),
              'received size not read from the meter');
  });

  it('--watch measures the destination itself - no bar required', async () => {
    const target = join(work, 'corpus.bin');
    // 4 MiB in four silent steps: the tool says nothing at all.
    const t = tool(`i=0
while [ $i -lt 4 ]; do
  dd if=/dev/zero bs=1048576 count=1 >> "${target}" 2>/dev/null
  sleep 1
  i=$((i+1))
done
exit 0`);
    const { res, evs } = await dl('dl.t-watch',
      ['--label', 'corpus', '--watch', target, '--size', '4M', '--', t]);

    assert.equal(res.code, 0);
    const pcts = metrics(evs, 'dl.pct').map((e) => e.metric.value);
    assert.ok(pcts.includes(100), `watch never saw the file fill: ${pcts}`);
    const mbs = metrics(evs, 'dl.mb').map((e) => e.metric.value);
    assert.ok(mbs.includes(4), `watch did not measure 4 MiB: ${mbs}`);
    assert.ok(evs.find((e) => /^done:/.test(e.msg)), 'no done verdict');
  });

  it('a stall is one WARN, then one ERROR, then one recovery - and failure keeps the exit status', async () => {
    const t = tool(`printf ' 10%%\\r' >&2
sleep 8
printf ' 20%%\\r' >&2
sleep 1
exit 7`);
    const { res, evs } = await dl('dl.t-stall',
      ['--label', 'stall', '--stall', '2', '--', t], { timeoutMs: 35000 });

    // Transparent failure: the wrapper's exit status is the command's own.
    assert.equal(res.code, 7);

    const stallWarns = evs.filter((e) => e.level === 'WARN' && /stalled/.test(e.msg));
    assert.equal(stallWarns.length, 1, 'stall must be said once, not every poll');
    // 0.0MB/s for three stall windows is not slow, it is dead - and dead is
    // an ERROR, said once too.
    const dead = evs.filter((e) => e.level === 'ERROR' && /treating as dead/.test(e.msg));
    assert.equal(dead.length, 1, 'a dead transfer must escalate to exactly one ERROR');
    assert.ok(evs.find((e) => /recovered: moving again/.test(e.msg)), 'recovery not announced');
    const fail = evs.find((e) => e.level === 'ERROR' && /^failed:/.test(e.msg));
    assert.ok(fail, 'no failure verdict');
    assert.equal(fail.fields.exit, '7');
  });
});
