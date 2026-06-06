import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      '/api/search': {
        target: 'https://datos.odepa.gob.cl',
        changeOrigin: true,
        rewrite: (path) => path.replace('/api/search', '/es/api/action/datastore_search'),
      },
    },
  },
})
