import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
const base = process.env.VITE_BASE_PATH || '/'
export default defineConfig({
  base,
  plugins: [react(), VitePWA({
    registerType: 'prompt',
    includeAssets: ['apple-touch-icon-disco.png', 'exercises/*.gif', 'exercises/*.mp4'],
    manifest: {
      name: 'Домашняя тренировка', short_name: 'Дома', description: 'Персональная домашняя тренировка',
      lang: 'ru', start_url: base, scope: base, display: 'standalone', background_color: '#f4f5ef', theme_color: '#172b25',
      icons: [{ src: `${base}icon-disco-192.png`, sizes: '192x192', type: 'image/png' }, { src: `${base}icon-disco-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any' }, { src: `${base}icon-disco-maskable.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' }],
    },
    workbox: { clientsClaim: true, globPatterns: ['**/*.{js,css,html,png,svg,gif,mp4}'], navigateFallback: `${base}index.html` },
  })],
})
