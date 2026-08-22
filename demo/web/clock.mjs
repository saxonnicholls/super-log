//
//  clock.mjs - the browser demo client
//
//  Copyright 2026 Saxon Herschel Nicholls
//
//  The same @super-log/client the React Native apps use, doing the browser
//  half of the story: patchConsole mirrors console.* onto the bench, so a
//  web app's client side and its Node server side consolidate on one
//  screen. The hub host follows the page host, so this page opened from
//  another machine on the LAN still reports to the bench.
//

import { createSuperLog } from '/client.js';

const hub =
  new URLSearchParams(location.search).get('hub') ??
  `http://${location.hostname}:7333`;

const slog = createSuperLog({
  url: hub,
  topic: 'web.clock',
  app: 'clock',
  development: true, // a real app passes its own dev/prod flags
  patchConsole: true,
});

slog.info('browser clock up - console.* now reaches the bench', {
  ua: navigator.userAgent.slice(0, 60),
});

// Uncaught errors and rejections, until the client absorbs this (M3 TODO in
// the SDK) - the pattern a real app wires once at startup.
window.addEventListener('error', (e) =>
  slog.error(`uncaught: ${e.message}`, {
    src: `${(e.filename ?? '').split('/').pop()}:${e.lineno ?? 0}`,
  }),
);
window.addEventListener('unhandledrejection', (e) =>
  slog.error(`unhandled rejection: ${e.reason}`),
);

const hms = () => new Date().toISOString().slice(11, 19) + 'Z';
let n = 0;
const tickEl = document.getElementById('tick');
setInterval(() => {
  n += 1;
  console.log(`tick ${n} - the time is ${hms()}`); // the console IS the pipe
  tickEl.textContent = `tick ${n} - the time is ${hms()}`;
}, 1000);

document.getElementById('log').onclick = () => console.log('hello from the browser console');
document.getElementById('warn').onclick = () => console.warn('a warning from the browser');
document.getElementById('error').onclick = () => console.error('an error from the browser');
document.getElementById('boom').onclick = () => {
  throw new Error('demo explosion');
};
