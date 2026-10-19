import { defineConfig } from 'vitest/config';

// `base` is relative so the build works when hosted under a sub-path (e.g. GitHub Pages /<repo>/).
export default defineConfig({
  base: './',
  build: {
    rollupOptions: {
      // Keep three.js in its own long-lived vendor chunk, separate from app code.
      output: { manualChunks: { three: ['three'] } },
    },
    chunkSizeWarningLimit: 600,
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
