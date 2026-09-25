import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: process.env.API_URL ?? 'http://localhost:4000', changeOrigin: true },
      // Public invoice links (`/i/<token>`) are served by the API, not the SPA. A regex, so it
      // cannot swallow paths that merely start with "/i" (e.g. /index.html).
      '^/i/': { target: process.env.API_URL ?? 'http://localhost:4000', changeOrigin: true },
    },
  },
});
