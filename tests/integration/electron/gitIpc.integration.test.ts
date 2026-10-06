/**
 * Git IPC Integration Tests
 *
 * Verifies real production Git IPC handlers and Preload API interactions:
 * 1. Git repository status, diff, and commit log querying.
 * 2. Staging and unstaging single files and all files.
 * 3. Commit creation with message validation and empty-stage guards.
 * 4. Branch listing, branch creation with injection prevention, and branch checkout.
 * 5. Per-file staged and unstaged diff generation and single-file discard operations.
 * 6. Non-repository workspace handling and sanitized error reporting.
 *
 * All operations execute within isolated temporary Git repositories cleaned up after tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import { createTestGitRepo, createTestWorkspace } from './harness'

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
import { api } from '../../../src/preload/index'

describe('4. Git IPC Integration', () => {
  let gitRepo: {
    rootPath: string
    cleanup: () => Promise<void>
    runGit: (args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>
  }

  beforeEach(async () => {
    registerIpcHandlers()
    gitRepo = await createTestGitRepo('ai-ide-git-test-')
  })

  afterEach(async () => {
    await gitRepo.cleanup()
  })

  it('queries Git status, diff, and log for an initialized repository', async () => {
    // Initial status for clean empty repo
    const initialStatus = await api.gitStatus(gitRepo.rootPath)
    expect(initialStatus.success).toBe(true)
    expect(initialStatus.isRepository).toBe(true)
    expect(initialStatus.clean).toBe(true)
    expect(initialStatus.files).toEqual([])

    // Create a new untracked file
    await fs.writeFile(path.join(gitRepo.rootPath, 'README.md'), '# Integration Repo\n')

    const untrackedStatus = await api.gitStatus(gitRepo.rootPath)
    expect(untrackedStatus.clean).toBe(false)
    expect(untrackedStatus.untracked).toContain('README.md')

    // Initial commit to establish branch history
    await gitRepo.runGit(['add', 'README.md'])
    await gitRepo.runGit(['commit', '-m', 'Initial commit'])

    // Query log
    const logRes = await api.gitLog(gitRepo.rootPath, 5)
    expect(logRes.success).toBe(true)
    expect(logRes.isRepository).toBe(true)
    expect(logRes.commits.length).toBeGreaterThanOrEqual(1)
    expect(logRes.commits[0].message).toBe('Initial commit')
  })

  it('stages, unstages, and commits files through IPC boundary', async () => {
    await fs.writeFile(path.join(gitRepo.rootPath, 'file1.txt'), 'initial file 1\n')
    await fs.writeFile(path.join(gitRepo.rootPath, 'file2.txt'), 'initial file 2\n')
    await gitRepo.runGit(['add', '.'])
    await gitRepo.runGit(['commit', '-m', 'base commit'])

    // Modify file1 and file2
    await fs.writeFile(path.join(gitRepo.rootPath, 'file1.txt'), 'modified file 1\n')
    await fs.writeFile(path.join(gitRepo.rootPath, 'file2.txt'), 'modified file 2\n')

    // 1. Stage single file
    const stageRes = await api.gitStageFile(gitRepo.rootPath, 'file1.txt')
    expect(stageRes.success).toBe(true)
    expect(stageRes.path).toBe('file1.txt')

    let status = await api.gitStatus(gitRepo.rootPath)
    expect(status.files).toBeDefined()
    const files = status.files ?? []
    expect(files.some((f) => f.path === 'file1.txt' && f.staged)).toBe(true)
    expect(files.some((f) => f.path === 'file2.txt' && !f.staged)).toBe(true)
    expect(status.staged.some((s) => s.endsWith('file1.txt'))).toBe(true)
    expect(status.unstaged.some((s) => s.endsWith('file2.txt'))).toBe(true)

    // 2. Unstage single file
    const unstageRes = await api.gitUnstageFile(gitRepo.rootPath, 'file1.txt')
    expect(unstageRes.success).toBe(true)

    status = await api.gitStatus(gitRepo.rootPath)
    expect(status.files).toBeDefined()
    const unstageFiles = status.files ?? []
    expect(unstageFiles.some((f) => f.path === 'file1.txt' && f.staged)).toBe(false)
    expect(status.unstaged.some((s) => s.endsWith('file1.txt'))).toBe(true)

    // 3. Stage all files
    const stageAllRes = await api.gitStageAll(gitRepo.rootPath)
    expect(stageAllRes.success).toBe(true)

    status = await api.gitStatus(gitRepo.rootPath)
    expect(status.staged.some((s) => s.endsWith('file1.txt'))).toBe(true)
    expect(status.staged.some((s) => s.endsWith('file2.txt'))).toBe(true)

    // 4. Commit changes
    const commitRes = await api.gitCommit(gitRepo.rootPath, 'feat: update both files')
    expect(commitRes.success).toBe(true)
    expect(commitRes.commitHash).toBeDefined()

    status = await api.gitStatus(gitRepo.rootPath)
    expect(status.clean).toBe(true)
  })

  it('prevents committing when no changes are staged or commit message is empty', async () => {
    await fs.writeFile(path.join(gitRepo.rootPath, 'setup.txt'), 'init')
    await gitRepo.runGit(['add', '.'])
    await gitRepo.runGit(['commit', '-m', 'init'])

    // Empty message
    const emptyMsgRes = await api.gitCommit(gitRepo.rootPath, '   ')
    expect(emptyMsgRes.success).toBe(false)
    expect(emptyMsgRes.error).toMatch(/commit message cannot be empty/i)

    // Valid message but nothing staged
    const noStagedRes = await api.gitCommit(gitRepo.rootPath, 'empty commit attempt')
    expect(noStagedRes.success).toBe(false)
    expect(noStagedRes.error).toMatch(/no staged changes/i)
  })

  it('manages branches and blocks option-injection and invalid branch names', async () => {
    await fs.writeFile(path.join(gitRepo.rootPath, 'base.txt'), 'base')
    await gitRepo.runGit(['add', '.'])
    await gitRepo.runGit(['commit', '-m', 'first'])

    // 1. List branches
    const listRes = await api.gitBranchList(gitRepo.rootPath)
    expect(listRes.success).toBe(true)
    expect(listRes.branches.length).toBeGreaterThanOrEqual(1)

    // 2. Create new valid branch
    const createRes = await api.gitBranchCreate(gitRepo.rootPath, 'feature-integration-test')
    expect(createRes.success).toBe(true)
    expect(createRes.branch).toBe('feature-integration-test')

    // 3. Checkout branch
    const checkoutRes = await api.gitBranchCheckout(gitRepo.rootPath, 'feature-integration-test')
    expect(checkoutRes.success).toBe(true)

    const currentStatus = await api.gitStatus(gitRepo.rootPath)
    expect(currentStatus.branch).toBe('feature-integration-test')

    // 4. Rejection of invalid branch names and option injections
    const hyphenBranch = await api.gitBranchCreate(gitRepo.rootPath, '-b')
    expect(hyphenBranch.success).toBe(false)

    const dotBranch = await api.gitBranchCreate(gitRepo.rootPath, '..')
    expect(dotBranch.success).toBe(false)

    const spaceBranch = await api.gitBranchCreate(gitRepo.rootPath, 'feature with spaces')
    expect(spaceBranch.success).toBe(false)

    const nullBranch = await api.gitBranchCreate(gitRepo.rootPath, 'bad\0branch')
    expect(nullBranch.success).toBe(false)
  })

  it('inspects per-file diffs and discards single-file modifications safely', async () => {
    await fs.writeFile(path.join(gitRepo.rootPath, 'tracked.txt'), 'line 1\nline 2\n')
    await gitRepo.runGit(['add', '.'])
    await gitRepo.runGit(['commit', '-m', 'add tracked'])

    // Modify tracked file
    await fs.writeFile(path.join(gitRepo.rootPath, 'tracked.txt'), 'line 1\nline 2 modified\nline 3\n')

    // 1. Inspect file diff
    const diffRes = await api.gitFileDiff(gitRepo.rootPath, 'tracked.txt')
    expect(diffRes.success).toBe(true)
    expect(diffRes.isRepository).toBe(true)
    expect(diffRes.unstagedDiff).toContain('+line 2 modified')

    // 2. Discard modifications
    const discardRes = await api.gitDiscardFile(gitRepo.rootPath, 'tracked.txt')
    expect(discardRes.success).toBe(true)

    const restoredContent = await fs.readFile(path.join(gitRepo.rootPath, 'tracked.txt'), 'utf-8')
    expect(restoredContent.replace(/\r\n/g, '\n')).toBe('line 1\nline 2\n')

    const statusAfterDiscard = await api.gitStatus(gitRepo.rootPath)
    expect(statusAfterDiscard.clean).toBe(true)
  })

  it('handles non-repository workspaces gracefully with sanitized responses', async () => {
    const nonRepo = await createTestWorkspace('ai-ide-non-git-')
    try {
      const statusRes = await api.gitStatus(nonRepo.rootPath)
      expect(statusRes.isRepository).toBe(false)
      expect(statusRes.clean).toBe(false)
      expect(statusRes.error).toMatch(/not a Git repository/i)

      const branchRes = await api.gitBranchList(nonRepo.rootPath)
      expect(branchRes.isRepository).toBe(false)
      expect(branchRes.branches).toEqual([])
    } finally {
      await nonRepo.cleanup()
    }
  })
})
