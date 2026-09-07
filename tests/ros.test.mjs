//
//  tests/ros.test.mjs - superlog-ros against a stand-in for the robot.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  A ROS distro is not something CI has, and the tool never links against
//  one anyway: it drives the `ros2` CLI and reads its YAML. So the CLI is
//  played by a shell script on PATH that cats a captured `ros2 topic echo
//  /rosout` document, which exercises exactly the code path a real robot
//  does - the spawn, the sh wrapper, the setup.sh probe, the line splitting
//  and the parser.
//
//  The assertion that earns this file is the unquoting. `ros2 topic echo`
//  single-quotes any scalar that needs it and escapes an inner quote by
//  DOUBLING it, so `sensor ''lidar'' timed out` is the robot saying
//  `sensor 'lidar' timed out`. Getting that wrong corrupts precisely the
//  interesting messages, since those are the ones with punctuation in them.
//

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  FIXTURES, assertValidEvent, removeDir, run, start, startHub, tempDir, waitFor,
} from './harness.mjs';

let hub, work, fakeBin;

before(async () => {
  hub = await startHub();
  work = tempDir('superlog-ros-');
  fakeBin = join(work, 'bin');
  mkdirSync(fakeBin);

  // `sleep` at the end because the tool treats the echo exiting as the robot
  // rebooting and reconnects three seconds later - which would republish
  // everything and turn every count in this file into a race.
  const ros2 = join(fakeBin, 'ros2');
  writeFileSync(ros2,
    '#!/bin/sh\n' +
    `cat ${JSON.stringify(join(FIXTURES, 'ros-rosout.yaml'))}\n` +
    'exec sleep 10\n');
  chmodSync(ros2, 0o755);
});

after(async () => {
  await hub?.stop();
  removeDir(work);
});

// A function, not a constant: `fakeBin` only exists once before() has run.
const withFakeRos = () => ({ PATH: `${fakeBin}:${process.env.PATH}` });
const byNode = (recs, node) => recs.find((r) => r.topic.endsWith(`.${node}`));

describe('superlog-ros', () => {
  describe('/rosout', () => {
    let recs, tool;

    before(async () => {
      tool = start('superlog-ros.mjs', [], { url: hub.url, env: withFakeRos() });
      await tool.waitForStderr(/echoing \/rosout/);
      recs = await waitFor(hub.url,
        (rs) => ['talker', 'planner', 'costmap_2d', 'motor_driver']
          .every((n) => rs.some((r) => r.topic.endsWith(`.${n}`))),
        { topic: '*', timeoutMs: 20000 });
      for (const r of recs) assertValidEvent(r.event, r.topic);
    });

    after(async () => { await tool?.stop(); });

    it("decodes YAML's doubled single quote back into the robot's own words", async () => {
      const e = byNode(recs, 'costmap_2d').event;
      assert.equal(e.msg, "costmap update failed: sensor 'lidar' timed out");
      assert.doesNotMatch(e.msg, /''/, 'the doubling must not survive into the message');
    });

    it('maps all five ROS severities', () => {
      // The wire is a byte; these five numbers are the whole vocabulary.
      const want = [
        ['talker', 10, 'DEBUG'],
        ['planner', 30, 'WARN'],
        ['costmap_2d', 40, 'ERROR'],
        ['motor_driver', 50, 'CRITICAL'],
      ];
      for (const [node, num, level] of want) {
        const e = byNode(recs, node).event;
        assert.equal(e.level, level, `level ${num} on ${node}`);
      }
      // 20 -> INFO, which is the same node as 10 so it needs picking out.
      const talker = recs.filter((r) => r.topic.endsWith('.talker')).map((r) => r.event);
      assert.ok(talker.some((e) => e.level === 'INFO' && e.msg === "Publishing 'Hello World: 1'"),
                'level 20 should be INFO');
    });

    it('gives each node its own topic, and the ROS macro its src', () => {
      const rec = byNode(recs, 'planner');
      assert.match(rec.topic, /^ros\.[a-z0-9._-]+\.planner$/);
      assert.equal(rec.event.src, '/opt/ros/jazzy/src/planner.cpp:311');
      assert.equal(rec.event.fields.function, 'replan');
      assert.equal(rec.event.fields.node, 'planner');
      assert.equal(rec.event.origin.runtime, 'ros');
      assert.equal(rec.event.tag, 'planner');
    });

    it('decodes double-quoted escapes as well as single-quoted ones', () => {
      const e = byNode(recs, 'motor_driver').event;
      assert.equal(e.msg, 'emergency stop asserted\nbrakes engaged');
    });

    it('publishes nothing back into the ROS graph', () => {
      // The fake ros2 ignores its arguments, so what it was ASKED to do is
      // the only evidence - and `topic echo` is read-only by construction.
      assert.match(tool.stderr(), /echoing \/rosout/);
      assert.doesNotMatch(tool.stderr(), /topic pub|param set/);
    });
  });

  describe('--files', () => {
    let recs;

    before(async () => {
      const logDir = join(work, 'roslog', 'run_2026-08-24-04-12-00-000000-bench-1234');
      mkdirSync(logDir, { recursive: true });
      writeFileSync(join(logDir, 'talker_1234_5678.log'),
        "[INFO] [1755831845.123456789] [talker]: Publishing: 'Hello World: 1'\n" +
        '[WARNING] [1755831846.000000000] [talker]: publish rate below target\n' +
        '[ERROR] [1755831847.000000000] [motor_driver]: driver timeout on joint 3\n' +
        '[FATAL] [1755831848.000000000] [motor_driver]: watchdog fired, halting\n' +
        'a line no ROS logger wrote\n');

      const r = await run('superlog-ros.mjs', ['--files', join(work, 'roslog')],
                          { url: hub.url, env: withFakeRos(), timeoutMs: 20000 });
      assert.match(r.stderr, /read 1 log file\(s\) from 1 run\(s\)/);

      recs = await waitFor(hub.url,
        (rs) => rs.some((r2) => r2.event?.msg === 'watchdog fired, halting'),
        { topic: '*', timeoutMs: 15000 });
      for (const rec of recs) assertValidEvent(rec.event, rec.topic);
    });

    it('reads the console format out of ~/.ros/log', () => {
      const byMsg = (m) => recs.find((r) => r.event.msg === m);

      assert.equal(byMsg("Publishing: 'Hello World: 1'").event.level, 'INFO');
      assert.equal(byMsg('publish rate below target').event.level, 'WARN');
      assert.equal(byMsg('driver timeout on joint 3').event.level, 'ERROR');
      assert.equal(byMsg('watchdog fired, halting').event.level, 'CRITICAL');
    });

    it('routes each line to its own node, not to the file it was found in', () => {
      const driver = recs.find((r) => r.event.msg === 'driver timeout on joint 3');
      assert.match(driver.topic, /\.motor_driver$/,
                   'the node named in the line wins over the filename');
      const talker = recs.find((r) => r.event.msg === 'publish rate below target');
      assert.match(talker.topic, /\.talker$/);
      assert.equal(talker.event.fields.stamp, '1755831846.000000000');
    });

    it('keeps a line it cannot parse rather than dropping it', () => {
      const stray = recs.find((r) => r.event.msg === 'a line no ROS logger wrote');
      assert.ok(stray, 'the tolerant-reader rule applies to log files too');
      assert.equal(stray.event.level, 'INFO');
      assert.match(stray.topic, /\.talker$/, 'unattributed lines belong to the file\'s node');
    });

    // --files is the one dual-purpose flag here: bare, or with a directory.
    // Read with a naive positional it swallowed whatever followed it, so
    // `--files --url http://…` looked for logs in a folder called "--url"
    // and reported that the robot had never run - a plausible-looking WARN,
    // which is the worst kind of wrong answer.
    it('does not mistake the next flag for its directory', async () => {
      const bare = await run('superlog-ros.mjs', ['--files', '--url', hub.url],
                             { timeoutMs: 8000 });
      assert.doesNotMatch(bare.stderr, /--url/,
                          '--files took the following flag as its value');
      assert.match(bare.stderr, /\.ros[/\\]log/,
                   'with no directory given it must fall back to ~/.ros/log');
    });
  });
});
