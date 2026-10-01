import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // A few cases wait on real timeouts and retry delays on purpose.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
