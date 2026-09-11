//
//  tests/firmware.test.mjs - superlog-firmware against stand-in hardware tools.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  A CI box has one CPU, no NVIDIA card, no FPGA and no drone, so the tools
//  are played by shell scripts on PATH emitting real captured output - the
//  technique tests/gpu.test.mjs uses for nvidia-smi and tests/topology.test.mjs
//  for arp/traceroute. That exercises the whole path a real machine takes: the
//  command detection, the tolerant parsers, the scheme classification, and the
//  device-vs-host identity split. The MAVLink frame is hand-built with a real
//  CRC (the tests/mavlink.test.mjs bargain: the encoder is the fixture, the
//  shipping decoder is under test), so "what firmware is flying" is proven
//  without a flight controller on the bench.
//
//  What earns this file: an inventory is published for the host's own silicon;
//  a deployed-version CHANGE carries before AND after (the transition an
//  incident correlates against); and a device fact carries a `device` identity
//  distinct from the `host` that probed it - the property the commercial
//  consumer needs so one host can probe three boards and one board be probed
//  from two hosts.
//

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { assertValidEvent, removeDir, run, startHub, tempDir, waitFor } from './harness.mjs';

let hub, work;
let binSeq = 0;

/** A PATH containing ONLY the tools named plus a shell and the utilities the
 *  probes and stand-ins use - so the real sysctl/nvidia-smi/lsblk/lsusb are
 *  genuinely absent and the detection runs against the stand-ins on both
 *  macOS and Linux. The same shape as tests/gpu.test.mjs's bench(). */
function bench(tools) {
  const dir = join(work, `bin${binSeq += 1}`);
  mkdirSync(dir);
  for (const u of ['sh', 'cat', 'sed', 'head', 'tr', 'grep', 'echo', 'printf']) {
    for (const d of ['/bin', '/usr/bin']) {
      if (existsSync(join(d, u))) { symlinkSync(join(d, u), join(dir, u)); break; }
    }
  }
  for (const [name, body] of Object.entries(tools)) {
    const p = join(dir, name);
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
  }
  return dir;
}

// ---- an independent MAVLink AUTOPILOT_VERSION encoder (the fixture) ----
const AV_EXTRA = 178;                      // AUTOPILOT_VERSION (msgid 148)
function crcAcc(b, crc) {
  let t = b ^ (crc & 0xff);
  t = (t ^ (t << 4)) & 0xff;
  return ((crc >> 8) ^ (t << 8) ^ (t << 3) ^ (t >> 4)) & 0xffff;
}
function crc16(bytes, extra) {
  let crc = 0xffff;
  for (const b of bytes) crc = crcAcc(b, crc);
  return crcAcc(extra, crc);
}
/** A real v2 AUTOPILOT_VERSION frame: flight_sw 4.5.7, board 16, git abcdef12,
 *  hardware UID as the device identity. Fields at MAVLink's wire offsets. */
function autopilotFrame({ sysid = 1 } = {}) {
  const p = Buffer.alloc(60);
  p.writeBigUInt64LE(0n, 0);                            // capabilities
  p.writeBigUInt64LE(0x0011223344556677n, 8);          // uid (hardware serial)
  p.writeUInt32LE((4 << 24) | (5 << 16) | (7 << 8) | 255, 16); // flight_sw_version 4.5.7
  p.writeUInt32LE(0, 20);                               // middleware_sw_version
  p.writeUInt32LE(0, 24);                               // os_sw_version
  p.writeUInt32LE(16, 28);                              // board_version
  p.writeUInt16LE(0x10c4, 32);                          // vendor_id
  p.writeUInt16LE(0x0001, 34);                          // product_id
  Buffer.from('abcdef12').copy(p, 36, 0, 8);            // flight_custom_version (git hash)
  const head = Buffer.from([0xFD, p.length, 0, 0, 0, sysid, 1,
                            148 & 0xff, (148 >> 8) & 0xff, (148 >> 16) & 0xff]);
  const noCrc = Buffer.concat([head, p]);
  const crc = crc16(noCrc.subarray(1), AV_EXTRA);
  return Buffer.concat([noCrc, Buffer.from([crc & 0xff, (crc >> 8) & 0xff])]);
}

before(async () => { hub = await startHub(); work = tempDir('superlog-firmware-'); });
after(async () => { await hub?.stop(); removeDir(work); });

/** Run the tailer with the fake tools ahead of the real ones, then wait for
 *  events on `topic` and validate every one against the protocol. */
async function fw(topic, argv, { timeoutMs = 20000, path, predicate } = {}) {
  await run('superlog-firmware.mjs', argv, { url: hub.url, timeoutMs, env: { PATH: path } });
  const recs = await waitFor(hub.url, predicate ?? ((r) => r.length > 0), { topic, timeoutMs: 15000 });
  recs.forEach((r, i) => assertValidEvent(r.event, `${topic}[${i}]`));
  return recs.map((r) => r.event);
}

describe('superlog-firmware', () => {
  it('publishes the host silicon inventory, with the GPU driver as an orderable version', async () => {
    const path = bench({
      sysctl: 'case "$2" in\n' +
        '  machdep.cpu.brand_string) echo "Apple M2 Pro" ;;\n' +
        '  *) exit 0 ;;\n' +
        'esac',
      'nvidia-smi': 'echo "NVIDIA GeForce RTX 4090, 550.54.15"',
    });
    const evs = await fw('host.testbox.versions', ['--once', '--name', 'testbox'], { path });

    const reading = evs.find((e) => e.fields?.versions);
    assert.ok(reading, 'the whole inventory must ride one reading (fields.versions)');
    assert.equal(reading.level, 'DEBUG', 'the inventory stays out of a default INFO view');

    const driver = evs.find((e) => e.fields?.tool === 'gpu-driver');
    assert.ok(driver, 'the GPU driver version is a fact of its own');
    assert.equal(driver.fields.version, '550.54.15');
    assert.equal(driver.fields.scheme, 'semver', 'the advisor must know which comparator applies');
    assert.equal(driver.fields.category, 'hardware');
    assert.equal(driver.fields.provenance, 'nvidia-smi');
    assert.match(driver.fields.purl, /pkg:generic\/nvidia-driver@550\.54\.15/);
    assert.equal(driver.fields.device, 'testbox', 'the host is its own device for its silicon');

    const cpu = evs.find((e) => e.fields?.tool === 'cpu');
    assert.ok(cpu, 'the CPU model is captured');
    assert.match(cpu.fields.raw, /Apple M2 Pro/);
    assert.equal(cpu.fields.unorderable, 'true', 'a model name is not an orderable version');
  });

  it('reports a deployed firmware-version CHANGE with both before and after', async () => {
    // The FPGA/deployed drift: a config-supplied probe reads a version register.
    // A counter file makes the stand-in return v2.3.1 first and v2.4.0 after,
    // exactly the tests/gpu.test.mjs heat-crossing technique.
    const counter = join(work, 'bitstream-rev');
    const probes = join(work, 'fpga.json');
    writeFileSync(probes, JSON.stringify({
      probes: [{
        device: 'fpga-a', target: 'ice40-bench1', tool: 'bitstream', scheme: 'semver',
        cmd: `n=$(cat ${counter} 2>/dev/null || echo 0); echo $((n+1)) > ${counter}; ` +
             'if [ "$n" -lt 1 ]; then echo "v2.3.1"; else echo "v2.4.0"; fi',
      }],
    }));
    const path = bench({});     // a shell and coreutils; no host tools at all
    const evs = await fw('firmware.fpga-a',
      ['--interval', '1', '--name', 'prober', '--probes', probes],
      { timeoutMs: 8000, path, predicate: (r) => r.some((e) => e.event?.fields?.change === 'changed') });

    const change = evs.find((e) => e.fields?.change === 'changed');
    assert.ok(change, 'a deployed version that moves must announce it');
    assert.equal(change.fields.before, '2.3.1', 'the transition carries where it came from');
    assert.equal(change.fields.after, '2.4.0', 'and where it went');
    assert.equal(change.fields.category, 'deployed');
    assert.equal(change.fields.device, 'fpga-a', 'keyed by the board, not the prober');
    assert.equal(change.level, 'INFO', 'a minor bump is INFO; a major would be WARN');

    // It said so once, not every poll - the house discipline.
    assert.equal(evs.filter((e) => e.fields?.change === 'changed').length, 1,
                 'a version change is reported once, not on every poll after');
  });

  it('decodes MAVLink AUTOPILOT_VERSION: the flying firmware, keyed by the board not the host', async () => {
    const frame = join(work, 'autopilot.bin');
    writeFileSync(frame, autopilotFrame());
    const path = bench({});
    // The hub's topic filter matches whole dot-segments, so a board keyed by
    // its UID is reached under the firmware. prefix, then picked out by tool.
    const evs = await fw('firmware.', ['--frame', frame, '--once', '--name', 'dronebox'],
      { path, predicate: (r) => r.some((e) => e.event?.fields?.tool === 'autopilot') });

    const av = evs.find((e) => e.fields?.tool === 'autopilot');
    assert.ok(av, 'the autopilot firmware must be reported');
    assert.equal(av.fields.flight_sw_version, '4.5.7', 'the flashed flight-software version');
    assert.equal(av.fields.version, '4.5.7');
    assert.equal(av.fields.scheme, 'semver');
    assert.equal(av.fields.board_version, '16', 'the board version rides alongside');
    assert.equal(av.fields.git_hash, 'abcdef12', 'the git hash it was built from');
    assert.equal(av.fields.provenance, 'mavlink');
    assert.equal(av.fields.category, 'firmware');

    // The identity split the commercial consumer requires: the board is named
    // by its own UID, separate from the host that read it.
    assert.equal(av.fields.host, 'dronebox', 'the prober is the host');
    assert.match(av.fields.device, /^mav-/, 'the board is named by its hardware UID');
    assert.notEqual(av.fields.device, av.fields.host, 'the board is not the host that probed it');
  });
});
