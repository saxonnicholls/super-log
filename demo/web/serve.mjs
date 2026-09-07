//
//  serve.mjs - static server for the browser demo
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  Zero dependencies because the whole job is handing three files to a
//  browser: the page, its module, and the built @super-log/client (which
//  compiles to one dependency-free ESM file - that is why this works).
//  Loopback by default; SUPER_LOG_WEB_BIND=0.0.0.0 lets phones and other
//  machines on the LAN open the page (the demo's SUPER_LOG_LAN=1 does
//  both this and the hub). Port 7335 (SUPER_LOG_WEB_PORT overrides).
//

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const FILES = {
  '/': ['index.html', 'text/html'],
  '/index.html': ['index.html', 'text/html'],
  '/clock.mjs': ['clock.mjs', 'text/javascript'],
  '/client.js': [
    join('..', '..', 'sdk', 'js', 'packages', 'client', 'dist', 'index.js'),
    'text/javascript',
  ],
};

const port = Number(process.env.SUPER_LOG_WEB_PORT ?? 7335);
const bind = process.env.SUPER_LOG_WEB_BIND ?? '127.0.0.1';

createServer(async (req, res) => {
  const hit = FILES[(req.url ?? '').split('?')[0]];
  if (!hit) {
    res.writeHead(404).end('not found');
    return;
  }
  try {
    // no-store: this server hands out the page and the built client, and a
    // browser holding an old copy of either is a debugging session spent
    // on a bug that was already fixed.
    res
      .writeHead(200, { 'content-type': hit[1], 'cache-control': 'no-store, must-revalidate' })
      .end(await readFile(join(root, hit[0])));
  } catch (e) {
    res.writeHead(500).end(String(e)); // most likely: client dist not built yet
  }
}).listen(port, bind, () =>
  console.error(`superlog web demo: http://localhost:${port} -> topic web.clock (bind ${bind})`),
);
