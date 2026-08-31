--
--  clock.hs - the Haskell demo client.
--
--  Copyright 2026 Saxon Herschel Nicholls
--  SPDX-License-Identifier: MIT
--
--  The same clock every other demo client runs, once a second on
--  haskell.clock: the tick at INFO, a DEBUG pricing pass, a real ERROR
--  when the pricer meets the symbol it has no rate for, and an uptime
--  metric every fifth tick.
--
--    ghc -DDEVELOPMENT -isdk/haskell -o clock demo/haskell/clock.hs && ./clock
--    ./clock --ticks 6        # stop after six, for scripts
--

import Control.Monad (forM_, when)
import Control.Concurrent (threadDelay)
import Data.Time.Clock (getCurrentTime)
import Data.Time.Format (defaultTimeLocale, formatTime)
import System.Environment (getArgs)

import SuperLog

rates :: [(String, Double)]
rates = [("BTC", 64000), ("ETH", 3200)]

main :: IO ()
main = do
  args <- getArgs
  let maxTicks = case dropWhile (/= "--ticks") args of
        (_ : n : _) -> maybe 0 id (readMaybe n)
        _ -> 0
      readMaybe s = case reads s of { [(v, "")] -> Just v; _ -> Nothing }

  lg <- newLog "haskell.clock" "clock"
  putStrLn "superlog: haskell clock -> haskell.clock"
  info lg "haskell clock up - one line a second" [("compiler", "ghc")]

  let ticks = if maxTicks > 0 then [1 .. maxTicks] else [1 ..]
  forM_ ticks $ \tick -> do
    now <- getCurrentTime
    let hms = formatTime defaultTimeLocale "%H:%M:%SZ" now
    info lg ("tick " ++ show tick ++ " - the time is " ++ hms)
            [("tick", show tick)]

    -- Honestly wrong every 7th tick, the same staged failure as every
    -- other clock, so one error lines up across every language.
    let symbol = if tick `mod` 7 == 0 then "DOGE" else "BTC"
    case lookup symbol rates of
      Just r -> debug lg ("pricing pass " ++ show tick)
                         [("symbol", symbol), ("price", show (r * 2))]
      Nothing -> err lg ("pricing failed on tick " ++ show tick ++
                         ": no rate for " ++ symbol)
                        [("symbol", symbol), ("tick", show tick)]

    when (tick `mod` 5 == 0) $ metric lg "clock.uptime_s" (fromIntegral tick)
    flushLog lg
    threadDelay 1000000

  info lg "haskell clock stopping" []
  flushLog lg
