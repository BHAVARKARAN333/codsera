/**
 * React Component Testing Smoke Suite
 *
 * Verifies that the React Testing Library foundation operates properly
 * in the happy-dom test environment, including:
 * 1. Proper component rendering into the DOM.
 * 2. User interactions via @testing-library/user-event and state updates.
 * 3. Custom @testing-library/jest-dom assertions and matchers.
 * 4. Automatic DOM cleanup between consecutive test cases.
 */

import React, { useState } from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// Simple test-only component for foundation verification
interface TestCounterProps {
  initialCount?: number
  label?: string
}

const TestCounter: React.FC<TestCounterProps> = ({ initialCount = 0, label = 'Test Counter' }) => {
  const [count, setCount] = useState(initialCount)
  const [enabled, setEnabled] = useState(true)

  return (
    <div data-testid="counter-box" className="test-widget">
      <h3 data-testid="counter-title">{label}</h3>
      <p data-testid="counter-value">Current count: {count}</p>
      <button
        data-testid="increment-btn"
        disabled={!enabled}
        onClick={() => setCount((c) => c + 1)}
      >
        Increment
      </button>
      <button
        data-testid="toggle-btn"
        onClick={() => setEnabled((e) => !e)}
      >
        {enabled ? 'Disable' : 'Enable'}
      </button>
    </div>
  )
}

describe('React Component Testing Smoke Suite', () => {
  it('renders a React component correctly into happy-dom document', () => {
    render(<TestCounter initialCount={5} label="Header Smoke" />)

    const titleEl = screen.getByTestId('counter-title')
    expect(titleEl).toBeInTheDocument()
    expect(titleEl).toHaveTextContent('Header Smoke')

    const countEl = screen.getByTestId('counter-value')
    expect(countEl).toBeInTheDocument()
    expect(countEl).toHaveTextContent('Current count: 5')

    const incrementBtn = screen.getByTestId('increment-btn')
    expect(incrementBtn).toBeInTheDocument()
    expect(incrementBtn).toBeEnabled()

    const toggleBtn = screen.getByTestId('toggle-btn')
    expect(toggleBtn).toBeInTheDocument()
    expect(toggleBtn).toHaveTextContent('Disable')
  })

  it('updates visible UI upon user interaction with button click', async () => {
    const user = userEvent.setup()
    render(<TestCounter initialCount={0} label="Interactive Test" />)

    const countEl = screen.getByTestId('counter-value')
    const incrementBtn = screen.getByTestId('increment-btn')
    const toggleBtn = screen.getByTestId('toggle-btn')

    expect(countEl).toHaveTextContent('Current count: 0')

    // Click increment
    await user.click(incrementBtn)
    expect(countEl).toHaveTextContent('Current count: 1')

    // Click increment again
    await user.click(incrementBtn)
    expect(countEl).toHaveTextContent('Current count: 2')

    // Click toggle to disable increment button
    await user.click(toggleBtn)
    expect(incrementBtn).toBeDisabled()
    expect(toggleBtn).toHaveTextContent('Enable')
  })

  it('verifies that Testing Library cleanup unmounts DOM elements from previous test', () => {
    // In previous test we rendered "Interactive Test"
    // With automatic cleanup, that element should not be present in the document
    expect(screen.queryByText('Interactive Test')).not.toBeInTheDocument()
    expect(screen.queryByTestId('counter-box')).not.toBeInTheDocument()

    // Render new distinct instance
    render(<TestCounter initialCount={42} label="Fresh Clean Test" />)
    expect(screen.getByText('Fresh Clean Test')).toBeInTheDocument()
    expect(screen.getByTestId('counter-value')).toHaveTextContent('Current count: 42')
  })

  it('supports explicit cleanup() invocation to reset document body', () => {
    render(<TestCounter initialCount={100} label="Manual Cleanup Test" />)
    expect(screen.getByText('Manual Cleanup Test')).toBeInTheDocument()

    // Explicitly run cleanup
    cleanup()

    expect(screen.queryByText('Manual Cleanup Test')).not.toBeInTheDocument()
    expect(document.body.innerHTML).toBe('')
  })
})
