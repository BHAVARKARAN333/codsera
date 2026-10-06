/**
 * Error Handling and Regression E2E Tests
 *
 * Verifies end-to-end resilience against errors and subsystem cross-talk:
 * 1. Non-existent saved workspace path falls back cleanly to 'No Folder Opened' without crash.
 * 2. Explorer modal input validation prevents empty and invalid filenames with inline error feedback.
 * 3. AI provider error response renders gracefully while editor and terminal remain completely functional.
 */

import { test, expect } from '@playwright/test'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import {
  launchElectronApp,
  createE2EWorkspace,
  type LaunchedAppInstance
} from './helpers/electronHarness'

test.describe('Error Handling and Regression E2E Tests', () => {
  let instance: LaunchedAppInstance | null = null
  let workspace: { rootPath: string; cleanup: () => Promise<void> } | null = null

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

  test('falls back gracefully to empty state when saved workspace path does not exist', async () => {
    const nonExistentPath = path.join(os.tmpdir(), 'ai-ide-non-existent-ws-' + Date.now())

    instance = await launchElectronApp({
      initialSettings: {
        lastWorkspaceRoot: nonExistentPath
      }
    })
    const { window } = instance

    // Explorer should show 'No Folder Opened' empty state
    const emptyState = window.locator('.sidebar-empty')
    await expect(emptyState).toBeVisible({ timeout: 10000 })
    await expect(emptyState.locator('.sidebar-empty-title')).toHaveText('No Folder Opened')

    // App header should be fully responsive
    const openFolderBtn = window.locator('header.header-bar').getByRole('button', { name: /open folder/i })
    await expect(openFolderBtn).toBeVisible({ timeout: 10000 })
  })

  test('validates modal inputs and blocks invalid filenames in file explorer', async () => {
    workspace = await createE2EWorkspace({
      'existing.txt': 'hello\n'
    }, 'e2e-err-explorer-')

    instance = await launchElectronApp({ workspacePath: workspace.rootPath })
    const { window } = instance

    // Open New File modal
    const newFileBtn = window.locator('button[aria-label="New File"]')
    await expect(newFileBtn).toBeVisible({ timeout: 10000 })
    await newFileBtn.click()

    const modal = window.locator('.explorer-modal')
    await expect(modal).toBeVisible({ timeout: 5000 })
    await expect(modal.locator('.explorer-modal-header')).toContainText('New File')

    const input = modal.locator('input.explorer-modal-input')
    const createBtn = modal.locator('.explorer-modal-footer button.btn-primary')

    // 1. Submit empty input
    await input.fill('')
    await createBtn.click()

    const errorMsg = modal.locator('.explorer-modal-error')
    await expect(errorMsg).toBeVisible({ timeout: 5000 })
    await expect(errorMsg).toContainText('Name cannot be empty')

    // 2. Submit invalid characters
    await input.fill('bad:file*name?.txt')
    await createBtn.click()

    await expect(errorMsg).toBeVisible({ timeout: 5000 })
    await expect(errorMsg).toContainText('Name contains invalid characters')

    // 3. Cancel modal safely
    const cancelBtn = modal.locator('.explorer-modal-footer button.btn-secondary')
    await cancelBtn.click()
    await expect(modal).toBeHidden()

    // Explorer tree remains functional
    await expect(window.locator('.tree-node').filter({ hasText: 'existing.txt' })).toBeVisible()
  })

  test('contains AI provider errors and maintains full editor and terminal functionality', async () => {
    workspace = await createE2EWorkspace({
      'task.ts': 'export const data = 42;\n'
    }, 'e2e-err-ai-')

    instance = await launchElectronApp({
      workspacePath: workspace.rootPath,
      initialSettings: {
        geminiApiKey: 'mock-valid-looking-key-12345'
      }
    })
    const { window } = instance

    // 1. Open AI Assistant panel
    const chatPanel = window.locator('.ai-chat-panel')
    if (!(await chatPanel.isVisible())) {
      const aiAssistantBtn = window.locator('header.header-bar').getByRole('button', { name: 'AI Assistant', exact: true })
      await aiAssistantBtn.click()
    }
    await expect(chatPanel).toBeVisible({ timeout: 10000 })

    // Configure mock fetch to simulate a 500 Provider error
    await window.evaluate(() => {
      const g = globalThis as any
      const origFetch = g.fetch.bind(g)
      g.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : (input as Request).url
        if (typeof url === 'string' && url.includes('generativelanguage.googleapis.com')) {
          return new Response(
            JSON.stringify({
              error: {
                code: 500,
                message: 'Simulated AI provider internal failure',
                status: 'INTERNAL'
              }
            }),
            {
              status: 500,
              headers: { 'Content-Type': 'application/json' }
            }
          )
        }
        return origFetch(input, init)
      }
    })

    const promptInput = window.locator('textarea.ai-prompt-input')
    await promptInput.fill('Trigger provider crash')
    await promptInput.press('Enter')

    // AI error should render cleanly
    const aiError = window.locator('.ai-error-message')
    await expect(aiError).toBeVisible({ timeout: 10000 })
    await expect(aiError).toContainText(/unavailable|error|failed/i)

    // 2. Cross-Subsystem State Isolation: Editor remains responsive
    const fileNode = window.locator('.tree-node').filter({ hasText: 'task.ts' })
    await fileNode.click()

    const editorTab = window.locator('.editor-tab').filter({ hasText: 'task.ts' })
    await expect(editorTab).toBeVisible({ timeout: 10000 })

    const monaco = window.locator('.monaco-editor')
    await expect(monaco).toBeVisible({ timeout: 10000 })
    await monaco.click()
    await window.keyboard.press('End')
    await window.keyboard.type('\nexport const isolated = true;')

    // Save active file
    await window.keyboard.press('Control+s')

    const fileContent = await fs.readFile(path.join(workspace.rootPath, 'task.ts'), 'utf-8')
    expect(fileContent).toContain('export const isolated = true;')

    // 3. Cross-Subsystem State Isolation: Terminal executes independently
    const terminalHeaderBtn = window.locator('header.header-bar').getByRole('button', { name: /terminal/i })
    await terminalHeaderBtn.click()

    const terminalPanel = window.locator('.terminal-panel')
    await expect(terminalPanel).toBeVisible({ timeout: 10000 })

    const terminalInput = window.locator('input.terminal-input')
    await terminalInput.fill('node -e "console.log(\'TERMINAL_HEALTHY\')"')
    await terminalInput.press('Enter')

    const terminalOut = window.locator('.terminal-stdout').filter({ hasText: 'TERMINAL_HEALTHY' })
    await expect(terminalOut).toBeVisible({ timeout: 10000 })
  })
})
