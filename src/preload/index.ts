import { contextBridge, ipcRenderer } from 'electron'
import {
  AppSettings,
  IElectronAPI,
  IPC_CHANNELS,
  OpenDirectoryResult,
  ReadFileResult,
  RunCommandResult,
  WriteFileResult
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
  stopCommand: (): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke(IPC_CHANNELS.STOP_COMMAND)
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
