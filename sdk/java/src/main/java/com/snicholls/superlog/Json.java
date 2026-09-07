//
//  Json.java
//  super-log Java SDK
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  Hand-rolled escaping, the same forty lines the Rust and C++ SDKs carry.
//  Jackson or Gson would do it better in general, and neither is worth a
//  dependency here: a debugging tool that needs its own dependency tree
//  resolved before it can tell you why the dependency tree broke is not much
//  of a debugging tool. The events this writes are flat by construction -
//  strings, one integer and one double - which is the narrow case a
//  hand-rolled writer gets right.
//
//  Escaping newlines is not cosmetic. The wire is NDJSON: one raw \n inside
//  a message would split one event into two unparseable halves.
//

package com.snicholls.superlog;

final class Json {

    private static final char[] HEX = "0123456789abcdef".toCharArray();

    private Json() {
    }

    static void escape(String s, StringBuilder out) {
        if (s == null) {
            return;
        }
        final int n = s.length();
        for (int i = 0; i < n; i++) {
            final char c = s.charAt(i);
            switch (c) {
                case '"':  out.append("\\\""); break;
                case '\\': out.append("\\\\"); break;
                case '\n': out.append("\\n");  break;
                case '\r': out.append("\\r");  break;
                case '\t': out.append("\\t");  break;
                case '\b': out.append("\\b");  break;
                case '\f': out.append("\\f");  break;
                default:
                    if (c < 0x20) {
                        out.append("\\u00")
                           .append(HEX[(c >> 4) & 0xF])
                           .append(HEX[c & 0xF]);
                    } else {
                        out.append(c);
                    }
            }
        }
    }

    static void quoted(String s, StringBuilder out) {
        out.append('"');
        escape(s, out);
        out.append('"');
    }

    /** JSON has no NaN and no Infinity. A line a viewer cannot parse is
     *  worse than a wrong number, so a non-finite value is written as 0 and
     *  the caller records the truth in a field instead. */
    static void number(double v, StringBuilder out) {
        if (Double.isNaN(v) || Double.isInfinite(v)) {
            out.append('0');
        } else if (v == Math.rint(v) && Math.abs(v) < 1e15) {
            out.append((long) v);
        } else {
            out.append(v);
        }
    }
}
