//
//  tests/engines.test.mjs - Unreal and Unity log parsing, through file mode.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  The lines here are real shapes from real logs on this bench (an Unreal
//  editor log, a Unity Editor.log). Two assertions earn this file: Unreal's
//  own verbosity words map onto the bench's levels with the category kept -
//  LogAI and LogNet at WARN are different facts; and Unity's import chatter
//  must NOT become errors just because half a project's paths contain the
//  word "Exceptions" - only the compiler's diagnostics and actual thrown
//  exceptions get a level of their own.
//

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  assertValidEvent, removeDir, start, startHub, tempDir, waitFor,
} from './harness.mjs';

let hub, work;

before(async () => {
  hub = await startHub();
  work = tempDir('superlog-engines-');
});

after(async () => {
  await hub?.stop();
  removeDir(work);
});

/** Tail a file with the given format, append the lines, return the events. */
async function tailFile(name, format, lines, topic, want) {
  const path = join(work, name);
  writeFileSync(path, '');
  // --url goes in args, not opts: superlog-tail reads its MODE from argv[0],
  // and the harness prepends opts.url ahead of everything.
  const h = start('superlog-tail.mjs',
    ['file', path, '--format', format, '--topic', topic, '--url', hub.url], {});
  // tail -F follows from the end, so give it a beat to attach first.
  await new Promise((r) => setTimeout(r, 700));
  appendFileSync(path, lines.join('\n') + '\n');
  const recs = await waitFor(hub.url, (r) => r.length >= want, { topic, timeoutMs: 15000 });
  await h.stop();
  recs.forEach((r, i) => assertValidEvent(r.event, `${topic}[${i}]`));
  return recs.map((r) => r.event);
}

describe('engine log formats', () => {
  it('unreal: verbosity words map to levels, the category rides along', async () => {
    const evs = await tailFile('unreal.log', 'unreal', [
      'LogInit: Display: Running engine for game: Arch1',
      'LogPlatformFile: Not using cached read wrapper',
      'LogShaderCompilers: Warning: 2 Shader compiler errors compiling global shaders',
      'LogWindows: Error: appError called: Assertion failed',
      'LogStreaming: VeryVerbose: gc barrier',
      '[2026.08.31-05.00.00:000][ 42]LogNet: Warning: connection timed out',
    ], 'app.t-unreal', 6);

    const by = (rx) => evs.find((e) => rx.test(e.msg));
    assert.equal(by(/Running engine/).level, 'INFO');          // Display
    assert.equal(by(/cached read wrapper/).level, 'INFO');     // bare = Log
    assert.equal(by(/Shader compiler/).level, 'WARN');
    assert.equal(by(/appError/).level, 'ERROR');
    assert.equal(by(/gc barrier/).level, 'TRACE');             // VeryVerbose
    assert.equal(by(/connection timed out/).level, 'WARN');    // -LogTimes prefix
    // The category is the searchable half of an Unreal line.
    assert.match(by(/Running engine/).msg, /^\[LogInit\]/);
    assert.match(by(/connection timed out/).msg, /^\[LogNet\]/);
  });

  it('unity: compiler diagnostics and thrown exceptions, not folder names', async () => {
    const evs = await tailFile('unity-editor.log', 'unity', [
      "Assets/Scripts/Player.cs(42,13): error CS0246: The type or namespace name 'Foo' could not be found",
      'Assets/Scripts/Old.cs(7,9): warning CS0618: UnityEngine.WWW is obsolete',
      'NullReferenceException: Object reference not set to an instance of an object',
      // Real import chatter: the path contains "Exceptions" and must stay INFO.
      'Start importing Packages/com.unity.visualscripting/Runtime/VisualScripting.Core/Exceptions using Guid(de71607b17af64bd6905e93e93a2f11c)',
    ], 'app.t-unity', 4);

    const by = (rx) => evs.find((e) => rx.test(e.msg));
    assert.equal(by(/error CS0246/).level, 'ERROR');
    assert.equal(by(/warning CS0618/).level, 'WARN');
    assert.equal(by(/NullReferenceException/).level, 'ERROR');
    assert.equal(by(/Start importing/).level, 'INFO',
      'a folder named Exceptions became an event level');
  });
});
