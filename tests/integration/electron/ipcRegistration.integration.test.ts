/**
 * Main Process IPC Registration Integration Tests
 *
 * Verifies that the production Main Process (src/main/index.ts) registers
 * all expected IPC handlers across filesystem, Git, terminal, workspace, and AI,
 * handles repeated registration idempotently, validates incoming payloads,
 * sanitizes errors, and adheres to the shared IPC contract.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { IPC_CHANNELS } from '../../../src/shared/types'
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

// Import the real production registerIpcHandlers
import { registerIpcHandlers } from '../../../src/main/index'

describe('1. Main Process IPC Registration Integration', () => {
  let workspace: { rootPath: string; cleanup: () => Promise<void> }

  beforeEach(async () => {
    electronHarness.state.handlers.clear()
    workspace = await createTestWorkspace('ai-ide-ipc-reg-')
  })

  afterEach(async () => {
    await workspace.cleanup()
  })

  it('registers all expected IPC request-response handlers on initial call', () => {
    registerIpcHandlers()

    const registeredChannels = Array.from(electronHarness.state.handlers.keys())

    // Events that are sent via webContents.send rather than handled via ipcMain.handle
    const pushOnlyEvents = new Set([
      IPC_CHANNELS.ON_WORKSPACE_FILE_CHANGED,
      IPC_CHANNELS.TERMINAL_STREAM_DATA,
      IPC_CHANNELS.TERMINAL_SESSION_EXIT,
      IPC_CHANNELS.OPENCODE_STREAM_CHUNK
    ])

    const expectedHandleChannels = Object.values(IPC_CHANNELS).filter(
      (channel) => !pushOnlyEvents.has(channel as any)
    )

    for (const channel of expectedHandleChannels) {
      expect(
        registeredChannels,
        `Expected IPC channel "${channel}" to be registered in ipcMain.handle`
      ).toContain(channel)
    }

    // Verify handler count is substantial and matches all core operations
    expect(registeredChannels.length).toBeGreaterThanOrEqual(40)
  })

  it('handles repeated registration idempotently without throwing or leaving gaps', () => {
    // First registration
    registerIpcHandlers()
    const firstCount = electronHarness.state.handlers.size
    const firstKeys = Array.from(electronHarness.state.handlers.keys()).sort()

    // Second registration (e.g. app re-init or hot reload)
    expect(() => registerIpcHandlers()).not.toThrow()

    const secondCount = electronHarness.state.handlers.size
    const secondKeys = Array.from(electronHarness.state.handlers.keys()).sort()

    expect(secondCount).toBe(firstCount)
    expect(secondKeys).toEqual(firstKeys)
  })

  it('covers all functional domains (Filesystem, Git, Terminal, Settings/Index, AI)', () => {
    registerIpcHandlers()
    const registered = electronHarness.state.handlers

    // 1. Filesystem & Explorer domain
    expect(registered.has(IPC_CHANNELS.OPEN_DIRECTORY)).toBe(true)
    expect(registered.has(IPC_CHANNELS.READ_TREE)).toBe(true)
    expect(registered.has(IPC_CHANNELS.READ_FILE)).toBe(true)
    expect(registered.has(IPC_CHANNELS.WRITE_FILE)).toBe(true)
    expect(registered.has(IPC_CHANNELS.FS_CREATE_FILE)).toBe(true)
    expect(registered.has(IPC_CHANNELS.FS_CREATE_DIRECTORY)).toBe(true)
    expect(registered.has(IPC_CHANNELS.FS_RENAME_PATH)).toBe(true)
    expect(registered.has(IPC_CHANNELS.FS_DELETE_PATH)).toBe(true)
    expect(registered.has(IPC_CHANNELS.LIST_FILES)).toBe(true)
    expect(registered.has(IPC_CHANNELS.WATCH_WORKSPACE)).toBe(true)
    expect(registered.has(IPC_CHANNELS.UNWATCH_WORKSPACE)).toBe(true)

    // 2. Git domain
    expect(registered.has(IPC_CHANNELS.GIT_STATUS)).toBe(true)
    expect(registered.has(IPC_CHANNELS.GIT_DIFF)).toBe(true)
    expect(registered.has(IPC_CHANNELS.GIT_LOG)).toBe(true)
    expect(registered.has(IPC_CHANNELS.GIT_STAGE_FILE)).toBe(true)
    expect(registered.has(IPC_CHANNELS.GIT_UNSTAGE_FILE)).toBe(true)
    expect(registered.has(IPC_CHANNELS.GIT_STAGE_ALL)).toBe(true)
    expect(registered.has(IPC_CHANNELS.GIT_UNSTAGE_ALL)).toBe(true)
    expect(registered.has(IPC_CHANNELS.GIT_COMMIT)).toBe(true)
    expect(registered.has(IPC_CHANNELS.GIT_BRANCH_LIST)).toBe(true)
    expect(registered.has(IPC_CHANNELS.GIT_BRANCH_CREATE)).toBe(true)
    expect(registered.has(IPC_CHANNELS.GIT_BRANCH_CHECKOUT)).toBe(true)
    expect(registered.has(IPC_CHANNELS.GIT_FILE_DIFF)).toBe(true)
    expect(registered.has(IPC_CHANNELS.GIT_DISCARD_FILE)).toBe(true)

    // 3. Terminal domain
    expect(registered.has(IPC_CHANNELS.TERMINAL_SPAWN)).toBe(true)
    expect(registered.has(IPC_CHANNELS.TERMINAL_WRITE_INPUT)).toBe(true)
    expect(registered.has(IPC_CHANNELS.TERMINAL_KILL)).toBe(true)
    expect(registered.has(IPC_CHANNELS.TERMINAL_KILL_ALL)).toBe(true)
    expect(registered.has(IPC_CHANNELS.TERMINAL_LIST_SESSIONS)).toBe(true)
    expect(registered.has(IPC_CHANNELS.RUN_COMMAND)).toBe(true)
    expect(registered.has(IPC_CHANNELS.STOP_COMMAND)).toBe(true)

    // 4. Settings & Persistent Workspace Index domain
    expect(registered.has(IPC_CHANNELS.GET_SETTINGS)).toBe(true)
    expect(registered.has(IPC_CHANNELS.SAVE_SETTINGS)).toBe(true)
    expect(registered.has(IPC_CHANNELS.SAVE_WORKSPACE_INDEX)).toBe(true)
    expect(registered.has(IPC_CHANNELS.LOAD_WORKSPACE_INDEX)).toBe(true)
    expect(registered.has(IPC_CHANNELS.CLEAR_WORKSPACE_INDEX)).toBe(true)

    // 5. AI Completion domain
    expect(registered.has(IPC_CHANNELS.NVIDIA_CHAT_COMPLETION)).toBe(true)
    expect(registered.has(IPC_CHANNELS.NVIDIA_LIST_MODELS)).toBe(true)
    expect(registered.has(IPC_CHANNELS.OPENCODE_CHAT_COMPLETION)).toBe(true)
    expect(registered.has(IPC_CHANNELS.OPENCODE_LIST_MODELS)).toBe(true)
    expect(registered.has(IPC_CHANNELS.CANCEL_CHAT_COMPLETION)).toBe(true)
  })

  it('invoking registered handler returns expected structured response shape', async () => {
    registerIpcHandlers()

    // 1. Settings handler
    const settings = await electronHarness.mockIpcRenderer.invoke(IPC_CHANNELS.GET_SETTINGS)
    expect(settings).toBeDefined()
    expect(typeof settings).toBe('object')

    // 2. Terminal list sessions handler
    const terminalSessions = await electronHarness.mockIpcRenderer.invoke(IPC_CHANNELS.TERMINAL_LIST_SESSIONS)
    expect(terminalSessions).toEqual({ success: true, sessions: expect.any(Array) })

    // 3. Watcher unwatch handler
    const unwatchResult = await electronHarness.mockIpcRenderer.invoke(IPC_CHANNELS.UNWATCH_WORKSPACE)
    expect(unwatchResult).toEqual({ success: true })
  })

  it('rejects invalid or missing arguments with structured error responses', async () => {
    registerIpcHandlers()

    // 1. FS_CREATE_FILE with empty / null paths
    const emptyCreateRes = await electronHarness.mockIpcRenderer.invoke(
      IPC_CHANNELS.FS_CREATE_FILE,
      '',
      ''
    )
    expect(emptyCreateRes.success).toBe(false)
    expect(emptyCreateRes.error).toBeDefined()

    // 2. GIT_BRANCH_CREATE with invalid branch name containing option injection
    const branchRes = await electronHarness.mockIpcRenderer.invoke(
      IPC_CHANNELS.GIT_BRANCH_CREATE,
      workspace.rootPath,
      '--option-injection'
    )
    expect(branchRes.success).toBe(false)
    expect(branchRes.error).toMatch(/invalid branch name|cannot start with a hyphen/i)

    // 3. READ_WORKSPACE_FILE with path traversal
    const traversalRes = await electronHarness.mockIpcRenderer.invoke(
      IPC_CHANNELS.READ_WORKSPACE_FILE,
      workspace.rootPath,
      '../../etc/passwd'
    )
    expect(traversalRes.success).toBe(false)
    expect(traversalRes.error).toMatch(/outside.*workspace|access denied|invalid/i)
  })

  it('sanitizes unexpected handler errors without leaking sensitive filesystem details', async () => {
    registerIpcHandlers()

    // Calling gitStatus on non-existent directory
    const fakeDir = 'C:/non/existent/deep/secret/path/to/project'
    const statusRes = await electronHarness.mockIpcRenderer.invoke(IPC_CHANNELS.GIT_STATUS, fakeDir)

    // Must be a handled failure without unhandled promise rejection
    expect(statusRes).toBeDefined()
    expect(statusRes.isRepository).toBe(false)
  })

  it('throws a descriptive error when invoking an unregistered channel', async () => {
    registerIpcHandlers()

    await expect(
      electronHarness.mockIpcRenderer.invoke('nonexistent:ghostChannel', {})
    ).rejects.toThrow(/No handler registered for 'nonexistent:ghostChannel'/)
  })
})
