#!/bin/sh
#
# make_macos_pkg.sh - build a UNIVERSAL macOS .pkg for super-log: the
# superlogd hub and the 40+ tailers, arm64 and x86_64 in ONE binary so one
# download serves Intel and Apple Silicon - not two files to choose between.
#
# Copyright 2026 Saxon Herschel Nicholls
# SPDX-License-Identifier: MIT
#
# WHY: Homebrew 7.0.0 (2026-09-13) moved macOS Intel to Tier 3 - no routine
# bottle builds - so `brew install` on Intel now compiles from source or
# fails outright (brew.sh/2026/09/13/homebrew-7.0.0/). "Single click from
# the website" needs a path that does not depend on Homebrew's tier ladder
# at all: this .pkg.
#
# WHAT A FULL INSTALL CONTAINS is defined ONCE, in
# packaging/homebrew/super-log.rb - this matches it exactly rather than
# inventing a second definition: the superlogd hub, every tailer as a PATH
# command (`superlog-otlp`, `superlog-rpc`, ...), and the C/C++ SDK headers.
# The ImGui viewer is left out for the same reason the formula leaves it
# out - it wants a display/GL stack this script does not vendor; the web
# viewer needs only a browser.
#
# STEPS, each verifying its own result rather than trusting an exit code -
# a script that exits 0 having produced a broken package is the exact
# failure mode this whole exercise exists to prevent:
#
#   1. build superlogd for arm64 AND x86_64 - two CMake trees, cross-
#      compiled with clang -arch (no Rosetta, no docker: Apple's clang
#      targets either Apple Silicon architecture from either host)
#   2. lipo them into ONE binary, then VERIFY `lipo -archs` actually
#      reports both
#   3. download + VERIFY a Node runtime per architecture against nodejs.org's
#      own SHASUMS256.txt (Saxon: "include node if not detected" - the
#      person who can't use Homebrew for the hub almost certainly has no
#      Node for the tailers either; shipping an unverified runtime inside
#      our own installer would be worse than shipping no installer)
#   4. stage the tailers as PATH wrappers that prefer a system `node` and
#      fall back to the bundled one, decided at RUN time, not build time
#   5. pkgbuild the component, productbuild the distribution package
#   6. sign + notarise IF Developer ID credentials exist; otherwise build
#      UNSIGNED and say so loudly - Gatekeeper refuses an unsigned .pkg on
#      any machine that downloaded it (no com.apple.quarantine needed to
#      trigger this for a .pkg, unlike an app bundle) - testable locally,
#      not shippable
#   7. VERIFY the .pkg just written: expand it, confirm lipo -archs on the
#      shipped binary, confirm every tailer is present and +x, and actually
#      RUN the binary for whichever architecture this host can execute
#
# Usage:
#   scripts/make_macos_pkg.sh
#
# Signing/notarising credentials (optional): a shell-sourceable env file,
# documented field by field in super-log-commercial/.credentials/apple.env
# (APPLE_SIGN_APP, APPLE_SIGN_PKG, APPLE_NOTARY_PROFILE, APPLE_TEAM_ID,
# APPLE_PKG_ID). That file is READ ONLY, never written, and lives outside
# this repo on purpose - a public MIT repo does not hold a path to anyone's
# signing identity as anything but an optional, overridable default.
#   SUPER_LOG_APPLE_ENV=/path/to/apple.env scripts/make_macos_pkg.sh
# As of 2026-09-25 no Developer ID certificates exist yet (only Xcode-local
# "Apple Development" ones - see that file's own header for what to create)
# - so by default this builds UNSIGNED and prints exactly that, loudly, at
# both the start and the end of the run.
#
set -eu

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

say()  { printf '\033[1;36m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33mwarn:\033[0m %s\n' "$1" >&2; }
die()  { printf '\033[1;31mmake_macos_pkg: %s\033[0m\n' "$1" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "this only runs on macOS (pkgbuild/productbuild are macOS-only tools)"
command -v pkgbuild >/dev/null || die "pkgbuild not found - install Xcode command line tools"
command -v productbuild >/dev/null || die "productbuild not found - install Xcode command line tools"
command -v lipo >/dev/null || die "lipo not found - install Xcode command line tools"
command -v node >/dev/null || die "node not found on the build host (needed to read package.json)"

VERSION="${SUPER_LOG_VERSION:-$(node -p "require('./package.json').version")}"
PKG_ID="com.super-log.bench"
DEPLOY_TARGET="12.0"   # Monterey+ - C++17 needs nothing newer; keeps old Intel Macs installable
NODE_BUNDLE_VERSION="22.20.0"   # current LTS at time of writing - bump deliberately, not floated

OUT_DIR="$REPO/packaging/macos"
CACHE_DIR="$OUT_DIR/.node-cache"
mkdir -p "$OUT_DIR" "$CACHE_DIR"

STAGE="$(mktemp -d)"
BUILD_ARM64="$REPO/build-pkg-arm64"
BUILD_X64="$REPO/build-pkg-x86_64"
cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT

# ---- 0. signing/notarising identity, if configured --------------------
APPLE_ENV="${SUPER_LOG_APPLE_ENV:-/Users/Shared/Development/super-log-commercial/.credentials/apple.env}"
SIGNING=0
# CI supplies the identity as already-exported secrets (no credentials FILE
# exists on a runner - the file lives only in the private commercial repo,
# which this workflow does not check out). A local dev machine supplies it
# via that file instead. Env wins if already set, so CI never needs the file.
if [ -z "${APPLE_SIGN_APP:-}" ] && [ -f "$APPLE_ENV" ]; then
    # shellcheck disable=SC1090
    . "$APPLE_ENV"
fi
: "${APPLE_SIGN_APP:=}"; : "${APPLE_SIGN_PKG:=}"; : "${APPLE_NOTARY_PROFILE:=}"; : "${APPLE_TEAM_ID:=}"
# NO -p codesigning ON THE INSTALLER LOOKUP. A "Developer ID Installer"
# certificate is not a codesigning identity — it signs a .pkg through
# productsign, not a binary through codesign — so the codesigning policy
# filter hides it. This script asked with that filter, found nothing, and
# built UNSIGNED on a machine where both certificates were installed and
# working (2026-09-25, an hour after they were issued).
#
# Each certificate is now looked up under the policy it is actually for, and
# BOTH must be present: signing the binaries with one and the package with
# the other is the whole arrangement, and half of it is not a build worth
# shipping.
if [ -n "$APPLE_SIGN_APP" ] && [ -n "$APPLE_SIGN_PKG" ] \
   && ! printf '%s' "$APPLE_SIGN_APP" | grep -q '<NAME>' \
   && security find-identity -v -p codesigning 2>/dev/null | grep -qF "$APPLE_SIGN_APP" \
   && security find-identity -v 2>/dev/null | grep -qF "$APPLE_SIGN_PKG"; then
    SIGNING=1
    [ -n "${APPLE_PKG_ID:-}" ] && PKG_ID="$APPLE_PKG_ID"
    say "signing identity found in keychain: $APPLE_SIGN_PKG"
elif [ -n "$APPLE_SIGN_APP" ]; then
    warn "signing identity configured (env or $APPLE_ENV) but no matching Developer ID Installer cert in this keychain - building UNSIGNED"
else
    warn "no signing identity in the environment and no credentials file at $APPLE_ENV - building UNSIGNED"
fi
if [ "$SIGNING" = 0 ]; then
    warn "*** THIS BUILD WILL BE UNSIGNED. ***"
    warn "*** Gatekeeper REFUSES an unsigned .pkg on any machine that downloaded it. ***"
    warn "*** Testable locally (this script does exactly that below) - NOT shippable from the website until"
    warn "*** a 'Developer ID Application' + 'Developer ID Installer' certificate exist. See $APPLE_ENV."
fi

# ---- 1. build superlogd for both architectures -------------------------
build_arch() {
    ARCH="$1"; DIR="$2"
    say "building superlogd for $ARCH"
    rm -rf "$DIR"
    cmake -S "$REPO" -B "$DIR" -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_OSX_ARCHITECTURES="$ARCH" \
        -DCMAKE_OSX_DEPLOYMENT_TARGET="$DEPLOY_TARGET" \
        -DSUPER_LOG_BUILD_IMGUI_VIEWER=OFF \
        -DSUPER_LOG_INSTALL=ON >/dev/null
    cmake --build "$DIR" --target superlogd -j >/dev/null
    [ -x "$DIR/hub/superlogd" ] || die "$ARCH build did not produce $DIR/hub/superlogd"
    GOT="$(lipo -archs "$DIR/hub/superlogd")"
    [ "$GOT" = "$ARCH" ] || die "$ARCH build produced a '$GOT' binary, not '$ARCH' - cross-compile flag was not honoured"
    say "  ok: $DIR/hub/superlogd is $GOT"
}
build_arch arm64  "$BUILD_ARM64"
build_arch x86_64 "$BUILD_X64"

# ---- 2. lipo into one universal binary, VERIFY both archs report -------
mkdir -p "$STAGE/usr/local/superlog/bin"
lipo -create -output "$STAGE/usr/local/superlog/bin/superlogd" \
    "$BUILD_ARM64/hub/superlogd" "$BUILD_X64/hub/superlogd"
ARCHES="$(lipo -archs "$STAGE/usr/local/superlog/bin/superlogd")"
echo "$ARCHES" | grep -qw arm64  || die "universal binary is missing arm64 - lipo -archs said: $ARCHES"
echo "$ARCHES" | grep -qw x86_64 || die "universal binary is missing x86_64 - lipo -archs said: $ARCHES"
say "universal binary verified: lipo -archs -> $ARCHES"
chmod 0755 "$STAGE/usr/local/superlog/bin/superlogd"

# ---- 3. Node runtime per architecture, downloaded + VERIFIED -----------
# No official "universal" Node tarball exists (that is an Electron-specific
# build, not upstream) - two full per-arch trees are bundled instead, and the
# wrapper picks one by `uname -m` at run time. Every tarball is checked
# against nodejs.org's own SHASUMS256.txt for its release before ANYTHING
# from it is copied into the package - an unverified runtime bundled inside
# our own installer would be a worse outcome than shipping no installer.
fetch_node() {
    NARCH="$1"   # arm64 | x64  (Node's own arch spelling)
    DEST="$STAGE/usr/local/superlog/node/$NARCH"
    TARBALL="node-v${NODE_BUNDLE_VERSION}-darwin-${NARCH}.tar.gz"
    URL="https://nodejs.org/dist/v${NODE_BUNDLE_VERSION}/$TARBALL"
    SHAFILE="$CACHE_DIR/SHASUMS256-v${NODE_BUNDLE_VERSION}.txt"
    CACHED="$CACHE_DIR/$TARBALL"

    [ -f "$SHAFILE" ] || {
        say "fetching node v$NODE_BUNDLE_VERSION SHASUMS256.txt"
        curl -fsSL "https://nodejs.org/dist/v${NODE_BUNDLE_VERSION}/SHASUMS256.txt" -o "$SHAFILE" \
            || die "could not fetch SHASUMS256.txt for node v$NODE_BUNDLE_VERSION"
    }
    WANT_SHA="$(awk -v f="$TARBALL" '$2==f{print $1}' "$SHAFILE")"
    [ -n "$WANT_SHA" ] || die "SHASUMS256.txt has no entry for $TARBALL - refusing to bundle an unverifiable runtime"

    if [ -f "$CACHED" ]; then
        GOT_SHA="$(shasum -a 256 "$CACHED" | awk '{print $1}')"
        [ "$GOT_SHA" = "$WANT_SHA" ] || { warn "cached $TARBALL failed checksum - refetching"; rm -f "$CACHED"; }
    fi
    if [ ! -f "$CACHED" ]; then
        say "downloading $TARBALL"
        curl -fsSL "$URL" -o "$CACHED.part" || die "download failed: $URL"
        mv "$CACHED.part" "$CACHED"
    fi
    GOT_SHA="$(shasum -a 256 "$CACHED" | awk '{print $1}')"
    [ "$GOT_SHA" = "$WANT_SHA" ] || die "CHECKSUM MISMATCH for $TARBALL: got $GOT_SHA, SHASUMS256.txt says $WANT_SHA - refusing to package it"
    say "  verified against SHASUMS256.txt: $TARBALL ($GOT_SHA)"

    # Only the interpreter is bundled, not npm/docs/headers - the tailers are
    # run directly with `node script.mjs`, never `npm install`d on the target.
    mkdir -p "$DEST/bin"
    tar -xzf "$CACHED" -O "node-v${NODE_BUNDLE_VERSION}-darwin-${NARCH}/bin/node" > "$DEST/bin/node" \
        || die "could not extract bin/node from $TARBALL"
    chmod 0755 "$DEST/bin/node"

    # A binary for NARCH can only be EXECUTED here if NARCH matches this
    # build host's own architecture - macOS has no emulation in the
    # Intel-runs-arm64 direction (unlike Rosetta 2, which only goes the
    # other way). The non-native slice is verified structurally instead
    # (its Mach-O architecture, via `file`), which is what it actually
    # means to "check a binary you cannot run".
    WANT_UNAME=arm64; [ "$NARCH" = x64 ] && WANT_UNAME=x86_64
    if [ "$(uname -m)" = "$WANT_UNAME" ]; then
        "$DEST/bin/node" --version | grep -qF "v$NODE_BUNDLE_VERSION" \
            || die "bundled node for $NARCH does not run / report v$NODE_BUNDLE_VERSION on this $WANT_UNAME host"
        say "  bundled node for $NARCH RUNS on this host: $("$DEST/bin/node" --version)"
    else
        file "$DEST/bin/node" | grep -qi "$WANT_UNAME" \
            || die "bundled node for $NARCH does not report itself as $WANT_UNAME (file(1) said: $(file "$DEST/bin/node"))"
        say "  bundled node for $NARCH verified structurally as $WANT_UNAME (this $(uname -m) host cannot execute it to check further)"
    fi
}
fetch_node arm64
# x64 is only runnable (and therefore only testable end-to-end) on this
# host if it is itself x86_64 - see the verify step below, which reports
# this precisely rather than claiming a check it could not perform.
fetch_node x64
say "node bundled for both architectures, each independently checksum-verified"

# ---- 4. tailers as PATH wrappers (prefer system node, else bundled) ----
mkdir -p "$STAGE/usr/local/superlog/lib/tailers" "$STAGE/usr/local/bin"
cp "$REPO"/tailers/bin/* "$STAGE/usr/local/superlog/lib/tailers/"

# The shared decision every wrapper makes at RUN time, not build time: a
# system `node` (any version >=18 the user already has) wins over the
# bundled one, because it is the user's own and gets their own updates:
# the bundle exists only to cover the "no Node at all" case this installer
# was written for.
NODE_PICK='NODE_BIN="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE_BIN" ]; then
    case "$(uname -m)" in
        arm64) NODE_BIN="/usr/local/superlog/node/arm64/bin/node" ;;
        *)     NODE_BIN="/usr/local/superlog/node/x64/bin/node" ;;
    esac
fi'

for f in "$STAGE"/usr/local/superlog/lib/tailers/superlog-*.mjs; do
    name="$(basename "$f" .mjs)"
    {
        echo '#!/bin/sh'
        echo "$NODE_PICK"
        echo "exec \"\$NODE_BIN\" \"/usr/local/superlog/lib/tailers/$(basename "$f")\" \"\$@\""
    } > "$STAGE/usr/local/bin/$name"
    chmod 0755 "$STAGE/usr/local/bin/$name"
done
# superlog-log is a plain POSIX shell script (it has to run where there is
# no Node at all) - symlink it directly rather than node-wrapping it. See
# the same fix applied to packaging/deb and packaging/rpm this session;
# the .mjs-only glob had silently dropped it from every channel's PATH.
ln -sf "/usr/local/superlog/lib/tailers/superlog-log" "$STAGE/usr/local/bin/superlog-log"
{
    echo '#!/bin/sh'
    echo "$NODE_PICK"
    echo 'exec "$NODE_BIN" "/usr/local/superlog/lib/tailers/superlog.mjs" "$@"'
} > "$STAGE/usr/local/bin/superlog"
chmod 0755 "$STAGE/usr/local/bin/superlog"
ln -sf "/usr/local/superlog/bin/superlogd" "$STAGE/usr/local/bin/superlogd"

TAILER_COUNT="$(find "$STAGE/usr/local/bin" -name 'superlog*' | wc -l | tr -d ' ')"
say "staged $TAILER_COUNT PATH commands (tailers + superlog + superlogd)"

# ---- SDK headers (matches what the Homebrew formula installs) ----------
mkdir -p "$STAGE/usr/local/superlog/include"
cp "$REPO/sdk/c/superlog.h" "$STAGE/usr/local/superlog/include/"
cp -R "$REPO/sdk/cpp/include/super_log" "$STAGE/usr/local/superlog/include/"

# ---- launchd agent template (not loaded by the installer; see caveats) -
# Mirrors the Homebrew formula's `service do` block and scripts/install.sh's
# --persist writer, but a .pkg cannot ask "start at login?" the way a brew
# service or an interactive script can - it drops the plist and lets the
# postinstall notes tell the user to load it, same as apt's postinst prints
# next steps rather than silently taking over their login items.
mkdir -p "$STAGE/usr/local/superlog/share"
cat > "$STAGE/usr/local/superlog/share/com.super-log.hub.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.super-log.hub</string>
  <key>ProgramArguments</key><array><string>/usr/local/bin/superlogd</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/super-log-hub.log</string>
  <key>StandardErrorPath</key><string>/tmp/super-log-hub.log</string>
</dict></plist>
PLIST

# ---- 4b. sign every Mach-O in the payload ------------------------------
#
# SIGNING THE .pkg IS NOT ENOUGH, and this is where the first real
# notarisation attempt died (2026-09-25, submission 28367e49). Apple accepted
# the package signature and then rejected the contents, four errors deep on
# one file:
#
#   The binary is not signed.
#   The signature does not include a secure timestamp.
#   The executable does not have the hardened runtime enabled.
#   The binary is not signed with a valid Developer ID certificate.
#
# So: every executable INSIDE the payload needs the Developer ID Application
# certificate, --timestamp (Apple's timestamp server, not the local clock,
# so the signature outlives the certificate's expiry) and --options runtime
# (the hardened runtime, which notarisation requires without exception).
#
# --force because the bundled Node tarballs arrive already signed by the
# Node project, and their signature is not one this package can notarise
# under. Ours replaces it.
#
# The list is DISCOVERED, not enumerated: `file` finds every Mach-O under the
# staging root. A hand-written list is a list that goes stale the first time
# somebody adds a binary, and the failure mode is another rejected submission
# twenty minutes later.
if [ "$SIGNING" = 1 ]; then
    # ENTITLEMENTS, FOR NODE ONLY.
    #
    # CRASHED ON A REAL MAC 2026-09-27, the first time anyone ran the
    # installed `superlog`:
    #
    #   Check failed: 12 == (*__error()).
    #   v8::base::OS::SetPermissions
    #   MemoryAllocator::SetPermissionsOnExecutableMemoryChunk
    #   BaselineCompiler::Build
    #
    # --options runtime is the hardened runtime, and notarisation requires
    # it. The hardened runtime forbids making memory executable. V8 asks for
    # exactly that the moment a function gets hot enough to tier up to
    # baseline, mprotect is refused, and V8 aborts the process. So satisfying
    # Apple's notarisation broke the runtime we bundle.
    #
    # The entitlements below are Apple's sanctioned answer for a JIT, and
    # they are accepted for Developer ID distribution. They are applied ONLY
    # to the bundled node binaries: superlogd is C++ with no JIT and has no
    # business asking for writable-executable memory, and granting it
    # anywhere it is not needed is hardening given away for nothing.
    ENT="$STAGE/node.entitlements"
    cat > "$ENT" <<'ENTXML'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.cs.allow-jit</key><true/>
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
    <key>com.apple.security.cs.disable-library-validation</key><true/>
</dict>
</plist>
ENTXML

    say "codesign: signing every Mach-O in the payload with $APPLE_SIGN_APP"
    signed_count=0
    find "$STAGE" -type f -perm -u+x -print | while read -r f; do
        case "$(file -b "$f" 2>/dev/null)" in
            *Mach-O*) ;;
            *) continue ;;
        esac
        # The bundled runtime gets the JIT entitlements; nothing else does.
        case "$f" in
            */superlog/node/*) ENT_ARGS="--entitlements $ENT" ;;
            *)                 ENT_ARGS="" ;;
        esac
        # shellcheck disable=SC2086
        codesign --force --sign "$APPLE_SIGN_APP" \
                 --timestamp --options runtime $ENT_ARGS \
                 "$f" >/dev/null 2>&1 \
            || die "codesign failed on $f"
        printf '%s\n' "$f" >> "$STAGE/.signed-list"
    done
    signed_count="$(wc -l < "$STAGE/.signed-list" 2>/dev/null | tr -d ' ')"
    [ "${signed_count:-0}" -gt 0 ] || die "codesign signed nothing - no Mach-O found under $STAGE"
    say "  signed $signed_count Mach-O file(s)"

    # Verify before packaging, not after Apple tells us. --strict is what
    # notarisation applies; a signature that passes the default check and
    # fails --strict is the one that wastes a submission round trip.
    while read -r f; do
        codesign --verify --strict --verbose=1 "$f" >/dev/null 2>&1 \
            || die "codesign --verify --strict rejected $f after signing it"
    done < "$STAGE/.signed-list"
    say "  VERIFY: every signed binary passes codesign --verify --strict"
    rm -f "$STAGE/.signed-list"
fi

# ---- 5. pkgbuild the component, productbuild the distribution ----------
# Only the FINAL product (below) needs the Developer ID Installer signature
# for Gatekeeper - the inner component here is wrapped, not distributed on
# its own, so pkgbuild does not sign it separately.
COMPONENT_PKG="$STAGE/component.pkg"

say "pkgbuild: staging component package"
# --ownership recommended: pkgbuild computes root:wheel metadata for
# /usr/local paths without needing this build to run as root itself.
# --install-location /usr/local, NOT /.
#
# FAILED ON A REAL MAC 2026-09-27, macOS 12.7.6: "The package is trying to
# install content to the system volume." Rooted at /, the payload's first
# path component is /usr — and since Catalina the system volume is sealed
# and read-only, so Installer refuses before it looks any deeper. /usr/local
# itself lives on the writable Data volume and is a perfectly legal target;
# the package simply has to SAY that is where it is going.
#
# The staged tree is already $STAGE/usr/local/..., so the root moves down two
# levels and the paths inside the payload become superlog/... and bin/...,
# relative to /usr/local. Nothing about the installed layout changes.
pkgbuild --root "$STAGE/usr/local" \
    --identifier "$PKG_ID" \
    --version "$VERSION" \
    --install-location /usr/local \
    --ownership recommended \
    "$COMPONENT_PKG" >/dev/null
[ -f "$COMPONENT_PKG" ] || die "pkgbuild did not produce $COMPONENT_PKG"

DIST_XML="$STAGE/Distribution.xml"
cat > "$DIST_XML" <<XML
<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="1">
    <title>super-log $VERSION</title>
    <organization>com.super-log</organization>
    <domains enable_localSystem="true"/>
    <!-- rootVolumeOnly was here and had to go. It is deprecated, and on a
         sealed-system-volume Mac (Catalina and later) it is part of what
         produces "the package is trying to install content to the system
         volume" — it asserts the one thing macOS will not allow. -->
    <options customize="never" require-scripts="false"/>
    <volume-check>
        <allowed-os-versions><os-version min="$DEPLOY_TARGET"/></allowed-os-versions>
    </volume-check>
    <choices-outline>
        <line choice="default"><line choice="com.super-log.bench"/></line>
    </choices-outline>
    <choice id="default"/>
    <choice id="com.super-log.bench" visible="false">
        <pkg-ref id="$PKG_ID"/>
    </choice>
    <pkg-ref id="$PKG_ID" version="$VERSION" onConclusion="none">component.pkg</pkg-ref>
</installer-gui-script>
XML

UNSIGNED_OUT="$OUT_DIR/super-log-${VERSION}-universal.pkg"
# A Developer ID Installer identity has the shape
# "Developer ID Installer: <name> (<team id>)" — it contains spaces, so the
# old `--sign $APPLE_SIGN_PKG` in an unquoted string
# expanded into --sign Developer / ID / Installer: / … and productbuild
# answered with its usage text. Found 2026-09-25, the first run with real
# certificates present.
#
# Spelled out as two invocations rather than collected into an array,
# because this script is #!/bin/sh and POSIX sh has no arrays. The first
# attempt at this fix used one and passed `bash -n`, which is the wrong
# shell to check it with.

say "productbuild: assembling the distribution package"
# Remove the previous build FIRST, so the check below means something. It
# did not: productbuild failed with a usage error, the existence test found
# the .pkg an earlier UNSIGNED run had left behind, and the script reported
# success and exited 0 with a stale artifact on disk. An existence check that
# a previous run can satisfy is not a check.
rm -f "$UNSIGNED_OUT"
if [ "$SIGNING" = 1 ]; then
    productbuild --distribution "$DIST_XML" --package-path "$STAGE" \
        --sign "$APPLE_SIGN_PKG" "$UNSIGNED_OUT" \
        || die "productbuild failed while signing - see its output above"
else
    productbuild --distribution "$DIST_XML" --package-path "$STAGE" \
        "$UNSIGNED_OUT" \
        || die "productbuild failed - see its output above"
fi
[ -f "$UNSIGNED_OUT" ] || die "productbuild did not produce $UNSIGNED_OUT"
say "built: $UNSIGNED_OUT"

# ---- 6. notarise, only if credentials exist -----------------------------
if [ "$SIGNING" = 1 ] && [ -n "$APPLE_NOTARY_PROFILE" ]; then
    say "notarytool: submitting for notarisation (this waits on Apple)"
    # `notarytool submit --wait` EXITS 0 EVEN WHEN THE STATUS IS Invalid.
    # It did exactly that on 2026-09-25: Apple rejected the package, stapler
    # then failed with error 65, and this script still exited 0. The status
    # line is the finding, not the exit code.
    notar_out="$(xcrun notarytool submit "$UNSIGNED_OUT" \
                   --keychain-profile "$APPLE_NOTARY_PROFILE" --wait 2>&1)"
    printf '%s\n' "$notar_out"
    notar_id="$(printf '%s' "$notar_out" | awk '/^  id: /{print $2; exit}')"
    if ! printf '%s' "$notar_out" | grep -q 'status: Accepted'; then
        warn "Apple's own reasons follow:"
        [ -n "$notar_id" ] && xcrun notarytool log "$notar_id" \
            --keychain-profile "$APPLE_NOTARY_PROFILE" 2>&1 | head -60
        die "notarisation was not Accepted - the log above says why"
    fi
    # Stapling attaches the ticket to the file, so the package verifies on a
    # machine that is offline. Without it Gatekeeper has to ask Apple.
    xcrun stapler staple "$UNSIGNED_OUT" || die "notarised, but the ticket would not staple"
    xcrun stapler validate "$UNSIGNED_OUT" >/dev/null 2>&1 \
        || die "stapler reported success but the ticket does not validate"
    say "notarised, stapled and validated: $UNSIGNED_OUT"
else
    warn "SKIPPING notarisation (no notary profile configured) - this .pkg is UNSIGNED and UNNOTARISED"
fi

# ---- 7. verify the artefact this script actually produced --------------
say "verifying the built .pkg (not trusting the exit codes above)"
EXPAND_DIR="$STAGE/expanded"
rm -rf "$EXPAND_DIR"
pkgutil --expand "$UNSIGNED_OUT" "$EXPAND_DIR" || die "pkgutil --expand failed on the package we just built"

# The payload is now relative to /usr/local (the install-location), so what
# used to sit at Payload/usr/local/superlog now sits at Payload/superlog.
# PAYLOAD_ROOT is where the installed /usr/local begins, whichever it is —
# resolved rather than assumed, so a future change to install-location
# fails loudly here instead of silently verifying nothing.
PAYLOAD_DIR="$EXPAND_DIR/component.pkg/Payload_extracted"
mkdir -p "$PAYLOAD_DIR"
( cd "$PAYLOAD_DIR" && gzip -dc "../Payload" | cpio -i --quiet ) \
    || die "could not extract the component Payload - the package archive is malformed"

if [ -d "$PAYLOAD_DIR/superlog/bin" ]; then
    PAYLOAD_ROOT="$PAYLOAD_DIR"                 # install-location /usr/local
elif [ -d "$PAYLOAD_DIR/usr/local/superlog/bin" ]; then
    PAYLOAD_ROOT="$PAYLOAD_DIR/usr/local"       # install-location /
else
    die "VERIFY FAILED: cannot find superlog/bin anywhere in the payload - the package layout is not what this script built"
fi
BIN="$PAYLOAD_ROOT/superlog/bin/superlogd"
[ -x "$BIN" ] || die "VERIFY FAILED: superlogd is not present/executable inside the built package"
ARCHES="$(lipo -archs "$BIN")"
echo "$ARCHES" | grep -qw arm64  || die "VERIFY FAILED: shipped superlogd lacks arm64 ($ARCHES)"
echo "$ARCHES" | grep -qw x86_64 || die "VERIFY FAILED: shipped superlogd lacks x86_64 ($ARCHES)"
say "VERIFY: lipo -archs on the SHIPPED binary -> $ARCHES (matches the claim: one file, both architectures)"

MISSING=""
for f in "$REPO"/tailers/bin/superlog-*; do
    name="$(basename "$f")"
    case "$name" in
        *.mjs) cmd="$(basename "$name" .mjs)" ;;
        *)     cmd="$name" ;;
    esac
    W="$PAYLOAD_ROOT/bin/$cmd"
    if [ -L "$W" ]; then
        # A symlink in the payload points at its post-install absolute path
        # (e.g. /usr/local/superlog/lib/tailers/superlog-log), which does not
        # exist at that literal location until pkgbuild's receipt is really
        # installed to / - so resolve it against the extracted payload root
        # instead of testing the dangling absolute path directly.
        # The target is absolute and post-install (/usr/local/superlog/...),
        # so it has to be rebased onto wherever /usr/local begins inside the
        # extracted payload. Stripping the /usr/local prefix and appending to
        # PAYLOAD_ROOT is correct for BOTH install locations: with
        # /usr/local the root is the payload itself, with / it is
        # payload/usr/local, and the remainder is the same either way.
        TARGET="$(readlink "$W")"
        [ -x "$PAYLOAD_ROOT${TARGET#/usr/local}" ] \
            || MISSING="$MISSING $cmd(broken-symlink->$TARGET)"
    elif [ -x "$W" ]; then
        :
    else
        MISSING="$MISSING $cmd"
    fi
done
[ -z "$MISSING" ] || die "VERIFY FAILED: these tailer commands are missing or not executable in the package:$MISSING"
COUNT="$(find "$PAYLOAD_ROOT/bin" -name 'superlog*' | wc -l | tr -d ' ')"
say "VERIFY: all $COUNT tailer PATH commands present and executable in the built package (every tailers/bin/superlog-* checked, not spot-checked)"

# Actually RUN it - for whichever architecture this host can execute.
# Honest about the gap: an arm64 host cannot execute the x86_64 slice and
# vice versa; only one direction is testable on any single Mac.
HOST_ARCH="$(uname -m)"
say "this build host is $HOST_ARCH - running the shipped binary for that architecture only"
PORT=17333
SUPER_LOG_PORT="$PORT" SUPER_LOG_BIND=127.0.0.1 "$BIN" >"$STAGE/pkg-verify-hub.log" 2>&1 &
HUBPID=$!
i=0
until curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; do
    i=$((i + 1))
    if [ "$i" -gt 50 ]; then
        kill "$HUBPID" 2>/dev/null || true
        cat "$STAGE/pkg-verify-hub.log" >&2
        die "VERIFY FAILED: the shipped $HOST_ARCH binary did not answer /healthz within 5s"
    fi
    sleep 0.1
done
curl -sf "http://127.0.0.1:$PORT/healthz" | grep -q published \
    || { kill "$HUBPID" 2>/dev/null || true; die "VERIFY FAILED: /healthz did not report 'published'"; }
kill "$HUBPID" 2>/dev/null || true
wait "$HUBPID" 2>/dev/null || true
say "VERIFY: shipped $HOST_ARCH superlogd actually runs and answers /healthz"
say "VERIFY: the other architecture in this binary was checked structurally (lipo -archs) but NOT executed - this host cannot run it natively"

# The bundled node for the host's own architecture, since the wrapper
# script logic is easy to get wrong (wrong path, wrong arch key).
case "$HOST_ARCH" in
    arm64) NCMD="$PAYLOAD_ROOT/superlog/node/arm64/bin/node" ;;
    *)     NCMD="$PAYLOAD_ROOT/superlog/node/x64/bin/node" ;;
esac
[ -x "$NCMD" ] || die "VERIFY FAILED: bundled node for $HOST_ARCH is missing from the package"
"$NCMD" --version | grep -qF "v$NODE_BUNDLE_VERSION" || die "VERIFY FAILED: bundled node for $HOST_ARCH does not run / reports the wrong version"
say "VERIFY: bundled node for $HOST_ARCH runs ($("$NCMD" --version))"

# AND THAT IT CAN ACTUALLY EXECUTE JAVASCRIPT, which --version does not
# prove. `node --version` prints a string and exits before V8 tiers a single
# function up, so it never asks for executable memory — which is why the
# build reported "bundled node runs (v22.20.0)" while the installed
# `superlog` died on a real Mac with:
#
#   Check failed: 12 == (*__error()).  ...  BaselineCompiler::Build
#
# The hardened runtime had refused the JIT. A true statement about a version
# string stood in for a working runtime for one whole release.
#
# So: run a loop hot enough to force baseline tier-up, with the JIT
# explicitly required. --jitless would mask the very failure this is here to
# catch, so it must NOT be used.
JITPROBE="$STAGE/jit-probe.js"
cat > "$JITPROBE" <<'JS'
// Hot enough that V8 promotes this out of the interpreter. Under a hardened
// runtime with no JIT entitlement, that promotion is where it dies.
function work(n) { let a = 0; for (let i = 0; i < n; i++) a = (a + i * 7) % 1000003; return a; }
let out = 0;
for (let round = 0; round < 200; round++) out += work(50000);
if (!Number.isFinite(out)) { process.exit(3); }
process.stdout.write('jit-ok');
JS
JITOUT="$("$NCMD" "$JITPROBE" 2>&1)" || {
    printf '%s\n' "$JITOUT" >&2
    die "VERIFY FAILED: bundled node for $HOST_ARCH cannot execute JavaScript under its own signature.
     If the trace mentions SetPermissions or BaselineCompiler, the hardened runtime
     refused the JIT and the node binaries are missing their entitlements."
}
[ "$JITOUT" = "jit-ok" ] || die "VERIFY FAILED: the JIT probe returned '$JITOUT', not 'jit-ok'"
say "VERIFY: bundled node JITs real code under the shipped signature (not just --version)"

say "done: $UNSIGNED_OUT"
if [ "$SIGNING" = 0 ]; then
    warn "*** UNSIGNED PACKAGE. Gatekeeper will refuse this on any machine that downloaded it. ***"
    warn "*** Do not link this from the website until Developer ID certs exist - see $APPLE_ENV ***"
fi
