# Publishing the Java artifacts to Maven Central

The point: make super-log consumable from the JVM the way Logback and Log4j are
— `implementation 'com.super-log:superlog-slf4j:0.4.1'` and you're done, no
building from source. This documents the release setup; the build that produces
the artifacts lives in `sdk/java/publish/`.

None of this changes how the SDK is *used* or built from source — `javac`
against `sdk/java/src` still needs nothing (see `sdk/java/README.md`). The Maven
build exists only to package and sign the same code for Central.

## The artifacts

| Coordinate | What | Runtime deps it pulls |
|---|---|---|
| `com.super-log:superlog:0.4.1` | the zero-dependency core SDK | none |
| `com.super-log:superlog-slf4j:0.4.1` | SLF4J 2.0 drop-in backend | `superlog` (slf4j-api is `provided` — the app has it) |
| `com.super-log:superlog-logback:0.4.1` | Logback appender | `superlog` (logback `provided`) |
| `com.super-log:superlog-log4j2:0.4.1` | Log4j 2 plugin appender | `superlog` (log4j-core `provided`) |

Each ships a jar + sources jar + javadoc jar (Central requires all three).
Version tracks the rest of the project (`0.4.1`, matching `@super-log/mcp` on
npm) — bump all four together.

Consumer, Gradle:
```gradle
implementation "com.super-log:superlog-slf4j:0.4.1"   // drop-in backend
// or, to keep your framework and add the bench beside it:
implementation "com.super-log:superlog-logback:0.4.1"
```
Consumer, Maven:
```xml
<dependency><groupId>com.super-log</groupId><artifactId>superlog-slf4j</artifactId><version>0.4.1</version></dependency>
```

## Building the artifacts (no credentials)

```sh
mvn -f sdk/java/publish/pom.xml -DskipTests package
```
produces the twelve jars under `sdk/java/publish/*/target/`. Java 17 is the
floor (the core uses records). Verified: `superlog-slf4j`'s jar carries its
`META-INF/services/org.slf4j.spi.SLF4JServiceProvider`, so it is a real drop-in.

## Publishing (needs credentials — Saxon)

Three things must exist first; all three are one-time:

1. **The namespace `com.super-log`, verified.** Register it on the Sonatype
   **Central Portal** (central.sonatype.com) and verify by adding the DNS `TXT`
   record it gives you to **super-log.com** — which we own, so this is the
   branded, correct namespace (the alternative, `io.github.saxonnicholls`,
   verifies via GitHub but is not the brand). Verification is one-time.
2. **A GPG signing key**, published to a public keyserver
   (`gpg --gen-key`; `gpg --keyserver keyserver.ubuntu.com --send-keys <id>`).
   Central rejects unsigned artifacts.
3. **A Central Portal user token**, in `~/.m2/settings.xml` under a server id
   `central`:
   ```xml
   <server><id>central</id><username>TOKEN_USER</username><password>TOKEN_PASS</password></server>
   ```

Then:
```sh
mvn -f sdk/java/publish/pom.xml -Prelease -DskipTests deploy
```
The `release` profile signs (maven-gpg-plugin) and uploads
(central-publishing-maven-plugin) as a **deployment you approve** in the Portal
(`autoPublish=false`), so nothing goes public by accident. Approve it once it
validates and the four coordinates go live.

## Notes

- **The core stays zero-dependency.** Each bridge declares its logging library
  as `provided`, so pulling `superlog-slf4j` brings in `superlog` + `slf4j-api`
  and nothing else — the empty-SBOM promise holds for the consumer too.
- **Log4j 2 plugin cache.** JDK 23+ disabled implicit annotation processing
  (JEP 705), so the `superlog-log4j2` jar may not carry a generated
  `Log4j2Plugins.dat`. The appender is still discovered via
  `<Configuration packages="com.snicholls.superlog.log4j2">` (shown in
  `sdk/java/integrations/README.md`); the `log4j2` module already re-enables
  processing (`<proc>full</proc>` + the processor path) for JDKs where it works.
- **Package vs. groupId.** The Java package is `com.snicholls.superlog` (stable,
  historical); the Maven groupId is `com.super-log` (the brand). Maven allows
  them to differ; only the groupId is verified against the domain.
