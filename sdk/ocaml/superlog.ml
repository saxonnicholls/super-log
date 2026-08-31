(*
   superlog.ml - the OCaml client, over Unix sockets and nothing else.

   Copyright 2026 Saxon Herschel Nicholls
   SPDX-License-Identifier: MIT

   Zero dependencies beyond the unix library that ships with the compiler,
   like the Fortran client: a hand-built HTTP POST of NDJSON events. The
   mode comes from SUPERLOG_MODE (development | production) and there is NO
   default, because deciding is the point - unset refuses to start, and
   production sends nothing at all: an inert shell, per the house rule.

     ocamlc -I +unix unix.cma superlog.ml yourapp.ml -o yourapp

   Failures never reach the caller: a logger that can take down the program
   it observes is worse than no logger, so a hub that is down just means
   the next batch counts again.
*)

type t = {
  host : string;
  port : int;
  topic : string;
  app : string;
  device : string;
  session : string;
  mutable seq : int;
  mutable buffer : string list;   (* newest first; reversed at flush *)
  active : bool;
}

let mode () =
  match try Some (Sys.getenv "SUPERLOG_MODE") with Not_found -> None with
  | Some "development" -> `Development
  | Some "production" -> `Production
  | Some other ->
      prerr_endline ("superlog: SUPERLOG_MODE is '" ^ other ^
                     "' - it must be development or production");
      exit 2
  | None ->
      prerr_endline
        "superlog: SUPERLOG_MODE is unset. Declare development or production -\n\
         there is no default, because deciding is the point.";
      exit 2

(* http://host:port with defaults; anything unparseable falls back rather
   than crashing the host program over a URL. *)
let parse_url u =
  let u = try Sys.getenv "SUPER_LOG_URL" with Not_found -> u in
  let stripped =
    if String.length u > 7 && String.sub u 0 7 = "http://"
    then String.sub u 7 (String.length u - 7) else u in
  match String.index_opt stripped ':' with
  | Some i ->
      let host = String.sub stripped 0 i in
      let rest = String.sub stripped (i + 1) (String.length stripped - i - 1) in
      let port = try int_of_string (List.hd (String.split_on_char '/' rest))
                 with _ -> 7333 in
      (host, port)
  | None -> ((if stripped = "" then "127.0.0.1" else stripped), 7333)

let json_escape s =
  let b = Buffer.create (String.length s + 8) in
  String.iter (fun c ->
    match c with
    | '"' -> Buffer.add_string b "\\\""
    | '\\' -> Buffer.add_string b "\\\\"
    | '\n' -> Buffer.add_string b "\\n"
    | '\r' -> Buffer.add_string b "\\r"
    | '\t' -> Buffer.add_string b "\\t"
    | c when Char.code c < 0x20 ->
        Buffer.add_string b (Printf.sprintf "\\u%04x" (Char.code c))
    | c -> Buffer.add_char b c) s;
  Buffer.contents b

let iso_now () =
  let t = Unix.gettimeofday () in
  let tm = Unix.gmtime t in
  Printf.sprintf "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ"
    (tm.Unix.tm_year + 1900) (tm.Unix.tm_mon + 1) tm.Unix.tm_mday
    tm.Unix.tm_hour tm.Unix.tm_min tm.Unix.tm_sec
    (int_of_float ((t -. Float.of_int (int_of_float t)) *. 1000.))

let create ?(url = "http://127.0.0.1:7333") ~topic ~app () =
  let active = match mode () with `Development -> true | `Production -> false in
  let host, port = parse_url url in
  {
    host; port; topic; app;
    device = (try Unix.gethostname () with _ -> "ocaml");
    session = Printf.sprintf "%08x" (Random.self_init (); Random.bits () land 0xffffffff);
    seq = 0; buffer = []; active;
  }

(* One TCP connection per flush: a clock at one line a second batches into
   a handful of POSTs a minute, and holding a socket open buys nothing at
   that rate. Errors are swallowed whole - see the header. *)
let flush t =
  if t.active && t.buffer <> [] then begin
    let body = String.concat "\n" (List.rev t.buffer) in
    t.buffer <- [];
    try
      let addr = Unix.ADDR_INET ((Unix.gethostbyname t.host).Unix.h_addr_list.(0), t.port) in
      let sock = Unix.socket Unix.PF_INET Unix.SOCK_STREAM 0 in
      (try
        Unix.connect sock addr;
        let req = Printf.sprintf
          "POST /ingest/%s HTTP/1.1\r\nHost: %s\r\nContent-Type: application/x-ndjson\r\n\
           Content-Length: %d\r\nConnection: close\r\n\r\n%s"
          t.topic t.host (String.length body) body in
        ignore (Unix.write_substring sock req 0 (String.length req));
        (* Read and discard the reply so the hub never sees a reset mid-answer. *)
        let buf = Bytes.create 256 in
        ignore (try Unix.read sock buf 0 256 with _ -> 0)
      with _ -> ());
      Unix.close sock
    with _ -> ()                    (* hub down; the next batch counts again *)
  end

let log ?(fields = []) ?metric t level msg =
  if t.active then begin
    let field_json =
      match fields with
      | [] -> ""
      | fs ->
          ",\"fields\":{" ^
          String.concat ","
            (List.map (fun (k, v) ->
               "\"" ^ json_escape k ^ "\":\"" ^ json_escape v ^ "\"") fs) ^ "}"
    in
    let metric_json =
      match metric with
      | None -> ""
      | Some (name, value) ->
          Printf.sprintf ",\"metric\":{\"name\":\"%s\",\"value\":%g}"
            (json_escape name) value
    in
    let line = Printf.sprintf
      "{\"v\":1,\"ts\":\"%s\",\"seq\":%d,\"session\":\"%s\",\"level\":\"%s\",\
       \"origin\":{\"runtime\":\"ocaml\",\"app\":\"%s\",\"platform\":\"host\",\"device\":\"%s\"},\
       \"tag\":\"%s\",\"msg\":\"%s\"%s%s}"
      (iso_now ()) t.seq t.session level (json_escape t.app)
      (json_escape t.device) (json_escape t.app) (json_escape msg)
      metric_json field_json in
    t.seq <- t.seq + 1;
    t.buffer <- line :: t.buffer;
    if List.length t.buffer >= 16 then flush t
  end

let debug ?fields t msg = log ?fields t "DEBUG" msg
let info ?fields t msg = log ?fields t "INFO" msg
let warn ?fields t msg = log ?fields t "WARN" msg
let error ?fields t msg = log ?fields t "ERROR" msg
let metric t name value =
  log t "DEBUG" (Printf.sprintf "%s =%g" name value) ~metric:(name, value)
