import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'bff-dist',
    emptyOutDir: true,
  },
  server: {
    port: 8090,
  },
  preview: {
    port: 8090,
    host: '127.0.0.1',
    strictPort: true,
  },
});
