# PPA — `apt install super-log` on Ubuntu, built by Launchpad

This is the source package that puts super-log in a **PPA**, so users get:

```sh
sudo add-apt-repository ppa:<owner>/super-log
sudo apt update && sudo apt install super-log
```

Launchpad builds the binaries for every supported Ubuntu series **and every
architecture** — including the `arm64`/`armhf` a Raspberry Pi needs — so you
never touch a Pi or an x86 box to ship for one.

## Why a source package (and why vendored)

Launchpad builders have **no network**. super-log's build normally fetches
two things — ts-moveables (by pinned commit) and the `fmt`/`spdlog`/`json`
submodules — so the orig tarball here **bundles all of them**, and
`debian/rules` builds with `FETCHCONTENT_FULLY_DISCONNECTED=ON` so a stray
fetch is a hard error, not a silent call. Verified: the hub builds with the
network off (`packaging/ppa` was developed against a `--network none` build).

## What you need first (once)

- A **Launchpad account** and a **PPA** (see the owner decision below).
- A **GPG key** registered on Launchpad, and the **Ubuntu Code of Conduct**
  signed. The source upload is signed with that key — the *same* key as the
  release / apt-repo / rpm-repo signing, so it all folds into one key.
- Tooling on a Debian/Ubuntu box (or container): `sudo apt install devscripts
  debhelper dput`.

## Owner: a team PPA is recommended over a personal one

Prefer a **team-owned** PPA — create a Launchpad team `super-log`, then its
PPA is `ppa:super-log/stable`:

- It reads as a **project channel**, not a person (`ppa:super-log/stable`
  beats `ppa:yourname/super-log`) — the "own the noun" posture.
- **Co-maintainers** can upload, and it **survives** any one person moving on.
- Room to grow: `ppa:super-log/stable` today, `ppa:super-log/edge` later.

You still sign uploads with your personal GPG key (as a team member). If the
team name is taken, a personal PPA works identically — only the `add-apt-
repository` line changes.

## Build and upload

From a Debian/Ubuntu box with this repo checked out (the `debian/` dir lives
in `packaging/ppa/`, so copy it to the tree root for the build):

```sh
# 1. Assemble the network-free orig tarball (needs the sibling ts-moveables
#    checkout; run from the repo root). Writes ../super-log_<ver>.orig.tar.gz
sh packaging/ppa/make-orig-tarball.sh

# 2. Put debian/ at the root of a matching source tree and build the SOURCE
#    package (‑S = source only, what a PPA takes; ‑sa includes the orig).
cp -r packaging/ppa/debian .
debuild -S -sa -k<YOUR_GPG_KEYID>

# 3. Upload to your PPA. Launchpad emails you when each arch has built.
dput ppa:<owner>/super-log ../super-log_<ver>-1~noble1_source.changes
```

### More than one Ubuntu series

A `.changes` targets one series (the `debian/changelog` distribution — here
`noble`, 24.04). For another series, copy the top changelog entry with a new
`~seriesN` version and its distribution (e.g. `0.4.0-1~jammy1` / `jammy`),
rebuild `-S`, and `dput` again. Launchpad keeps them side by side.

## Once it is live

```sh
sudo add-apt-repository ppa:<owner>/super-log
sudo apt update && sudo apt install super-log
```

The next step toward being *in Debian proper* (no PPA needed) reuses this
exact source package — the vendoring is the hard part, and it is done. See
the commercial `07-linux-standard.md` for the Debian-archive plan.
