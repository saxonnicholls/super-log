#!/bin/sh
# Run the compiled Scala clock. Scala 3.5+ replaced the classic runner with
# scala-cli, which no longer launches a bare class - so prefer plain java
# with the brew-installed Scala runtime jars, and fall back to the legacy
# runner for non-brew installs that still have it.
CP="${1:?usage: run.sh <classpath> [clock args...]}"; shift
for L in /opt/homebrew/opt/scala/libexec/lib /usr/local/opt/scala/libexec/lib; do
    [ -d "$L" ] && exec java -cp "$CP:$L/*" Clock "$@"
done
exec scala -classpath "$CP" Clock "$@"
