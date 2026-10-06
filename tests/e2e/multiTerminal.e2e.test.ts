/**
 * Multi-Session Terminal Reliability E2E Tests
 *
 * Verifies end-to-end multi-terminal behavior:
 * 1. Creates multiple terminal tabs (Terminal 1, Terminal 2).
 * 2. Runs separate commands in each session and verifies strict stdout isolation.
 * 3. Switches tabs during process execution without cross-tab contamination.
 * 4. Verifies one tab's running process does not block or affect another tab.
 * 5. Verifies running process close confirmation modal (Cancel vs Terminate & Close).
 */

import { test, expect } from '@playwright/test'
import { launchElectronApp, createE2EWorkspace, type LaunchedAppInstance } from './helpers/electronHarness'

test.describe('Multi-Session Terminal Reliability E2E Tests', () => {
  let instance: LaunchedAppInstance | null = null
  let workspace: { rootPath: string; cleanup: () => Promise<void> } | null = null

  test.beforeEach(async () => {
    workspace = await createE2EWorkspace({}, 'e2e-multi-term-')
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

  test('creates multiple terminal tabs with isolated stdout and independent execution', async () => {
    if (!workspace) throw new Error('Workspace not initialized')

    instance = await launchElectronApp({ workspacePath: workspace.rootPath })
    const { window } = instance

    // 1. Open Terminal panel via header button
    const terminalHeaderBtn = window.locator('header.header-bar').getByRole('button', { name: /terminal/i })
    await terminalHeaderBtn.click()

    const terminalPanel = window.locator('.terminal-panel')
    await expect(terminalPanel).toBeVisible({ timeout: 10000 })

    // Verify initial Terminal 1 tab exists
    const tab1 = window.locator('.terminal-tab').filter({ hasText: 'Terminal 1' })
    await expect(tab1).toBeVisible({ timeout: 10000 })
    await expect(tab1).toHaveClass(/active/)

    // 2. Create Terminal 2 tab
    const newTabBtn = window.locator('.terminal-new-tab-btn')
    await newTabBtn.click()

    const tab2 = window.locator('.terminal-tab').filter({ hasText: 'Terminal 2' })
    await expect(tab2).toBeVisible({ timeout: 10000 })
    await expect(tab2).toHaveClass(/active/)

    const terminalInput = window.locator('input.terminal-input')
    await expect(terminalInput).toBeEnabled({ timeout: 10000 })

    // 3. Run command in Terminal 2
    await terminalInput.fill('node -e "console.log(\'TERM_OUT_2\')"')
    await terminalInput.press('Enter')

    const out2 = window.locator('.terminal-stdout').filter({ hasText: 'TERM_OUT_2' })
    await expect(out2).toBeVisible({ timeout: 10000 })

    // 4. Switch to Terminal 1 and verify TERM_OUT_2 is NOT present
    await tab1.click()
    await expect(tab1).toHaveClass(/active/)
    await expect(out2).toBeHidden()

    // 5. Run command in Terminal 1
    await terminalInput.fill('node -e "console.log(\'TERM_OUT_1\')"')
    await terminalInput.press('Enter')

    const out1 = window.locator('.terminal-stdout').filter({ hasText: 'TERM_OUT_1' })
    await expect(out1).toBeVisible({ timeout: 10000 })

    // 6. Switch back to Terminal 2 and verify isolation
    await tab2.click()
    await expect(tab2).toHaveClass(/active/)
    await expect(out2).toBeVisible({ timeout: 10000 })
    await expect(out1).toBeHidden()
  })

  test('handles concurrent running processes and close confirmation modal safely', async () => {
    if (!workspace) throw new Error('Workspace not initialized')

    instance = await launchElectronApp({ workspacePath: workspace.rootPath })
    const { window } = instance

    // Open Terminal panel
    const terminalHeaderBtn = window.locator('header.header-bar').getByRole('button', { name: /terminal/i })
    await terminalHeaderBtn.click()

    const tab1 = window.locator('.terminal-tab').filter({ hasText: 'Terminal 1' })
    await expect(tab1).toBeVisible({ timeout: 10000 })

    // Create Terminal 2
    const newTabBtn = window.locator('.terminal-new-tab-btn')
    await newTabBtn.click()

    const tab2 = window.locator('.terminal-tab').filter({ hasText: 'Terminal 2' })
    await expect(tab2).toBeVisible({ timeout: 10000 })
    await expect(tab2).toHaveClass(/active/)

    const terminalInput = window.locator('input.terminal-input')

    // 1. Start long-running process in Terminal 2
    await terminalInput.fill('node -e "setInterval(() => console.log(\'T2_ALIVE\'), 300)"')
    await terminalInput.press('Enter')

    const runningBadge = window.locator('.terminal-running-badge')
    await expect(runningBadge).toBeVisible({ timeout: 10000 })

    // 2. Switch to Terminal 1 while Terminal 2 is running
    await tab1.click()
    await expect(tab1).toHaveClass(/active/)
    // Terminal 1 is idle, running badge should not be shown for it
    await expect(runningBadge).toBeHidden()

    // Terminal 1 can execute independent commands
    await terminalInput.fill('node -e "console.log(\'T1_INDEPENDENT\')"')
    await terminalInput.press('Enter')
    await expect(window.locator('.terminal-stdout').filter({ hasText: 'T1_INDEPENDENT' })).toBeVisible({ timeout: 10000 })

    // 3. Switch back to Terminal 2: still running
    await tab2.click()
    await expect(tab2).toHaveClass(/active/)
    await expect(runningBadge).toBeVisible({ timeout: 10000 })

    // 4. Try to close running Terminal 2 tab -> trigger confirmation modal
    const closeTab2Btn = tab2.locator('.terminal-tab-close-btn')
    await closeTab2Btn.click()

    const confirmModal = window.locator('.terminal-confirm-modal')
    await expect(confirmModal).toBeVisible({ timeout: 10000 })
    await expect(confirmModal).toContainText('Terminate Running Session?')

    // 5. Cancel closing -> session remains running
    const cancelBtn = confirmModal.locator('.explorer-modal-footer button').filter({ hasText: 'Cancel' })
    await cancelBtn.click()
    await expect(confirmModal).toBeHidden()
    await expect(tab2).toBeVisible()
    await expect(runningBadge).toBeVisible()

    // 6. Terminate & Close -> modal confirms and closes tab cleanly
    await closeTab2Btn.click()
    await expect(confirmModal).toBeVisible({ timeout: 10000 })

    const terminateBtn = confirmModal.getByRole('button', { name: /terminate & close/i })
    await terminateBtn.click()

    await expect(confirmModal).toBeHidden()
    await expect(tab2).toBeHidden({ timeout: 10000 })
    await expect(tab1).toHaveClass(/active/)
  })
})
