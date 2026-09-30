export interface FileEntry {
  name: string
  path: string
  isDirectory: boolean
  children?: FileEntry[]
  size?: number
  mtimeMs?: number
}

export interface ReadFileResult {
  success: boolean
  content?: string
  error?: string
}

export interface WriteFileResult {
  success: boolean
  error?: string
}

export interface OpenDirectoryResult {
  success: boolean
  rootPath?: string
  tree?: FileEntry[]
  error?: string
  canceled?: boolean
}

export interface ListFilesOptions {
  maxDepth?: number
  relativePath?: string
}

export interface ListFilesResult {
  success: boolean
  treeString?: string
  totalFiles?: number
  totalDirs?: number
  error?: string
}

export interface ReadWorkspaceFileResult {
  success: boolean
  path?: string
  content?: string
  error?: string
}

export interface CreateWorkspaceFileResult {
  success: boolean
  path?: string
  error?: string
}

export interface EditWorkspaceFileResult {
  success: boolean
  path?: string
  error?: string
}

export interface RunCommandResult {
  success: boolean
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
  error?: string
}

export interface GitStatusResult {
  success: boolean
  isRepository: boolean
  branch: string | null
  staged: string[]
  unstaged: string[]
  untracked: string[]
  conflicted: string[]
  clean?: boolean
  error?: string
}

export interface GitDiffResult {
  success: boolean
  isRepository: boolean
  unstagedDiff: string
  stagedDiff: string
  truncated?: boolean
  error?: string
}

export interface GitCommitInfo {
  hash: string
  author: string
  date: string
  message: string
}

export interface GitLogResult {
  success: boolean
  isRepository: boolean
  commits: GitCommitInfo[]
  error?: string
}

export interface AppSettings {
  openRouterApiKey?: string
  geminiApiKey?: string
  nvidiaApiKey?: string
  nvidiaModelId?: string
  opencodeApiKey?: string
  opencodeModelId?: string
  selectedProvider?: 'gemini' | 'openrouter' | 'nvidia' | 'opencode'
  lastWorkspaceRoot?: string
}

export interface NvidiaChatCompletionRequest {
  model: string
  messages: Array<{
    role: string
    content: string | null
    tool_calls?: Array<{
      id: string
      type: 'function'
      function: {
        name: string
        arguments: string
      }
    }>
    tool_call_id?: string
    name?: string
  }>
  temperature?: number
  tools?: Array<{
    type: 'function'
    function: {
      name: string
      description: string
      parameters?: Record<string, unknown>
    }
  }>
  tool_choice?: 'auto' | 'none'
  apiKey?: string
  timeoutMs?: number
  requestId?: string
}

export interface NvidiaChatCompletionResponse {
  success: boolean
  data?: {
    choices?: Array<{
      message?: {
        role: string
        content?: string | null
        tool_calls?: Array<{
          id: string
          type: 'function'
          function: {
            name: string
            arguments: string
          }
        }>
      }
    }>
  }
  status?: number
  statusText?: string
  error?: string
  errorDetails?: string
  isNetworkError?: boolean
  stage?: string
  retryAfter?: string | number | null
}

export interface NvidiaModelItem {
  id: string
  created?: number
  owned_by?: string
  object?: string
  permission?: unknown[]
  root?: string
  parent?: string | null
}

export interface NvidiaListModelsRequest {
  apiKey?: string
  timeoutMs?: number
}

export interface NvidiaListModelsResponse {
  success: boolean
  models?: NvidiaModelItem[]
  status?: number
  statusText?: string
  error?: string
  errorDetails?: string
  isNetworkError?: boolean
}

export interface OpenCodeChatCompletionRequest {
  model: string
  messages: Array<{
    role: string
    content: string | null
    tool_calls?: Array<{
      id: string
      type: 'function'
      function: {
        name: string
        arguments: string
      }
    }>
    tool_call_id?: string
    name?: string
  }>
  temperature?: number
  tools?: Array<{
    type: 'function'
    function: {
      name: string
      description: string
      parameters?: Record<string, unknown>
    }
  }>
  tool_choice?: 'auto' | 'none'
  apiKey?: string
  timeoutMs?: number
  stream?: boolean
  requestId?: string
}

export interface OpenCodeChatCompletionResponse {
  success: boolean
  data?: {
    choices?: Array<{
      message?: {
        role: string
        content?: string | null
        tool_calls?: Array<{
          id: string
          type: 'function'
          function: {
            name: string
            arguments: string
          }
        }>
      }
    }>
  }
  status?: number
  statusText?: string
  error?: string
  errorDetails?: string
  isNetworkError?: boolean
  retryAfter?: string | number | null
}

export interface OpenCodeModelItem {
  id: string
  created?: number
  owned_by?: string
  object?: string
  isFree?: boolean
}

export interface OpenCodeListModelsRequest {
  apiKey?: string
  timeoutMs?: number
}

export interface OpenCodeListModelsResponse {
  success: boolean
  models?: OpenCodeModelItem[]
  status?: number
  statusText?: string
  error?: string
  errorDetails?: string
  isNetworkError?: boolean
}

export interface OpenCodeStreamChunkEvent {
  requestId: string
  chunk?: string
  done?: boolean
  error?: string
}

export type WorkspaceFileChangeType = 'add' | 'change' | 'unlink'

export interface WorkspaceFileChangeEvent {
  workspaceRoot: string
  relativePath: string
  eventType: WorkspaceFileChangeType
}

export interface IElectronAPI {
  openDirectory: () => Promise<OpenDirectoryResult>
  readTree: (rootPath: string) => Promise<OpenDirectoryResult>
  getLastWorkspace: () => Promise<OpenDirectoryResult>
  readFile: (filePath: string) => Promise<ReadFileResult>
  readWorkspaceFile: (rootPath: string, relativePath: string) => Promise<ReadWorkspaceFileResult>
  createWorkspaceFile: (
    rootPath: string,
    relativePath: string,
    content: string
  ) => Promise<CreateWorkspaceFileResult>
  editWorkspaceFile: (
    rootPath: string,
    relativePath: string,
    newContent: string,
    expectedOldContent?: string
  ) => Promise<EditWorkspaceFileResult>
  writeFile: (filePath: string, content: string) => Promise<WriteFileResult>
  listFiles: (rootPath: string, options?: ListFilesOptions) => Promise<ListFilesResult>
  watchWorkspace: (rootPath: string) => Promise<{ success: boolean; error?: string }>
  unwatchWorkspace: () => Promise<{ success: boolean }>
  onWorkspaceFileChanged: (callback: (event: WorkspaceFileChangeEvent) => void) => () => void
  runCommand: (
    command: string,
    cwd?: string,
    timeoutMs?: number
  ) => Promise<RunCommandResult>
  stopCommand: () => Promise<{ success: boolean }>
  gitStatus: (rootPath: string) => Promise<GitStatusResult>
  gitDiff: (rootPath: string) => Promise<GitDiffResult>
  gitLog: (rootPath: string, maxCount?: number) => Promise<GitLogResult>
  getEnvApiKey: (provider?: string) => Promise<string | null>
  getSettings: () => Promise<AppSettings>
  saveSettings: (settings: Partial<AppSettings>) => Promise<{ success: boolean; error?: string }>
  nvidiaChatCompletion: (
    request: NvidiaChatCompletionRequest
  ) => Promise<NvidiaChatCompletionResponse>
  nvidiaListModels: (
    request?: NvidiaListModelsRequest
  ) => Promise<NvidiaListModelsResponse>
  opencodeChatCompletion: (
    request: OpenCodeChatCompletionRequest
  ) => Promise<OpenCodeChatCompletionResponse>
  opencodeListModels: (
    request?: OpenCodeListModelsRequest
  ) => Promise<OpenCodeListModelsResponse>
  onOpenCodeStreamChunk: (
    callback: (event: OpenCodeStreamChunkEvent) => void
  ) => () => void
  cancelChatCompletion: (
    requestId: string
  ) => Promise<{ success: boolean; canceled?: boolean }>
  saveWorkspaceIndex: (
    workspaceRoot: string,
    data: unknown
  ) => Promise<SaveWorkspaceIndexResult>
  loadWorkspaceIndex: (
    workspaceRoot: string
  ) => Promise<LoadWorkspaceIndexResult>
  clearWorkspaceIndex: (
    workspaceRoot: string
  ) => Promise<ClearWorkspaceIndexResult>
}

export interface SaveWorkspaceIndexResult {
  success: boolean
  error?: string
}

export interface LoadWorkspaceIndexResult {
  success: boolean
  data?: unknown
  error?: string
}

export interface ClearWorkspaceIndexResult {
  success: boolean
  error?: string
}

export const IPC_CHANNELS = {
  OPEN_DIRECTORY: 'dialog:openDirectory',
  READ_TREE: 'fs:readTree',
  GET_LAST_WORKSPACE: 'workspace:getLast',
  READ_FILE: 'fs:readFile',
  READ_WORKSPACE_FILE: 'fs:readWorkspaceFile',
  CREATE_WORKSPACE_FILE: 'fs:createWorkspaceFile',
  EDIT_WORKSPACE_FILE: 'fs:editWorkspaceFile',
  WRITE_FILE: 'fs:writeFile',
  LIST_FILES: 'fs:listFiles',
  WATCH_WORKSPACE: 'fs:watchWorkspace',
  UNWATCH_WORKSPACE: 'fs:unwatchWorkspace',
  ON_WORKSPACE_FILE_CHANGED: 'fs:onWorkspaceFileChanged',
  SAVE_WORKSPACE_INDEX: 'index:save',
  LOAD_WORKSPACE_INDEX: 'index:load',
  CLEAR_WORKSPACE_INDEX: 'index:clear',
  RUN_COMMAND: 'command:run',
  STOP_COMMAND: 'command:stop',
  GIT_STATUS: 'git:status',
  GIT_DIFF: 'git:diff',
  GIT_LOG: 'git:log',
  GET_ENV_API_KEY: 'env:getApiKey',
  GET_SETTINGS: 'settings:get',
  SAVE_SETTINGS: 'settings:save',
  NVIDIA_CHAT_COMPLETION: 'ai:nvidiaChatCompletion',
  NVIDIA_LIST_MODELS: 'ai:nvidiaListModels',
  OPENCODE_CHAT_COMPLETION: 'ai:opencodeChatCompletion',
  OPENCODE_LIST_MODELS: 'ai:opencodeListModels',
  OPENCODE_STREAM_CHUNK: 'ai:opencodeStreamChunk',
  CANCEL_CHAT_COMPLETION: 'ai:cancelChatCompletion'
} as const
