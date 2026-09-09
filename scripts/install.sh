#!/bin/sh
#
# install.sh - build super-log, verify it delivers, and keep it running.
#
# Copyright 2026 Saxon Herschel Nicholls
# SPDX-License-Identifier: MIT
#
# The one-command install for a bench of your own. It does four things, in
# order, and stops loudly at the first that fails rather than half-finishing:
#
#   1. PREFLIGHT - checks the toolchain (Node >= 18, cmake, a C++ compiler)
#      and, if anything is missing, prints the one line that installs it and
#      stops. It never installs a toolchain behind your back.
#   2. BUILD - npm ci, then the hub and (where a display stack exists) the
#      native viewer.
#   3. VERIFY - runs scripts/verify-sdks.sh: every SDK whose toolchain is
#      present actually delivers to a real hub. Green here is the whole
#      point; a bench that builds but delivers nothing is the exact failure
#      this project exists to prevent, so the install refuses to call itself
#      done without it.
#   4. PERSIST (--persist) - installs the hub, viewer and the default-on
#      tailers as login services (launchd on macOS, systemd --user on
#      Linux) so they start at login and survive a reboot. This is the
#      "who tails the tailers" answer: without it the bench dies with your
#      terminal, which is how sixteen commits once sat unpushed behind dead
#      tailers nobody noticed.
#
#   ./scripts/install.sh                 # build + verify
#   ./scripts/install.sh --persist       # ...and start at login, forever
#   ./scripts/install.sh --persist --lan # ...and bind the LAN so phones/other
#                                        #    hosts can log to it (no auth -
#                                        #    trust the network). Baked into
#                                        #    the login service so it sticks.
#   ./scripts/install.sh --uninstall     # remove the login services
#   ./scripts/install.sh --no-viewer     # headless: hub + tailers only
#
set -eu

cd "$(dirname "$0")/.."
REPO="$(pwd)"
OS="$(uname -s)"
PERSIST=0
UNINSTALL=0
WANT_VIEWER=1
# The persisted hub binds loopback unless asked otherwise. Devices on the LAN
# (a phone, a container, another host) cannot reach a loopback hub, and the
# drop is silent at both ends - so a persisted loopback hub is the reason
# handset logging "never worked". --lan (or exporting SUPER_LOG_LAN=1 /
# SUPER_LOG_BIND before install) bakes the binding INTO the login service, so
# KeepAlive relaunches keep it - which a one-off `export` before `up` cannot.
LAN="${SUPER_LOG_LAN:-0}"
BIND="${SUPER_LOG_BIND:-}"
for a in "$@"; do
    case "$a" in
        --persist) PERSIST=1 ;;
        --uninstall) UNINSTALL=1 ;;
        --no-viewer) WANT_VIEWER=0 ;;
        --lan) LAN=1 ;;
        -h|--help)
            sed -n '3,33p' "$0" | sed 's/^# \{0,1\}//'
            exit 0 ;;
        *) echo "install: unknown option $a" >&2; exit 2 ;;
    esac
done

say() { printf '\033[1;36m==>\033[0m %s\n' "$1"; }
die() { printf '\033[1;31minstall: %s\033[0m\n' "$1" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# The default-on tailers, matched to demo/run.sh: what a macOS bench watches
# about itself without being asked. Linux gets the platform-agnostic subset.
default_tailers_macos() {
    echo "power sys netstate usb otlp"
}
default_tailers_linux() {
    echo "netstate otlp"
}

# ---- the login services -----------------------------------------------
#
# Two writers, one shape: a label, a command, and "run at login, restart if
# it dies". launchd wants a plist; systemd --user wants a unit. Both are
# generated here from the same list so the two platforms cannot drift.

LAUNCH_DIR="$HOME/Library/LaunchAgents"
SYSTEMD_DIR="$HOME/.config/systemd/user"

svc_label() { echo "services.superlog.$1"; }

macos_agent() {
    label="$1"; shift
    plist="$LAUNCH_DIR/$label.plist"
    mkdir -p "$LAUNCH_DIR"
    {
        echo '<?xml version="1.0" encoding="UTF-8"?>'
        echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
        echo '<plist version="1.0"><dict>'
        echo "  <key>Label</key><string>$label</string>"
        echo '  <key>ProgramArguments</key><array>'
        for arg in "$@"; do printf '    <string>%s</string>\n' "$arg"; done
        echo '  </array>'
        # A KeepAlive agent relaunches with EXACTLY this environment and no
        # more, so anything the process needs at runtime must live here - an
        # `export` in the installing shell does not survive the relaunch.
        if [ -n "${SERVICE_ENV:-}" ]; then
            echo '  <key>EnvironmentVariables</key><dict>'
            for kv in $SERVICE_ENV; do
                printf '    <key>%s</key><string>%s</string>\n' "${kv%%=*}" "${kv#*=}"
            done
            echo '  </dict>'
        fi
        echo "  <key>WorkingDirectory</key><string>$REPO</string>"
        echo '  <key>RunAtLoad</key><true/>'
        echo '  <key>KeepAlive</key><true/>'
        echo "  <key>StandardOutPath</key><string>$REPO/logs/$label.log</string>"
        echo "  <key>StandardErrorPath</key><string>$REPO/logs/$label.log</string>"
        echo '</dict></plist>'
    } > "$plist"
    launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$plist" 2>/dev/null \
        || launchctl load "$plist" 2>/dev/null || true
}

linux_unit() {
    label="$1"; shift
    unit="$SYSTEMD_DIR/$label.service"
    mkdir -p "$SYSTEMD_DIR"
    {
        echo '[Unit]'
        echo "Description=super-log: $label"
        echo '[Service]'
        # Same reason as the launchd agent: Restart=always relaunches with the
        # unit's own environment, so a runtime need belongs in the unit.
        for kv in ${SERVICE_ENV:-}; do echo "Environment=$kv"; done
        printf 'ExecStart='
        for arg in "$@"; do printf '%s ' "$arg"; done
        echo
        echo "WorkingDirectory=$REPO"
        echo 'Restart=always'
        echo 'RestartSec=3'
        echo '[Install]'
        echo 'WantedBy=default.target'
    } > "$unit"
    systemctl --user daemon-reload 2>/dev/null || true
    systemctl --user enable --now "$label" 2>/dev/null || true
}

install_service() {  # label, command...
    if [ "$OS" = "Darwin" ]; then macos_agent "$@"; else linux_unit "$@"; fi
}
remove_service() {   # label
    label="$1"
    if [ "$OS" = "Darwin" ]; then
        launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
        rm -f "$LAUNCH_DIR/$label.plist"
    else
        systemctl --user disable --now "$label" 2>/dev/null || true
        rm -f "$SYSTEMD_DIR/$label.service"
    fi
}

host() { hostname -s 2>/dev/null || echo local; }

persist() {
    mkdir -p "$REPO/logs"
    NODE="$(command -v node)"
    # The hub carries its binding as service env, so a KeepAlive/Restart
    # relaunch keeps it. Only the hub - the tailers are loopback clients and
    # want no part of this.
    hub_env=""
    [ -n "$BIND" ] && hub_env="SUPER_LOG_BIND=$BIND"
    [ "$LAN" = "1" ] && [ -z "$BIND" ] && hub_env="SUPER_LOG_LAN=1"
    if [ -n "$hub_env" ]; then
        say "hub will bind for the LAN ($hub_env) - devices can reach it. No auth: trust the network."
    else
        say "hub will bind loopback only - re-run with --lan for phones/other hosts to reach it."
    fi
    SERVICE_ENV="$hub_env" install_service "$(svc_label hub)" "$REPO/build/hub/superlogd"
    for t in $( [ "$OS" = "Darwin" ] && default_tailers_macos || default_tailers_linux ); do
        SERVICE_ENV="" install_service "$(svc_label "$t")" "$NODE" "$REPO/tailers/bin/superlog-$t.mjs"
    done
    say "login services installed. They start now and at every login."
    say "Manage them: $( [ "$OS" = Darwin ] && echo 'launchctl list | grep superlog' || echo 'systemctl --user status services.superlog.*' )"
}

unpersist() {
    for t in power sys netstate usb otlp hub; do
        remove_service "$(svc_label "$t")"
    done
    say "login services removed."
}

# ------------------------------------------------------------------ main

if [ "$UNINSTALL" = 1 ]; then
    unpersist
    exit 0
fi

say "1/4  preflight"
MISSING=""
have node || MISSING="$MISSING node"
have cmake || MISSING="$MISSING cmake"
{ have cc || have gcc || have clang; } || MISSING="$MISSING a-C-compiler"
if [ -n "$MISSING" ]; then
    echo "install: missing:$MISSING" >&2
    if [ "$OS" = "Darwin" ]; then
        echo "  brew install node cmake   # and: xcode-select --install" >&2
    else
        echo "  sudo apt-get install -y nodejs cmake build-essential" >&2
    fi
    die "install the above, then re-run"
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "Node >= 18 required, found $(node -v)"
say "toolchain ok: node $(node -v), $(cmake --version | head -1)"

say "2/4  build"
npm ci
VIEWER_FLAG="-DSUPER_LOG_BUILD_IMGUI_VIEWER=OFF"
TARGETS="superlogd"
if [ "$WANT_VIEWER" = 1 ]; then
    VIEWER_FLAG=""
    TARGETS="superlogd superlog_viewer"
fi
# shellcheck disable=SC2086
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release $VIEWER_FLAG
# shellcheck disable=SC2086
cmake --build build --target $TARGETS -j
say "built: $TARGETS"

say "3/4  verify (every SDK actually delivers to a real hub)"
if ./scripts/verify-sdks.sh; then
    say "verified: the bench delivers."
else
    die "verify-sdks failed - the build is not trustworthy, not installing services"
fi

if [ "$PERSIST" = 1 ]; then
    say "4/4  persist"
    persist
else
    say "4/4  persist  (skipped - pass --persist to start at login)"
    say "Start it now by hand: ./scripts/dev.sh    (or npm run demo for the full bench)"
fi

say "done."
