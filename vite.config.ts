delete process.env.ELECTRON_RUN_AS_NODE;
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron/simple'
import { builtinModules } from 'node:module'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    electron({
      main: {
        entry: 'electron/main.ts',
        vite: {
          build: {
            rollupOptions: {
              external: ['electron', ...builtinModules]
            }
          }
        }
      },
      preload: {
        input: 'electron/preload.ts',
        vite: {
          build: {
            rollupOptions: {
              external: ['electron', ...builtinModules]
            }
          }
        }
      },
      renderer: process.env.NODE_ENV === 'test' ? undefined : {},
    }),
  ],
})
