/**
 * File Explorer Workflow E2E Tests
 *
 * Verifies end-to-end file management operations:
 * 1. Create a new file through File Explorer UI.
 * 2. Verify file appears in tree and opens in editor.
 * 3. Create a new folder and verify it appears.
 * 4. Rename a file and verify updated name in tree and editor tabs.
 * 5. Delete a file using the UI confirmation flow.
 * 6. Verify filesystem changes inside the temporary workspace on disk.
 */

import { test, expect } from '@playwright/test'
import fs from 'fs/promises'
import path from 'path'
import { launchElectronApp, createE2EWorkspace, type LaunchedAppInstance } from './helpers/electronHarness'

test.describe('File Explorer Workflow E2E Tests', () => {
  let instance: LaunchedAppInstance | null = null
  let workspace: { rootPath: string; cleanup: () => Promise<void> } | null = null

  test.beforeEach(async () => {
    workspace = await createE2EWorkspace({
      'initial.ts': 'console.log("initial file");\n'
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

  test('executes complete file and folder CRUD workflow with tree and tab synchronization', async () => {
    if (!workspace) throw new Error('Workspace is not initialized')

    instance = await launchElectronApp({ workspacePath: workspace.rootPath })
    const { window } = instance

    // 1. Verify workspace is loaded and initial.ts is in tree
    const initialNode = window.locator('.tree-node').filter({ hasText: 'initial.ts' })
    await expect(initialNode).toBeVisible({ timeout: 10000 })

    const sidebar = window.locator('.sidebar')
    const modal = window.locator('.explorer-modal')
    const modalInput = modal.locator('.explorer-modal-input')
    const submitBtn = modal.locator('button[type="submit"]')

    // 2. Create new file through UI
    const newFileBtn = sidebar.locator('button[aria-label="New File"]')
    await newFileBtn.click()
    await expect(modal).toBeVisible()
    await expect(modal.locator('.explorer-modal-header')).toContainText('New File')

    await modalInput.fill('created-by-e2e.txt')
    await submitBtn.click()
    await expect(modal).toBeHidden()

    // 3. Verify the file appears in the tree
    const createdNode = window.locator('.tree-node').filter({ hasText: 'created-by-e2e.txt' })
    await expect(createdNode).toBeVisible({ timeout: 10000 })

    // 4. Verify file is automatically opened in an active editor tab
    const createdTab = window.locator('.editor-tab').filter({ hasText: 'created-by-e2e.txt' })
    await expect(createdTab).toBeVisible({ timeout: 10000 })
    await expect(createdTab).toHaveClass(/active/)

    // 5. Create new folder through UI
    const newFolderBtn = sidebar.locator('button[aria-label="New Folder"]')
    await newFolderBtn.click()
    await expect(modal).toBeVisible()
    await expect(modal.locator('.explorer-modal-header')).toContainText('New Folder')

    await modalInput.fill('e2e-subfolder')
    await submitBtn.click()
    await expect(modal).toBeHidden()

    // Verify folder appears in tree
    const folderNode = window.locator('.tree-node').filter({ hasText: 'e2e-subfolder' })
    await expect(folderNode).toBeVisible({ timeout: 10000 })

    // 6. Rename the created file via context menu
    await createdNode.click({ button: 'right' })
    const contextMenu = window.locator('.explorer-context-menu')
    await expect(contextMenu).toBeVisible()

    await contextMenu.getByRole('button', { name: 'Rename...' }).click()
    await expect(modal).toBeVisible()
    await expect(modal.locator('.explorer-modal-header')).toContainText('Rename')

    await modalInput.fill('renamed-by-e2e.txt')
    await submitBtn.click()
    await expect(modal).toBeHidden()

    // Verify updated name in tree and disappearance of old name
    const renamedNode = window.locator('.tree-node').filter({ hasText: 'renamed-by-e2e.txt' })
    await expect(renamedNode).toBeVisible({ timeout: 10000 })
    await expect(createdNode).toBeHidden()

    // Verify editor tab synchronized to renamed filename
    const renamedTab = window.locator('.editor-tab').filter({ hasText: 'renamed-by-e2e.txt' })
    await expect(renamedTab).toBeVisible({ timeout: 10000 })

    // 7. Delete the renamed file using UI confirmation flow
    await renamedNode.click({ button: 'right' })
    await expect(contextMenu).toBeVisible()

    await contextMenu.getByRole('button', { name: 'Delete...' }).click()
    await expect(modal).toBeVisible()
    await expect(modal.locator('.explorer-modal-header')).toContainText('Delete')
    await expect(modal.locator('.explorer-modal-message')).toContainText('renamed-by-e2e.txt')

    await submitBtn.click()
    await expect(modal).toBeHidden()

    // Verify file disappears from tree
    await expect(renamedNode).toBeHidden()

    // 8. Verify actual filesystem changes on disk
    const diskEntries = await fs.readdir(workspace.rootPath)
    expect(diskEntries).toContain('e2e-subfolder')
    expect(diskEntries).not.toContain('created-by-e2e.txt')
    expect(diskEntries).not.toContain('renamed-by-e2e.txt')

    // Confirm e2e-subfolder is a directory on disk
    const stat = await fs.stat(path.join(workspace.rootPath, 'e2e-subfolder'))
    expect(stat.isDirectory()).toBe(true)
  })
})
