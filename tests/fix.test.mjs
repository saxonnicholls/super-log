//
//  tests/fix.test.mjs - superlog-fix against a real QuickFIX-style message log.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  A FIX message log is SOH-delimited tag=value, one message per line, and
//  that is exactly what is written here - the real wire format, into a real
//  file, followed by the real tailer against a real hub. The only thing
//  faked is that a broker is on the other end; the parser, the levelling and
//  the session derivation are the shipping ones.
//
//  What is worth asserting is the levelling and the fields a trader chases:
//  a Reject is ERROR and carries its reason, a rejected fill is ERROR even
//  though an ExecutionReport is normally INFO, a Heartbeat is DEBUG, and the
//  session topic is derived from the message (BeginString-Sender-Target),
//  never the filename. Delimiter tolerance is checked too: one line arrives
//  pipe-delimited and one carries the local-timestamp prefix an engine
//  writes, and both must still decode.
//

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { assertValidEvent, recent, start, startHub, tempDir, removeDir, waitFor } from './harness.mjs';

const SOH = '\x01';
const TOPIC = 'fix.4.4-broker-client';

// Real FIX messages. Checksums are cosmetic here - the tailer never
// validates them, because an engine already did before it wrote the log.
const soh = (s) => s.replace(/\|/g, SOH);
// A real FIX Logon carries a password in tag 554 (and sometimes a NewPassword
// in 925 / RawData in 96). These sit in the test's Logon so the credential
// test below has something real to fail on. Confirmed against the user's own
// LMAX logs, whose Logon carried an account password in 554.
const PASSWORD = 'topsecret-hunter2';
const NEWPASSWORD = 'even-newer-secret';
const MESSAGES = [
  // Logon - INFO. Carries credentials that must never reach the bench.
  soh(`8=FIX.4.4|9=70|35=A|49=BROKER|56=CLIENT|34=1|52=20260907-12:00:00|98=0|108=30|553=BROKER|554=${PASSWORD}|925=${NEWPASSWORD}|96=rawsecret|10=000|`),
  // NewOrderSingle - INFO, with the order fields.
  soh('8=FIX.4.4|35=D|49=BROKER|56=CLIENT|34=2|11=ORD123|55=AAPL|54=1|38=100|44=195.50|40=2|10=000|'),
  // ExecutionReport, a full fill - INFO.
  soh('8=FIX.4.4|35=8|49=BROKER|56=CLIENT|34=3|11=ORD123|55=AAPL|54=1|38=100|150=2|39=2|32=100|31=195.50|10=000|'),
  // A local-timestamp prefix, pipe-delimited: the tolerant reader still decodes it.
  '20260907-12:00:05.123 : ' + '8=FIX.4.4|35=0|49=BROKER|56=CLIENT|34=4|10=000|',
  // Reject - ERROR, carrying the reason and the offending tag.
  soh('8=FIX.4.4|35=3|49=BROKER|56=CLIENT|34=5|45=6|371=35|58=Invalid MsgType|10=000|'),
  // ExecutionReport, a rejected order - ERROR despite being an 8.
  soh('8=FIX.4.4|35=8|49=BROKER|56=CLIENT|34=6|11=ORD999|55=TSLA|54=2|150=8|39=8|58=Insufficient buying power|10=000|'),
  // Logout - WARN.
  soh('8=FIX.4.4|35=5|49=BROKER|56=CLIENT|34=7|58=End of day|10=000|'),
];

let hub, tool, dir, logPath, events;

before(async () => {
  hub = await startHub();
  dir = tempDir('superlog-fix-');
  logPath = join(dir, 'FIX.4.4-BROKER-CLIENT.messages.current.log');
  writeFileSync(logPath, '');   // exists and empty, so -n 0 -F attaches at the end

  tool = start('superlog-fix.mjs', ['--file', logPath], { url: hub.url });
  await tool.waitForStderr(/following 1 log/);

  // BSD tail -F polls the file; give it a beat to attach before the first
  // append, then write the day's traffic in one go.
  await new Promise((r) => setTimeout(r, 700));
  for (const m of MESSAGES) appendFileSync(logPath, m + '\n');

  // Logout is the last message written, so its arrival means all seven are in.
  const recs = await waitFor(hub.url,
    (rs) => rs.some((r) => r.event?.msg === 'Logout'),
    { topic: TOPIC, timeoutMs: 20000 });
  events = recs.map((r) => r.event);
  events.forEach((e, i) => assertValidEvent(e, `${TOPIC}[${i}]`));
});

after(async () => {
  await tool?.stop();
  await hub?.stop();
  removeDir(dir);
});

const byType = (mt) => events.find((e) => e.fields?.msgtype === mt);

describe('superlog-fix', () => {
  it('derives the session topic from the message, not the filename', () => {
    for (const e of events) {
      assert.equal(e.tag, 'fix');
      assert.equal(e.origin.app, 'fix');
      assert.equal(e.fields.sender, 'BROKER');
      assert.equal(e.fields.target, 'CLIENT');
    }
  });

  it('reads a Logon as INFO', () => {
    const logon = byType('A');
    assert.equal(logon.level, 'INFO');
    assert.match(logon.msg, /Logon/);
  });

  it('NEVER lets a Logon password reach the bench', () => {
    // The whole batch: the password (554), NewPassword (925) and RawData (96)
    // must appear in no event's msg or fields, whichever tag carried them.
    for (const e of events) {
      const blob = JSON.stringify(e);
      assert.ok(!blob.includes(PASSWORD), `password leaked into ${blob}`);
      assert.ok(!blob.includes(NEWPASSWORD), `new-password leaked into ${blob}`);
      assert.ok(!blob.includes('rawsecret'), `raw credential leaked into ${blob}`);
    }
    // ...while the Logon itself was still read, so this is a redaction, not a drop.
    assert.equal(byType('A').level, 'INFO', 'the Logon is still an event, minus the secret');
  });

  it('reads a NewOrderSingle with side, quantity and price', () => {
    const nos = byType('D');
    assert.equal(nos.level, 'INFO');
    assert.equal(nos.fields.symbol, 'AAPL');
    assert.equal(nos.fields.side, 'Buy');
    assert.equal(nos.fields.qty, '100');
    assert.equal(nos.fields.price, '195.50');
    assert.equal(nos.fields.clordid, 'ORD123');
    assert.match(nos.msg, /AAPL/);
    assert.match(nos.msg, /Buy/);
  });

  it('reads a full fill as INFO with exec type and status', () => {
    const fill = events.find((e) => e.fields?.msgtype === '8' && e.fields?.exectype === 'Fill');
    assert.equal(fill.level, 'INFO');
    assert.equal(fill.fields.ordstatus, 'Filled');
    assert.equal(fill.fields.lastqty, '100');
    assert.equal(fill.fields.lastpx, '195.50');
  });

  it('gives a rejected fill ERROR even though an ExecutionReport is normally INFO', () => {
    const rej = events.find((e) => e.fields?.msgtype === '8' && e.fields?.exectype === 'Rejected');
    assert.equal(rej.level, 'ERROR', 'a rejected order is what you scroll back looking for');
    assert.equal(rej.fields.symbol, 'TSLA');
    assert.equal(rej.fields.text, 'Insufficient buying power');
  });

  it('gives a session-level Reject ERROR with its reason and offending tag', () => {
    const reject = byType('3');
    assert.equal(reject.level, 'ERROR');
    assert.equal(reject.fields.text, 'Invalid MsgType');
    assert.equal(reject.fields.refseqnum, '6');
    assert.equal(reject.fields.reftag, '35');
    assert.match(reject.msg, /Invalid MsgType/);
  });

  it('gives a Logout WARN and a Heartbeat DEBUG', () => {
    assert.equal(byType('5').level, 'WARN');
    const hb = byType('0');
    assert.equal(hb.level, 'DEBUG', 'a heartbeat every few seconds is a watcher people mute');
  });

  it('decodes the pipe-delimited, timestamp-prefixed line the tolerant reader had to handle', () => {
    // That line is the Heartbeat (34=4); if it decoded, its seqnum is 4.
    assert.equal(byType('0').fields.seqnum, '4');
  });

  it('publishes one event per message and nothing it did not', async () => {
    const recs = await recent(hub.url, { topic: TOPIC });
    assert.equal(recs.length, MESSAGES.length,
      recs.map((r) => `${r.event.level} ${r.event.msg}`).join('\n'));
  });
});
