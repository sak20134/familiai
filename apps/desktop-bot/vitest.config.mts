import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Same aliases as the esbuild bundle and tsconfig.main.json, so tests import the real shared code.
export default defineConfig({
  resolve: {
    alias: {
      '@familiai/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)),
      '@stream': fileURLToPath(new URL('../stream-copilot/src', import.meta.url)),
    },
  },
});
