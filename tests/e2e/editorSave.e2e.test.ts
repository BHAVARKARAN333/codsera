/**
 * Editor Save and Dirty Tab Workflow E2E Tests
 *
 * Verifies end-to-end editor workflows:
 * 1. Open source file in Monaco editor.
 * 2. Modify content using editor keyboard interactions.
 * 3. Save via Ctrl+S and verify saved content on disk.
 * 4. Modify content again to enter dirty state.
 * 5. Attempt closing dirty tab to trigger Save / Don't Save / Cancel guard.
 * 6. Cancel close and verify unsaved state is preserved.
 * 7. Close with Don't Save and verify tab closes while disk content remains intact.
 */

import { test, expect } from '@playwright/test'
import fs from 'fs/promises'
import path from 'path'
import { launchElectronApp, createE2EWorkspace, type LaunchedAppInstance } from './helpers/electronHarness'

test.describe('Editor Save and Dirty Tab Workflow E2E Tests', () => {
  let instance: LaunchedAppInstance | null = null
  let workspace: { rootPath: string; cleanup: () => Promise<void> } | null = null

  test.beforeEach(async () => {
    workspace = await createE2EWorkspace({
      'example.ts': 'export const initialCode = 100;\n'
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

  test('handles editor typing, Ctrl+S persistence, dirty indicator, and modal guards', async () => {
    if (!workspace) throw new Error('Workspace is not initialized')

    const filePath = path.join(workspace.rootPath, 'example.ts')

    instance = await launchElectronApp({ workspacePath: workspace.rootPath })
    const { window } = instance

    // 1. Open example.ts from file tree
    const fileNode = window.locator('.tree-node').filter({ hasText: 'example.ts' })
    await expect(fileNode).toBeVisible({ timeout: 10000 })
    await fileNode.click()

    // Verify active editor tab appears
    const editorTab = window.locator('.editor-tab').filter({ hasText: 'example.ts' })
    await expect(editorTab).toBeVisible({ timeout: 10000 })
    await expect(editorTab).toHaveClass(/active/)

    // Wait for Monaco editor surface to mount
    const monacoEditor = window.locator('.monaco-editor')
    await expect(monacoEditor).toBeVisible({ timeout: 10000 })

    // Tab should initially not be dirty
    const dirtyIndicator = editorTab.locator('.tab-dirty-indicator')
    await expect(dirtyIndicator).toBeHidden()

    // 2. Modify editor content by clicking into Monaco and typing
    await monacoEditor.click()
    await window.keyboard.press('End')
    await window.keyboard.type('\nexport const savedFeature = 200;')

    // Verify tab enters dirty state
    await expect(dirtyIndicator).toBeVisible({ timeout: 5000 })

    // 3. Save file using Ctrl+S
    await window.keyboard.press('Control+s')

    // Verify dirty indicator disappears after save
    await expect(dirtyIndicator).toBeHidden({ timeout: 5000 })

    // 4. Verify content is persisted to disk
    const diskContentAfterSave = await fs.readFile(filePath, 'utf-8')
    expect(diskContentAfterSave).toContain('export const savedFeature = 200;')

    // 5. Modify file again to create an unsaved edit
    await monacoEditor.click()
    await window.keyboard.press('End')
    await window.keyboard.type('\n// UNSAVED_DIRTY_CONTENT')

    // Verify dirty state appears again
    await expect(dirtyIndicator).toBeVisible({ timeout: 5000 })

    // 6. Attempt to close the dirty tab
    const closeTabBtn = editorTab.locator('.tab-close-btn')
    await closeTabBtn.click()

    // Verify Dirty Tab confirmation modal appears
    const dirtyModal = window.locator('.explorer-modal[role="dialog"]')
    await expect(dirtyModal).toBeVisible({ timeout: 5000 })
    await expect(dirtyModal.locator('.explorer-modal-header')).toContainText('Unsaved Changes')
    await expect(dirtyModal.locator('.explorer-modal-message')).toContainText('example.ts')

    const modalFooter = dirtyModal.locator('.explorer-modal-footer')
    const cancelBtn = modalFooter.getByRole('button', { name: 'Cancel' })
    const dontSaveBtn = modalFooter.getByRole('button', { name: "Don't Save" })
    const saveBtn = modalFooter.getByRole('button', { name: 'Save', exact: true })

    await expect(cancelBtn).toBeVisible()
    await expect(dontSaveBtn).toBeVisible()
    await expect(saveBtn).toBeVisible()

    // 7. Verify Cancel preserves the tab and unsaved changes
    await cancelBtn.click()
    await expect(dirtyModal).toBeHidden()
    await expect(editorTab).toBeVisible()
    await expect(dirtyIndicator).toBeVisible()

    // 8. Attempt to close again and select Don't Save
    await closeTabBtn.click()
    await expect(dirtyModal).toBeVisible()
    await dontSaveBtn.click()
    await expect(dirtyModal).toBeHidden()

    // Verify tab is now closed
    await expect(editorTab).toBeHidden()

    // 9. Verify disk content still contains the first save but NOT the unsaved edit
    const diskFinalContent = await fs.readFile(filePath, 'utf-8')
    expect(diskFinalContent).toContain('export const savedFeature = 200;')
    expect(diskFinalContent).not.toContain('UNSAVED_DIRTY_CONTENT')
  })
})
