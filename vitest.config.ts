import { resolve } from 'path'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer/src'),
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  test: {
    globals: true,
    environment: 'node',
    environmentMatchGlobs: [
      ['tests/components/**', 'happy-dom'],
      ['tests/renderer/**', 'happy-dom'],
      ['tests/**/*.react.{test,spec}.{ts,tsx}', 'happy-dom'],
      ['tests/reactSmoke.test.tsx', 'happy-dom']
    ],
    setupFiles: ['./tests/setup/setupTests.ts'],
    include: ['tests/**/*.{test,spec}.{ts,tsx,js,jsx}'],
    exclude: [
      '**/scratch/**',
      '**/node_modules/**',
      '**/dist/**',
      '**/out/**',
      '**/.git/**',
      '**/tests/e2e/**',
      '**/*.e2e.*'
    ]
  }
})
