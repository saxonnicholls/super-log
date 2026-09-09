#!/usr/bin/env node
//
//  superlog-versions - the stack's versions, logged, and their changes.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  A version list looks static, which is why nobody watches it and why a silent
//  bump costs a day: gcc 13.1->13.2 starts miscompiling, postgres 15->16 changes
//  a plan, a version manager swaps node under your feet. The version that hides
//  best is the one on the hardware - a five-person team once lost three days to
//  an FPGA toolchain/bitstream mismatch nothing on the bench reported. So this
//  is a snapshot-and-diff tailer: a silent baseline, then a CHANGE is the event.
//
//    superlog-versions                       # this machine's versions, watched
//    superlog-versions --once                # the inventory now, then exit
//    superlog-versions --check-conflicts      # + check against a known-conflicts list
//
//  Publishes host.<name>.versions: the inventory on fields.versions (a DEBUG
//  reading), and each change as an edge (a new tool, a version change with
//  before+after, a tool that vanished). node and python lead because their
//  version managers (nvm/pyenv/asdf, virtualenvs) make the ACTIVE version
//  per-shell and invisible - the drift a poll catches and a package-manager
//  hook misses.
//
//  It ships NO knowledge of what is good or bad - it logs facts. Advice (EOL,
//  CVEs, known-bad combos) is a separate, maintained thing; --check-conflicts
//  is the one opt-in exception, and it DOWNLOADS a list and checks LOCALLY, so
//  your versions never leave the machine (a version list is a CVE roadmap).
//
//  Zero dependency: shells out to each tool's --version. Node >= 18.
//

import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { hostname, platform, cpus, totalmem } from 'node:os';
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
  console.error(`superlog-versions - the stack's versions, logged, and their changes

  superlog-versions [--once] [--interval 300] [--name LABEL] [--url HUB]
                    [--ssh DEST] [--identity KEY] [--ssh-port N]
                    [--check-conflicts] [--conflicts-url URL|FILE]

--ssh inventories a remote box over ssh (it needs no node there - the probes
are shell commands), so you can diff dev against prod, or watch an older box
that has no node of its own.

Publishes host.<name>.versions: the inventory on fields.versions (DEBUG), and
each CHANGE as an edge (new tool, version change with before+after, tool gone).
Silent baseline; only changes speak. Facts only - no EOL/CVE knowledge.
--check-conflicts downloads a known-conflicts list and checks LOCALLY (your
versions never leave the machine); it stamps every hit "as of <list date>".`);
  process.exit(0);
}

const env = loadEnv();
const hubUrl = opt('url', env.SUPER_LOG_URL ?? 'http://127.0.0.1:7333');
const mac = platform() === 'darwin';
const win = platform() === 'win32';
const once = args.includes('--once');
const intervalS = Number(opt('interval', 300)) || 300;   // versions change slowly
const wantConflicts = args.includes('--check-conflicts');
const conflictsUrl = opt('conflicts-url', env.SUPER_LOG_CONFLICTS_URL ?? 'https://super-log.com/conflicts.json');

const dest = opt('ssh');                        // inventory a remote box (needs no node there)
const sanitize = (s) => String(s).toLowerCase().replace(/[^a-z0-9._-]/g, '-')
  .replace(/^-+|-+$/g, '').slice(0, 40) || 'host';
// Resolved to the box's real hostname at startup over ssh (see below), so a box
// is one identity regardless of the alias used to reach it.
let host = opt('name') ? sanitize(opt('name'))
         : dest ? sanitize(dest.includes('@') ? dest.split('@')[1] : dest)
                : sanitize(hostname().split('.')[0]);
let topic = `host.${host}.versions`;
const localPlatform = win ? 'windows' : mac ? 'macos' : 'linux';

// Over --ssh a box is inventoried by SHELL commands (command -v, --version),
// so it needs no node - which is the point for an older box that has none.
// ControlMaster multiplexes the many small probes onto one connection so
// a poll is a handful of round trips, not twenty handshakes.
const SSH_BASE = dest ? [
  '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-T',
  '-o', 'ControlMaster=auto', '-o', 'ControlPath=/tmp/sl-ver-%r@%h:%p', '-o', 'ControlPersist=30',
  ...(opt('identity') ? ['-i', opt('identity')] : []),
  ...(opt('ssh-port') ? ['-p', String(opt('ssh-port'))] : []),
] : [];
async function sshExec(remoteCmd) {
  try { return (await run('ssh', [...SSH_BASE, dest, remoteCmd], { timeout: 15000 })).stdout; }
  catch (e) { return e?.stdout || ''; }
}
const remotely = !!dest;
async function resolveRemoteHost() {
  if (!dest || opt('name')) return;
  const out = await sshExec('hostname -s 2>/dev/null || hostname 2>/dev/null');
  const h = sanitize(out.split('\n')[0].trim());
  if (h) { host = h; topic = `host.${host}.versions`; }
}

// ------------------------------------------------------------- publishing

const session = randomBytes(4).toString('hex');
let seq = 0;
let lines = [];
function publish(level, msg, fields) {
  lines.push(JSON.stringify({
    v: 1, ts: new Date().toISOString(), seq: seq++, session, level,
    origin: { runtime: 'node', app: 'versions', platform: localPlatform, device: host },
    tag: 'versions', msg,
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

// ---------------------------------------------------------------- probing
//
// A probe names a tool and how to read its version. node and python first;
// the rest of the common toolchain, OS and a couple of databases follow. A
// version string is gloriously inconsistent, so we keep `raw` verbatim and
// extract the first orderable token - flagging when we cannot rather than
// guessing.

const PROBES = [
  { tool: 'node', category: 'runtime', cmd: 'node', args: ['--version'] },
  { tool: 'python', category: 'runtime', cmd: 'python3', args: ['--version'], scheme: 'pep440' },
  { tool: 'gcc', category: 'toolchain', cmd: 'gcc', args: ['--version'] },
  { tool: 'clang', category: 'toolchain', cmd: 'clang', args: ['--version'] },
  { tool: 'rustc', category: 'toolchain', cmd: 'rustc', args: ['--version'] },
  { tool: 'go', category: 'toolchain', cmd: 'go', args: ['version'] },
  { tool: 'java', category: 'toolchain', cmd: 'java', args: ['-version'] },   // prints to stderr
  { tool: 'cmake', category: 'toolchain', cmd: 'cmake', args: ['--version'] },
  { tool: 'git', category: 'toolchain', cmd: 'git', args: ['--version'] },
  { tool: 'docker', category: 'toolchain', cmd: 'docker', args: ['--version'] },
  { tool: 'psql', category: 'database', cmd: 'psql', args: ['--version'] },
  { tool: 'sqlite3', category: 'database', cmd: 'sqlite3', args: ['--version'] },
  { tool: 'redis-server', category: 'database', cmd: 'redis-server', args: ['--version'] },
  { tool: 'openssl', category: 'library', cmd: 'openssl', args: ['version'] },
  { tool: 'ruby', category: 'runtime', cmd: 'ruby', args: ['--version'] },
  { tool: 'perl', category: 'runtime', cmd: 'perl', args: ['--version'] },
  { tool: 'make', category: 'toolchain', cmd: 'make', args: ['--version'] },
  { tool: 'nvcc', category: 'toolchain', cmd: 'nvcc', args: ['--version'] },        // CUDA compiler
  { tool: 'clinfo', category: 'toolchain', cmd: 'clinfo', args: ['--version'] },    // OpenCL
  { tool: 'vulkaninfo', category: 'toolchain', cmd: 'vulkaninfo', args: ['--summary'] },
];

// The first X.Y[.Z][-tag] in the text: almost always the version in --version
// output. Returns '' when there is nothing orderable to find.
const parseVersion = (text) => /(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.]+)?)/.exec(text || '')?.[1] ?? '';

function scopeOf(binPath) {
  const p = binPath || '';
  if (/\/\.?(nvm|pyenv|asdf|rbenv|rustup|virtualenvs?)\//.test(p)) return 'user';
  if (/node_modules|\/\.venv\/|\/venv\//.test(p)) return 'project';
  if (/^\/(usr|opt|bin|sbin)\b/.test(p) || /Program Files/i.test(p) || /\/Library\//.test(p)) return 'system';
  if (/\/home\/|\/Users\//.test(p)) return 'user';
  return 'system';
}

async function whichPath(cmd) {
  try {
    const { stdout } = await run(win ? 'where' : 'which', [cmd], { timeout: 4000 });
    return stdout.split('\n')[0].trim();
  } catch { return ''; }
}

async function probeOne(p) {
  let binPath = '', out = '', mtime;
  if (remotely) {
    binPath = (await sshExec(`command -v ${p.cmd} 2>/dev/null`)).split('\n')[0].trim();
    if (!binPath) return { category: p.category, tool: p.tool, state: 'absent' };
    out = await sshExec(`${p.cmd} ${p.args.join(' ')} 2>&1 | head -5`);
  } else {
    binPath = await whichPath(p.cmd);
    if (!binPath) return { category: p.category, tool: p.tool, state: 'absent' };
    try {
      const r = await run(p.cmd, p.args, { timeout: 8000 });
      out = r.stdout || r.stderr;               // java and some tools print to stderr
    } catch (e) {
      out = e?.stdout || e?.stderr || '';       // some tools exit non-zero but still print
    }
    try { mtime = statSync(binPath).mtime.toISOString(); } catch { /* gone between which and stat */ }
  }
  const raw = (out.split('\n').find((l) => l.trim()) ?? '').trim();
  const version = parseVersion(out);
  const fact = { category: p.category, tool: p.tool, state: 'present', raw,
                 provenance: '--version', scope: scopeOf(binPath), path: binPath, mtime };
  if (version) {
    fact.version = version;
    fact.scheme = p.scheme ?? 'semver';         // which comparator the advisor must use
    fact.purl = `pkg:generic/${p.tool}@${version}`;
  } else {
    fact.unorderable = true;                     // a version we cannot order, flagged not guessed
  }
  return fact;
}

async function osFact() {
  if (remotely) {
    const sw = (await sshExec('sw_vers -productVersion 2>/dev/null')).trim();
    if (sw) {
      const name = (await sshExec('sw_vers -productName 2>/dev/null')).trim() || 'macOS';
      return { category: 'os', tool: 'macos', state: 'present', raw: `${name} ${sw}`, provenance: 'sw_vers',
               scope: 'system', version: parseVersion(sw), scheme: 'calver', purl: `pkg:generic/macos@${sw}` };
    }
    const rel = (await sshExec('. /etc/os-release 2>/dev/null && echo "$ID $VERSION_ID"')).trim();
    const kernel = (await sshExec('uname -r 2>/dev/null')).trim();
    const [id, ver] = rel.split(/\s+/);
    const raw = `${rel || 'linux'} kernel ${kernel}`.trim();
    return { category: 'os', tool: id || 'linux', state: 'present', raw, provenance: 'os-release', scope: 'system',
             ...(ver && parseVersion(ver) ? { version: parseVersion(ver), scheme: 'opaque', purl: `pkg:generic/${id}@${parseVersion(ver)}` } : { unorderable: true }) };
  }
  if (mac) {
    const [name, ver, build] = await Promise.all([
      run('sw_vers', ['-productName']).then((r) => r.stdout.trim()).catch(() => 'macOS'),
      run('sw_vers', ['-productVersion']).then((r) => r.stdout.trim()).catch(() => ''),
      run('sw_vers', ['-buildVersion']).then((r) => r.stdout.trim()).catch(() => ''),
    ]);
    const raw = `${name} ${ver} (${build})`;
    return { category: 'os', tool: 'macos', state: 'present', raw, provenance: 'sw_vers',
             scope: 'system', ...(ver ? { version: parseVersion(ver), scheme: 'calver', purl: `pkg:generic/macos@${ver}` } : { unorderable: true }) };
  }
  if (win) {
    const raw = await run('cmd', ['/c', 'ver']).then((r) => r.stdout.trim()).catch(() => 'Windows');
    const version = parseVersion(raw);
    return { category: 'os', tool: 'windows', state: 'present', raw, provenance: 'ver', scope: 'system',
             ...(version ? { version, scheme: 'calver', purl: `pkg:generic/windows@${version}` } : { unorderable: true }) };
  }
  // Linux: /etc/os-release for the distro, uname for the kernel.
  const rel = await run('sh', ['-c', '. /etc/os-release 2>/dev/null && echo "$ID $VERSION_ID"'])
    .then((r) => r.stdout.trim()).catch(() => '');
  const kernel = await run('uname', ['-r']).then((r) => r.stdout.trim()).catch(() => '');
  const [id, ver] = rel.split(/\s+/);
  const raw = `${rel || 'linux'} kernel ${kernel}`.trim();
  return { category: 'os', tool: id || 'linux', state: 'present', raw, provenance: 'os-release', scope: 'system',
           ...(ver && parseVersion(ver) ? { version: parseVersion(ver), scheme: 'opaque', purl: `pkg:generic/${id}@${parseVersion(ver)}` } : { unorderable: true }) };
}

async function hardwareFact() {
  // Unprivileged tier only: the CPU model and core count. BIOS/microcode would
  // need root and are the opt-in --firmware add of superlog-firmware.
  if (remotely) {
    const model = (await sshExec("lscpu 2>/dev/null | sed -n 's/^Model name:[[:space:]]*//p' | head -1")).trim()
               || (await sshExec('sysctl -n machdep.cpu.brand_string 2>/dev/null')).trim();
    if (!model) return null;
    const cores = (await sshExec('nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null')).trim();
    return { category: 'hardware', tool: 'cpu', state: 'present',
             raw: `${model}${cores ? ` x${cores}` : ''}`, provenance: 'lscpu', scope: 'system', unorderable: true };
  }
  const c = cpus();
  const model = c[0]?.model?.trim() || 'unknown CPU';
  return { category: 'hardware', tool: 'cpu', state: 'present',
           raw: `${model} x${c.length}, ${Math.round(totalmem() / 1073741824)}GB RAM`,
           provenance: 'os', scope: 'system', unorderable: true };
}

// Every package the system package manager knows about - the full library
// surface, not just the curated tools. brew on macOS, dpkg then rpm on Linux.
// These are `pkgmgr` provenance (distinct from a tool's own --version), so an
// openssl seen both ways is two honest facts, never one that overwrites.
async function packageFacts() {
  const out = [];
  const add = (name, version, prov, type) => {
    if (!name || !version) return;
    const f = { category: 'library', tool: name, state: 'present', raw: `${name} ${version}`,
                provenance: prov, scope: 'system' };
    if (parseVersion(version)) { f.version = parseVersion(version); f.scheme = 'opaque'; f.purl = `pkg:${type}/${name}@${f.version}`; }
    else f.unorderable = true;
    out.push(f);
  };
  if (remotely) {
    let txt = await sshExec("dpkg-query -W -f='${Package} ${Version}\\n' 2>/dev/null");
    let prov = 'pkgmgr:dpkg', type = 'deb';
    if (!txt.trim()) { txt = await sshExec("rpm -qa --qf '%{NAME} %{VERSION}\\n' 2>/dev/null"); prov = 'pkgmgr:rpm'; type = 'rpm'; }
    if (!txt.trim()) { txt = await sshExec('brew list --versions 2>/dev/null'); prov = 'pkgmgr:brew'; type = 'brew'; }
    for (const line of txt.split('\n')) {
      const p = line.trim().split(/\s+/);
      if (p.length >= 2) add(p[0], type === 'brew' ? p[p.length - 1] : p[1], prov, type);
    }
    return out;
  }
  if (mac) {
    const txt = await run('brew', ['list', '--versions'], { timeout: 30000 }).then((r) => r.stdout).catch(() => '');
    for (const line of txt.split('\n')) {
      const p = line.trim().split(/\s+/);
      if (p.length >= 2) add(p[0], p[p.length - 1], 'pkgmgr:brew', 'brew');   // last = newest installed
    }
  } else if (!win) {
    let txt = await run('dpkg-query', ['-W', '-f=${Package} ${Version}\n'], { timeout: 30000 })
      .then((r) => r.stdout).catch(() => '');
    if (txt.trim()) {
      for (const line of txt.split('\n')) { const p = line.trim().split(/\s+/); if (p.length >= 2) add(p[0], p[1], 'pkgmgr:dpkg', 'deb'); }
    } else {
      txt = await run('rpm', ['-qa', '--qf', '%{NAME} %{VERSION}\n'], { timeout: 30000 }).then((r) => r.stdout).catch(() => '');
      for (const line of txt.split('\n')) { const p = line.trim().split(/\s+/); if (p.length >= 2) add(p[0], p[1], 'pkgmgr:rpm', 'rpm'); }
    }
  }
  return out;
}

async function inventory() {
  const facts = await Promise.all(PROBES.map(probeOne));
  facts.push(await osFact());
  const hw = await hardwareFact();
  if (hw) facts.push(hw);
  facts.push(...(await packageFacts()));
  return facts;
}

// -------------------------------------------------------------- diffing

let last = null;      // Map "tool/scope/path" -> fact
// Path is in the key so two of the same tool (system clang and a brew clang)
// are distinct facts, not one that flickers between them.
const keyOf = (f) => `${f.tool}/${f.scope ?? '?'}/${f.path ?? ''}`;

function diff(prevMap, facts) {
  const cur = new Map(facts.map((f) => [keyOf(f), f]));
  for (const [k, f] of cur) {
    const was = prevMap.get(k);
    const shown = (x) => x.version ?? x.raw ?? '(unknown)';
    if (f.state === 'present' && (!was || was.state === 'absent')) {
      publish('INFO', `found ${f.tool} ${shown(f)} (${f.scope})`,
              { change: 'appeared', tool: f.tool, category: f.category, scope: f.scope,
                after: shown(f), purl: f.purl });
    } else if (f.state === 'present' && was.state === 'present' &&
               (was.version ?? was.raw) !== (f.version ?? f.raw)) {
      // A major bump is louder - majors break things.
      const major = f.version && was.version && f.version.split('.')[0] !== was.version.split('.')[0];
      publish(major ? 'WARN' : 'INFO',
              `${f.tool} ${shown(was)} -> ${shown(f)}${major ? ' (major)' : ''} (${f.scope})`,
              { change: 'changed', tool: f.tool, category: f.category, scope: f.scope,
                before: shown(was), after: shown(f), purl: f.purl });
    }
  }
  for (const [k, was] of prevMap)
    if (was.state === 'present' && !cur.has(k))
      publish('WARN', `${was.tool} is GONE (was ${was.version ?? was.raw})`,
              { change: 'vanished', tool: was.tool, category: was.category, scope: was.scope,
                before: was.version ?? was.raw });
  return cur;
}

// ----------------------------------------------------- conflict checking
//
// The one opt-in exception to "facts only". It DOWNLOADS a list and checks
// LOCALLY - versions never leave the machine. Every hit is stamped "as of" the
// list's own date, because a stale check presented as current is the same
// absence-as-fact sin the tailer avoids by shipping no feed.

function cmpVer(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}
function satisfies(version, range) {
  const m = /^(==|>=|<=|>|<)?\s*(.+)$/.exec(String(range).trim());
  if (!m) return false;
  const op = m[1] || '==', c = cmpVer(version, m[2].trim());
  return op === '==' ? c === 0 : op === '>=' ? c >= 0 : op === '<=' ? c <= 0
       : op === '>' ? c > 0 : op === '<' ? c < 0 : false;
}
async function fetchConflicts() {
  try {
    // A file path is allowed too, so a bench can self-host its own list.
    if (/^https?:\/\//.test(conflictsUrl)) {
      const res = await fetch(conflictsUrl, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return null;
      return await res.json();
    }
    const { readFile } = await import('node:fs/promises');
    return JSON.parse(await readFile(conflictsUrl, 'utf8'));
  } catch { return null; }
}
const warnedConflicts = new Set();
let conflictsWarned = false;
async function checkConflicts(facts) {
  const doc = await fetchConflicts();
  if (!doc) {
    if (!conflictsWarned) {
      conflictsWarned = true;
      publish('INFO', `conflicts list unavailable (${conflictsUrl}) - checked nothing`,
              { change: 'conflicts-unavailable' });
    }
    return;
  }
  const list = Array.isArray(doc) ? doc : (doc.conflicts ?? []);
  const listDate = Array.isArray(doc) ? '' : (doc.as_of ?? '');
  const byTool = new Map(facts.filter((f) => f.state === 'present' && f.version).map((f) => [f.tool, f.version]));
  for (const c of list) {
    const hit = Array.isArray(c.tools) && c.tools.length &&
      c.tools.every((t) => { const v = byTool.get(t.tool); return v && satisfies(v, t.range); });
    if (hit && !warnedConflicts.has(c.id)) {
      warnedConflicts.add(c.id);
      publish('WARN', `known version conflict: ${c.message} (as of ${c.as_of || listDate || '?'}; absence of a listed conflict is not a guarantee)`,
              { change: 'conflict', id: c.id, as_of: c.as_of || listDate,
                tools: c.tools.map((t) => `${t.tool}${t.range}`).join(', ') });
    }
  }
}

// ------------------------------------------------------------------ main

async function tick() {
  const facts = await inventory();
  // The inventory as a reading: always current for the advisor and a viewer,
  // out of a default INFO view.
  publish('DEBUG', `${facts.filter((f) => f.state === 'present').length} versions`,
          { versions: JSON.stringify(facts), count: facts.filter((f) => f.state === 'present').length });
  if (last === null) last = new Map(facts.map((f) => [keyOf(f), f]));   // silent baseline
  else last = diff(last, facts);
  if (wantConflicts) await checkConflicts(facts);
}

const main = async () => {
  await resolveRemoteHost();                      // real hostname, not the ssh alias
  await tick();
  await flush();
  if (once) process.exit(0);
  setInterval(async () => { await tick(); await flush(); }, intervalS * 1000);
  console.error(`superlog-versions: ${topic} every ${intervalS}s` +
    (wantConflicts ? ` (+conflicts: ${conflictsUrl})` : '') + ` -> ${hubUrl}`);
};

void main();
