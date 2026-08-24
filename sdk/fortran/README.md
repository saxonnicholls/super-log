# super-log for Fortran

A solver is the hardest program on the bench to observe. It runs for hours,
often on a machine you cannot attach to, and when it goes wrong the evidence
is a slurm file nobody reads until the allocation has already been spent.

This client puts a running solver on the same viewer as everything else —
one line a second, or a residual per step, next to the database, the build
and the browser console.

```fortran
use superlog

call sl_init(topic='fortran.solver', app='solver')
call sl_info('starting sweep', 'nx', '512')

do step = 1, nsteps
   call sl_set_trace(sl_new_trace())
   call sl_metric('solver.residual', residual)
   if (residual /= residual) call sl_error('residual is NaN', 'step', itoa(step))
end do

call sl_close()
```

## Building

Exactly one mode must be defined. Neither and both are compile errors, not
warnings — a logging pipeline you *think* is off is worse than one that
refuses to build until you have decided.

```sh
gfortran -cpp -DDEVELOPMENT superlog.F90 yours.f90 -o yours    # everything
gfortran -cpp -DPRODUCTION  superlog.F90 yours.f90 -o yours    # nothing, by default
```

`-cpp` is required: the mode check and the platform differences are handled
by the preprocessor, which is why the file is `.F90` and not `.f90`.

Production defaults to **OFF**. Log lines leaving a production run are a
decision for whoever owns that machine, so nothing here makes it for you.
To turn some back on, pass a level rank:

```sh
gfortran -cpp -DPRODUCTION -DSUPERLOG_PROD_POLICY=5 ...   # ERROR and CRITICAL
```

Ranks are `1 TRACE, 2 DEBUG, 3 INFO, 4 WARN, 5 ERROR, 6 CRITICAL, 7 OFF`.
An inert client prints one line to stderr saying so, because otherwise it
is indistinguishable from a broken one — nothing arrives, nothing is
dropped, and the counters read as healthy.

## Pointing it at a hub

`SUPER_LOG_URL` wins over anything compiled in, so a batch script can
redirect a run without rebuilding it:

```sh
SUPER_LOG_URL=http://bench.local:7333 srun ./solver
```

Otherwise `sl_init(host=..., port=...)`, defaulting to `127.0.0.1:7333`.
Hostnames resolve through `gethostbyname`, so a compute node can stream to
a hub that is named rather than numbered.

## What it does and does not do

It speaks HTTP straight down a POSIX socket through `ISO_C_BINDING`. No
libcurl, no libraries at all — the house rule for every SDK here, and it
matters more in Fortran than anywhere else, because HPC sites are exactly
where "just add a dependency" becomes a fortnight with the module system.

Events go into a fixed ring of 512. When it fills, the **oldest** are
dropped and counted (`sl_dropped()`), because the newest events are the
ones describing whatever is going wrong right now.

There is no background thread — Fortran has no portable threading, and
adding OpenMP to a logger would be a strange thing to make a caller link
against. So `sl_flush()` sends on the calling thread and **does block**,
for as long as one POST to the hub takes. The socket carries a two-second
send timeout so a bench that has gone away cannot stall a solver
indefinitely, and `SIGPIPE` is ignored at init so a hub disappearing
mid-write cannot kill a run twelve hours in. The ring drains itself when it
is half full; call `sl_flush()` yourself at a natural boundary — the end of
a timestep is the usual one.

## The API

| Call | Notes |
|---|---|
| `sl_init(topic, app, host, port, quiet)` | all optional; called implicitly on first log |
| `sl_trace/debug/info/warn/error/critical(msg, k, v)` | one optional key/value pair |
| `sl_log(level, msg, k1, v1, k2, v2)` | two pairs, explicit level |
| `sl_metric(name, value)` | `real64`; NaN and infinities become `0` with `fields.value="NaN"`, since JSON can express neither |
| `sl_set_trace(id)` / `sl_new_trace()` | correlation id carried on every following event |
| `sl_flush()` / `sl_close()` | `sl_close` flushes |
| `sl_status()` / `sl_dropped()` | the first thing to check when events are not arriving |

Level constants are `SL_LVL_INFO` and friends rather than `SL_INFO`,
because Fortran is case-insensitive and `SL_INFO` would collide with the
`sl_info` subroutine.

## The demo

```sh
cd demo/fortran
gfortran -cpp -DDEVELOPMENT ../../sdk/fortran/superlog.F90 clock.f90 -o clock
./clock              # one line a second on fortran.clock, residual per step
./clock --diverge    # residual grows until it trips an ERROR; exits 1
```
