#!/bin/sh
#
# install.sh - super-log's one URL, two jobs.
#
# Copyright 2026 Saxon Herschel Nicholls
# SPDX-License-Identifier: MIT
#
# This file answers to two different invocations, and tells them apart by
# where it is actually running from - not by a flag, because the whole
# point of the second one is that nothing has been cloned yet to pass a
# flag from:
#
#   A) FROM A CLONE - `cd super-log && ./scripts/install.sh [flags]`
#      The original local installer: preflight the toolchain, build the hub
#      (+ viewer) from source, run scripts/verify-sdks.sh as the acceptance
#      gate, optionally persist as login services. Every flag documented
#      below has worked this way since before this file grew a second job;
#      running it this way is UNCHANGED by anything added here.
#
#   B) CURL-PIPED - `curl -fsSL https://super-log.com/install.sh | sh`
#      No clone exists yet (there is nothing to `cd` into - $0 is "sh", not
#      a path in this repo). Detects OS + architecture, downloads the
#      matching prebuilt artefact from the latest GitHub release, VERIFIES
#      its checksum against the release's SHA256SUMS before running
#      anything, installs it with the platform's own package tool, and
#      prints what to do next. This is the Homebrew-Tier-3-Intel fallback
#      and the "no toolchain on this machine" on-ramp; it needs no clone.
#      A pipe-to-shell installer that does not verify what it downloaded is
#      malware waiting to happen - the checksum check is NOT optional, and
#      this refuses to install anything if SHA256SUMS is missing or does
#      not match, full stop.
#
# The detection: is $0 sitting inside an actual super-log clone (a
# CMakeLists.txt one directory up that really is this project's)? Then (A).
# Otherwise, (B) - which is exactly the curl-pipe case, since piped stdin
# has no meaningful $0 path at all.
#
#   ./scripts/install.sh                 # (A) build + verify
#   ./scripts/install.sh --persist       # (A) ...and start at login, forever
#   ./scripts/install.sh --persist --lan # (A) ...and bind the LAN so phones/other
#                                        #    hosts can log to it (no auth -
#                                        #    trust the network). Baked into
#                                        #    the login service so it sticks.
#   ./scripts/install.sh --uninstall     # (A) remove the login services
#   ./scripts/install.sh --no-viewer     # (A) headless: hub + tailers only
#   ./scripts/install.sh --vscode        # (A) ...and install the VS Code extension
#   curl -fsSL https://super-log.com/install.sh | sh              # (B) fetch + install
#   curl -fsSL https://super-log.com/install.sh | sh -s -- --uninstall  # (B) remove it
#
set -eu

say() { printf '\033[1;36m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33mwarn:\033[0m %s\n' "$1" >&2; }
die() { printf '\033[1;31minstall: %s\033[0m\n' "$1" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# ---- which of the two jobs is this? -------------------------------------
IN_CLONE=0
REPO=""
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd -P || true)"
if [ -n "$SCRIPT_DIR" ]; then
    CAND="$(cd "$SCRIPT_DIR/.." 2>/dev/null && pwd -P || true)"
    if [ -n "$CAND" ] && [ -f "$CAND/CMakeLists.txt" ] && grep -q 'project(super_log' "$CAND/CMakeLists.txt" 2>/dev/null; then
        IN_CLONE=1
        REPO="$CAND"
    fi
fi

# ===========================================================================
# (A) FROM A CLONE - build from source. Unchanged from the original file.
# ===========================================================================
run_source_install() {
cd "$REPO"
OS="$(uname -s)"
PERSIST=0
UNINSTALL=0
WANT_VIEWER=1
WANT_VSCODE=0
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
        --vscode) WANT_VSCODE=1 ;;
        --lan) LAN=1 ;;
        -h|--help)
            sed -n '/^#   A) FROM A CLONE/,/^set -eu/p' "$REPO/scripts/install.sh" | sed '$d; s/^# \{0,1\}//'
            exit 0 ;;
        *) echo "install: unknown option $a" >&2; exit 2 ;;
    esac
done

default_tailers_macos() { echo "power sys netstate usb otlp"; }
default_tailers_linux() { echo "netstate otlp"; }

# ---- the VS Code extension (opt-in, --vscode) -------------------------
#
# Install the PUBLISHED extension, rather than building one from source.
#
# This used to `cd "$REPO/editors/vscode"` and build a .vsix. That directory is
# in .gitignore, so it does not exist in any clone - the build only ever worked
# on the one laptop where an untracked copy happened to be sitting, and it was
# two versions behind what the Marketplace serves. Every stranger who passed
# --vscode got a silent non-fatal skip, which is the worst shape a failure can
# have: it looks like a decision.
#
# The extension has been published since 2026-09-22 and the marketplace copy is
# the artefact we actually maintain, so fetching it is both simpler and more
# correct than building one. Opt-in because it needs the `code` CLI on PATH.
# Non-fatal: a failure here never fails the bench install.
install_vscode_extension() {
    have code || {
        say "VS Code extension skipped: the 'code' CLI isn't on PATH."
        say "  In VS Code run 'Shell Command: Install code command in PATH', then re-run with --vscode."
        return 0
    }
    say "VS Code extension: installing super-log.super-log-vscode from the Marketplace"
    code --install-extension super-log.super-log-vscode --force || {
        say "VS Code extension install failed (non-fatal) - the bench is still installed."
        say "  Cursor, Windsurf, VSCodium and Theia read Open VSX instead:"
        say "  https://open-vsx.org/extension/super-log/super-log-vscode"
        return 0
    }
    say "VS Code extension installed - reload VS Code (fully quit, then reopen), then click the"
    say "  super-log pulse icon in the left Activity Bar. The repo also ships .vscode/mcp.json,"
    say "  so VS Code agent mode sees super-log's MCP server when you open the folder."
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
    # Optional backing store - persisted ONLY when .env configures one, because an
    # unconfigured store exits at once and a KeepAlive service would relaunch it in
    # a loop. It reads .env at runtime (WorkingDirectory is the repo), so no
    # credentials need live in the service; Postgres passwords stay in .env /
    # ~/.pgpass, never in a plist.
    if [ -n "${SUPER_LOG_STORE:-}" ] || grep -qE '^(export[[:space:]]+)?SUPER_LOG_STORE=' "$REPO/.env" 2>/dev/null; then
        SERVICE_ENV="" install_service "$(svc_label store)" "$NODE" "$REPO/tailers/bin/superlog-store.mjs"
        say "backing store persisted - it reads SUPER_LOG_STORE from .env at start."
    fi
    say "login services installed. They start now and at every login."
    say "Manage them: $( [ "$OS" = Darwin ] && echo 'launchctl list | grep superlog' || echo 'systemctl --user status services.superlog.*' )"
}

unpersist() {
    for t in power sys netstate usb otlp store hub; do
        remove_service "$(svc_label "$t")"
    done
    say "login services removed."
}

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

if [ "$WANT_VSCODE" = 1 ]; then
    say "editor  VS Code extension"
    install_vscode_extension
fi

if [ "$PERSIST" = 1 ]; then
    say "4/4  persist"
    persist
else
    say "4/4  persist  (skipped - pass --persist to start at login)"
    say "Start it now by hand: ./scripts/dev.sh    (or npm run demo for the full bench)"
fi

say "done."
}

# ===========================================================================
# (B) CURL-PIPED - fetch a prebuilt artefact, verify it, install it.
# ===========================================================================
run_fetch_install() {
GH_REPO="saxonnicholls/super-log"
UNINSTALL=0
for a in "$@"; do
    case "$a" in
        --uninstall) UNINSTALL=1 ;;
        -h|--help)
            echo "curl -fsSL https://super-log.com/install.sh | sh              # fetch + install"
            echo "curl -fsSL https://super-log.com/install.sh | sh -s -- --uninstall  # remove it"
            exit 0 ;;
        *) echo "install: unknown option $a (fetch mode takes only --uninstall)" >&2; exit 2 ;;
    esac
done

have curl || die "curl is required and was not found"
SUDO=""
[ "$(id -u)" = "0" ] || SUDO="sudo"

OS="$(uname -s)"
MACHINE="$(uname -m)"

# Which install mechanism this platform uses - a purely LOCAL decision (OS +
# which package manager is present), no network needed. Uninstalling never
# has to hit the GitHub API or find a matching asset - only installing does -
# so this is resolved before any of that, and --uninstall short-circuits
# right after it.
INSTALL_KIND=""
case "$OS" in
    Darwin) INSTALL_KIND=pkg ;;
    Linux)
        if have apt-get; then INSTALL_KIND=deb
        elif have dnf || have yum; then INSTALL_KIND=rpm
        else die "no apt-get or dnf/yum found - this fetch-install path covers Debian/Ubuntu and Fedora/RHEL family only. For anything else: git clone https://github.com/$GH_REPO && cd super-log && ./scripts/install.sh   (builds from source)"
        fi
        ;;
    *) die "unsupported OS: $OS. For anything else: git clone https://github.com/$GH_REPO && cd super-log && ./scripts/install.sh   (builds from source)" ;;
esac

if [ "$UNINSTALL" = 1 ]; then
    say "uninstalling super-log"
    case "$INSTALL_KIND" in
        pkg)
            $SUDO rm -f /usr/local/bin/superlog /usr/local/bin/superlogd /usr/local/bin/superlog-*
            $SUDO rm -rf /usr/local/superlog
            say "removed the files this installer wrote under /usr/local. (pkgutil keeps a receipt: pkgutil --forget com.super-log.bench)"
            ;;
        deb) $SUDO apt-get remove -y super-log ;;
        rpm) $SUDO dnf remove -y super-log 2>/dev/null || $SUDO yum remove -y super-log ;;
    esac
    exit 0
fi

say "super-log: fetching the latest release for $OS/$MACHINE"
# NOT /releases/latest. That endpoint excludes prereleases, and the
# installers ship under one BECAUSE GitHub releases here are immutable: a
# corrected build cannot replace an asset, so it needs a new tag, and the
# stable tag stays behind. On 2026-09-28 /releases/latest answered v0.4.0
# (2026-09-11), which carries no SHA256SUMS at all — so a curl-pipe install
# would have died at the checksum gate while the packages sat one tag away.
# Walk the list instead and take the newest release that carries BOTH a
# matching artefact and the checksums, which is the same rule the website's
# /download/<platform> function follows.
API="https://api.github.com/repos/$GH_REPO/releases?per_page=20"
RELEASES_JSON="$(curl -fsSL "$API")" || die "could not reach $API - check your network"

# One asset name per (OS, package manager, architecture). The .rpm's dist
# tag (fc41, ...) moves with the Fedora version pinned in the release
# workflow, so it is matched by pattern against the real asset list rather
# than hardcoded here - a hardcoded "fc41" would silently 404 the day that
# tag changes.
asset_url() {  # pattern
    printf '%s' "$RELEASE_JSON" | grep -o '"browser_download_url": *"[^"]*"' \
        | sed -E 's/.*"([^"]+)"$/\1/' | grep -E "$1" | head -1
}

# The pattern for THIS machine, decided once so the release loop below can
# ask each candidate the same question.
case "$INSTALL_KIND" in
    pkg) WANT_PATTERN='super-log-[0-9.]+-universal\.pkg$' ;;
    deb)
        case "$MACHINE" in
            x86_64|amd64)  WANT_PATTERN='super-log_[0-9.]+_amd64\.deb$' ;;
            aarch64|arm64) WANT_PATTERN='super-log_[0-9.]+_arm64\.deb$' ;;
            *) die "unsupported architecture for .deb: $MACHINE" ;;
        esac
        ;;
    rpm)
        case "$MACHINE" in
            x86_64)        WANT_PATTERN='super-log-[0-9.]+-[0-9]+\.[^.]*\.x86_64\.rpm$' ;;
            aarch64|arm64) WANT_PATTERN='super-log-[0-9.]+-[0-9]+\.[^.]*\.aarch64\.rpm$' ;;
            *) die "unsupported architecture for .rpm: $MACHINE" ;;
        esac
        ;;
esac

# Newest release first, and a release only counts if it carries BOTH the
# artefact for this machine and the checksums to verify it with. Accepting a
# release that has the package but no SHA256SUMS would mean either installing
# something unverified or dying one tag short of a release that would have
# worked - and both happened in practice before this loop existed.
TAG=""; ASSET_URL=""; SUMS_URL=""
for candidate in $(printf '%s' "$RELEASES_JSON" | grep -o '"tag_name": *"[^"]*"' \
                   | sed -E 's/.*"([^"]+)"$/\1/'); do
    RELEASE_JSON="$(curl -fsSL "https://api.github.com/repos/$GH_REPO/releases/tags/$candidate")" || continue
    try_asset="$(asset_url "$WANT_PATTERN")"
    try_sums="$(asset_url 'SHA256SUMS$')"
    if [ -n "$try_asset" ] && [ -n "$try_sums" ]; then
        TAG="$candidate"; ASSET_URL="$try_asset"; SUMS_URL="$try_sums"
        break
    fi
done

[ -n "$TAG" ] || die "no published release carries both a $OS/$MACHINE artefact and a SHA256SUMS to verify it against. Refusing to install anything unverified. See https://github.com/$GH_REPO/releases for what exists, or docs/INSTALL.md to build from source."
VERSION="${TAG#v}"
say "latest release with a verifiable $OS/$MACHINE build: $TAG"
ASSET_NAME="$(basename "$ASSET_URL")"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

say "downloading $ASSET_NAME"
curl -fsSL "$ASSET_URL" -o "$WORK/$ASSET_NAME" || die "download failed: $ASSET_URL"
curl -fsSL "$SUMS_URL" -o "$WORK/SHA256SUMS" || die "download failed: $SUMS_URL"

say "verifying checksum against the release's SHA256SUMS"
WANT_SHA="$(grep -F "$ASSET_NAME" "$WORK/SHA256SUMS" | awk '{print $1}' | head -1)"
[ -n "$WANT_SHA" ] || die "SHA256SUMS has no entry for $ASSET_NAME - refusing to install an unverifiable download"
if have sha256sum; then
    GOT_SHA="$(sha256sum "$WORK/$ASSET_NAME" | awk '{print $1}')"
else
    GOT_SHA="$(shasum -a 256 "$WORK/$ASSET_NAME" | awk '{print $1}')"
fi
[ "$GOT_SHA" = "$WANT_SHA" ] || die "CHECKSUM MISMATCH for $ASSET_NAME: got $GOT_SHA, SHA256SUMS says $WANT_SHA - refusing to install. Re-download, and if this repeats, report it - do not proceed."
say "checksum verified: $ASSET_NAME ($GOT_SHA)"

say "installing $ASSET_NAME"
case "$INSTALL_KIND" in
    pkg)
        $SUDO installer -pkg "$WORK/$ASSET_NAME" -target / \
            || die "installer failed. If this is an UNSIGNED build (no Developer ID cert yet), Gatekeeper refuses it outright - see docs/INSTALL.md."
        ;;
    deb)
        $SUDO apt-get update -qq || true
        $SUDO apt-get install -y "$WORK/$ASSET_NAME" || die "apt-get install failed"
        ;;
    rpm)
        if have dnf; then $SUDO dnf install -y "$WORK/$ASSET_NAME" || die "dnf install failed"
        else $SUDO yum install -y "$WORK/$ASSET_NAME" || die "yum install failed"
        fi
        ;;
esac

say "installed super-log $VERSION"
have superlogd >/dev/null 2>&1 || warn "superlogd is not on PATH in THIS shell yet - open a new shell, or check /usr/local/bin or /usr/bin"
case "$INSTALL_KIND" in
    deb|rpm)
        say "the hub (superlogd) is already running as a systemd service on 127.0.0.1:7333"
        ;;
    pkg)
        say "start the hub by hand:            superlogd &"
        say "...or make it start at login:     launchctl load /usr/local/superlog/share/com.super-log.hub.plist"
        ;;
esac
say "give it something to log, then read it back:"
say "  echo \"the bench is live\" | superlog --topic hello"
say "  curl -s http://127.0.0.1:7333/recent?topic=hello"
say "See docs/INSTALL.md for the full route list, and README.md for what to point at the hub next."
}

# ------------------------------------------------------------------ main
if [ "$IN_CLONE" = 1 ]; then
    run_source_install "$@"
else
    run_fetch_install "$@"
fi
