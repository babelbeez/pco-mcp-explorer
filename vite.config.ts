import { defineConfig } from 'vitest/config';

export default defineConfig({
  // GitHub Pages project site: https://babelbeez.github.io/pco-mcp-explorer/
  base: '/pco-mcp-explorer/',
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
