# Fuzzing the hub's scanners

**Status: the target is WRITTEN and syntax-verified against the real
ts-moveables headers; it is NOT yet wired into CMake or CI.** This file
says exactly what is left, so the gap is a task and not a mystery.

## What is fuzzed, and why only this

`superlogd` relays ingested bytes verbatim. The only code that applies
logic to hostile input is the set of targeted scanners in
`hub/src/main.cpp` — `string_field`, `level_of`, `trace_of`,
`embeddable_json_object` — so they are the entire fuzz surface.
`fuzz_hub_scan.cpp` includes the real translation unit (renaming `main`)
rather than copying the functions out: a fuzzer over a refactored copy
proves nothing about the binary that ships.

The end-to-end behaviour of the same path is already covered, verified,
by `tests/hostile-corpus.test.mjs`, which drives a real hub over real
HTTP. The libFuzzer target adds coverage-guided depth to the same
functions, not a different claim.

## Running it (Linux, clang — the CI shape)

Apple clang ships no libFuzzer; use Ubuntu clang, the same toolchain the
`sanitizers` CI job already uses.

```sh
clang++ -std=c++17 -g -fsanitize=fuzzer,address,undefined \
    -DSUPERLOG_VERSION='"fuzz"' \
    -I <ts-moveables>/TSMoveables \
    tests/fuzz/fuzz_hub_scan.cpp -o fuzz_hub_scan

mkdir -p tests/fuzz/corpus
# Seed with the same hostile lines the integration suite uses - one file
# per line so libFuzzer can mutate them independently.
awk '{ print > ("tests/fuzz/corpus/seed-" NR) }' tests/fixtures/hostile-corpus.ndjson

./fuzz_hub_scan -max_len=4096 tests/fuzz/corpus
```

## What stands between this and CI

1. A CMake target (`superlog_fuzz_scan`) guarded behind
   `-DSUPER_LOG_BUILD_FUZZERS=ON`, mirroring `superlogd`'s include set
   plus `-fsanitize=fuzzer,address,undefined`. Not added yet: the root
   CMakeLists is shared surface, and a fuzz flag deserves its own
   reviewed change rather than riding along with a test commit.
2. A short CI job (Ubuntu, clang) that builds the target and runs it for
   a bounded budget (`-runs=200000` is minutes, not hours) over the
   seeded corpus, uploading any crash artifact.
3. Corpus persistence between runs (actions/cache keyed on the corpus
   dir), so coverage accumulates instead of restarting.

Until those land, the changelog and the public security paper must keep
calling fuzzing "written, not wired" — the same rule as every other
capability in this repo: VERIFIED means it runs, and this does not run
in CI yet.
