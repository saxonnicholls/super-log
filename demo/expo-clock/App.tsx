//
//  App.tsx - the real Expo clock client (HANDOFF M2's first light)
//
//  Copyright 2026 Saxon Herschel Nicholls
//
//  The same clock the Node stand-ins fake, running inside actual React
//  Native on the actual simulators - which is the point: this exercises
//  RN's fetch, Hermes timers, patchConsole under Metro, and the per-device
//  URL table (docs/PROTOCOL.md) that the stand-ins cannot. Topics are the
//  same, so the viewers cannot tell the difference - turn the stand-ins
//  off when this runs (double-reporting otherwise).
//
//  Hardware needs the bench's LAN IP and SUPER_LOG_LAN=1 on the hub:
//    EXPO_PUBLIC_SUPERLOG_URL=http://192.168.x.x:7333 npx expo start
//

import { useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { createSuperLog } from '@super-log/client';

// The bench is wherever Metro is: the app already knows the host it loaded
// its bundle from (hostUri), and the hub lives on the same machine. That
// one fact makes every target work unconfigured - simulator (localhost),
// emulator (Metro's host), and hardware on the LAN (the Mac's IP; the hub
// must be on the LAN too: SUPER_LOG_LAN=1). The PROTOCOL.md table remains
// the fallback when hostUri is absent (release builds).
const metroHost = Constants.expoConfig?.hostUri?.split(':')[0];
const HOST = metroHost ?? (Platform.OS === 'android' ? '10.0.2.2' : 'localhost');
const URL = process.env.EXPO_PUBLIC_SUPERLOG_URL ?? `http://${HOST}:7333`;

// Topics name streams: hardware and simulator are different streams even
// when they run the same build.
const TOPIC =
  process.env.EXPO_PUBLIC_SUPERLOG_TOPIC ??
  (Platform.OS === 'android'
    ? Device.isDevice ? 'expo.android.device' : 'expo.android.emu'
    : Device.isDevice ? 'expo.ios.device' : 'expo.ios.sim');

const slog = createSuperLog({
  url: URL,
  topic: TOPIC,
  app: 'clock',
  platform: Platform.OS,
  device: Device.deviceName ?? Device.modelName ?? undefined,
  development: __DEV__,
  production: !__DEV__,
  patchConsole: true, // console.* from this app now reaches the bench
});

// Crashes reach the bench even when nobody logged them - the wiring the
// client absorbs at its M3 TODO; until then, one global handler here.
type RNErrorUtils = {
  getGlobalHandler?: () => (e: unknown, fatal?: boolean) => void;
  setGlobalHandler?: (h: (e: unknown, fatal?: boolean) => void) => void;
};
const EU = (globalThis as { ErrorUtils?: RNErrorUtils }).ErrorUtils;
const prevHandler = EU?.getGlobalHandler?.();
EU?.setGlobalHandler?.((e, fatal) => {
  const err = e as { message?: string; stack?: string } | undefined;
  slog.error(`${fatal ? 'FATAL ' : ''}uncaught: ${err?.message ?? String(e)}`, {
    stack: (err?.stack ?? '').split('\n').slice(0, 4).join(' | '),
  });
  prevHandler?.(e, fatal);
});

const hms = () => new Date().toISOString().slice(11, 19) + 'Z';

export default function App() {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    slog.info(`${Platform.OS} clock up - real Expo, one line a second`);
    let n = 0;
    const t = setInterval(() => {
      n += 1;
      setTick(n);
      slog.info(`tick ${n} - the time is ${hms()}`, { tick: String(n) });
    }, 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <View style={s.root}>
      <Text style={s.title}>super-log expo clock</Text>
      <Text style={s.meta}>
        {TOPIC} → {URL}
      </Text>
      <Text style={s.tick}>
        {tick ? `tick ${tick} - the time is ${hms()}` : 'waiting for the first tick…'}
      </Text>
      <View style={s.row}>
        <Btn label="console.log" onPress={() => console.log('hello from the app console')} />
        <Btn label="console.warn" onPress={() => console.warn('a warning from the app')} />
      </View>
      <View style={s.row}>
        <Btn label="console.error" onPress={() => console.error('an error from the app')} />
        <Btn
          label="throw"
          onPress={() => {
            throw new Error('demo explosion');
          }}
        />
      </View>
      <StatusBar style="light" />
    </View>
  );
}

function Btn({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable style={s.btn} onPress={onPress}>
      <Text style={s.btnText}>{label}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#101216',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    padding: 24,
  },
  title: { color: '#7aa2f7', fontSize: 18, fontWeight: '600' },
  meta: { color: '#5c6470', fontSize: 12 },
  tick: { color: '#68c964', fontSize: 14, marginVertical: 8 },
  row: { flexDirection: 'row', gap: 12 },
  btn: {
    backgroundColor: '#181c22',
    borderColor: '#262b33',
    borderWidth: 1,
    borderRadius: 6,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  btnText: { color: '#d6dae2', fontSize: 13 },
});
