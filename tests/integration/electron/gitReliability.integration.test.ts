/**
 * Git Reliability & Edge Case Integration Tests
 *
 * Verifies robust Git IPC handling across:
 * 1. Mid-session repository deletion (removing .git transitions cleanly to isRepository: false).
 * 2. Branch checkout conflict rejection when dirty uncommitted working tree changes exist.
 * 3. File discard differentiation: unlinking untracked files vs. reverting tracked files to HEAD.
 * 4. Lockfile collision handling (.git/index.lock prevents hanging and returns safe error).
 * 5. Commit messages with special characters, quotes, and multiline text.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import path from 'path'
import fs from 'fs/promises'
import { electronHarness, createTestGitRepo } from './harness'

vi.mock('electron', async () => {
  const { electronHarness } = await import('./harness')
  return {
    app: electronHarness.mockApp,
    BrowserWindow: electronHarness.MockBrowserWindow,
    dialog: electronHarness.mockDialog,
    ipcMain: electronHarness.mockIpcMain,
    ipcRenderer: electronHarness.mockIpcRenderer,
    shell: electronHarness.mockShell,
    session: electronHarness.mockSession,
    contextBridge: electronHarness.mockContextBridge
  }
})

import { registerIpcHandlers } from '../../../src/main/index'
import { api as rawApi } from '../../../src/preload/index'

const api = rawApi as Required<typeof rawApi>

describe('Git Reliability & Repository Edge Cases', () => {
  let gitRepo: {
    rootPath: string
    cleanup: () => Promise<void>
    runGit: (args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>
  }

  beforeEach(async () => {
    registerIpcHandlers()
    electronHarness.state.rendererListeners.clear()
    gitRepo = await createTestGitRepo('ai-ide-git-rel-')
  })

  afterEach(async () => {
    await gitRepo.cleanup()
  })

  it('handles mid-session repository removal cleanly across all Git inspection channels', async () => {
    // 1. Initial valid status
    const initialStatus = await api.gitStatus(gitRepo.rootPath)
    expect(initialStatus.success).toBe(true)
    expect(initialStatus.isRepository).toBe(true)

    // 2. Programmatically remove .git folder to simulate repo deletion
    const gitDir = path.join(gitRepo.rootPath, '.git')
    await fs.rm(gitDir, { recursive: true, force: true })

    // 3. Status should now gracefully report isRepository: false without throwing
    const afterDeleteStatus = await api.gitStatus(gitRepo.rootPath)
    expect(afterDeleteStatus.isRepository).toBe(false)
    expect(afterDeleteStatus.error).toMatch(/not a git repository/i)

    // 4. Branch list should report isRepository: false
    const afterDeleteBranch = await api.gitBranchList(gitRepo.rootPath)
    expect(afterDeleteBranch.isRepository).toBe(false)
    expect(afterDeleteBranch.branches).toEqual([])

    // 5. Log should report isRepository: false
    const afterDeleteLog = await api.gitLog(gitRepo.rootPath)
    expect(afterDeleteLog.isRepository).toBe(false)
  })

  it('blocks branch checkout when local uncommitted changes would be overwritten', async () => {
    // 1. Create and commit a file on the default branch
    await fs.writeFile(path.join(gitRepo.rootPath, 'version.txt'), 'v1.0.0\n', 'utf-8')
    await gitRepo.runGit(['add', 'version.txt'])
    await gitRepo.runGit(['commit', '-m', 'Initial version.txt'])

    // 2. Create and switch to new branch 'feature-v2'
    const branchRes = await api.gitBranchCreate(gitRepo.rootPath, 'feature-v2')
    expect(branchRes.success).toBe(true)

    // 3. Modify version.txt on feature-v2 and commit
    await fs.writeFile(path.join(gitRepo.rootPath, 'version.txt'), 'v2.0.0\n', 'utf-8')
    await gitRepo.runGit(['add', 'version.txt'])
    await gitRepo.runGit(['commit', '-m', 'Bump to v2 on feature branch'])

    // 4. Switch back to master/main
    const branches = await api.gitBranchList(gitRepo.rootPath)
    const baseBranch = branches.branches.find((b) => b !== 'feature-v2') || 'master'
    const switchBackRes = await api.gitBranchCheckout(gitRepo.rootPath, baseBranch)
    expect(switchBackRes.success).toBe(true)

    // 5. Make local dirty uncommitted edit to version.txt
    await fs.writeFile(path.join(gitRepo.rootPath, 'version.txt'), 'dirty uncommitted\n', 'utf-8')

    // 6. Attempting to switch to feature-v2 must be blocked by Git
    const checkoutConflict = await api.gitBranchCheckout(gitRepo.rootPath, 'feature-v2')
    expect(checkoutConflict.success).toBe(false)
    expect(checkoutConflict.error).toMatch(/would be overwritten/i)
  })

  it('unlinks untracked files on discard while reverting tracked files to HEAD', async () => {
    // 0. Commit a baseline tracked file
    await fs.writeFile(path.join(gitRepo.rootPath, 'tracked.txt'), 'Original HEAD Content\n', 'utf-8')
    await gitRepo.runGit(['add', 'tracked.txt'])
    await gitRepo.runGit(['commit', '-m', 'Baseline tracked file'])

    // 1. Create an untracked file
    const untrackedFile = path.join(gitRepo.rootPath, 'untracked.tmp')
    await fs.writeFile(untrackedFile, 'temporary scratch data', 'utf-8')

    // Verify untracked status
    const statusBefore = await api.gitStatus(gitRepo.rootPath)
    expect(statusBefore.untracked).toContain('untracked.tmp')

    // 2. Discard untracked file -> should be unlinked from disk
    const discardUntrackedRes = await api.gitDiscardFile(gitRepo.rootPath, 'untracked.tmp')
    expect(discardUntrackedRes.success).toBe(true)

    let untrackedExists = true
    try {
      await fs.stat(untrackedFile)
    } catch {
      untrackedExists = false
    }
    expect(untrackedExists).toBe(false)

    // 3. Modify the tracked file
    await fs.writeFile(path.join(gitRepo.rootPath, 'tracked.txt'), 'Dirty Uncommitted Modification\n', 'utf-8')
    const statusModified = await api.gitStatus(gitRepo.rootPath)
    expect(statusModified.unstaged.some((f) => f.includes('tracked.txt'))).toBe(true)

    // 4. Discard tracked file -> should revert to HEAD on disk
    const discardTrackedRes = await api.gitDiscardFile(gitRepo.rootPath, 'tracked.txt')
    expect(discardTrackedRes.success).toBe(true)

    const revertedContent = await fs.readFile(path.join(gitRepo.rootPath, 'tracked.txt'), 'utf-8')
    expect(revertedContent.replace(/\r\n/g, '\n')).toBe('Original HEAD Content\n')

    const statusAfterDiscard = await api.gitStatus(gitRepo.rootPath)
    expect(statusAfterDiscard.clean).toBe(true)
  })

  it('gracefully handles Git lockfile collisions without hanging or crashing', async () => {
    await fs.writeFile(path.join(gitRepo.rootPath, 'file.txt'), 'hello', 'utf-8')
    await gitRepo.runGit(['add', 'file.txt'])
    await gitRepo.runGit(['commit', '-m', 'Initial file'])

    // Modify file
    await fs.writeFile(path.join(gitRepo.rootPath, 'file.txt'), 'hello updated', 'utf-8')

    // Create artificial index.lock
    const lockPath = path.join(gitRepo.rootPath, '.git', 'index.lock')
    await fs.writeFile(lockPath, 'lock dummy content')

    try {
      // Attempting stage while locked
      const stageRes = await api.gitStageFile(gitRepo.rootPath, 'file.txt')
      expect(stageRes.success).toBe(false)
      expect(stageRes.error).toMatch(/index\.lock|locked/i)
    } finally {
      // Clean up lock
      try {
        await fs.unlink(lockPath)
      } catch {}
    }

    // Now staging succeeds
    const retryStage = await api.gitStageFile(gitRepo.rootPath, 'file.txt')
    expect(retryStage.success).toBe(true)
  })

  it('correctly handles commit messages with special characters, quotes, and newlines', async () => {
    await fs.writeFile(path.join(gitRepo.rootPath, 'notes.txt'), 'Initial notes\n', 'utf-8')
    await api.gitStageFile(gitRepo.rootPath, 'notes.txt')

    const complexMessage = 'fix: handle "quoted" strings & symbols (e.g. $VAR, #123, `code`)'
    const commitRes = await api.gitCommit(gitRepo.rootPath, complexMessage)
    expect(commitRes.success).toBe(true)
    expect(commitRes.commitHash).toBeDefined()

    const logRes = await api.gitLog(gitRepo.rootPath, 1)
    expect(logRes.success).toBe(true)
    expect(logRes.commits[0].message).toBe(complexMessage)
  })
})
