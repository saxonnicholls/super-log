//
//  env.mjs - read .env without a dependency.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  Enough dotenv for this repo's needs: KEY=value, # comments, optional
//  quotes, and `export ` prefixes so a file can double as a shell source.
//  Real environment variables always win, because that is what makes a
//  container or a CI job able to override a file it cannot edit.
//

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Walk up from here to find the repo's .env - the tailers are run from
 *  wherever the operator happens to be standing. */
function findEnvFile(explicit) {
  if (explicit) return existsSync(explicit) ? explicit : null;
  if (process.env.SUPER_LOG_ENV && existsSync(process.env.SUPER_LOG_ENV))
    return process.env.SUPER_LOG_ENV;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const p = join(dir, '.env');
    if (existsSync(p)) return p;
    dir = resolve(dir, '..');
  }
  const cwd = join(process.cwd(), '.env');
  return existsSync(cwd) ? cwd : null;
}

export function loadEnv(explicit) {
  const path = findEnvFile(explicit);
  const out = {};
  if (path) {
    for (const raw of readFileSync(path, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const m = line.replace(/^export\s+/, '').match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
        v = v.slice(1, -1);
      if (v) out[m[1]] = v;
    }
  }
  // The process environment wins: a file is a default, not an override.
  return { ...out, ...process.env, __envFile: path ?? undefined };
}

// A path segment that looks like a credential: long, and mixed letters+digits
// (a real provider key is high-entropy), but not a readable slug or a plain id.
// Infura/Alchemy/QuickNode all put the key in the path, not a query param.
const looksSecret = (s) =>
  s.length >= 16 && /[A-Za-z]/.test(s) && /\d/.test(s) && /^[\w-]+$/.test(s);

/** Never print a URL with a provider key in it. Logs get shared, pasted and
 *  screenshotted, and an RPC key is spendable. Strips user:pass@, blanks every
 *  query value, drops the fragment, and redacts key-shaped path segments in any
 *  position. Handles a relative URL (a path with no scheme) too. */
export function redactUrl(u) {
  if (!u) return '';
  try {
    const relative = !/^[a-z][a-z0-9+.-]*:/i.test(u);
    const url = new URL(u, relative ? 'http://_redacted_base_' : undefined);
    if (url.username || url.password) { url.username = ''; url.password = ''; }
    url.pathname = url.pathname.split('/').map((s) => looksSecret(s) ? '<key>' : s).join('/');
    for (const k of [...url.searchParams.keys()]) url.searchParams.set(k, '<redacted>');
    if (url.hash) url.hash = '';
    let out = url.toString();
    if (relative) out = out.replace(/^http:\/\/_redacted_base_/, '');
    return out.slice(0, 512);
  } catch {
    return '<unparseable url>';
  }
}
