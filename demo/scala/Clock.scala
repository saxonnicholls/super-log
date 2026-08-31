//
//  Clock.scala - the Scala demo client, riding the Java SDK.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  Scala needs no SDK of its own for the same reason Kotlin does not: it
//  IS the JVM, and the Java client - the builder, the java.util.logging
//  handler, the uncaught-exception hook - is idiomatic enough to call
//  directly. What this file demonstrates is exactly that: zero wrapper,
//  zero glue, one import.
//
//    javac -d /tmp/sls $(find sdk/java -name '*.java')
//    scalac -classpath /tmp/sls -d /tmp/sls demo/scala/Clock.scala
//    sh demo/scala/run.sh /tmp/sls            # java + the Scala runtime jars
//    (Scala >= 3.5 replaced the classic runner with scala-cli, which no
//    longer launches a bare class - run.sh picks whichever way works)
//
//  The same clock every other demo client runs, once a second on
//  scala.clock: tick at INFO, a DEBUG pricing pass, a real ERROR when the
//  pricer meets the symbol it has no rate for, an uptime metric.
//

import com.snicholls.superlog.SuperLog

import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.time.Instant

object Clock {

  private val Hms =
    DateTimeFormatter.ofPattern("HH:mm:ss'Z'").withZone(ZoneOffset.UTC)

  private val Rates = Map("BTC" -> 64000.0, "ETH" -> 3200.0)

  def main(args: Array[String]): Unit = {
    val maxTicks = args.sliding(2).collectFirst {
      case Array("--ticks", n) => n.toInt
    }.getOrElse(0)

    val log = SuperLog.builder()
      .topic("scala.clock")
      .app("clock")
      .url(sys.env.getOrElse("SUPER_LOG_URL", "http://127.0.0.1:7333"))
      .development(true)
      .production(false)
      .build()
    log.installUncaughtHandler()

    println(s"superlog: scala clock -> ${log.status().topic()}")
    log.info("scala clock up - one line a second",
             SuperLog.fields("scala", util.Properties.versionNumberString))

    var tick = 0
    while (maxTicks == 0 || tick < maxTicks) {
      tick += 1
      log.info(s"tick $tick - the time is ${Hms.format(Instant.now())}",
               SuperLog.fields("tick", Int.box(tick)))

      // Honestly wrong every 7th tick, the same staged failure as every
      // other clock, so one error lines up across every language.
      val symbol = if (tick % 7 == 0) "DOGE" else "BTC"
      Rates.get(symbol) match {
        case Some(rate) =>
          log.debug(s"pricing pass $tick",
                    SuperLog.fields("symbol", symbol, "price", Double.box(rate * 2)))
        case None =>
          log.error(s"pricing failed on tick $tick: no rate for $symbol",
                    SuperLog.fields("symbol", symbol, "tick", Int.box(tick)))
      }

      if (tick % 5 == 0)
        log.debug("clock.uptime_s", SuperLog.fields("value", Int.box(tick)))

      Thread.sleep(1000)
    }
    log.info("scala clock stopping")
  }
}
