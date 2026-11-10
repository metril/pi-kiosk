import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
const t = 'http://127.0.0.1:8090'
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/papyrus': t, '/labels': t, '/kiosk': t } },
})
