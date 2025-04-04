import build from '@hono/vite-build/node'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    build({
      entry: './src/app.ts',
      port: 3000,
    }),
  ],
})
