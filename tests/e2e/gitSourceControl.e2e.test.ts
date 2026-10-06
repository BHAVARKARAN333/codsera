/**
 * Git Source Control Workflow E2E Tests
 *
 * Verifies end-to-end Git source control workflows:
 * 1. Initialize isolated test repository with initial commit.
 * 2. Open Source Control and verify 'Working Tree Clean' state.
 * 3. Modify a tracked file and verify it appears in Unstaged Changes.
 * 4. Stage the file through the UI and verify Staged Changes state.
 * 5. Commit using deterministic message via UI.
 * 6. Verify repository returns to clean state and commit appears in git log.
 * 7. Verify non-Git workspace displays clear recoverable non-repo state.
 */

import { test, expect } from '@playwright/test'
import fs from 'fs/promises'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import {
  launchElectronApp,
  createE2EWorkspace,
  createE2EGitWorkspace,
  type LaunchedAppInstance
} from './helpers/electronHarness'

const execFileAsync = promisify(execFile)

test.describe('Git Source Control Workflow E2E Tests', () => {
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

  test('verifies clean state, file modification, staging, committing, and git log history', async () => {
    workspace = await createE2EGitWorkspace({
      'tracked.txt': 'initial content\n'
    })

    instance = await launchElectronApp({ workspacePath: workspace.rootPath })
    const { window } = instance

    // 1. Switch Activity Bar to Source Control
    const sourceControlNavBtn = window.getByRole('button', { name: 'Source Control' })
    await expect(sourceControlNavBtn).toBeVisible({ timeout: 10000 })
    await sourceControlNavBtn.click()

    // 2. Verify initial clean working tree state
    const cleanState = window.locator('[data-testid="clean-state"]')
    await expect(cleanState).toBeVisible({ timeout: 10000 })
    await expect(cleanState).toContainText('Working Tree Clean')

    // 3. Modify tracked file on disk
    const filePath = path.join(workspace.rootPath, 'tracked.txt')
    await fs.writeFile(filePath, 'modified content for e2e test\n', 'utf-8')

    // Trigger refresh in Source Control header
    const refreshBtn = window.locator('button[aria-label="Refresh Git Status"]')
    await expect(refreshBtn).toBeVisible({ timeout: 5000 })
    await refreshBtn.click()

    // 4. Verify modified file appears under CHANGES (unstaged)
    const unstagedSection = window.locator('[data-testid="unstaged-section"]')
    await expect(unstagedSection).toBeVisible({ timeout: 10000 })

    const unstagedFile = window.locator('[data-testid="unstaged-file-tracked.txt"]')
    await expect(unstagedFile).toBeVisible({ timeout: 10000 })

    // 5. Stage file through UI
    const stageBtn = unstagedFile.locator('button.stage')
    await stageBtn.click()

    // Verify file moves to STAGED CHANGES
    const stagedSection = window.locator('[data-testid="staged-section"]')
    await expect(stagedSection).toBeVisible({ timeout: 10000 })

    const stagedFile = window.locator('[data-testid="staged-file-tracked.txt"]')
    await expect(stagedFile).toBeVisible({ timeout: 10000 })

    // 6. Enter commit message and commit through UI
    const commitInput = window.locator('[data-testid="commit-message-input"]')
    await commitInput.fill('feat: e2e test verified commit')

    const commitBtn = window.locator('[data-testid="commit-button"]')
    await expect(commitBtn).toBeEnabled()
    await commitBtn.click()

    // 7. Verify repository transitions back to clean state
    await expect(cleanState).toBeVisible({ timeout: 10000 })

    // 8. Verify git log on disk contains the commit message
    const { stdout: gitLog } = await execFileAsync('git', ['log', '-1', '--pretty=%B'], {
      cwd: workspace.rootPath
    })
    expect(gitLog.trim()).toBe('feat: e2e test verified commit')
  })

  test('displays clear recoverable state for a non-Git workspace', async () => {
    // Plain folder without git
    workspace = await createE2EWorkspace({
      'plain-note.txt': 'no git here\n'
    })

    instance = await launchElectronApp({ workspacePath: workspace.rootPath })
    const { window } = instance

    // Switch Activity Bar to Source Control
    const sourceControlNavBtn = window.getByRole('button', { name: 'Source Control' })
    await sourceControlNavBtn.click()

    // Verify non-repo state message
    const nonRepoState = window.locator('[data-testid="non-repo-state"]')
    await expect(nonRepoState).toBeVisible({ timeout: 10000 })
    await expect(nonRepoState).toContainText('The currently opened workspace is not a Git repository.')
  })

  test('inspects diff, stages and unstages files, and discards uncommitted changes via UI modal', async () => {
    workspace = await createE2EGitWorkspace({
      'versioned.txt': 'original line\n'
    })

    instance = await launchElectronApp({ workspacePath: workspace.rootPath })
    const { window } = instance

    // Switch Activity Bar to Source Control
    const sourceControlNavBtn = window.getByRole('button', { name: 'Source Control' })
    await sourceControlNavBtn.click()

    const cleanState = window.locator('[data-testid="clean-state"]')
    await expect(cleanState).toBeVisible({ timeout: 10000 })

    // 1. Modify file on disk
    const filePath = path.join(workspace.rootPath, 'versioned.txt')
    await fs.writeFile(filePath, 'modified uncommitted line\n', 'utf-8')

    // Refresh status
    const refreshBtn = window.locator('button[aria-label="Refresh Git Status"]')
    await refreshBtn.click()

    const unstagedFile = window.locator('[data-testid="unstaged-file-versioned.txt"]')
    await expect(unstagedFile).toBeVisible({ timeout: 10000 })

    // 2. Open Diff view
    const diffBtn = unstagedFile.locator('button.diff-btn')
    await diffBtn.click()

    const diffTab = window.locator('[data-testid="editor-diff-tab"]')
    await expect(diffTab).toBeVisible({ timeout: 10000 })
    await expect(diffTab).toContainText('versioned.txt')

    // Close diff tab
    const closeDiffBtn = diffTab.locator('.tab-close-btn')
    await closeDiffBtn.click()
    await expect(diffTab).toBeHidden()

    // 3. Stage file
    const stageBtn = unstagedFile.locator('button.stage')
    await stageBtn.click()

    const stagedSection = window.locator('[data-testid="staged-section"]')
    await expect(stagedSection).toBeVisible({ timeout: 10000 })
    const stagedFile = window.locator('[data-testid="staged-file-versioned.txt"]')
    await expect(stagedFile).toBeVisible({ timeout: 10000 })

    // 4. Unstage file
    const unstageBtn = stagedFile.locator('button.unstage')
    await unstageBtn.click()

    // File moves back to unstaged section
    await expect(unstagedFile).toBeVisible({ timeout: 10000 })

    // 5. Discard changes via modal
    const discardBtn = unstagedFile.locator('button.discard')
    await discardBtn.click()

    const discardModal = window.locator('.explorer-modal')
    await expect(discardModal).toBeVisible({ timeout: 5000 })
    await expect(discardModal).toContainText('Are you sure you want to discard changes in')

    // Confirm discard
    const confirmDiscardBtn = discardModal.locator('button.btn-danger')
    await confirmDiscardBtn.click()
    await expect(discardModal).toBeHidden()

    // Repository returns to clean state
    await expect(cleanState).toBeVisible({ timeout: 10000 })

    // 6. Verify file content on disk reverted to original
    const revertedContent = await fs.readFile(filePath, 'utf-8')
    expect(revertedContent.trim()).toBe('original line')
  })
})
