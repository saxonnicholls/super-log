#!/bin/sh
#
# install-power-tailer.sh - let superlog-power read watts without a prompt.
#
# Copyright 2026 Saxon Herschel Nicholls
# SPDX-License-Identifier: MIT
#
# powermetrics requires root and superlog-power never asks for a password -
# it runs unattended. Of the two honest ways to square that (a root daemon
# streaming powermetrics to a file, or a scoped sudoers entry) this installs
# the sudoers entry: the tailer keeps ownership of its child, powermetrics
# runs only while something is actually watching, and there is no always-on
# root daemon drawing the very power it exists to measure. The cost is one
# rule in /etc/sudoers.d and one root-owned script to carry it.
#
# The rule does NOT point at powermetrics itself. Keeping the interval
# configurable would need wildcarded arguments, and a sudoers wildcard
# matches spaces - "powermetrics *" also matches "-o /etc/anything", which
# is a root file write dressed as a metrics flag. So the rule pins ONE
# root-owned wrapper that validates its single argument (the interval, in
# milliseconds) and hard-codes everything else.
#
#   sudo ./scripts/install-power-tailer.sh              # authorise $SUDO_USER
#   sudo ./scripts/install-power-tailer.sh --uninstall
#
set -e

WRAPPER=/usr/local/libexec/superlog-powermetrics
SUDOERS=/etc/sudoers.d/superlog-power

[ "$(uname -s)" = "Darwin" ] || {
    echo "install-power-tailer: powermetrics is macOS only" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || {
    echo "install-power-tailer: run with sudo (it writes /etc/sudoers.d)" >&2; exit 2; }

if [ "${1:-}" = "--uninstall" ]; then
    rm -f "$WRAPPER" "$SUDOERS"
    echo "install-power-tailer: removed $WRAPPER and $SUDOERS"
    exit 0
fi

USER_NAME="${SUDO_USER:-}"
if [ -z "$USER_NAME" ] || [ "$USER_NAME" = "root" ]; then
    echo "install-power-tailer: cannot tell which user to authorise (no SUDO_USER)." >&2
    echo "  run it as:  sudo ./scripts/install-power-tailer.sh" >&2
    exit 2
fi

mkdir -p /usr/local/libexec

cat > "$WRAPPER" <<'EOF'
#!/bin/sh
# Installed by super-log's scripts/install-power-tailer.sh. Root-owned and
# pinned by /etc/sudoers.d/superlog-power so superlog-power can read watts
# without a password. ONE argument - the sample interval in milliseconds,
# validated here - and everything else is fixed, so the sudoers entry cannot
# be steered into anything but this exact powermetrics run (in particular
# not -o, which writes files as root).
ms="${1:-10000}"
case "$ms" in ''|*[!0-9]*) ms=10000 ;; esac
[ "$ms" -ge 1000 ] || ms=1000
# smc (fans, die temperatures) and thermal (pressure) exist on some macOS
# releases and not others; the help says which, and needs no root to ask.
samplers="cpu_power,tasks"
for extra in smc thermal; do
    if /usr/bin/powermetrics -h 2>&1 | grep -q "^    $extra "; then
        samplers="$samplers,$extra"
    fi
done
exec /usr/bin/powermetrics --samplers "$samplers" --show-process-energy \
    -f plist -i "$ms" -b 1
EOF
chown root:wheel "$WRAPPER"
chmod 755 "$WRAPPER"

# visudo -c before installing: a malformed file in sudoers.d disables sudo
# for everyone, which would be a spectacular own goal for a logging tool.
TMP=$(mktemp)
printf '%s ALL=(root) NOPASSWD: %s\n' "$USER_NAME" "$WRAPPER" > "$TMP"
if ! visudo -c -f "$TMP" >/dev/null; then
    rm -f "$TMP"
    echo "install-power-tailer: generated sudoers entry did not validate; nothing installed" >&2
    exit 1
fi
install -m 440 -o root -g wheel "$TMP" "$SUDOERS"
rm -f "$TMP"

echo "install-power-tailer: $USER_NAME may now run, passwordless and only this:"
echo "  sudo -n $WRAPPER <interval-ms>"
echo "Try it:  npm run power -- --once"
