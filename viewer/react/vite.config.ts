import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Stamped into the UI so "am I looking at the current viewer?" is
  // answerable at a glance rather than by faith. A stale bundle is the
  // quiet failure here: the page still works, it just behaves like an
  // older version - which once meant a viewer opened over the LAN kept
  // talking to 127.0.0.1 because the fix was in a build nobody had.
  define: {
    __SUPERLOG_BUILD__: JSON.stringify(new Date().toISOString().slice(0, 19).replace('T', ' ')),
  },
  plugins: [react()],
  server: {
    port: 7334,
    // Never let a browser hold on to the entry document. Vite's assets are
    // content-hashed, but index.html is what points at them, so caching it
    // pins the whole app to an old build.
    headers: { 'Cache-Control': 'no-store, must-revalidate' },
    // Loopback by default like the rest of the bench; SUPER_LOG_WEB_BIND
    // (which demo/run.sh sets from SUPER_LOG_LAN) opens it to the LAN, so
    // a phone or another machine can open the viewer. Without this vite
    // silently stays on localhost and prints "use --host to expose".
    host: process.env.SUPER_LOG_WEB_BIND ?? '127.0.0.1',
  },
});
