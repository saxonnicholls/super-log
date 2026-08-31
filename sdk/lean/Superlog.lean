/-
  Superlog.lean - the Lean 4 client: core IO plus curl, nothing else.

  Copyright 2026 Saxon Herschel Nicholls
  SPDX-License-Identifier: MIT

  Lean's core library has no sockets, and this repo takes no dependencies -
  so the wire is curl, the shell producer's honest bargain, and the wall
  clock is date(1), because a proof checker's standard library grew a
  kernel before it grew strftime. Both are one subprocess per FLUSH, not
  per event, and a Lean job is long enough that neither will ever be the
  thing worth profiling.

    import Superlog

    def main : IO Unit := do
      let lg ← Superlog.init "lean.search" "search"
      Superlog.info lg "search up" [("depth", "12")]
      Superlog.metric lg "goals.open" 4123
      Superlog.flush lg

  The mode comes from SUPERLOG_MODE (development | production) with NO
  default, because deciding is the point - unset refuses to start, and
  production is an inert shell that sends nothing at all.

  Failures never reach the caller: a logger that can take down the proof
  it observes is worse than no logger. A hub that is down means the next
  batch counts again.
-/

namespace Superlog

structure Log where
  active : Bool
  url : String
  topic : String
  app : String
  device : String
  session : String
  seqRef : IO.Ref Nat
  buf : IO.Ref (Array String)

private def jsonEscape (s : String) : String :=
  s.foldl (init := "") fun acc c =>
    if c == '"' then acc ++ "\\\""
    else if c == '\\' then acc ++ "\\\\"
    else if c == '\n' then acc ++ "\\n"
    else if c == '\r' then acc ++ "\\r"
    else if c == '\t' then acc ++ "\\t"
    -- Other control characters become a space rather than a \u escape:
    -- they are vanishingly rare in a message and a wrong escape would cost
    -- the whole event.
    else if c.toNat < 0x20 then acc.push ' '
    else acc.push c

private def isoNow : IO String := do
  try
    let out ← IO.Process.output { cmd := "date", args := #["-u", "+%Y-%m-%dT%H:%M:%SZ"] }
    pure out.stdout.trimAscii.toString
  catch _ => pure "1970-01-01T00:00:00Z"   -- a wrong clock beats a lost event

/-- The wall clock as HH:MM:SSZ - what a demo wants to print. -/
def nowHMS : IO String := do
  try
    let out ← IO.Process.output { cmd := "date", args := #["-u", "+%H:%M:%SZ"] }
    pure out.stdout.trimAscii.toString
  catch _ => pure "??:??:??Z"

/-- Declare once; there is no default, because deciding is the point. -/
def init (topic app : String) : IO Log := do
  let active ← match (← IO.getEnv "SUPERLOG_MODE") with
    | some "development" => pure true
    | some "production"  => pure false
    | _ => do
        IO.eprintln "superlog: SUPERLOG_MODE is unset or unknown - declare development or production; there is no default, because deciding is the point."
        IO.Process.exit 2
  let url := (← IO.getEnv "SUPER_LOG_URL").getD "http://127.0.0.1:7333"
  let device ← try
      let h ← IO.Process.output { cmd := "hostname", args := #["-s"] }
      pure h.stdout.trimAscii.toString
    catch _ => pure "lean"
  let ns ← IO.monoNanosNow
  pure {
    active, url, topic, app, device,
    session := String.ofList (Nat.toDigits 16 (ns % 4294967296)),
    seqRef := ← IO.mkRef 0,
    buf := ← IO.mkRef #[],
  }

/-- One POST for whatever has accumulated. The body rides argv, exactly as
    the Haskell client does it - small batches, no pipe lifetime to manage. -/
def flush (lg : Log) : IO Unit := do
  unless lg.active do return
  let lines ← lg.buf.modifyGet fun b => (b, #[])
  if lines.isEmpty then return
  try
    let _ ← IO.Process.output {
      cmd := "curl",
      args := #["-s", "-m", "5", "-o", "/dev/null", "-X", "POST",
                s!"{lg.url}/ingest/{lg.topic}",
                "-H", "content-type: application/x-ndjson",
                "--data-binary", String.intercalate "\n" lines.toList] }
  catch _ => pure ()               -- hub down; the next batch counts again

def log (lg : Log) (level msg : String) (fields : List (String × String) := []) : IO Unit := do
  unless lg.active do return
  let ts ← isoNow
  let n ← lg.seqRef.modifyGet fun s => (s, s + 1)
  let fjson := match fields with
    | [] => ""
    | fs => ",\"fields\":{" ++
        String.intercalate "," (fs.map fun (k, v) =>
          "\"" ++ jsonEscape k ++ "\":\"" ++ jsonEscape v ++ "\"") ++ "}"
  let line :=
    "{\"v\":1,\"ts\":\"" ++ ts ++ "\",\"seq\":" ++ toString n ++
    ",\"session\":\"" ++ lg.session ++ "\",\"level\":\"" ++ level ++
    "\",\"origin\":{\"runtime\":\"lean\",\"app\":\"" ++ jsonEscape lg.app ++
    "\",\"platform\":\"host\",\"device\":\"" ++ jsonEscape lg.device ++
    "\"},\"tag\":\"" ++ jsonEscape lg.app ++
    "\",\"msg\":\"" ++ jsonEscape msg ++ "\"" ++ fjson ++ "}"
  let pending ← lg.buf.modifyGet fun b => (b.size + 1, b.push line)
  if pending ≥ 16 then flush lg

def trace (lg : Log) (msg : String) (fields : List (String × String) := []) : IO Unit :=
  log lg "TRACE" msg fields
def debug (lg : Log) (msg : String) (fields : List (String × String) := []) : IO Unit :=
  log lg "DEBUG" msg fields
def info (lg : Log) (msg : String) (fields : List (String × String) := []) : IO Unit :=
  log lg "INFO" msg fields
def warn (lg : Log) (msg : String) (fields : List (String × String) := []) : IO Unit :=
  log lg "WARN" msg fields
def error (lg : Log) (msg : String) (fields : List (String × String) := []) : IO Unit :=
  log lg "ERROR" msg fields

/-- A reading for the chart: DEBUG, with the metric riding the event. -/
def metric (lg : Log) (name : String) (value : Float) : IO Unit := do
  unless lg.active do return
  let ts ← isoNow
  let n ← lg.seqRef.modifyGet fun s => (s, s + 1)
  let line :=
    "{\"v\":1,\"ts\":\"" ++ ts ++ "\",\"seq\":" ++ toString n ++
    ",\"session\":\"" ++ lg.session ++
    "\",\"level\":\"DEBUG\",\"origin\":{\"runtime\":\"lean\",\"app\":\"" ++
    jsonEscape lg.app ++ "\",\"platform\":\"host\",\"device\":\"" ++
    jsonEscape lg.device ++ "\"},\"tag\":\"" ++ jsonEscape lg.app ++
    "\",\"msg\":\"" ++ jsonEscape name ++ " =" ++ toString value ++
    "\",\"metric\":{\"name\":\"" ++ jsonEscape name ++
    "\",\"value\":" ++ toString value ++ "}}"
  let pending ← lg.buf.modifyGet fun b => (b.size + 1, b.push line)
  if pending ≥ 16 then flush lg

end Superlog
