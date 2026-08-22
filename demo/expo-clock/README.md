# The Expo clock

The real React Native client (HANDOFF M2): the same one-tick-a-second clock
the Node stand-ins fake, running inside actual Expo on actual devices. It
exercises what the stand-ins cannot — RN's `fetch`, Hermes timers,
`patchConsole` under Metro, `ErrorUtils` crash capture, and the per-device
host table — and it publishes to the same topics, so the viewers cannot
tell the difference.

```sh
# 1. Bench first, with the stand-ins off (they share these topics)
SUPER_LOG_STANDINS=0 ./demo/run.sh            # add SUPER_LOG_LAN=1 for hardware

# 2. Metro (port 8090 here; :8081 is often taken by another project)
cd demo/expo-clock && npm install
npx expo start --port 8090 --ios --android
```

The app finds the hub by itself: it reads the host it loaded its bundle
from (`Constants.expoConfig.hostUri`) and assumes the hub is on the same
machine, which is true for simulator, emulator, and hardware alike. Override
with `EXPO_PUBLIC_SUPERLOG_URL=http://<bench>:7333`.

Topic per target, chosen by `expo-device`:

| Target                | Topic                 | Getting it there |
|-----------------------|-----------------------|------------------|
| iOS Simulator         | `expo.ios.sim`        | `npx expo start --ios` |
| Android emulator      | `expo.android.emu`    | `adb reverse tcp:8090 tcp:8090 && adb reverse tcp:7333 tcp:7333`, then `--android` |
| Android hardware      | `expo.android.device` | same `adb reverse` on that serial, then open `exp://localhost:8090` |
| iOS hardware          | `expo.ios.device`     | install **Expo Go** from the App Store, then scan Metro's QR (needs `SUPER_LOG_LAN=1` so the phone can reach the hub over Wi-Fi) |

The buttons drive `console.log/warn/error` and a thrown exception, so you
can watch level colouring and crash capture arrive on the bench.

Standalone package on purpose: its React Native dependency tree stays out of
the repo's root `npm install`, and `@super-log/client` is a `file:` link, so
edits to the SDK are picked up by a rebuild (`npm run build --workspace
@super-log/client`) rather than a publish.
