#!/usr/bin/env node
//
//  superlog-tail - host-side tailers for the four React Native streams.
//
//  Copyright 2026 Saxon Herschel Nicholls
//
//  Zero app changes: scrape what the device already says (adb logcat, the
//  simulator's unified log), reshape each line into a PROTOCOL.md event, and
//  batch-POST to superlogd. The in-app @super-log/client is the better
//  citizen; this is the fallback that works on any build, today.
//
//    superlog-tail android                        # emulator (adb, first device)
//    superlog-tail android --serial R5CT30ABCDE   # hardware -> expo.android.device
//    superlog-tail ios-sim                        # booted simulator
//    superlog-tail ios-sim --process Expo         # only that process
//
//  Options: --url http://127.0.0.1:7333  --topic <override>
//           --serial <adb serial>  --udid <simulator udid>
//           --process <name>  --predicate '<os_log predicate>'
//
//  Node >= 18, no dependencies. iOS *hardware* needs a companion tool
//  (pymobiledevice3 / idevicesyslog) - see tailers/README.md and HANDOFF M4.
//

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { hostname } from 'node:os';

const args = process.argv.slice(2);
const mode = args[0];
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};

const url = opt('url', process.env.SUPER_LOG_URL ?? 'http://127.0.0.1:7333');
const serial = opt('serial');
const udid = opt('udid', 'booted');
const procName = opt('process');
const predicate = opt('predicate');

const FLUSH_MS = 250;
const MAX_BATCH = 500;
const session = Math.random().toString(16).slice(2, 10);

// logcat V/D/I/W/E/F -> PROTOCOL.md levels
const LOGCAT_LEVEL = { V: 'TRACE', D: 'DEBUG', I: 'INFO', W: 'WARN', E: 'ERROR', F: 'CRITICAL' };
// Apple unified log messageType -> levels
const OSLOG_LEVEL = { Debug: 'DEBUG', Default: 'INFO', Info: 'INFO', Error: 'ERROR', Fault: 'CRITICAL' };

let seq = 0;
let buf = [];
let posted = 0, failed = 0;

function push(event) {
  buf.push(JSON.stringify(event));
  if (buf.length >= MAX_BATCH) void flush();
}

async function flush() {
  if (buf.length === 0) return;
  const body = buf.join('\n');
  buf = [];
  try {
    await fetch(`${url}/ingest/${topic}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-ndjson' },
      body,
    });
    posted++;
  } catch {
    failed++; // hub down; the stream goes on, the next batch counts again
  }
}

function baseEvent(level, msg, platform, device, tag) {
  const ev = {
    v: 1,
    ts: new Date().toISOString(),
    seq: seq++,
    session,
    level,
    origin: { runtime: 'react-native', app: 'tailer', platform, device },
    msg,
  };
  if (tag) ev.tag = tag;
  return ev;
}

function run(cmd, cmdArgs, onLine) {
  const child = spawn(cmd, cmdArgs, { stdio: ['ignore', 'pipe', 'inherit'] });
  child.on('error', (e) => {
    console.error(`superlog-tail: cannot run ${cmd}: ${e.message}`);
    process.exit(1);
  });
  child.on('exit', (code) => {
    void flush().then(() => {
      console.error(`superlog-tail: ${cmd} exited (${code}); batches posted=${posted} failed=${failed}`);
      process.exit(code ?? 0);
    });
  });
  createInterface({ input: child.stdout }).on('line', onLine);
  const stop = () => child.kill('SIGTERM');
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

let topic;

if (mode === 'android') {
  // Hardware serials are not "emulator-*"; the topic follows the device.
  const isEmulator = !serial || serial.startsWith('emulator-');
  topic = opt('topic', isEmulator ? 'expo.android.emu' : 'expo.android.device');
  const platform = 'android';
  const device = serial ?? 'emulator';
  const adbArgs = serial ? ['-s', serial] : [];
  // threadtime: "08-22 13:01:02.345  1234  5678 I ReactNativeJS: hello"
  run('adb', [...adbArgs, 'logcat', '-v', 'threadtime'], (line) => {
    const m = line.match(/^\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+\s+\d+\s+\d+\s+([VDIWEF])\s+([^:]+):\s?(.*)$/);
    if (m) {
      push(baseEvent(LOGCAT_LEVEL[m[1]] ?? 'INFO', m[3], platform, device, m[2].trim()));
    } else if (line.trim()) {
      push(baseEvent('INFO', line, platform, device)); // tolerant-reader rule, producer side
    }
  });
} else if (mode === 'ios-sim') {
  topic = opt('topic', 'expo.ios.sim');
  const streamArgs = ['simctl', 'spawn', udid, 'log', 'stream', '--style', 'ndjson', '--level', 'debug'];
  if (procName) streamArgs.push('--process', procName);
  if (predicate) streamArgs.push('--predicate', predicate);
  run('xcrun', streamArgs, (line) => {
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      return; // log stream prints a non-JSON banner line first
    }
    if (!j.eventMessage) return;
    push(
      baseEvent(
        OSLOG_LEVEL[j.messageType] ?? 'INFO',
        j.eventMessage,
        'ios',
        `simulator:${udid}`,
        j.subsystem || j.processImagePath?.split('/').pop(),
      ),
    );
  });
} else {
  console.error('usage: superlog-tail <android|ios-sim> [--serial S] [--udid U] [--topic T] [--url U] [--process P] [--predicate Q]');
  console.error('       ios hardware: see tailers/README.md');
  process.exit(2);
}

console.error(`superlog-tail: ${mode} -> ${url}/ingest/${topic} (host ${hostname()})`);
setInterval(() => void flush(), FLUSH_MS);
