import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

// The repository-root .env belongs to the API. Only API_PORT is read from it, with Node's parser,
// to point the dev proxy at the API. It is deliberately not loaded through Vite (envDir/loadEnv):
// Vite would pick up its NODE_ENV=development and bundle React's development build into
// production builds. The web client itself needs no environment variables.
// fileURLToPath (not URL.pathname) so folders with spaces, like "Capstone sem3", resolve correctly.
const rootEnvFile = fileURLToPath(new URL('../../.env', import.meta.url));
const rootEnv = existsSync(rootEnvFile) ? parseEnv(readFileSync(rootEnvFile, 'utf8')) : {};
const apiTarget = `http://localhost:${process.env.API_PORT || rootEnv.API_PORT || 4000}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    // Proxy API and WebSocket traffic so the browser sees a single origin. This keeps session
    // cookies first-party and avoids cross-origin requests during development.
    proxy: {
      // xfwd adds X-Forwarded-For so the API records the browser's address, not the proxy's.
      '/api': { target: apiTarget, changeOrigin: false, xfwd: true },
      '/socket.io': { target: apiTarget, ws: true, changeOrigin: false, xfwd: true },
    },
  },
});
