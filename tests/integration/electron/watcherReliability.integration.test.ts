/**
 * Workspace Watcher Reliability & Event Processing Edge Case Integration Tests
 *
 * Verifies robust filesystem watcher behavior across:
 * 1. Rapid burst of multiple filesystem additions and modifications.
 * 2. Deeply nested directory creation and file addition.
 * 3. Cross-channel event delivery triggered by Git discard operations.
 * 4. Graceful rejection when attempting to watch non-existent directories.
 * 5. Idempotent repeated unwatchWorkspace calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import path from 'path'
import fs from 'fs/promises'
import { electronHarness, createTestGitRepo, createTestWorkspace } from './harness'

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
import type { WorkspaceFileChangeEvent } from '../../../src/shared/types'

const api = rawApi as Required<typeof rawApi>

describe('Workspace Watcher Reliability & Edge Cases', () => {
  let workspace: { rootPath: string; cleanup: () => Promise<void> }

  beforeEach(async () => {
    registerIpcHandlers()
    electronHarness.state.rendererListeners.clear()
    workspace = await createTestWorkspace('ai-ide-watch-rel-')
  })

  afterEach(async () => {
    try {
      await api.unwatchWorkspace()
    } catch {}
    await new Promise((r) => setTimeout(r, 100))
    await workspace.cleanup()
  })

  it('reliably handles a rapid burst of multiple file writes without dropping watcher handle', async () => {
    await api.watchWorkspace(workspace.rootPath)

    const events: WorkspaceFileChangeEvent[] = []
    const unsub = api.onWorkspaceFileChanged((evt) => {
      events.push(evt)
    })

    try {
      const fileNames = ['burst_1.txt', 'burst_2.txt', 'burst_3.txt', 'burst_4.txt']

      // Rapidly write 4 files in sequence
      for (const name of fileNames) {
        await fs.writeFile(path.join(workspace.rootPath, name), `Content of ${name}`, 'utf-8')
      }

      await vi.waitFor(
        () => {
          for (const name of fileNames) {
            const found = events.some((e) => e.relativePath.toLowerCase().includes(name))
            expect(found).toBe(true)
          }
        },
        { timeout: 4000 }
      )
    } finally {
      unsub()
    }
  })

  it('tracks file creations inside deeply nested directory hierarchies', async () => {
    await api.watchWorkspace(workspace.rootPath)

    const events: WorkspaceFileChangeEvent[] = []
    const unsub = api.onWorkspaceFileChanged((evt) => {
      events.push(evt)
    })

    try {
      const deepDirRel = path.join('packages', 'core', 'src', 'utils')
      const deepDirAbs = path.join(workspace.rootPath, deepDirRel)
      await fs.mkdir(deepDirAbs, { recursive: true })

      const targetFile = path.join(deepDirAbs, 'helper.ts')
      await fs.writeFile(targetFile, 'export const helper = 42;\n', 'utf-8')

      await vi.waitFor(
        () => {
          const matched = events.find(
            (e) =>
              e.relativePath.toLowerCase().includes('helper.ts') &&
              e.relativePath.toLowerCase().includes('packages')
          )
          expect(matched).toBeDefined()
          expect(matched?.isDirectory).toBe(false)
        },
        { timeout: 4000 }
      )
    } finally {
      unsub()
    }
  })

  it('delivers watcher notifications during cross-channel Git discard operations', async () => {
    const gitRepo = await createTestGitRepo('ai-ide-watch-git-')

    try {
      // 1. Commit baseline tracked file
      const trackedFile = path.join(gitRepo.rootPath, 'settings.json')
      await fs.writeFile(trackedFile, '{"theme": "dark"}\n', 'utf-8')
      await gitRepo.runGit(['add', 'settings.json'])
      await gitRepo.runGit(['commit', '-m', 'Initial settings.json'])

      // 2. Start watcher on Git repository
      await api.watchWorkspace(gitRepo.rootPath)

      const events: WorkspaceFileChangeEvent[] = []
      const unsub = api.onWorkspaceFileChanged((evt) => {
        events.push(evt)
      })

      try {
        // 3. Modify the tracked file
        await fs.writeFile(trackedFile, '{"theme": "light"}\n', 'utf-8')

        await vi.waitFor(
          () => {
            expect(events.some((e) => e.relativePath.includes('settings.json'))).toBe(true)
          },
          { timeout: 3500 }
        )

        // Clear events
        events.length = 0

        // 4. Discard modifications via Git IPC
        const discardRes = await api.gitDiscardFile(gitRepo.rootPath, 'settings.json')
        expect(discardRes.success).toBe(true)

        // 5. Watcher should receive notification that settings.json was reverted
        await vi.waitFor(
          () => {
            const discardEvent = events.find((e) => e.relativePath.includes('settings.json'))
            expect(discardEvent).toBeDefined()
          },
          { timeout: 3500 }
        )
      } finally {
        unsub()
      }
    } finally {
      await api.unwatchWorkspace()
      await new Promise((r) => setTimeout(r, 100))
      await gitRepo.cleanup()
    }
  })

  it('rejects watching non-existent workspace directories gracefully', async () => {
    const nonExistentPath = path.join(workspace.rootPath, 'folder-that-does-not-exist-999')
    const watchRes = await api.watchWorkspace(nonExistentPath)
    expect(watchRes.success).toBe(false)
    expect(watchRes.error).toBeDefined()
  })

  it('handles multiple sequential unwatchWorkspace calls idempotently', async () => {
    await api.watchWorkspace(workspace.rootPath)

    // First unwatch
    const res1 = await api.unwatchWorkspace()
    expect(res1.success).toBe(true)

    // Second unwatch when no watcher is active
    const res2 = await api.unwatchWorkspace()
    expect(res2.success).toBe(true)

    // Third unwatch
    const res3 = await api.unwatchWorkspace()
    expect(res3.success).toBe(true)
  })
})
