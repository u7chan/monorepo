import build from '@hono/vite-build/node'
import devServer from '@hono/vite-dev-server'
import { defineConfig } from 'vite'
import tsconfigPaths from 'vite-tsconfig-paths'

const port = 3000
const entry = './src/app.ts'

export default defineConfig(({ command }) =>
  command === 'build'
    ? {
        plugins: [tsconfigPaths(), build({ entry, port })],
      }
    : {
        plugins: [tsconfigPaths(), devServer({ entry })],
        server: { port, host: true },
      },
)
