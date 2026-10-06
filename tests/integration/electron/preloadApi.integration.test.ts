/**
 * Preload API Integration Tests
 *
 * Verifies that the production Preload script (src/preload/index.ts):
 * 1. Exposes the secure electronAPI via contextBridge.exposeInMainWorld.
 * 2. Maps every Renderer API method to the correct IPC channel and argument signature.
 * 3. Returns functional cleanup callbacks from event subscription methods.
 * 4. Ensures listener cleanup removes only the intended listener.
 * 5. Strictly confines Renderer capabilities without leaking raw Node.js/Electron objects.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { IPC_CHANNELS } from '../../../src/shared/types'
import { electronHarness } from './harness'

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

// Import real production preload module and main handlers
import { registerIpcHandlers } from '../../../src/main/index'
import { api } from '../../../src/preload/index'

describe('2. Preload API Integration', () => {
  beforeEach(() => {
    registerIpcHandlers()
    electronHarness.state.rendererListeners.clear()
  })

  it('exposes the electronAPI object in main world through contextBridge', () => {
    expect(electronHarness.state.exposedApis['electronAPI']).toBe(api)
    expect(electronHarness.state.exposedApis['electronAPI']).toBeDefined()
  })

  it('verifies all expected API methods are defined on the exposed API object', () => {
    const expectedMethods = [
      // Workspace & Explorer
      'openDirectory',
      'readTree',
      'getLastWorkspace',
      'readFile',
      'readWorkspaceFile',
      'createWorkspaceFile',
      'editWorkspaceFile',
      'writeFile',
      'createFile',
      'createDirectory',
      'renamePath',
      'deletePath',
      'listFiles',
      'watchWorkspace',
      'unwatchWorkspace',
      'onWorkspaceFileChanged',

      // Terminal & Process
      'runCommand',
      'stopCommand',
      'terminalSpawn',
      'terminalWriteInput',
      'terminalKill',
      'terminalKillAll',
      'terminalListSessions',
      'onTerminalStreamData',
      'onTerminalSessionExit',

      // Git
      'gitStatus',
      'gitDiff',
      'gitLog',
      'gitStageFile',
      'gitUnstageFile',
      'gitStageAll',
      'gitUnstageAll',
      'gitCommit',
      'gitBranchList',
      'gitBranchCreate',
      'gitBranchCheckout',
      'gitFileDiff',
      'gitDiscardFile',

      // Settings & Index & AI
      'getEnvApiKey',
      'getSettings',
      'saveSettings',
      'nvidiaChatCompletion',
      'nvidiaListModels',
      'opencodeChatCompletion',
      'opencodeListModels',
      'onOpenCodeStreamChunk',
      'cancelChatCompletion',
      'saveWorkspaceIndex',
      'loadWorkspaceIndex',
      'clearWorkspaceIndex'
    ]

    for (const method of expectedMethods) {
      expect(
        typeof (api as any)[method],
        `Expected api.${method} to be a function`
      ).toBe('function')
    }
  })

  it('verifies Renderer API calls invoke the correct IPC channel with correct arguments', async () => {
    // 1. openDirectory
    await api.openDirectory()
    expect(electronHarness.mockIpcRenderer.invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.OPEN_DIRECTORY
    )

    // 2. readTree
    await api.readTree('/mock/path')
    expect(electronHarness.mockIpcRenderer.invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.READ_TREE,
      '/mock/path'
    )

    // 3. readFile
    await api.readFile('/mock/path/file.ts')
    expect(electronHarness.mockIpcRenderer.invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.READ_FILE,
      '/mock/path/file.ts'
    )

    // 4. createFile
    await api.createFile('/mock/root', 'src/app.ts', 'const a = 1;')
    expect(electronHarness.mockIpcRenderer.invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.FS_CREATE_FILE,
      '/mock/root',
      'src/app.ts',
      'const a = 1;'
    )

    // 5. createDirectory
    await api.createDirectory('/mock/root', 'src/components')
    expect(electronHarness.mockIpcRenderer.invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.FS_CREATE_DIRECTORY,
      '/mock/root',
      'src/components'
    )

    // 6. renamePath
    await api.renamePath('/mock/root', 'src/old.ts', 'src/new.ts')
    expect(electronHarness.mockIpcRenderer.invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.FS_RENAME_PATH,
      '/mock/root',
      'src/old.ts',
      'src/new.ts'
    )

    // 7. deletePath
    await api.deletePath('/mock/root', 'src/trash.ts', { recursive: true })
    expect(electronHarness.mockIpcRenderer.invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.FS_DELETE_PATH,
      '/mock/root',
      'src/trash.ts',
      { recursive: true }
    )

    // 8. terminalSpawn
    const spawnOpts = { sessionId: 'term-1', command: 'ls', cwd: '/mock/root', workspaceRoot: '/mock/root' }
    await api.terminalSpawn!(spawnOpts)
    expect(electronHarness.mockIpcRenderer.invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.TERMINAL_SPAWN,
      spawnOpts
    )

    // 9. gitStatus
    await api.gitStatus('/mock/root')
    expect(electronHarness.mockIpcRenderer.invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.GIT_STATUS,
      '/mock/root'
    )

    // 10. gitCommit
    await api.gitCommit('/mock/root', 'feat: initial commit')
    expect(electronHarness.mockIpcRenderer.invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.GIT_COMMIT,
      '/mock/root',
      'feat: initial commit'
    )
  })

  it('event subscription methods register listeners and return functional cleanup callbacks', () => {
    // 1. onWorkspaceFileChanged
    const watcherCallback = vi.fn()
    const unsubscribeWatcher = api.onWorkspaceFileChanged(watcherCallback)
    expect(typeof unsubscribeWatcher).toBe('function')
    expect(electronHarness.mockIpcRenderer.on).toHaveBeenCalledWith(
      IPC_CHANNELS.ON_WORKSPACE_FILE_CHANGED,
      expect.any(Function)
    )

    // 2. onTerminalStreamData
    const streamCallback = vi.fn()
    const unsubscribeStream = api.onTerminalStreamData!(streamCallback)
    expect(typeof unsubscribeStream).toBe('function')
    expect(electronHarness.mockIpcRenderer.on).toHaveBeenCalledWith(
      IPC_CHANNELS.TERMINAL_STREAM_DATA,
      expect.any(Function)
    )

    // 3. onTerminalSessionExit
    const exitCallback = vi.fn()
    const unsubscribeExit = api.onTerminalSessionExit!(exitCallback)
    expect(typeof unsubscribeExit).toBe('function')
    expect(electronHarness.mockIpcRenderer.on).toHaveBeenCalledWith(
      IPC_CHANNELS.TERMINAL_SESSION_EXIT,
      expect.any(Function)
    )

    // 4. onOpenCodeStreamChunk
    const chunkCallback = vi.fn()
    const unsubscribeChunk = api.onOpenCodeStreamChunk(chunkCallback)
    expect(typeof unsubscribeChunk).toBe('function')
    expect(electronHarness.mockIpcRenderer.on).toHaveBeenCalledWith(
      IPC_CHANNELS.OPENCODE_STREAM_CHUNK,
      expect.any(Function)
    )

    // Unsubscribe each and verify removeListener called
    unsubscribeWatcher()
    expect(electronHarness.mockIpcRenderer.removeListener).toHaveBeenCalledWith(
      IPC_CHANNELS.ON_WORKSPACE_FILE_CHANGED,
      expect.any(Function)
    )

    unsubscribeStream()
    expect(electronHarness.mockIpcRenderer.removeListener).toHaveBeenCalledWith(
      IPC_CHANNELS.TERMINAL_STREAM_DATA,
      expect.any(Function)
    )

    unsubscribeExit()
    expect(electronHarness.mockIpcRenderer.removeListener).toHaveBeenCalledWith(
      IPC_CHANNELS.TERMINAL_SESSION_EXIT,
      expect.any(Function)
    )

    unsubscribeChunk()
    expect(electronHarness.mockIpcRenderer.removeListener).toHaveBeenCalledWith(
      IPC_CHANNELS.OPENCODE_STREAM_CHUNK,
      expect.any(Function)
    )
  })

  it('listener cleanup removes only the intended listener while preserving sibling listeners', () => {
    const callback1 = vi.fn()
    const callback2 = vi.fn()

    const unsub1 = api.onTerminalStreamData!(callback1)
    const unsub2 = api.onTerminalStreamData!(callback2)

    // Simulate event delivery from main process
    const testPayload = { sessionId: 'term-1', type: 'stdout' as const, data: 'hello\n' }
    electronHarness.mockWebContents.send(IPC_CHANNELS.TERMINAL_STREAM_DATA, testPayload)

    expect(callback1).toHaveBeenCalledWith(testPayload)
    expect(callback2).toHaveBeenCalledWith(testPayload)

    // Clean up first callback
    unsub1()

    // Second event delivery
    const secondPayload = { sessionId: 'term-1', type: 'stdout' as const, data: 'world\n' }
    electronHarness.mockWebContents.send(IPC_CHANNELS.TERMINAL_STREAM_DATA, secondPayload)

    // callback1 was removed, should NOT receive secondPayload
    expect(callback1).toHaveBeenCalledTimes(1)
    // callback2 remains active, should receive secondPayload
    expect(callback2).toHaveBeenCalledTimes(2)
    expect(callback2).toHaveBeenLastCalledWith(secondPayload)

    unsub2()
  })

  it('ensures Renderer-facing APIs do not expose raw Node.js or unrestricted Electron capabilities', () => {
    // Check that api object does not expose dangerous Node/Electron properties
    const dangerousProps = [
      'process',
      'require',
      'module',
      'fs',
      'child_process',
      'ipcRenderer',
      'sendSync',
      'send',
      'remote',
      'shell',
      'nativeImage'
    ]

    for (const prop of dangerousProps) {
      expect((api as any)[prop], `api.${prop} should be undefined`).toBeUndefined()
    }

    // Verify all keys on api are strictly functions matching IElectronAPI interface
    for (const [key, value] of Object.entries(api)) {
      expect(typeof value, `Expected ${key} to be a function`).toBe('function')
    }
  })
})
