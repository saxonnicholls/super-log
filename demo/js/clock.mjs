//
//  clock.mjs - the iOS and Android demo clients
//
//  Copyright 2026 Saxon Herschel Nicholls
//
//  Stand-ins for the two React Native apps: until M2 puts @super-log/client
//  inside the real Expo builds, this runs the exact same client from Node -
//  one process per device, same topics, same origin shape - so the
//  four-stream demo has all four topics live today. Swapping the real app
//  in changes nothing downstream; that is the point of topics naming
//  streams, not transports.
//
//      node demo/js/clock.mjs ios | android
//

import { createSuperLog } from '@super-log/client';

const DEVICES = {
  ios: { topic: 'expo.ios.sim', platform: 'ios', device: 'iPhone 16 Pro (sim)' },
  android: { topic: 'expo.android.emu', platform: 'android', device: 'Pixel 8 (emu)' },
};

const kind = DEVICES[process.argv[2]];
if (!kind) {
  console.error('usage: node demo/js/clock.mjs ios|android');
  process.exit(2);
}

const slog = createSuperLog({
  url: process.env.SUPER_LOG_URL ?? 'http://127.0.0.1:7333',
  topic: kind.topic,
  app: 'clock',
  platform: kind.platform,
  device: kind.device,
  development: true, // the bench IS development; a real app passes __DEV__
});

// UTC like the other clients - four streams that agree beat local drift
const hms = () => new Date().toISOString().slice(11, 19) + 'Z';

let n = 0;
slog.info(`${kind.platform} clock up - one line a second`);
const timer = setInterval(() => {
  n += 1;
  slog.info(`tick ${n} - the time is ${hms()}`, { tick: String(n) });
}, 1000);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    clearInterval(timer);
    void slog.close().then(() => process.exit(0));
  });
}
