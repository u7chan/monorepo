import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const rootDir = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '#': resolve(rootDir, 'src'),
    },
  },
  test: {
    environment: 'node',
    setupFiles: ['./src/server/test/setup.ts'],
    include: ['src/server/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/server/**/*.{ts,tsx}'],
      exclude: ['src/server/**/*.test.{ts,tsx}', 'src/server/app.d.ts', 'src/server/node-server.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 70,
        statements: 80,
      },
    },
  },
})
