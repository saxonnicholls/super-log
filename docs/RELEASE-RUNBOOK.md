# Releasing super-log

Copyright 2026 Saxon Herschel Nicholls

One workflow does the whole release. This file is the part a person still has
to do, and nothing else.

## Cutting a release

```sh
./scripts/check_versions.sh 0.5.3     # must pass before the tag exists
git tag v0.5.3 && git push origin v0.5.3
```

That is all. The workflow then, on its own:

| Job | What it proves |
| --- | --- |
| `gate` | the tag and all nine hardcoded versions agree |
| `macos-pkg` | builds the universal `.pkg`, **installs it on macos-15 and runs the binary** — which is Apple Silicon, so this is the arm64 slice executing |
| `linux-packages` | builds four artefacts, **installs the arm64 `.deb` under arm64 and requires `/healthz` to answer** (the Raspberry Pi leg), installs the amd64 one, and checks an older Debian *refuses* the package rather than installing a binary that cannot run |
| `publish` | uploads five artefacts + `SHA256SUMS`, then re-reads the release to confirm they arrived — as a **prerelease** |
| `npm` | publishes both npm packages and waits for the registry to actually serve them |
| `promote` | re-proves all of it from outside, then marks the release **latest** |

**A release is only `latest` if `promote` ran.** That is deliberate. Before
2026-11-19 the release was marked latest by `publish`, which runs *before*
npm — so when the npm leg failed on the 15th, v0.5.2 sat on the releases page
looking finished while the registry went on serving 0.4.x for a week. A
release that is missing a leg now looks missing.

## The one thing that is not automated

**npm will refuse to publish until this is done once per package.** It has
been the blocker since 2026-11-12.

The symptom in the log is misleading, so recognise it: the OIDC exchange
succeeds, the provenance statement is signed and published to the sigstore
transparency log, and *then* the upload fails with

```
npm error 404 Not Found - PUT https://registry.npmjs.org/@super-log%2ftailers
```

npm answers a missing Trusted Publisher with **404, not 403**, so as not to
leak whether a package exists. It reads as "no such package" and means "this
workflow is not authorised".

**Decided, Saxon 2026-11-19: Trusted Publishing is the route.** (b) below stays
in the workflow as a fallback for the day (a) is unavailable, so that one
setting on a website is never again the single thing standing between a built
release and the registry — but it is not the plan, and a token should be
removed once (a) is in place.

**(a) Trusted Publishing** — do this for **both** packages:

1. npmjs.com → `@super-log/tailers` → Settings → Trusted Publisher
2. Publisher **GitHub Actions**, repository **saxonnicholls/super-log**,
   workflow **`.github/workflows/release.yml`**
3. Repeat for `@super-log/mcp`

**(b) Automation token** — one token covers both, if (a) is awkward:

1. npmjs.com → Access Tokens → **Granular**, read+write on
   `@super-log/tailers` and `@super-log/mcp`
2. Add it to this repo as the secret **`NPM_TOKEN`**

The workflow prefers OIDC and uses the token only if `NPM_TOKEN` exists, and
says in the log which one it used.

## Finishing a release whose npm leg failed

The workflow is re-runnable and idempotent: `publish` uploads only assets the
release does not already have (GitHub releases here are **immutable**, so
`--clobber` would try to delete first and be refused with HTTP 422), and the
npm step treats an already-published version as success.

So after doing the step above:

```sh
gh workflow run release.yml -f tag=v0.5.2     # or re-run the failed run
```

`promote` will then mark it latest once the registry actually serves both
packages.

## What a stranger installs

```sh
curl -fsSL https://super-log.com/install.sh | sh
```

It detects OS and architecture, walks the releases for the newest one carrying
**both** a matching artefact and `SHA256SUMS` (`/releases/latest` excludes
prereleases, and once answered v0.4.0, which has no checksums at all),
verifies the download, and refuses to install anything unverified.

Verified 2026-11-19 against the live API: Darwin/arm64, Linux x86_64 `.deb`,
Linux aarch64 `.deb` and Linux aarch64 `.rpm` all resolve to v0.5.2 and the
correct asset, and the published 74 MB `.pkg` hashes to the `54bf8934…` in
`SHA256SUMS`.
