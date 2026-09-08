// Windows CI mock hub. Accepts the ingest POSTs the SDKs and tailers send to
// 127.0.0.1:7333 and records one line per delivery, so the run can prove that
// the Winsock transport (C and C++) and the Node tailers actually deliver on
// Windows - not merely compile. Zero dependencies; exits on its own so a
// forgotten stop can't hang the runner.
import http from 'node:http';
import { appendFileSync } from 'node:fs';

const OUT = process.env.MOCK_HUB_OUT || 'received.txt';
const PORT = Number(process.env.MOCK_HUB_PORT || 7333);   // CI uses 7333 (the SDK default)

const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
        appendFileSync(OUT, `${req.method} ${req.url} bytes=${Buffer.byteLength(body)}\n`);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
    });
});

server.listen(PORT, '127.0.0.1', () => {
    process.stdout.write(`mock hub listening on 127.0.0.1:${PORT}\n`);
});

setTimeout(() => process.exit(0), 30000).unref?.();
