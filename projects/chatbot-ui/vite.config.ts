import build from '@hono/vite-build/node'
import devServer from '@hono/vite-dev-server'
import { defineConfig } from 'vite'
import tsconfigPaths from 'vite-tsconfig-paths'

const port = 3000
const entry = './src/server/app.tsx'
const client = ['./src/client/main.tsx', './src/client/styles.css']

export default defineConfig(({ command, mode }) =>
  command === 'build'
    ? (() => {
        switch (mode) {
          case 'client':
            return {
              plugins: [tsconfigPaths()],
              build: {
                outDir: 'dist/static',
                rollupOptions: {
                  input: client,
                  output: { entryFileNames: 'client.js', assetFileNames: '[name].[ext]' },
                },
              },
            }
          case 'server':
            return {
              plugins: [tsconfigPaths(), build({ entry, port })],
            }
        }
        throw new Error(`Invalid build mode: ${mode}`)
      })()
    : {
        plugins: [ tsconfigPaths(), devServer({ entry })],
        server: { port, host: true },
      },
)
