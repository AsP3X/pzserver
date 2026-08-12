import { fileURLToPath, URL } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/** Where `npm run dev` proxies /api to. Override with API_ORIGIN. */
const apiOrigin = process.env.API_ORIGIN ?? 'http://127.0.0.1:8080'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5174,
    // Proxying keeps dev same-origin, exactly like nginx does in production —
    // so CORS behaviour is never something that only breaks after deploy.
    proxy: {
      '/api': {
        target: apiOrigin,
        changeOrigin: true,
      },
    },
  },
  build: {
    // Source maps are worth the bytes on a site this size; stack traces from
    // production bug reports are otherwise unreadable.
    sourcemap: true,
  },
})
