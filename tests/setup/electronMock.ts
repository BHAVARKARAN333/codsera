/**
 * Reusable, typed Electron API Mock Fixture
 * 
 * Provides safe mock implementations for `window.electronAPI` conforming strictly to `IElectronAPI`.
 * Safe for use in Node or DOM test environments without launching Electron or making external network requests.
 */

import type {
  IElectronAPI,
  OpenDirectoryResult,
  ReadFileResult,
  ReadWorkspaceFileResult,
  CreateWorkspaceFileResult,
  EditWorkspaceFileResult,
  WriteFileResult,
  CreateFileResult,
  CreateDirectoryResult,
  RenamePathResult,
  DeletePathResult,
  DeletePathOptions,
  ListFilesResult,
  ListFilesOptions,
  WorkspaceFileChangeEvent,
  RunCommandResult,
  TerminalSpawnOptions,
  TerminalSpawnResult,
  TerminalWriteInputResult,
  TerminalKillResult,
  TerminalKillAllResult,
  TerminalResizeResult,
  TerminalListSessionsResult,
  TerminalStreamDataEvent,
  TerminalSessionExitEvent,
  GitStatusResult,
  GitDiffResult,
  GitLogResult,
  GitStageResult,
  GitUnstageResult,
  GitStageAllResult,
  GitUnstageAllResult,
  GitCommitResult,
  GitBranchListResult,
  GitBranchCreateResult,
  GitBranchCheckoutResult,
  GitFileDiffResult,
  GitDiscardFileResult,
  AppSettings,
  NvidiaChatCompletionRequest,
  NvidiaChatCompletionResponse,
  NvidiaListModelsRequest,
  NvidiaListModelsResponse,
  OpenCodeChatCompletionRequest,
  OpenCodeChatCompletionResponse,
  OpenCodeListModelsRequest,
  OpenCodeListModelsResponse,
  OpenCodeStreamChunkEvent,
  SaveWorkspaceIndexResult,
  LoadWorkspaceIndexResult,
  ClearWorkspaceIndexResult
} from '@shared/types'

export function createMockElectronAPI(overrides: Partial<IElectronAPI> = {}): IElectronAPI {
  const defaultApi: IElectronAPI = {
    // Directory & Workspace
    openDirectory: async (): Promise<OpenDirectoryResult> => ({
      success: true,
      rootPath: '/mock/workspace',
      tree: []
    }),
    readTree: async (rootPath: string): Promise<OpenDirectoryResult> => ({
      success: true,
      rootPath,
      tree: []
    }),
    getLastWorkspace: async (): Promise<OpenDirectoryResult> => ({
      success: true,
      rootPath: undefined,
      tree: []
    }),

    // File Operations
    readFile: async (_filePath: string): Promise<ReadFileResult> => ({
      success: true,
      content: ''
    }),
    readWorkspaceFile: async (_rootPath: string, relativePath: string): Promise<ReadWorkspaceFileResult> => ({
      success: true,
      path: relativePath,
      content: ''
    }),
    createWorkspaceFile: async (_rootPath: string, relativePath: string): Promise<CreateWorkspaceFileResult> => ({
      success: true,
      path: relativePath
    }),
    editWorkspaceFile: async (_rootPath: string, relativePath: string): Promise<EditWorkspaceFileResult> => ({
      success: true,
      path: relativePath
    }),
    writeFile: async (_filePath: string): Promise<WriteFileResult> => ({
      success: true
    }),
    createFile: async (_workspaceRoot: string, relativePath: string): Promise<CreateFileResult> => ({
      success: true,
      path: relativePath
    }),
    createDirectory: async (_workspaceRoot: string, relativePath: string): Promise<CreateDirectoryResult> => ({
      success: true,
      path: relativePath
    }),
    renamePath: async (_workspaceRoot: string, _oldPath: string, newPath: string): Promise<RenamePathResult> => ({
      success: true,
      newPath
    }),
    deletePath: async (_workspaceRoot: string, relativePath: string, _options?: DeletePathOptions): Promise<DeletePathResult> => ({
      success: true,
      path: relativePath
    }),
    listFiles: async (_rootPath: string, _options?: ListFilesOptions): Promise<ListFilesResult> => ({
      success: true,
      treeString: '',
      totalFiles: 0,
      totalDirs: 0
    }),
    watchWorkspace: async (_rootPath: string): Promise<{ success: boolean; error?: string }> => ({
      success: true
    }),
    unwatchWorkspace: async (): Promise<{ success: boolean }> => ({
      success: true
    }),
    onWorkspaceFileChanged: (_callback: (event: WorkspaceFileChangeEvent) => void) => () => {},

    // Command Execution & Terminal
    runCommand: async (
      _command: string,
      _cwd?: string,
      _timeoutMs?: number
    ): Promise<RunCommandResult> => ({
      success: true,
      stdout: '',
      stderr: '',
      exitCode: 0,
      timedOut: false
    }),
    stopCommand: async (_sessionId?: string): Promise<{ success: boolean; error?: string }> => ({
      success: true
    }),
    terminalSpawn: async (_options: TerminalSpawnOptions): Promise<TerminalSpawnResult> => ({
      success: true,
      sessionId: 'mock-session-1',
      pid: 1234
    }),
    terminalWriteInput: async (_sessionId: string, _inputData: string): Promise<TerminalWriteInputResult> => ({
      success: true
    }),
    terminalKill: async (_sessionId: string): Promise<TerminalKillResult> => ({
      success: true
    }),
    terminalKillAll: async (): Promise<TerminalKillAllResult> => ({
      success: true,
      killedCount: 0
    }),
    terminalResize: async (
      _sessionId: string,
      _cols: number,
      _rows: number
    ): Promise<TerminalResizeResult> => ({
      success: true,
      cols: _cols,
      rows: _rows
    }),
    terminalListSessions: async (): Promise<TerminalListSessionsResult> => ({
      success: true,
      sessions: []
    }),
    onTerminalStreamData: (_callback: (event: TerminalStreamDataEvent) => void) => () => {},
    onTerminalSessionExit: (_callback: (event: TerminalSessionExitEvent) => void) => () => {},

    // Git Operations
    gitStatus: async (_rootPath: string): Promise<GitStatusResult> => ({
      success: true,
      isRepository: true,
      branch: 'main',
      clean: true,
      files: [],
      staged: [],
      unstaged: [],
      untracked: [],
      conflicted: []
    }),
    gitDiff: async (_rootPath: string): Promise<GitDiffResult> => ({
      success: true,
      isRepository: true,
      unstagedDiff: '',
      stagedDiff: ''
    }),
    gitLog: async (_rootPath: string, _maxCount?: number): Promise<GitLogResult> => ({
      success: true,
      isRepository: true,
      commits: []
    }),
    gitStageFile: async (_workspaceRoot: string, _relativePath: string): Promise<GitStageResult> => ({
      success: true
    }),
    gitUnstageFile: async (_workspaceRoot: string, _relativePath: string): Promise<GitUnstageResult> => ({
      success: true
    }),
    gitStageAll: async (_workspaceRoot: string): Promise<GitStageAllResult> => ({
      success: true
    }),
    gitUnstageAll: async (_workspaceRoot: string): Promise<GitUnstageAllResult> => ({
      success: true
    }),
    gitCommit: async (_workspaceRoot: string, _message: string): Promise<GitCommitResult> => ({
      success: true,
      commitHash: 'mock1234567890'
    }),
    gitBranchList: async (_workspaceRoot: string): Promise<GitBranchListResult> => ({
      success: true,
      isRepository: true,
      currentBranch: 'main',
      branches: ['main']
    }),
    gitBranchCreate: async (_workspaceRoot: string, branchName: string): Promise<GitBranchCreateResult> => ({
      success: true,
      branch: branchName
    }),
    gitBranchCheckout: async (_workspaceRoot: string, branchName: string): Promise<GitBranchCheckoutResult> => ({
      success: true,
      branch: branchName
    }),
    gitFileDiff: async (_workspaceRoot: string, relativePath: string): Promise<GitFileDiffResult> => ({
      success: true,
      isRepository: true,
      path: relativePath,
      unstagedDiff: '',
      stagedDiff: ''
    }),
    gitDiscardFile: async (_workspaceRoot: string, relativePath: string): Promise<GitDiscardFileResult> => ({
      success: true,
      path: relativePath
    }),

    // Settings & Keys
    getEnvApiKey: async (_provider?: string): Promise<string | null> => null,
    getSettings: async (): Promise<AppSettings> => ({
      selectedProvider: 'gemini'
    }),
    saveSettings: async (_settings: Partial<AppSettings>): Promise<{ success: boolean; error?: string }> => ({
      success: true
    }),

    // AI Provider Mock Endpoints (Safe, Mocked, Offline)
    nvidiaChatCompletion: async (
      _request: NvidiaChatCompletionRequest
    ): Promise<NvidiaChatCompletionResponse> => ({
      success: true,
      data: {
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'Mock Nvidia response'
            }
          }
        ]
      }
    }),
    nvidiaListModels: async (
      _request?: NvidiaListModelsRequest
    ): Promise<NvidiaListModelsResponse> => ({
      success: true,
      models: []
    }),
    opencodeChatCompletion: async (
      _request: OpenCodeChatCompletionRequest
    ): Promise<OpenCodeChatCompletionResponse> => ({
      success: true,
      data: {
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'Mock OpenCode response'
            }
          }
        ]
      }
    }),
    opencodeListModels: async (
      _request?: OpenCodeListModelsRequest
    ): Promise<OpenCodeListModelsResponse> => ({
      success: true,
      models: []
    }),
    onOpenCodeStreamChunk: (
      _callback: (event: OpenCodeStreamChunkEvent) => void
    ) => () => {},
    cancelChatCompletion: async (
      _requestId: string
    ): Promise<{ success: boolean; canceled?: boolean }> => ({
      success: true,
      canceled: true
    }),

    // Smart Context Persistent Index
    saveWorkspaceIndex: async (
      _workspaceRoot: string,
      _data: unknown
    ): Promise<SaveWorkspaceIndexResult> => ({
      success: true
    }),
    loadWorkspaceIndex: async (
      _workspaceRoot: string
    ): Promise<LoadWorkspaceIndexResult> => ({
      success: true,
      data: null
    }),
    clearWorkspaceIndex: async (
      _workspaceRoot: string
    ): Promise<ClearWorkspaceIndexResult> => ({
      success: true
    })
  }

  return { ...defaultApi, ...overrides }
}

let originalWindowElectronAPI: IElectronAPI | undefined

/**
 * Injects a typed mock `electronAPI` onto the global `window` object.
 * Restorable with `resetMockElectron()`.
 */
export function setupMockElectron(overrides: Partial<IElectronAPI> = {}): IElectronAPI {
  const mockApi = createMockElectronAPI(overrides)
  const globalTarget = typeof window !== 'undefined' ? window : (globalThis as unknown as { window?: { electronAPI?: IElectronAPI } })

  if (typeof window !== 'undefined') {
    originalWindowElectronAPI = window.electronAPI
    window.electronAPI = mockApi
  } else {
    if (!globalTarget.window) {
      globalTarget.window = {} as { electronAPI?: IElectronAPI }
    }
    originalWindowElectronAPI = globalTarget.window.electronAPI
    globalTarget.window.electronAPI = mockApi
  }

  return mockApi
}

/**
 * Restores any previous `electronAPI` instance.
 */
export function resetMockElectron(): void {
  if (typeof window !== 'undefined') {
    if (originalWindowElectronAPI) {
      window.electronAPI = originalWindowElectronAPI
    } else {
      delete (window as unknown as { electronAPI?: IElectronAPI }).electronAPI
    }
  } else {
    const globalTarget = globalThis as unknown as { window?: { electronAPI?: IElectronAPI } }
    if (globalTarget.window) {
      if (originalWindowElectronAPI) {
        globalTarget.window.electronAPI = originalWindowElectronAPI
      } else {
        delete globalTarget.window.electronAPI
      }
    }
  }
  originalWindowElectronAPI = undefined
}
