import build from '@hono/vite-build/node'
import devServer from '@hono/vite-dev-server'
import { defineConfig } from 'vite'

const port = 3000
const entry = './src/app.ts'

export default defineConfig(({ command }) =>
  command === 'build'
    ? {
        plugins: [build({ entry, port })],
      }
    : {
        plugins: [devServer({ entry })],
        server: { port, host: true },
      },
)
