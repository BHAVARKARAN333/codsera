/**
 * Git Conflict and Recovery E2E Tests
 *
 * Verifies end-to-end Git edge cases and error recovery:
 * 1. Rapid refresh triggers without UI deadlocks or corrupted state.
 * 2. Checkout conflict detection when local modifications collide with target branch,
 *    verifying that the error banner appears and local edits are preserved without data loss.
 * 3. Graceful handling and UI recovery when a repository is deleted or invalidated externally.
 */

import { test, expect } from '@playwright/test'
import fs from 'fs/promises'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import {
  launchElectronApp,
  createE2EGitWorkspace,
  type LaunchedAppInstance
} from './helpers/electronHarness'

const execFileAsync = promisify(execFile)

test.describe('Git Conflict and Recovery E2E Tests', () => {
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

  test('handles rapid status refresh clicks without UI deadlock or glitching', async () => {
    workspace = await createE2EGitWorkspace({
      'file1.txt': 'initial line\n'
    }, true, 'e2e-git-rapid-')

    instance = await launchElectronApp({ workspacePath: workspace.rootPath })
    const { window } = instance

    // Navigate to Source Control
    const scNavBtn = window.getByRole('button', { name: 'Source Control' })
    await scNavBtn.click()

    const cleanState = window.locator('[data-testid="clean-state"]')
    await expect(cleanState).toBeVisible({ timeout: 10000 })

    // Locate refresh button
    const refreshBtn = window.locator('button[aria-label="Refresh Git Status"]')
    await expect(refreshBtn).toBeVisible({ timeout: 5000 })

    // Rapid consecutive clicks
    for (let i = 0; i < 5; i++) {
      await refreshBtn.click({ force: true }).catch(() => {})
      await new Promise((r) => setTimeout(r, 40))
    }

    // Must settle smoothly on clean working tree state
    await expect(cleanState).toBeVisible({ timeout: 10000 })
    await expect(cleanState).toContainText('Working Tree Clean')
  })

  test('displays action error banner on branch checkout conflict and preserves local changes', async () => {
    // 1. Create a git repo with a commit on default branch (main/master)
    workspace = await createE2EGitWorkspace({
      'shared.txt': 'content on base branch\n'
    }, true, 'e2e-git-conflict-')

    // 2. Create feature branch and commit different content to shared.txt
    await execFileAsync('git', ['checkout', '-b', 'feature-branch'], { cwd: workspace.rootPath })
    await fs.writeFile(path.join(workspace.rootPath, 'shared.txt'), 'conflicting content on feature branch\n', 'utf-8')
    await execFileAsync('git', ['add', '.'], { cwd: workspace.rootPath })
    await execFileAsync('git', ['commit', '-m', 'Feature commit'], { cwd: workspace.rootPath })

    // 3. Switch back to base branch and make conflicting uncommitted edits
    await execFileAsync('git', ['checkout', '-'], { cwd: workspace.rootPath })
    const localEdits = 'uncommitted local edits that will conflict\n'
    await fs.writeFile(path.join(workspace.rootPath, 'shared.txt'), localEdits, 'utf-8')

    // 4. Launch app and open Source Control
    instance = await launchElectronApp({ workspacePath: workspace.rootPath })
    const { window } = instance

    const scNavBtn = window.getByRole('button', { name: 'Source Control' })
    await scNavBtn.click()

    // Refresh status to see unstaged changes
    const refreshBtn = window.locator('button[aria-label="Refresh Git Status"]')
    await refreshBtn.click()

    const unstagedFile = window.locator('[data-testid="unstaged-file-shared.txt"]')
    await expect(unstagedFile).toBeVisible({ timeout: 10000 })

    // 5. Open Branch selector dropdown
    const branchSelectorBtn = window.locator('.source-control-branch-selector-btn')
    await expect(branchSelectorBtn).toBeVisible({ timeout: 10000 })
    await branchSelectorBtn.click()

    const branchDropdown = window.locator('.source-control-branch-dropdown')
    await expect(branchDropdown).toBeVisible({ timeout: 5000 })

    // 6. Attempt checkout of feature-branch
    const featureItem = window.getByRole('menuitem', { name: 'feature-branch' })
    await expect(featureItem).toBeVisible({ timeout: 5000 })
    await featureItem.click()

    // 7. Verify action error banner appears with Git checkout error
    const actionErrorBanner = window.locator('.source-control-action-error')
    await expect(actionErrorBanner).toBeVisible({ timeout: 10000 })
    await expect(actionErrorBanner).toContainText(/overwritten/i)

    // 8. Verify local changes were NOT lost or wiped out
    const fileContentOnDisk = await fs.readFile(path.join(workspace.rootPath, 'shared.txt'), 'utf-8')
    expect(fileContentOnDisk).toBe(localEdits)

    // Unstaged file should still be listed in UI
    await expect(unstagedFile).toBeVisible()
  })

  test('gracefully transitions to non-repo state when .git is deleted externally', async () => {
    workspace = await createE2EGitWorkspace({
      'readme.md': '# Repo Title\n'
    }, true, 'e2e-git-inval-')

    instance = await launchElectronApp({ workspacePath: workspace.rootPath })
    const { window } = instance

    // Navigate to Source Control
    const scNavBtn = window.getByRole('button', { name: 'Source Control' })
    await scNavBtn.click()

    const cleanState = window.locator('[data-testid="clean-state"]')
    await expect(cleanState).toBeVisible({ timeout: 10000 })

    // Invalidate git repository by removing .git folder
    const gitDir = path.join(workspace.rootPath, '.git')
    await fs.rm(gitDir, { recursive: true, force: true })

    // Trigger refresh in UI
    const refreshBtn = window.locator('button[aria-label="Refresh Git Status"]')
    await refreshBtn.click()

    // UI should safely display non-repo state without crash
    const nonRepoState = window.locator('[data-testid="non-repo-state"]')
    await expect(nonRepoState).toBeVisible({ timeout: 10000 })
    await expect(nonRepoState).toContainText('not a Git repository')
  })
})
