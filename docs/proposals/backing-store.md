# Proposal: a backing store for the feed (`superlog-store`)

Status: **v1 done** — SQLite and Postgres both verified (Postgres live over mTLS
against a real server). MySQL + ClickHouse next; RocksDB out.

## The idea

Optionally persist the feed into an external database — SQLite, Postgres,
MySQL, ClickHouse — so the bench's history lives somewhere queryable beside the
NDJSON journal. It **auto-starts** when the config is present in `.env`, and it
adds **no dependency of ours**: it writes through the database's own CLI client
(`sqlite3`, `psql`, `mysql`, `clickhouse-client`), which the user installs. The
empty-SBOM promise holds — the dependency is theirs, invoked as a subprocess,
exactly as the tailers already shell out to `git`, `docker`, `dmidecode`.

"File" (#1 on the wishlist) already exists — the **journal** (`superlog-journal`,
append-only NDJSON, read by `search_history`). This proposal is the *external
database* case.

## Where it sits: an outlet tailer that tails the journal

`superlog-store` is a Node tailer, sibling to `superlog-otlp-export`. **The hub
stays pure** — no database code in C++.

It reads the **journal**, not `/ws`. This matters:

- The journal is the **complete** on-disk record; `/ws` is dropped to slow
  subscribers, so a store on `/ws` would lose events under load and add firehose
  load to the hub. Tailing the journal loses nothing to backpressure and touches
  the hub not at all.
- It **resumes from a persisted cursor** (`{epoch, file, offset}` in
  `~/.superlog/store-<name>.cursor`), so a restart neither re-writes nor skips.
- Default is **tail from now** (like the watchers' silent baseline); `--from-start`
  replays the whole journal into the DB.

## The honest ceiling = the upsell (not a crippled tier)

The free store is fully functional; its ceiling is physics — CLI-pipe throughput
× your DB × your disk — and it **reports that ceiling** rather than hiding it. On
`store.<backend>` it publishes DEBUG `metric` readings — rows/sec written, queue
depth, **lag (frames behind the journal head)** — and an edge-triggered **WARN
when it drops** (the journal rotated past the cursor before the DB drained). That
drop line is the upsell, stated by the bench itself: *"store lagging, N events
dropped — retain everything with super-log Cloud."* No dark pattern, no nagging;
the tool tells the truth and Cloud's pitch writes itself: managed ingest with no
ceiling, durable policy-based retention, fleet-wide, AI over full history.

**Licence: MIT.** This is BYO-database self-hosting, the same category as the
OTLP export. Cloud's commercial value is *managed/hosted* retention + fleet, not
"can you write to a database."

## Schema — one wide table

```
superlog_events(
  epoch     TEXT,      -- hub lifetime id
  hub_seq   BIGINT,    -- frame sequence
  idx       INT,       -- event index within the frame's NDJSON payload
  ts_ms     BIGINT,    -- HUB ARRIVAL time (the orderable one)
  topic     TEXT,
  level     TEXT,
  session   TEXT,
  app       TEXT, device TEXT, platform TEXT, runtime TEXT,   -- from origin
  tag       TEXT,
  msg       TEXT,
  trace     TEXT,
  fields    <json>,    -- JSONB (pg) / JSON (mysql/ch) / TEXT (sqlite)
  event     <json>,    -- the whole event, verbatim
  PRIMARY KEY (epoch, hub_seq, idx)          -- idempotent: replay never dupes
)
-- indexes: (topic, ts_ms), (trace)
```

Created on start via the CLI if absent. The primary key makes writes idempotent
(`INSERT OR IGNORE` / `ON CONFLICT DO NOTHING`), so a cursor rewound after a
crash never double-writes.

## Write paths (raw SQL through the CLI)

- **SQLite:** a long-lived `sqlite3 <file>` process; batches written to its stdin
  as `BEGIN; INSERT OR IGNORE ...; COMMIT;`.
- **Postgres:** batched multi-row `INSERT ... ON CONFLICT DO NOTHING` piped to
  `psql -v ON_ERROR_STOP=1` (stdin). **Credentials via `psql`'s native env**
  (`PGHOST`/`PGUSER`/`PGPASSWORD`/`PGDATABASE`) or `SUPER_LOG_STORE_DSN` — our
  code never handles the password. (COPY is faster but has no `ON CONFLICT`;
  chosen against for v1 so idempotency is simple. Revisit COPY-into-staging for a
  high-throughput mode.)
- **MySQL / ClickHouse (next):** batched `INSERT` / `INSERT ... FORMAT CSV`.

Values are single-quote-escaped (`'` → `''`); with `standard_conforming_strings`
on (the default) that is sufficient for SQLite and Postgres alike. JSON columns
are the stringified event.

## Config (`.env`, gitignored)

```
SUPER_LOG_STORE=sqlite|postgres          # which backend (unset = inactive)
SUPER_LOG_STORE_SQLITE=/path/bench.db     # sqlite file
SUPER_LOG_STORE_DSN=postgresql://…        # or rely on PG* env
SUPER_LOG_STORE_TABLE=superlog_events     # optional
SUPER_LOG_STORE_TOPICS=build.,alert.      # optional filter (default: everything)
SUPER_LOG_STORE_LEVEL=INFO                # optional minimum level
```

**Auto-start:** `superlog-store` is a no-op unless `SUPER_LOG_STORE` is set and
the matching CLI is on PATH (it says so, once, and exits quiet). `install.sh` /
`superlog enable store` wires it as a login service when configured.

## Backpressure & safety

- Bounded in-memory batch queue, **drop-oldest** under pressure — a slow DB never
  stalls the tailer, and every drop is counted and surfaced (the upsell signal).
- The cursor advances only after a batch is durably written, so a crash rewinds
  to the last committed batch (and the PK dedupes the overlap).

## Scope

- **v1:** SQLite + Postgres, journal-tailing, cursor resume, `store.*` metrics,
  harness test. **MIT.**
- **Next:** MySQL, ClickHouse; a `--from-start` full backfill; optional COPY
  fast-path for Postgres.
- **Out:** RocksDB — a library with no streaming-insert CLI, so it can't be done
  within the zero-dependency promise without a linked driver or a helper binary.
  Documented, not built.
