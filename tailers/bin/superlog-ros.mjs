#!/usr/bin/env node
//
//  superlog-ros - a robot's nodes on the bench with everything else.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  A robot is a distributed system that happens to be in one room. A dozen
//  nodes, each with its own logger, and the interesting failures are the
//  ones between them: perception published late, the planner used a stale
//  transform, the driver e-stopped. `ros2 topic echo /rosout` shows you
//  that, in a terminal, unfiltered, with no history and nothing else on the
//  screen - so the moment the question involves the server the robot talks
//  to, or the build that produced the firmware, you are correlating by
//  wall-clock and memory.
//
//    superlog-ros                      # /rosout, ROS 2 or ROS 1, auto-detected
//    superlog-ros --node /planner      # one node only
//    superlog-ros --files              # ~/.ros/log, including past runs
//    superlog-ros --ssh robot1         # the robot, from the bench
//
//  Publishes to ros.<host>.<node> - one topic per node, so the planner and
//  the perception stack are separable in the viewer rather than interleaved
//  in one wall of text. ROS severities map straight onto ours: DEBUG INFO
//  WARN ERROR FATAL, with FATAL becoming CRITICAL.
//
//  Zero dependency: it drives the `ros2` (or `rostopic`) CLI that any ROS
//  machine already has, and parses ~/.ros/log files directly. Nothing is
//  installed into the workspace, no rclpy node joins the graph, and nothing
//  here publishes to ROS - a logger that adds a node to a robot's graph is
//  changing the system it is supposed to be observing.
//
//  Node >= 18.
//

import { spawn } from 'node:child_process';
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { hostname, homedir } from 'node:os';
import { join } from 'node:path';
import { loadEnv } from './env.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};

if (args.includes('--help') || args.includes('-h')) {
  console.error(`superlog-ros - ROS 1 / ROS 2 node logs as events

  superlog-ros [--node NAME] [--files [DIR]] [--ssh DEST] [--topic-name /rosout]
               [--url HUB] [--identity KEY] [--ssh-port N]

  superlog-ros                    # echo /rosout, auto-detecting ros2 vs ros1
  superlog-ros --node /planner    # only that node
  superlog-ros --files            # ~/.ros/log, past runs included

Publishes to ros.<host>.<node>. FATAL becomes CRITICAL; DEBUG/INFO/WARN/ERROR
map straight across. Nothing is published back into the ROS graph.`);
  process.exit(0);
}

const env = loadEnv();
const hubUrl = opt('url', env.SUPER_LOG_URL ?? 'http://127.0.0.1:7333');
const dest = opt('ssh');
const rosoutName = opt('topic-name', '/rosout');
const nodeFilter = opt('node', '');
const fileMode = args.includes('--files');
const fileDir = opt('files', '') || join(homedir(), '.ros', 'log');

const sanitize = (s) => String(s).toLowerCase().replace(/^\//, '')
  .replace(/[^a-z0-9._-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'node';
const host = dest ? sanitize(dest.includes('@') ? dest.split('@')[1] : dest)
                  : sanitize(hostname().split('.')[0]);

// ROS severity is a byte on the wire and a word in the console format. Both
// mean the same five things.
const LEVEL_BY_NUM = { 10: 'DEBUG', 20: 'INFO', 30: 'WARN', 40: 'ERROR', 50: 'CRITICAL' };
const LEVEL_BY_NAME = { DEBUG: 'DEBUG', INFO: 'INFO', WARN: 'WARN', WARNING: 'WARN',
                        ERROR: 'ERROR', FATAL: 'CRITICAL' };

// ------------------------------------------------------------- publishing

const session = Math.random().toString(16).slice(2, 10);
const buf = new Map();
let seq = 0;

function publish(node, level, msg, fields) {
  const topic = opt('topic', `ros.${host}.${sanitize(node || 'rosout')}`);
  if (!buf.has(topic)) buf.set(topic, []);
  buf.get(topic).push(JSON.stringify({
    v: 1, ts: new Date().toISOString(), seq: seq++, session, level,
    origin: { runtime: 'ros', app: sanitize(node || 'rosout'), platform: 'robot', device: host },
    tag: node || undefined, msg,
    ...(fields?.src ? { src: fields.src } : {}),
    ...(fields && Object.keys(fields).some((k) => k !== 'src')
      ? { fields: Object.fromEntries(Object.entries(fields).filter(([k]) => k !== 'src')) }
      : {}),
  }));
}

async function flush() {
  for (const [topic, lines] of buf) {
    if (!lines.length) continue;
    const body = lines.join('\n');
    buf.set(topic, []);
    try {
      await fetch(`${hubUrl}/ingest/${topic}`, {
        method: 'POST', headers: { 'content-type': 'application/x-ndjson' }, body,
      });
    } catch {
      /* hub down; the next batch counts again */
    }
  }
}
setInterval(() => void flush(), 250).unref?.();

// ------------------------------------------------------------------ /rosout
//
// `ros2 topic echo` emits YAML documents separated by `---`. Parsing YAML in
// general would need a dependency; parsing THIS message does not, because
// rcl_interfaces/msg/Log is flat and its field names are fixed. Anything
// unrecognised inside a document is ignored rather than guessed at.

// ros2 echo quotes any scalar that needs it, and a YAML single-quoted string
// escapes an inner quote by DOUBLING it: a message reading
//   costmap update failed: sensor 'lidar_front' timed out
// arrives as
//   msg: 'costmap update failed: sensor ''lidar_front'' timed out'
// Stripping the outer pair alone leaves the doubling in the message, which
// is a corruption of the robot's own words - and quoting is exactly what
// happens to the interesting messages, since those are the ones with
// punctuation in them.
function unquoteYaml(raw) {
  const t = raw.trim();
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'"))
    return t.slice(1, -1).replace(/''/g, "'");
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"'))
    return t.slice(1, -1)
      .replace(/\\n/g, '\n').replace(/\\t/g, '\t')
      .replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  return t;
}

function makeRosoutParser() {
  let cur = null;
  const finish = () => {
    if (!cur) return;
    const level = LEVEL_BY_NUM[cur.level] ?? 'INFO';
    if (!nodeFilter || cur.name === nodeFilter.replace(/^\//, '') || cur.name === nodeFilter) {
      publish(cur.name, level, cur.msg ?? '', {
        // file:line comes from the ROS macro, so it points at the source that
        // logged rather than at anything in this process.
        ...(cur.file ? { src: `${cur.file}${cur.line ? `:${cur.line}` : ''}` } : {}),
        ...(cur.function ? { function: cur.function } : {}),
        ...(cur.stamp ? { stamp: cur.stamp } : {}),
        node: cur.name ?? '',
      });
    }
    cur = null;
  };
  return (line) => {
    if (/^---\s*$/.test(line)) { finish(); return; }
    const m = /^\s*([a-z_]+):\s*(.*)$/.exec(line);
    if (!m) return;
    cur ??= {};
    const [, k, raw] = m;
    const v = unquoteYaml(raw);
    switch (k) {
      case 'level': cur.level = Number(v); break;
      case 'name': cur.name = v; break;
      case 'msg': cur.msg = v; break;
      case 'file': cur.file = v; break;
      case 'function': cur.function = v; break;
      case 'line': cur.line = v; break;
      case 'sec': cur.stamp = v; break;
      default: break;
    }
  };
}

// The ROS console format, which is what the log FILES contain and what a
// node prints to its own stderr:
//   [INFO] [1755831845.123456789] [talker]: Publishing: 'Hello World: 1'
const CONSOLE = /^\[(DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\]\s*\[([\d.]+)\]\s*\[([^\]]+)\]:\s*(.*)$/;
// ROS 1 adds the file/line on the same line in some configurations.
const CONSOLE_ROS1 = /^\[\s*(DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\]\s*\[([\d.]+)\]:\s*(.*)$/;

function parseConsole(line, fallbackNode) {
  let m = CONSOLE.exec(line);
  if (m) return { level: LEVEL_BY_NAME[m[1]], stamp: m[2], node: m[3], msg: m[4] };
  m = CONSOLE_ROS1.exec(line);
  if (m) return { level: LEVEL_BY_NAME[m[1]], stamp: m[2], node: fallbackNode, msg: m[3] };
  return null;
}

// ------------------------------------------------------------------ running

const SSH_BASE = [
  '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-T',
  ...(opt('identity') ? ['-i', opt('identity')] : []),
  ...(opt('ssh-port') ? ['-p', String(opt('ssh-port'))] : []),
];
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function run(cmd, onLine, onExit) {
  const child = dest
    ? spawn('ssh', [...SSH_BASE, dest, cmd], { stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn('sh', ['-c', cmd], { stdio: ['ignore', 'pipe', 'pipe'] });
  let carry = '';
  const feed = (d) => {
    const lines = (carry + d.toString()).split('\n');
    carry = lines.pop() ?? '';
    for (const l of lines) onLine(l);
  };
  child.stdout.on('data', feed);
  // ROS nodes write their console output to stderr; echo writes to stdout.
  child.stderr.on('data', feed);
  child.on('error', (e) => onExit(-1, e.message));
  child.on('close', (code) => { if (carry.trim()) onLine(carry); onExit(code ?? 0, ''); });
  return child;
}

// ROS lives behind a setup script, so a login shell that has not sourced it
// has no ros2 on PATH at all. Sourcing whichever distro is installed is the
// difference between working and "command not found" on every robot.
const ROS_ENV =
  'if ! command -v ros2 >/dev/null 2>&1 && ! command -v rostopic >/dev/null 2>&1; then ' +
  'for s in /opt/ros/*/setup.sh; do [ -f "$s" ] && . "$s" && break; done; fi;';

function echoRosout() {
  const parse = makeRosoutParser();
  const cmd =
    `${ROS_ENV} if command -v ros2 >/dev/null 2>&1; then ` +
    `exec ros2 topic echo ${shq(rosoutName)}; ` +
    `elif command -v rostopic >/dev/null 2>&1; then ` +
    `exec rostopic echo ${shq(rosoutName)}; ` +
    `else echo "__NO_ROS__"; fi`;
  console.error(`superlog-ros: echoing ${rosoutName}${dest ? ` on ${dest}` : ''} -> ros.${host}.<node>`);
  run(cmd, (line) => {
    if (line.includes('__NO_ROS__')) {
      publish('rosout', 'ERROR',
              `no ros2 or rostopic found${dest ? ` on ${dest}` : ''} - is a ROS distro installed and /opt/ros/*/setup.sh present?`,
              { change: 'no-ros' });
      return;
    }
    parse(line);
  }, (code, err) => {
    // A robot rebooting, or roscore restarting, is normal. Say it and retry.
    publish('rosout', code === 0 ? 'INFO' : 'WARN',
            `${rosoutName} echo ended${err ? `: ${err}` : ` (exit ${code})`} - retrying in 3s`,
            { change: 'reconnect' });
    setTimeout(echoRosout, 3000);
  });
}

// -------------------------------------------------------------------- files
//
// ~/.ros/log holds the current run and every past one, which is the only
// place a crash from yesterday still exists.

function tailFiles() {
  if (dest) {
    const cmd = `${ROS_ENV} tail -n +1 -F ${shq(fileDir)}/latest/*.log 2>/dev/null`;
    console.error(`superlog-ros: tailing ${fileDir}/latest on ${dest}`);
    run(cmd, (line) => {
      const p = parseConsole(line, 'rosout');
      if (p) publish(p.node, p.level, p.msg, { stamp: p.stamp, node: p.node });
    }, (code) => {
      publish('rosout', 'WARN', `file tail ended (exit ${code}) - retrying in 3s`, { change: 'reconnect' });
      setTimeout(tailFiles, 3000);
    });
    return;
  }

  if (!existsSync(fileDir)) {
    console.error(`superlog-ros: ${fileDir} does not exist - has a ROS node run on this machine?`);
    publish('rosout', 'WARN', `${fileDir} does not exist`, { change: 'no-logs' });
    void flush();
    return;
  }

  // Newest run first: `latest` is a symlink ROS maintains, but past runs are
  // the point of this mode, so walk the directory rather than trusting it.
  const runs = readdirSync(fileDir)
    .map((d) => join(fileDir, d))
    .filter((d) => { try { return statSync(d).isDirectory(); } catch { return false; } })
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    .slice(0, Number(opt('runs', '3')));

  let files = 0;
  for (const runDir of runs) {
    for (const f of readdirSync(runDir).filter((f) => f.endsWith('.log'))) {
      files += 1;
      const nodeName = f.replace(/_\d+_\d+\.log$/, '').replace(/\.log$/, '');
      let carry = '';
      createReadStream(join(runDir, f), { encoding: 'utf8' })
        .on('data', (d) => {
          const lines = (carry + d).split('\n');
          carry = lines.pop() ?? '';
          for (const line of lines) {
            const p = parseConsole(line, nodeName);
            if (p) publish(p.node, p.level, p.msg, { stamp: p.stamp, node: p.node, run: runDir });
            else if (line.trim()) publish(nodeName, 'INFO', line, { run: runDir });
          }
        })
        .on('end', () => void flush());
    }
  }
  console.error(`superlog-ros: read ${files} log file(s) from ${runs.length} run(s) in ${fileDir}`);
  setTimeout(() => void flush(), 500);
}

process.on('SIGINT', async () => { await flush(); process.exit(130); });
process.on('SIGTERM', async () => { await flush(); process.exit(143); });

if (fileMode) tailFiles();
else echoRosout();
