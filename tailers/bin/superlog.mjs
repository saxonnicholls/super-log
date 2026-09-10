#!/usr/bin/env node
//
//  superlog - the bench CLI.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  Shaped after the CLIs that got this right - docker, systemctl, brew services,
//  pm2: a verb, then a thing. A tailer you `start` runs in the background with
//  its pid and log tracked under ~/.superlog, so `stop`, `restart`, `status` and
//  `logs` have something real to act on. The tailer list is read from disk, so
//  this tool can never claim a tailer that is not installed, or miss a new one.
//
//    superlog start <tailer> [opts]   start a tailer in the background
//    superlog stop <tailer>           stop it
//    superlog restart <tailer>        stop, then start with the same options
//    superlog status [tailer]         what is running, and the hub's health
//    superlog logs <tailer>           follow a running tailer's log
//    superlog list                    every tailer, with a one-line description
//    <command> | superlog tee [opts]  tee(1): pass a stream through, onto the hub
//    superlog login                   open super-log Cloud in your browser
//    superlog help | --help | -h      this
//    superlog --version               the version
//
//  Every tailer still runs directly as `npm run <name>`; this is the friendlier
//  front door to the same files. Node >= 18.
//

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runLogin } from './superlog-login.mjs';

const BIN = dirname(fileURLToPath(import.meta.url));            // tailers/bin
const HOME = join(homedir(), '.superlog');
const RUN = join(HOME, 'run');                                  // <name>.json state
const LOGDIR = join(HOME, 'log');                               // <name>.log output
const HUB = process.env.SUPER_LOG_URL || 'http://127.0.0.1:7333';

const argv = process.argv.slice(2);
const [cmd, ...rest] = argv;

// `tee` and `login` are verbs, not `start` targets; a few files here are
// libraries or helpers rather than tailers you would start by name.
const NOT_A_TAILER = new Set(['tee', 'login', 'journal-read', 'env']);

const tailerNames = () => readdirSync(BIN)
  .map((f) => f.match(/^superlog-([a-z0-9-]+)\.mjs$/)?.[1])
  .filter((n) => n && !NOT_A_TAILER.has(n))
  .sort();

// The one-line purpose from a tailer's own header: `//  superlog-<name> - <...>`.
function describe(name) {
  try {
    const head = readFileSync(join(BIN, `superlog-${name}.mjs`), 'utf8').slice(0, 600);
    const m = head.match(new RegExp(`superlog-${name}\\s*[-–]\\s*([^\\n]+)`));
    return m ? m[1].replace(/[.\s]+$/, '').trim() : '';
  } catch { return ''; }
}

const version = () => {
  try { return JSON.parse(readFileSync(join(BIN, '..', '..', 'package.json'), 'utf8')).version; }
  catch { return '?'; }
};

// ---- managed state: one small JSON per started tailer --------------------
const statePath = (name) => join(RUN, `${name}.json`);
const logPath = (name) => join(LOGDIR, `${name}.log`);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
function readState(name) {
  try { return JSON.parse(readFileSync(statePath(name), 'utf8')); } catch { return null; }
}
function running() {
  if (!existsSync(RUN)) return [];
  return readdirSync(RUN)
    .map((f) => f.endsWith('.json') && readState(f.slice(0, -5)))
    .filter((s) => s && alive(s.pid));
}
const ago = (ms) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`;
};

function die(msg, code = 2) { console.error(`superlog: ${msg}`); process.exit(code); }
function requireTailer(name) {
  if (!name) die("that command needs a tailer name - run 'superlog list' to see them");
  if (!tailerNames().includes(name)) die(`no tailer '${name}' - run 'superlog list' to see them all`);
}

function start(name, args) {
  requireTailer(name);
  const existing = readState(name);
  if (existing && alive(existing.pid))
    die(`${name} is already running (pid ${existing.pid}) - 'superlog restart ${name}' to reload`, 1);
  mkdirSync(RUN, { recursive: true });
  mkdirSync(LOGDIR, { recursive: true });
  const fd = openSync(logPath(name), 'a');
  const child = spawn(process.execPath, [join(BIN, `superlog-${name}.mjs`), ...args],
    { detached: true, stdio: ['ignore', fd, fd] });
  child.unref();
  writeFileSync(statePath(name), JSON.stringify({ pid: child.pid, args, started: Date.now(), log: logPath(name) }));
  console.log(`started ${name} (pid ${child.pid})  logs: superlog logs ${name}`);
}

async function stop(name) {
  requireTailer(name);
  const st = readState(name);
  if (!st || !alive(st.pid)) { rmSync(statePath(name), { force: true }); return console.log(`${name} is not running`); }
  try { process.kill(st.pid, 'SIGTERM'); } catch { /* already gone */ }
  for (let i = 0; i < 40 && alive(st.pid); i++) await new Promise((r) => setTimeout(r, 50));
  if (alive(st.pid)) { try { process.kill(st.pid, 'SIGKILL'); } catch { /* gone */ } }
  rmSync(statePath(name), { force: true });
  console.log(`stopped ${name}`);
}

async function restart(name) {
  requireTailer(name);
  const st = readState(name);
  await stop(name);
  start(name, st?.args ?? rest.slice(1));
}

// Every superlog-<name> process on the machine, however it was started - by
// `superlog start`, launchd, a fleet runner, `npm run`, or by hand - so status
// shows the whole bench and not just what this CLI launched.
function scanRunningTailers() {
  try {
    const out = spawnSync('ps', ['-axww', '-o', 'pid=,etime=,args='],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).stdout || '';
    const rows = [];
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\S+)\s+.*\bsuperlog-([a-z0-9-]+)\.mjs\b(.*)$/);
      if (m) rows.push({ name: m[3], pid: Number(m[1]), etime: m[2], args: m[4].trim() });
    }
    return rows;
  } catch { return []; }
}

async function status(name) {
  // The hub first: a bench with no hub is the "is it down, or just quiet" question.
  let hub = 'down';
  try {
    const h = await fetch(`${HUB}/healthz`, { signal: AbortSignal.timeout(1500) }).then((r) => r.json());
    hub = `up  (published ${Number(h.published ?? 0).toLocaleString()}, ${h.topics ?? 0} topics)`;
  } catch { /* down */ }
  console.log(`hub ${HUB}: ${hub}\n`);

  const managed = new Set(running()
    .map((s) => s.log.match(/([a-z0-9-]+)\.log$/)?.[1]).filter(Boolean));
  let procs = scanRunningTailers();
  if (name) procs = procs.filter((p) => p.name === name);
  if (!procs.length) {
    console.log(name ? `${name} is not running`
      : "no superlog tailers are running ('superlog list', then 'superlog start <tailer>')");
    return;
  }
  procs.sort((a, b) => a.name.localeCompare(b.name) || a.pid - b.pid);
  const width = procs.reduce((w, p) => Math.max(w, p.name.length), 0);
  for (const p of procs)
    console.log(`  up   ${p.name.padEnd(width)}  pid ${String(p.pid).padEnd(7)} ${p.etime.padStart(9)}  ` +
                `${managed.has(p.name) ? 'superlog' : 'external'}` +
                (p.args ? `  ${redactArgs(p.args).slice(0, 48)}` : ''));
}

// status prints a process's args; never echo a secret from a command line.
function redactArgs(a) {
  return a.replace(/^--url \S+ ?/, '')
    .replace(/(--(?:token|secret|auth|key|password|pass)[= ]?)\S+/gi, '$1<redacted>');
}

function logs(name) {
  requireTailer(name);
  if (!existsSync(logPath(name))) die(`no logs for ${name} yet - has it been started?`, 1);
  const child = spawn('tail', ['-n', '60', '-f', logPath(name)], { stdio: 'inherit' });
  child.on('exit', (code, sig) => process.exit(sig ? 1 : (code ?? 0)));
}

// super-log Cloud is a SEPARATE, optional, proprietary package. This MIT tool
// ships no cloud code and depends on none - it only ever looks for the cloud
// client on PATH and hands off to it if the user chose to install it. The
// single place MIT names that binary is here, deliberately, with this comment as
// the guard against a future edit "simplifying" it into a hard dependency.
const cloudInstalled = () =>
  spawnSync(process.platform === 'win32' ? 'where' : 'which', ['superlog-cloud'],
    { stdio: 'ignore' }).status === 0;

function passthru(bin, args) {
  const child = spawn(bin, args, { stdio: 'inherit' });
  child.on('exit', (code, sig) => process.exit(sig ? 1 : (code ?? 0)));
  child.on('error', () => die(`'${bin}' is not installed`, 1));
}

function billing() {
  // Billing belongs to the paid tier. If the cloud client is installed, hand
  // off; otherwise tell the plain, cheerful truth about the free tool.
  if (cloudInstalled()) return passthru('superlog-cloud', ['billing', ...rest]);
  console.log(
`free forever.

super-log (this tool) is MIT-licensed and free - no account, and nothing to
bill, ever. super-log Cloud is the optional paid tier - hosted retention,
backups and fleet views - and its billing lives there:

  superlog login    to start`);
}

function list() {
  const names = tailerNames();
  console.log(`superlog: ${names.length} tailers - start any with 'superlog start <name>'\n`);
  const width = names.reduce((w, n) => Math.max(w, n.length), 0);
  for (const n of names) console.log(`  ${n.padEnd(width)}  ${describe(n)}`);
  console.log(`\nAlso: superlog tee (pipe a stream), superlog login (super-log Cloud).`);
}

function help() {
  const queries = Object.entries(QUERIES)
    .map(([k, q]) => `  ${k.padEnd(24)}${q.desc}`).join('\n');
  console.log(
`superlog - one wire for every log stream on your bench (v${version()})

USAGE
  superlog <command> [args]

READ THE BENCH  (readable on a terminal; NDJSON when piped, so \`| jq\` just works)
  status [tailer]           what is running, and the hub's health
${queries}

TAILERS (managed in the background; logs under ~/.superlog/log)
  start <tailer> [opts]     start a tailer        e.g. superlog start vitals
  stop <tailer>             stop it
  restart <tailer>          stop, then start with the same options
  logs <tailer>             follow a running tailer's log
  list                      every tailer, with a one-line description (${tailerNames().length} of them)

STREAMS & CLOUD
  tee [opts] [FILE...]      tee(1) onto the hub    e.g. make 2>&1 | superlog tee --topic build
  login                     open super-log Cloud in your browser
  billing                   your plan (free forever unless you're on Cloud)

  help, --help, -h          this
  --version                 print the version

The hub (superlogd) collects and a viewer shows it; these tailers feed it. Each
also runs directly as 'npm run <name>' in the super-log repo. Try:

  superlog start vitals     disk / memory / CPU
  superlog status           what's running
  superlog list             every tailer there is`);
}

// ---- reading the bench: a panel's worth of state, as data -----------------
// These answer "what does the bench look like right now" the way the viewer
// panels do - latest state per key - but as text you can pipe. On a terminal
// they print a readable line each; piped (or with --json) they emit NDJSON, one
// event per line, so `superlog alarms | jq .` just works.
const ev = (r) => r.event || {};
const QUERIES = {
  alarms:      { desc: 'firing and recovered alarms',       match: (t) => t.startsWith('alert.'), key: (r) => ev(r).fields?.key ?? r.topic },
  servers:     { desc: 'every machine that has spoken',     match: () => true, skip: (r) => r.topic.startsWith('agent.') || !ev(r).origin?.device, key: (r) => ev(r).origin.device },
  versions:    { desc: 'version inventory, per host',       match: (t) => t.startsWith('host.') && t.endsWith('.versions'), key: (r) => r.topic },
  prs:         { desc: 'pull requests being watched',       match: (t) => t.startsWith('pr.'), key: (r) => `${ev(r).fields?.repo}#${ev(r).fields?.number}`, skip: (r) => !ev(r).fields?.repo },
  rpc:         { desc: 'RPC node health, per provider',     match: (t) => t.startsWith('rpc.'), key: (r) => `${ev(r).fields?.chain}/${ev(r).fields?.provider}` },
  topology:    { desc: 'the network as a tree, per host',   match: (t) => t.startsWith('net.') && t.includes('.topology'), key: (r) => r.topic },
  connections: { desc: 'outbound connections, per host',    match: (t) => t.startsWith('net.') && t.endsWith('.connections'), key: (r) => r.topic },
  ports:       { desc: 'listening sockets, per host',       match: (t) => t.startsWith('net.') && t.endsWith('.listeners'), key: (r) => r.topic },
  webhooks:    { desc: 'webhook deliveries',                match: (t) => t.startsWith('wh.'), key: (r) => r.seq },
  agents:      { desc: 'agents on the bench',               match: (t) => t.startsWith('agent.'), key: (r) => r.topic },
  devices:     { desc: 'USB device trees, per host',        match: (t) => t.startsWith('usb.'), key: (r) => r.topic },
  gpu:         { desc: 'GPU metrics, per card',             match: (t) => t.startsWith('gpu.'), key: (r) => r.topic },
};

async function query(name) {
  const q = QUERIES[name];
  let events;
  try {
    events = await fetch(`${HUB}/recent?limit=5000`, { signal: AbortSignal.timeout(4000) })
      .then((r) => r.json()).then((e) => e.events || []);
  } catch { return die(`cannot reach the hub at ${HUB} - is superlogd running?`, 1); }
  // /recent is oldest -> newest, so the last write per key is the latest state.
  const latest = new Map();
  for (const r of events) {
    if (!q.match(r.topic) || (q.skip && q.skip(r))) continue;
    const k = q.key(r);
    if (k != null && k !== 'undefined#undefined') latest.set(k, r);
  }
  const rows = [...latest.values()];
  const asJson = !process.stdout.isTTY || argv.includes('--json');
  if (asJson) { for (const r of rows) process.stdout.write(JSON.stringify({ hub_seq: r.seq, topic: r.topic, ...ev(r) }) + '\n'); return; }
  if (!rows.length) return void console.log(`no ${name} on the bench right now - is a producer running? ('superlog list')`);
  for (const r of rows) {
    const e = ev(r);
    console.log(`${String(e.level ?? '').padEnd(5)} ${r.topic}  ${String(e.msg ?? '').slice(0, 90)}`);
  }
}

async function main() {
  switch (cmd) {
    case 'start': return start(rest[0], rest.slice(1));
    case 'stop': return stop(rest[0]);
    case 'restart': return restart(rest[0]);
    case 'status': return status(rest[0]);
    case 'logs': return logs(rest[0]);
    case 'list': return list();
    case 'tee': return void spawnInherit('superlog-tee.mjs', rest);
    case 'login': return runLogin(rest);
    case 'billing': return billing();
    case 'help': case '--help': case '-h': case undefined: return help();
    case '--version': case 'version': return void console.log(version());
    default:
      // A bare panel name reads the bench (superlog alarms, versions, servers...).
      if (QUERIES[cmd]) return query(cmd);
      if (tailerNames().includes(cmd))
        die(`'${cmd}' is a tailer - run it with 'superlog start ${cmd}'`, 2);
      die(`unknown command '${cmd}' - run 'superlog --help'`);
  }
}

function spawnInherit(file, args) {
  const child = spawn(process.execPath, [join(BIN, file), ...args], { stdio: 'inherit' });
  child.on('exit', (code, sig) => process.exit(sig ? 1 : (code ?? 0)));
  child.on('error', (e) => die(e.message, 1));
}

main();
