import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

/**
 * The bridge port is not fixed at build time: the Tauri shell passes the effective bridge
 * URL to the webview, and `vite dev` proxies to CCCN_BRIDGE_PORT (default 43130) so the
 * same frontend code runs in both.
 */
const bridgePort = process.env.CCCN_BRIDGE_PORT ?? '43130'

export default defineConfig({
  plugins: [vue()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${bridgePort}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome110',
    sourcemap: false,
  },
})
