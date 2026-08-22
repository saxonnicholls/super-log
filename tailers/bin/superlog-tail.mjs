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
//    superlog-tail os --process superlogd         # this Mac's unified log -> os.<host>
//    superlog-tail os-linux --unit myapp.service  # journald               -> os.<host>
//    superlog-tail ssh my-server                 # a REMOTE machine's OS logs,
//                                                 # OS auto-detected (mac/linux/
//                                                 # windows), nothing installed there
//    superlog-tail file /var/log/nginx/error.log  # an app's log file -> app.<host>.nginx.error
//    superlog-tail ssh db1 --file /var/log/postgresql/postgresql-16-main.log
//
//  The os modes run on ANY machine on the bench LAN, pointed at the hub with
//  --url http://<bench>:7333 - the topic carries the hostname, so several
//  machines' OS logs sit beside the app streams and beside each other. The
//  ssh mode inverts the transport: logs come TO the bench over ssh, so the
//  hub can stay loopback-bound and the remote needs no hub access at all.
//
//  Options: --url http://127.0.0.1:7333  --topic <override>
//           --serial <adb serial>  --udid <simulator udid>
//           --process <name>  --predicate '<os_log predicate>'
//           --level <default|info|debug>  (os; default: default)
//           --unit <systemd unit>         (os-linux)
//
//  Node >= 18, no dependencies. iOS *hardware* needs a companion tool
//  (pymobiledevice3 / idevicesyslog) - see tailers/README.md and HANDOFF M4.
//

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { hostname } from 'node:os';

import { APP_CATALOG, patternsFor, resolveApp } from './app-catalog.mjs';

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
// journald PRIORITY (syslog severities) -> levels
const JOURNALD_LEVEL = ['CRITICAL', 'CRITICAL', 'CRITICAL', 'ERROR', 'WARN', 'INFO', 'INFO', 'DEBUG'];

// Topic pieces must fit the PROTOCOL.md charset
const sanitizePart = (s) => s.toLowerCase().replace(/[^a-z0-9._-]/g, '-');
const sanitizeName = (h) => sanitizePart(h.split('.')[0]);
const shortHost = () => sanitizeName(hostname());

let seq = 0;
// One buffer per topic: most modes speak one topic, the app mode tails
// several files at once and each file is its own stream.
const bufs = new Map();
let posted = 0, failed = 0;

function push(event, toTopic = topic) {
  let b = bufs.get(toTopic);
  if (!b) bufs.set(toTopic, (b = []));
  b.push(JSON.stringify(event));
  if (b.length >= MAX_BATCH) void flushTopic(toTopic);
}

async function flushTopic(t) {
  const lines = bufs.get(t);
  if (!lines || lines.length === 0) return;
  bufs.set(t, []);
  try {
    await fetch(`${url}/ingest/${t}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-ndjson' },
      body: lines.join('\n'),
    });
    posted++;
  } catch {
    failed++; // hub down; the stream goes on, the next batch counts again
  }
}

async function flush() {
  await Promise.all([...bufs.keys()].map(flushTopic));
}

function baseEvent(level, msg, origin, tag, ts) {
  const ev = {
    v: 1,
    ts: ts ?? new Date().toISOString(),
    seq: seq++,
    session,
    level,
    origin,
    msg,
  };
  if (tag) ev.tag = tag;
  return ev;
}

const rnOrigin = (platform, device) => ({ runtime: 'react-native', app: 'tailer', platform, device });
const osOrigin = (platform) => ({ runtime: 'node', app: 'os-tailer', platform, device: hostname() });
const sshOrigin = (platform, host) => ({ runtime: 'node', app: 'ssh-tailer', platform, device: host });

// One line-parser per feed shape, shared by the local modes and the ssh
// mode - a machine's logs look the same whether the pipe is local or ssh.

const oslogLine = (origin) => (line) => {
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
      origin,
      j.subsystem || j.processImagePath?.split('/').pop(),
    ),
  );
};

const journaldLine = (origin) => (line) => {
  let j;
  try {
    j = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof j.MESSAGE !== 'string') return; // binary payloads arrive as byte arrays
  const us = Number(j.__REALTIME_TIMESTAMP);
  push(
    baseEvent(
      JOURNALD_LEVEL[Number(j.PRIORITY)] ?? 'INFO',
      j.MESSAGE,
      origin,
      j.SYSLOG_IDENTIFIER || j._COMM,
      Number.isFinite(us) ? new Date(us / 1000).toISOString() : undefined,
    ),
  );
};

// Windows event levels, as Get-WinEvent's LevelDisplayName spells them
const WINEVENT_LEVEL = {
  Critical: 'CRITICAL', Error: 'ERROR', Warning: 'WARN',
  Information: 'INFO', Verbose: 'DEBUG',
};

// ---- app log files: nginx, postgres, and anything else worth tailing ----
// One parser per format; each returns {level, msg} or null for "not this
// shape" (continuation lines, unexpected prefixes), which falls back to
// generic - the tolerant-reader rule, producer side.

const NGINX_LEVEL = {
  debug: 'DEBUG', info: 'INFO', notice: 'INFO', warn: 'WARN',
  error: 'ERROR', crit: 'CRITICAL', alert: 'CRITICAL', emerg: 'CRITICAL',
};
const PG_LEVEL = {
  LOG: 'INFO', INFO: 'INFO', NOTICE: 'INFO', WARNING: 'WARN',
  ERROR: 'ERROR', FATAL: 'CRITICAL', PANIC: 'CRITICAL',
};

const FILE_FORMATS = {
  // error log: 2026/08/22 12:01:02 [error] 123#0: *45 the message
  nginx: (line) => {
    const m = line.match(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2} \[(\w+)\] (.*)$/);
    return m ? { level: NGINX_LEVEL[m[1]] ?? 'INFO', msg: m[2] } : null;
  },
  // combined access log: the status code is the only level there is
  'nginx-access': (line) => {
    const m = line.match(/" (\d{3}) /);
    const s = m ? Number(m[1]) : 0;
    return { level: s >= 500 ? 'ERROR' : s >= 400 ? 'WARN' : 'INFO', msg: line };
  },
  // default log_line_prefix: 2026-08-22 12:01:02.123 UTC [123] LOG:  msg
  postgres: (line) => {
    const m = line.match(/^\d{4}-\d{2}-\d{2} [\d:.]+ \S+ \[\d+\] (?:\S+@\S+ )?([A-Z]+\d?):\s?(.*)$/);
    if (!m) return null;
    if (PG_LEVEL[m[1]]) return { level: PG_LEVEL[m[1]], msg: m[2] };
    if (/^DEBUG\d?$/.test(m[1])) return { level: 'DEBUG', msg: m[2] };
    return null;
  },
  // [Fri Aug 22 13:01:02.123456 2026] [core:error] [pid 123] the message
  apache: (line) => {
    const m = line.match(/^\[[^\]]+\] \[(?:[\w-]+:)?(\w+)\] (.*)$/);
    return m ? { level: NGINX_LEVEL[m[1]] ?? 'INFO', msg: m[2] } : null;
  },
  // 123:M 22 Aug 2026 13:01:02.123 * message  (. debug  - verbose  * notice  # warning)
  redis: (line) => {
    const m = line.match(/^\d+:[XCSM] \d{1,2} \w{3} \d{4} [\d:.]+ ([.\-*#]) (.*)$/);
    if (!m) return null;
    return { level: { '.': 'DEBUG', '-': 'DEBUG', '*': 'INFO', '#': 'WARN' }[m[1]] ?? 'INFO', msg: m[2] };
  },
  // mongod 4.4+: one JSON object per line, severity in "s"
  mongodb: (line) => {
    if (!line.startsWith('{')) return null;
    try {
      const j = JSON.parse(line);
      const lv = { F: 'CRITICAL', E: 'ERROR', W: 'WARN', I: 'INFO' }[j.s] ?? (String(j.s).startsWith('D') ? 'DEBUG' : 'INFO');
      return { level: lv, msg: typeof j.msg === 'string' ? j.msg : line };
    } catch {
      return null;
    }
  },
  // the Java family (kafka, zookeeper, elasticsearch): a level word in brackets
  // or after the timestamp bracket
  log4j: (line) => {
    const m = line.match(/\[(TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\s*\]|\]\s+(TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\s+/);
    const w = m?.[1] ?? m?.[2];
    return w ? { level: w === 'FATAL' ? 'CRITICAL' : w, msg: line } : null;
  },
  // 2026/08/22-13:01:02.123456 7f8b [WARN] [db/x.cc:123] the message
  rocksdb: (line) => {
    const m = line.match(/^\d{4}\/\d{2}\/\d{2}-[\d:.]+ \w+ \[(\w+)\] ?(.*)$/);
    if (!m) return null;
    const w = m[1].toUpperCase();
    const map = { WARN: 'WARN', ERROR: 'ERROR', FATAL: 'CRITICAL', DEBUG: 'DEBUG' };
    return { level: map[w] ?? 'INFO', msg: m[2] };
  },
  generic: (line) => ({
    level: /fatal|crit|panic|emerg/i.test(line) ? 'CRITICAL'
      : /\berror\b|\berr\b/i.test(line) ? 'ERROR'
      : /warn|fail/i.test(line) ? 'WARN'
      : /debug/i.test(line) ? 'DEBUG'
      : 'INFO',
    msg: line,
  }),
};

const guessFormat = (p) =>
  /postgres/i.test(p) ? 'postgres'
    : /nginx.*access|access[._-]?log/i.test(p) ? 'nginx-access'
    : /nginx/i.test(p) ? 'nginx'
    : /apache2|httpd/i.test(p) ? 'apache'
    : /redis/i.test(p) ? 'redis'
    : /mongo/i.test(p) ? 'mongodb'
    : /kafka|zookeeper|elasticsearch/i.test(p) ? 'log4j'
    : 'generic';

// The path usually knows best; the catalog entry is the fallback
const fmtFor = (file, fallback) => {
  const g = guessFormat(file);
  return g === 'generic' ? (fallback ?? 'generic') : g;
};

// app.<host>.<label>: label from the last two path pieces (nginx/error.log
// -> nginx.error), because filenames alone collide (everything is error.log)
const fileLabel = (p) =>
  sanitizePart(p.split('/').filter(Boolean).slice(-2).join('.').replace(/\.log$/, ''));

const fileLine = (origin, fmt, tag, toTopic) => (line) => {
  if (!line.trim()) return;
  const g = FILE_FORMATS[fmt]?.(line) ?? FILE_FORMATS.generic(line);
  push(baseEvent(g.level, g.msg, origin, tag), toTopic);
};

// tail -F over several files interleaves "==> path <==" headers; track them
// so each file keeps its own handler (and therefore its own topic).
const multiTailLine = (handlerFor) => {
  let current = null;
  return (line) => {
    const m = line.match(/^==> (.+) <==$/);
    if (m) {
      current = handlerFor(m[1]);
      return;
    }
    current?.(line);
  };
};

const winEventLine = (origin) => (line) => {
  let j;
  try {
    j = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof j.msg !== 'string' || !j.msg) return;
  push(
    baseEvent(
      WINEVENT_LEVEL[j.level] ?? 'INFO',
      j.msg,
      origin,
      j.provider,
      typeof j.time === 'string' ? j.time : undefined,
    ),
  );
};

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
  const origin = rnOrigin('android', serial ?? 'emulator');
  const adbArgs = serial ? ['-s', serial] : [];
  // threadtime: "08-22 13:01:02.345  1234  5678 I ReactNativeJS: hello"
  run('adb', [...adbArgs, 'logcat', '-v', 'threadtime'], (line) => {
    const m = line.match(/^\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+\s+\d+\s+\d+\s+([VDIWEF])\s+([^:]+):\s?(.*)$/);
    if (m) {
      push(baseEvent(LOGCAT_LEVEL[m[1]] ?? 'INFO', m[3], origin, m[2].trim()));
    } else if (line.trim()) {
      push(baseEvent('INFO', line, origin)); // tolerant-reader rule, producer side
    }
  });
} else if (mode === 'ios-sim') {
  topic = opt('topic', 'expo.ios.sim');
  const origin = rnOrigin('ios', `simulator:${udid}`);
  const streamArgs = ['simctl', 'spawn', udid, 'log', 'stream', '--style', 'ndjson', '--level', 'debug'];
  if (procName) streamArgs.push('--process', procName);
  if (predicate) streamArgs.push('--predicate', predicate);
  run('xcrun', streamArgs, oslogLine(origin));
} else if (mode === 'os') {
  // This Mac's own unified log, beside the app streams - the "what was the
  // OS doing at that moment" view. Run one per machine, pointed at the
  // bench hub; the hostname in the topic keeps the machines apart.
  topic = opt('topic', `os.${shortHost()}`);
  const origin = osOrigin('macos');
  const level = opt('level', 'default'); // NOT debug: that firehose is torrential
  const streamArgs = ['stream', '--style', 'ndjson', '--level', level];
  if (procName) streamArgs.push('--process', procName);
  if (predicate) streamArgs.push('--predicate', predicate);
  if (!procName && !predicate)
    console.error('superlog-tail: os with no --process/--predicate is the whole unified log - expect volume');
  run('log', streamArgs, oslogLine(origin));
} else if (mode === 'os-linux') {
  // journald, same shape: any Linux box on the LAN can put its OS logs on
  // the bench. WRITTEN, NOT VERIFIED against a live journald yet - the dev
  // machines here are Macs (ledger honesty; expect one round of fixes).
  topic = opt('topic', `os.${shortHost()}`);
  const origin = osOrigin('linux');
  const unit = opt('unit');
  const jArgs = ['-f', '-o', 'json', '-n', '0'];
  if (unit) jArgs.push('-u', unit);
  run('journalctl', jArgs, journaldLine(origin));
} else if (mode === 'file') {
  // App-specific log files - nginx, postgres, anything that writes a file.
  // tail -F follows by name, so logrotate cannot silently end the stream.
  //   superlog-tail file /var/log/nginx/error.log            # format guessed
  //   superlog-tail file /opt/pg/log/postgresql.log --format postgres
  const path = args[1];
  if (!path || path.startsWith('--')) {
    console.error('usage: superlog-tail file <path> [--format nginx|nginx-access|postgres|generic] [--topic T] [--url U]');
    process.exit(2);
  }
  const fmt = opt('format', guessFormat(path));
  const label = fileLabel(path);
  topic = opt('topic', `app.${shortHost()}.${label}`);
  const origin = osOrigin(process.platform === 'darwin' ? 'macos' : 'linux');
  run('tail', ['-n', '0', '-F', path], fileLine(origin, fmt, label));
} else if (mode === 'apps') {
  // Discovery: what does THIS machine have to say? Prints the catalog with
  // what actually exists here, and the exact command to turn it on.
  const plat = process.platform === 'darwin' ? 'darwin' : 'linux';
  console.error(`superlog-tail: known app logs on this machine (${plat}/${process.arch}):`);
  const on = [];
  for (const name of Object.keys(APP_CATALOG)) {
    const r = resolveApp(name, process.platform);
    if (r.files.length) {
      on.push(name);
      for (const f of r.files) console.error(`  + ${name.padEnd(14)} ${f}`);
    } else {
      console.error(`  - ${name.padEnd(14)} ${r.note ?? '(no default log file found)'}`);
    }
  }
  if (on.length) {
    console.error(`\nturn on:   superlog-tail app ${on.join(' ')}`);
    console.error(`the demo:  SUPER_LOG_APPS="${on.join(' ')}" ./demo/run.sh`);
  } else {
    console.error('\nnothing found at default paths - superlog-tail file <path> works for anything');
  }
  process.exit(0);
} else if (mode === 'app') {
  // The catalog, switched on by name - one process, one tail per found
  // file, one topic per stream: app.<host>.<name>[.<file>]
  const names = [];
  for (let i = 1; i < args.length && !args[i].startsWith('--'); i++) names.push(args[i]);
  if (!names.length) {
    console.error('usage: superlog-tail app <name...> [--url U]   (superlog-tail apps lists the catalog)');
    process.exit(2);
  }
  const origin = osOrigin(process.platform === 'darwin' ? 'macos' : 'linux');
  topic = `app.${shortHost()}.*`; // the banner line; real topics are per stream
  const children = [];
  let started = 0;
  for (const name of names) {
    const r = resolveApp(name, process.platform);
    if (!r) {
      console.error(`superlog-tail: unknown app '${name}' - superlog-tail apps lists the catalog`);
      continue;
    }
    if (!r.files.length) {
      console.error(`superlog-tail: ${name}: no default log found here${r.note ? ` - ${r.note}` : ''}`);
      continue;
    }
    for (const f of r.files) {
      const base = sanitizePart((f.split('/').pop() ?? '').replace(/\.log$/, ''));
      const label = r.files.length > 1 ? `${name}.${base}` : name;
      const t = `app.${shortHost()}.${label}`;
      const c = spawn('tail', ['-n', '0', '-F', f], { stdio: ['ignore', 'pipe', 'inherit'] });
      createInterface({ input: c.stdout }).on('line', fileLine(origin, fmtFor(f, r.format), label, t));
      c.on('exit', (code) => console.error(`superlog-tail: tail ${f} exited (${code})`));
      children.push(c);
      console.error(`superlog-tail: ${name}: ${f} -> ${url}/ingest/${t}`);
      started++;
    }
  }
  if (!started) process.exit(2);
  for (const sig of ['SIGINT', 'SIGTERM'])
    process.on(sig, () => {
      children.forEach((c) => c.kill('SIGTERM'));
      void flush().then(() => process.exit(0));
    });
} else if (mode === 'ssh') {
  // A remote machine's OS logs, no install on the remote: detect its OS
  // over ssh, spawn the right stream command there, parse here. The logs
  // travel to the bench over ssh, so the hub can stay loopback-bound and
  // the remote never needs to reach it - the tightest of the transports.
  //
  //   superlog-tail ssh my-server                # uses ~/.ssh/config, keys
  //   superlog-tail ssh user@10.0.1.9 --process MyApp
  //
  // Reconnects for as long as it runs; detection re-runs each time, so a
  // host that was down at start joins when it comes up.
  const dest = args[1];
  if (!dest || dest.startsWith('--')) {
    console.error('usage: superlog-tail ssh <destination> [--process P] [--predicate Q] [--level L] [--unit U] [--winlog LOG] [--topic T] [--url U]');
    process.exit(2);
  }
  const host = sanitizeName(dest.includes('@') ? dest.split('@')[1] : dest);
  // --file or --app switch the feed from the OS log to app logs there
  const filePath = opt('file');
  const appName = opt('app');
  topic = opt('topic',
    filePath ? `app.${host}.${fileLabel(filePath)}`
      : appName ? `app.${host}.${sanitizePart(appName)}`
      : `os.${host}`);
  const SSH_BASE = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-T'];
  const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const sshOnce = (cmd) =>
    new Promise((resolve) => {
      const c = spawn('ssh', [...SSH_BASE, dest, cmd], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      c.stdout.on('data', (d) => (out += d));
      c.on('error', () => resolve(''));
      c.on('exit', () => resolve(out.trim()));
    });

  const detectOs = async () => {
    const uname = await sshOnce('uname -s');
    if (/^Darwin/m.test(uname)) return 'darwin';
    if (/^Linux/m.test(uname)) return 'linux';
    // No uname: probably Windows OpenSSH (cmd or PowerShell default shell)
    if (/Windows/i.test(await sshOnce('cmd /c ver'))) return 'windows';
    return null;
  };

  const remoteFor = async (os) => {
    const platform = os === 'darwin' ? 'macos' : os;
    if (appName) {
      // The catalog's default paths, expanded by the REMOTE shell - ls
      // globs there and keeps what exists. Patterns are our own static
      // data, so embedding them unquoted is deliberate and safe.
      if (os === 'windows') {
        console.error('superlog-tail: ssh --app is macOS/Linux only for now (--file works anywhere tail does)');
        process.exit(2);
      }
      const pats = patternsFor(appName, os);
      if (!pats) {
        console.error(`superlog-tail: unknown app '${appName}' - superlog-tail apps lists the catalog`);
        process.exit(2);
      }
      const found = (await sshOnce(`ls -1 ${pats.join(' ')} 2>/dev/null`))
        .split('\n').filter(Boolean).slice(0, 8);
      if (!found.length) {
        console.error(`superlog-tail: ${dest}: no ${appName} log at its default paths - use --file <path> for a custom location`);
        process.exit(2);
      }
      const entry = APP_CATALOG[appName];
      const org = sshOrigin(platform, host);
      const handlerFor = (p) => {
        const base = sanitizePart((p.split('/').pop() ?? '').replace(/\.log$/, ''));
        const label = found.length > 1 ? `${appName}.${base}` : appName;
        return fileLine(org, fmtFor(p, entry.format), label, `app.${host}.${label}`);
      };
      for (const f of found) console.error(`superlog-tail: ${dest} ${appName}: ${f}`);
      return {
        cmd: `tail -n 0 -F ${found.map(shq).join(' ')}`,
        onLine: found.length > 1 ? multiTailLine(handlerFor) : handlerFor(found[0]),
      };
    }
    if (filePath) {
      const fmt = opt('format', guessFormat(filePath));
      const onLine = fileLine(sshOrigin(platform, host), fmt, fileLabel(filePath));
      if (os === 'windows') {
        // PowerShell's tail -F; WRITTEN, NOT VERIFIED like the event-log path
        const ps = `Get-Content -LiteralPath '${filePath.replace(/'/g, "''")}' -Wait -Tail 0`;
        const enc = Buffer.from(ps, 'utf16le').toString('base64');
        return { cmd: `powershell -NoProfile -NonInteractive -EncodedCommand ${enc}`, onLine };
      }
      return { cmd: `tail -n 0 -F ${shq(filePath)}`, onLine };
    }
    if (os === 'darwin') {
      let cmd = `/usr/bin/log stream --style ndjson --level ${shq(opt('level', 'default'))}`;
      if (procName) cmd += ` --process ${shq(procName)}`;
      if (predicate) cmd += ` --predicate ${shq(predicate)}`;
      if (!procName && !predicate)
        console.error(`superlog-tail: ${dest} unified log with no --process/--predicate - expect volume`);
      return { cmd, onLine: oslogLine(sshOrigin('macos', host)) };
    }
    if (os === 'linux') {
      // The remote user needs journal access (systemd-journal group)
      let cmd = 'journalctl -f -o json -n 0';
      const unit = opt('unit');
      if (unit) cmd += ` -u ${shq(unit)}`;
      return { cmd, onLine: journaldLine(sshOrigin('linux', host)) };
    }
    // Windows: no native "follow", so a small polling loop over Get-WinEvent,
    // shipped as -EncodedCommand - base64 survives every remote shell where
    // three layers of quoting would not. WRITTEN, NOT VERIFIED: no Windows
    // machine on this bench yet (ledger honesty; expect one round of fixes).
    const winlog = (opt('winlog', 'System') ?? 'System').replace(/[^\w /-]/g, '');
    const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$log = '${winlog}'
$last = (Get-WinEvent -LogName $log -MaxEvents 1).RecordId
if (-not $last) { $last = 0 }
while ($true) {
  $evts = Get-WinEvent -LogName $log -MaxEvents 500 | Where-Object { $_.RecordId -gt $last } | Sort-Object RecordId
  foreach ($e in $evts) {
    $last = $e.RecordId
    ConvertTo-Json -Compress -InputObject @{
      level = $e.LevelDisplayName; provider = $e.ProviderName
      msg = $e.Message; time = $e.TimeCreated.ToUniversalTime().ToString('o')
    }
  }
  Start-Sleep -Seconds 2
}`;
    const enc = Buffer.from(ps, 'utf16le').toString('base64');
    return {
      cmd: `powershell -NoProfile -NonInteractive -EncodedCommand ${enc}`,
      onLine: winEventLine(sshOrigin('windows', host)),
    };
  };

  let sshChild;
  let stopping = false;
  for (const sig of ['SIGINT', 'SIGTERM'])
    process.on(sig, () => {
      stopping = true;
      sshChild?.kill('SIGTERM');
      void flush().then(() => process.exit(0));
    });

  const streamOnce = (cmd, onLine) =>
    new Promise((resolve) => {
      sshChild = spawn('ssh', [...SSH_BASE, dest, cmd], { stdio: ['ignore', 'pipe', 'inherit'] });
      sshChild.on('error', () => resolve(-1));
      sshChild.on('exit', (code) => resolve(code ?? 0));
      createInterface({ input: sshChild.stdout }).on('line', onLine);
    });

  void (async () => {
    for (;;) {
      const os = await detectOs();
      if (stopping) return;
      if (!os) {
        console.error(`superlog-tail: cannot reach ${dest} or detect its OS; retrying in 5s`);
        await sleep(5000);
        continue;
      }
      console.error(`superlog-tail: ${dest} is ${os} -> ${url}/ingest/${topic}`);
      const { cmd, onLine } = await remoteFor(os);
      const code = await streamOnce(cmd, onLine);
      await flush();
      if (stopping) return;
      console.error(`superlog-tail: ssh ${dest} exited (${code}); reconnecting in 3s`);
      await sleep(3000);
    }
  })();
} else {
  console.error('usage: superlog-tail <android|ios-sim|os|os-linux|file <path>|ssh <dest>> [--serial S] [--udid U] [--topic T] [--url U] [--process P] [--predicate Q] [--level L] [--unit U] [--winlog LOG] [--file PATH] [--format F]');
  console.error('       ios hardware: see tailers/README.md');
  process.exit(2);
}

console.error(`superlog-tail: ${mode} -> ${url}/ingest/${topic} (host ${hostname()})`);
setInterval(() => void flush(), FLUSH_MS);
