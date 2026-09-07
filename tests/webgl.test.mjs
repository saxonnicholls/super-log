//
//  tests/webgl.test.mjs - patchWebGL against a stand-in context.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  There is no GPU and no browser in a test runner, so the WebGL context is
//  a plain object with the handful of methods patchWebGL actually touches.
//  That is enough to test the half that carries the logic - wrapping
//  compileShader and linkProgram, reading the info logs, and pulling the
//  offending source line out of "ERROR: 0:12:" - and honest about the half
//  it cannot: context loss and restore are real browser events on a real
//  canvas, and they are verified by opening demo/web, not here.
//
//  The assertion that earns this file is the source line. A shader info log
//  names a line number and nothing else; without pulling that line out of
//  the source, the event says "syntax error on line 12" and the reader still
//  has to go and find line 12 themselves.
//

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { assertValidEvent, recent, startHub, waitFor } from './harness.mjs';

const CLIENT = new URL('../sdk/js/packages/client/dist/index.js', import.meta.url).href;

let hub, createSuperLog;

before(async () => {
  hub = await startHub();
  ({ createSuperLog } = await import(CLIENT));
});

after(async () => { await hub?.stop(); });

/** The smallest object patchWebGL will accept: the constants it reads, the
 *  two calls it wraps, and the queries it makes after a failure. */
function fakeGl({ compileOk = true, linkOk = true, info = '', source = '',
                  missingExts = [] } = {}) {
  return {
    VERSION: 1, SHADING_LANGUAGE_VERSION: 2, COMPILE_STATUS: 3, LINK_STATUS: 4,
    MAX_TEXTURE_SIZE: 5, MAX_RENDERBUFFER_SIZE: 6, MAX_COMBINED_TEXTURE_IMAGE_UNITS: 7,
    canvas: undefined,                      // no DOM in a test runner
    getExtension: (name) => (missingExts.includes(name) ? null : {}),
    getParameter: (p) => (p === 1 ? 'WebGL 2.0 (stand-in)'
                        : p === 2 ? 'GLSL ES 3.00'
                        : p === 5 ? 16384 : p === 6 ? 16384 : 32),
    compileShader: () => {},
    linkProgram: () => {},
    getShaderParameter: () => compileOk,
    getProgramParameter: () => linkOk,
    getShaderInfoLog: () => info,
    getProgramInfoLog: () => info,
    getShaderSource: () => source,
    getError: () => 0,
  };
}

async function eventsFor(topic, run) {
  const log = createSuperLog({ url: hub.url, topic, app: 'webgl', development: true });
  run(log);
  await log.flush();
  const recs = await waitFor(hub.url, (r) => r.length > 0, { topic, timeoutMs: 10000 });
  recs.forEach((r, i) => assertValidEvent(r.event, `${topic}[${i}]`));
  return recs.map((r) => r.event);
}

describe('patchWebGL', () => {
  it('says what the context is when it attaches', async () => {
    const evs = await eventsFor('webgl.test.up', (log) => {
      log.patchWebGL(fakeGl());
    });
    const up = evs.find((e) => /context up/.test(e.msg));
    assert.ok(up, 'attaching should say so');
    assert.equal(up.tag, 'webgl');
    assert.match(up.fields.version, /WebGL 2\.0/);
  });

  // From a real shipped defect: an HDR/bloom pipeline needs float colour
  // buffers and linear filtering of them, Safari's WebGL2 lacks both on many
  // GPUs, and the composite pass then yields a BLACK FRAME with a clean
  // console. Nothing throws. The only way to see it coming is to ask what
  // the machine can do and say when the answer is "less than you assumed".
  it('warns when an extension that fails SILENTLY is unavailable', async () => {
    const evs = await eventsFor('webgl.test.caps', (log) => {
      log.patchWebGL(fakeGl({
        missingExts: ['EXT_color_buffer_float', 'OES_texture_float_linear'],
      }));
    });
    const up = evs.find((e) => /context up/.test(e.msg));
    assert.equal(up.level, 'WARN', 'a missing silent-failure extension is not an INFO');
    assert.match(up.msg, /2 extension\(s\) unavailable/);
    assert.equal(up.fields.no_EXT_color_buffer_float, 'missing');
    assert.equal(up.fields.no_OES_texture_float_linear, 'missing');
    assert.equal(up.fields.max_texture, '16384', 'limits ride along for comparison');
  });

  it('stays INFO when the machine has everything', async () => {
    const evs = await eventsFor('webgl.test.capsok', (log) => {
      log.patchWebGL(fakeGl());
    });
    const up = evs.find((e) => /context up/.test(e.msg));
    assert.equal(up.level, 'INFO');
    assert.doesNotMatch(up.msg, /unavailable/);
  });

  it('reports a shader that failed to compile, with the line it names', async () => {
    // A real GLSL info log: the line number is all it gives you.
    const info = "ERROR: 0:3: 'vec5' : undeclared identifier\nERROR: 1 compilation error.";
    const source = '#version 300 es\nin vec4 a_pos;\nvec5 broken;\nvoid main(){}';
    const evs = await eventsFor('webgl.test.shader', (log) => {
      const gl = fakeGl({ compileOk: false, info, source });
      log.patchWebGL(gl);
      gl.compileShader({});
    });

    const err = evs.find((e) => /shader compile failed/.test(e.msg));
    assert.ok(err, 'a failed compile must be reported - it does not throw');
    assert.equal(err.level, 'ERROR');
    assert.match(err.msg, /undeclared identifier/);
    assert.match(err.fields.log, /compilation error/, 'the whole info log rides along');
    // The point of the file: line 3 of the source, fetched for the reader.
    assert.equal(err.fields.source, '3: vec5 broken;');
  });

  it('says nothing when the shader compiles', async () => {
    const evs = await eventsFor('webgl.test.ok', (log) => {
      const gl = fakeGl({ compileOk: true });
      log.patchWebGL(gl);
      gl.compileShader({});
      log.info('drew a frame');
    });
    assert.equal(evs.filter((e) => /compile failed/.test(e.msg)).length, 0,
                 'a working shader is not news');
    assert.ok(evs.some((e) => e.msg === 'drew a frame'), 'and ordinary logging still works');
  });

  it('reports a program that failed to link', async () => {
    const evs = await eventsFor('webgl.test.link', (log) => {
      const gl = fakeGl({ linkOk: false, info: 'Varying a_uv has no matching input' });
      log.patchWebGL(gl);
      gl.linkProgram({});
    });
    const err = evs.find((e) => /link failed/.test(e.msg));
    assert.ok(err, 'a link failure is silent otherwise - the object just draws nothing');
    assert.equal(err.level, 'ERROR');
    assert.match(err.fields.log, /no matching input/);
  });

  it('restores the context object when detached, and does not double-patch', async () => {
    const gl = fakeGl({ compileOk: false, info: 'ERROR: 0:1: bad' });
    const before = gl.compileShader;
    const log = createSuperLog({ url: hub.url, topic: 'webgl.test.detach',
                                 app: 'webgl', development: true });

    const detach = log.patchWebGL(gl);
    assert.notEqual(gl.compileShader, before, 'it should have wrapped');

    // Patching twice would double-report every failure.
    const second = log.patchWebGL(gl);
    second();
    assert.notEqual(gl.compileShader, before, 'the no-op detach must not unwrap the first');

    detach();
    assert.equal(gl.compileShader, before, 'detach puts the original back');
    await log.flush();
  });

  it('survives a context that refuses to answer questions', async () => {
    // A lost context throws from almost everything. The logger must not turn
    // that into a second failure on top of the one already happening.
    const hostile = {
      ...fakeGl(),
      getParameter: () => { throw new Error('context lost'); },
      getShaderParameter: () => { throw new Error('context lost'); },
    };
    const evs = await eventsFor('webgl.test.hostile', (log) => {
      assert.doesNotThrow(() => {
        const d = log.patchWebGL(hostile);
        hostile.compileShader({});
        d();
      });
      log.info('still running');
    });
    assert.ok(evs.some((e) => e.msg === 'still running'),
              'the program must keep going after the logger meets a dead context');
  });
});
