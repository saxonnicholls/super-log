// Copyright 2026 Saxon Herschel Nicholls
// SPDX-License-Identifier: MIT
//
// B3 regression: a logging product was shipping provider API keys into the hub.
// The SDK's redactUrl returned any URL with no `?` unchanged, so Infura/Alchemy
// path-segment keys sailed through; env.mjs re-emitted user:pass@ and ignored
// fragments and middle segments; superlog-net published the raw URL. This proves
// the shared redactor (env.mjs, which superlog-net now imports) strips every one,
// and - the control - leaves an innocent URL readable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactUrl } from '../tailers/bin/env.mjs';

const S = 'SECRETVALUE9aa3bcd120feed';   // a unique high-entropy token per case

const leaks = {
  'infura path key':        `https://mainnet.infura.io/v3/${S}`,
  'alchemy path key':       `https://eth-mainnet.g.alchemy.com/v2/${S}`,
  'basic-auth userinfo':    `https://apiuser:${S}@api.example.com/v1/orders`,
  'middle path segment':    `https://api.example.com/${S}/v1/chain/x`,
  'fragment token':         `https://app.example.com/x#access_token=${S}`,
  'query client_secret':    `https://api.example.com/x?client_secret=${S}`,
  'query X-Amz-Signature':  `https://s3.example.com/o?X-Amz-Signature=${S}`,
  'relative path key':      `/v3/${S}?token=${S}`,     // superlog-net passes a path
};

for (const [name, url] of Object.entries(leaks)) {
  test(`redacts: ${name}`, () => {
    const out = redactUrl(url);
    assert.ok(!out.includes(S), `secret leaked in redacted output: ${out}`);
  });
}

test('control: an innocent URL stays readable (path kept, query value blanked)', () => {
  const out = redactUrl('https://api.example.com/v1/orders?page=2&sort=desc');
  assert.match(out, /\/v1\/orders/, 'the useful path survives');
  assert.ok(!out.includes('desc') && !out.includes('page=2'),
    'query VALUES are blanked so a new secret param can never leak');
});

test('control: a genuinely short non-key last segment is not clobbered', () => {
  // The old redactor replaced the last segment ALWAYS; this must not.
  assert.match(redactUrl('https://api.example.com/health'), /\/health$/);
});
