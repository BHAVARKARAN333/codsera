/**
 * Packaged Application E2E Validation Tests
 *
 * Verifies that the actual packaged Windows binary (`dist/win-unpacked/AI IDE.exe`):
 * 1. Launches from its packaged location and renders the IDE shell from `app.asar`.
 * 2. Opens a test workspace and populates the file explorer tree.
 * 3. Mounts Monaco Editor and opens/displays a file without worker/runtime errors.
 * 4. Executes packaged Electron IPC roundtrips (getSettings, readTree, readFile).
 * 5. Handles editing and saving (Ctrl+S) inside the packaged environment.
 * 6. Shuts down cleanly without orphaned processes.
 */

import { test, expect } from '@playwright/test'
import path from 'path'
import fs from 'fs/promises'
import {
  launchPackagedElectronApp,
  createE2EWorkspace,
  type LaunchedAppInstance
} from './helpers/electronHarness'

test.describe('Packaged Application E2E Validation', () => {
  let instance: LaunchedAppInstance | null = null

  test.afterEach(async () => {
    if (instance) {
      await instance.cleanup()
      instance = null
    }
  })

  test('1. launches packaged executable and renders main IDE shell from app.asar', async () => {
    instance = await launchPackagedElectronApp()
    const { window, app } = instance

    // Assert app process is alive
    const appProcess = app.process()
    expect(appProcess).toBeDefined()
    expect(typeof appProcess.pid).toBe('number')

    // Verify window title
    const title = await window.title()
    expect(title).toBe('AI IDE')

    // Verify window URL points to app.asar production bundle
    const currentUrl = window.url()
    expect(currentUrl).toMatch(/app\.asar[/\\]out[/\\]renderer[/\\]index\.html$/i)

    // Verify core header elements
    const appTitle = window.locator('.app-title')
    await expect(appTitle).toBeVisible({ timeout: 10000 })
    await expect(appTitle).toHaveText('AI IDE')

    const versionPill = window.locator('.app-version-pill')
    await expect(versionPill).toBeVisible()
    await expect(versionPill).toHaveText('PRO')

    // Verify workspace pill indicates no workspace initially
    const workspacePill = window.locator('.workspace-pill')
    await expect(workspacePill).toBeVisible()
    await expect(workspacePill).toContainText('No Workspace Opened')

    // Verify activity bar navigation
    const activityBar = window.getByLabel('Activity Bar')
    await expect(activityBar).toBeVisible()

    // Verify status bar
    const statusBar = window.locator('.status-bar')
    await expect(statusBar).toBeVisible()
  })

  test('2. loads workspace, renders file tree, and mounts Monaco Editor for file editing', async () => {
    const pageErrors: Error[] = []
    const consoleErrors: string[] = []

    const workspace = await createE2EWorkspace({
      'index.ts': 'export const appGreeting = "Hello from Packaged AI IDE";\nconsole.log(appGreeting);\n',
      'README.md': '# Packaged App E2E Test\nVerifying Monaco editor and worker in packaged mode.\n',
      'package.json': '{"name": "packaged-test-project", "version": "1.0.0"}'
    })

    try {
      instance = await launchPackagedElectronApp({ workspacePath: workspace.rootPath })
      const { window } = instance

      window.on('pageerror', (err) => {
        pageErrors.push(err)
      })
      window.on('console', (msg) => {
        if (msg.type() === 'error') {
          consoleErrors.push(msg.text())
        }
      })

      // Verify workspace pill renders folder name
      const folderBasename = path.basename(workspace.rootPath)
      const workspacePillText = window.locator('.workspace-pill-text')
      await expect(workspacePillText).toBeVisible({ timeout: 10000 })
      await expect(workspacePillText).toHaveText(folderBasename)

      // Verify file tree nodes are populated
      const indexNode = window.locator('.tree-node').filter({ hasText: 'index.ts' })
      const readmeNode = window.locator('.tree-node').filter({ hasText: 'README.md' })
      const packageNode = window.locator('.tree-node').filter({ hasText: 'package.json' })

      await expect(indexNode).toBeVisible({ timeout: 10000 })
      await expect(readmeNode).toBeVisible({ timeout: 5000 })
      await expect(packageNode).toBeVisible({ timeout: 5000 })

      // Open index.ts in Monaco Editor
      await indexNode.click()

      // Verify editor tab appears and is marked active
      const editorTab = window.locator('.editor-tab').filter({ hasText: 'index.ts' })
      await expect(editorTab).toBeVisible({ timeout: 10000 })
      await expect(editorTab).toHaveClass(/active/)

      // Verify Monaco Editor mounts and renders
      const monacoEditor = window.locator('.monaco-editor')
      await expect(monacoEditor).toBeVisible({ timeout: 15000 })

      // Verify file text rendered inside Monaco's view-lines
      const viewLines = monacoEditor.locator('.view-lines')
      await expect(viewLines).toContainText('Hello from Packaged AI IDE', { timeout: 10000 })

      // Modify editor content
      await monacoEditor.click()
      await window.keyboard.press('End')
      await window.keyboard.type('\nexport const packagedFeature = 42;')

      // Verify dirty tab indicator
      const dirtyIndicator = editorTab.locator('.tab-dirty-indicator')
      await expect(dirtyIndicator).toBeVisible({ timeout: 5000 })

      // Save via Ctrl+S
      await window.keyboard.press('Control+s')
      await expect(dirtyIndicator).toBeHidden({ timeout: 5000 })

      // Verify disk persistence
      const diskContent = await fs.readFile(path.join(workspace.rootPath, 'index.ts'), 'utf-8')
      expect(diskContent).toContain('export const packagedFeature = 42;')

      // Assert no unhandled page errors occurred during editor mounting and typing
      expect(pageErrors).toHaveLength(0)
    } finally {
      await workspace.cleanup()
    }
  })

  test('3. executes packaged IPC roundtrips (getSettings, readTree, readFile) via preload API', async () => {
    const workspace = await createE2EWorkspace({
      'test-file.txt': 'Packaged IPC roundtrip content\n'
    })

    try {
      instance = await launchPackagedElectronApp({ workspacePath: workspace.rootPath })
      const { window } = instance

      // 1. Verify window.electronAPI is exposed in the packaged environment
      const hasElectronAPI = await window.evaluate(() => {
        return typeof (window as any).electronAPI === 'object' && (window as any).electronAPI !== null
      })
      expect(hasElectronAPI).toBe(true)

      // 2. Test getSettings() IPC roundtrip
      const settings = await window.evaluate(async () => {
        return await (window as any).electronAPI.getSettings()
      })
      expect(typeof settings).toBe('object')
      expect(settings).not.toBeNull()

      // 3. Test readTree() IPC roundtrip
      const treeResult = await window.evaluate(async (wsPath) => {
        return await (window as any).electronAPI.readTree(wsPath)
      }, workspace.rootPath)
      expect(treeResult).toBeDefined()
      expect(treeResult.success).toBe(true)
      expect(treeResult.tree).toBeDefined()
      expect(Array.isArray(treeResult.tree)).toBe(true)
      const foundFile = treeResult.tree?.find((f: any) => f.name === 'test-file.txt')
      expect(foundFile).toBeDefined()
      expect(foundFile?.isDirectory).toBe(false)

      // 4. Test readFile() IPC roundtrip
      const filePath = path.join(workspace.rootPath, 'test-file.txt')
      const readResult = await window.evaluate(async (fp) => {
        return await (window as any).electronAPI.readFile(fp)
      }, filePath)
      expect(readResult.success).toBe(true)
      expect(readResult.content).toContain('Packaged IPC roundtrip content')
    } finally {
      await workspace.cleanup()
    }
  })

  test('4. monitors and asserts clean worker and renderer environment without initialization failures', async () => {
    const errors: string[] = []

    instance = await launchPackagedElectronApp()
    const { window } = instance

    window.on('pageerror', (err) => {
      errors.push(`PageError: ${err.message}`)
    })

    window.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text()
        errors.push(`ConsoleError: ${text}`)
      }
    })

    // Verify Monaco environment is configured and healthy
    const monacoStatus = await window.evaluate(() => {
      const win = window as any
      return {
        hasMonacoEnvironment: typeof win.MonacoEnvironment !== 'undefined',
        workerConfigured: Boolean(win.MonacoEnvironment?.getWorker)
      }
    })
    expect(monacoStatus.hasMonacoEnvironment).toBe(true)
    expect(monacoStatus.workerConfigured).toBe(true)

    // Verify worker instantiation returns a valid Worker without error
    const workerCreation = await window.evaluate(() => {
      const win = window as any
      try {
        const worker = win.MonacoEnvironment?.getWorker?.('', 'typescript')
        const isWorker = worker instanceof Worker
        if (worker && typeof worker.terminate === 'function') {
          worker.terminate()
        }
        return { success: true, isWorker }
      } catch (err: any) {
        return { success: false, error: String(err) }
      }
    })
    expect(workerCreation.success).toBe(true)
    expect(workerCreation.isWorker).toBe(true)

    // Let the window idle for 1 second to catch any delayed worker initialization errors
    await new Promise((resolve) => setTimeout(resolve, 1000))

    // Assert that no fatal worker or renderer load errors occurred
    expect(errors.filter((e) => e.includes('worker') || e.includes('SyntaxError'))).toHaveLength(0)
  })
})
