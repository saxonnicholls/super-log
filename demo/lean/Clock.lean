/-
  Clock.lean - the Lean 4 demo client.

  Copyright 2026 Saxon Herschel Nicholls
  SPDX-License-Identifier: MIT

  The same clock every other demo client runs, once a second on
  lean.clock: the tick at INFO, a DEBUG pricing pass, a real ERROR when
  the pricer meets the symbol it has no rate for, and an uptime metric.

    SUPERLOG_MODE=development lake exe clock
    lake exe clock -- --ticks 6      # stop after six, for scripts

  Lean core has no signal handling, so Ctrl-C is abrupt - the clock
  flushes every tick, so a kill loses at most the tick in flight.
-/

import Superlog

def rates : List (String × Float) := [("BTC", 64000.0), ("ETH", 3200.0)]

def priceFor (symbol : String) : Option Float :=
  (rates.find? fun (s, _) => s == symbol).map (·.2)

def main (args : List String) : IO Unit := do
  -- lake forwards a literal "--" when args are given as `lake exe clock --
  -- --ticks 6`; tolerate both spellings.
  let args := if args.head? == some "--" then args.tail else args
  let maxTicks := match args with
    | "--ticks" :: n :: _ => n.toNat!
    | _ => 0

  let lg ← Superlog.init "lean.clock" "clock"
  IO.println "superlog: lean clock -> lean.clock"
  Superlog.info lg "lean clock up - one line a second" [("runtime", "lean4")]

  let mut tick := 0
  while maxTicks == 0 || tick < maxTicks do
    tick := tick + 1
    let ts ← Superlog.nowHMS
    Superlog.info lg s!"tick {tick} - the time is {ts}" [("tick", toString tick)]

    -- Honestly wrong every 7th tick, the same staged failure as every
    -- other clock, so one error lines up across every language.
    let symbol := if tick % 7 == 0 then "DOGE" else "BTC"
    match priceFor symbol with
    | some rate =>
        Superlog.debug lg s!"pricing pass {tick}"
          [("symbol", symbol), ("price", toString (rate * 2))]
    | none =>
        Superlog.error lg s!"pricing failed on tick {tick}: no rate for {symbol}"
          [("symbol", symbol), ("tick", toString tick)]

    if tick % 5 == 0 then
      Superlog.metric lg "clock.uptime_s" (Float.ofNat tick)

    Superlog.flush lg
    IO.sleep 1000

  Superlog.info lg "lean clock stopping"
  Superlog.flush lg
