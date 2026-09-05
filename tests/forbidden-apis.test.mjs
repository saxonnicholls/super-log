//
//  tests/forbidden-apis.test.mjs - the machinery that must stay absent.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  The security posture makes a structural claim: log content is data,
//  never instructions, because the machinery that could evaluate it does
//  not exist in this codebase - no eval, no template engines, no HTML
//  sinks in the viewers, no process execution on the paths that touch
//  ingested bytes. A claim like that rots the day a well-meaning commit
//  adds one of them, so this file greps the shipped source for the
//  forbidden machinery and fails the suite when any of it appears.
//
//  Two design decisions worth defending:
//
//    - Tailers may spawn processes; SDKs, the MCP server and the viewers
//      may not. Driving a vendor CLI (adb, simctl, wrangler, stripe) is a
//      tailer's documented job - forbidding child_process there would
//      forbid the product. What a tailer spawns is chosen by config and
//      code, never by log content, and the hostile-corpus suite holds the
//      rest of the pipeline to that.
//    - The allowlist pins an exact COUNT per file, not a blanket pardon.
//      A new call in an allowlisted file changes the count and fails the
//      test, so every addition gets read by a human; and an entry whose
//      count drops is stale and fails too, so the list cannot quietly
//      accumulate permissions nobody uses.
//
//  Whole-line comments are skipped so prose ABOUT eval does not read as
//  eval; a violation hiding at the end of a code line still fails.
//

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { REPO } from './harness.mjs';

const JS_EXT = new Set(['.mjs', '.js', '.cjs', '.ts', '.tsx']);
const CXX_EXT = new Set(['.c', '.h', '.cc', '.cpp', '.hpp']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'third_party', '.git', 'coverage']);

function walk(dir, exts, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, exts, out);
    else if (exts.has(name.slice(name.lastIndexOf('.')))) out.push(p);
  }
  return out;
}

/** Match a pattern against a file, skipping whole-line comments, and
 *  return the offending lines so a failure names the exact spot. */
function scanFile(path, rx) {
  const hits = [];
  const lines = readFileSync(path, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#')) continue;
    if (rx.test(lines[i])) hits.push(`${relative(REPO, path)}:${i + 1}: ${trimmed.slice(0, 100)}`);
  }
  return hits;
}

/**
 * Every process-spawning call the C++ surfaces are allowed to keep, each
 * with the reason it is not a violation of the no-evaluation rule. The
 * count is exact on purpose - see the header.
 */
const CXX_EXEC_ALLOWLIST = [
  {
    file: 'viewer/imgui/src/main.cpp',
    rule: 'popen',
    count: 4,
    why: 'drives curl against the operator-configured alarm gateway and the ' +
         'local usb tailer. Every command is built from configuration and ' +
         'string literals; log content never reaches a command line.',
  },
];

// The dirs that ship. Demos and docs are examples, not the pipeline.
const JS_SHIPPED = ['sdk/js/packages', 'viewer/react/src', 'tailers'].map((d) => join(REPO, d));
const JS_NO_SPAWN = ['sdk/js/packages', 'viewer/react/src'].map((d) => join(REPO, d));
const CXX_SHIPPED = ['hub/src', 'sdk/cpp', 'sdk/c', 'viewer/imgui/src'].map((d) => join(REPO, d));

const jsFiles = (roots) => roots.flatMap((r) => walk(r, JS_EXT));
const cxxFiles = (roots) => roots.flatMap((r) => walk(r, CXX_EXT));

function assertNone(files, rx, what) {
  const hits = files.flatMap((f) => scanFile(f, rx));
  assert.deepEqual(hits, [],
    `${what} found in shipped source - the structural guarantee forbids this:\n  ${hits.join('\n  ')}`);
}

describe('forbidden APIs stay absent', () => {
  it('no dynamic code evaluation in shipped JS/TS', () => {
    const files = jsFiles(JS_SHIPPED);
    assertNone(files, /\beval\s*\(/, 'eval()');
    assertNone(files, /\bnew\s+Function\s*\(|(?<![.\w])Function\s*\(\s*['"`]/, 'Function constructor');
    assertNone(files, /require\(\s*['"](?:node:)?vm['"]\s*\)|from\s+['"](?:node:)?vm['"]/, 'the vm module');
    assertNone(files, /\bset(?:Timeout|Interval)\s*\(\s*['"`]/, 'string-argument setTimeout/setInterval');
  });

  it('no template engines anywhere near the pipeline', () => {
    // A template engine on the ingest or render path is exactly how log
    // content stops being data. None is legitimate anywhere in this repo.
    const rx = /(?:require\(\s*|from\s+)['"](?:handlebars|ejs|pug|jade|mustache|nunjucks|dot|eta|liquidjs|twig|lodash\.template|underscore\.template)['"]/;
    assertNone(jsFiles(JS_SHIPPED), rx, 'a template engine import');
  });

  it('no HTML sinks in the viewers or SDKs - text, never markup', () => {
    const rx = /dangerouslySetInnerHTML|\.innerHTML\s*=|\.outerHTML\s*=|document\.write\s*\(|insertAdjacentHTML\s*\(/;
    assertNone(jsFiles(JS_SHIPPED), rx, 'an HTML injection sink');
  });

  it('no child_process outside the tailers', () => {
    // SDKs run inside the user's app and the MCP server answers agents;
    // neither has any business spawning anything. Tailers are exempt by
    // design - see the header.
    assertNone(jsFiles(JS_NO_SPAWN), /child_process/, 'child_process');
  });

  it('no process execution or dynamic loading in C/C++ beyond the allowlist', () => {
    const rules = [
      { name: 'system', rx: /\bsystem\s*\(/ },
      { name: 'popen', rx: /\bpopen\s*\(/ },
      { name: 'dlopen', rx: /\bdlopen\s*\(/ },
      { name: 'exec', rx: /\bexec(?:l|lp|le|v|vp|vpe|ve)\s*\(/ },
    ];
    const problems = [];
    for (const file of cxxFiles(CXX_SHIPPED)) {
      const rel = relative(REPO, file);
      for (const { name, rx } of rules) {
        const hits = scanFile(file, rx);
        if (hits.length === 0) continue;
        const allowed = CXX_EXEC_ALLOWLIST.find((a) => a.file === rel && a.rule === name);
        if (!allowed)
          problems.push(...hits.map((h) => `${h}   [${name}, not allowlisted]`));
        else if (hits.length !== allowed.count)
          problems.push(`${rel}: ${hits.length} ${name}() call(s), allowlist pins ${allowed.count} - ` +
                        'a new call needs a human to read it (or a removed one needs the pin updated)');
      }
    }
    assert.deepEqual(problems, [], `process execution outside the allowlist:\n  ${problems.join('\n  ')}`);
  });

  it('allowlist entries are all still alive', () => {
    // An entry that matches nothing is a pardon waiting for code that no
    // longer exists; it must be removed, not inherited.
    for (const a of CXX_EXEC_ALLOWLIST) {
      const hits = scanFile(join(REPO, a.file), { popen: /\bpopen\s*\(/ }[a.rule] ?? /$ ^/);
      assert.ok(hits.length > 0, `stale allowlist entry: ${a.file} has no ${a.rule}() left`);
    }
  });

  it('the zero-dependency packages actually declare zero dependencies', () => {
    // "The SBOM of a super-log SDK is one file" is a security claim, and
    // this is where it would silently break: someone adds a runtime dep to
    // a package the README calls dependency-free.
    for (const pkg of ['tailers/package.json',
                       'sdk/js/packages/client/package.json',
                       'sdk/js/packages/mcp/package.json']) {
      const json = JSON.parse(readFileSync(join(REPO, pkg), 'utf8'));
      const deps = Object.keys(json.dependencies ?? {});
      assert.deepEqual(deps, [], `${pkg} grew runtime dependencies: ${deps.join(', ')}`);
    }
  });
});
