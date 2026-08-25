#!/bin/sh
#
# setup.sh - put super-log into a project without putting super-log IN it.
#
# Copyright 2026 Saxon Herschel Nicholls
# SPDX-License-Identifier: MIT
#
#   ./scripts/setup.sh ~/code/my-app
#
# Writes two small files into the project and nothing else:
#
#   logging.sh      a launcher, ~250 lines of POSIX sh, self-contained
#   superlog.conf   what this project logs - the only file you edit
#
# Why this rather than a package dependency. super-log is one clone shared by
# every project on the machine, the way you would install a debugger: the hub
# is a machine-wide service, not a per-project library, and running one per
# project would be several hubs competing for a port and several viewers
# showing you a third of the picture each. Adding it as a dependency is also
# genuinely expensive here - a Cargo git dependency on this repo clones all
# five submodules and 36MB of C++ the Rust crate never touches.
#
# So the project gets a launcher that knows where the clone is, and the clone
# gets updated once for everybody.
#
set -u

SELF_DIR=$(cd "$(dirname "$0")/.." && pwd)
PROJECT="${1:-}"

if [ -z "$PROJECT" ] || [ "$PROJECT" = "-h" ] || [ "$PROJECT" = "--help" ]; then
    cat >&2 <<EOF
setup.sh - add super-log to a project

  $0 <path/to/project> [--force] [--wire]

  --force   overwrite an existing logging.sh / superlog.conf
  --wire    also add npm scripts (log, log:stop, log:status) when the
            project has a package.json

Writes logging.sh and superlog.conf into the project. Edit superlog.conf to
say what to log, then run ./logging.sh start.
EOF
    exit 2
fi

FORCE=0
WIRE=0
for a in "$@"; do
    [ "$a" = "--force" ] && FORCE=1
    [ "$a" = "--wire" ] && WIRE=1
done

if [ ! -d "$PROJECT" ]; then
    echo "setup.sh: $PROJECT is not a directory" >&2
    exit 1
fi
PROJECT=$(cd "$PROJECT" && pwd)

if [ "$PROJECT" = "$SELF_DIR" ]; then
    echo "setup.sh: that is super-log itself - point this at a project that USES it" >&2
    exit 1
fi

# ---- work out what this project is, so the config arrives pre-filled ----
#
# Guessing wrong is cheap (the dev edits one line); making them start from a
# blank file is not, because then they have to read the docs first.

NAME=$(basename "$PROJECT" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9._-' '-' | sed 's/-*$//')
KIND="generic"
BUILD_HINT="make"
RUN_HINT="./run.sh"
WATCH="src"

if [ -f "$PROJECT/package.json" ]; then
    KIND="node"; BUILD_HINT="npm run build"; RUN_HINT="npm start"; WATCH="src"
elif [ -f "$PROJECT/Cargo.toml" ]; then
    KIND="rust"; BUILD_HINT="cargo build"; RUN_HINT="cargo run"; WATCH="src"
elif [ -f "$PROJECT/CMakeLists.txt" ]; then
    KIND="cpp"; BUILD_HINT="cmake --build build -j"; RUN_HINT="./build/app"; WATCH="src include"
elif [ -f "$PROJECT/go.mod" ]; then
    KIND="go"; BUILD_HINT="go build ./..."; RUN_HINT="go run ."; WATCH="."
elif [ -f "$PROJECT/pyproject.toml" ] || [ -f "$PROJECT/requirements.txt" ]; then
    KIND="python"; BUILD_HINT="python -m compileall ."; RUN_HINT="python main.py"; WATCH="."
elif [ -f "$PROJECT/pom.xml" ] || [ -f "$PROJECT/build.gradle" ]; then
    KIND="java"; BUILD_HINT="./gradlew build"; RUN_HINT="./gradlew run"; WATCH="src"
elif [ -f "$PROJECT/Package.swift" ]; then
    KIND="swift"; BUILD_HINT="swift build"; RUN_HINT="swift run"; WATCH="Sources"
fi

IS_GIT=0
[ -d "$PROJECT/.git" ] && IS_GIT=1

# ---- write superlog.conf ------------------------------------------------

CONF="$PROJECT/superlog.conf"
if [ -f "$CONF" ] && [ "$FORCE" -eq 0 ]; then
    echo "setup.sh: $CONF exists - keeping it (use --force to replace)"
else
    cat > "$CONF" <<EOF
# What this project puts on the bench.
#
# Read, not sourced - only the keys below are understood, and a value is
# everything after the first '=' with no shell expansion. Edit freely.
#
# Start it all with:  ./logging.sh start
# Stop what it started: ./logging.sh stop

# Topic namespace for this project. Streams appear as <prefix>.<something>,
# so several projects can share one hub and stay separable in the viewer.
TOPIC_PREFIX=$NAME

# The hub. One per machine, shared by every project - logging.sh starts it
# only if nothing is answering on this port already.
PORT=7333

# Open a viewer when starting, if one is not already up. Set to 0 if you
# keep a viewer open yourself.
VIEWER=1

# Watch the working tree for changes -> fs.<host>.<dir>. Space-separated,
# relative to the project. Empty disables.
WATCH_DIRS=$WATCH

# Watch this repository -> git.<host>.<repo>: commits, branch switches,
# rewritten history, conflicts. 1 or 0.
GIT=$IS_GIT

# Log files this project writes -> app.<host>.<name>. Space-separated paths.
LOG_FILES=

# Well-known services this project depends on -> app.<host>.<service>.
# Try: $SELF_DIR/tailers/bin/superlog-tail.mjs apps
APPS=

# This machine's OS log alongside the app streams. 1 or 0 - useful when the
# thing you are debugging involves the OS (ports, permissions, crashes).
OS_LOG=0

# The commands ./logging.sh build and ./logging.sh run wrap by default.
BUILD_CMD=$BUILD_HINT
RUN_CMD=$RUN_HINT
EOF
    echo "  wrote $CONF"
fi

# ---- write logging.sh ---------------------------------------------------

LAUNCHER="$PROJECT/logging.sh"
if [ -f "$LAUNCHER" ] && [ "$FORCE" -eq 0 ]; then
    echo "setup.sh: $LAUNCHER exists - keeping it (use --force to replace)"
else
    # SUPERLOG_HOME is baked in at setup time rather than discovered at run
    # time: the alternative is every project guessing where the clone lives,
    # and guessing wrong quietly. The environment still wins if it is set.
    sed "s|@SUPERLOG_HOME@|$SELF_DIR|g" "$SELF_DIR/scripts/logging.sh.in" > "$LAUNCHER"
    chmod +x "$LAUNCHER"
    echo "  wrote $LAUNCHER"
fi

# ---- keep the project's repo clean --------------------------------------

if [ "$IS_GIT" -eq 1 ]; then
    GI="$PROJECT/.gitignore"
    if ! grep -qs '^\.superlog/' "$GI" 2>/dev/null; then
        {
            echo ""
            echo "# super-log: pids and logs of what logging.sh started"
            echo ".superlog/"
        } >> "$GI"
        echo "  added .superlog/ to $GI"
    fi
fi

# ---- optional npm wiring ------------------------------------------------

if [ "$WIRE" -eq 1 ] && [ -f "$PROJECT/package.json" ]; then
    if command -v node >/dev/null 2>&1; then
        node -e '
const fs = require("fs");
const p = process.argv[1] + "/package.json";
const d = JSON.parse(fs.readFileSync(p, "utf8"));
d.scripts ??= {};
let added = [];
for (const [k, v] of [["log", "./logging.sh start"],
                      ["log:stop", "./logging.sh stop"],
                      ["log:status", "./logging.sh status"]]) {
  if (!d.scripts[k]) { d.scripts[k] = v; added.push(k); }
}
fs.writeFileSync(p, JSON.stringify(d, null, 2) + "\n");
console.log(added.length ? "  added npm scripts: " + added.join(", ")
                         : "  npm scripts already present");
' "$PROJECT"
    else
        echo "  --wire needs node; skipped"
    fi
fi

# ---- what to do next ----------------------------------------------------

cat <<EOF

super-log is set up for $NAME ($KIND).

  cd $PROJECT
  \$EDITOR superlog.conf        # say what to log
  ./logging.sh start           # hub + viewer + this project's streams

To put your build and run on the bench too - compiler diagnostics as events,
and everything the program prints:

  ./logging.sh build           # wraps: $BUILD_HINT
  ./logging.sh run             # wraps: $RUN_HINT

Both start the logging first if it is not already up, so wiring them into
whatever you already type is enough:

  alias b='./logging.sh build'
EOF
[ "$KIND" = "node" ] && [ "$WIRE" -eq 0 ] && \
    echo "  (or re-run with --wire to add npm run log / log:stop / log:status)"
echo
