#!/usr/bin/env node
//
//  superlog-serial - the serial console, on the bench with everything else.
//
//  Copyright 2026 Saxon Herschel Nicholls
//
//  Embedded development happens in a terminal running screen or picocom, and
//  that terminal is a black hole: no history beyond the scrollback, no
//  filter, no search, and nothing to correlate against. The board reset at
//  14:03:11 and the server logged a dropped connection at 14:03:11 - two
//  facts in two windows that nobody put side by side.
//
//    superlog-serial --list                       # what is plugged in
//    superlog-serial --port /dev/tty.usbmodem1101
//    superlog-serial --port /dev/ttyUSB0 --baud 921600
//
//  Publishes to serial.<host>.<port>.
//
//  Zero dependency, and no native module: stty configures the line and the
//  device is then an ordinary readable file. That matters more here than
//  elsewhere - serialport needs a compiler and a rebuild per Node version,
//  which is a bad thing to need on the day the board is misbehaving.
//
//  It knows the shapes the common RTOS loggers emit - ESP-IDF, Zephyr,
//  Arduino/PlatformIO, FreeRTOS and plain bracketed levels - so an error on
//  the wire is an ERROR event with its tag, not a line of text. A panic,
//  hard fault, assert or watchdog reset is CRITICAL, because those are the
//  lines you scroll back looking for.
//
//  A board that is unplugged is not an error: it reopens the port when the
//  device returns, which is what happens every time you reflash.
//
//  Node >= 18.
//

import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { hostname, platform } from 'node:os';
import { loadEnv } from './env.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};

// The names a USB serial adaptor actually takes. cu.* rather than tty.* on
// macOS: opening tty.* blocks waiting for DCD, which on a board that is not
// asserting it means the tool simply hangs with no message.
function candidates() {
  const out = [];
  try {
    for (const f of readdirSync('/dev')) {
      if (/^cu\.(usb|wch|SLAB|usbserial|usbmodem)/i.test(f)) out.push(`/dev/${f}`);
      else if (/^ttyUSB\d+$/.test(f) || /^ttyACM\d+$/.test(f)) out.push(`/dev/${f}`);
    }
  } catch { /* no /dev to read */ }
  return out.sort();
}

if (args.includes('--list')) {
  const c = candidates();
  console.error(c.length ? `serial ports:\n  ${c.join('\n  ')}`
                         : 'no USB serial ports found (is the board plugged in?)');
  process.exit(0);
}

if (args.includes('--help') || args.includes('-h')) {
  console.error(`superlog-serial - a serial console as structured events

  superlog-serial [--port DEV] [--baud N] [--list] [--raw]
                  [--topic NAME] [--url HUB]

  superlog-serial --list
  superlog-serial --port /dev/tty.usbmodem1101 --baud 115200

Publishes to serial.<host>.<port>. ESP-IDF, Zephyr, Arduino and bracketed
levels are recognised; panics, hard faults and watchdog resets are CRITICAL.
Reopens the port when the board is reflashed or replugged.`);
  process.exit(0);
}

const env = loadEnv();
const hubUrl = opt('url', env.SUPER_LOG_URL ?? 'http://127.0.0.1:7333');
const baud = opt('baud', env.SUPER_LOG_SERIAL_BAUD ?? '115200');
const raw = args.includes('--raw');   // publish every line verbatim at INFO

const port = opt('port', env.SUPER_LOG_SERIAL_PORT ?? candidates()[0]);
if (!port) {
  console.error('superlog-serial: no --port given and no USB serial device found. ' +
                'Try --list.');
  process.exit(2);
}

const sanitize = (s) => s.toLowerCase().replace(/[^a-z0-9._-]/g, '-').replace(/^-+|-+$/g, '');
const host = sanitize(hostname().split('.')[0]);
const topic = opt('topic', `serial.${host}.${sanitize(port.replace(/^\/dev\//, ''))}`);

// -------------------------------------------------------------- parsing
//
// Each RTOS spells a level its own way; all of them put it near the front.
// Anything unmatched still ships at INFO - a board with a homemade logger is
// still worth having on the screen.

const PATTERNS = [
  // ESP-IDF:   E (12345) wifi: connect failed
  { rx: /^([EWIDV])\s+\((\d+)\)\s+([^:]{1,32}):\s*(.*)$/,
    map: (m) => ({ lvl: { E: 'ERROR', W: 'WARN', I: 'INFO', D: 'DEBUG', V: 'TRACE' }[m[1]],
                   tag: m[3], msg: m[4], uptime: m[2] }) },
  // Zephyr:    [00:00:12.345,678] <err> net_if: no route
  { rx: /^\[[\d:.,]+\]\s*<(err|wrn|inf|dbg)>\s*([^:]{1,32}):\s*(.*)$/,
    map: (m) => ({ lvl: { err: 'ERROR', wrn: 'WARN', inf: 'INFO', dbg: 'DEBUG' }[m[1]],
                   tag: m[2], msg: m[3] }) },
  // Bracketed: [ERROR] something, [W] something
  { rx: /^\[\s*(ERROR|ERR|WARN|WARNING|INFO|DEBUG|TRACE|E|W|I|D|V)\s*\]\s*(.*)$/i,
    map: (m) => ({ lvl: levelName(m[1]), msg: m[2] }) },
  // Prefixed:  ERROR: something
  { rx: /^(ERROR|WARN|WARNING|INFO|DEBUG|TRACE|FATAL)\s*:\s*(.*)$/i,
    map: (m) => ({ lvl: levelName(m[1]), msg: m[2] }) },
];

function levelName(s) {
  const k = s.toUpperCase();
  if (k.startsWith('F')) return 'CRITICAL';
  if (k.startsWith('E')) return 'ERROR';
  if (k.startsWith('W')) return 'WARN';
  if (k.startsWith('D')) return 'DEBUG';
  if (k.startsWith('V') || k.startsWith('T')) return 'TRACE';
  return 'INFO';
}

// The lines you scroll back hunting for. A board that faulted has usually
// also reset, so the evidence is above a wall of boot banner - which is
// exactly why it deserves a level that survives a filter.
const FATAL = /(Guru Meditation|panic|PANIC|Hard ?Fault|HardFault|BusFault|MemManage|UsageFault|assert(ion)? fail|ASSERT|abort\(\)|Kernel panic|watchdog|WDT reset|rst cause|Stack overflow|CORRUPT HEAP|LoadProhibited|StoreProhibited|IllegalInstruction)/;
// A reset is not a failure, but knowing exactly when one happened is often
// the whole answer.
const BOOT = /(ets [A-Z][a-z]{2} +\d|rst:0x|boot: ESP-IDF|Booting Zephyr|\*\*\* Booting|U-Boot \d|Starting kernel|SYSTEM RESET|Build:)/;

function classify(line) {
  if (FATAL.test(line)) return { lvl: 'CRITICAL', msg: line };
  for (const p of PATTERNS) {
    const m = p.rx.exec(line);
    if (m) {
      const g = p.map(m);
      if (g.lvl) return { lvl: g.lvl, msg: g.msg || line, tag: g.tag, uptime: g.uptime };
    }
  }
  if (BOOT.test(line)) return { lvl: 'INFO', msg: line, boot: true };
  return { lvl: 'INFO', msg: line };
}

// ------------------------------------------------------------ publishing

const session = Math.random().toString(16).slice(2, 10);
let buf = [];
let seq = 0;

function publish(level, msg, fields) {
  buf.push(JSON.stringify({
    v: 1, ts: new Date().toISOString(), seq: seq++, session, level,
    origin: { runtime: 'serial', app: 'board', platform: 'embedded', device: host },
    ...(fields?.tag ? { tag: fields.tag } : {}),
    msg,
    ...(fields && Object.keys(fields).some((k) => k !== 'tag')
      ? { fields: Object.fromEntries(Object.entries(fields).filter(([k]) => k !== 'tag')) }
      : {}),
  }));
  if (buf.length >= 256) void flush();
}

async function flush() {
  if (!buf.length) return;
  const body = buf.join('\n');
  buf = [];
  try {
    await fetch(`${hubUrl}/ingest/${topic}`, {
      method: 'POST', headers: { 'content-type': 'application/x-ndjson' }, body,
    });
  } catch {
    /* hub down; the next batch counts again */
  }
}
setInterval(() => void flush(), 250).unref?.();

// ---------------------------------------------------------------- device

/** stty, because configuring a line discipline from Node without a native
 *  module is not otherwise possible - and -F vs -f is the one flag that
 *  differs between GNU and BSD. */
function configure() {
  return new Promise((resolve) => {
    const flag = platform() === 'linux' ? '-F' : '-f';
    const opts = platform() === 'linux'
      ? [flag, port, String(baud), 'raw', '-echo', '-hupcl', 'cs8', '-cstopb', '-parenb']
      : [flag, port, String(baud), 'raw', '-echo', 'cs8', '-parenb'];
    const p = spawn('stty', opts, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', () => resolve('stty not found'));
    p.on('close', (code) => resolve(code === 0 ? null : err.trim() || `stty exited ${code}`));
  });
}

let carry = '';
let binaryWarned = false;

// A wrong baud rate produces bytes, not silence, so it looks like the board
// is talking gibberish rather than like a misconfiguration. Say which it is.
function looksBinary(s) {
  let bad = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13) continue;
    if (c < 32 || c === 0xfffd) bad += 1;
  }
  return s.length > 8 && bad / s.length > 0.3;
}

function onData(chunk) {
  const text = carry + chunk.toString('utf8');
  const lines = text.split(/\r?\n/);
  carry = lines.pop() ?? '';
  if (carry.length > 4096) { carry = ''; }   // a board emitting no newlines
  for (const line of lines) {
    const clean = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trimEnd();
    if (!clean) continue;
    if (!binaryWarned && looksBinary(clean)) {
      publish('WARN', `unreadable bytes on ${port} - wrong baud rate? (trying ${baud})`,
              { port, baud: String(baud), change: 'garbled' });
      binaryWarned = true;
    }
    if (raw) { publish('INFO', clean, { port }); continue; }
    const c = classify(clean);
    publish(c.lvl, c.msg, {
      port, ...(c.tag ? { tag: c.tag } : {}),
      ...(c.uptime ? { uptime_ms: c.uptime } : {}),
      ...(c.boot ? { change: 'boot' } : {}),
    });
  }
}

async function open() {
  if (!existsSync(port)) {
    // Reflashing removes the device for a second or two. Waiting quietly is
    // the correct behaviour; complaining every 500ms is not.
    setTimeout(open, 1000);
    return;
  }
  const problem = await configure();
  if (problem) {
    publish('WARN', `could not configure ${port}: ${problem}`, { port, change: 'stty-failed' });
  }
  publish('INFO', `serial console open on ${port} at ${baud} baud`,
          { port, baud: String(baud), change: 'open' });

  const s = createReadStream(port, { highWaterMark: 4096 });
  s.on('data', onData);
  s.on('error', (e) => {
    publish('WARN', `${port}: ${e.message}`, { port, change: 'error' });
    s.destroy();
    setTimeout(open, 1000);
  });
  s.on('close', () => {
    // The board was unplugged or reset into the bootloader. Normal.
    publish('DEBUG', `${port} closed - waiting for it to come back`, { port, change: 'closed' });
    setTimeout(open, 1000);
  });
}

process.on('SIGINT', async () => { await flush(); process.exit(130); });
process.on('SIGTERM', async () => { await flush(); process.exit(143); });

console.error(`superlog-serial: ${port} at ${baud} baud -> ${topic}`);
void open();
