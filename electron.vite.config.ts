import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/main/index.ts') },
    },
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/preload/index.ts') },
    },
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') },
      // Monaco is chunky; don't nag about it.
      chunkSizeWarningLimit: 4096,
    },
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer'),
        '@shared': resolve(__dirname, 'src/shared'),
      },
    },
  },
});
