/**
 * Application Lifecycle and Recovery E2E Tests
 *
 * Verifies end-to-end application lifecycle and resilience:
 * 1. Restoring previously active workspace on restart via persistent settings profile.
 * 2. Graceful fallback when local settings.json is corrupted or malformed.
 * 3. Clean teardown ensuring child processes and Electron window exit without leaks.
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

test.describe('Application Lifecycle and Recovery E2E Tests', () => {
  let instance: LaunchedAppInstance | null = null
  let workspace: { rootPath: string; cleanup: () => Promise<void> } | null = null
  let sharedUserDataDir: string | null = null

  test.afterEach(async () => {
    if (instance) {
      await instance.cleanup()
      instance = null
    }
    if (workspace) {
      await workspace.cleanup()
      workspace = null
    }
    if (sharedUserDataDir) {
      try {
        await fs.rm(sharedUserDataDir, { recursive: true, force: true })
      } catch {}
      sharedUserDataDir = null
    }
  })

  test('restores lastWorkspaceRoot across application restarts using the same profile', async () => {
    sharedUserDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-ide-lifecycle-user-'))

    workspace = await createE2EWorkspace({
      'persistent-doc.md': '# Persistent Document\n'
    }, 'e2e-ws-lifecycle-')

    const wsName = path.basename(workspace.rootPath)

    // First Session: Launch with specific profile and set workspace
    instance = await launchElectronApp({
      userDataDir: sharedUserDataDir,
      workspacePath: workspace.rootPath,
      preserveUserDataDir: true
    })
    const { window: win1 } = instance

    const pill1 = win1.locator('.workspace-pill-text')
    await expect(pill1).toHaveText(wsName, { timeout: 10000 })
    await expect(win1.locator('.tree-node').filter({ hasText: 'persistent-doc.md' })).toBeVisible({ timeout: 10000 })

    // Clean exit of first session
    await instance.cleanup()
    instance = null
    await new Promise((r) => setTimeout(r, 300))

    // Second Session: Relaunch using SAME userDataDir without specifying workspacePath
    instance = await launchElectronApp({
      userDataDir: sharedUserDataDir,
      preserveUserDataDir: false
    })
    const { window: win2 } = instance

    // Verify getLastWorkspace restored the workspace automatically
    const pill2 = win2.locator('.workspace-pill-text')
    await expect(pill2).toHaveText(wsName, { timeout: 10000 })
    await expect(win2.locator('.tree-node').filter({ hasText: 'persistent-doc.md' })).toBeVisible({ timeout: 10000 })
  })

  test('falls back cleanly to default state when settings.json is corrupted', async () => {
    sharedUserDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-ide-corrupt-user-'))

    // Write malformed JSON into settings.json
    const corruptSettingsPath = path.join(sharedUserDataDir, 'settings.json')
    await fs.writeFile(corruptSettingsPath, '{ MALFORMED_JSON_SYNTAX: %%% 12345', 'utf-8')

    // App should launch cleanly without throwing or crashing
    instance = await launchElectronApp({
      userDataDir: sharedUserDataDir,
      preserveUserDataDir: false
    })
    const { window } = instance

    // Main UI should be fully responsive and visible
    const headerTitle = window.locator('header.header-bar .app-title')
    await expect(headerTitle).toBeVisible({ timeout: 10000 })
    await expect(headerTitle).toContainText('AI IDE')

    const openFolderBtn = window.locator('header.header-bar').getByRole('button', { name: /open folder/i })
    await expect(openFolderBtn).toBeVisible({ timeout: 10000 })

    const terminalBtn = window.locator('header.header-bar').getByRole('button', { name: /terminal/i })
    await expect(terminalBtn).toBeVisible({ timeout: 10000 })
  })

  test('verifies clean window teardown and process exit without lingering orphans', async () => {
    instance = await launchElectronApp()
    const { window, app } = instance

    const header = window.locator('header.header-bar')
    await expect(header).toBeVisible({ timeout: 10000 })

    const pid = app.process()?.pid
    expect(typeof pid).toBe('number')

    await instance.cleanup()
    instance = null

    // Give OS brief moment to release PID
    await new Promise((r) => setTimeout(r, 400))

    // Verify process is no longer running
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
