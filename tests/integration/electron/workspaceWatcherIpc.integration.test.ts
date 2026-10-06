/**
 * Workspace Watcher IPC Integration Tests
 *
 * Verifies real production Workspace Watcher IPC handlers and Preload API interactions:
 * 1. Watcher lifecycle (start, restart on workspace switch, idempotency, and stop).
 * 2. Real filesystem change detection (add, change, unlink) broadcast to WebContents.
 * 3. Ignored directory filtering (.git, node_modules, dist, scratch, etc.).
 * 4. Ignored file extension filtering (.tmp, .tsbuildinfo, ~).
 * 5. Safe unwatching and listener cleanup.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import path from 'path'
import fs from 'fs/promises'
import { electronHarness, createTestWorkspace } from './harness'

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
import type { WorkspaceFileChangeEvent } from '../../../src/shared/types'

describe('6. Workspace Watcher IPC Integration', () => {
  let workspace: { rootPath: string; cleanup: () => Promise<void> }

  beforeEach(async () => {
    registerIpcHandlers()
    electronHarness.state.rendererListeners.clear()
    workspace = await createTestWorkspace('ai-ide-watcher-test-')
  })

  afterEach(async () => {
    try {
      await api.unwatchWorkspace()
    } catch {
      // Ignore cleanup error
    }
    // Small pause to allow native watcher handle to release before rm
    await new Promise((r) => setTimeout(r, 100))
    await workspace.cleanup()
  })

  it('starts and stops workspace watcher successfully, maintaining idempotency', async () => {
    // 1. Start watching workspace
    const startRes = await api.watchWorkspace(workspace.rootPath)
    expect(startRes.success).toBe(true)

    // 2. Starting on the exact same root returns success idempotently
    const duplicateRes = await api.watchWorkspace(workspace.rootPath)
    expect(duplicateRes.success).toBe(true)

    // 3. Stop watcher
    const stopRes = await api.unwatchWorkspace()
    expect(stopRes.success).toBe(true)

    // 4. Invalid workspace path rejection
    const invalidRes = await api.watchWorkspace('')
    expect(invalidRes.success).toBe(false)
    expect(invalidRes.error).toMatch(/invalid workspace path/i)
  })

  it('broadcasts file creation, modification, and deletion events through Preload API', async () => {
    const startRes = await api.watchWorkspace(workspace.rootPath)
    expect(startRes.success).toBe(true)

    const events: WorkspaceFileChangeEvent[] = []
    const unsub = api.onWorkspaceFileChanged((evt) => {
      events.push(evt)
    })

    try {
      // 1. Create a new file inside the workspace
      const targetFile = path.join(workspace.rootPath, 'watched-note.txt')
      await fs.writeFile(targetFile, 'initial content', 'utf-8')

      await vi.waitFor(
        () => {
          const match = events.find(
            (e) => e.relativePath.toLowerCase() === 'watched-note.txt' && (e.eventType === 'add' || e.eventType === 'change')
          )
          expect(match).toBeDefined()
          expect(match?.isDirectory).toBe(false)
        },
        { timeout: 3500 }
      )

      // 2. Modify the file
      await fs.writeFile(targetFile, 'updated content after initial write', 'utf-8')

      await vi.waitFor(
        () => {
          const changeEvents = events.filter(
            (e) => e.relativePath.toLowerCase() === 'watched-note.txt' && e.eventType === 'change'
          )
          expect(changeEvents.length).toBeGreaterThanOrEqual(1)
        },
        { timeout: 3500 }
      )

      // 3. Delete the file
      await fs.unlink(targetFile)

      await vi.waitFor(
        () => {
          const unlinkEvent = events.find(
            (e) => e.relativePath.toLowerCase() === 'watched-note.txt' && e.eventType === 'unlink'
          )
          expect(unlinkEvent).toBeDefined()
        },
        { timeout: 3500 }
      )
    } finally {
      unsub()
    }
  })

  it('detects directory creation and identifies isDirectory correctly', async () => {
    await api.watchWorkspace(workspace.rootPath)

    const events: WorkspaceFileChangeEvent[] = []
    const unsub = api.onWorkspaceFileChanged((evt) => {
      events.push(evt)
    })

    try {
      const newSubdir = path.join(workspace.rootPath, 'components')
      await fs.mkdir(newSubdir, { recursive: true })

      await vi.waitFor(
        () => {
          const dirEvent = events.find(
            (e) => e.relativePath.toLowerCase() === 'components' && (e.eventType === 'add' || e.eventType === 'change')
          )
          expect(dirEvent).toBeDefined()
          expect(dirEvent?.isDirectory).toBe(true)
        },
        { timeout: 3500 }
      )
    } finally {
      unsub()
    }
  })

  it('filters out ignored directories like .git, node_modules, and scratch', async () => {
    await api.watchWorkspace(workspace.rootPath)

    const events: WorkspaceFileChangeEvent[] = []
    const unsub = api.onWorkspaceFileChanged((evt) => {
      events.push(evt)
    })

    try {
      // Create ignored dirs
      const gitDir = path.join(workspace.rootPath, '.git')
      const nodeModulesDir = path.join(workspace.rootPath, 'node_modules')
      const scratchDir = path.join(workspace.rootPath, 'scratch')
      await fs.mkdir(gitDir, { recursive: true })
      await fs.mkdir(nodeModulesDir, { recursive: true })
      await fs.mkdir(scratchDir, { recursive: true })

      // Clear any events from directory creations
      events.length = 0

      // Write files inside ignored directories
      await fs.writeFile(path.join(gitDir, 'COMMIT_EDITMSG'), 'commit message', 'utf-8')
      await fs.writeFile(path.join(nodeModulesDir, 'package.json'), '{}', 'utf-8')
      await fs.writeFile(path.join(scratchDir, 'temp.txt'), 'scratch data', 'utf-8')

      // Also write temporary cache file extensions that should be filtered
      await fs.writeFile(path.join(workspace.rootPath, 'tsconfig.tsbuildinfo'), 'cache', 'utf-8')
      await fs.writeFile(path.join(workspace.rootPath, 'temp-file.tmp'), 'temp', 'utf-8')

      // Wait a moment for any filesystem events to process
      await new Promise((r) => setTimeout(r, 600))

      // None of the ignored paths should appear in events
      const ignoredEvents = events.filter((e) => {
        const rel = e.relativePath.toLowerCase()
        return (
          rel.includes('.git') ||
          rel.includes('node_modules') ||
          rel.includes('scratch') ||
          rel.endsWith('.tsbuildinfo') ||
          rel.endsWith('.tmp')
        )
      })

      expect(ignoredEvents).toHaveLength(0)
    } finally {
      unsub()
    }
  })

  it('stops firing events after unwatchWorkspace is called', async () => {
    await api.watchWorkspace(workspace.rootPath)

    const events: WorkspaceFileChangeEvent[] = []
    const unsub = api.onWorkspaceFileChanged((evt) => {
      events.push(evt)
    })

    try {
      // Verify watcher is working first
      const file1 = path.join(workspace.rootPath, 'file1.txt')
      await fs.writeFile(file1, 'hello', 'utf-8')

      await vi.waitFor(
        () => {
          expect(events.some((e) => e.relativePath.toLowerCase() === 'file1.txt')).toBe(true)
        },
        { timeout: 3500 }
      )

      // Wait for file1 events to settle
      await new Promise((r) => setTimeout(r, 200))
      events.length = 0

      // Stop watching
      await api.unwatchWorkspace()

      // Write another file after unwatch
      const file2 = path.join(workspace.rootPath, 'file2.txt')
      await fs.writeFile(file2, 'hello again', 'utf-8')

      await new Promise((r) => setTimeout(r, 600))

      // No new events should have been added for file2
      expect(events.some((e) => e.relativePath.toLowerCase() === 'file2.txt')).toBe(false)
      expect(events.length).toBe(0)
    } finally {
      unsub()
    }
  })

  it('cleanly transitions when switching to watch a different workspace', async () => {
    const secondWorkspace = await createTestWorkspace('ai-ide-watcher-switch-')

    try {
      // 1. Watch first workspace
      await api.watchWorkspace(workspace.rootPath)

      // 2. Switch watch to second workspace
      const switchRes = await api.watchWorkspace(secondWorkspace.rootPath)
      expect(switchRes.success).toBe(true)

      const events: WorkspaceFileChangeEvent[] = []
      const unsub = api.onWorkspaceFileChanged((evt) => {
        events.push(evt)
      })

      try {
        // Write to first workspace (which should no longer be watched)
        await fs.writeFile(path.join(workspace.rootPath, 'ignored-after-switch.txt'), 'data', 'utf-8')

        // Write to second workspace (which is currently watched)
        await fs.writeFile(path.join(secondWorkspace.rootPath, 'active-in-second.txt'), 'data', 'utf-8')

        await vi.waitFor(
          () => {
            const inSecond = events.find((e) => e.relativePath.toLowerCase() === 'active-in-second.txt')
            expect(inSecond).toBeDefined()
          },
          { timeout: 3500 }
        )

        // Ensure no events for first workspace were fired
        const inFirst = events.find((e) => e.relativePath.toLowerCase() === 'ignored-after-switch.txt')
        expect(inFirst).toBeUndefined()
      } finally {
        unsub()
      }
    } finally {
      await api.unwatchWorkspace()
      await new Promise((r) => setTimeout(r, 100))
      await secondWorkspace.cleanup()
    }
  })
})
