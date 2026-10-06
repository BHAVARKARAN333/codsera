/**
 * Editor and File Watcher Reliability E2E Tests
 *
 * Verifies end-to-end watcher synchronization and editor resilience:
 * 1. Clean tab auto-sync when modified externally on disk.
 * 2. Dirty tab protection: external changes trigger warning banner and tab indicator;
 *    supports both 'Keep Local Edits' and 'Reload From Disk'.
 * 3. Debounced burst updates coalescing rapid external disk writes.
 * 4. External file deletion safety: dirty tabs preserve unsaved buffers with '[deleted]' tag.
 */

import { test, expect } from '@playwright/test'
import fs from 'fs/promises'
import path from 'path'
import {
  launchElectronApp,
  createE2EWorkspace,
  type LaunchedAppInstance
} from './helpers/electronHarness'

test.describe('Editor and File Watcher Reliability E2E Tests', () => {
  let instance: LaunchedAppInstance | null = null
  let workspace: { rootPath: string; cleanup: () => Promise<void> } | null = null

  test.beforeEach(async () => {
    workspace = await createE2EWorkspace({
      'sync.txt': 'initial clean content\n',
      'dirty.txt': 'original disk content\n',
      'burst.txt': 'burst base\n',
      'deleteme.txt': 'to be deleted\n'
    }, 'e2e-watcher-')
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

  test('auto-reloads clean editor tab when modified externally on disk', async () => {
    if (!workspace) throw new Error('Workspace not initialized')

    instance = await launchElectronApp({ workspacePath: workspace.rootPath })
    const { window } = instance

    // Open sync.txt
    const fileNode = window.locator('.tree-node').filter({ hasText: 'sync.txt' })
    await expect(fileNode).toBeVisible({ timeout: 10000 })
    await fileNode.click()

    const editorTab = window.locator('.editor-tab').filter({ hasText: 'sync.txt' })
    await expect(editorTab).toBeVisible({ timeout: 10000 })

    const viewLines = window.locator('.view-lines')
    await expect(viewLines).toContainText('initial clean content', { timeout: 10000 })

    // Modify file externally on disk
    const targetPath = path.join(workspace.rootPath, 'sync.txt')
    await fs.writeFile(targetPath, 'EXTERNALLY_UPDATED_SYNC_CONTENT\n', 'utf-8')

    // Clean tab should automatically sync to the new disk content
    await expect(viewLines).toContainText('EXTERNALLY_UPDATED_SYNC_CONTENT', { timeout: 10000 })

    // Tab should remain clean (not dirty)
    await expect(editorTab.locator('.tab-dirty-indicator')).toBeHidden()
  })

  test('protects dirty tab from external overwrite and provides Keep vs Reload actions', async () => {
    if (!workspace) throw new Error('Workspace not initialized')

    instance = await launchElectronApp({ workspacePath: workspace.rootPath })
    const { window } = instance

    // Open dirty.txt
    const fileNode = window.locator('.tree-node').filter({ hasText: 'dirty.txt' })
    await expect(fileNode).toBeVisible({ timeout: 10000 })
    await fileNode.click()

    const editorTab = window.locator('.editor-tab').filter({ hasText: 'dirty.txt' })
    await expect(editorTab).toBeVisible({ timeout: 10000 })

    const monaco = window.locator('.monaco-editor')
    await expect(monaco).toBeVisible({ timeout: 10000 })

    // Make local unsaved edits
    await monaco.click()
    await window.keyboard.press('End')
    await window.keyboard.type('\nLOCAL_UNSAVED_BUFFER')

    const dirtyIndicator = editorTab.locator('.tab-dirty-indicator')
    await expect(dirtyIndicator).toBeVisible({ timeout: 5000 })

    // Modify file externally on disk
    const targetPath = path.join(workspace.rootPath, 'dirty.txt')
    await fs.writeFile(targetPath, 'EXTERNAL_DISK_MODIFICATION_1\n', 'utf-8')

    // External change warning banner and indicator must appear
    const banner = window.locator('.external-change-banner')
    await expect(banner).toBeVisible({ timeout: 10000 })
    await expect(banner).toContainText('External changes detected')

    const extIndicator = editorTab.locator('.tab-external-indicator')
    await expect(extIndicator).toBeVisible({ timeout: 5000 })

    // 1. Action: Keep Local Edits
    const keepBtn = banner.locator('button').filter({ hasText: 'Keep Local Edits' })
    await keepBtn.click()

    await expect(banner).toBeHidden({ timeout: 5000 })
    await expect(extIndicator).toBeHidden()

    // Local buffer should be intact
    const viewLines = window.locator('.view-lines')
    await expect(viewLines).toContainText('LOCAL_UNSAVED_BUFFER')

    // 2. Modify disk again and test Reload From Disk
    await fs.writeFile(targetPath, 'EXTERNAL_DISK_MODIFICATION_2\n', 'utf-8')

    await expect(banner).toBeVisible({ timeout: 10000 })
    const reloadBtn = banner.locator('button').filter({ hasText: 'Reload From Disk' })
    await reloadBtn.click()

    await expect(banner).toBeHidden({ timeout: 5000 })
    await expect(dirtyIndicator).toBeHidden()
    await expect(viewLines).toContainText('EXTERNAL_DISK_MODIFICATION_2')
    await expect(viewLines).not.toContainText('LOCAL_UNSAVED_BUFFER')
  })

  test('coalesces rapid burst writes without crashing or infinite reloads', async () => {
    if (!workspace) throw new Error('Workspace not initialized')

    instance = await launchElectronApp({ workspacePath: workspace.rootPath })
    const { window } = instance

    // Open burst.txt
    const fileNode = window.locator('.tree-node').filter({ hasText: 'burst.txt' })
    await expect(fileNode).toBeVisible({ timeout: 10000 })
    await fileNode.click()

    const viewLines = window.locator('.view-lines')
    await expect(viewLines).toContainText('burst base', { timeout: 10000 })

    const targetPath = path.join(workspace.rootPath, 'burst.txt')

    // Perform rapid sequence of external writes
    for (let i = 1; i <= 5; i++) {
      await fs.writeFile(targetPath, `BURST_WRITE_STEP_${i}\n`, 'utf-8')
      await new Promise((r) => setTimeout(r, 30))
    }

    // Debounced watcher should settle on final state smoothly
    await expect(viewLines).toContainText('BURST_WRITE_STEP_5', { timeout: 10000 })
  })

  test('preserves unsaved buffer when file is deleted externally on disk', async () => {
    if (!workspace) throw new Error('Workspace not initialized')

    instance = await launchElectronApp({ workspacePath: workspace.rootPath })
    const { window } = instance

    // Open deleteme.txt
    const fileNode = window.locator('.tree-node').filter({ hasText: 'deleteme.txt' })
    await expect(fileNode).toBeVisible({ timeout: 10000 })
    await fileNode.click()

    const editorTab = window.locator('.editor-tab').filter({ hasText: 'deleteme.txt' })
    await expect(editorTab).toBeVisible({ timeout: 10000 })

    const monaco = window.locator('.monaco-editor')
    await monaco.click()
    await window.keyboard.press('End')
    await window.keyboard.type('\nCRITICAL_UNSAVED_DATA')

    const dirtyIndicator = editorTab.locator('.tab-dirty-indicator')
    await expect(dirtyIndicator).toBeVisible({ timeout: 5000 })

    // Delete the file on disk externally
    const targetPath = path.join(workspace.rootPath, 'deleteme.txt')
    await fs.unlink(targetPath)

    // Verify missing indicator or banner appears
    const missingTag = editorTab.locator('.tab-missing-tag')
    await expect(missingTag).toBeVisible({ timeout: 10000 })

    const missingBanner = window.locator('.external-change-banner.missing')
    await expect(missingBanner).toBeVisible({ timeout: 10000 })
    await expect(missingBanner).toContainText('File missing on disk')

    // Critical unsaved buffer is preserved
    const viewLines = window.locator('.view-lines')
    await expect(viewLines).toContainText('CRITICAL_UNSAVED_DATA')
  })
})
