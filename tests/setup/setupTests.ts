/**
 * React Component Testing Setup Fixture
 *
 * Configures @testing-library/jest-dom matchers for Vitest and ensures
 * automatic DOM cleanup between React component tests.
 */
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// Automatically unmount mounted React trees after each test in DOM environments
afterEach(() => {
  if (typeof document !== 'undefined') {
    cleanup()
  }
})
