/**
 * Electron Runtime Reliability & Edge Case Integration Tests
 *
 * Verifies runtime boundary resilience across:
 * 1. Preload event multi-subscriber isolation and idempotent unsubscription.
 * 2. Concurrent filesystem IPC invocations without queue or disk corruption.
 * 3. Workspace index corruption recovery and identity mismatch protection.
 * 4. Settings sanitization and partial update persistence.
 * 5. Application shutdown session cleanup simulation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import path from 'path'
import fs from 'fs/promises'
import crypto from 'crypto'
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

import { registerIpcHandlers, terminalSessionManager } from '../../../src/main/index'
import { api as rawApi } from '../../../src/preload/index'
import type { WorkspaceFileChangeEvent } from '../../../src/shared/types'

const api = rawApi as Required<typeof rawApi>

describe('Runtime Reliability & Edge Cases', () => {
  let workspace: { rootPath: string; cleanup: () => Promise<void> }

  beforeEach(async () => {
    registerIpcHandlers()
    electronHarness.state.rendererListeners.clear()
    terminalSessionManager.clearAllCompletedSessions()
    workspace = await createTestWorkspace('ai-ide-runtime-rel-')
  })

  afterEach(async () => {
    try {
      await api.unwatchWorkspace()
      await api.terminalKillAll()
      terminalSessionManager.clearAllCompletedSessions()
    } catch {}
    await new Promise((r) => setTimeout(r, 100))
    await workspace.cleanup()
  })

  it('isolates multiple preload event subscribers and supports idempotent double unsubscription', async () => {
    await api.watchWorkspace(workspace.rootPath)

    const eventsSubscriber1: WorkspaceFileChangeEvent[] = []
    const eventsSubscriber2: WorkspaceFileChangeEvent[] = []

    const unsub1 = api.onWorkspaceFileChanged((evt) => {
      eventsSubscriber1.push(evt)
    })
    const unsub2 = api.onWorkspaceFileChanged((evt) => {
      eventsSubscriber2.push(evt)
    })

    try {
      // 1. Create a file: both subscribers should receive the event
      await api.createWorkspaceFile(workspace.rootPath, 'multi-sub-1.txt', 'first')

      await vi.waitFor(
        () => {
          expect(eventsSubscriber1.some((e) => e.relativePath.includes('multi-sub-1.txt'))).toBe(true)
          expect(eventsSubscriber2.some((e) => e.relativePath.includes('multi-sub-1.txt'))).toBe(true)
        },
        { timeout: 3500 }
      )

      // 2. Unsubscribe listener 1, then unsubscribe listener 1 a second time (idempotent no-op)
      unsub1()
      expect(() => unsub1()).not.toThrow()

      const count1 = eventsSubscriber1.length
      const count2 = eventsSubscriber2.length

      // 3. Create a second file: only subscriber 2 should receive this event
      await api.createWorkspaceFile(workspace.rootPath, 'multi-sub-2.txt', 'second')

      await vi.waitFor(
        () => {
          expect(eventsSubscriber2.some((e) => e.relativePath.includes('multi-sub-2.txt'))).toBe(true)
        },
        { timeout: 3500 }
      )

      // Subscriber 1 should not have received any new events
      expect(eventsSubscriber1.length).toBe(count1)
      expect(eventsSubscriber2.length).toBeGreaterThan(count2)
    } finally {
      unsub2()
    }
  })

  it('handles burst of concurrent file operations without race conditions or corrupted contents', async () => {
    const fileCount = 8
    const writePromises: Promise<any>[] = []

    // Concurrently trigger 8 workspace file creations
    for (let i = 0; i < fileCount; i++) {
      const fileName = `concurrent_file_${i}.txt`
      const content = `Content for concurrent file index ${i} with random ${Math.random()}`
      writePromises.push(api.createWorkspaceFile(workspace.rootPath, fileName, content))
    }

    const results = await Promise.all(writePromises)
    for (const res of results) {
      expect(res.success).toBe(true)
    }

    // Concurrently read all 8 files back
    const readPromises = Array.from({ length: fileCount }, (_, i) =>
      api.readWorkspaceFile(workspace.rootPath, `concurrent_file_${i}.txt`)
    )

    const readResults = await Promise.all(readPromises)
    for (let i = 0; i < fileCount; i++) {
      expect(readResults[i].success).toBe(true)
      expect(readResults[i].content).toContain(`Content for concurrent file index ${i}`)
    }
  })

  it('safely recovers from a corrupt workspace index on disk and allows immediate re-indexing', async () => {
    // Determine hash file path for this workspace root
    const normalized = path.resolve(workspace.rootPath).replace(/\\/g, '/').toLowerCase()
    const hash = crypto.createHash('sha256').update(normalized).digest('hex')
    const indexDir = path.join(electronHarness.state.userDataDir, 'workspace-indexes')
    const indexFilePath = path.join(indexDir, `${hash}.json`)

    // Write corrupted non-JSON content
    await fs.mkdir(indexDir, { recursive: true })
    await fs.writeFile(indexFilePath, '{ invalid json garbage @@##!!', 'utf-8')

    // 1. Loading corrupt index must not throw unhandled error, and discards the corrupt file
    const loadCorruptRes = await api.loadWorkspaceIndex(workspace.rootPath)
    expect(loadCorruptRes.success).toBe(false)
    expect(loadCorruptRes.error).toMatch(/corrupted index file discarded/i)

    // Verify corrupt file was deleted from disk
    let fileExists = true
    try {
      await fs.stat(indexFilePath)
    } catch {
      fileExists = false
    }
    expect(fileExists).toBe(false)

    // 2. Immediately save a valid index
    const validData = { workspaceRoot: workspace.rootPath, version: 1, files: ['index.ts'] }
    const saveRes = await api.saveWorkspaceIndex(workspace.rootPath, validData)
    expect(saveRes.success).toBe(true)

    // 3. Loading now returns valid index data
    const loadValidRes = await api.loadWorkspaceIndex(workspace.rootPath)
    expect(loadValidRes.success).toBe(true)
    expect(loadValidRes.data).toEqual(validData)
  })

  it('rejects workspace index payloads with identity mismatch', async () => {
    // Attempt to save an index payload where workspaceRoot !== requested root
    const mismatchedData = {
      workspaceRoot: 'C:/Another/Unrelated/Workspace',
      version: 1,
      files: []
    }

    const saveRes = await api.saveWorkspaceIndex(workspace.rootPath, mismatchedData)
    expect(saveRes.success).toBe(false)
    expect(saveRes.error).toMatch(/workspace identity mismatch/i)
  })

  it('sanitizes application settings and preserves existing values across partial updates', async () => {
    // 1. Initial settings save
    const res1 = await api.saveSettings({
      geminiApiKey: 'gemini-key-123',
      openRouterApiKey: 'openrouter-key-456',
      selectedProvider: 'gemini'
    })
    expect(res1.success).toBe(true)

    let settings = await api.getSettings()
    expect(settings.geminiApiKey).toBe('gemini-key-123')
    expect(settings.openRouterApiKey).toBe('openrouter-key-456')
    expect(settings.selectedProvider).toBe('gemini')

    // 2. Partial update changing provider and removing openRouter key by sending empty string
    await api.saveSettings({
      selectedProvider: 'openrouter',
      openRouterApiKey: '   ' // empty trimmed -> should delete key
    })

    settings = await api.getSettings()
    expect(settings.selectedProvider).toBe('openrouter')
    expect(settings.geminiApiKey).toBe('gemini-key-123') // preserved!
    expect(settings.openRouterApiKey).toBeUndefined() // removed!
  })

  it('simulates main process shutdown cleanly terminating all active background terminal sessions', async () => {
    const sleepScript = path.join(workspace.rootPath, 'shutdown_sleep.cjs').replace(/\\/g, '/')
    await fs.writeFile(
      sleepScript,
      'const i = setInterval(() => {}, 1000); process.on("SIGTERM", () => { clearInterval(i); process.exit(0); });'
    )

    // Spawn 2 background sessions
    const s1 = await api.terminalSpawn({
      sessionId: 'term-shutdown-1',
      command: `node "${sleepScript}"`,
      cwd: workspace.rootPath,
      workspaceRoot: workspace.rootPath
    })
    const s2 = await api.terminalSpawn({
      sessionId: 'term-shutdown-2',
      command: `node "${sleepScript}"`,
      cwd: workspace.rootPath,
      workspaceRoot: workspace.rootPath
    })

    expect(s1.success).toBe(true)
    expect(s2.success).toBe(true)

    // Simulate before-quit application event
    await terminalSessionManager.killAllSessions()

    // Verify all sessions are terminated
    const listRes = await api.terminalListSessions()
    const active = listRes.sessions.filter((s) => s.running)
    expect(active.length).toBe(0)
  })
})
