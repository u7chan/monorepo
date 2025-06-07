import build from '@hono/vite-build/node'
import devServer from '@hono/vite-dev-server'
import { defineConfig } from 'vite'
import tsconfigPaths from 'vite-tsconfig-paths'

const port = 3000
const entry = {
  server: './src/server/app.tsx',
  client: ['./src/client/main.tsx', './src/client/styles.css'],
  lib: './src/chatbot-ui/index.ts',
}

export default defineConfig(({ command, mode }) => {
  switch (command) {
    case 'build':
      switch (mode) {
        case 'lib':
          return {
            plugins: [tsconfigPaths()],
            build: {
              lib: {
                entry: entry.lib,
                name: 'chatbot-ui',
                fileName: 'index',
                formats: ['es'],
              },
              rollupOptions: {
                external: ['react', 'react-dom'],
                output: {
                  globals: {
                    react: 'React',
                    'react-dom': 'ReactDOM',
                  },
                },
              },
            },
          }
        case 'client':
          return {
            plugins: [tsconfigPaths()],
            build: {
              outDir: 'build/static',
              rollupOptions: {
                input: entry.client,
                output: { entryFileNames: 'client.js', assetFileNames: '[name].[ext]' },
              },
            },
          }
        case 'server':
          return {
            plugins: [tsconfigPaths(), build({ entry: entry.server, port, outputDir: 'build' })],
          }
      }
      throw new Error(`Invalid build mode: ${mode}`)
    case 'serve':
      return {
        plugins: [tsconfigPaths(), devServer({ entry: entry.server })],
        server: { port, host: true },
      }
  }
})
