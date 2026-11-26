import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const webRoot = path.resolve(import.meta.dirname)
const outDir = path.resolve(webRoot, '..', 'dist-web')

export default defineConfig({
  root: webRoot,
  base: '/synapse/',
  plugins: [react(), tailwindcss()],
  build: {
    outDir,
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 650,
    rollupOptions: {
      output: {
        manualChunks(id: string): string | undefined {
          const normId = id.replaceAll('\\', '/')
          if (normId.includes('/src/ink/')) {
            return 'ink'
          }
          if (normId.includes('node_modules/three')) {
            return 'vendor-three'
          }
          if (normId.includes('node_modules/motion') || normId.includes('node_modules/framer-motion')) {
            return 'vendor-motion'
          }
          if (
            normId.includes('node_modules/react/')
            || normId.includes('node_modules/react-dom/')
            || normId.includes('node_modules/scheduler/')
          ) {
            return 'vendor-react'
          }
          return undefined
        },
      },
    },
  },
})
