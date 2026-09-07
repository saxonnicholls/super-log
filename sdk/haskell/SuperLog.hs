{-# LANGUAGE CPP #-}
--
--  SuperLog.hs - the Haskell client: GHC's boot libraries, plus curl.
--
--  Copyright 2026 Saxon Herschel Nicholls
--  SPDX-License-Identifier: MIT
--
--  base has no sockets and this repo takes no dependencies, so the wire is
--  curl - the same honest bargain the shell producer makes, and curl is on
--  every machine this bench will meet. Everything else is boot libraries
--  that ship inside GHC (process, time).
--
--  The mode is compile-time, like the C++ and Fortran clients:
--
--    ghc -DDEVELOPMENT ... SuperLog.hs yourapp.hs
--
--  Exactly one of -DDEVELOPMENT / -DPRODUCTION must be given; neither or
--  both refuses to compile, because deciding is the point. PRODUCTION
--  compiles to an inert shell that sends nothing at all.
--

module SuperLog
  ( Log, newLog, flushLog
  , logMsg, debug, info, warn, err, metric
  ) where

#if defined(DEVELOPMENT) && defined(PRODUCTION)
#error "declare DEVELOPMENT xor PRODUCTION, not both - deciding is the point"
#endif
#if !defined(DEVELOPMENT) && !defined(PRODUCTION)
#error "declare -DDEVELOPMENT or -DPRODUCTION - there is no default"
#endif

import Data.Char (isControl, ord)
import Data.IORef
import Data.List (intercalate)
import Data.Time.Clock (getCurrentTime)
import Data.Time.Format (defaultTimeLocale, formatTime)
import System.Environment (lookupEnv)
import System.Process (readProcessWithExitCode)
import Text.Printf (printf)

data Log = Log
  { lgUrl :: String
  , lgTopic :: String
  , lgApp :: String
  , lgDevice :: String
  , lgSession :: String
  , lgSeq :: IORef Int
  , lgBuf :: IORef [String]     -- newest first; reversed at flush
  }

newLog :: String -> String -> IO Log
newLog topic app = do
  url <- maybe "http://127.0.0.1:7333" id <$> lookupEnv "SUPER_LOG_URL"
  -- hostname(1) rather than a networking package: one call at startup.
  (_, hn, _) <- readProcessWithExitCode "hostname" ["-s"] ""
  now <- getCurrentTime
  let device = case lines hn of { (h:_) -> h; _ -> "haskell" }
      -- Picosecond digits are as random as a session id needs to be.
      session = take 8 (formatTime defaultTimeLocale "%q" now ++ "00000000")
  seqRef <- newIORef 0
  buf <- newIORef []
  pure (Log url topic app device session seqRef buf)

jsonEscape :: String -> String
jsonEscape = concatMap esc
  where
    esc '"' = "\\\""
    esc '\\' = "\\\\"
    esc '\n' = "\\n"
    esc '\r' = "\\r"
    esc '\t' = "\\t"
    esc c | isControl c = printf "\\u%04x" (ord c)
          | otherwise = [c]

isoNow :: IO String
isoNow = formatTime defaultTimeLocale "%Y-%m-%dT%H:%M:%SZ" <$> getCurrentTime

-- | One event; buffered, flushed every 16 or on flushLog. In PRODUCTION
-- this whole body compiles away to pure ().
logMsg :: Log -> String -> String -> [(String, String)] -> IO ()
#if defined(PRODUCTION)
logMsg _ _ _ _ = pure ()
#else
logMsg lg level msg fields = do
  ts <- isoNow
  n <- atomicModifyIORef' (lgSeq lg) (\s -> (s + 1, s))
  let fjson = case fields of
        [] -> ""
        fs -> ",\"fields\":{" ++
              intercalate "," [ "\"" ++ jsonEscape k ++ "\":\"" ++ jsonEscape v ++ "\""
                              | (k, v) <- fs ] ++ "}"
      line = concat
        [ "{\"v\":1,\"ts\":\"", ts, "\",\"seq\":", show n
        , ",\"session\":\"", lgSession lg
        , "\",\"level\":\"", level
        , "\",\"origin\":{\"runtime\":\"haskell\",\"app\":\"", jsonEscape (lgApp lg)
        , "\",\"platform\":\"host\",\"device\":\"", jsonEscape (lgDevice lg)
        , "\"},\"tag\":\"", jsonEscape (lgApp lg)
        , "\",\"msg\":\"", jsonEscape msg, "\"", fjson, "}" ]
  pending <- atomicModifyIORef' (lgBuf lg) (\b -> (line : b, length b + 1))
  if pending >= 16 then flushLog lg else pure ()
#endif

-- | POST the batch; a hub that is down means the next batch counts again,
-- never an exception in the host program.
flushLog :: Log -> IO ()
#if defined(PRODUCTION)
flushLog _ = pure ()
#else
flushLog lg = do
  batch <- atomicModifyIORef' (lgBuf lg) (\b -> ([], reverse b))
  case batch of
    [] -> pure ()
    ls -> do
      _ <- readProcessWithExitCode "curl"
             [ "-s", "-m", "5", "-o", "/dev/null"
             , "-X", "POST", lgUrl lg ++ "/ingest/" ++ lgTopic lg
             , "-H", "content-type: application/x-ndjson"
             , "--data-binary", intercalate "\n" ls ] ""
      pure ()
#endif

debug, info, warn, err :: Log -> String -> [(String, String)] -> IO ()
debug lg m = logMsg lg "DEBUG" m
info lg m = logMsg lg "INFO" m
warn lg m = logMsg lg "WARN" m
err lg m = logMsg lg "ERROR" m

-- | A reading for the chart: DEBUG, with the metric riding the event.
metric :: Log -> String -> Double -> IO ()
#if defined(PRODUCTION)
metric _ _ _ = pure ()
#else
metric lg name value = do
  ts <- isoNow
  n <- atomicModifyIORef' (lgSeq lg) (\s -> (s + 1, s))
  let line = concat
        [ "{\"v\":1,\"ts\":\"", ts, "\",\"seq\":", show n
        , ",\"session\":\"", lgSession lg
        , "\",\"level\":\"DEBUG\",\"origin\":{\"runtime\":\"haskell\",\"app\":\""
        , jsonEscape (lgApp lg), "\",\"platform\":\"host\",\"device\":\""
        , jsonEscape (lgDevice lg), "\"},\"tag\":\"", jsonEscape (lgApp lg)
        , "\",\"msg\":\"", jsonEscape name, " =", show value
        , "\",\"metric\":{\"name\":\"", jsonEscape name
        , "\",\"value\":", show value, "}}" ]
  pending <- atomicModifyIORef' (lgBuf lg) (\b -> (line : b, length b + 1))
  if pending >= 16 then flushLog lg else pure ()
#endif
