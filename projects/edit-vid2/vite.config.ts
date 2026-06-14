import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import devServer from '@hono/vite-dev-server'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'

const rootDir = fileURLToPath(new URL('.', import.meta.url))
const sourceAlias = { '#': resolve(rootDir, 'src') }

export default defineConfig(({ mode }) => {
  switch (mode) {
    case 'typegen':
      return {
        plugins: [
          dts({
            include: './src/server/app.tsx',
            outDirs: rootDir,
            compilerOptions: {
              noEmit: false,
              declaration: true,
              emitDeclarationOnly: true,
            },
          }),
        ],
        resolve: { alias: sourceAlias },
        build: {
          lib: { entry: './src/server/app.tsx', name: 'typegen', formats: ['es'] },
          rollupOptions: {
            external: ['node:fs', 'node:path', 'bun:sqlite'],
          },
        },
      }

    case 'dev':
      return {
        plugins: [tanstackRouter({ target: 'react' }), devServer({ entry: './src/server/dev-server.ts' })],
        resolve: { alias: sourceAlias },
        server: {
          port: process.env.SERVER_PORT ? Number(process.env.SERVER_PORT) : undefined,
        },
      }

    default:
      return {
        base: '/static/',
        plugins: [tanstackRouter({ target: 'react' })],
        resolve: { alias: sourceAlias },
        build: {
          minify: true,
          outDir: 'dist/static',
          rollupOptions: {
            input: ['./src/client/main.tsx', './src/client/main.css'],
            output: {
              entryFileNames: 'client.js',
              assetFileNames: '[name].[ext]',
            },
          },
        },
      }
  }
})
