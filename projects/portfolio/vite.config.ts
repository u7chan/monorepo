import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import devServer from '@hono/vite-dev-server'
import { TanStackRouterVite } from '@tanstack/router-plugin/vite'
import tsconfigPaths from 'vite-tsconfig-paths'
import dts from 'vite-plugin-dts'

export default defineConfig(({ mode }) => {
  switch (mode) {
    case 'typegen':
      return {
        plugins: [
          dts({
            include: resolve(__dirname, 'src/server/app.tsx'),
            outDir: resolve(__dirname, 'src/server'),
            declarationOnly: true,
          }),
        ],
        build: {
          lib: {
            entry: resolve(__dirname, 'src/server/app.tsx'),
            name: 'typegen',
            formats: ['es'],
          },
        },
      }

    case 'dev':
      return {
        plugins: [
          TanStackRouterVite(),
          tsconfigPaths(),
          devServer({
            entry: resolve(__dirname, 'src/server/app.tsx'),
          }),
        ],
        server: {
          port: process.env.SERVER_PORT ? Number(process.env.SERVER_PORT) : undefined,
        },
      }

    default:
      return {
        plugins: [TanStackRouterVite(), tsconfigPaths()],
        build: {
          minify: true,
          outDir: resolve(__dirname, 'dist/static'),
          rollupOptions: {
            input: [
              resolve(__dirname, 'src/client/main.tsx'),
              resolve(__dirname, 'src/client/main.css'),
            ],
            output: {
              entryFileNames: 'client.js',
              assetFileNames: '[name].[ext]',
            },
          },
        },
      }
  }
})
