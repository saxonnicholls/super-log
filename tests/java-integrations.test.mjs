//
//  tests/java-integrations.test.mjs - the JVM logging bridges, for real.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  Three integrations live outside the zero-dependency core (sdk/java/
//  integrations), each compiled only with the logging library it bridges:
//  a Logback appender, a Log4j 2 appender, and - the headline - an SLF4J 2.0
//  service provider that makes super-log a DROP-IN logging backend. This test
//  compiles all three against their libraries, then proves the SLF4J drop-in
//  end to end: a plain SLF4J program with NO logback on the classpath, only
//  slf4j-api + our provider, lands its lines on the bench with no code change.
//
//  The logging jars are not vendored. Run sdk/java/integrations/fetch-libs.sh
//  once (it downloads pinned jars to sdk/java/.libs, gitignored); without them
//  this suite skips rather than fails, so an offline CI stays green.
//

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { REPO, recent, startHub } from './harness.mjs';

const LIBS = join(REPO, 'sdk/java/.libs');
const JARS = {
  slf4j: 'slf4j-api-2.0.16.jar',
  logbackC: 'logback-classic-1.5.12.jar',
  logbackCore: 'logback-core-1.5.12.jar',
  log4jApi: 'log4j-api-2.24.1.jar',
  log4jCore: 'log4j-core-2.24.1.jar',
};
const jar = (k) => join(LIBS, JARS[k]);

const haveJavac = () => { try { execFileSync('javac', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } };
const haveJars = () => Object.values(JARS).every((j) => existsSync(join(LIBS, j)));
const skip = !haveJavac() ? 'javac not installed'
  : !haveJars() ? 'JVM logging jars missing (run sdk/java/integrations/fetch-libs.sh)'
    : false;

function javaFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.java')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

describe('Java integrations: appenders + SLF4J drop-in', { skip }, () => {
  let hub, work, out;

  before(async () => {
    hub = await startHub();
    work = mkdtempSync(join(tmpdir(), 'slj-'));
    out = join(work, 'out');
    mkdirSync(out, { recursive: true });

    const allJars = Object.keys(JARS).map(jar).join(':');
    // Core: zero-dependency, compiles against nothing.
    execFileSync('javac', ['-d', out, ...javaFiles(join(REPO, 'sdk/java/src'))]);
    // All three integrations, each against its own library on one classpath.
    execFileSync('javac', ['-cp', `${out}:${allJars}`, '-d', out,
      ...javaFiles(join(REPO, 'sdk/java/integrations'))]);
    // The SLF4J service registration must be on the classpath for ServiceLoader.
    mkdirSync(join(out, 'META-INF', 'services'), { recursive: true });
    cpSync(join(REPO, 'sdk/java/integrations/slf4j/META-INF/services/org.slf4j.spi.SLF4JServiceProvider'),
      join(out, 'META-INF', 'services', 'org.slf4j.spi.SLF4JServiceProvider'));
  });

  after(async () => { await hub?.stop(); });

  it('all three integrations compile against their logging library', () => {
    for (const cls of [
      'com/snicholls/superlog/logback/SuperLogAppender.class',
      'com/snicholls/superlog/log4j2/SuperLogAppender.class',
      'com/snicholls/superlog/slf4j/SuperLogSlf4jProvider.class',
    ]) assert.ok(existsSync(join(out, cls)), `${cls} compiled`);
  });

  it('SLF4J drop-in: a plain SLF4J program (no logback) reaches the bench', async () => {
    writeFileSync(join(work, 'Probe.java'),
      'import org.slf4j.Logger; import org.slf4j.LoggerFactory; import org.slf4j.MDC;\n'
      + 'public class Probe {\n'
      + '  public static void main(String[] a) throws Exception {\n'
      + '    Logger log = LoggerFactory.getLogger("checkout");\n'
      + '    MDC.put("user", "42");\n'
      + '    log.info("checkout started for {} items", 3);\n'
      + '    log.warn("slow path");\n'
      + '    log.error("boom", new RuntimeException("kaboom"));\n'
      + '    Thread.sleep(1500);\n'
      + '  }\n}\n');
    execFileSync('javac', ['-cp', jar('slf4j'), '-d', work, join(work, 'Probe.java')]);
    execFileSync('java', ['-cp', `${work}:${out}:${jar('slf4j')}`,
      '-Dsuperlog.mode=development', `-Dsuperlog.url=${hub.url}`,
      '-Dsuperlog.topic=java.slf4j', '-Dsuperlog.app=checkout', 'Probe'], { stdio: 'ignore' });

    const rows = await recent(hub.url, { topic: 'java.slf4j' });
    const ev = rows.map((r) => r.event);
    const info = ev.find((e) => e.level === 'INFO');
    assert.ok(info, 'an INFO line arrived');
    assert.match(info.msg, /checkout started for 3 items/, 'the {} placeholder was formatted');
    assert.equal(info.tag, 'checkout', 'the logger name becomes the tag');
    assert.equal(info.fields.user, '42', 'MDC rides as a field');
    assert.ok(ev.some((e) => e.level === 'WARN'), 'a WARN line arrived');
    const err = ev.find((e) => e.level === 'ERROR');
    assert.ok(err, 'an ERROR line arrived');
    assert.match(err.fields.stack, /kaboom/, 'the throwable stack rides as a field');
  });
});
