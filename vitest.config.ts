import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Windows spawns (PowerShell, git, CLI fixtures) are slower under the full
    // parallel suite than the previous 5s default.
    testTimeout: 15_000
  }
})
