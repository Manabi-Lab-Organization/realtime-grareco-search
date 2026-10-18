import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'fs'

function readIosVersion(): string {
  try {
    const pbxproj = readFileSync('ios/App/App.xcodeproj/project.pbxproj', 'utf8')
    const match = pbxproj.match(/MARKETING_VERSION\s*=\s*([\d.]+)/)
    return match?.[1] ?? ''
  } catch {
    return ''
  }
}

const defaultHttpURL = process.env.SERVER_URL ?? ''

export default defineConfig({
  plugins: [react()],
  define: {
    __DEFAULT_HTTP_URL__: JSON.stringify(defaultHttpURL),
    __APP_VERSION__: JSON.stringify(readIosVersion()),
  },
})
