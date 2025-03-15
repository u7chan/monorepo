import { defineConfig } from 'vite'
import devServer from '@hono/vite-dev-server'
import { TanStackRouterVite } from '@tanstack/router-plugin/vite'

export default defineConfig(({ mode }) => {
  if (mode === 'dev') {
    return {
      plugins: [
        TanStackRouterVite(),
        devServer({
          entry: './src/server/app.tsx',
        }),
      ],
      server: {
        port: process.env.SERVER_PORT ? Number(process.env.SERVER_PORT) : undefined,
      },
    }
  }
  return {
    plugins: [TanStackRouterVite()],
    build: {
      minify: true,
      outDir: './dist/static',
      rollupOptions: {
        input: ['./src/client/main.tsx', './src/client/main.css'],
        output: {
          entryFileNames: 'client.js',
          assetFileNames: '[name].[ext]',
        },
      },
    },
  }
})
