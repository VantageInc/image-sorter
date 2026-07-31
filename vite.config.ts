import { builtinModules } from 'node:module'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import electron from 'vite-plugin-electron/simple'

interface ElectronCompatOutputOptions {
  codeSplitting?: boolean
  inlineDynamicImports?: boolean
}

interface ElectronCompatRollupOptions {
  platform?: unknown
  output?: ElectronCompatOutputOptions | ElectronCompatOutputOptions[]
}

function removeUnsupportedElectronRollupOptions(): Plugin {
  return {
    name: 'image-sorter:electron-rollup-compat',
    enforce: 'pre',
    config(config) {
      const rollupOptions = config.build?.rollupOptions as
        | ElectronCompatRollupOptions
        | undefined
      if (!rollupOptions) return

      delete rollupOptions.platform
      const outputs = Array.isArray(rollupOptions.output)
        ? rollupOptions.output
        : rollupOptions.output
          ? [rollupOptions.output]
          : []
      for (const output of outputs) {
        if (typeof output.codeSplitting === 'boolean') {
          output.inlineDynamicImports ??= !output.codeSplitting
          delete output.codeSplitting
        }
      }
    },
  }
}

export default defineConfig({
  base: './',
  plugins: [
    react(),
    electron({
      main: {
        entry: 'electron/main.ts',
        vite: {
          plugins: [removeUnsupportedElectronRollupOptions()],
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
          plugins: [removeUnsupportedElectronRollupOptions()],
          build: {
            rollupOptions: {
              external: ['electron', ...builtinModules]
            }
          }
        }
      },
    }),
  ],
  build: {
    sourcemap: false,
  },
  server: {
    host: '127.0.0.1',
    strictPort: true,
  },
})
