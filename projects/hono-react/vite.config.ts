import { defineConfig } from 'vite'
import devServer from '@hono/vite-dev-server'
import { TanStackRouterVite } from '@tanstack/router-plugin/vite'

export default defineConfig(() => {
  return {
    plugins: [
      TanStackRouterVite(),
      devServer({
        entry: './src/server.tsx',
      }),
    ],
  }
})
