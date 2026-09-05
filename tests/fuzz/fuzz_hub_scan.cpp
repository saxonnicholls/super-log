//
//  tests/fuzz/fuzz_hub_scan.cpp - libFuzzer target for the hub's scanners.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  The only code in superlogd that reads hostile bytes with any logic at
//  all is the set of targeted scanners in hub/src/main.cpp: string_field
//  (level/trace extraction), level_of, trace_of, and
//  embeddable_json_object. Everything else relays bytes verbatim. So they
//  are the entire fuzz surface, and they are pure functions - no I/O, no
//  state - which is what makes coverage-guided fuzzing honest here.
//
//  This target includes the REAL main.cpp rather than a copy, for the same
//  reason the test suite drives real subprocesses: testing a refactored
//  copy proves nothing about the thing that ships. Renaming main() is the
//  price of that choice and is confined to this file.
//
//  Status: WRITTEN, NOT WIRED INTO CI - see README.md in this directory
//  for the build recipe and what stands between this file and a CI job.
//

// Pull in the shipping translation unit; its main() must not collide with
// the fuzzer's own driver.
#define main superlogd_fuzz_shadowed_main
#include "../../hub/src/main.cpp"
#undef main

#include <cstddef>
#include <cstdint>
#include <string>

extern "C" int LLVMFuzzerTestOneInput(const std::uint8_t* data, std::size_t size)
{
    const std::string line(reinterpret_cast<const char*>(data), size);

    // The exact calls the ingest route makes per line, in the same order.
    (void)level_of(line);
    (void)trace_of(line);
    (void)embeddable_json_object(line);

    // string_field with a key the input can collide with, since the needle
    // itself is part of the parse state machine.
    (void)string_field(line, "level");
    (void)string_field(line, "msg");
    return 0;
}
