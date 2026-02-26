import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/upload': 'http://localhost:8000',
      '/export': 'http://localhost:8000',
      '/preview': 'http://localhost:8000',
      '/clear-cache': 'http://localhost:8000',
      '/videos': 'http://localhost:8000',
      '/exports': 'http://localhost:8000',
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
