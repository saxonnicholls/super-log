#!/usr/bin/env node
//
//  loadtest - can one hub take a whole dev team's fleet at once?
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  A decent team runs 200-300 machines, and every one of them can tail its OS,
//  its services, its versions and its network onto a single bench hub. This
//  simulates that fleet against a real superlogd: MACHINES boxes, each POSTing a
//  full versions inventory (~600 facts, the heaviest single event the bench
//  produces) plus a stream of log events, at bounded concurrency - then it reads
//  the hub's own /healthz to see whether it kept up or dropped anything, and
//  times a /recent query to prove a reader is still answered under the load.
//
//  It POSTs plain NDJSON to /ingest/<topic>, exactly as a tailer does - no
//  special path - so the number it prints is the number a real fleet would get.
//
//  Point it at a THROWAWAY hub, never a working bench: it fills the ring and the
//  journal with hundreds of thousands of synthetic events.
//
//    superlogd --bind 127.0.0.1:7350 &
//    HUB=http://127.0.0.1:7350 MACHINES=250 EVENTS=2000 node bench/loadtest.mjs
//

const HUB = process.env.HUB || 'http://127.0.0.1:7350';
const MACHINES = Number(process.env.MACHINES || 250);
const EVENTS = Number(process.env.EVENTS || 2000);   // log events per machine
const BATCH = Number(process.env.BATCH || 200);      // events per POST (a tailer flush)
const CONC = Number(process.env.CONC || 64);         // concurrent in-flight POSTs
const VER_FACTS = Number(process.env.VER_FACTS || 600);

const LEVELS = ['DEBUG', 'INFO', 'INFO', 'INFO', 'WARN', 'ERROR'];
const SUBTOPICS = ['app.api', 'app.worker', 'os.syslog', 'net.state'];

function versionsBody(m) {
  const facts = [];
  for (let i = 0; i < VER_FACTS; i++) {
    facts.push({ category: 'library', tool: `pkg-${i}`, state: 'present',
                 raw: `pkg-${i} 1.${i}.0`, version: `1.${i}.0`, scheme: 'semver',
                 provenance: 'pkgmgr:dpkg', scope: 'system', purl: `pkg:deb/pkg-${i}@1.${i}.0` });
  }
  return JSON.stringify({
    v: 1, ts: new Date().toISOString(), seq: 0, session: `m${m}`, level: 'DEBUG',
    origin: { runtime: 'node', app: 'versions', platform: 'linux', device: `box${m}` },
    tag: 'versions', msg: `${VER_FACTS} versions`,
    fields: { versions: JSON.stringify(facts), count: String(VER_FACTS) },
  });
}
function eventLine(m, n) {
  return JSON.stringify({
    v: 1, ts: new Date().toISOString(), seq: n, session: `m${m}`,
    level: LEVELS[n % LEVELS.length],
    origin: { runtime: 'node', app: 'svc', platform: 'linux', device: `box${m}` },
    tag: 'svc', msg: `event ${n} on box ${m} doing work item ${n * 7 % 9973}`,
    fields: { i: String(n), box: String(m) },
  });
}

// Build the flat list of POST tasks: one versions POST + EVENTS/BATCH log POSTs
// per machine, spread across a few topics.
const tasks = [];
let totalEvents = 0, totalBytes = 0;
for (let m = 0; m < MACHINES; m++) {
  const vb = versionsBody(m);
  tasks.push({ topic: `host.box${m}.versions`, body: vb });
  totalEvents += 1; totalBytes += vb.length;
  let n = 0;
  while (n < EVENTS) {
    const lines = [];
    const topic = `${SUBTOPICS[(m + n) % SUBTOPICS.length]}.box${m}`;
    for (let b = 0; b < BATCH && n < EVENTS; b++, n++) lines.push(eventLine(m, n));
    const body = lines.join('\n');
    tasks.push({ topic, body });
    totalEvents += lines.length; totalBytes += body.length;
  }
}
// Shuffle so machines interleave (a real fleet does not post in order).
for (let i = tasks.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0; [tasks[i], tasks[j]] = [tasks[j], tasks[i]]; }

async function worker(iter) {
  for (const t of iter) {
    try {
      await fetch(`${HUB}/ingest/${t.topic}`, {
        method: 'POST', headers: { 'content-type': 'application/x-ndjson' }, body: t.body,
      });
    } catch { /* the hub's /healthz counts what was dropped; a client-side miss is noise */ }
  }
}
function* chunks() { let i = 0; while (i < tasks.length) yield tasks[i++]; }

console.log(`load: ${MACHINES} machines, ${totalEvents.toLocaleString()} events in ${tasks.length.toLocaleString()} POSTs, ` +
            `${(totalBytes / 1048576).toFixed(0)}MB, ${CONC} concurrent -> ${HUB}`);
const shared = chunks();
const t0 = Date.now();
await Promise.all(Array.from({ length: CONC }, () => worker(shared)));
const secs = (Date.now() - t0) / 1000;
console.log(`sent in ${secs.toFixed(1)}s  =>  ${Math.round(totalEvents / secs).toLocaleString()} events/s, ` +
            `${Math.round(tasks.length / secs).toLocaleString()} POSTs/s, ${(totalBytes / 1048576 / secs).toFixed(1)} MB/s`);

// Was the hub still healthy, and did it drop anything under the load?
const health = await fetch(`${HUB}/healthz`).then((r) => r.json()).catch(() => null);
if (health) console.log(`hub after: published=${health.published.toLocaleString()} dropped=${health.dropped} ` +
                        `topics=${health.topics} uptime=${health.uptime_seconds}s`);
// And can a reader still query it quickly under all that?
const q0 = Date.now();
const rec = await fetch(`${HUB}/recent?limit=200&level=ERROR`).then((r) => r.json()).catch(() => null);
console.log(`/recent?level=ERROR under load: ${Date.now() - q0}ms, ${rec?.count ?? '?'} rows, missed=${rec?.missed}`);
