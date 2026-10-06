/**
 * AIChatPanel Component Behavior Tests
 *
 * Verifies real React component rendering and user interaction flows
 * for the AI Assistant panel using React Testing Library in happy-dom.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { AIChatPanel } from '@renderer/components/AIChatPanel'
import { providerRegistry } from '@renderer/services/ai/providerRegistry'
import type { IAIProvider, ProviderCapabilities } from '@renderer/services/ai/types'
import { setupMockElectron, resetMockElectron } from '../setup/electronMock'

// ============================================================================
// Mock Helpers
// ============================================================================

function createMockProvider(
  id: string,
  name: string,
  capabilities: Partial<ProviderCapabilities> = {},
  sendFn?: (messages: any[], tools: any[], options: any) => Promise<any>
): IAIProvider {
  return {
    id,
    name,
    capabilities: {
      supportsStreaming: true,
      supportsTools: true,
      requiresApiKey: true,
      supportsModelListing: false,
      ...capabilities
    },
    sendMessage:
      sendFn ||
      vi.fn().mockResolvedValue({
        text: `Mock response from ${name}`,
        rawModelParts: [{ text: `Mock response from ${name}` }]
      })
  }
}

describe('AIChatPanel Component Tests', () => {
  let mockGeminiSendMessage: any
  let mockOpenCodeSendMessage: any
  let mockOpenRouterSendMessage: any
  let mockNvidiaSendMessage: any

  beforeEach(() => {
    // Setup window mocks
    setupMockElectron({
      getSettings: async () => ({
        selectedProvider: 'gemini',
        geminiApiKey: 'test-gemini-key'
      })
    })

    if (typeof window !== 'undefined' && window.HTMLElement) {
      window.HTMLElement.prototype.scrollIntoView = vi.fn()
    }

    try {
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          writeText: vi.fn().mockResolvedValue(undefined)
        },
        configurable: true,
        writable: true
      })
    } catch {}

    // Mock provider send implementations
    mockGeminiSendMessage = vi.fn().mockResolvedValue({
      text: 'I am Gemini. Here to help with your project.',
      rawModelParts: [{ text: 'I am Gemini. Here to help with your project.' }]
    })

    mockOpenCodeSendMessage = vi.fn().mockResolvedValue({
      text: 'I am OpenCode free tier assistant.',
      rawModelParts: [{ text: 'I am OpenCode free tier assistant.' }]
    })

    mockOpenRouterSendMessage = vi.fn().mockResolvedValue({
      text: 'I am OpenRouter assistant.',
      rawModelParts: [{ text: 'I am OpenRouter assistant.' }]
    })

    mockNvidiaSendMessage = vi.fn().mockResolvedValue({
      text: 'I am NVIDIA NIM assistant.',
      rawModelParts: [{ text: 'I am NVIDIA NIM assistant.' }]
    })

    const mockGeminiProvider = createMockProvider('gemini', 'Google Gemini', {
      supportsStreaming: true,
      supportsTools: true,
      requiresApiKey: true,
      supportsModelListing: false
    }, mockGeminiSendMessage)

    const mockOpenCodeProvider = createMockProvider('opencode', 'OpenCode', {
      supportsStreaming: true,
      supportsTools: true,
      requiresApiKey: false,
      supportsModelListing: true
    }, mockOpenCodeSendMessage)

    const mockOpenRouterProvider = createMockProvider('openrouter', 'OpenRouter', {
      supportsStreaming: true,
      supportsTools: true,
      requiresApiKey: true,
      supportsModelListing: false
    }, mockOpenRouterSendMessage)

    const mockNvidiaProvider = createMockProvider('nvidia', 'NVIDIA NIM', {
      supportsStreaming: false,
      supportsTools: true,
      requiresApiKey: true,
      supportsModelListing: true
    }, mockNvidiaSendMessage)

    // Spy on providerRegistry.get to return deterministic mock providers
    vi.spyOn(providerRegistry, 'get').mockImplementation((id: string) => {
      const norm = id.trim().toLowerCase()
      if (norm === 'gemini') return mockGeminiProvider
      if (norm === 'opencode') return mockOpenCodeProvider
      if (norm === 'openrouter') return mockOpenRouterProvider
      if (norm === 'nvidia') return mockNvidiaProvider
      return createMockProvider(norm, norm, {})
    })
  })

  afterEach(() => {
    cleanup()
    resetMockElectron()
    vi.restoreAllMocks()
  })

  // --------------------------------------------------------------------------
  // 1. Component Rendering & Initial State
  // --------------------------------------------------------------------------
  describe('Rendering & Initial State', () => {
    it('renders header, title, provider dropdown, model badge, and input form without crashing', async () => {
      render(<AIChatPanel workspaceRoot="/test/workspace" />)

      // Header title
      expect(screen.getByText('AI Assistant')).toBeInTheDocument()

      // Provider selector
      const selectEl = screen.getByTitle('Switch AI Provider') as HTMLSelectElement
      expect(selectEl).toBeInTheDocument()
      expect(selectEl.value).toBe('gemini')

      // Model badge
      expect(screen.getByText(/Model:/i)).toBeInTheDocument()
      expect(screen.getByText('gemini-3.8-flash')).toBeInTheDocument()

      // Input box and buttons
      expect(
        screen.getByPlaceholderText(/Ask AI about your code\.\.\./i)
      ).toBeInTheDocument()
      expect(screen.getByTitle('Send message (Enter)')).toBeInTheDocument()
      expect(screen.getByTitle('Start New Conversation')).toBeInTheDocument()
      expect(screen.getByTitle(/Provider Settings/i)).toBeInTheDocument()
    })

    it('displays empty state with description and clickable suggestions when there are no messages', () => {
      render(<AIChatPanel workspaceRoot="/test/workspace" />)

      expect(screen.getByText('AI Code Assistant')).toBeInTheDocument()
      expect(
        screen.getByText(/Ask coding questions, inspect project architecture, and manipulate workspace files/i)
      ).toBeInTheDocument()

      expect(
        screen.getByText('"List the files in my project and explain structure."')
      ).toBeInTheDocument()
      expect(
        screen.getByText('"Explain how application state is managed."')
      ).toBeInTheDocument()
    })

    it('renders close button when onClose prop is provided and triggers callback on click', async () => {
      const handleClose = vi.fn()
      render(<AIChatPanel workspaceRoot="/test/workspace" onClose={handleClose} />)

      const closeBtn = screen.getByTitle('Close AI Assistant')
      expect(closeBtn).toBeInTheDocument()

      fireEvent.click(closeBtn)
      expect(handleClose).toHaveBeenCalledTimes(1)
    })

    it('does not render close button when onClose prop is omitted', () => {
      render(<AIChatPanel workspaceRoot="/test/workspace" />)
      expect(screen.queryByTitle('Close AI Assistant')).not.toBeInTheDocument()
    })

    it('loads persisted settings on mount and updates status dot to Ready', async () => {
      render(<AIChatPanel workspaceRoot="/test/workspace" />)

      await waitFor(() => {
        expect(screen.getByText('Ready')).toBeInTheDocument()
      })
    })
  })

  // --------------------------------------------------------------------------
  // 2. Empty State & Suggestion Chips
  // --------------------------------------------------------------------------
  describe('Empty State & Suggestion Interactions', () => {
    it('clicking a suggestion chip triggers sending prompt and replaces empty state with messages', async () => {
      render(<AIChatPanel workspaceRoot="/test/workspace" />)

      const chip = screen.getByText('"List the files in my project and explain structure."')
      fireEvent.click(chip)

      // Empty state should be dismissed
      await waitFor(() => {
        expect(screen.queryByText('AI Code Assistant')).not.toBeInTheDocument()
      })

      // User message should appear
      expect(
        screen.getByText('List the files in my current project and explain the project structure.')
      ).toBeInTheDocument()

      // Mock assistant response should appear
      await waitFor(() => {
        expect(
          screen.getByText('I am Gemini. Here to help with your project.')
        ).toBeInTheDocument()
      })
    })
  })

  // --------------------------------------------------------------------------
  // 3. Input Validation & Form Submission
  // --------------------------------------------------------------------------
  describe('Input Validation & Form Submission', () => {
    it('disables send button when input prompt is empty or whitespace-only', () => {
      render(<AIChatPanel workspaceRoot="/test/workspace" />)

      const sendBtn = screen.getByTitle('Send message (Enter)') as HTMLButtonElement
      const textarea = screen.getByPlaceholderText(/Ask AI about your code/i) as HTMLTextAreaElement

      expect(textarea.value).toBe('')
      expect(sendBtn).toBeDisabled()

      fireEvent.change(textarea, { target: { value: '    ' } })
      expect(sendBtn).toBeDisabled()
    })

    it('enables send button when user types non-empty text', () => {
      render(<AIChatPanel workspaceRoot="/test/workspace" />)

      const sendBtn = screen.getByTitle('Send message (Enter)') as HTMLButtonElement
      const textarea = screen.getByPlaceholderText(/Ask AI about your code/i) as HTMLTextAreaElement

      fireEvent.change(textarea, { target: { value: 'How does indexing work?' } })
      expect(sendBtn).not.toBeDisabled()
    })

    it('submits message on send button click, renders user message, and clears textarea', async () => {
      render(<AIChatPanel workspaceRoot="/test/workspace" />)

      const textarea = screen.getByPlaceholderText(/Ask AI about your code/i) as HTMLTextAreaElement
      fireEvent.change(textarea, { target: { value: 'Explain the folder structure' } })

      const sendBtn = screen.getByTitle('Send message (Enter)')
      fireEvent.click(sendBtn)

      // Textarea cleared after send begins
      await waitFor(() => {
        expect(textarea.value).toBe('')
      })

      // User turn rendered
      expect(screen.getByText('Explain the folder structure')).toBeInTheDocument()

      // Assistant response received
      await waitFor(() => {
        expect(
          screen.getByText('I am Gemini. Here to help with your project.')
        ).toBeInTheDocument()
      })
    })

    it('submits message on Enter keydown in textarea without shiftKey', async () => {
      render(<AIChatPanel workspaceRoot="/test/workspace" />)

      const textarea = screen.getByPlaceholderText(/Ask AI about your code/i) as HTMLTextAreaElement
      fireEvent.change(textarea, { target: { value: 'Hello from keyboard' } })

      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false })

      await waitFor(() => {
        expect(textarea.value).toBe('')
      })
      expect(screen.getByText('Hello from keyboard')).toBeInTheDocument()

      await waitFor(() => {
        expect(
          screen.getByText('I am Gemini. Here to help with your project.')
        ).toBeInTheDocument()
      })
    })

    it('does not submit on Shift+Enter, allowing multiline typing', () => {
      render(<AIChatPanel workspaceRoot="/test/workspace" />)

      const textarea = screen.getByPlaceholderText(/Ask AI about your code/i) as HTMLTextAreaElement
      fireEvent.change(textarea, { target: { value: 'Line 1' } })

      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })

      // Textarea should not be cleared
      expect(textarea.value).toBe('Line 1')
      // No message submitted (empty state remains and no message rows exist)
      expect(screen.getByText('AI Code Assistant')).toBeInTheDocument()
      expect(document.querySelector('.ai-message-row')).toBeNull()
    })
  })

  // --------------------------------------------------------------------------
  // 4. Provider Selection & Switching
  // --------------------------------------------------------------------------
  describe('Provider Selection & Switching', () => {
    it('displays all four providers in the select dropdown', () => {
      render(<AIChatPanel workspaceRoot="/test/workspace" />)

      const select = screen.getByTitle('Switch AI Provider') as HTMLSelectElement
      const options = Array.from(select.options).map((o) => o.value)

      expect(options).toEqual(['gemini', 'openrouter', 'nvidia', 'opencode'])
    })

    it('switching provider updates active model, calls saveSettings, and updates badge', async () => {
      const saveSettingsSpy = vi.fn().mockResolvedValue({ success: true })
      setupMockElectron({
        getSettings: async () => ({
          selectedProvider: 'gemini',
          geminiApiKey: 'test-key'
        }),
        saveSettings: saveSettingsSpy
      })

      render(<AIChatPanel workspaceRoot="/test/workspace" />)

      const select = screen.getByTitle('Switch AI Provider') as HTMLSelectElement
      fireEvent.change(select, { target: { value: 'opencode' } })

      expect(select.value).toBe('opencode')
      expect(saveSettingsSpy).toHaveBeenCalledWith({ selectedProvider: 'opencode' })

      // OpenCode default model badge and free tier status
      await waitFor(() => {
        expect(screen.getByText('space-bunny-free')).toBeInTheDocument()
        expect(screen.getByText('Free Tier')).toBeInTheDocument()
      })
    })

    it('switching provider resets conversation messages to provide a clean session', async () => {
      render(<AIChatPanel workspaceRoot="/test/workspace" />)

      // Send first message on Gemini
      const textarea = screen.getByPlaceholderText(/Ask AI about your code/i)
      fireEvent.change(textarea, { target: { value: 'Turn on Gemini' } })
      fireEvent.click(screen.getByTitle('Send message (Enter)'))

      await waitFor(() => {
        expect(screen.getByText('Turn on Gemini')).toBeInTheDocument()
      })

      // Switch to OpenCode
      const select = screen.getByTitle('Switch AI Provider')
      fireEvent.change(select, { target: { value: 'opencode' } })

      // Messages should be cleared and empty state restored
      await waitFor(() => {
        expect(screen.queryByText('Turn on Gemini')).not.toBeInTheDocument()
        expect(screen.getByText('AI Code Assistant')).toBeInTheDocument()
      })
    })
  })

  // --------------------------------------------------------------------------
  // 5. Assistant Response Rendering & Streaming
  // --------------------------------------------------------------------------
  describe('Assistant Response Rendering', () => {
    it('renders assistant markdown response when provider resolves', async () => {
      mockGeminiSendMessage.mockResolvedValueOnce({
        text: '### Architecture Overview\nThe project uses React and Electron.',
        rawModelParts: [{ text: '### Architecture Overview\nThe project uses React and Electron.' }]
      })

      render(<AIChatPanel workspaceRoot="/test/workspace" />)

      const textarea = screen.getByPlaceholderText(/Ask AI about your code/i)
      fireEvent.change(textarea, { target: { value: 'Explain architecture' } })
      fireEvent.click(screen.getByTitle('Send message (Enter)'))

      await waitFor(() => {
        expect(screen.getByText('Architecture Overview')).toBeInTheDocument()
        expect(screen.getByText('The project uses React and Electron.')).toBeInTheDocument()
      })
    })

    it('renders streaming response chunks as they arrive from provider', async () => {
      mockGeminiSendMessage.mockImplementationOnce(
        async (_history: any[], _tools: any[], options: any) => {
          options.onChunk?.('Streaming first chunk... ')
          await new Promise((r) => setTimeout(r, 20))
          options.onChunk?.('and final chunk.')
          return {
            text: 'Streaming first chunk... and final chunk.',
            rawModelParts: [{ text: 'Streaming first chunk... and final chunk.' }]
          }
        }
      )

      render(<AIChatPanel workspaceRoot="/test/workspace" />)

      const textarea = screen.getByPlaceholderText(/Ask AI about your code/i)
      fireEvent.change(textarea, { target: { value: 'Stream test' } })
      fireEvent.click(screen.getByTitle('Send message (Enter)'))

      // First chunk visible
      await waitFor(() => {
        expect(screen.getByText(/Streaming first chunk\.\.\./i)).toBeInTheDocument()
      })

      // Final complete response
      await waitFor(() => {
        expect(
          screen.getByText(/Streaming first chunk\.\.\. and final chunk\./i)
        ).toBeInTheDocument()
      })
    })

    it('New Chat button resets conversation and returns to empty state', async () => {
      render(<AIChatPanel workspaceRoot="/test/workspace" />)

      const textarea = screen.getByPlaceholderText(/Ask AI about your code/i)
      fireEvent.change(textarea, { target: { value: 'Initial query' } })
      fireEvent.click(screen.getByTitle('Send message (Enter)'))

      await waitFor(() => {
        expect(screen.getByText('Initial query')).toBeInTheDocument()
      })

      const newChatBtn = screen.getByTitle('Start New Conversation')
      fireEvent.click(newChatBtn)

      // Messages should be cleared
      expect(screen.queryByText('Initial query')).not.toBeInTheDocument()
      expect(screen.getByText('AI Code Assistant')).toBeInTheDocument()
    })
  })

  // --------------------------------------------------------------------------
  // 6. Error Handling & Recovery
  // --------------------------------------------------------------------------
  describe('Error Handling & Recovery', () => {
    it('renders warning message and opens Settings modal when required API key is missing', async () => {
      // Setup Electron with no saved keys
      setupMockElectron({
        getSettings: async () => ({
          selectedProvider: 'gemini',
          geminiApiKey: ''
        }),
        getEnvApiKey: async () => null
      })

      render(<AIChatPanel workspaceRoot="/test/workspace" />)

      const textarea = screen.getByPlaceholderText(/Ask AI about your code/i)
      fireEvent.change(textarea, { target: { value: 'Hello without key' } })
      fireEvent.click(screen.getByTitle('Send message (Enter)'))

      // Warning message should be added
      await waitFor(() => {
        expect(
          screen.getByText(/Google Gemini API key is not configured\. Please add your key in Settings\./i)
        ).toBeInTheDocument()
      })

      // Settings modal should be opened automatically
      expect(screen.getByText('AI Provider Configuration')).toBeInTheDocument()
    })

    it('renders error bubble with error styling when provider rejects or throws', async () => {
      mockGeminiSendMessage.mockRejectedValueOnce(
        new Error('Google API quota exceeded. Please check your plan.')
      )

      render(<AIChatPanel workspaceRoot="/test/workspace" />)

      const textarea = screen.getByPlaceholderText(/Ask AI about your code/i)
      fireEvent.change(textarea, { target: { value: 'Trigger error' } })
      fireEvent.click(screen.getByTitle('Send message (Enter)'))

      await waitFor(() => {
        expect(
          screen.getByText(/Google API quota exceeded\. Please check your plan\./i)
        ).toBeInTheDocument()
      })
    })

    it('recovers to ready state after error, allowing user to submit a subsequent prompt', async () => {
      mockGeminiSendMessage
        .mockRejectedValueOnce(new Error('Temporary network glitch.'))
        .mockResolvedValueOnce({
          text: 'Second attempt succeeded!',
          rawModelParts: [{ text: 'Second attempt succeeded!' }]
        })

      render(<AIChatPanel workspaceRoot="/test/workspace" />)

      const textarea = screen.getByPlaceholderText(/Ask AI about your code/i)
      const sendBtn = screen.getByTitle('Send message (Enter)')

      // First attempt fails
      fireEvent.change(textarea, { target: { value: 'First attempt' } })
      fireEvent.click(sendBtn)

      await waitFor(() => {
        expect(screen.getByText(/Temporary network glitch\./i)).toBeInTheDocument()
      })

      // Send button should be restored and textarea enabled
      expect(sendBtn).toBeDisabled() // empty input
      expect(textarea).not.toBeDisabled()

      // Second attempt succeeds
      fireEvent.change(textarea, { target: { value: 'Second attempt' } })
      fireEvent.click(sendBtn)

      await waitFor(() => {
        expect(screen.getByText('Second attempt succeeded!')).toBeInTheDocument()
      })
    })
  })

  // --------------------------------------------------------------------------
  // 7. Execution Controls & Cancellation (Stop)
  // --------------------------------------------------------------------------
  describe('Execution Controls & Cancellation', () => {
    it('shows Stop button and status indicator while generation is running', async () => {
      let resolvePromise: (value: any) => void
      const slowPromise = new Promise((resolve) => {
        resolvePromise = resolve
      })

      mockGeminiSendMessage.mockImplementationOnce(() => slowPromise)

      render(<AIChatPanel workspaceRoot="/test/workspace" />)

      const textarea = screen.getByPlaceholderText(/Ask AI about your code/i)
      fireEvent.change(textarea, { target: { value: 'Long running request' } })
      fireEvent.click(screen.getByTitle('Send message (Enter)'))

      // Stop button and thinking indicator should be visible once generation starts
      await waitFor(() => {
        expect(screen.getByTitle('Stop generation')).toBeInTheDocument()
        expect(screen.getByText(/Thinking\.\.\./i)).toBeInTheDocument()
        expect(screen.getByText('Generation in progress')).toBeInTheDocument()
        expect(textarea).toBeDisabled()
      })

      // Cleanup long promise
      resolvePromise!({ text: 'Done', rawModelParts: [{ text: 'Done' }] })
    })

    it('clicking Stop button halts in-flight request and restores Send button', async () => {
      mockGeminiSendMessage.mockImplementationOnce(
        () => new Promise((_resolve) => {
          // Never resolves naturally to simulate in-flight task
        })
      )

      render(<AIChatPanel workspaceRoot="/test/workspace" />)

      const textarea = screen.getByPlaceholderText(/Ask AI about your code/i)
      fireEvent.change(textarea, { target: { value: 'Cancel me' } })
      fireEvent.click(screen.getByTitle('Send message (Enter)'))

      const stopBtn = await screen.findByTitle('Stop generation')
      expect(stopBtn).toBeInTheDocument()

      fireEvent.click(stopBtn)

      // Stop button replaced with Send button
      await waitFor(() => {
        expect(screen.queryByTitle('Stop generation')).not.toBeInTheDocument()
        expect(screen.getByTitle('Send message (Enter)')).toBeInTheDocument()
      })

      expect(textarea).not.toBeDisabled()
    })
  })

  // --------------------------------------------------------------------------
  // 8. Settings Modal Interaction
  // --------------------------------------------------------------------------
  describe('Settings Modal Interaction', () => {
    it('opens settings modal on settings button click and displays provider tabs', () => {
      render(<AIChatPanel workspaceRoot="/test/workspace" />)

      const settingsBtn = screen.getByTitle(/Provider Settings/i)
      fireEvent.click(settingsBtn)

      expect(screen.getByText('AI Provider Configuration')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Google Gemini' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'OpenRouter (Free)' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'NVIDIA NIM' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'OpenCode (Free)' })).toBeInTheDocument()
    })

    it('switches provider tabs inside settings dialog', () => {
      render(<AIChatPanel workspaceRoot="/test/workspace" />)

      fireEvent.click(screen.getByTitle(/Provider Settings/i))

      const openCodeTab = screen.getByRole('button', { name: 'OpenCode (Free)' })
      fireEvent.click(openCodeTab)

      expect(
        screen.getByText(/OpenCode Console API Key \(Optional\)/i)
      ).toBeInTheDocument()
    })

    it('persists entered API key when clicking Save Settings', async () => {
      const saveSettingsSpy = vi.fn().mockResolvedValue({ success: true })
      setupMockElectron({
        getSettings: async () => ({ selectedProvider: 'gemini' }),
        saveSettings: saveSettingsSpy
      })

      render(<AIChatPanel workspaceRoot="/test/workspace" />)

      fireEvent.click(screen.getByTitle(/Provider Settings/i))

      const keyInput = screen.getByPlaceholderText('AIzaSy...')
      fireEvent.change(keyInput, { target: { value: 'AIzaSy_NEW_KEY_12345' } })

      const saveBtn = screen.getByRole('button', { name: 'Save Settings' })
      fireEvent.click(saveBtn)

      await waitFor(() => {
        expect(saveSettingsSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            geminiApiKey: 'AIzaSy_NEW_KEY_12345'
          })
        )
      })

      // Modal should be closed
      expect(screen.queryByText('AI Provider Configuration')).not.toBeInTheDocument()
    })

    it('closes settings modal on Cancel button without persisting changes', () => {
      const saveSettingsSpy = vi.fn()
      setupMockElectron({
        getSettings: async () => ({ selectedProvider: 'gemini' }),
        saveSettings: saveSettingsSpy
      })

      render(<AIChatPanel workspaceRoot="/test/workspace" />)

      fireEvent.click(screen.getByTitle(/Provider Settings/i))
      expect(screen.getByText('AI Provider Configuration')).toBeInTheDocument()

      const cancelBtn = screen.getByRole('button', { name: 'Cancel' })
      fireEvent.click(cancelBtn)

      expect(screen.queryByText('AI Provider Configuration')).not.toBeInTheDocument()
      expect(saveSettingsSpy).not.toHaveBeenCalled()
    })
  })

  // --------------------------------------------------------------------------
  // 9. Component Cleanup & Async State Protection
  // --------------------------------------------------------------------------
  describe('Component Cleanup & Async State Protection', () => {
    it('unregisters file watcher and stops orchestrator on component unmount', () => {
      const unsubscribeSpy = vi.fn()
      setupMockElectron({
        onWorkspaceFileChanged: vi.fn().mockReturnValue(unsubscribeSpy)
      })

      const { unmount } = render(<AIChatPanel workspaceRoot="/test/workspace" />)
      unmount()

      expect(unsubscribeSpy).toHaveBeenCalled()
    })
  })
})
