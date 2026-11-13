import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'

// "npm run dev"          -> http://localhost:5173 (microfone funciona em localhost)
// "npm run dev:celular"  -> https://<ip-do-pc>:5173 (celular exige HTTPS para usar o microfone)
export default defineConfig(({ mode }) => ({
  plugins: [react(), ...(mode === 'celular' ? [basicSsl()] : [])],
  server: {
    port: 5173,
    proxy: {
      // o painel fala com o n8n pelo mesmo endereco: sem problema de CORS
      '/webhook': { target: 'http://localhost:5678', changeOrigin: true },
    },
  },
}))
