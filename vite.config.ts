import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    // Tauri ships an evergreen WebView2 (Chromium); targeting the latest
    // syntax produces the smallest possible output with zero legacy transforms.
    target: 'esnext',
    rollupOptions: {
      output: {
        // Framework code changes rarely; keeping it separate preserves
        // the browser cache across app-code iterations.
        manualChunks(id) {
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id))
            return 'vendor';
        },
      },
    },
  },
  optimizeDeps: {
    include: ['react', 'react-dom'],
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
});
