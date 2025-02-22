import { defineConfig } from 'vite'
import devServer from '@hono/vite-dev-server'
import { TanStackRouterVite } from '@tanstack/router-plugin/vite'

export default defineConfig(({ mode }) => {
  if (mode === 'dev') {
    return {
      plugins: [
        TanStackRouterVite(),
        devServer({
          entry: './src/server.tsx',
        }),
      ],
    }
  }
  return {
    plugins: [TanStackRouterVite()],
    build: {
      minify: true,
      outDir: './dist/static',
      rollupOptions: {
        input: ['./src/client.tsx', './src/main.css'],
        output: {
          entryFileNames: 'client.js',
          assetFileNames: '[name].[ext]',
        },
      },
    },
  }
})
