/**
 * Cross-Domain IPC Integration Regression Tests
 *
 * Verifies end-to-end multi-channel integration flows across:
 * 1. Filesystem -> Git Status -> Git Staging -> Git Commit -> Git Log cycle.
 * 2. Filesystem Creation -> Workspace Watcher notification -> File Read round-trip.
 * 3. Workspace Index Save -> Load -> Clear lifecycle and workspace identity matching.
 * 4. Application Settings Save -> Load persistence.
 * 5. Terminal execution writing file -> Session exit event -> Filesystem verification.
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

import { registerIpcHandlers, terminalSessionManager } from '../../../src/main/index'
import { api } from '../../../src/preload/index'
import type { WorkspaceFileChangeEvent, TerminalSessionExitEvent } from '../../../src/shared/types'

describe('8. Cross-Domain IPC Integration Regression', () => {
  let gitRepo: {
    rootPath: string
    cleanup: () => Promise<void>
    runGit: (args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>
  }

  beforeEach(async () => {
    registerIpcHandlers()
    electronHarness.state.rendererListeners.clear()
    terminalSessionManager.clearAllCompletedSessions()
    gitRepo = await createTestGitRepo('ai-ide-regression-')
  })

  afterEach(async () => {
    try {
      await api.unwatchWorkspace()
      await api.terminalKillAll?.()
      terminalSessionManager.clearAllCompletedSessions()
    } catch {}
    await new Promise((r) => setTimeout(r, 100))
    await gitRepo.cleanup()
  })

  it('completes an end-to-end file editing, git staging, and committing cycle', async () => {
    // 0. Establish initial commit with tracked README.md
    await fs.writeFile(path.join(gitRepo.rootPath, 'README.md'), '# Initial README\n', 'utf-8')
    await gitRepo.runGit(['add', 'README.md'])
    await gitRepo.runGit(['commit', '-m', 'Initial commit'])

    // 1. Initial repo status should be clean
    const initialStatus = await api.gitStatus(gitRepo.rootPath)
    expect(initialStatus.success).toBe(true)
    expect(initialStatus.clean).toBe(true)

    // 2. Modify an existing tracked file through filesystem IPC
    const editRes = await api.editWorkspaceFile(
      gitRepo.rootPath,
      'README.md',
      '# Updated Project Title\n\nFresh content edited via IPC.'
    )
    expect(editRes.success).toBe(true)

    // 3. Git status detects unstaged change
    const afterEditStatus = await api.gitStatus(gitRepo.rootPath)
    expect(afterEditStatus.success).toBe(true)
    expect(afterEditStatus.clean).toBe(false)
    expect(afterEditStatus.unstaged.length).toBeGreaterThan(0)
    expect(afterEditStatus.unstaged.some((f) => f.includes('README.md'))).toBe(true)

    // 4. Inspect file diff via Git IPC
    const diffRes = await api.gitFileDiff(gitRepo.rootPath, 'README.md')
    expect(diffRes.success).toBe(true)
    expect(diffRes.unstagedDiff).toContain('+Fresh content edited via IPC.')

    // 5. Stage the modified file
    const stageRes = await api.gitStageFile(gitRepo.rootPath, 'README.md')
    expect(stageRes.success).toBe(true)

    const afterStageStatus = await api.gitStatus(gitRepo.rootPath)
    expect(afterStageStatus.staged.some((f) => f.includes('README.md'))).toBe(true)

    // 6. Commit the staged change
    const commitRes = await api.gitCommit(gitRepo.rootPath, 'Update README docs')
    expect(commitRes.success).toBe(true)
    expect(commitRes.commitHash).toBeDefined()

    // 7. Verify clean status and new entry in git log
    const finalStatus = await api.gitStatus(gitRepo.rootPath)
    expect(finalStatus.clean).toBe(true)

    const logRes = await api.gitLog(gitRepo.rootPath, 5)
    expect(logRes.success).toBe(true)
    expect(logRes.commits.length).toBeGreaterThanOrEqual(2)
    expect(logRes.commits[0].message).toBe('Update README docs')
  })

  it('coordinates filesystem file creation with workspace watcher notification and read-back', async () => {
    // 1. Start watching repo workspace
    await api.watchWorkspace(gitRepo.rootPath)

    const events: WorkspaceFileChangeEvent[] = []
    const unsubWatcher = api.onWorkspaceFileChanged((evt) => {
      events.push(evt)
    })

    try {
      // 2. Create file through Preload createWorkspaceFile
      const createdContent = '{"version": "1.0.0", "status": "ok"}'
      const createRes = await api.createWorkspaceFile(
        gitRepo.rootPath,
        'config/settings.json',
        createdContent
      )
      expect(createRes.success).toBe(true)

      // 3. Verify watcher picked up file addition
      await vi.waitFor(
        () => {
          const match = events.find(
            (e) => e.relativePath.toLowerCase().includes('settings.json')
          )
          expect(match).toBeDefined()
        },
        { timeout: 3500 }
      )

      // 4. Verify reading the file returns identical content
      const readRes = await api.readWorkspaceFile(gitRepo.rootPath, 'config/settings.json')
      expect(readRes.success).toBe(true)
      expect(readRes.content).toBe(createdContent)
    } finally {
      unsubWatcher()
    }
  })

  it('manages workspace index lifecycle (save, load, and clear) with identity validation', async () => {
    const testIndexData = {
      workspaceRoot: gitRepo.rootPath,
      version: 1,
      fileCount: 42,
      symbols: ['App', 'Header', 'Footer']
    }

    // 1. Save workspace index
    const saveRes = await api.saveWorkspaceIndex(gitRepo.rootPath, testIndexData)
    expect(saveRes.success).toBe(true)

    // 2. Load workspace index and verify content
    const loadRes = await api.loadWorkspaceIndex(gitRepo.rootPath)
    expect(loadRes.success).toBe(true)
    expect(loadRes.data).toEqual(testIndexData)

    // 3. Clear workspace index
    const clearRes = await api.clearWorkspaceIndex(gitRepo.rootPath)
    expect(clearRes.success).toBe(true)

    // 4. Verify loading cleared index returns error
    const loadAfterClear = await api.loadWorkspaceIndex(gitRepo.rootPath)
    expect(loadAfterClear.success).toBe(false)
    expect(loadAfterClear.error).toMatch(/not found/i)
  })

  it('persists and retrieves application settings without data corruption', async () => {
    // 1. Save new settings
    const saveRes = await api.saveSettings({
      selectedProvider: 'openrouter',
      nvidiaModelId: 'meta/llama3-70b-instruct'
    })
    expect(saveRes.success).toBe(true)

    // 2. Get settings and verify values
    const settings = await api.getSettings()
    expect(settings.selectedProvider).toBe('openrouter')
    expect(settings.nvidiaModelId).toBe('meta/llama3-70b-instruct')

    // 3. Partially update settings
    await api.saveSettings({
      selectedProvider: 'nvidia'
    })

    const updatedSettings = await api.getSettings()
    expect(updatedSettings.selectedProvider).toBe('nvidia')
    expect(updatedSettings.nvidiaModelId).toBe('meta/llama3-70b-instruct')
  })

  it('coordinates terminal command execution, session exit, and filesystem verification', async () => {
    if (!api.onTerminalSessionExit || !api.terminalSpawn) {
      throw new Error('Terminal IPC APIs must be available on preload api')
    }

    let exitEvent: TerminalSessionExitEvent | null = null
    const unsubExit = api.onTerminalSessionExit((evt) => {
      if (evt.sessionId === 'session-coord-test') {
        exitEvent = evt
      }
    })

    try {
      // Spawn terminal command that creates an artifact file in the workspace
      const targetFileName = 'generated_output.txt'
      const targetFileRel = path.join(gitRepo.rootPath, targetFileName).replace(/\\/g, '/')
      const command = `node -e "require('fs').writeFileSync(process.argv[1], 'IPC Coordination Success\\n');" "${targetFileRel}"`

      const spawnRes = await api.terminalSpawn({
        sessionId: 'session-coord-test',
        command,
        cwd: gitRepo.rootPath,
        workspaceRoot: gitRepo.rootPath
      })
      expect(spawnRes.success).toBe(true)

      // Await process completion
      await vi.waitFor(
        () => {
          expect(exitEvent).not.toBeNull()
          expect(exitEvent?.exitCode).toBe(0)
        },
        { timeout: 5000 }
      )

      // Verify file was written to disk and can be read back via filesystem IPC
      const readRes = await api.readWorkspaceFile(gitRepo.rootPath, targetFileName)
      expect(readRes.success).toBe(true)
      expect(readRes.content).toContain('IPC Coordination Success')
    } finally {
      unsubExit()
    }
  })
})
