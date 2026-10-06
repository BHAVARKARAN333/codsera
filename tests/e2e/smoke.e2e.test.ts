/**
 * Electron E2E Smoke Tests
 *
 * Verifies that the real desktop application:
 * 1. Launches and displays its main Electron window.
 * 2. Renders the core workspace UI shell without fatal startup errors.
 * 3. Restores and browses a test workspace, opening editor tabs.
 * 4. Shuts down cleanly without leaving orphaned processes.
 */

import { test, expect } from '@playwright/test'
import path from 'path'
import { launchElectronApp, createE2EWorkspace, type LaunchedAppInstance } from './helpers/electronHarness'

test.describe('Electron Application E2E Smoke Tests', () => {
  let instance: LaunchedAppInstance | null = null

  test.afterEach(async () => {
    if (instance) {
      await instance.cleanup()
      instance = null
    }
  })

  test('1. launches application and displays main window with correct title', async () => {
    instance = await launchElectronApp()
    const { window } = instance

    // Verify window title
    const title = await window.title()
    expect(title).toBe('AI IDE')

    // Verify URL points to local production renderer
    const currentUrl = window.url()
    expect(currentUrl).toMatch(/renderer\/index\.html$/i)
  })

  test('2. renders main workspace UI shell without startup errors', async () => {
    instance = await launchElectronApp()
    const { window } = instance

    // Header bar elements
    const appTitle = window.locator('.app-title')
    await expect(appTitle).toBeVisible()
    await expect(appTitle).toHaveText('AI IDE')

    const versionPill = window.locator('.app-version-pill')
    await expect(versionPill).toBeVisible()
    await expect(versionPill).toHaveText('PRO')

    // Default empty workspace pill
    const workspacePill = window.locator('.workspace-pill')
    await expect(workspacePill).toBeVisible()
    await expect(workspacePill).toContainText('No Workspace Opened')

    // Top action buttons in header
    const headerBar = window.locator('header.header-bar')
    const openFolderBtn = headerBar.getByRole('button', { name: /open folder/i })
    await expect(openFolderBtn).toBeVisible()

    const terminalBtn = headerBar.getByRole('button', { name: /terminal/i })
    await expect(terminalBtn).toBeVisible()

    const aiAssistantBtn = headerBar.getByRole('button', { name: 'AI Assistant', exact: true })
    await expect(aiAssistantBtn).toBeVisible()

    // Activity bar navigation
    const activityBar = window.getByLabel('Activity Bar')
    await expect(activityBar).toBeVisible()

    const explorerNavBtn = window.getByRole('button', { name: 'Explorer' })
    await expect(explorerNavBtn).toBeVisible()

    const sourceControlNavBtn = window.getByRole('button', { name: 'Source Control' })
    await expect(sourceControlNavBtn).toBeVisible()

    // Status bar
    const statusBar = window.locator('.status-bar')
    await expect(statusBar).toBeVisible()
  })

  test('3. loads workspace, populates file explorer, and opens an editor tab on click', async () => {
    // Create an isolated workspace with sample files
    const workspace = await createE2EWorkspace({
      'README.md': '# Welcome to AI IDE E2E Test\nTesting file reading and tabs.',
      'main.ts': 'console.log("Hello from E2E test");\n',
      'package.json': '{"name": "test-e2e-project"}'
    })

    try {
      // Launch application with pre-loaded workspace
      instance = await launchElectronApp({ workspacePath: workspace.rootPath })
      const { window } = instance

      // Verify workspace pill displays directory name
      const workspaceFolderBasename = path.basename(workspace.rootPath)
      const workspacePillText = window.locator('.workspace-pill-text')
      await expect(workspacePillText).toBeVisible({ timeout: 10000 })
      await expect(workspacePillText).toHaveText(workspaceFolderBasename)

      // Verify file explorer tree shows the files
      const readmeItem = window.locator('.tree-node').filter({ hasText: 'README.md' })
      await expect(readmeItem).toBeVisible({ timeout: 10000 })

      const mainTsItem = window.locator('.tree-node').filter({ hasText: 'main.ts' })
      await expect(mainTsItem).toBeVisible({ timeout: 10000 })

      // Click on README.md to open it in an editor tab
      await readmeItem.click()

      // Verify editor tab appears with README.md
      const editorTab = window.locator('.editor-tab').filter({ hasText: 'README.md' })
      await expect(editorTab).toBeVisible({ timeout: 5000 })
      await expect(editorTab).toHaveClass(/active/)
    } finally {
      await workspace.cleanup()
    }
  })

  test('4. shuts down cleanly and exits without orphan processes', async () => {
    instance = await launchElectronApp()
    const appProcess = instance.app.process()
    expect(appProcess).toBeDefined()
    const pid = appProcess.pid
    expect(typeof pid).toBe('number')

    // Close application
    await instance.cleanup()
    instance = null

    // Give OS a moment to reap process
    await new Promise((r) => setTimeout(r, 300))

    // Verify process is no longer alive
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
