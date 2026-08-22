# Tailers

Host-side scrapers for streams we cannot (or have not yet) instrumented
in-app. Each reshapes an existing feed into PROTOCOL.md events and batch-POSTs
them to superlogd. Zero dependencies, Node ≥ 18.

## The four React Native streams

```sh
# Android emulator                          -> expo.android.emu
node bin/superlog-tail.mjs android

# Android hardware (find serial: adb devices) -> expo.android.device
node bin/superlog-tail.mjs android --serial R5CT30ABCDE

# iOS Simulator (booted)                    -> expo.ios.sim
node bin/superlog-tail.mjs ios-sim --process Expo

# iOS hardware                              -> expo.ios.device
#   Not wired yet (HANDOFF M4). Two candidate feeds:
#   - pymobiledevice3 syslog live  (pip install pymobiledevice3) - works on iOS 17+
#   - idevicesyslog (brew install libimobiledevice)
#   Either pipes line-per-entry text; the adapter follows the logcat pattern.
```

Noise control: `--process` / `--predicate` (iOS) and logcat's own tag filters
are the first line of defence; the viewers filter the rest. For RN work the
interesting Android tags are usually `ReactNativeJS` and `ReactNative`.

The in-app `@super-log/client` SDK is always the better source (structured
fields, sessions, real levels). A tailer and the SDK publishing to the *same
topic* at the same time will double-report the app's own console lines — run
one or the other per device.
