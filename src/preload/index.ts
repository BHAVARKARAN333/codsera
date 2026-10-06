import { contextBridge, ipcRenderer } from 'electron'
import {
  AppSettings,
  CreateDirectoryResult,
  CreateFileResult,
  DeletePathOptions,
  DeletePathResult,
  IElectronAPI,
  IPC_CHANNELS,
  OpenDirectoryResult,
  ReadFileResult,
  RenamePathResult,
  RunCommandResult,
  WriteFileResult,
  TerminalSpawnOptions,
  TerminalSpawnResult,
  TerminalWriteInputResult,
  TerminalKillResult,
  TerminalKillAllResult,
  TerminalListSessionsResult,
  TerminalStreamDataEvent,
  TerminalSessionExitEvent
} from '../shared/types'

const api: IElectronAPI = {
  openDirectory: (): Promise<OpenDirectoryResult> => {
    return ipcRenderer.invoke(IPC_CHANNELS.OPEN_DIRECTORY)
  },
  readTree: (rootPath: string): Promise<OpenDirectoryResult> => {
    return ipcRenderer.invoke(IPC_CHANNELS.READ_TREE, rootPath)
  },
  getLastWorkspace: (): Promise<OpenDirectoryResult> => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_LAST_WORKSPACE)
  },
  readFile: (filePath: string): Promise<ReadFileResult> => {
    return ipcRenderer.invoke(IPC_CHANNELS.READ_FILE, filePath)
  },
  readWorkspaceFile: (rootPath: string, relativePath: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.READ_WORKSPACE_FILE, rootPath, relativePath)
  },
  createWorkspaceFile: (rootPath: string, relativePath: string, content: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.CREATE_WORKSPACE_FILE, rootPath, relativePath, content)
  },
  editWorkspaceFile: (
    rootPath: string,
    relativePath: string,
    newContent: string,
    expectedOldContent?: string
  ) => {
    return ipcRenderer.invoke(
      IPC_CHANNELS.EDIT_WORKSPACE_FILE,
      rootPath,
      relativePath,
      newContent,
      expectedOldContent
    )
  },
  writeFile: (filePath: string, content: string): Promise<WriteFileResult> => {
    return ipcRenderer.invoke(IPC_CHANNELS.WRITE_FILE, filePath, content)
  },
  createFile: (
    workspaceRoot: string,
    relativePath: string,
    initialContent?: string
  ): Promise<CreateFileResult> => {
    return ipcRenderer.invoke(
      IPC_CHANNELS.FS_CREATE_FILE,
      workspaceRoot,
      relativePath,
      initialContent
    )
  },
  createDirectory: (
    workspaceRoot: string,
    relativePath: string
  ): Promise<CreateDirectoryResult> => {
    return ipcRenderer.invoke(IPC_CHANNELS.FS_CREATE_DIRECTORY, workspaceRoot, relativePath)
  },
  renamePath: (
    workspaceRoot: string,
    oldRelativePath: string,
    newRelativePath: string
  ): Promise<RenamePathResult> => {
    return ipcRenderer.invoke(
      IPC_CHANNELS.FS_RENAME_PATH,
      workspaceRoot,
      oldRelativePath,
      newRelativePath
    )
  },
  deletePath: (
    workspaceRoot: string,
    relativePath: string,
    options?: DeletePathOptions
  ): Promise<DeletePathResult> => {
    return ipcRenderer.invoke(IPC_CHANNELS.FS_DELETE_PATH, workspaceRoot, relativePath, options)
  },
  listFiles: (rootPath, options) => {
    return ipcRenderer.invoke(IPC_CHANNELS.LIST_FILES, rootPath, options)
  },
  watchWorkspace: (rootPath: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.WATCH_WORKSPACE, rootPath)
  },
  unwatchWorkspace: () => {
    return ipcRenderer.invoke(IPC_CHANNELS.UNWATCH_WORKSPACE)
  },
  onWorkspaceFileChanged: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: import('../shared/types').WorkspaceFileChangeEvent
    ) => {
      callback(data)
    }
    ipcRenderer.on(IPC_CHANNELS.ON_WORKSPACE_FILE_CHANGED, listener)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.ON_WORKSPACE_FILE_CHANGED, listener)
    }
  },
  runCommand: (command: string, cwd?: string, timeoutMs?: number): Promise<RunCommandResult> => {
    return ipcRenderer.invoke(IPC_CHANNELS.RUN_COMMAND, command, cwd, timeoutMs)
  },
  stopCommand: (sessionId?: string): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke(IPC_CHANNELS.STOP_COMMAND, sessionId)
  },
  terminalSpawn: (options: TerminalSpawnOptions): Promise<TerminalSpawnResult> => {
    return ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_SPAWN, options)
  },
  terminalWriteInput: (sessionId: string, inputData: string): Promise<TerminalWriteInputResult> => {
    return ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_WRITE_INPUT, sessionId, inputData)
  },
  terminalResize: (
    sessionId: string,
    cols: number,
    rows: number
  ): Promise<import('../shared/types').TerminalResizeResult> => {
    return ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_RESIZE, sessionId, cols, rows)
  },
  terminalSendSignal: (
    sessionId: string,
    signal?: 'SIGINT' | 'SIGTERM'
  ): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_WRITE_INPUT, sessionId, signal === 'SIGTERM' ? '\x1a' : '\x03')
  },
  terminalKill: (sessionId: string): Promise<TerminalKillResult> => {
    return ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_KILL, sessionId)
  },
  terminalKillAll: (): Promise<TerminalKillAllResult> => {
    return ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_KILL_ALL)
  },
  terminalListSessions: (): Promise<TerminalListSessionsResult> => {
    return ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_LIST_SESSIONS)
  },
  onTerminalStreamData: (callback: (event: TerminalStreamDataEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: TerminalStreamDataEvent) => {
      callback(payload)
    }
    ipcRenderer.on(IPC_CHANNELS.TERMINAL_STREAM_DATA, listener)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.TERMINAL_STREAM_DATA, listener)
    }
  },
  onTerminalSessionExit: (callback: (event: TerminalSessionExitEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: TerminalSessionExitEvent) => {
      callback(payload)
    }
    ipcRenderer.on(IPC_CHANNELS.TERMINAL_SESSION_EXIT, listener)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.TERMINAL_SESSION_EXIT, listener)
    }
  },
  gitStatus: (rootPath: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.GIT_STATUS, rootPath)
  },
  gitDiff: (rootPath: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.GIT_DIFF, rootPath)
  },
  gitLog: (rootPath: string, maxCount?: number) => {
    return ipcRenderer.invoke(IPC_CHANNELS.GIT_LOG, rootPath, maxCount)
  },
  gitStageFile: (workspaceRoot: string, relativePath: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.GIT_STAGE_FILE, workspaceRoot, relativePath)
  },
  gitUnstageFile: (workspaceRoot: string, relativePath: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.GIT_UNSTAGE_FILE, workspaceRoot, relativePath)
  },
  gitStageAll: (workspaceRoot: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.GIT_STAGE_ALL, workspaceRoot)
  },
  gitUnstageAll: (workspaceRoot: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.GIT_UNSTAGE_ALL, workspaceRoot)
  },
  gitCommit: (workspaceRoot: string, message: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.GIT_COMMIT, workspaceRoot, message)
  },
  gitBranchList: (workspaceRoot: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.GIT_BRANCH_LIST, workspaceRoot)
  },
  gitBranchCreate: (workspaceRoot: string, branchName: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.GIT_BRANCH_CREATE, workspaceRoot, branchName)
  },
  gitBranchCheckout: (workspaceRoot: string, branchName: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.GIT_BRANCH_CHECKOUT, workspaceRoot, branchName)
  },
  gitFileDiff: (workspaceRoot: string, relativePath: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.GIT_FILE_DIFF, workspaceRoot, relativePath)
  },
  gitDiscardFile: (workspaceRoot: string, relativePath: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.GIT_DISCARD_FILE, workspaceRoot, relativePath)
  },
  getEnvApiKey: (provider?: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_ENV_API_KEY, provider)
  },
  getSettings: (): Promise<AppSettings> => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_SETTINGS)
  },
  saveSettings: (settings: Partial<AppSettings>) => {
    return ipcRenderer.invoke(IPC_CHANNELS.SAVE_SETTINGS, settings)
  },
  nvidiaChatCompletion: (request) => {
    return ipcRenderer.invoke(IPC_CHANNELS.NVIDIA_CHAT_COMPLETION, request)
  },
  nvidiaListModels: (request) => {
    return ipcRenderer.invoke(IPC_CHANNELS.NVIDIA_LIST_MODELS, request)
  },
  opencodeChatCompletion: (request) => {
    return ipcRenderer.invoke(IPC_CHANNELS.OPENCODE_CHAT_COMPLETION, request)
  },
  opencodeListModels: (request) => {
    return ipcRenderer.invoke(IPC_CHANNELS.OPENCODE_LIST_MODELS, request)
  },
  onOpenCodeStreamChunk: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: import('../shared/types').OpenCodeStreamChunkEvent
    ) => {
      callback(data)
    }
    ipcRenderer.on(IPC_CHANNELS.OPENCODE_STREAM_CHUNK, listener)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.OPENCODE_STREAM_CHUNK, listener)
    }
  },
  cancelChatCompletion: (requestId: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.CANCEL_CHAT_COMPLETION, requestId)
  },
  saveWorkspaceIndex: (workspaceRoot: string, data: unknown) => {
    return ipcRenderer.invoke(IPC_CHANNELS.SAVE_WORKSPACE_INDEX, workspaceRoot, data)
  },
  loadWorkspaceIndex: (workspaceRoot: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.LOAD_WORKSPACE_INDEX, workspaceRoot)
  },
  clearWorkspaceIndex: (workspaceRoot: string) => {
    return ipcRenderer.invoke(IPC_CHANNELS.CLEAR_WORKSPACE_INDEX, workspaceRoot)
  }
}

try {
  contextBridge.exposeInMainWorld('electronAPI', api)
} catch (error) {
  console.error('Failed to expose electronAPI via contextBridge:', error)
}

export { api }
