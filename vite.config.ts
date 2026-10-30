import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { '/api': process.env.TACK_API ?? 'http://localhost:3000', '/mcp': process.env.TACK_API ?? 'http://localhost:3000' },
  },
});
