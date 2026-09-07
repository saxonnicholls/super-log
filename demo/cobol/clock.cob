*>
*>  clock.cob - the COBOL demo client. Yes, really.
*>
*>  Copyright 2026 Saxon Herschel Nicholls
*>  SPDX-License-Identifier: MIT
*>
*>  The same clock every other demo client runs, once a second on
*>  cobol.clock, through the header-only C SDK via shim.c - GnuCOBOL
*>  CALLs C by symbol, so the oldest business language on the bench logs
*>  through the same twenty lines of C as everything else. Z"" literals
*>  are NUL-terminated; computed messages append X"00" by hand, because
*>  C strings end and COBOL fields do not.
*>
*>    sh demo/cobol/run.sh          (SUPERLOG_MODE=development|production)
*>
IDENTIFICATION DIVISION.
PROGRAM-ID. clock.
DATA DIVISION.
WORKING-STORAGE SECTION.
01 tick        PIC 9(6)  VALUE 0.
01 tick-disp   PIC Z(5)9.
01 msg-buf     PIC X(96).
01 uptime      COMP-2.
PROCEDURE DIVISION.
    CALL "cobol_superlog_init"
        USING BY CONTENT Z"cobol.clock", Z"clock"
    END-CALL
    CALL "cobol_superlog_log"
        USING BY CONTENT Z"INFO", Z"cobol clock up - one line a second"
    END-CALL
    DISPLAY "superlog: cobol clock -> cobol.clock"

    PERFORM UNTIL 1 = 2
        ADD 1 TO tick
        MOVE tick TO tick-disp
        MOVE SPACES TO msg-buf
        STRING "tick " FUNCTION TRIM(tick-disp)
               " - from 1959, with love" X"00"
               DELIMITED BY SIZE INTO msg-buf
        END-STRING
        CALL "cobol_superlog_log"
            USING BY CONTENT Z"INFO", BY REFERENCE msg-buf
        END-CALL

*>      Honestly wrong every 7th tick, the same staged failure as every
*>      other clock, so one error lines up across every language.
        IF FUNCTION MOD(tick, 7) = 0
            MOVE SPACES TO msg-buf
            STRING "pricing failed on tick " FUNCTION TRIM(tick-disp)
                   ": no rate for DOGE" X"00"
                   DELIMITED BY SIZE INTO msg-buf
            END-STRING
            CALL "cobol_superlog_log"
                USING BY CONTENT Z"ERROR", BY REFERENCE msg-buf
            END-CALL
        ELSE
            MOVE SPACES TO msg-buf
            STRING "pricing pass " FUNCTION TRIM(tick-disp) X"00"
                   DELIMITED BY SIZE INTO msg-buf
            END-STRING
            CALL "cobol_superlog_log"
                USING BY CONTENT Z"DEBUG", BY REFERENCE msg-buf
            END-CALL
        END-IF

        IF FUNCTION MOD(tick, 5) = 0
            MOVE tick TO uptime
            CALL "cobol_superlog_metric"
                USING BY CONTENT Z"clock.uptime_s", BY REFERENCE uptime
            END-CALL
        END-IF

        CALL "cobol_superlog_flush" END-CALL
        CALL "C$SLEEP" USING BY CONTENT 1 END-CALL
    END-PERFORM.
