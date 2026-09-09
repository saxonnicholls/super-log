#!/usr/bin/env node
//
//  superlog login - the door to super-log Cloud, and nothing more.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  This is the whole of the cloud story in the MIT tool: it opens the website.
//  It makes NO network call of its own - it hands a URL to the operating
//  system's browser opener and exits. `strings` this and you will find one URL
//  the binary never connects to. There is deliberately no version check, no
//  "does this machine have an account" probe, and no telemetry ping: those are
//  exactly the connections that get a tool accused of phoning home, and this
//  command is the counter-example. The enrolment ceremony, the token, and every
//  byte that actually leaves a machine live in the separate super-log-cloud
//  package - the MIT tool carries no cloud code at all
//  (docs/strategy/11-daemon-interaction.md, decisions 3 and 5).
//
//  The URL is a compile-time constant on purpose (that doc's Gap 8): the one
//  command whose entire claim is "no network call" must not take a destination
//  from config or the environment, or it becomes an open-redirect vector.
//
//    superlog login              print the URL and open it in a browser
//    superlog login --print      print the URL only (do not open a browser)
//
//  Node >= 18.
//

import { spawn } from 'node:child_process';
import { platform } from 'node:os';

// Gap 8: compile-time constant, never read from config or environment. This is
// the console's OWN login route on purpose - the person typing `superlog login`
// is an OSS bench user who most likely has no account yet, so the door has to
// land where an account is created, not on a marketing page. Changing it later
// is a release, so it is an address meant to be kept.
const LOGIN_URL = 'https://app.super-log.com/login';

function openInBrowser(url) {
  // The opener is per-OS; on a headless box it simply is not there, which is
  // fine - the URL was already printed, which is what an ssh user needs.
  const p = platform();
  const [cmd, args] = p === 'darwin' ? ['open', [url]]
                    : p === 'win32' ? ['cmd', ['/c', 'start', '', url]]
                                    : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});   // no opener (headless) - the printed URL stands
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export function runLogin(args = []) {
  const printOnly = args.includes('--print') || args.includes('--no-open');
  process.stdout.write(
    '\nsuper-log Cloud - sign in or sign up in your browser:\n\n' +
    `  ${LOGIN_URL}\n\n`);
  if (!printOnly) {
    openInBrowser(LOGIN_URL);
    process.stdout.write('Opening your browser (if it does not, copy the link above).\n');
  }
  process.stdout.write(
    'When you finish there, the page shows the two commands that connect this bench.\n\n');
  // No network call was made, and nothing waits on input - so it exits, and
  // `superlog login` never hangs the way a stdin-reading tee would.
}

// Run when invoked directly (superlog-login.mjs); superlog-tee.mjs imports
// runLogin so `superlog login` dispatches here.
if (import.meta.url === `file://${process.argv[1]}`)
  runLogin(process.argv.slice(2));
