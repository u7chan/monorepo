import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import devServer from '@hono/vite-dev-server'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'

const rootDir = fileURLToPath(new URL('.', import.meta.url))
const sourceAlias = {
  '#': resolve(rootDir, 'src'),
}

export default defineConfig(({ mode }) => {
  switch (mode) {
    case 'typegen':
      return {
        plugins: [
          dts({
            include: resolve(rootDir, 'src/server/app.tsx'),
            outDir: resolve(rootDir, 'src/server'),
            declarationOnly: true,
            insertTypesEntry: false,
            rollupTypes: false,
            copyDtsFiles: false,
            entryRoot: resolve(rootDir, 'src/server'),
          }),
        ],
        resolve: {
          alias: sourceAlias,
          tsconfigPaths: true,
        },
        build: {
          lib: {
            entry: resolve(rootDir, 'src/server/app.tsx'),
            name: 'typegen',
            formats: ['es'],
          },
          rollupOptions: {
            external: ['node:fs', 'node:path', 'pg', 'pgpass', 'pg-cloudflare'],
          },
        },
      }

    case 'dev':
      return {
        plugins: [
          tanstackRouter({
            target: 'react',
          }),
          devServer({
            entry: resolve(rootDir, 'src/server/app.tsx'),
          }),
        ],
        resolve: {
          alias: sourceAlias,
          tsconfigPaths: true,
        },
        server: {
          port: process.env.SERVER_PORT ? Number(process.env.SERVER_PORT) : undefined,
        },
      }

    default:
      return {
        base: '/static/',
        plugins: [
          tanstackRouter({
            target: 'react',
          }),
        ],
        resolve: {
          alias: sourceAlias,
          tsconfigPaths: true,
        },
        build: {
          minify: true,
          outDir: resolve(rootDir, 'dist/static'),
          rollupOptions: {
            input: [resolve(rootDir, 'src/client/main.tsx'), resolve(rootDir, 'src/client/main.css')],
            output: {
              entryFileNames: 'client.js',
              assetFileNames: '[name].[ext]',
            },
            onwarn(warning, warn) {
              if (warning.code === 'MODULE_LEVEL_DIRECTIVE') {
                return
              }
              warn(warning)
            },
          },
        },
      }
  }
})
