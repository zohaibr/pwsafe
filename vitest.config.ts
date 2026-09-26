import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@shared': resolve('src/shared') } },
  test: {
    include: [
      'src/**/*.test.{ts,tsx}',
      'test/integration/**/*.test.ts',
      'test/oracle/**/*.test.ts',
    ],
    environment: 'node',
    // Component tests opt in with a `// @vitest-environment jsdom` comment.
    testTimeout: 20_000,
  },
})
