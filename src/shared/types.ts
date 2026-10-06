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

export interface CreateFileResult {
  success: boolean
  path?: string
  error?: string
}

export interface CreateDirectoryResult {
  success: boolean
  path?: string
  error?: string
}

export interface RenamePathResult {
  success: boolean
  oldPath?: string
  newPath?: string
  error?: string
}

export interface DeletePathOptions {
  recursive?: boolean
}

export interface DeletePathResult {
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

export type GitFileChangeStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'untracked'
  | 'conflicted'
  | 'renamed'

export interface GitFileStatus {
  path: string
  status: GitFileChangeStatus
  staged: boolean
  oldPath?: string
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
  files?: GitFileStatus[]
  error?: string
}

export interface GitStageResult {
  success: boolean
  path?: string
  error?: string
}

export interface GitUnstageResult {
  success: boolean
  path?: string
  error?: string
}

export interface GitStageAllResult {
  success: boolean
  error?: string
}

export interface GitUnstageAllResult {
  success: boolean
  error?: string
}

export interface GitCommitResult {
  success: boolean
  commitHash?: string
  summary?: string
  error?: string
}

export interface GitBranchInfo {
  name: string
  isCurrent: boolean
}

export interface GitBranchListResult {
  success: boolean
  isRepository: boolean
  currentBranch: string | null
  branches: string[]
  error?: string
}

export interface GitBranchCreateResult {
  success: boolean
  branch?: string
  error?: string
}

export interface GitBranchCheckoutResult {
  success: boolean
  branch?: string
  error?: string
}

export interface GitFileDiffResult {
  success: boolean
  isRepository: boolean
  path: string
  unstagedDiff: string
  stagedDiff: string
  isBinary?: boolean
  truncated?: boolean
  error?: string
}

export interface GitDiscardFileResult {
  success: boolean
  path?: string
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
  isDirectory?: boolean
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
  createFile: (
    workspaceRoot: string,
    relativePath: string,
    initialContent?: string
  ) => Promise<CreateFileResult>
  createDirectory: (
    workspaceRoot: string,
    relativePath: string
  ) => Promise<CreateDirectoryResult>
  renamePath: (
    workspaceRoot: string,
    oldRelativePath: string,
    newRelativePath: string
  ) => Promise<RenamePathResult>
  deletePath: (
    workspaceRoot: string,
    relativePath: string,
    options?: DeletePathOptions
  ) => Promise<DeletePathResult>
  listFiles: (rootPath: string, options?: ListFilesOptions) => Promise<ListFilesResult>
  watchWorkspace: (rootPath: string) => Promise<{ success: boolean; error?: string }>
  unwatchWorkspace: () => Promise<{ success: boolean }>
  onWorkspaceFileChanged: (callback: (event: WorkspaceFileChangeEvent) => void) => () => void
  runCommand: (
    command: string,
    cwd?: string,
    timeoutMs?: number
  ) => Promise<RunCommandResult>
  stopCommand: (sessionId?: string) => Promise<{ success: boolean; error?: string }>
  terminalSpawn?: (options: TerminalSpawnOptions) => Promise<TerminalSpawnResult>
  terminalWriteInput?: (sessionId: string, inputData: string) => Promise<TerminalWriteInputResult>
  terminalResize?: (sessionId: string, cols: number, rows: number) => Promise<TerminalResizeResult>
  terminalSendSignal?: (
    sessionId: string,
    signal?: 'SIGINT' | 'SIGTERM'
  ) => Promise<{ success: boolean; error?: string }>
  terminalKill?: (sessionId: string) => Promise<TerminalKillResult>
  terminalKillAll?: () => Promise<TerminalKillAllResult>
  terminalListSessions?: () => Promise<TerminalListSessionsResult>
  onTerminalStreamData?: (callback: (event: TerminalStreamDataEvent) => void) => () => void
  onTerminalSessionExit?: (callback: (event: TerminalSessionExitEvent) => void) => () => void
  gitStatus: (rootPath: string) => Promise<GitStatusResult>
  gitDiff: (rootPath: string) => Promise<GitDiffResult>
  gitLog: (rootPath: string, maxCount?: number) => Promise<GitLogResult>
  gitStageFile: (workspaceRoot: string, relativePath: string) => Promise<GitStageResult>
  gitUnstageFile: (workspaceRoot: string, relativePath: string) => Promise<GitUnstageResult>
  gitStageAll: (workspaceRoot: string) => Promise<GitStageAllResult>
  gitUnstageAll: (workspaceRoot: string) => Promise<GitUnstageAllResult>
  gitCommit: (workspaceRoot: string, message: string) => Promise<GitCommitResult>
  gitBranchList: (workspaceRoot: string) => Promise<GitBranchListResult>
  gitBranchCreate: (workspaceRoot: string, branchName: string) => Promise<GitBranchCreateResult>
  gitBranchCheckout: (workspaceRoot: string, branchName: string) => Promise<GitBranchCheckoutResult>
  gitFileDiff: (workspaceRoot: string, relativePath: string) => Promise<GitFileDiffResult>
  gitDiscardFile: (workspaceRoot: string, relativePath: string) => Promise<GitDiscardFileResult>
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

export type TerminalSessionSource = 'user' | 'ai' | 'transient'
export type TerminalSessionStatus = 'running' | 'completed' | 'terminated' | 'timedOut' | 'failed'

export interface TerminalSpawnOptions {
  command?: string
  shell?: string
  shellArgs?: string[]
  cols?: number
  rows?: number
  cwd?: string
  workspaceRoot?: string
  sessionId?: string
  source?: TerminalSessionSource
  timeoutMs?: number
  maxBuffer?: number
  interactive?: boolean
  env?: Record<string, string>
}

export interface TerminalSpawnResult {
  success: boolean
  sessionId?: string
  pid?: number
  cols?: number
  rows?: number
  shell?: string
  error?: string
}

export interface TerminalResizeResult {
  success: boolean
  cols?: number
  rows?: number
  error?: string
}

export interface TerminalWriteInputResult {
  success: boolean
  error?: string
}

export interface TerminalKillResult {
  success: boolean
  error?: string
  message?: string
}

export interface TerminalKillAllResult {
  success: boolean
  killedCount: number
  error?: string
}

export interface TerminalSessionInfo {
  sessionId: string
  command: string
  cwd: string
  source: TerminalSessionSource
  status: TerminalSessionStatus
  running: boolean
  exitCode: number | null
  timedOut: boolean
  createdAt: number
  pid?: number
}

export interface TerminalListSessionsResult {
  success: boolean
  sessions: TerminalSessionInfo[]
  error?: string
}

export interface TerminalStreamDataEvent {
  sessionId: string
  type: 'stdout' | 'stderr'
  data: string
}

export interface TerminalSessionExitEvent {
  sessionId: string
  exitCode: number | null
  signal?: string | null
  timedOut: boolean
  error?: string
  stdout?: string
  stderr?: string
}

export type TerminalTabStatus = 'idle' | 'running' | 'completed' | 'failed' | 'stopped'

export interface TerminalEntryData {
  id: string
  sessionId?: string
  command: string
  cwd: string
  stdout: string
  stderr: string
  exitCode: number | null
  running: boolean
  timedOut?: boolean
  error?: string
  timestamp: number
  source: 'user' | 'ai'
}

export interface TerminalTab {
  id: string
  title: string
  cwd: string
  entries: TerminalEntryData[]
  commandHistory: string[]
  inputBuffer: string
  isRunning: boolean
  activeProcessSessionId: string | null
  lastExitCode: number | null
  status: TerminalTabStatus
  createdAt: number
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
  FS_CREATE_FILE: 'fs:createFile',
  FS_CREATE_DIRECTORY: 'fs:createDirectory',
  FS_RENAME_PATH: 'fs:renamePath',
  FS_DELETE_PATH: 'fs:deletePath',
  LIST_FILES: 'fs:listFiles',
  WATCH_WORKSPACE: 'fs:watchWorkspace',
  UNWATCH_WORKSPACE: 'fs:unwatchWorkspace',
  ON_WORKSPACE_FILE_CHANGED: 'fs:onWorkspaceFileChanged',
  SAVE_WORKSPACE_INDEX: 'index:save',
  LOAD_WORKSPACE_INDEX: 'index:load',
  CLEAR_WORKSPACE_INDEX: 'index:clear',
  RUN_COMMAND: 'command:run',
  STOP_COMMAND: 'command:stop',
  TERMINAL_SPAWN: 'terminal:spawn',
  TERMINAL_WRITE_INPUT: 'terminal:writeInput',
  TERMINAL_RESIZE: 'terminal:resize',
  TERMINAL_KILL: 'terminal:kill',
  TERMINAL_KILL_ALL: 'terminal:killAll',
  TERMINAL_LIST_SESSIONS: 'terminal:listSessions',
  TERMINAL_STREAM_DATA: 'terminal:streamData',
  TERMINAL_SESSION_EXIT: 'terminal:sessionExit',
  GIT_STATUS: 'git:status',
  GIT_DIFF: 'git:diff',
  GIT_LOG: 'git:log',
  GIT_STAGE_FILE: 'git:stageFile',
  GIT_UNSTAGE_FILE: 'git:unstageFile',
  GIT_STAGE_ALL: 'git:stageAll',
  GIT_UNSTAGE_ALL: 'git:unstageAll',
  GIT_COMMIT: 'git:commit',
  GIT_BRANCH_LIST: 'git:branchList',
  GIT_BRANCH_CREATE: 'git:branchCreate',
  GIT_BRANCH_CHECKOUT: 'git:branchCheckout',
  GIT_FILE_DIFF: 'git:fileDiff',
  GIT_DISCARD_FILE: 'git:discardFile',
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
