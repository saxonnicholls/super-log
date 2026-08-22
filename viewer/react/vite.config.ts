import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 7334,
    // Loopback by default like the rest of the bench; SUPER_LOG_WEB_BIND
    // (which demo/run.sh sets from SUPER_LOG_LAN) opens it to the LAN, so
    // a phone or another machine can open the viewer. Without this vite
    // silently stays on localhost and prints "use --host to expose".
    host: process.env.SUPER_LOG_WEB_BIND ?? '127.0.0.1',
  },
});
