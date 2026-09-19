#!/bin/sh
#
#  fetch-libs.sh - download the logging libraries the integrations compile
#  against, into sdk/java/.libs (gitignored).
#
#  Copyright 2026 Saxon Herschel Nicholls
#  SPDX-License-Identifier: MIT
#
#  The integrations under sdk/java/integrations bridge Logback, Log4j 2 and
#  SLF4J. Compiling them needs those libraries on the classpath - the same
#  libraries the consuming app already ships - so we do NOT vendor them into
#  the repo. This fetches pinned versions from Maven Central for building and
#  testing the bridges here; a real consumer gets them from their own
#  dependency manager (see integrations/README.md).
#
set -eu

DIR="$(cd "$(dirname "$0")/.." && pwd)/.libs"
BASE="https://repo1.maven.org/maven2"
mkdir -p "$DIR"

# path-under-maven-central ...
JARS="
org/slf4j/slf4j-api/2.0.16/slf4j-api-2.0.16.jar
ch/qos/logback/logback-core/1.5.12/logback-core-1.5.12.jar
ch/qos/logback/logback-classic/1.5.12/logback-classic-1.5.12.jar
org/apache/logging/log4j/log4j-api/2.24.1/log4j-api-2.24.1.jar
org/apache/logging/log4j/log4j-core/2.24.1/log4j-core-2.24.1.jar
"

for path in $JARS; do
  file="$DIR/$(basename "$path")"
  if [ -f "$file" ]; then
    echo "have    $(basename "$path")"
  else
    echo "fetch   $(basename "$path")"
    curl -fsSL -o "$file" "$BASE/$path"
  fi
done

echo "libs in $DIR"
