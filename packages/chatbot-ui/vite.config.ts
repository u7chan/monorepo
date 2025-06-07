import build from '@hono/vite-build/node'
import devServer from '@hono/vite-dev-server'
import { defineConfig } from 'vite'
import tsconfigPaths from 'vite-tsconfig-paths'

const port = 3000
const entry = './src/server/app.tsx'
const client = ['./src/client/main.tsx', './src/client/styles.css']
const libs = [
  // components
  './src/components/ChatTextInput.tsx',
  './src/components/Header.tsx',
  './src/components/MarkdownRenderer.tsx',
  './src/components/MessageArea.tsx',
  './src/components/MessageAreaScroll.tsx',
  './src/components/ThemeToggle.tsx',
  // hooks
  './src/hooks/useChat.ts',
  './src/hooks/useTheme.ts',
]

export default defineConfig(({ command, mode }) => {
  switch (command) {
    case 'build':
      switch (mode) {
        case 'lib':
          return {
            plugins: [tsconfigPaths()],
            build: {
              minify: false,
              cssCodeSplit: false,
              sourcemap: true,
              outDir: 'lib/',
              rollupOptions: {
                input: libs,
                output: {
                  entryFileNames: '[name].js',
                  chunkFileNames: '[name].js',
                  assetFileNames: '[name].[ext]',
                  manualChunks: undefined, // 自動チャンク分割をやめる
                },
              },
            },
          }
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
    case 'serve':
      return {
        plugins: [tsconfigPaths(), devServer({ entry })],
        server: { port, host: true },
      }
  }
})
