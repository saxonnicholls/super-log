#!/usr/bin/env node
//
//  superlog-fleet - one config, every machine.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  Eight servers with a handful of containers each is thirty tailers, and
//  nobody runs thirty commands twice. This reads a fleet file, starts the
//  right tailer for every stream in it, restarts any that die, and prints
//  one status line per stream so a glance answers "is anything missing".
//
//    superlog-fleet fleet.json          # or ./fleet.json by default
//    superlog-fleet fleet.json --dry-run
//
//  Everything is PULLED over ssh from the machine running this. The
//  production boxes need no agent, no open port, and no route to the hub -
//  the hub can stay loopback-bound, which is the posture that makes this
//  safe to point at production at all (docs/ARCHITECTURE.md).
//
//  The config is JSON so it needs no parser dependency:
//
//    {
//      "url": "http://127.0.0.1:7333",
//      "hosts": [
//        {
//          "ssh": "web1.example.com",   // anything `ssh <this>` accepts
//          "name": "web1",              // topic name; defaults to the ssh host
//          "os": true,                  // journald/unified log -> os.web1
//          "unit": "myapp",             // limit the OS stream to one unit
//          "apps": ["nginx", "postgres"],       // -> app.web1.nginx, ...
//          "files": ["/srv/app/log/production.log"],
//          "docker": ["api", "worker"]          // -> app.web1.api, ...
//        }
//      ]
//    }
//
//  Node >= 18, no dependencies.
//

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const configPath = args.find((a) => !a.startsWith('--')) ?? 'fleet.json';

let cfg;
try {
  cfg = JSON.parse(readFileSync(configPath, 'utf8'));
} catch (e) {
  console.error(`superlog-fleet: cannot read ${configPath}: ${e.message}`);
  console.error('Write one (see the header of this file) or pass a path.');
  process.exit(2);
}

const hubUrl = cfg.url ?? process.env.SUPER_LOG_URL ?? 'http://127.0.0.1:7333';
const TAIL = join(here, 'superlog-tail.mjs');

// One entry per stream: what to run, and what it will be called on the bench.
const streams = [];
for (const host of cfg.hosts ?? []) {
  const dest = host.ssh;
  if (!dest) {
    console.error('superlog-fleet: a host entry has no "ssh" field; skipping');
    continue;
  }
  const name = host.name ?? dest.split('@').pop().split('.')[0];
  // Per-host ssh details, for the boxes that have no ~/.ssh/config entry -
  // an IP and a key is a complete answer here.
  const sshArgs = [
    ...(host.identity ? ['--identity', host.identity] : []),
    ...(host.port ? ['--ssh-port', String(host.port)] : []),
    ...(host.sshOpts ?? []).flatMap((o) => ['--ssh-opt', o]),
  ];
  const base = ['ssh', dest, '--url', hubUrl, ...sshArgs];
  // --topic is passed explicitly so the stream name follows the config's
  // `name`, not whatever the remote calls itself. Hetzner's default
  // hostnames (ubuntu-4gb-nbg1-1) are not what you want to read at 3am.
  if (host.os)
    streams.push({
      topic: `os.${name}`,
      argv: [...base, '--topic', `os.${name}`, ...(host.unit ? ['--unit', host.unit] : [])],
    });
  for (const app of host.apps ?? [])
    streams.push({
      topic: `app.${name}.${app}`,
      argv: [...base, '--app', app, '--topic', `app.${name}.${app}`],
    });
  for (const f of host.files ?? []) {
    const label = f.split('/').filter(Boolean).slice(-2).join('.').replace(/\.log$/, '')
      .toLowerCase().replace(/[^a-z0-9._-]/g, '-');
    streams.push({
      topic: `app.${name}.${label}`,
      argv: [...base, '--file', f, '--topic', `app.${name}.${label}`],
    });
  }
  for (const c of host.docker ?? [])
    streams.push({
      topic: `app.${name}.${c}`,
      argv: [...base, '--docker', c, '--topic', `app.${name}.${c}`],
    });
}

if (streams.length === 0) {
  console.error(`superlog-fleet: ${configPath} defines no streams`);
  process.exit(2);
}

console.error(`superlog-fleet: ${streams.length} stream(s) from ${(cfg.hosts ?? []).length} host(s) -> ${hubUrl}`);
for (const s of streams) console.error(`  ${s.topic}`);
if (dryRun) {
  console.error('\n--dry-run: nothing started.');
  process.exit(0);
}

// Supervise. A tailer that exits is restarted with backoff - a production
// box reboots, a container is redeployed, a network blips, and none of
// those should mean a stream silently stops for the rest of the day.
let stopping = false;
const children = new Set();

function start(stream, delay = 0) {
  if (stopping) return;
  setTimeout(() => {
    if (stopping) return;
    const child = spawn(process.execPath, [TAIL, ...stream.argv],
                        { stdio: ['ignore', 'ignore', 'inherit'] });
    children.add(child);
    child.on('exit', (code) => {
      children.delete(child);
      if (stopping) return;
      // Backoff caps at 30s: a host that is down for an hour should not be
      // retried thousands of times, but should rejoin within half a minute
      // of coming back.
      const next = Math.min((delay || 1000) * 2, 30000);
      console.error(`superlog-fleet: ${stream.topic} exited (${code}); retrying in ${next / 1000}s`);
      start(stream, next);
    });
  }, delay);
}

for (const s of streams) start(s);

for (const sig of ['SIGINT', 'SIGTERM'])
  process.on(sig, () => {
    stopping = true;
    for (const c of children) c.kill('SIGTERM');
    console.error('\nsuperlog-fleet: stopped');
    setTimeout(() => process.exit(0), 300);
  });
