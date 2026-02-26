import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        // Don't proxy HA ingress paths — they're SPA routes, not backend API calls
        bypass(req) {
          if (req.url?.startsWith('/api/hassio_ingress/')) return '/index.html'
        },
      },
    },
  },
})
