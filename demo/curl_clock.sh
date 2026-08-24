#!/bin/sh
#
# curl_clock.sh - the clock demo as HTTP/HTTPS traffic
#
# Copyright 2026 Saxon Herschel Nicholls
# SPDX-License-Identifier: MIT
#
# Once a second, curl asks a server for the time - once over plain http to
# a tiny local origin, once over https to a public one - through the
# logging proxy (tailers/bin/superlog-net.mjs), so every call shows up on
# the bench as a net.* event: method, path, status, latency, bytes.
#
# It is the same "one tick a second" story as the other demo clients, but
# the thing being logged is the *call*, which is what you actually want
# when a request is misbehaving. The https leg proves the proxy handles TLS
# targets without any certificate work: the client->proxy hop is plain http
# on loopback and this process re-dials the target itself.
#
#   ./demo/curl_clock.sh                  # metadata only
#   SUPER_LOG_BODIES=1 ./demo/curl_clock.sh   # capture bodies too
#
# Ctrl-C stops the clocks, the proxies, and the origin together.
#
set -eu
cd "$(dirname "$0")/.."

HUB="${SUPER_LOG_URL:-http://127.0.0.1:7333}"
HTTP_PROXY_PORT="${SUPER_LOG_HTTP_PORT:-9080}"
HTTPS_PROXY_PORT="${SUPER_LOG_HTTPS_PORT:-9081}"
ORIGIN_PORT="${SUPER_LOG_ORIGIN_PORT:-9079}"
# A real TLS target, not a mock of one: cdn-cgi/trace is unauthenticated,
# fast from everywhere, and its body carries the server's own `ts=` - so
# the https leg is genuinely a clock too. (worldtimeapi.org was the first
# choice and was down; when a target dies the proxy says so - ERROR rows
# reading "upstream error: read ECONNRESET" - which is the tool working.)
HTTPS_TARGET="${SUPER_LOG_HTTPS_TARGET:-https://cloudflare.com}"
HTTPS_PATH="${SUPER_LOG_HTTPS_PATH:-/cdn-cgi/trace}"
BODIES=""
[ -n "${SUPER_LOG_BODIES:-}" ] && BODIES="--bodies"

pids=""
cleanup() {
    trap - EXIT INT TERM
    [ -n "$pids" ] && kill $pids 2>/dev/null || true
    wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# A local origin that answers with the time - the http leg's target. Node
# because it is already a dependency of the demo, and 15 lines beats a
# dependency on whatever else is installed.
PORT="$ORIGIN_PORT" node -e '
const http = require("http");
http.createServer((req, res) => {
  const now = new Date().toISOString();
  if (req.url === "/slow") return setTimeout(() => { res.writeHead(200, {"content-type":"application/json"}); res.end(JSON.stringify({now, slow:true})); }, 400);
  if (req.url === "/boom") { res.writeHead(500, {"content-type":"application/json"}); return res.end(JSON.stringify({error:"the clock exploded"})); }
  res.writeHead(200, {"content-type":"application/json"});
  res.end(JSON.stringify({now, path:req.url}));
}).listen(Number(process.env.PORT), "127.0.0.1");
' >/dev/null 2>&1 &
pids="$pids $!"

sleep 1

# Two proxies: one per target, so the topics read net.<host>.<target>
node tailers/bin/superlog-net.mjs "$HTTP_PROXY_PORT" "http://127.0.0.1:${ORIGIN_PORT}" \
    --url "$HUB" --topic "net.curl.http" $BODIES &
pids="$pids $!"
node tailers/bin/superlog-net.mjs "$HTTPS_PROXY_PORT" "$HTTPS_TARGET" \
    --url "$HUB" --topic "net.curl.https" $BODIES &
pids="$pids $!"

sleep 1
cat <<EOF
curl clock running - every call is on the bench:

  net.curl.http    curl -> http://127.0.0.1:${HTTP_PROXY_PORT}  -> http://127.0.0.1:${ORIGIN_PORT}
  net.curl.https   curl -> http://127.0.0.1:${HTTPS_PROXY_PORT}  -> ${HTTPS_TARGET}

Every 4th tick asks for /boom (a 500) and /slow (400ms), so the viewer has
errors and latency to colour, not just a wall of 200s.
EOF

n=0
while :; do
    n=$((n + 1))
    # The http leg: mostly the plain clock, every 4th an error, every 6th slow
    path="/time"
    [ $((n % 4)) -eq 0 ] && path="/boom"
    [ $((n % 6)) -eq 0 ] && path="/slow"
    curl -s -o /dev/null "http://127.0.0.1:${HTTP_PROXY_PORT}${path}" || true
    # and a POST, so request bodies appear when --bodies is on
    curl -s -o /dev/null -X POST -H 'content-type: application/json' \
        -d "{\"tick\":${n}}" "http://127.0.0.1:${HTTP_PROXY_PORT}/tick" || true
    # The https leg, through the proxy - TLS terminated by the proxy, no certs here
    curl -s -o /dev/null "http://127.0.0.1:${HTTPS_PROXY_PORT}${HTTPS_PATH}" || true
    sleep 1
done
