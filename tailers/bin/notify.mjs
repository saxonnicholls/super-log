//
//  notify.mjs - one interface, many ways to reach a human.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  Every alerting path here - the rules engine, the inbound alarm gateway,
//  whatever comes next - speaks to people through this one registry, so a
//  new channel is one entry, not a per-tool rewrite. A channel is a name,
//  a `configured` verdict with the reason when it is not (the roster IS
//  the diagnostic - "telegram: set TELEGRAM_BOT_TOKEN and
//  TELEGRAM_CHAT_ID" beats silence), and a send(alert).
//
//  The alert shape every channel receives:
//    { title, body, level, event? }
//
//  Channels, all zero-dependency:
//    console          stderr, always available
//    desktop          osascript / notify-send
//    webhook          one POST; the {text} shape Slack, Discord and
//                     Mattermost all read
//    command          a shell command, alert passed in the ENVIRONMENT so
//                     log text can never become shell
//    telegram         Bot API sendMessage - a bot token and a chat id
//    twilio-sms       Twilio Messages API, basic auth, form-encoded
//    twilio-whatsapp  the same API with whatsapp: addressing
//    email            sendmail(1) on stdin - the zero-dependency mail
//                     bargain; point it at postfix, msmtp, or anything
//                     that quacks like sendmail
//
//  Sends never throw to the caller: a notification channel that can take
//  down the alerter is worse than a missed page - failures go to stderr
//  and the next alert tries again.
//

import { spawn } from 'node:child_process';
import { platform } from 'node:os';

const need = (missing) => `set ${missing.join(' and ')}`;

/** Build the channel registry from config (alerts.json's `channels`) and
 *  the environment. Every known channel appears; `configured` says whether
 *  it would actually deliver, and `why` says what is missing when not. */
export function makeChannels(cfg = {}, env = process.env) {
  const ch = cfg.channels ?? {};
  const registry = new Map();
  const add = (name, configured, why, send) =>
    registry.set(name, { name, configured, why: configured ? '' : why, send });

  add('console', true, '', async (a) => {
    console.error(`superlog: [${a.level}] ${a.title} - ${a.body}`);
  });

  add('desktop', true, '', async (a) => {
    if (platform() === 'darwin') {
      const script = `display notification ${JSON.stringify(String(a.body).slice(0, 400))} with title ${JSON.stringify(a.title)}`;
      spawn('osascript', ['-e', script], { stdio: 'ignore' }).on('error', () => {});
    } else {
      spawn('notify-send', [a.title, String(a.body).slice(0, 400)], { stdio: 'ignore' })
        .on('error', () => {});
    }
  });

  const webhook = ch.webhook?.url ?? cfg.webhook ?? env.SUPER_LOG_WEBHOOK ?? '';
  add('webhook', !!webhook, 'set SUPER_LOG_WEBHOOK or channels.webhook.url', async (a) => {
    await fetch(webhook, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: `*${a.title}*\n${a.body}`,
                             title: a.title, body: a.body, level: a.level, event: a.event }),
      signal: AbortSignal.timeout(10000),
    });
  });

  const command = ch.command?.run ?? cfg.command ?? '';
  add('command', !!command, 'set channels.command.run (or a rule/config `command`)', async (a) => {
    spawn('sh', ['-c', command], {
      stdio: 'ignore',
      env: { ...process.env, SUPERLOG_ALERT_TITLE: a.title,
             SUPERLOG_ALERT_BODY: a.body, SUPERLOG_ALERT_LEVEL: a.level },
    }).on('error', () => {});
  });

  const tgToken = ch.telegram?.bot_token ?? env.TELEGRAM_BOT_TOKEN ?? '';
  const tgChat = ch.telegram?.chat_id ?? env.TELEGRAM_CHAT_ID ?? '';
  add('telegram', !!(tgToken && tgChat), need(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']),
    async (a) => {
      await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: tgChat,
                               text: `[${a.level}] ${a.title}\n${a.body}`.slice(0, 4000) }),
        signal: AbortSignal.timeout(10000),
      });
    });

  const twSid = ch.twilio?.account_sid ?? env.TWILIO_ACCOUNT_SID ?? '';
  const twAuth = ch.twilio?.auth_token ?? env.TWILIO_AUTH_TOKEN ?? '';
  const twilioSend = (from, to) => async (a) => {
    const params = new URLSearchParams({
      From: from, To: to, Body: `[${a.level}] ${a.title}\n${a.body}`.slice(0, 1500),
    });
    await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twSid}/Messages.json`, {
      method: 'POST',
      headers: {
        authorization: 'Basic ' + Buffer.from(`${twSid}:${twAuth}`).toString('base64'),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: params, signal: AbortSignal.timeout(10000),
    });
  };

  const smsFrom = ch.twilio?.sms_from ?? env.TWILIO_FROM ?? '';
  const smsTo = ch.twilio?.sms_to ?? env.TWILIO_TO ?? '';
  add('twilio-sms', !!(twSid && twAuth && smsFrom && smsTo),
      need(['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM', 'TWILIO_TO']),
      twilioSend(smsFrom, smsTo));

  const waFrom = ch.twilio?.whatsapp_from ?? env.TWILIO_WHATSAPP_FROM ?? '';
  const waTo = ch.twilio?.whatsapp_to ?? env.TWILIO_WHATSAPP_TO ?? '';
  add('twilio-whatsapp', !!(twSid && twAuth && waFrom && waTo),
      need(['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_WHATSAPP_FROM', 'TWILIO_WHATSAPP_TO']),
      twilioSend(`whatsapp:${waFrom.replace(/^whatsapp:/, '')}`,
                 `whatsapp:${waTo.replace(/^whatsapp:/, '')}`));

  const mailTo = ch.email?.to ?? env.SUPER_LOG_ALERT_EMAIL ?? '';
  add('email', !!mailTo, 'set SUPER_LOG_ALERT_EMAIL or channels.email.to', async (a) => {
    const from = ch.email?.from ?? 'superlog@localhost';
    const mail = spawn(ch.email?.sendmail ?? 'sendmail', ['-t'], { stdio: ['pipe', 'ignore', 'ignore'] });
    mail.on('error', () => console.error('superlog: sendmail not available for email channel'));
    mail.stdin.end(
      `To: ${mailTo}\nFrom: ${from}\nSubject: [${a.level}] ${a.title}\n\n${a.body}\n`);
  });

  return registry;
}

/** Deliver one alert to the named channels; unknown or unconfigured names
 *  are said once on stderr rather than silently eaten. */
export async function deliver(registry, names, alert, saidRef = new Set()) {
  for (const name of names) {
    const c = registry.get(name);
    if (!c) {
      if (!saidRef.has(name)) {
        saidRef.add(name);
        console.error(`superlog: unknown notify channel '${name}' (have: ${[...registry.keys()].join(', ')})`);
      }
      continue;
    }
    if (!c.configured) {
      if (!saidRef.has(name)) {
        saidRef.add(name);
        console.error(`superlog: channel '${name}' not configured - ${c.why}`);
      }
      continue;
    }
    try {
      await c.send(alert);
    } catch (e) {
      console.error(`superlog: ${name} delivery failed: ${e.message}`);
    }
  }
}

/** The roster with configured state - the UI's diagnostics read this. */
export const channelRoster = (registry) =>
  [...registry.values()].map(({ name, configured, why }) => ({ name, configured, why }));
