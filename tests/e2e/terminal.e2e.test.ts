/**
 * Terminal Workflow E2E Tests
 *
 * Verifies end-to-end integrated terminal operations:
 * 1. Open terminal panel.
 * 2. Create a new terminal session tab.
 * 3. Run a safe node-based command and verify streamed stdout.
 * 4. Verify exit code 0 status badge.
 * 5. Run a persistent command, stop it via UI Stop button, and verify stopped state.
 * 6. Verify clean teardown without orphan processes.
 */

import { test, expect } from '@playwright/test'
import { launchElectronApp, createE2EWorkspace, type LaunchedAppInstance } from './helpers/electronHarness'

test.describe('Terminal Workflow E2E Tests', () => {
  let instance: LaunchedAppInstance | null = null
  let workspace: { rootPath: string; cleanup: () => Promise<void> } | null = null

  test.beforeEach(async () => {
    workspace = await createE2EWorkspace()
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

  test('opens terminal, executes command, streams stdout, stops running process, and cleans up', async () => {
    if (!workspace) throw new Error('Workspace is not initialized')

    instance = await launchElectronApp({ workspacePath: workspace.rootPath })
    const { window, app } = instance

    // 1. Open terminal panel via top header button
    const terminalHeaderBtn = window.locator('header.header-bar').getByRole('button', { name: /terminal/i })
    await terminalHeaderBtn.click()

    const terminalPanel = window.locator('.terminal-panel')
    await expect(terminalPanel).toBeVisible({ timeout: 10000 })

    // 2. Create a new terminal session if none open, or verify default session
    const tabList = window.locator('.terminal-tab')
    const count = await tabList.count()
    if (count === 0) {
      const newTabBtn = window.locator('.terminal-create-tab-btn, .terminal-new-tab-btn').first()
      await newTabBtn.click()
    }

    const activeTab = window.locator('.terminal-tab.active')
    await expect(activeTab).toBeVisible({ timeout: 10000 })

    const terminalInput = window.locator('input.terminal-input')
    await expect(terminalInput).toBeEnabled({ timeout: 10000 })

    // 3. Run harmless command: printing a fixed test string
    const testCommand = 'node -e "console.log(\'E2E_STREAMED_TERMINAL_OUTPUT\')"'
    await terminalInput.fill(testCommand)
    await terminalInput.press('Enter')

    // 4. Verify streamed output appears in the terminal body
    const stdoutEntry = window.locator('.terminal-stdout').filter({ hasText: 'E2E_STREAMED_TERMINAL_OUTPUT' })
    await expect(stdoutEntry).toBeVisible({ timeout: 10000 })

    // Verify exit code 0 status badge
    const successBadge = window.locator('.terminal-status-badge.success')
    await expect(successBadge).toBeVisible({ timeout: 10000 })

    // 5. Run a persistent command and stop it via UI
    const longRunningCommand = 'node -e "setInterval(() => console.log(\'still-alive\'), 500)"'
    await terminalInput.fill(longRunningCommand)
    await terminalInput.press('Enter')

    // Verify running state badge appears
    const runningBadge = window.locator('.terminal-running-badge')
    await expect(runningBadge).toBeVisible({ timeout: 10000 })

    // Stop the running process
    const stopBtn = window.locator('button[aria-label="Stop running command"]')
    await expect(stopBtn).toBeVisible({ timeout: 5000 })
    await stopBtn.click()

    // Verify running badge disappears
    await expect(runningBadge).toBeHidden({ timeout: 10000 })

    // 6. Verify terminal cleanup and process exit
    const pid = app.process()?.pid
    expect(typeof pid).toBe('number')

    await instance.cleanup()
    instance = null

    // Give OS a moment to reap process
    await new Promise((r) => setTimeout(r, 300))

    let isAlive = false
    try {
      if (pid) {
        process.kill(pid, 0)
        isAlive = true
      }
    } catch {
      isAlive = false
    }

    expect(isAlive).toBe(false)
  })
})
