//
//  tests/socket.test.mjs - superlog-socket against real datagrams.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  This inlet exists for the half of a bench that will never run an SDK - a
//  router, a NAS, a firewall - so the test sends what those actually send:
//  real UDP datagrams and a real TCP stream, in all three framings, through
//  a real socket. Nothing here calls a parser directly.
//
//  The assertions that matter are the priority arithmetic (severity is
//  `pri & 7`, and the level comes from that rather than from the English in
//  the message, which every vendor writes differently) and the passthrough:
//  a producer already speaking the protocol must arrive unchanged, because
//  re-wrapping it would bury its own level and fields inside a string.
//

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { connect } from 'node:net';

import {
  assertValidEvent, freePort, freeUdpPort, recent, start, startHub, waitFor,
} from './harness.mjs';

// The mapping under test, restated here so the test is not merely agreeing
// with the implementation's own table.
const SEVERITY = ['CRITICAL', 'CRITICAL', 'CRITICAL', 'ERROR',
                  'WARN', 'INFO', 'INFO', 'DEBUG'];
const levelFor = (pri) => SEVERITY[pri & 7];

let hub, tool, udpPort, tcpPort;

before(async () => {
  hub = await startHub();
  udpPort = await freeUdpPort();
  tcpPort = await freePort();
  tool = start('superlog-socket.mjs', ['--udp', String(udpPort), '--tcp', String(tcpPort)],
               { url: hub.url });
  // Both listeners announce themselves from inside their bind callback, so
  // this is proof the port is open rather than a guess that it might be.
  await tool.waitForStderr(new RegExp(`syslog/udp on 127\\.0\\.0\\.1:${udpPort}`));
  await tool.waitForStderr(new RegExp(`lines/tcp on 127\\.0\\.0\\.1:${tcpPort}`));
});

after(async () => {
  await tool?.stop();
  await hub?.stop();
});

function sendUdp(lines) {
  return new Promise((res, rej) => {
    const s = createSocket('udp4');
    let left = lines.length;
    s.bind(0, '127.0.0.1', () => {
      for (const l of lines)
        s.send(Buffer.from(l), udpPort, '127.0.0.1', (e) => {
          if (e) { s.close(); rej(e); return; }
          if (--left === 0) s.close(res);
        });
    });
    s.on('error', rej);
  });
}

function sendTcp(text) {
  return new Promise((res, rej) => {
    const c = connect(tcpPort, '127.0.0.1', () => c.end(text, () => res()));
    c.on('error', rej);
  });
}

const all = () => recent(hub.url, { topic: '*', limit: 1000 });
const find = (records, fn) => records.find((r) => fn(r.event, r.topic));

describe('superlog-socket', () => {
  it('decodes RFC 5424, and takes the level from the priority', async () => {
    const pri = 34;                          // auth.crit
    await sendUdp([`<${pri}>1 2026-08-24T04:12:00.003Z fw01 sshd 1234 ID47 - ` +
                   'Failed password for root from 10.0.0.9']);
    const recs = await waitFor(hub.url, (rs) => rs.some((r) => r.topic === 'syslog.fw01.sshd'),
                               { topic: '*' });
    const rec = find(recs, (_e, t) => t === 'syslog.fw01.sshd');
    const e = assertValidEvent(rec.event, 'rfc5424');

    assert.equal(e.msg, 'Failed password for root from 10.0.0.9');
    assert.equal(e.level, levelFor(pri));
    assert.equal(e.level, 'CRITICAL', '34 & 7 == 2, which is crit');
    assert.equal(e.fields.severity, String(pri & 7));
    assert.equal(e.fields.facility, 'auth', '34 >> 3 == 4');
    assert.equal(e.fields.rfc, '5424');
    assert.equal(e.fields.pid, '1234');
    assert.equal(e.fields.transport, 'udp');
    assert.equal(e.tag, 'sshd');
    assert.equal(e.origin.runtime, 'socket');
  });

  it('decodes RFC 3164, brackets and all', async () => {
    const pri = 86;                          // authpriv.info
    await sendUdp([`<${pri}>Aug 24 04:12:02 router01 dhcpd[901]: lease 192.168.1.44 renewed`]);
    const recs = await waitFor(hub.url, (rs) => rs.some((r) => r.topic === 'syslog.router01.dhcpd'),
                               { topic: '*' });
    const e = assertValidEvent(find(recs, (_e, t) => t === 'syslog.router01.dhcpd').event, 'rfc3164');

    assert.equal(e.msg, 'lease 192.168.1.44 renewed');
    assert.equal(e.level, levelFor(pri));
    assert.equal(e.level, 'INFO');
    assert.equal(e.fields.rfc, '3164');
    assert.equal(e.fields.pid, '901');
    assert.equal(e.fields.facility, 'authpriv');
  });

  it('accepts a bare priority, which plenty of appliances send and nothing else parses', async () => {
    const pri = 7;                           // kern.debug
    await sendUdp([`<${pri}>kernel: usb 1-1: new high-speed USB device number 4`]);
    const recs = await waitFor(hub.url, (rs) => rs.some((r) => r.topic === 'syslog.127.0.0.1.kern'),
                               { topic: '*' });
    const e = assertValidEvent(find(recs, (_e, t) => t === 'syslog.127.0.0.1.kern').event, 'bare');

    assert.equal(e.msg, 'kernel: usb 1-1: new high-speed USB device number 4');
    assert.equal(e.level, levelFor(pri));
    assert.equal(e.level, 'DEBUG', '7 & 7 == 7, which is debug');
    assert.equal(e.fields.rfc, 'bare');
    assert.equal(e.fields.facility, 'kern');
    // No app name to take, so the facility names the stream instead.
    assert.equal(e.fields.severity, '7');
  });

  it('maps every priority by severity = pri & 7, not by the words in the message', async () => {
    // Same alarming English, five different priorities: only the number
    // decides. 11 = user.err, 190 = local7.info.
    const cases = [
      { pri: 11, host: 'nas01', app: 'smbd', want: 'ERROR' },
      { pri: 190, host: 'sw01', app: 'snmpd', want: 'INFO' },
      { pri: 12, host: 'ups01', app: 'upsd', want: 'WARN' },
      { pri: 8, host: 'pdu01', app: 'pdud', want: 'CRITICAL' },
    ];
    for (const c of cases)
      await sendUdp([`<${c.pri}>1 2026-08-24T04:12:01.000Z ${c.host} ${c.app} - - - ` +
                     'everything is completely fine']);

    const recs = await waitFor(hub.url,
      (rs) => cases.every((c) => rs.some((r) => r.topic === `syslog.${c.host}.${c.app}`)),
      { topic: '*' });

    for (const c of cases) {
      const e = assertValidEvent(find(recs, (_e, t) => t === `syslog.${c.host}.${c.app}`).event,
                                 `pri ${c.pri}`);
      assert.equal(levelFor(c.pri), c.want, `the test's own table disagrees for ${c.pri}`);
      assert.equal(e.level, c.want, `<${c.pri}> should be ${c.want}`);
      assert.equal(e.fields.severity, String(c.pri & 7));
    }
  });

  it('passes a super-log event through verbatim, keeping its own level', async () => {
    const own = {
      v: 1, ts: '2026-08-24T04:12:04.000Z', seq: 17, session: 'deadbeef',
      level: 'CRITICAL', origin: { runtime: 'cpp', app: 'pricer', platform: 'linux' },
      tag: 'engine', msg: 'engine aborted', fields: { code: '9' },
      trace: '9f1c0a2b7d4e5f60',
    };
    await sendUdp([JSON.stringify(own)]);

    const recs = await waitFor(hub.url, (rs) => rs.some((r) => r.event?.msg === 'engine aborted'),
                               { topic: '*' });
    const rec = find(recs, (e) => e.msg === 'engine aborted');
    const e = assertValidEvent(rec.event, 'passthrough');

    assert.ok(rec.topic.startsWith('socket.'), `unexpected topic ${rec.topic}`);
    // Not re-wrapped: everything the producer said is still the event's own.
    assert.deepEqual(e, own);
    assert.equal(e.level, 'CRITICAL');
    assert.equal(e.origin.runtime, 'cpp', 'a re-wrap would have made this "socket"');
    assert.equal(e.seq, 17, 'a re-wrap would have replaced the producer\'s counter');
    assert.equal(e.trace, '9f1c0a2b7d4e5f60');
  });

  it('gives a plain line the socket.* topic and the default level', async () => {
    await sendUdp(['a device that speaks no syslog at all, just text']);

    const recs = await waitFor(hub.url,
      (rs) => rs.some((r) => r.event?.msg?.startsWith('a device that speaks no syslog')),
      { topic: '*' });
    const rec = find(recs, (e) => e.msg?.startsWith('a device that speaks no syslog'));
    const e = assertValidEvent(rec.event, 'plain');

    assert.match(rec.topic, /^socket\.[a-z0-9._-]+\.127\.0\.0\.1$/);
    assert.equal(e.level, 'INFO');
    assert.equal(e.fields.transport, 'udp');
    assert.equal(e.fields.peer, '127.0.0.1');
  });

  it('reads syslog over TCP as well as UDP', async () => {
    const pri = 11;
    await sendTcp(`<${pri}>1 2026-08-24T04:12:05.000Z tcpbox rsyslogd - - - forwarded backlog\n` +
                  'and a raw line with no framing on the same connection\n');

    const recs = await waitFor(hub.url,
      (rs) => rs.some((r) => r.topic === 'syslog.tcpbox.rsyslogd') &&
              rs.some((r) => r.event?.msg?.startsWith('and a raw line with no framing')),
      { topic: '*' });

    const sys = assertValidEvent(find(recs, (_e, t) => t === 'syslog.tcpbox.rsyslogd').event, 'tcp-syslog');
    assert.equal(sys.msg, 'forwarded backlog');
    assert.equal(sys.level, levelFor(pri));
    assert.equal(sys.level, 'ERROR');
    assert.equal(sys.fields.transport, 'tcp');

    const raw = find(recs, (e) => e.msg?.startsWith('and a raw line with no framing'));
    assert.ok(raw.topic.startsWith('socket.'));
    assert.equal(assertValidEvent(raw.event, 'tcp-plain').fields.transport, 'tcp');
  });

  it('emits nothing that fails the protocol', async () => {
    for (const r of await all()) assertValidEvent(r.event, r.topic);
  });
});
