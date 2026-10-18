import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

const serverURL = process.env.SERVER_URL ?? ''

export default defineConfig({
  main: {
    build: {
      externalizeDeps: { exclude: ['electron-store'] }
    },
    define: {
      __SERVER_URL__: JSON.stringify(serverURL)
    }
  },
  preload: {
    build: {
      externalizeDeps: true
    }
  },
  renderer: {
    server: {
      port: 5174
    },
    resolve: {
      alias: {
        '@': resolve('src/renderer/src')
      }
    },
    plugins: [
      react(),
      {
        name: 'dev-csp-relax',
        apply: 'serve',
        transformIndexHtml(html: string): string {
          return html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
        }
      }
    ],
    build: {
      assetsInlineLimit: (filePath: string) => (/\.(js|mjs)$/.test(filePath) ? false : undefined)
    }
  }
})
