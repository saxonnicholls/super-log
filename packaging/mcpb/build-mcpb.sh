#!/bin/sh
#
# build-mcpb.sh - build the super-log Claude Desktop extension (.mcpb).
#
# Copyright 2026 Saxon Herschel Nicholls
# SPDX-License-Identifier: MIT
#
# An MCPB bundle is a ZIP: a manifest.json plus the server it runs. super-log's
# MCP server is zero-dependency, so we bundle it whole (bin + guide.json +
# package.json) and run it with node - no npx, no network fetch at install or
# run time. The bin resolves ../guide.json and ../package.json from its own
# directory, so it lives at server/bin/ with those two beside it at server/.
#
#   sh packaging/mcpb/build-mcpb.sh
#
# Produces packaging/mcpb/super-log-<version>.mcpb - attach it to the GitHub
# release; users double-click it into Claude Desktop (Settings -> Connectors).
#
set -eu
cd "$(dirname "$0")/../.."
REPO="$(pwd)"
MCP="$REPO/sdk/js/packages/mcp"
VERSION="$(node -p "require('$MCP/package.json').version")"

command -v zip >/dev/null || { echo "build-mcpb: zip is required" >&2; exit 1; }

STG="$(mktemp -d)"; trap 'rm -rf "$STG"' EXIT
mkdir -p "$STG/server/bin"
# The whole published server: bin/, guide.json, package.json (see files[] in
# the package). guide.json/package.json sit at server/ so bin/../ finds them.
cp -R "$MCP/bin/." "$STG/server/bin/"
cp "$MCP/guide.json" "$STG/server/guide.json"
cp "$MCP/package.json" "$STG/server/package.json"
# The manifest is a template; stamp the version from the package.
sed "s/@VERSION@/$VERSION/g" "$REPO/packaging/mcpb/manifest.json" > "$STG/manifest.json"
# A logo, if one is present (Claude Desktop shows it in the extension card).
[ -f "$REPO/packaging/mcpb/icon.png" ] && cp "$REPO/packaging/mcpb/icon.png" "$STG/icon.png"

node -e "JSON.parse(require('fs').readFileSync('$STG/manifest.json','utf8'))" \
  || { echo "build-mcpb: manifest.json is not valid JSON after substitution" >&2; exit 1; }

OUT="$REPO/packaging/mcpb/super-log-${VERSION}.mcpb"
rm -f "$OUT"
( cd "$STG" && zip -qr "$OUT" . )
echo "build-mcpb: wrote $OUT"
unzip -l "$OUT"
