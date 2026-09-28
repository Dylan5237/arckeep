import { defineConfig } from 'vite'
import { resolve } from 'node:path'

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  build: {
    outDir: resolve(__dirname, 'out/renderer'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'src/renderer/index.html'),
        capture: resolve(__dirname, 'src/renderer/capture.html')
      }
    }
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true
  }
})
