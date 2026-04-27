import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  oxc: {
    target: 'es2019'
  },
  build: {
    target: 'es2019'
  },
  server: {
    host: '0.0.0.0',
    port: 1420,
    strictPort: true,
    forwardConsole: true
  }
});
