# super-log for Logback, Log4j 2 and SLF4J

The core Java SDK (`sdk/java/src`) compiles against **nothing** — that's the
zero-dependency, one-import-away promise. But most Java shops don't call a
logger directly; they route through **SLF4J**, **Logback** or **Log4j 2**. These
integrations reach that audience without breaking the core's zero-dependency
rule: each one compiles **only** against the logging library it bridges — the
same library the consuming app already ships — so they live here, outside
`src`, and vendor no jars of their own.

There are two shapes, and the difference matters:

| | What it is | Your logging framework |
|---|---|---|
| **`slf4j/`** — SLF4J provider | a **drop-in replacement backend** | you *remove* logback/log4j2 and put us in its place |
| **`logback/`**, **`log4j2/`** — appenders | a **bolt-on destination** | you *keep* logback/log4j2 and add us as one more appender |

## The drop-in: `superlog-slf4j`

SLF4J 2.0 loads exactly one backend off the classpath. Put `superlog-slf4j`
there **instead of** `logback-classic` (or `log4j-slf4j2-impl`, or
`slf4j-jdk14`) and every `org.slf4j.Logger` call in the program lands on the
bench — **no call sites change, no config file to port.** Apps on the Log4j 2
API reach it through the standard `log4j-to-slf4j` bridge; apps on
`java.util.logging` through `jul-to-slf4j`. That is a drop-in replacement for
your logging **backend**, in the honest sense of the phrase.

Configuration is by env var / system property, because the provider is
auto-loaded before your own code runs:

```
SUPERLOG_MODE / -Dsuperlog.mode      development | production   (see below)
SUPER_LOG_URL / -Dsuperlog.url       hub URL (default http://127.0.0.1:7333)
-Dsuperlog.topic                     default java.slf4j
-Dsuperlog.app                       default app
-Dsuperlog.device                    optional
```

A logging backend must not *throw* during init (that would leave the program
with no logging at all), so — unlike the appenders — an unset mode **defaults
to development** (ships everything) with a one-line notice, rather than
refusing to start. Set `production` explicitly to go quiet.

It is **not** a reimplementation of Logback/Log4j 2 — it does not read your
`logback.xml`/`log4j2.xml`, and it writes no files, rolls no logs and formats no
layouts. super-log is a bench, not a logging framework: the drop-in gets your
lines *to the bench* with zero code change. Keep a file appender alongside if
you still want files (that's the appender path, below, or your existing setup).

## The bolt-on: the appenders

Keep your framework; add the bench as one destination.

**Logback** — programmatic, or pure `logback.xml`:

```xml
<appender name="SUPERLOG" class="com.snicholls.superlog.logback.SuperLogAppender">
  <url>http://127.0.0.1:7333</url><topic>java.app</topic>
  <app>myapp</app><mode>development</mode>
</appender>
<root level="INFO"><appender-ref ref="SUPERLOG"/></root>
```

**Log4j 2** — reference the plugin package, then use `<SuperLog>`:

```xml
<Configuration packages="com.snicholls.superlog.log4j2">
  <Appenders>
    <SuperLog name="SUPERLOG" url="http://127.0.0.1:7333"
              topic="java.app" app="myapp" mode="development"/>
  </Appenders>
  <Loggers><Root level="info"><AppenderRef ref="SUPERLOG"/></Root></Loggers>
</Configuration>
```

Both also take a `SuperLog` you built yourself (`new SuperLogAppender(log)` /
`SuperLogAppender.forClient("SuperLog", log)`) if you'd rather wire it in code.
Both insist on `mode = development xor production` (or `SUPERLOG_MODE`) rather
than guess — the config path is not a hot loop where a wrong default is cheap.

*(Yes, a Log4j appender for the project whose pitch is "the anti-log4j" is a
little ironic. Plainly: it forwards Log4j's already-formatted text to the bench
as data, which the bench never evaluates anywhere in its pipeline. Adopting the
bench does not re-import the JNDI-lookup class of problem — that lived in the
logging library's message handling, not here.)*

## Building & testing

These need the logging jars on the classpath. They are not vendored; fetch
pinned copies into `sdk/java/.libs` (gitignored):

```
sh sdk/java/integrations/fetch-libs.sh
```

Then, from the repo root:

```sh
# core (zero-dep) + one integration against its library
javac -d out $(find sdk/java/src -name '*.java')
javac -cp out:sdk/java/.libs/slf4j-api-2.0.16.jar -d out \
    $(find sdk/java/integrations/slf4j -name '*.java')
```

`tests/java-integrations.test.mjs` compiles all three and drives the SLF4J
drop-in end-to-end against a real hub (it skips cleanly if the jars or `javac`
are absent).

## Distribution

The drop-in story is only real once these are on **Maven Central**, the way
Logback and Log4j are — `implementation 'com.super-log:superlog-slf4j:<v>'` and
you're done. See `../../../docs/JAVA_DISTRIBUTION.md` for the release setup
(namespace, signing, the artifacts). Until then, compile from source as above.

Each integration declares the logging library as a **provided/compileOnly**
dependency in its published POM — shipped by the consumer, never by us — so the
zero-dependency promise of the core is intact: adding `superlog-slf4j` pulls in
nothing but `slf4j-api`, which your app already has.
