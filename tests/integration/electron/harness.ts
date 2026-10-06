/**
 * Electron Runtime Integration Test Harness
 *
 * Provides a high-fidelity, in-memory IPC bridge and mocked Electron environment
 * allowing direct execution of real Main Process handlers (src/main/index.ts)
 * and real Preload APIs (src/preload/index.ts) in deterministic Vitest suites.
 */

import path from 'path'
import fs from 'fs/promises'
import os from 'os'
import { spawn } from 'child_process'
import { vi } from 'vitest'

export interface IpcHarnessState {
  handlers: Map<string, (event: any, ...args: any[]) => Promise<any> | any>
  rendererListeners: Map<string, Set<(event: any, ...args: any[]) => void>>
  mainListeners: Map<string, Set<(...args: any[]) => void>>
  exposedApis: Record<string, any>
  activeWindows: any[]
  userDataDir: string
}

export function createElectronHarness() {
  const userDataDir = path.join(os.tmpdir(), `ai-ide-test-userData-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)

  const state: IpcHarnessState = {
    handlers: new Map(),
    rendererListeners: new Map(),
    mainListeners: new Map(),
    exposedApis: {},
    activeWindows: [],
    userDataDir
  }

  const mockWebContents = {
    send: vi.fn((channel: string, ...args: any[]) => {
      const listeners = state.rendererListeners.get(channel)
      if (listeners) {
        for (const listener of Array.from(listeners)) {
          try {
            listener({ sender: mockWebContents }, ...args)
          } catch (err) {
            console.error(`Error in renderer listener for channel ${channel}:`, err)
          }
        }
      }
    }),
    isDestroyed: vi.fn().mockReturnValue(false),
    on: vi.fn(),
    setWindowOpenHandler: vi.fn()
  }

  const mockMainWindow = {
    webContents: mockWebContents,
    isDestroyed: vi.fn().mockReturnValue(false),
    show: vi.fn(),
    focus: vi.fn(),
    restore: vi.fn(),
    isMinimized: vi.fn().mockReturnValue(false),
    on: vi.fn()
  }

  state.activeWindows = [mockMainWindow]

  const mockIpcMain = {
    handle: vi.fn((channel: string, handler: (event: any, ...args: any[]) => Promise<any> | any) => {
      state.handlers.set(channel, handler)
    }),
    removeHandler: vi.fn((channel: string) => {
      state.handlers.delete(channel)
    }),
    on: vi.fn((channel: string, listener: (...args: any[]) => void) => {
      if (!state.mainListeners.has(channel)) {
        state.mainListeners.set(channel, new Set())
      }
      state.mainListeners.get(channel)!.add(listener)
    }),
    removeListener: vi.fn((channel: string, listener: (...args: any[]) => void) => {
      state.mainListeners.get(channel)?.delete(listener)
    })
  }

  const mockIpcRenderer = {
    invoke: vi.fn(async (channel: string, ...args: any[]) => {
      const handler = state.handlers.get(channel)
      if (!handler) {
        throw new Error(`Error invoking remote method '${channel}': No handler registered for '${channel}'`)
      }
      return await handler({ sender: mockWebContents }, ...args)
    }),
    on: vi.fn((channel: string, listener: (event: any, ...args: any[]) => void) => {
      if (!state.rendererListeners.has(channel)) {
        state.rendererListeners.set(channel, new Set())
      }
      state.rendererListeners.get(channel)!.add(listener)
    }),
    removeListener: vi.fn((channel: string, listener: (event: any, ...args: any[]) => void) => {
      state.rendererListeners.get(channel)?.delete(listener)
    }),
    send: vi.fn((channel: string, ...args: any[]) => {
      const listeners = state.mainListeners.get(channel)
      if (listeners) {
        for (const listener of Array.from(listeners)) {
          listener({ sender: mockWebContents }, ...args)
        }
      }
    })
  }

  const mockContextBridge = {
    exposeInMainWorld: vi.fn((key: string, apiObject: any) => {
      state.exposedApis[key] = apiObject
    })
  }

  class MockBrowserWindow {
    webContents = mockWebContents
    isDestroyed = vi.fn().mockReturnValue(false)
    show = vi.fn()
    focus = vi.fn()
    restore = vi.fn()
    isMinimized = vi.fn().mockReturnValue(false)
    on = vi.fn()

    static getAllWindows = vi.fn(() => state.activeWindows)
  }

  const mockApp = {
    requestSingleInstanceLock: vi.fn().mockReturnValue(true),
    whenReady: vi.fn().mockReturnValue(new Promise(() => {})), // Does not auto-resolve
    on: vi.fn(),
    quit: vi.fn(),
    getPath: vi.fn((name: string) => {
      if (name === 'userData') return state.userDataDir
      return path.join(state.userDataDir, name)
    }),
    isPackaged: false
  }

  const mockDialog = {
    showOpenDialog: vi.fn()
  }

  const mockShell = {
    openExternal: vi.fn().mockResolvedValue(undefined)
  }

  let headersReceivedCallback: any = null
  const mockSession = {
    defaultSession: {
      webRequest: {
        onHeadersReceived: vi.fn((cb) => {
          headersReceivedCallback = cb
        })
      }
    }
  }

  return {
    state,
    mockIpcMain,
    mockIpcRenderer,
    mockContextBridge,
    MockBrowserWindow,
    mockWebContents,
    mockMainWindow,
    mockApp,
    mockDialog,
    mockShell,
    mockSession,
    getHeaderReceivedCallback: () => headersReceivedCallback
  }
}

/**
 * Creates an isolated temporary directory for filesystem integration tests.
 */
export async function createTestWorkspace(prefix = 'ai-ide-test-ws-'): Promise<{
  rootPath: string
  cleanup: () => Promise<void>
}> {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  const cleanup = async () => {
    try {
      await fs.rm(rootPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch (err) {
      // Ignore cleanup error if already removed
    }
  }
  return { rootPath: rootPath.replace(/\\/g, '/'), cleanup }
}

/**
 * Creates an isolated temporary Git repository for Git IPC integration tests.
 */
export async function createTestGitRepo(prefix = 'ai-ide-test-git-'): Promise<{
  rootPath: string
  cleanup: () => Promise<void>
  runGit: (args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>
}> {
  const { rootPath, cleanup: dirCleanup } = await createTestWorkspace(prefix)

  const runGit = (args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
    return new Promise((resolve) => {
      const child = spawn('git', args, {
        cwd: rootPath,
        shell: false,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Test Runner',
          GIT_AUTHOR_EMAIL: 'test@runner.local',
          GIT_COMMITTER_NAME: 'Test Runner',
          GIT_COMMITTER_EMAIL: 'test@runner.local'
        }
      })

      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (d) => {
        stdout += d.toString()
      })
      child.stderr?.on('data', (d) => {
        stderr += d.toString()
      })
      child.on('close', (code) => {
        resolve({ stdout, stderr, exitCode: code ?? 0 })
      })
      child.on('error', (err) => {
        resolve({ stdout, stderr: err.message, exitCode: 1 })
      })
    })
  }

  // Initialize git repo
  await runGit(['init'])
  await runGit(['config', 'user.name', 'Test Runner'])
  await runGit(['config', 'user.email', 'test@runner.local'])

  return { rootPath, cleanup: dirCleanup, runGit }
}

export const electronHarness = createElectronHarness()

