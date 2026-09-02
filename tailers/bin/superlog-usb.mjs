#!/usr/bin/env node
//
//  superlog-usb - the machine's device tree, watched; hotplug, announced.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  The bench's physical edge: what is plugged into what. On macOS the
//  tree comes from the IORegistry's USB plane - `ioreg -a -p IOUSB -l`
//  through `plutil` into JSON - because system_profiler's USB reporter
//  returns nothing at all on some macOS builds (this bench's included)
//  while ioreg always answers. On Linux, `lsusb` (flat - the tree shape
//  needs udev walking that is not worth a dependency, so Linux gets an
//  honest flat list under one root).
//
//  Two products, one poll:
//    - HOTPLUG EVENTS, snapshot-diffed: "plugged in: iPhone (Apple,
//      serial ...)" at INFO, "unplugged: ..." at INFO - an Android
//      handset appearing on the bench is information, not an alarm.
//    - THE TREE itself, as fields.tree on a usb.<host> event, published
//      at baseline and on every change - the viewers' Devices window
//      renders the latest one per host, so plugging a phone in redraws
//      the tree within one poll (default 5s) with no clicking.
//
//  A tiny loopback poke (POST /poll on --poke-port, default 7338) lets a
//  viewer's refresh button ask for a measurement NOW instead of at the
//  next tick; 0 disables it. Loopback only - the poke is for the bench,
//  not the network.
//
//    superlog-usb                     # watch, 5s poll, poke on :7338
//    superlog-usb --once              # print the tree as events, then exit
//
//  macOS is the verified platform; the Linux path is exercised by CI's
//  --once run.
//

import { execFile, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { hostname, platform } from 'node:os';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { loadEnv } from './env.mjs';

const run = promisify(execFile);
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = args[i + 1];
  return v !== undefined && !v.startsWith('--') ? v : dflt;
};

if (args.includes('--help') || args.includes('-h')) {
  console.error(`superlog-usb - the USB device tree, watched; hotplug, announced

  superlog-usb [--once] [--interval 5] [--poke-port 7338] [--url HUB]

Publishes to usb.<host>: plugged/unplugged events (snapshot-diffed, INFO)
and the whole tree as fields.tree whenever it changes - the viewers'
Devices window renders it. POST 127.0.0.1:<poke-port>/poll forces a
measurement now (the refresh button); --poke-port 0 disables.`);
  process.exit(0);
}

const env = loadEnv();
const hubUrl = opt('url', env.SUPER_LOG_URL ?? 'http://127.0.0.1:7333');
const intervalS = Number(opt('interval', 5)) || 5;
const pokePort = Number(opt('poke-port', 7338));
const once = args.includes('--once');
const mac = platform() === 'darwin';

const device = hostname().split('.')[0].toLowerCase();
const topic = `usb.${device}`;
const session = randomBytes(4).toString('hex');
let seq = 0;
let lines = [];

function publish(level, msg, fields) {
  lines.push(JSON.stringify({
    v: 1, ts: new Date().toISOString(), seq: seq++, session, level,
    origin: { runtime: 'node', app: 'usb', platform: mac ? 'macos' : 'linux', device },
    tag: 'usb', msg,
    ...(fields && Object.keys(fields).length
      ? { fields: Object.fromEntries(Object.entries(fields)
          .filter(([, v]) => v !== undefined && v !== '')
          .map(([k, v]) => [k, String(v)])) }
      : {}),
  }));
}

async function flush() {
  if (!lines.length) return;
  const body = lines.join('\n');
  lines = [];
  try {
    await fetch(`${hubUrl}/ingest/${topic}`, {
      method: 'POST', headers: { 'content-type': 'application/x-ndjson' }, body,
    });
  } catch { /* hub down; the next batch counts again */ }
}

// ------------------------------------------------------------- collectors
//
// One normalized shape out: {name, vendor?, serial?, speed?, children[]}.

const SPEED = { 0: 'low-speed', 1: 'full-speed', 2: 'high-speed',
                3: 'superspeed', 4: 'superspeed+', 5: 'superspeed+ 20G' };

function normalizeMac(item) {
  return {
    name: item['USB Product Name'] ?? item.IORegistryEntryName ?? 'device',
    vendor: item['USB Vendor Name'] ?? undefined,
    serial: item['USB Serial Number'] ?? item.kUSBSerialNumberString ?? undefined,
    speed: SPEED[item['Device Speed']] ?? undefined,
    children: (item.IORegistryEntryChildren ?? []).map(normalizeMac),
  };
}

async function collect() {
  if (mac) {
    // -l carries the product/vendor/serial properties but also binary
    // <data> blobs that plutil's JSON conversion refuses outright, so
    // they are stripped before the plist crosses over - none of the
    // fields this tree keeps live in them.
    const { stdout: xml } = await run('ioreg', ['-a', '-p', 'IOUSB', '-l', '-w0'],
                                     { timeout: 20000, maxBuffer: 64 * 1024 * 1024 });
    const cleaned = xml.replace(/<data>[\s\S]*?<\/data>/g, '<string></string>');
    const r = spawnSync('plutil', ['-convert', 'json', '-o', '-', '-'],
                        { input: cleaned, encoding: 'utf8',
                          maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0)
      throw new Error((r.stderr || 'plutil failed').slice(0, 200));
    const j = JSON.parse(r.stdout);
    return { name: device,
             children: (j.IORegistryEntryChildren ?? []).map(normalizeMac) };
  }
  const { stdout } = await run('lsusb', [], { timeout: 10000 });
  const children = stdout.split('\n').filter(Boolean).map((l) => {
    const m = /^Bus (\d+) Device (\d+): ID ([0-9a-f:]+) (.*)$/.exec(l);
    return m ? { name: m[4] || m[3], serial: `bus${m[1]}dev${m[2]}`, children: [] }
             : { name: l.trim(), children: [] };
  });
  return { name: device, children };
}

// Identity for the diff: name plus serial where one exists, path-scoped so
// two identical unserialised hubs on different ports stay distinct.
function flatten(node, path, into) {
  for (const c of node.children ?? []) {
    const key = `${path}/${c.name}${c.serial ? `#${c.serial}` : ''}`;
    into.set(key, c);
    flatten(c, key, into);
  }
  return into;
}

let prev = null;      // Map of key -> node
let lastTreeJson = '';

async function poll(first) {
  let tree;
  try {
    tree = await collect();
  } catch (e) {
    if (prev !== null)
      publish('WARN', `cannot read the device tree: ${String(e.message ?? e).slice(0, 200)}`);
    await flush();
    return;
  }
  const cur = flatten(tree, '', new Map());

  if (prev !== null) {
    for (const [key, node] of cur)
      if (!prev.has(key))
        publish('INFO', `plugged in: ${node.name}` +
          (node.vendor ? ` (${node.vendor}${node.serial ? `, serial ${node.serial}` : ''})` : ''),
          { device_name: node.name, vendor: node.vendor, serial: node.serial,
            speed: node.speed, at: key });
    for (const [key, node] of prev)
      if (!cur.has(key))
        publish('INFO', `unplugged: ${node.name}`,
          { device_name: node.name, serial: node.serial, at: key });
  }

  const treeJson = JSON.stringify(tree);
  if (first || once || treeJson !== lastTreeJson) {
    lastTreeJson = treeJson;
    publish(first || once ? 'INFO' : 'DEBUG',
      `usb tree: ${cur.size} device(s)`,
      { count: cur.size, tree: treeJson.slice(0, 16000) });
  }
  prev = cur;
  await flush();
}

const main = async () => {
  await poll(true);
  if (once) process.exit(0);

  setInterval(() => void poll(false), intervalS * 1000);

  // The poke: a viewer's refresh button asking for the measurement NOW.
  if (pokePort > 0) {
    const srv = createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/poll') {
        await poll(false);
        res.writeHead(200, { 'content-type': 'application/json',
                             'access-control-allow-origin': '*' });
        return res.end('{"ok":true}');
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'access-control-allow-origin': '*',
                             'access-control-allow-methods': 'POST' });
        return res.end();
      }
      res.writeHead(404);
      res.end();
    });
    srv.on('error', () => console.error(
      `superlog-usb: poke port ${pokePort} taken - refresh disabled, polling continues`));
    srv.listen(pokePort, '127.0.0.1');
  }

  console.error(`superlog-usb: ${topic} every ${intervalS}s` +
    (pokePort > 0 ? ` (poke on 127.0.0.1:${pokePort}/poll)` : '') + ` -> ${hubUrl}`);
};

void main();
