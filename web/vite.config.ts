import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
const t = 'http://127.0.0.1:8090'
export default defineConfig({
  plugins: [react()],
  build: { rollupOptions: { input: { main: resolve(__dirname, 'index.html'), admin: resolve(__dirname, 'admin.html') } } },
  server: { proxy: { '/papyrus': t, '/labels': t, '/kiosk': t, '/admin': 'http://127.0.0.1:8443' } },
})
