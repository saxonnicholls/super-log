//
//  env.mjs - read .env without a dependency.
//
//  Copyright 2026 Saxon Herschel Nicholls
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

/** Never print a URL with a provider key in it. Logs get shared, pasted and
 *  screenshotted, and an RPC key is spendable. */
export function redactUrl(u) {
  if (!u) return '';
  try {
    const url = new URL(u);
    const parts = url.pathname.split('/').filter(Boolean);
    // Providers put the key in the last path segment (alchemy, quicknode)
    // or in a query param (infura-style).
    if (parts.length) parts[parts.length - 1] = '<key>';
    url.pathname = '/' + parts.join('/');
    for (const k of [...url.searchParams.keys()]) url.searchParams.set(k, '<redacted>');
    return url.toString();
  } catch {
    return '<unparseable url>';
  }
}
