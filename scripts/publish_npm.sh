#!/usr/bin/env bash
#
# publish_npm.sh — publish the super-log npm packages, or refuse to.
#
# Copyright 2026 Saxon Herschel Nicholls
# SPDX-License-Identifier: MIT
#
# WHY THIS EXISTS, and it is not hypothetical.
#
# On 2026-09-10, hours before the first publish, @super-log/tailers still
# declared its `superlog` bin as bin/superlog-tee.mjs — the OLD tee. Anyone
# running `npm install -g @super-log/tailers` and then a bare `superlog` would
# have got a process that HUNG. That is a stranger's entire first impression of
# the project, formed in ten seconds and never revisited, and `npm unpublish` is
# restricted after 72 hours so it could not have been taken back.
#
# It was caught by a person reading the file. This script is the check that does
# not depend on a person reading the file.
#
# THE CENTRAL IDEA: a package is not verified by inspecting the repository. It is
# verified by PACKING it, INSTALLING the tarball into a clean environment, and
# RUNNING the command a stranger would run. Everything short of that tests the
# source tree, which is not the artefact anybody receives.
#
# Default is a DRY RUN. Nothing reaches the registry without --publish.
#
#   ./scripts/publish_npm.sh                 # check everything, publish nothing
#   ./scripts/publish_npm.sh --publish       # check, then publish what passes
#   ./scripts/publish_npm.sh --only tailers  # one package
#
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

DO_PUBLISH=0
ALLOW_DIRTY=0
ONLY=""
RUN_TIMEOUT=15

while [[ $# -gt 0 ]]; do
  case "$1" in
    --publish)     DO_PUBLISH=1 ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    --only)        ONLY="${2:-}"; shift ;;
    -h|--help)     sed -n '3,30p' "$0"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

RED=$'\033[0;31m'; GRN=$'\033[0;32m'; YEL=$'\033[1;33m'; CYA=$'\033[0;36m'; NC=$'\033[0m'
ok()   { echo "  ${GRN}✓${NC} $*"; }
bad()  { echo "  ${RED}✗${NC} $*"; FAILED=$((FAILED+1)); }
warn() { echo "  ${YEL}!${NC} $*"; WARNED=$((WARNED+1)); }
head_() { echo; echo "${CYA}━━━ $* ━━━${NC}"; }

FAILED=0
WARNED=0

# macOS has no coreutils `timeout`. A hang is the exact bug this script exists to
# catch, so the timeout cannot be optional — implement it rather than skip it.
run_limited() {
  local secs="$1"; shift
  ( "$@" ) & local pid=$!
  ( sleep "$secs"; kill -9 "$pid" 2>/dev/null ) & local killer=$!
  local rc=0
  wait "$pid" 2>/dev/null || rc=$?
  kill -9 "$killer" 2>/dev/null || true
  wait "$killer" 2>/dev/null || true
  # 137 = SIGKILL, i.e. we timed it out.
  return "$rc"
}

# ---------------------------------------------------------------- preflight

head_ "Preflight"

command -v npm  >/dev/null || { echo "npm not found" >&2; exit 1; }
command -v node >/dev/null || { echo "node not found" >&2; exit 1; }
ok "node $(node --version), npm $(npm --version)"

if [[ "$ALLOW_DIRTY" -eq 0 ]]; then
  if [[ -n "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=no)" ]]; then
    bad "working tree is dirty — a published artefact must correspond to a commit"
    git -C "$REPO_ROOT" status --short --untracked-files=no | head -10 | sed 's/^/      /'
    echo
    echo "  Publishing from a dirty tree means the tarball on the registry matches"
    echo "  no commit anywhere, so a later bug report cannot be reproduced. Commit,"
    echo "  or re-run with --allow-dirty if you have decided otherwise."
    exit 1
  fi
  ok "working tree clean (HEAD $(git -C "$REPO_ROOT" rev-parse --short HEAD))"
fi

if [[ "$DO_PUBLISH" -eq 1 ]]; then
  if ! npm whoami >/dev/null 2>&1; then
    bad "not logged in to npm — run: npm login"
    exit 1
  fi
  ok "npm user: $(npm whoami)"
else
  echo "  ${YEL}DRY RUN${NC} — checks only. Nothing will be published."
fi

# ------------------------------------------------------------ package list

mapfile -t PKG_DIRS < <(
  find "$REPO_ROOT" -name package.json -not -path "*/node_modules/*" -maxdepth 5 -print0 2>/dev/null \
  | xargs -0 -I{} dirname {} | sort
)

# ------------------------------------------------------------- per package

check_package() {
  local dir="$1"
  local pj="$dir/package.json"

  local name ver private_
  name=$(node -p "try{require('$pj').name||''}catch(e){''}")
  ver=$(node -p  "try{require('$pj').version||''}catch(e){''}")
  private_=$(node -p "try{require('$pj').private?'1':''}catch(e){''}")

  [[ -n "$name" ]]   || return 0
  [[ -z "$private_" ]] || return 0
  if [[ -n "$ONLY" && "$name" != *"$ONLY"* ]]; then return 0; fi

  head_ "$name@$ver"
  echo "  ${dir#$REPO_ROOT/}"

  local pkg_failed_before=$FAILED

  # -- 1. files field ------------------------------------------------------
  # Without `files`, npm ships everything not covered by .npmignore. That is how
  # test fixtures, .env files and internal notes reach the registry.
  local has_files
  has_files=$(node -p "try{(require('$pj').files||[]).length?'1':''}catch(e){''}")
  if [[ -n "$has_files" ]]; then
    ok "files[] declared — the tarball is an allowlist, not a leftover"
  else
    bad "NO files[] field — npm would publish everything not in .npmignore"
  fi

  # -- 2. every bin target, statically ------------------------------------
  # Three separate ways a bin entry ships broken, and all three install cleanly:
  # the target may not exist, may not be executable, may have no shebang.
  local bins
  bins=$(node -p "try{Object.entries(require('$pj').bin||{}).map(([k,v])=>k+'='+v).join('\n')}catch(e){''}")
  if [[ -n "$bins" ]]; then
    local nbin=0 nbad=0
    while IFS= read -r entry; do
      [[ -n "$entry" ]] || continue
      nbin=$((nbin+1))
      local bname="${entry%%=*}" bpath="${entry#*=}"
      local full="$dir/$bpath"
      if [[ ! -f "$full" ]]; then
        bad "bin '$bname' → $bpath  DOES NOT EXIST"; nbad=$((nbad+1)); continue
      fi
      if [[ ! -x "$full" ]]; then
        bad "bin '$bname' → $bpath  not executable"; nbad=$((nbad+1)); continue
      fi
      if [[ "$(head -c 2 "$full")" != "#!" ]]; then
        bad "bin '$bname' → $bpath  no shebang"; nbad=$((nbad+1)); continue
      fi
    done <<< "$bins"
    [[ "$nbad" -eq 0 ]] && ok "$nbin bin entries: all exist, executable, shebanged"
  else
    ok "no bin entries"
  fi

  # -- 3. version not already on the registry -----------------------------
  # Republishing an existing version fails anyway, but failing HERE means the
  # version bump was forgotten, which is worth saying plainly.
  if npm view "$name@$ver" version >/dev/null 2>&1; then
    bad "$name@$ver is ALREADY on the registry — bump the version"
  else
    ok "$ver is not yet published"
  fi

  # -- 4. pack, install into a clean environment, RUN it -------------------
  # The part that matters. Everything above reads the repo; this reads what a
  # stranger actually receives.
  local tarball tmp
  tmp=$(mktemp -d -t slpub-XXXXXXXX)
  if ! tarball=$( (cd "$dir" && npm pack --silent 2>/dev/null) | tail -1 ); then
    bad "npm pack failed"; rm -rf "$tmp"; return 0
  fi
  mv "$dir/$tarball" "$tmp/" 2>/dev/null || cp "$dir/$tarball" "$tmp/"
  ok "packed $tarball ($(du -h "$tmp/$tarball" | cut -f1))"

  (
    cd "$tmp"
    # A pristine HOME so a global npm config or a cached credential cannot make
    # a broken package look installable.
    export HOME="$tmp/home"; mkdir -p "$HOME"
    npm init -y >/dev/null 2>&1
    npm install --no-audit --no-fund --silent "./$tarball" >/dev/null 2>&1
  ) || { bad "installing the packed tarball FAILED"; rm -rf "$tmp"; return 0; }
  ok "tarball installs into a clean project"

  # -- 5. run the primary command ------------------------------------------
  # This is the check that would have caught the 2026-09-10 hang. A bin that
  # hangs installs perfectly; only running it tells you.
  if [[ -n "$bins" ]]; then
    while IFS= read -r entry; do
      [[ -n "$entry" ]] || continue
      local bname="${entry%%=*}"
      local shim="$tmp/node_modules/.bin/$bname"
      [[ -x "$shim" ]] || { bad "shim .bin/$bname missing after install"; continue; }

      # Only the package's own headline command is a hard gate. Running all 41
      # tailers is slow and several legitimately start work rather than print
      # help; those are reported, not blocked.
      local hard=0
      case "$bname" in
        superlog|superlog-mcp) hard=1 ;;
      esac

      local out rc=0
      out=$(run_limited "$RUN_TIMEOUT" "$shim" --help 2>&1) || rc=$?
      if [[ "$rc" -eq 137 ]]; then
        if [[ "$hard" -eq 1 ]]; then
          bad "'$bname --help' DID NOT TERMINATE in ${RUN_TIMEOUT}s — this is the hang"
        else
          warn "'$bname --help' did not terminate in ${RUN_TIMEOUT}s (not gating)"
        fi
      elif [[ -z "$out" ]]; then
        if [[ "$hard" -eq 1 ]]; then
          bad "'$bname --help' produced NO OUTPUT"
        else
          warn "'$bname --help' produced no output (not gating)"
        fi
      elif [[ "$hard" -eq 1 ]]; then
        ok "'$bname --help' responds ($(wc -l <<< "$out" | tr -d ' ') lines)"
      fi
    done <<< "$bins"
  fi

  rm -rf "$tmp"

  # -- 6. publish, only if this package passed everything -----------------
  if [[ "$DO_PUBLISH" -eq 1 ]]; then
    if [[ "$FAILED" -gt "$pkg_failed_before" ]]; then
      bad "NOT PUBLISHING $name@$ver — it failed a check above"
    else
      local access="public"
      echo "  publishing…"
      (cd "$dir" && npm publish --access "$access") && ok "PUBLISHED $name@$ver"
    fi
  fi
}

for d in "${PKG_DIRS[@]}"; do
  check_package "$d"
done

# --------------------------------------------------------------- verdict

head_ "Verdict"
echo "  failures: $FAILED    warnings: $WARNED"
if [[ "$FAILED" -gt 0 ]]; then
  echo
  echo "  ${RED}REFUSING.${NC} npm unpublish is restricted after 72 hours, so a bad publish"
  echo "  is effectively permanent. Fix the failures above and re-run."
  exit 1
fi
if [[ "$DO_PUBLISH" -eq 0 ]]; then
  echo "  ${GRN}All checks pass.${NC} Re-run with --publish to publish."
else
  echo "  ${GRN}Done.${NC}"
fi
