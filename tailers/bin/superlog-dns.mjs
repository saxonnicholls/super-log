#!/usr/bin/env node
//
//  superlog-dns - watch DNS records and TLS certificates for change.
//
//  Copyright 2026 Saxon Herschel Nicholls
//
//  DNS is the failure nobody sees coming. A record changes and half your
//  users reach the old box; an NS or CAA change you did not make is a
//  hijack in progress; an SPF or DKIM edit silently stops your mail being
//  delivered, and nothing anywhere logs an error. Certificates are the
//  same shape: an expiry is a scheduled outage that only announces itself
//  by going off.
//
//    superlog-dns --domains example.com,mail.example.com
//    superlog-dns --domains example.com --interval 300 --tls-warn 21
//
//  Publishes to dns.<domain>. It reports CHANGES, not readings: the first
//  poll establishes a baseline silently, because a watcher that announces
//  everything it sees teaches you to ignore it. Levels follow meaning -
//  an NS or CAA change is WARN because you probably did not do it, an A
//  record moving is INFO because you probably did, and a lookup that stops
//  working at all is ERROR.
//
//  Zero dependency: node:dns and node:tls are enough.
//
//  Node >= 18.
//

import { Resolver } from 'node:dns/promises';
import { connect } from 'node:tls';
import { loadEnv } from './env.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
if (args.includes('--help') || args.includes('-h')) {
  console.error(`superlog-dns - DNS records and TLS expiry, watched for change

  superlog-dns [--domains a.com,b.com] [--interval SECONDS] [--url HUB]
               [--resolver 1.1.1.1] [--tls-warn DAYS] [--no-tls]

Reads .env: SUPER_LOG_DOMAINS, SUPER_LOG_DNS_INTERVAL, SUPER_LOG_URL.
Publishes to dns.<domain>. First poll is a silent baseline; after that only
changes are reported.`);
  process.exit(0);
}

const env = loadEnv();
const hubUrl = opt('url', env.SUPER_LOG_URL ?? 'http://127.0.0.1:7333');
const intervalMs = Number(opt('interval', env.SUPER_LOG_DNS_INTERVAL ?? '300')) * 1000;
const tlsWarnDays = Number(opt('tls-warn', '21'));
const checkTls = !args.includes('--no-tls');

// Bare arguments are domains too, so `superlog-dns example.com` works the
// way anyone would expect before reading any help.
const bare = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const once = args.includes('--once');
const domains = [
  ...(opt('domains', env.SUPER_LOG_DOMAINS ?? '') || '').split(','),
  ...bare,
].map((s) => s.trim().toLowerCase()).filter(Boolean);

if (!domains.length) {
  console.error('superlog-dns: no domains. Set SUPER_LOG_DOMAINS in .env or pass --domains.');
  process.exit(2);
}

// A specific resolver by choice: asking the same public resolver every time
// makes a change mean "the record changed", not "my laptop switched
// networks and got a different cache".
const resolver = new Resolver({ timeout: 5000, tries: 2 });
const resolverIp = opt('resolver', env.SUPER_LOG_DNS_RESOLVER ?? '1.1.1.1');
if (resolverIp) resolver.setServers([resolverIp]);

// ------------------------------------------------------------- publishing

const session = Math.random().toString(16).slice(2, 10);
const buffers = new Map();
let seq = 0;
let posted = 0, failed = 0;

function publish(domain, level, msg, fields) {
  const topic = `dns.${domain.replace(/[^a-z0-9._-]/g, '-')}`;
  const ev = {
    v: 1, ts: new Date().toISOString(), seq: seq++, session, level,
    origin: { runtime: 'node', app: 'dns-watcher', platform: 'net' },
    tag: 'dns', msg, fields,
  };
  let b = buffers.get(topic);
  if (!b) buffers.set(topic, (b = []));
  b.push(JSON.stringify(ev));
}

async function flushAll() {
  await Promise.all([...buffers.keys()].map(async (t) => {
    const lines = buffers.get(t);
    if (!lines?.length) return;
    buffers.set(t, []);
    try {
      await fetch(`${hubUrl}/ingest/${t}`, {
        method: 'POST', headers: { 'content-type': 'application/x-ndjson' },
        body: lines.join('\n'),
      });
      posted++;
    } catch {
      failed++;
    }
  }));
}

// ------------------------------------------------------------- the records
//
// Each record type carries a different meaning when it changes, so each has
// its own level rather than one blanket severity. NS and CAA are the two
// that say "someone may be taking your domain": NS moves control of the
// zone, CAA moves who is allowed to issue certificates for it.

const RECORDS = [
  { type: 'A',    level: 'INFO', get: (d) => resolver.resolve4(d) },
  { type: 'AAAA', level: 'INFO', get: (d) => resolver.resolve6(d) },
  { type: 'NS',   level: 'WARN', get: (d) => resolver.resolveNs(d) },
  { type: 'MX',   level: 'WARN', get: (d) => resolver.resolveMx(d).then((r) => r.map((m) => `${m.priority} ${m.exchange}`)) },
  { type: 'TXT',  level: 'WARN', get: (d) => resolver.resolveTxt(d).then((r) => r.map((t) => t.join(''))) },
  { type: 'CAA',  level: 'WARN', get: (d) => resolver.resolveCaa(d).then((r) => r.map((c) => JSON.stringify(c))) },
];

const previous = new Map();                    // "domain|TYPE" -> sorted values

/** A TXT record is where SPF, DKIM and DMARC live, and those breaking is
 *  the quiet mail outage - so name them when they move. */
function txtKind(v) {
  if (/^v=spf1/i.test(v)) return 'SPF';
  if (/^v=DMARC1/i.test(v)) return 'DMARC';
  if (/^v=DKIM1/i.test(v)) return 'DKIM';
  if (/^google-site-verification|^MS=|_domainkey/i.test(v)) return 'verification';
  return null;
}

async function checkRecords(domain, first) {
  for (const rec of RECORDS) {
    const key = `${domain}|${rec.type}`;
    let values;
    try {
      values = (await rec.get(domain)).map(String).sort();
    } catch (e) {
      // NODATA is normal - plenty of domains have no AAAA or CAA - and
      // reporting it as a failure every interval would be noise. A lookup
      // that USED to work and now does not is the real signal.
      const code = e?.code ?? '';
      if (previous.has(key) && code !== 'ENODATA' && code !== 'ENOTFOUND') {
        publish(domain, 'ERROR', `${rec.type} lookup failed: ${code || e.message}`,
                { domain, record: rec.type, error: code || String(e.message) });
        previous.delete(key);
      } else if (!previous.has(key)) {
        previous.set(key, []);                 // baseline: it has none
      }
      continue;
    }

    const before = previous.get(key);
    previous.set(key, values);

    // --once is the inventory question - "what does this domain look like
    // right now" - rather than the watch question. Publish everything found
    // and say nothing about change, because there is no before.
    if (once) {
      if (values.length)
        publish(domain, 'INFO', `${rec.type}: ${values.join(', ')}`,
                { domain, record: rec.type, values: values.join(', '), count: String(values.length) });
      continue;
    }

    if (first || before === undefined) continue;   // silent baseline
    if (before.join('|') === values.join('|')) continue;

    const added = values.filter((v) => !before.includes(v));
    const removed = before.filter((v) => !values.includes(v));
    const fields = {
      domain, record: rec.type,
      before: before.join(', ') || '(none)',
      after: values.join(', ') || '(none)',
    };
    if (added.length) fields.added = added.join(', ');
    if (removed.length) fields.removed = removed.join(', ');

    // Losing every record of a type that had some is worse than a change.
    const gone = values.length === 0 && before.length > 0;
    let level = gone ? 'ERROR' : rec.level;
    let what = `${rec.type} changed`;
    if (rec.type === 'TXT') {
      const kinds = [...new Set([...added, ...removed].map(txtKind).filter(Boolean))];
      if (kinds.length) what = `${kinds.join('/')} record changed`;
    }
    if (gone) what = `${rec.type} records disappeared`;
    publish(domain, level, `${what}: ${fields.before} -> ${fields.after}`, fields);
  }
}

// --------------------------------------------------------------- the cert
//
// Expiry is a scheduled outage. It is worth knowing weeks ahead, and worth
// escalating as the date approaches rather than shouting from day one.

function peerCert(host, port = 443) {
  return new Promise((resolve, reject) => {
    const socket = connect(
      { host, port, servername: host, timeout: 8000, rejectUnauthorized: false },
      () => {
        const cert = socket.getPeerCertificate();
        const authorized = socket.authorized;
        const err = socket.authorizationError;
        socket.end();
        resolve({ cert, authorized, authorizationError: err ? String(err) : undefined });
      },
    );
    socket.on('timeout', () => { socket.destroy(); reject(new Error('timeout')); });
    socket.on('error', reject);
  });
}

const certState = new Map();

async function checkTlsFor(domain, first) {
  let info;
  try {
    info = await peerCert(domain);
  } catch (e) {
    if (certState.has(domain))                 // it used to answer
      publish(domain, 'ERROR', `TLS connect failed: ${e.message}`, { domain, error: String(e.message) });
    certState.set(domain, { failed: true });
    return;
  }
  const { cert, authorized, authorizationError } = info;
  if (!cert?.valid_to) return;
  const expires = Date.parse(cert.valid_to);
  const days = Math.floor((expires - Date.now()) / 86400000);
  const fingerprint = cert.fingerprint256 ?? cert.fingerprint ?? '';
  const before = certState.get(domain);
  certState.set(domain, { fingerprint, days, failed: false });

  const fields = {
    domain, expires: new Date(expires).toISOString().slice(0, 10),
    days_left: String(days), issuer: cert.issuer?.O ?? cert.issuer?.CN ?? '',
    subject: cert.subject?.CN ?? '', fingerprint: fingerprint.slice(0, 32),
    valid: authorized ? 'yes' : 'no',
  };
  if (authorizationError) fields.error = authorizationError;

  // A certificate you did not replace, replacing itself, is worth a line -
  // it is either your renewal working or someone else's cert in front of
  // your name.
  if (before && !before.failed && before.fingerprint && before.fingerprint !== fingerprint)
    publish(domain, 'INFO', `TLS certificate replaced (now expires in ${days}d)`, fields);

  if (!authorized)
    publish(domain, 'ERROR', `TLS certificate not valid: ${authorizationError}`, fields);
  else if (days < 0)
    publish(domain, 'CRITICAL', `TLS certificate EXPIRED ${-days}d ago`, fields);
  else if (days <= 7)
    publish(domain, 'ERROR', `TLS certificate expires in ${days}d`, fields);
  else if (days <= tlsWarnDays)
    publish(domain, 'WARN', `TLS certificate expires in ${days}d`, fields);
  else if (first)
    publish(domain, 'INFO', `watching ${domain} - certificate valid ${days}d, ` +
            `${RECORDS.length} record types`, fields);
}

// ------------------------------------------------------------------ loop

console.error(`superlog-dns: ${domains.length} domain(s) every ${intervalMs / 1000}s ` +
              `via ${resolverIp} -> ${hubUrl}`);

let first = true;
for (;;) {
  for (const d of domains) {
    await checkRecords(d, first);
    if (checkTls) await checkTlsFor(d, first);
  }
  await flushAll();
  if (once) {
    console.error(`superlog-dns: inventory published for ${domains.join(', ')}`);
    break;
  }
  if (first) {
    console.error(`superlog-dns: baseline taken for ${domains.join(', ')}; ` +
                  `reporting changes from here`);
    first = false;
  }
  await new Promise((r) => setTimeout(r, intervalMs));
}
