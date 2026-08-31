import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // 'prompt', not 'autoUpdate': an article being read must never be swapped out
      // from under the reader. Phase 8 surfaces the waiting worker as an explicit
      // "reload for the new version" affordance.
      registerType: 'prompt',
      includeAssets: ['icons/apple-touch-icon.png'],
      manifest: {
        name: 'Stash',
        short_name: 'Stash',
        description: 'A read-it-later reader for Instapaper',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        background_color: '#faf8f4',
        theme_color: '#12100e',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/icons/icon-192-maskable.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'maskable',
          },
          {
            src: '/icons/icon-512-maskable.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // The fonts are the one large precache cost, and the reason to pay it:
        // an installed reader must render offline in the reader's chosen face.
        globPatterns: ['**/*.{js,css,html,woff2,png,svg,ico}'],
        // Never let the shell's navigation fallback answer for a function call.
        navigateFallbackDenylist: [/^\/api\//],
      },
      devOptions: {
        // Off by default: a service worker caching a dev server is a debugging tax.
        enabled: false,
      },
    }),
  ],
});
