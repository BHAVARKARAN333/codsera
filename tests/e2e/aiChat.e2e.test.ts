/**
 * Mocked AI Chat Workflow E2E Tests
 *
 * Verifies end-to-end AI Chat interaction:
 * 1. Open AI Chat panel.
 * 2. Send prompt with mocked successful streaming response (zero real API calls).
 * 3. Verify assistant message renders formatted response.
 * 4. Send prompt with mocked error response and verify safe error rendering without crashes.
 * 5. Mock function call and verify tool approval card (Reject / Approve) interaction.
 */

import { test, expect } from '@playwright/test'
import { launchElectronApp, createE2EWorkspace, type LaunchedAppInstance } from './helpers/electronHarness'

test.describe('Mocked AI Chat Workflow E2E Tests', () => {
  let instance: LaunchedAppInstance | null = null
  let workspace: { rootPath: string; cleanup: () => Promise<void> } | null = null

  test.beforeEach(async () => {
    workspace = await createE2EWorkspace({
      'index.ts': 'console.log("hello AI");\n'
    })
  })

  test.afterEach(async () => {
    if (instance) {
      await instance.cleanup()
      instance = null
    }
    if (workspace) {
      await workspace.cleanup()
      workspace = null
    }
  })

  test('handles mocked AI streaming response, provider error handling, and tool approval card', async () => {
    if (!workspace) throw new Error('Workspace is not initialized')

    // Pre-populate dummy API key so UI doesn't block on missing key modal
    instance = await launchElectronApp({
      workspacePath: workspace.rootPath,
      initialSettings: {
        geminiApiKey: 'mock-e2e-gemini-key-12345'
      }
    })
    const { window } = instance

    // 1. Ensure AI Assistant panel is open
    const chatPanel = window.locator('.ai-chat-panel')
    if (!(await chatPanel.isVisible())) {
      const headerBar = window.locator('header.header-bar')
      const aiAssistantBtn = headerBar.getByRole('button', { name: 'AI Assistant', exact: true })
      await aiAssistantBtn.click()
    }

    await expect(chatPanel).toBeVisible({ timeout: 10000 })

    const promptTextarea = window.locator('textarea.ai-prompt-input')
    await expect(promptTextarea).toBeVisible({ timeout: 10000 })

    // 2. Set up deterministic AI mock in renderer context
    await window.evaluate(() => {
      const g = globalThis as any
      g.__aiMockMode = 'success'
      const origFetch = g.fetch.bind(g)
      g.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : (input as Request).url
        if (typeof url === 'string' && url.includes('generativelanguage.googleapis.com')) {
          const mode = g.__aiMockMode

          if (mode === 'error') {
            return new Response(
              JSON.stringify({
                error: {
                  code: 500,
                  message: 'Simulated AI provider internal error',
                  status: 'INTERNAL'
                }
              }),
              {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
              }
            )
          }

          if (mode === 'tool_approval') {
            const ssePayload =
              'data: ' +
              JSON.stringify({
                candidates: [
                  {
                    content: {
                      parts: [
                        {
                          functionCall: {
                            name: 'run_command',
                            args: { command: 'echo "mocked approval test"' }
                          }
                        }
                      ]
                    }
                  }
                ]
              }) +
              '\n\ndata: [DONE]\n\n'

            const encoder = new TextEncoder()
            const stream = new ReadableStream({
              start(controller) {
                controller.enqueue(encoder.encode(ssePayload))
                controller.close()
              }
            })
            return new Response(stream, {
              status: 200,
              headers: { 'Content-Type': 'text/event-stream' }
            })
          }

          // Default: streaming success text response
          const ssePayload =
            'data: ' +
            JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [{ text: 'MOCKED_AI_SUCCESS_RESPONSE: The AI IDE is working correctly!' }]
                  }
                }
              ]
            }) +
            '\n\ndata: [DONE]\n\n'

          const encoder = new TextEncoder()
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(ssePayload))
              controller.close()
            }
          })
          return new Response(stream, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' }
          })
        }
        return origFetch(input, init)
      }
    })

    // Submit user prompt in success mode
    await promptTextarea.fill('Hello AI assistant')
    await promptTextarea.press('Enter')

    // Verify user message appears
    const userMessage = window.locator('.ai-message-row.user')
    await expect(userMessage).toBeVisible({ timeout: 10000 })
    await expect(userMessage).toContainText('Hello AI assistant')

    // Verify mocked assistant response is rendered
    const assistantMessage = window.locator('.ai-message-row.assistant')
    await expect(assistantMessage).toBeVisible({ timeout: 10000 })
    await expect(assistantMessage).toContainText('MOCKED_AI_SUCCESS_RESPONSE: The AI IDE is working correctly!')

    // 3. Switch mock to error mode and verify graceful handling
    await window.evaluate(() => {
      ;(globalThis as any).__aiMockMode = 'error'
    })

    await promptTextarea.fill('Trigger simulated error')
    await promptTextarea.press('Enter')

    // Verify error message renders inside chat without crashing
    const errorMessage = window.locator('.ai-error-message').first()
    await expect(errorMessage).toBeVisible({ timeout: 10000 })
    await expect(errorMessage).toContainText('The Google Gemini service is temporarily unavailable')

    // Verify input is re-enabled
    await expect(promptTextarea).toBeEnabled({ timeout: 10000 })

    // 4. Switch mock to tool approval mode and verify sensitive operation approval card
    await window.evaluate(() => {
      ;(globalThis as any).__aiMockMode = 'tool_approval'
    })

    await promptTextarea.fill('Run a test command')
    await promptTextarea.press('Enter')

    // Verify Approval Card appears
    const approvalCard = window.locator('.ai-approval-card')
    await expect(approvalCard).toBeVisible({ timeout: 10000 })
    await expect(approvalCard.locator('.ai-approval-title')).toContainText('Permission Request: Run Command')
    await expect(approvalCard.locator('.command-text')).toContainText('echo "mocked approval test"')

    // Verify Reject and Approve buttons are present
    const rejectBtn = approvalCard.locator('button.btn-reject')
    const approveBtn = approvalCard.locator('button.btn-approve')
    await expect(rejectBtn).toBeVisible()
    await expect(approveBtn).toBeVisible()

    // Test rejection: reject should dismiss approval card cleanly
    await rejectBtn.click()
    await expect(approvalCard).toBeHidden({ timeout: 5000 })
    await expect(promptTextarea).toBeEnabled({ timeout: 10000 })
  })
})
