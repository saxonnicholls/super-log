(*
   clock.ml - the OCaml demo client.

   Copyright 2026 Saxon Herschel Nicholls
   SPDX-License-Identifier: MIT

   The same clock every other demo client runs, once a second on
   ocaml.clock: the tick at INFO, a DEBUG pricing pass, a real ERROR when
   the pricer meets the symbol it has no rate for, and an uptime metric -
   so the stream demonstrates levels, fields and metrics rather than a
   heartbeat.

     SUPERLOG_MODE=development \
       ocamlc -I +unix unix.cma superlog.ml clock.ml -o clock && ./clock
     ./clock --ticks 6        # stop after six, for scripts
*)

let rates = [ ("BTC", 64000.0); ("ETH", 3200.0) ]

let price_for symbol qty =
  match List.assoc_opt symbol rates with
  | Some r -> Some (r *. float_of_int qty)
  | None -> None

let () =
  let max_ticks =
    let rec find = function
      | "--ticks" :: n :: _ -> (try int_of_string n with _ -> 0)
      | _ :: rest -> find rest
      | [] -> 0
    in
    find (Array.to_list Sys.argv)
  in
  let log = Superlog.create ~topic:"ocaml.clock" ~app:"clock" () in
  let stop = ref false in
  Sys.set_signal Sys.sigint (Sys.Signal_handle (fun _ -> stop := true));
  print_endline "superlog: ocaml clock -> ocaml.clock";
  Superlog.info log "ocaml clock up - one line a second"
    ~fields:[ ("ocaml", Sys.ocaml_version) ];

  let tick = ref 0 in
  while (not !stop) && (max_ticks = 0 || !tick < max_ticks) do
    incr tick;
    let t = Unix.gmtime (Unix.time ()) in
    Superlog.info log
      (Printf.sprintf "tick %d - the time is %02d:%02d:%02dZ"
         !tick t.Unix.tm_hour t.Unix.tm_min t.Unix.tm_sec)
      ~fields:[ ("tick", string_of_int !tick) ];

    (* The pricing pass: mostly fine, and honestly wrong every 7th tick -
       the same failure every other clock stages, so one error lines up
       across every language on the bench. *)
    let symbol = if !tick mod 7 = 0 then "DOGE" else "BTC" in
    (match price_for symbol 2 with
     | Some p ->
         Superlog.debug log (Printf.sprintf "pricing pass %d" !tick)
           ~fields:[ ("symbol", symbol); ("price", Printf.sprintf "%.1f" p) ]
     | None ->
         Superlog.error log
           (Printf.sprintf "pricing failed on tick %d: no rate for %s" !tick symbol)
           ~fields:[ ("symbol", symbol); ("tick", string_of_int !tick) ]);

    if !tick mod 5 = 0 then
      Superlog.metric log "clock.uptime_s" (float_of_int !tick);

    Superlog.flush log;
    Unix.sleepf 1.0
  done;
  Superlog.info log "ocaml clock stopping";
  Superlog.flush log
