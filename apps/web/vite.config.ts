import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // The API owns persistence and long studies; the engine itself runs in
      // the browser, so only these calls cross the network.
      '/api': { target: 'http://localhost:5177', changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
