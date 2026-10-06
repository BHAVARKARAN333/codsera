import { app, BrowserWindow, dialog, ipcMain, shell, session } from 'electron'
import { join } from 'path'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as crypto from 'crypto'
import { watch, FSWatcher } from 'fs'
import { spawn, exec } from 'child_process'
import {
  FileEntry,
  IPC_CHANNELS,
  OpenDirectoryResult,
  ReadFileResult,
  ReadWorkspaceFileResult,
  CreateWorkspaceFileResult,
  EditWorkspaceFileResult,
  WriteFileResult,
  CreateFileResult,
  CreateDirectoryResult,
  RenamePathResult,
  DeletePathOptions,
  DeletePathResult,
  RunCommandResult,
  GitStatusResult,
  GitFileStatus,
  GitFileChangeStatus,
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
  GitDiffResult,
  GitLogResult,
  GitCommitInfo,
  AppSettings,
  WorkspaceFileChangeEvent,
  WorkspaceFileChangeType,
  SaveWorkspaceIndexResult,
  LoadWorkspaceIndexResult,
  ClearWorkspaceIndexResult,
  NvidiaChatCompletionRequest,
  NvidiaChatCompletionResponse,
  NvidiaListModelsRequest,
  NvidiaListModelsResponse,
  NvidiaModelItem,
  OpenCodeChatCompletionRequest,
  OpenCodeChatCompletionResponse,
  OpenCodeListModelsRequest,
  OpenCodeListModelsResponse,
  OpenCodeModelItem,
  TerminalSpawnOptions,
  TerminalSpawnResult,
  TerminalWriteInputResult,
  TerminalKillResult,
  TerminalKillAllResult,
  TerminalListSessionsResult,
  TerminalStreamDataEvent,
  TerminalSessionExitEvent
} from '../shared/types'
import { TerminalSessionManager } from './terminalSessionManager'
import { validateCommandSafety } from '../shared/commandValidator'
import { encryptSecret, decryptSecret, isEncryptionAvailable } from './safeStorage'
import {
  getSettingsFilePath,
  loadSettings,
  saveSettings,
  cleanupOrphanSettingsTempFiles
} from './settingsPersistence'
import {
  isSafeString,
  isSafePath,
  isSafeExternalUrl,
  clampTimeout,
  buildCspDirectives,
  isValidBranchName
} from '../shared/securityUtils'

// Ignore common non-essential folders to keep explorer performant and clean
const IGNORED_FOLDERS = new Set(['.git', 'node_modules', 'dist', 'out', '.vscode', '.idea'])

const WATCHER_IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'out',
  '.vscode',
  '.idea',
  '.cache',
  'coverage',
  '.parcel-cache',
  'scratch'
])

let currentWatcher: FSWatcher | null = null
let watchedWorkspaceRoot: string | null = null

const terminalSessionManager = new TerminalSessionManager()

// Broadcast terminal streaming chunks to all active application windows
terminalSessionManager.on('data', (evt: TerminalStreamDataEvent) => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.TERMINAL_STREAM_DATA, evt)
    }
  }
})

// Broadcast terminal session exit events to all active application windows
terminalSessionManager.on('exit', (evt: TerminalSessionExitEvent) => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.TERMINAL_SESSION_EXIT, evt)
    }
  }
})

function stopWorkspaceWatcher(): void {
  if (currentWatcher) {
    try {
      currentWatcher.close()
    } catch (err) {
      console.error('[Watcher] Error closing watcher:', err)
    }
    currentWatcher = null
    watchedWorkspaceRoot = null
  }
}

function startWorkspaceWatcher(workspaceRoot: string): { success: boolean; error?: string } {
  try {
    if (!workspaceRoot || !isSafePath(workspaceRoot)) {
      return { success: false, error: 'Invalid workspace path.' }
    }

    const normalizedRoot = path.resolve(workspaceRoot)

    // If already watching this exact root, return success
    if (currentWatcher && watchedWorkspaceRoot === normalizedRoot) {
      return { success: true }
    }

    // Stop any existing watcher before starting a new one
    stopWorkspaceWatcher()

    // Create recursive watcher on workspace root
    const watcher = watch(normalizedRoot, { recursive: true }, async (eventType, filename) => {
      try {
        if (!filename) return

        // Normalize path and clean separators
        const rawFilename = filename.toString()
        const normalizedRel = rawFilename.replace(/\\/g, '/').replace(/^\/+/, '')

        // Check path traversal or outside workspace
        const targetAbs = path.resolve(normalizedRoot, normalizedRel)
        const rel = path.relative(normalizedRoot, targetAbs)
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
          return // Path outside workspace
        }

        // Filter out ignored folders
        const parts = rel.split(/[/\\]/)
        if (parts.some((part) => WATCHER_IGNORED_DIRS.has(part))) {
          return
        }

        // Filter out temporary build cache files
        const lowerRel = rel.toLowerCase()
        if (
          lowerRel.endsWith('.tsbuildinfo') ||
          lowerRel.endsWith('.tmp') ||
          lowerRel.endsWith('~')
        ) {
          return
        }

        // Determine event type and whether target is a directory
        let changeType: WorkspaceFileChangeType = 'change'
        let isDir = false
        try {
          const stat = await fs.stat(targetAbs)
          isDir = stat.isDirectory()
          if (eventType === 'rename') {
            changeType = 'add'
          } else {
            changeType = 'change'
          }
        } catch {
          // If stat fails, file or folder was deleted
          changeType = 'unlink'
        }

        const payload: WorkspaceFileChangeEvent = {
          workspaceRoot: normalizedRoot.replace(/\\/g, '/'),
          relativePath: rel.replace(/\\/g, '/'),
          eventType: changeType,
          isDirectory: isDir
        }

        // Broadcast to all open BrowserWindows
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.webContents.send(IPC_CHANNELS.ON_WORKSPACE_FILE_CHANGED, payload)
          }
        }
      } catch (err) {
        console.error('[Watcher] Error handling filesystem event:', err)
      }
    })

    watcher.on('error', (err) => {
      console.error('[Watcher] Filesystem watcher error:', err)
    })

    currentWatcher = watcher
    watchedWorkspaceRoot = normalizedRoot

    return { success: true }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[Watcher] Failed to start watcher on "${workspaceRoot}":`, message)
    return { success: false, error: message }
  }
}

function getWorkspaceIndexDirPath(): string {
  return path.join(app.getPath('userData'), 'workspace-indexes')
}

function getWorkspaceIndexFilePath(workspaceRoot: string): string {
  const normalized = path.resolve(workspaceRoot).replace(/\\/g, '/').toLowerCase()
  const hash = crypto.createHash('sha256').update(normalized).digest('hex')
  return path.join(getWorkspaceIndexDirPath(), `${hash}.json`)
}

// Queue of pending writes per storage file path to serialize concurrent operations
const saveQueueMap: Map<string, Promise<void>> = new Map()

async function safeWriteWorkspaceIndex(
  workspaceRoot: string,
  data: unknown
): Promise<SaveWorkspaceIndexResult> {
  try {
    if (!workspaceRoot || !isSafePath(workspaceRoot)) {
      return { success: false, error: 'Invalid workspace path.' }
    }
    if (!data || typeof data !== 'object') {
      return { success: false, error: 'Invalid index payload.' }
    }

    // Verify payload workspace identity matches the requested workspace
    const payloadRoot = (data as { workspaceRoot?: string }).workspaceRoot
    if (typeof payloadRoot !== 'string' || !payloadRoot.trim()) {
      return { success: false, error: 'Payload missing workspaceRoot identity.' }
    }
    const normRequested = path.resolve(workspaceRoot).replace(/\\/g, '/').toLowerCase()
    const normPayload = path.resolve(payloadRoot).replace(/\\/g, '/').toLowerCase()
    if (normRequested !== normPayload) {
      return {
        success: false,
        error: `Workspace identity mismatch: requested "${normRequested}", payload was "${normPayload}".`
      }
    }

    const filePath = getWorkspaceIndexFilePath(workspaceRoot)
    const dirPath = getWorkspaceIndexDirPath()
    const tempPath = `${filePath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`

    // Serialize concurrent writes using promise chain per file
    const currentQueue = saveQueueMap.get(filePath) || Promise.resolve()
    const writeOperation = currentQueue
      .then(async () => {
        await fs.mkdir(dirPath, { recursive: true })
        const jsonContent = JSON.stringify(data)
        await fs.writeFile(tempPath, jsonContent, 'utf-8')
        await fs.rename(tempPath, filePath)
      })
      .catch(async (err) => {
        try {
          await fs.unlink(tempPath)
        } catch {}
        throw err
      })

    saveQueueMap.set(filePath, writeOperation.catch(() => {}))
    await writeOperation

    return { success: true }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[IndexStorage] Failed to save workspace index for "${workspaceRoot}":`, message)
    return { success: false, error: message }
  }
}

async function safeLoadWorkspaceIndex(
  workspaceRoot: string
): Promise<LoadWorkspaceIndexResult> {
  try {
    if (!workspaceRoot || !isSafePath(workspaceRoot)) {
      return { success: false, error: 'Invalid workspace path.' }
    }

    const filePath = getWorkspaceIndexFilePath(workspaceRoot)

    // Wait for any in-flight write in the queue to finish first
    const pendingWrite = saveQueueMap.get(filePath)
    if (pendingWrite) {
      await pendingWrite
    }

    let fileContent: string
    try {
      fileContent = await fs.readFile(filePath, 'utf-8')
    } catch {
      return { success: false, error: 'Index file not found.' }
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(fileContent)
    } catch {
      // Corrupted file: remove it so future operations recover cleanly
      try {
        await fs.unlink(filePath)
      } catch {}
      return { success: false, error: 'Corrupted index file discarded.' }
    }

    if (!parsed || typeof parsed !== 'object') {
      return { success: false, error: 'Malformed index payload.' }
    }

    const payload = parsed as { workspaceRoot?: string; version?: number }
    const normRequested = path.resolve(workspaceRoot).replace(/\\/g, '/').toLowerCase()
    const normPayload = payload.workspaceRoot
      ? path.resolve(payload.workspaceRoot).replace(/\\/g, '/').toLowerCase()
      : null

    if (normPayload !== normRequested) {
      return {
        success: false,
        error: `Workspace identity mismatch in stored index: "${normPayload}" !== "${normRequested}".`
      }
    }

    return { success: true, data: parsed }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return { success: false, error: message }
  }
}

async function safeClearWorkspaceIndex(
  workspaceRoot: string
): Promise<ClearWorkspaceIndexResult> {
  try {
    if (!workspaceRoot || !isSafePath(workspaceRoot)) {
      return { success: false, error: 'Invalid workspace path.' }
    }
    const filePath = getWorkspaceIndexFilePath(workspaceRoot)
    try {
      await fs.unlink(filePath)
    } catch {}
    return { success: true }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return { success: false, error: message }
  }
}

async function readDirectoryTree(dirPath: string, maxDepth = 8, currentDepth = 0): Promise<FileEntry[]> {
  if (currentDepth > maxDepth) {
    return []
  }

  try {
    const dirents = await fs.readdir(dirPath, { withFileTypes: true })
    const entries: FileEntry[] = []

    for (const dirent of dirents) {
      if (IGNORED_FOLDERS.has(dirent.name)) {
        continue
      }

      const fullPath = path.join(dirPath, dirent.name)

      if (dirent.isDirectory()) {
        const children = await readDirectoryTree(fullPath, maxDepth, currentDepth + 1)
        entries.push({
          name: dirent.name,
          path: fullPath,
          isDirectory: true,
          children
        })
      } else if (dirent.isFile()) {
        let size: number | undefined
        let mtimeMs: number | undefined
        try {
          const stat = await fs.stat(fullPath)
          size = stat.size
          mtimeMs = stat.mtimeMs
        } catch {
          // Graceful fallback if stat fails for a file
        }
        entries.push({
          name: dirent.name,
          path: fullPath,
          isDirectory: false,
          size,
          mtimeMs
        })
      }
    }

    // Sort: directories first, then alphabetically
    return entries.sort((a, b) => {
      if (a.isDirectory === b.isDirectory) {
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
      }
      return a.isDirectory ? -1 : 1
    })
  } catch (error) {
    console.error(`Failed to read directory ${dirPath}:`, error)
    return []
  }
}

function setupContentSecurityPolicy(): void {
  const isDev = Boolean(process.env['ELECTRON_RENDERER_URL']) || !app.isPackaged
  const csp = buildCspDirectives(isDev)

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp]
      }
    })
  })
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 800,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: 'AI IDE',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
    mainWindow.focus()
  })

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`[Renderer Load Failure] code: ${errorCode}, desc: ${errorDescription}, url: ${validatedURL}`)
  })

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[Renderer Crashed]', details)
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']

  // Prevent navigation inside Electron window to external/arbitrary origins
  mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    // Allow internal navigation to the dev server in development
    if (devUrl && navigationUrl.startsWith(devUrl)) {
      return
    }

    event.preventDefault()
    if (isSafeExternalUrl(navigationUrl)) {
      shell.openExternal(navigationUrl)
    }
  })

  // Prevent opening arbitrary protocols/links, allow only safe external URLs (http/https) in system browser
  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (isSafeExternalUrl(details.url)) {
      shell.openExternal(details.url)
    }
    return { action: 'deny' }
  })

  // In production builds, block DevTools keyboard shortcuts (F12, Ctrl+Shift+I)
  if (app.isPackaged) {
    mainWindow.webContents.on('before-input-event', (event, input) => {
      const isDevToolsShortcut =
        (input.control && input.shift && input.key.toLowerCase() === 'i') ||
        input.key === 'F12'
      if (isDevToolsShortcut) {
        event.preventDefault()
      }
    })
  }

  // Load URL in dev, or local index.html in production
  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Note: getSettingsFilePath, loadSettings, and saveSettings are imported from ./settingsPersistence

interface SafeWorkspaceTargetSuccess {
  success: true
  normalizedRoot: string
  normalizedTarget: string
  relativePath: string
}

interface SafeWorkspaceTargetFailure {
  success: false
  error: string
}

type SafeWorkspaceTargetResult = SafeWorkspaceTargetSuccess | SafeWorkspaceTargetFailure

function resolveSafeWorkspaceTarget(
  workspaceRoot: unknown,
  targetPath: unknown
): SafeWorkspaceTargetResult {
  if (!workspaceRoot || !isSafePath(workspaceRoot)) {
    return { success: false, error: 'Invalid or missing workspace root.' }
  }
  if (!targetPath || !isSafePath(targetPath)) {
    return { success: false, error: 'Invalid or missing target path.' }
  }

  const normalizedRoot = path.resolve(workspaceRoot)

  let cleanPath = targetPath.trim()
  if (!/^[a-zA-Z]:[/\\]/.test(cleanPath)) {
    cleanPath = cleanPath.replace(/^[/\\]+/, '')
  }

  const normalizedTarget = path.isAbsolute(cleanPath)
    ? path.resolve(cleanPath)
    : path.resolve(normalizedRoot, cleanPath)

  const rel = path.relative(normalizedRoot, normalizedTarget)
  const isOutside = rel.startsWith('..') || path.isAbsolute(rel)

  if (isOutside) {
    return {
      success: false,
      error: `Access denied: Path '${targetPath}' is outside the current workspace.`
    }
  }

  return {
    success: true,
    normalizedRoot,
    normalizedTarget,
    relativePath: rel.replace(/\\/g, '/')
  }
}

function sanitizeFsError(err: unknown, normalizedTarget?: string, relativePath?: string): string {
  if (!(err instanceof Error)) return String(err)
  let msg = err.message
  if (normalizedTarget && relativePath !== undefined) {
    msg = msg.split(normalizedTarget).join(relativePath || 'target')
  }
  return msg
}

function registerIpcHandlers(): void {
  // Handle opening directory dialog
  ipcMain.handle(IPC_CHANNELS.OPEN_DIRECTORY, async (): Promise<OpenDirectoryResult> => {
    try {
      const result = await dialog.showOpenDialog({
        properties: ['openDirectory', 'createDirectory']
      })

      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, canceled: true }
      }

      const rootPath = result.filePaths[0]
      const tree = await readDirectoryTree(rootPath)

      // Persist last opened workspace path locally
      await saveSettings({ lastWorkspaceRoot: rootPath }).catch((err) => {
        console.error('Failed to persist last workspace root setting:', err)
      })

      return {
        success: true,
        rootPath,
        tree
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return { success: false, error: message }
    }
  })

  // Handle restoring last workspace on startup (with folder existence validation)
  ipcMain.handle(IPC_CHANNELS.GET_LAST_WORKSPACE, async (): Promise<OpenDirectoryResult> => {
    try {
      const settings = await loadSettings()
      const lastRoot = settings.lastWorkspaceRoot
      if (!lastRoot || typeof lastRoot !== 'string') {
        return { success: false, error: 'No previously opened workspace.' }
      }

      // Verify that the folder exists and is a directory
      try {
        const stat = await fs.stat(lastRoot)
        if (!stat.isDirectory()) {
          return { success: false, error: 'Saved workspace path is not a directory.' }
        }
      } catch {
        return { success: false, error: 'Saved workspace folder no longer exists.' }
      }

      const tree = await readDirectoryTree(lastRoot)
      return {
        success: true,
        rootPath: lastRoot,
        tree
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return { success: false, error: message }
    }
  })

  // Handle reading directory tree without open dialog (for refresh)
  ipcMain.handle(
    IPC_CHANNELS.READ_TREE,
    async (_event, rootPath: string): Promise<OpenDirectoryResult> => {
      try {
        if (!rootPath || !isSafePath(rootPath)) {
          return { success: false, error: 'No workspace folder specified or path is invalid.' }
        }
        const resolved = path.resolve(rootPath)
        try {
          const stat = await fs.stat(resolved)
          if (!stat.isDirectory()) {
            return { success: false, error: 'Specified path is not a directory.' }
          }
        } catch {
          return { success: false, error: 'Specified workspace folder does not exist.' }
        }
        const tree = await readDirectoryTree(resolved)
        return {
          success: true,
          rootPath: resolved,
          tree
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return { success: false, error: message }
      }
    }
  )

  // Handle reading a file from local disk
  ipcMain.handle(
    IPC_CHANNELS.READ_FILE,
    async (_event, filePath: string): Promise<ReadFileResult> => {
      try {
        if (!filePath || !isSafePath(filePath)) {
          return { success: false, error: 'Invalid or missing file path.' }
        }
        const normalized = path.resolve(filePath)
        let stat
        try {
          stat = await fs.stat(normalized)
        } catch {
          return { success: false, error: `File not found: '${filePath}'` }
        }
        if (stat.isDirectory()) {
          return { success: false, error: `Cannot read '${filePath}': Target path is a directory, not a file.` }
        }
        const content = await fs.readFile(normalized, 'utf-8')
        return { success: true, content }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return { success: false, error: `Failed to read file: ${message}` }
      }
    }
  )

  // Handle safe workspace file reading for the AI agent (with path traversal and directory guards)
  console.log('[IPC DEBUG] registering fs:readWorkspaceFile')
  ipcMain.handle(
    IPC_CHANNELS.READ_WORKSPACE_FILE,
    async (_event, rootPath: string, targetPath: string): Promise<ReadWorkspaceFileResult> => {
      try {
        if (!rootPath || !isSafePath(rootPath)) {
          return { success: false, error: 'No workspace folder is currently open or path is invalid.' }
        }
        if (!targetPath || !isSafePath(targetPath)) {
          return { success: false, error: 'Missing or invalid file path.' }
        }

        const normalizedRoot = path.resolve(rootPath)

        // Normalize target path (strip leading slashes/backslashes unless it's a drive path like C:\)
        let cleanPath = targetPath.trim()
        if (!/^[a-zA-Z]:[/\\]/.test(cleanPath)) {
          cleanPath = cleanPath.replace(/^[/\\]+/, '')
        }

        const normalizedTarget = path.isAbsolute(cleanPath)
          ? path.resolve(cleanPath)
          : path.resolve(normalizedRoot, cleanPath)

        // Ensure target is strictly inside the workspace root (prevent ../ traversal or drive escape)
        const rel = path.relative(normalizedRoot, normalizedTarget)
        const isOutside = rel.startsWith('..') || path.isAbsolute(rel)

        if (isOutside) {
          return {
            success: false,
            error: `Access denied: Path '${targetPath}' is outside the current workspace.`
          }
        }

        // Verify existence and ensure it is not a directory
        let stat
        try {
          stat = await fs.stat(normalizedTarget)
        } catch (statErr: unknown) {
          return {
            success: false,
            error: `File not found: '${targetPath}'`
          }
        }

        if (stat.isDirectory()) {
          return {
            success: false,
            error: `Cannot read '${targetPath}': Target path is a directory, not a file.`
          }
        }

        const content = await fs.readFile(normalizedTarget, 'utf-8')
        const displayPath = rel.replace(/\\/g, '/')

        return {
          success: true,
          path: displayPath,
          content
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          success: false,
          error: `Failed to read file: ${message}`
        }
      }
    }
  )
  console.log('[IPC DEBUG] readWorkspaceFile handler registered')

  // Handle safe workspace file creation for the AI agent (with path traversal and overwrite guards)
  ipcMain.handle(
    IPC_CHANNELS.CREATE_WORKSPACE_FILE,
    async (
      _event,
      rootPath: string,
      targetPath: string,
      content: string
    ): Promise<CreateWorkspaceFileResult> => {
      try {
        if (!rootPath || !isSafePath(rootPath)) {
          return { success: false, error: 'No workspace folder is currently open or path is invalid.' }
        }
        if (!targetPath || !isSafePath(targetPath)) {
          return { success: false, error: 'Missing or invalid file path.' }
        }

        const normalizedRoot = path.resolve(rootPath)

        // Normalize target path (strip leading slashes/backslashes unless it's a drive path like C:\)
        let cleanPath = targetPath.trim()
        if (!/^[a-zA-Z]:[/\\]/.test(cleanPath)) {
          cleanPath = cleanPath.replace(/^[/\\]+/, '')
        }

        const normalizedTarget = path.isAbsolute(cleanPath)
          ? path.resolve(cleanPath)
          : path.resolve(normalizedRoot, cleanPath)

        // Ensure target is strictly inside the workspace root (prevent ../ traversal or drive escape)
        const rel = path.relative(normalizedRoot, normalizedTarget)
        const isOutside = rel.startsWith('..') || path.isAbsolute(rel)

        if (isOutside) {
          return {
            success: false,
            error: `Access denied: Path '${targetPath}' is outside the current workspace.`
          }
        }

        // Overwrite protection: check if file/folder already exists
        try {
          await fs.access(normalizedTarget)
          // If fs.access does not throw, the file/dir already exists!
          return {
            success: false,
            error: `File already exists: '${targetPath}'. Use an edit operation instead.`
          }
        } catch {
          // File does not exist, proceed
        }

        // Ensure parent directories exist
        const parentDir = path.dirname(normalizedTarget)
        await fs.mkdir(parentDir, { recursive: true })

        // Write new file
        await fs.writeFile(normalizedTarget, content || '', 'utf-8')

        const displayPath = rel.replace(/\\/g, '/')
        return {
          success: true,
          path: displayPath
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          success: false,
          error: `Failed to create file: ${message}`
        }
      }
    }
  )

  // Handle safe workspace file editing for the AI agent (with path traversal, existence, and concurrency guards)
  ipcMain.handle(
    IPC_CHANNELS.EDIT_WORKSPACE_FILE,
    async (
      _event,
      rootPath: string,
      targetPath: string,
      newContent: string,
      expectedOldContent?: string
    ): Promise<EditWorkspaceFileResult> => {
      try {
        if (!rootPath || !isSafePath(rootPath)) {
          return { success: false, error: 'No workspace folder is currently open or path is invalid.' }
        }
        if (!targetPath || !isSafePath(targetPath)) {
          return { success: false, error: 'Missing or invalid file path.' }
        }

        const normalizedRoot = path.resolve(rootPath)

        // Normalize target path (strip leading slashes/backslashes unless it's a drive path like C:\)
        let cleanPath = targetPath.trim()
        if (!/^[a-zA-Z]:[/\\]/.test(cleanPath)) {
          cleanPath = cleanPath.replace(/^[/\\]+/, '')
        }

        const normalizedTarget = path.isAbsolute(cleanPath)
          ? path.resolve(cleanPath)
          : path.resolve(normalizedRoot, cleanPath)

        // Ensure target is strictly inside the workspace root (prevent ../ traversal or drive escape)
        const rel = path.relative(normalizedRoot, normalizedTarget)
        const isOutside = rel.startsWith('..') || path.isAbsolute(rel)

        if (isOutside) {
          return {
            success: false,
            error: `Access denied: Path '${targetPath}' is outside the current workspace.`
          }
        }

        // Verify existence and ensure it is not a directory
        let stat
        try {
          stat = await fs.stat(normalizedTarget)
        } catch {
          return {
            success: false,
            error: `File does not exist: '${targetPath}'. Use create_file instead.`
          }
        }

        if (stat.isDirectory()) {
          return {
            success: false,
            error: `Cannot edit '${targetPath}': Target path is a directory, not a file.`
          }
        }

        // Concurrency guard: verify current file content on disk matches expectedOldContent if provided
        if (expectedOldContent !== undefined) {
          const currentContent = await fs.readFile(normalizedTarget, 'utf-8')
          if (currentContent !== expectedOldContent) {
            return {
              success: false,
              error: 'File changed since this edit was proposed. Review the change again.'
            }
          }
        }

        // Write modified content
        await fs.writeFile(normalizedTarget, newContent || '', 'utf-8')

        const displayPath = rel.replace(/\\/g, '/')
        return {
          success: true,
          path: displayPath
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          success: false,
          error: `Failed to edit file: ${message}`
        }
      }
    }
  )

  // Handle writing modified file content back to local disk
  ipcMain.handle(
    IPC_CHANNELS.WRITE_FILE,
    async (_event, filePath: string, content: string): Promise<WriteFileResult> => {
      try {
        if (!filePath || !isSafePath(filePath)) {
          return { success: false, error: 'Invalid or missing file path.' }
        }
        if (typeof content !== 'string') {
          return { success: false, error: 'Invalid file content.' }
        }

        const normalizedTarget = path.resolve(filePath)
        try {
          const stat = await fs.stat(normalizedTarget)
          if (stat.isDirectory()) {
            return { success: false, error: `Cannot write to '${filePath}': Target path is a directory.` }
          }
        } catch {
          // File does not exist yet, proceed with write
        }

        await fs.mkdir(path.dirname(normalizedTarget), { recursive: true })
        await fs.writeFile(normalizedTarget, content, 'utf-8')
        return { success: true }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return { success: false, error: `Failed to write file: ${message}` }
      }
    }
  )

  // Handle creating a new file in workspace (User CRUD)
  ipcMain.handle(
    IPC_CHANNELS.FS_CREATE_FILE,
    async (
      _event,
      workspaceRoot: string,
      relativePath: string,
      content?: string
    ): Promise<CreateFileResult> => {
      try {
        const res = resolveSafeWorkspaceTarget(workspaceRoot, relativePath)
        if (!res.success) {
          return { success: false, error: res.error }
        }
        if (res.relativePath === '') {
          return { success: false, error: 'Cannot create a file as the workspace root.' }
        }

        // Validate workspace root exists and is a directory
        try {
          const rootStat = await fs.stat(res.normalizedRoot)
          if (!rootStat.isDirectory()) {
            return { success: false, error: 'Workspace root is not a directory.' }
          }
        } catch {
          return { success: false, error: 'Workspace root does not exist.' }
        }

        // Overwrite protection: check if file or directory already exists at target
        try {
          await fs.access(res.normalizedTarget)
          return {
            success: false,
            error: `File or directory already exists: '${res.relativePath}'.`
          }
        } catch {
          // Target does not exist, proceed
        }

        // Validate content if provided
        let fileContent = ''
        if (content !== undefined && content !== null) {
          if (typeof content !== 'string') {
            return { success: false, error: 'Invalid file content provided.' }
          }
          if (content.length > 50 * 1024 * 1024) {
            return { success: false, error: 'File content exceeds maximum permitted size (50MB).' }
          }
          fileContent = content
        }

        // Ensure parent directory exists
        const parentDir = path.dirname(res.normalizedTarget)
        await fs.mkdir(parentDir, { recursive: true })

        // Write file
        await fs.writeFile(res.normalizedTarget, fileContent, 'utf-8')

        return {
          success: true,
          path: res.relativePath
        }
      } catch (err: unknown) {
        const message = sanitizeFsError(err)
        return { success: false, error: `Failed to create file: ${message}` }
      }
    }
  )

  // Handle creating a new directory in workspace (User CRUD)
  ipcMain.handle(
    IPC_CHANNELS.FS_CREATE_DIRECTORY,
    async (
      _event,
      workspaceRoot: string,
      relativePath: string
    ): Promise<CreateDirectoryResult> => {
      try {
        const res = resolveSafeWorkspaceTarget(workspaceRoot, relativePath)
        if (!res.success) {
          return { success: false, error: res.error }
        }
        if (res.relativePath === '') {
          return { success: false, error: 'Cannot create directory: target is the workspace root.' }
        }

        // Validate workspace root exists and is a directory
        try {
          const rootStat = await fs.stat(res.normalizedRoot)
          if (!rootStat.isDirectory()) {
            return { success: false, error: 'Workspace root is not a directory.' }
          }
        } catch {
          return { success: false, error: 'Workspace root does not exist.' }
        }

        // Check if target already exists
        try {
          const targetStat = await fs.stat(res.normalizedTarget)
          if (targetStat.isDirectory()) {
            return {
              success: false,
              error: `Directory already exists: '${res.relativePath}'.`
            }
          } else {
            return {
              success: false,
              error: `Cannot create directory: A file already exists at '${res.relativePath}'.`
            }
          }
        } catch {
          // Target does not exist, proceed
        }

        await fs.mkdir(res.normalizedTarget, { recursive: true })

        return {
          success: true,
          path: res.relativePath
        }
      } catch (err: unknown) {
        const message = sanitizeFsError(err)
        return { success: false, error: `Failed to create directory: ${message}` }
      }
    }
  )

  // Handle renaming or moving a path in workspace (User CRUD)
  ipcMain.handle(
    IPC_CHANNELS.FS_RENAME_PATH,
    async (
      _event,
      workspaceRoot: string,
      oldRelativePath: string,
      newRelativePath: string
    ): Promise<RenamePathResult> => {
      try {
        const oldRes = resolveSafeWorkspaceTarget(workspaceRoot, oldRelativePath)
        if (!oldRes.success) {
          return { success: false, error: `Invalid source path: ${oldRes.error}` }
        }
        const newRes = resolveSafeWorkspaceTarget(workspaceRoot, newRelativePath)
        if (!newRes.success) {
          return { success: false, error: `Invalid destination path: ${newRes.error}` }
        }

        if (oldRes.relativePath === '') {
          return { success: false, error: 'Cannot rename the workspace root directory.' }
        }
        if (newRes.relativePath === '') {
          return { success: false, error: 'Destination cannot be the workspace root directory.' }
        }

        // Check source exists
        let oldStat
        try {
          oldStat = await fs.lstat(oldRes.normalizedTarget)
        } catch {
          return { success: false, error: `Source path not found: '${oldRes.relativePath}'.` }
        }

        // If paths are identical string match
        if (oldRes.normalizedTarget === newRes.normalizedTarget) {
          return {
            success: true,
            oldPath: oldRes.relativePath,
            newPath: newRes.relativePath
          }
        }

        // Prevent moving a directory into itself or one of its descendants
        if (oldStat.isDirectory()) {
          const normOld = path.resolve(oldRes.normalizedTarget).toLowerCase()
          const normNew = path.resolve(newRes.normalizedTarget).toLowerCase()
          const relSub = path.relative(normOld, normNew)
          if (!relSub.startsWith('..') && !path.isAbsolute(relSub)) {
            return {
              success: false,
              error: 'Cannot move a directory into itself or one of its descendants.'
            }
          }
        }

        // Check destination conflict
        try {
          await fs.access(newRes.normalizedTarget)
          // Destination exists. Check if this is a case-only rename on a case-insensitive filesystem
          const isCaseOnly =
            oldRes.normalizedTarget.toLowerCase() === newRes.normalizedTarget.toLowerCase()
          if (!isCaseOnly) {
            return {
              success: false,
              error: `Destination already exists: '${newRes.relativePath}'.`
            }
          }
        } catch {
          // Destination does not exist, proceed
        }

        // Ensure parent directory of destination exists
        const parentDir = path.dirname(newRes.normalizedTarget)
        await fs.mkdir(parentDir, { recursive: true })

        await fs.rename(oldRes.normalizedTarget, newRes.normalizedTarget)

        return {
          success: true,
          oldPath: oldRes.relativePath,
          newPath: newRes.relativePath
        }
      } catch (err: unknown) {
        const message = sanitizeFsError(err)
        return { success: false, error: `Failed to rename path: ${message}` }
      }
    }
  )

  // Handle deleting a file or directory in workspace (User CRUD)
  ipcMain.handle(
    IPC_CHANNELS.FS_DELETE_PATH,
    async (
      _event,
      workspaceRoot: string,
      relativePath: string,
      options?: DeletePathOptions
    ): Promise<DeletePathResult> => {
      try {
        const res = resolveSafeWorkspaceTarget(workspaceRoot, relativePath)
        if (!res.success) {
          return { success: false, error: res.error }
        }
        if (res.relativePath === '') {
          return { success: false, error: 'Cannot delete the workspace root directory.' }
        }

        // Verify target exists
        let targetStat
        try {
          targetStat = await fs.lstat(res.normalizedTarget)
        } catch {
          return { success: false, error: `Path not found: '${res.relativePath}'.` }
        }

        if (targetStat.isDirectory()) {
          const isRecursive = Boolean(options && typeof options === 'object' && options.recursive === true)
          if (!isRecursive) {
            const entries = await fs.readdir(res.normalizedTarget)
            if (entries.length > 0) {
              return {
                success: false,
                error: `Directory is not empty: '${res.relativePath}'. Set recursive to true to delete.`
              }
            }
          }
          await fs.rm(res.normalizedTarget, { recursive: true, force: false })
        } else {
          await fs.unlink(res.normalizedTarget)
        }

        return {
          success: true,
          path: res.relativePath
        }
      } catch (err: unknown) {
        const message = sanitizeFsError(err)
        return { success: false, error: `Failed to delete path: ${message}` }
      }
    }
  )

  // Handle compact token-efficient listing of project files for the AI Agent
  ipcMain.handle(
    IPC_CHANNELS.LIST_FILES,
    async (_event, rootPath: string, options?: { maxDepth?: number; relativePath?: string }) => {
      try {
        if (!rootPath || !isSafePath(rootPath)) {
          return { success: false, error: 'Invalid or missing workspace root path.' }
        }

        const normalizedRoot = path.resolve(rootPath)
        let targetPath = normalizedRoot

        const safeOptions = options && typeof options === 'object' ? options : undefined

        if (safeOptions?.relativePath) {
          if (!isSafePath(safeOptions.relativePath)) {
            return { success: false, error: 'Invalid relative path provided.' }
          }
          const resolvedTarget = path.resolve(normalizedRoot, safeOptions.relativePath)
          const rel = path.relative(normalizedRoot, resolvedTarget)
          if (rel.startsWith('..') || path.isAbsolute(rel)) {
            return { success: false, error: 'Access denied: target path is outside the workspace root.' }
          }
          targetPath = resolvedTarget
        }

        let stat
        try {
          stat = await fs.stat(targetPath)
        } catch {
          return { success: false, error: `Directory not found: '${safeOptions?.relativePath || rootPath}'` }
        }
        if (!stat.isDirectory()) {
          return { success: false, error: `Path is not a directory: '${safeOptions?.relativePath || rootPath}'` }
        }

        const rawMaxDepth = typeof safeOptions?.maxDepth === 'number' && Number.isFinite(safeOptions.maxDepth)
          ? safeOptions.maxDepth
          : 5
        const maxDepth = Math.max(1, Math.min(Math.floor(rawMaxDepth), 20))
        let totalFiles = 0
        let totalDirs = 0

        async function formatTree(dir: string, depth: number, prefix: string): Promise<string> {
          if (depth > maxDepth) {
            return `${prefix}└── ... (max depth reached)\n`
          }

          const dirents = await fs.readdir(dir, { withFileTypes: true })
          const visible = dirents.filter((d) => !IGNORED_FOLDERS.has(d.name))
          
          // Sort directories first, then alphabetical
          visible.sort((a, b) => {
            if (a.isDirectory() === b.isDirectory()) {
              return a.name.localeCompare(b.name, undefined, { numeric: true })
            }
            return a.isDirectory() ? -1 : 1
          })

          let output = ''
          for (let i = 0; i < visible.length; i++) {
            const dirent = visible[i]
            const isLast = i === visible.length - 1
            const pointer = isLast ? '└── ' : '├── '
            const childPrefix = prefix + (isLast ? '    ' : '│   ')
            const fullChildPath = path.join(dir, dirent.name)

            if (dirent.isDirectory()) {
              totalDirs++
              output += `${prefix}${pointer}${dirent.name}/\n`
              output += await formatTree(fullChildPath, depth + 1, childPrefix)
            } else {
              totalFiles++
              output += `${prefix}${pointer}${dirent.name}\n`
            }
          }
          return output
        }

        const treeString = await formatTree(targetPath, 0, '')
        return {
          success: true,
          treeString: treeString.trim() ? treeString : '(Empty directory)',
          totalFiles,
          totalDirs
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return { success: false, error: message }
      }
    }
  )

  // Handle starting workspace filesystem watcher
  ipcMain.handle(
    IPC_CHANNELS.WATCH_WORKSPACE,
    async (_event, rootPath: string): Promise<{ success: boolean; error?: string }> => {
      return startWorkspaceWatcher(rootPath)
    }
  )

  // Handle stopping workspace filesystem watcher
  ipcMain.handle(
    IPC_CHANNELS.UNWATCH_WORKSPACE,
    async (): Promise<{ success: boolean }> => {
      stopWorkspaceWatcher()
      return { success: true }
    }
  )

  // Handle saving persistent workspace index
  ipcMain.handle(
    IPC_CHANNELS.SAVE_WORKSPACE_INDEX,
    async (_event, workspaceRoot: string, data: unknown): Promise<SaveWorkspaceIndexResult> => {
      return safeWriteWorkspaceIndex(workspaceRoot, data)
    }
  )

  // Handle loading persistent workspace index
  ipcMain.handle(
    IPC_CHANNELS.LOAD_WORKSPACE_INDEX,
    async (_event, workspaceRoot: string): Promise<LoadWorkspaceIndexResult> => {
      return safeLoadWorkspaceIndex(workspaceRoot)
    }
  )

  // Handle clearing persistent workspace index
  ipcMain.handle(
    IPC_CHANNELS.CLEAR_WORKSPACE_INDEX,
    async (_event, workspaceRoot: string): Promise<ClearWorkspaceIndexResult> => {
      return safeClearWorkspaceIndex(workspaceRoot)
    }
  )

  // Handle reading API keys securely from local environment
  ipcMain.handle(IPC_CHANNELS.GET_ENV_API_KEY, async (_event, provider?: string) => {
    if (provider === 'openrouter') {
      return process.env.OPENROUTER_API_KEY || null
    }
    if (provider === 'nvidia') {
      return process.env.NVIDIA_API_KEY || process.env.NVIDIA_NIM_API_KEY || null
    }
    if (provider === 'opencode') {
      return process.env.OPENCODE_API_KEY || null
    }
    return process.env.GEMINI_API_KEY || null
  })

  // Handle getting persisted application settings
  ipcMain.handle(IPC_CHANNELS.GET_SETTINGS, async (): Promise<AppSettings> => {
    try {
      return await loadSettings()
    } catch {
      return {}
    }
  })

  // Handle saving persisted application settings
  ipcMain.handle(
    IPC_CHANNELS.SAVE_SETTINGS,
    async (_event, settings: Partial<AppSettings>): Promise<{ success: boolean; error?: string }> => {
      try {
        if (settings && typeof settings === 'object') {
          await saveSettings(settings)
          return { success: true }
        }
        return { success: false, error: 'Invalid settings payload.' }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return { success: false, error: message }
      }
    }
  )

  interface ActiveChatRequest {
    requestId: string
    provider: 'nvidia' | 'opencode'
    controller: AbortController
    reader?: ReadableStreamDefaultReader<Uint8Array>
  }
  const activeChatRequests = new Map<string, ActiveChatRequest>()

  // Handle cancelling active in-flight AI completion requests
  ipcMain.handle(
    IPC_CHANNELS.CANCEL_CHAT_COMPLETION,
    async (_event, requestId: string): Promise<{ success: boolean; canceled: boolean }> => {
      if (!requestId || typeof requestId !== 'string') {
        return { success: false, canceled: false }
      }
      const active = activeChatRequests.get(requestId)
      if (active) {
        activeChatRequests.delete(requestId)
        try {
          if (active.reader) {
            active.reader.cancel('Request was stopped by user.').catch(() => {})
          }
        } catch {}
        try {
          active.controller.abort('Request was stopped by user.')
        } catch {}
        console.log(`[IPC] Successfully cancelled in-flight request: ${requestId} (${active.provider})`)
        return { success: true, canceled: true }
      }
      return { success: true, canceled: false }
    }
  )

  // Handle NVIDIA NIM chat completions via Node.js fetch in main process (Bypasses Chromium CORS restrictions)
  ipcMain.handle(
    IPC_CHANNELS.NVIDIA_CHAT_COMPLETION,
    async (_event, request: NvidiaChatCompletionRequest): Promise<NvidiaChatCompletionResponse> => {
      const endpoint = 'https://integrate.api.nvidia.com/v1/chat/completions'
      const timeoutMs = request.timeoutMs && request.timeoutMs > 0 ? request.timeoutMs : 30000
      const requestId = request.requestId

      if (!request || typeof request !== 'object') {
        console.log('[NVIDIA NIM IPC] Invalid request payload received')
        return {
          success: false,
          error: 'Invalid request payload format.',
          stage: 'init'
        }
      }

      // Validate model - require configured model without silent fallback guessing
      const model = typeof request.model === 'string' ? request.model.trim() : ''
      if (!model) {
        console.log('[NVIDIA NIM IPC] Request rejected: missing model ID')
        return {
          success: false,
          error: 'No NVIDIA NIM model selected. Please fetch and select an available model in Settings.',
          stage: 'init'
        }
      }

      // Validate messages
      if (!Array.isArray(request.messages) || request.messages.length === 0) {
        console.log('[NVIDIA NIM IPC] Request rejected: missing messages')
        return {
          success: false,
          error: 'Chat completion request requires at least one message.',
          stage: 'init'
        }
      }

      // Resolve API key securely (Never log or print this)
      let apiKey = request.apiKey && typeof request.apiKey === 'string' ? request.apiKey.trim() : ''
      if (!apiKey) {
        const settings = await loadSettings()
        apiKey = settings.nvidiaApiKey || ''
      }
      if (!apiKey) {
        apiKey = process.env.NVIDIA_API_KEY || process.env.NVIDIA_NIM_API_KEY || ''
      }

      console.log(`[NVIDIA NIM IPC] Handler invoked for model: ${model}`)
      console.log(`[NVIDIA NIM IPC] API Key present: ${apiKey ? 'true' : 'false'}`)

      if (!apiKey) {
        console.log('[NVIDIA NIM IPC] Request failed: API key is not configured')
        return {
          success: false,
          error: 'NVIDIA NIM API key is not configured. Please provide a valid API key in Settings.',
          stage: 'init'
        }
      }

      const requestBody: Record<string, unknown> = {
        model,
        messages: request.messages,
        temperature: typeof request.temperature === 'number' ? request.temperature : 0.2
      }

      if (Array.isArray(request.tools) && request.tools.length > 0) {
        requestBody.tools = request.tools
        requestBody.tool_choice = request.tool_choice || 'auto'
      }

      const controller = new AbortController()
      let isTimedOut = false
      const timer = setTimeout(() => {
        isTimedOut = true
        controller.abort()
      }, timeoutMs)

      if (requestId) {
        activeChatRequests.set(requestId, {
          requestId,
          provider: 'nvidia',
          controller
        })
      }

      try {
        console.log(`[NVIDIA NIM IPC] Stage: connecting -> Dispatching HTTPS POST to ${endpoint}`)

        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
            Accept: 'application/json'
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal
        })
        clearTimeout(timer)

        console.log(`[NVIDIA NIM IPC] Stage: response_received -> HTTP Status ${response.status} (${response.statusText})`)

        if (!response.ok) {
          let errorDetails = `Status ${response.status} (${response.statusText})`
          try {
            const errorJson = (await response.json()) as any
            if (errorJson.error?.message) {
              errorDetails = errorJson.error.message
            } else if (errorJson.message) {
              errorDetails = errorJson.message
            } else if (errorJson.detail) {
              errorDetails = typeof errorJson.detail === 'string' ? errorJson.detail : JSON.stringify(errorJson.detail)
            }
          } catch {
            // Non-JSON error body
          }

          console.log(`[NVIDIA NIM IPC] HTTP Error response: ${errorDetails}`)
          const retryAfter = response.headers.get('retry-after')

          return {
            success: false,
            status: response.status,
            statusText: response.statusText,
            error: errorDetails,
            errorDetails,
            retryAfter: retryAfter || undefined,
            stage: 'response_received'
          }
        }

        const data = (await response.json()) as any
        const choiceCount = Array.isArray(data?.choices) ? data.choices.length : 0
        console.log(`[NVIDIA NIM IPC] Stage: completed -> Returned ${choiceCount} choice(s)`)

        return {
          success: true,
          status: response.status,
          data,
          stage: 'completed'
        }
      } catch (err: unknown) {
        clearTimeout(timer)
        const isUserCancel = controller.signal.aborted && !isTimedOut
        const isAbort =
          err instanceof Error &&
          (err.name === 'AbortError' || err.message.toLowerCase().includes('abort'))
        const rawMessage = isUserCancel
          ? 'Request was stopped by user.'
          : isAbort || isTimedOut
          ? `Request timed out after ${timeoutMs / 1000}s`
          : err instanceof Error
          ? err.message
          : String(err)

        console.log(`[NVIDIA NIM IPC] Stage: ${isUserCancel ? 'cancelled' : 'failed'} -> Network/Runtime Error: ${rawMessage}`)

        return {
          success: false,
          isNetworkError: !isUserCancel,
          error: rawMessage,
          errorDetails: rawMessage,
          stage: isUserCancel ? 'cancelled' : 'failed'
        }
      } finally {
        if (requestId) {
          activeChatRequests.delete(requestId)
        }
      }
    }
  )

  // Handle listing available NVIDIA NIM models securely via Node.js fetch in main process
  ipcMain.handle(
    IPC_CHANNELS.NVIDIA_LIST_MODELS,
    async (_event, request?: NvidiaListModelsRequest): Promise<NvidiaListModelsResponse> => {
      const endpoint = 'https://integrate.api.nvidia.com/v1/models'
      const timeoutMs = request?.timeoutMs && request.timeoutMs > 0 ? request.timeoutMs : 15000

      // Resolve API key securely (Never log or print this)
      let apiKey = request?.apiKey && typeof request.apiKey === 'string' ? request.apiKey.trim() : ''
      if (!apiKey) {
        const settings = await loadSettings()
        apiKey = settings.nvidiaApiKey || ''
      }
      if (!apiKey) {
        apiKey = process.env.NVIDIA_API_KEY || process.env.NVIDIA_NIM_API_KEY || ''
      }

      console.log(`[NVIDIA NIM IPC] Listing available models... API Key present: ${apiKey ? 'true' : 'false'}`)

      if (!apiKey) {
        return {
          success: false,
          error: 'NVIDIA NIM API key is not configured. Please provide a valid API key in Settings.',
          errorDetails: 'Missing API key'
        }
      }

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)

      try {
        const response = await fetch(endpoint, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: 'application/json'
          },
          signal: controller.signal
        })
        clearTimeout(timer)

        console.log(`[NVIDIA NIM IPC] List models response received: HTTP Status ${response.status} (${response.statusText})`)

        if (!response.ok) {
          let errorDetails = `Status ${response.status} (${response.statusText})`
          try {
            const errorJson = (await response.json()) as any
            if (errorJson.error?.message) {
              errorDetails = errorJson.error.message
            } else if (errorJson.message) {
              errorDetails = errorJson.message
            } else if (errorJson.detail) {
              errorDetails = typeof errorJson.detail === 'string' ? errorJson.detail : JSON.stringify(errorJson.detail)
            }
          } catch {}

          return {
            success: false,
            status: response.status,
            statusText: response.statusText,
            error: errorDetails,
            errorDetails
          }
        }

        const data = (await response.json()) as any
        const rawList = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : []
        const models: NvidiaModelItem[] = rawList
          .filter((item: any) => item && typeof item.id === 'string' && item.id.trim())
          .map((item: any) => ({
            id: item.id.trim(),
            created: item.created,
            owned_by: item.owned_by,
            object: item.object,
            root: item.root,
            parent: item.parent
          }))

        console.log(`[NVIDIA NIM IPC] Successfully retrieved ${models.length} available models`)

        return {
          success: true,
          status: response.status,
          models
        }
      } catch (err: unknown) {
        clearTimeout(timer)
        const isAbort =
          err instanceof Error &&
          (err.name === 'AbortError' || err.message.toLowerCase().includes('abort'))
        const rawMessage = isAbort
          ? `Request timed out after ${timeoutMs / 1000}s`
          : err instanceof Error
          ? err.message
          : String(err)

        console.log(`[NVIDIA NIM IPC] List models failed: ${rawMessage}`)

        return {
          success: false,
          isNetworkError: true,
          error: rawMessage,
          errorDetails: rawMessage
        }
      }
    }
  )

  // Handle OpenCode Chat Completions (with streaming and tool calling) via Node.js fetch in main process
  ipcMain.handle(
    IPC_CHANNELS.OPENCODE_CHAT_COMPLETION,
    async (event, request: OpenCodeChatCompletionRequest): Promise<OpenCodeChatCompletionResponse> => {
      if (!request || typeof request !== 'object') {
        return {
          success: false,
          error: 'Invalid request payload'
        }
      }

      const {
        model,
        messages,
        temperature = 0.2,
        tools,
        tool_choice,
        timeoutMs = 60000,
        stream = false,
        requestId
      } = request

      if (!model) {
        return {
          success: false,
          error: 'No OpenCode model selected. Please fetch and select an available free model in Settings.'
        }
      }

      let apiKey = request.apiKey || ''
      if (!apiKey) {
        apiKey = process.env.OPENCODE_API_KEY || ''
      }

      const endpoint = 'https://opencode.ai/inference/openai/v1/chat/completions'
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: stream ? 'text/event-stream, application/json' : 'application/json'
      }

      // Free models should work without an API key; include Authorization header only when key is provided
      if (apiKey && apiKey.trim()) {
        headers.Authorization = `Bearer ${apiKey.trim()}`
      }

      const requestBody: Record<string, unknown> = {
        model,
        messages,
        temperature,
        stream
      }

      if (tools && tools.length > 0) {
        requestBody.tools = tools
        requestBody.tool_choice = tool_choice || 'auto'
      }

      const controller = new AbortController()
      let isTimedOut = false
      const timer = setTimeout(() => {
        isTimedOut = true
        controller.abort()
      }, timeoutMs)

      if (requestId) {
        activeChatRequests.set(requestId, {
          requestId,
          provider: 'opencode',
          controller
        })
      }

      try {
        console.log(`[OpenCode IPC] Dispatching request to model: ${model}, stream: ${stream}, hasKey: ${!!apiKey}`)
        const response = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(requestBody),
          signal: controller.signal
        })
        clearTimeout(timer)

        if (!response.ok) {
          let errorDetails = `Status ${response.status} (${response.statusText})`
          try {
            const errJson = (await response.json()) as any
            if (errJson.error?.message) {
              errorDetails = errJson.error.message
            } else if (errJson.message) {
              errorDetails = errJson.message
            }
          } catch {}

          console.log(`[OpenCode IPC] HTTP error ${response.status}: ${errorDetails}`)
          const retryAfter = response.headers.get('retry-after')

          return {
            success: false,
            status: response.status,
            statusText: response.statusText,
            error: errorDetails,
            errorDetails,
            retryAfter: retryAfter || undefined
          }
        }

        // If streaming is requested and response has a readable body stream
        if (stream && response.body) {
          const reader = response.body.getReader()
          if (requestId) {
            const active = activeChatRequests.get(requestId)
            if (active) active.reader = reader
          }

          const decoder = new TextDecoder()
          let accumulatedContent = ''
          const toolCallsMap = new Map<number, { id: string; name: string; arguments: string }>()

          let buffer = ''
          try {
            while (true) {
              if (controller.signal.aborted) break

              const { done, value } = await reader.read()
              if (done) break

              buffer += decoder.decode(value, { stream: true })
              const lines = buffer.split('\n')
              buffer = lines.pop() || ''

              for (const line of lines) {
                if (controller.signal.aborted) break

                const trimmed = line.trim()
                if (!trimmed || !trimmed.startsWith('data:')) continue
                const payload = trimmed.slice(5).trim()
                if (payload === '[DONE]') continue

                try {
                  const parsed = JSON.parse(payload)
                  const choice = parsed.choices?.[0]
                  if (!choice) continue

                  const delta = choice.delta
                  if (delta) {
                    if (delta.content) {
                      accumulatedContent += delta.content
                      if (!controller.signal.aborted && requestId && !event.sender.isDestroyed()) {
                        event.sender.send(IPC_CHANNELS.OPENCODE_STREAM_CHUNK, {
                          requestId,
                          chunk: delta.content
                        })
                      }
                    }

                    if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
                      for (const tc of delta.tool_calls) {
                        const idx = typeof tc.index === 'number' ? tc.index : toolCallsMap.size
                        const existing = toolCallsMap.get(idx) || { id: '', name: '', arguments: '' }
                        if (tc.id) existing.id = tc.id
                        if (tc.function?.name) existing.name = tc.function.name
                        if (tc.function?.arguments) existing.arguments += tc.function.arguments
                        toolCallsMap.set(idx, existing)
                      }
                    }
                  }
                } catch {
                  // Ignore partial JSON parse chunks
                }
              }
            }

            if (!controller.signal.aborted && requestId && !event.sender.isDestroyed()) {
              event.sender.send(IPC_CHANNELS.OPENCODE_STREAM_CHUNK, {
                requestId,
                done: true
              })
            }
          } catch (streamErr: unknown) {
            try {
              await reader.cancel()
            } catch {}
            throw streamErr
          }

          if (controller.signal.aborted) {
            return {
              success: false,
              isNetworkError: false,
              error: 'Request was stopped by user.',
              errorDetails: 'Request was stopped by user.'
            }
          }

          const finalToolCalls = Array.from(toolCallsMap.values())
            .filter((tc) => tc.name)
            .map((tc) => ({
              id: tc.id || `call_${tc.name}_${Date.now()}`,
              type: 'function' as const,
              function: {
                name: tc.name,
                arguments: tc.arguments
              }
            }))

          return {
            success: true,
            status: response.status,
            statusText: response.statusText,
            data: {
              choices: [
                {
                  message: {
                    role: 'assistant',
                    content: accumulatedContent || null,
                    tool_calls: finalToolCalls.length > 0 ? finalToolCalls : undefined
                  }
                }
              ]
            }
          }
        }

        // Standard non-streaming JSON response
        const data = (await response.json()) as any
        return {
          success: true,
          status: response.status,
          statusText: response.statusText,
          data
        }
      } catch (err: unknown) {
        clearTimeout(timer)
        const isUserCancel = controller.signal.aborted && !isTimedOut
        const isAbort =
          err instanceof Error &&
          (err.name === 'AbortError' || err.message.toLowerCase().includes('abort'))
        const rawMsg = isUserCancel
          ? 'Request was stopped by user.'
          : isAbort || isTimedOut
          ? `Request timed out after ${timeoutMs / 1000}s`
          : String(err)

        if (!isUserCancel && requestId && stream && !event.sender.isDestroyed()) {
          event.sender.send(IPC_CHANNELS.OPENCODE_STREAM_CHUNK, {
            requestId,
            error: rawMsg,
            done: true
          })
        }

        console.log(`[OpenCode IPC] Request ${isUserCancel ? 'cancelled' : 'failed'}: ${rawMsg}`)
        return {
          success: false,
          isNetworkError: !isUserCancel,
          error: rawMsg,
          errorDetails: rawMsg
        }
      } finally {
        if (requestId) {
          activeChatRequests.delete(requestId)
        }
      }
    }
  )

  // Handle listing available OpenCode models securely via Node.js fetch in main process
  ipcMain.handle(
    IPC_CHANNELS.OPENCODE_LIST_MODELS,
    async (_event, request?: OpenCodeListModelsRequest): Promise<OpenCodeListModelsResponse> => {
      let apiKey = request?.apiKey || ''
      if (!apiKey) {
        apiKey = process.env.OPENCODE_API_KEY || ''
      }

      const timeoutMs = request?.timeoutMs || 15000
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)

      try {
        const headers: Record<string, string> = {
          Accept: 'application/json'
        }
        if (apiKey && apiKey.trim()) {
          headers.Authorization = `Bearer ${apiKey.trim()}`
        }

        const endpoint = 'https://opencode.ai/inference/v1/models'
        const response = await fetch(endpoint, {
          method: 'GET',
          headers,
          signal: controller.signal
        })
        clearTimeout(timer)

        if (!response.ok) {
          let errorDetails = `Status ${response.status} (${response.statusText})`
          try {
            const errJson = (await response.json()) as any
            if (errJson.error?.message) {
              errorDetails = errJson.error.message
            } else if (errJson.message) {
              errorDetails = errJson.message
            }
          } catch {}

          return {
            success: false,
            status: response.status,
            statusText: response.statusText,
            error: errorDetails,
            errorDetails
          }
        }

        const payload = (await response.json()) as any
        const rawList: any[] = Array.isArray(payload.data) ? payload.data : Array.isArray(payload) ? payload : []

        // Filter strictly for models officially marked as free
        const freeModels: OpenCodeModelItem[] = rawList
          .filter((m) => {
            const id = String(m.id || '').toLowerCase()
            return id.includes('free')
          })
          .map((m) => ({
            id: String(m.id),
            created: m.created,
            owned_by: m.owned_by,
            object: m.object,
            isFree: true
          }))

        console.log(`[OpenCode IPC] Successfully retrieved ${freeModels.length} free models`)
        return {
          success: true,
          models: freeModels,
          status: response.status,
          statusText: response.statusText
        }
      } catch (err: unknown) {
        clearTimeout(timer)
        const isAbort =
          err instanceof Error &&
          (err.name === 'AbortError' || err.message.toLowerCase().includes('abort'))
        const rawMsg = isAbort ? `Request timed out after ${timeoutMs / 1000}s` : String(err)
        return {
          success: false,
          isNetworkError: true,
          error: rawMsg,
          errorDetails: rawMsg
        }
      }
    }
  )

  // Track most recent active legacy/user session for backward-compatible STOP_COMMAND targeting
  let activeLegacySessionId: string | null = null

  // Handle running shell commands safely in workspace working directory (backward-compatible session wrapper)
  ipcMain.handle(
    IPC_CHANNELS.RUN_COMMAND,
    async (
      _event,
      command: string,
      targetCwd?: string,
      timeoutMs: number = 60000
    ): Promise<RunCommandResult> => {
      if (!command || !isSafeString(command)) {
        return {
          success: false,
          stdout: '',
          stderr: '',
          exitCode: null,
          timedOut: false,
          error: 'No command specified or command contains invalid characters.'
        }
      }

      const clampedTimeout = clampTimeout(timeoutMs, 60000, 1000, 600000)

      // Ensure valid cwd
      let resolvedCwd = process.cwd()
      if (typeof targetCwd === 'string' && targetCwd.trim().length > 0) {
        if (!isSafePath(targetCwd)) {
          return {
            success: false,
            stdout: '',
            stderr: '',
            exitCode: null,
            timedOut: false,
            error: 'Invalid working directory path.'
          }
        }
        try {
          const stat = await fs.stat(targetCwd)
          if (stat.isDirectory()) {
            resolvedCwd = path.resolve(targetCwd)
          } else {
            return {
              success: false,
              stdout: '',
              stderr: '',
              exitCode: null,
              timedOut: false,
              error: `Invalid working directory: '${targetCwd}' is not a directory.`
            }
          }
        } catch {
          return {
            success: false,
            stdout: '',
            stderr: '',
            exitCode: null,
            timedOut: false,
            error: `Working directory does not exist: '${targetCwd}'`
          }
        }
      } else if (targetCwd !== undefined && targetCwd !== null) {
        return {
          success: false,
          stdout: '',
          stderr: '',
          exitCode: null,
          timedOut: false,
          error: 'Invalid working directory path.'
        }
      }

      // Safety Validation: Prevent workspace escape, traversal, or unauthorized directory changes
      const safetyCheck = validateCommandSafety(command, resolvedCwd)
      if (!safetyCheck.safe) {
        return {
          success: false,
          stdout: '',
          stderr: '',
          exitCode: null,
          timedOut: false,
          error:
            safetyCheck.error ||
            'Command rejected: working directory must remain inside the current workspace.'
        }
      }

      return new Promise<RunCommandResult>(async (resolve) => {
        const sessionId = terminalSessionManager.generateSessionId('legacy')
        activeLegacySessionId = sessionId

        const onExit = (evt: TerminalSessionExitEvent) => {
          if (evt.sessionId === sessionId) {
            terminalSessionManager.off('exit', onExit)
            if (activeLegacySessionId === sessionId) {
              activeLegacySessionId = null
            }
            const session = terminalSessionManager.getSession(sessionId)
            const stdout = session ? session.retainedStdout : (evt.stdout || '')
            const stderr = session ? session.retainedStderr : (evt.stderr || '')
            const finalError = evt.error || (evt.timedOut ? `Execution timed out after ${clampedTimeout / 1000} seconds.` : undefined)

            // Safely prune completed transient session from memory
            terminalSessionManager.removeCompletedSession(sessionId)

            resolve({
              success: evt.exitCode === 0 && !evt.timedOut,
              stdout,
              stderr: evt.timedOut ? stderr + `\nCommand timed out after ${clampedTimeout / 1000}s.` : stderr,
              exitCode: evt.exitCode,
              timedOut: evt.timedOut,
              error: finalError
            })
          }
        }

        terminalSessionManager.on('exit', onExit)

        const spawnRes = await terminalSessionManager.spawnSession({
          sessionId,
          command,
          cwd: resolvedCwd,
          workspaceRoot: resolvedCwd,
          source: 'transient',
          timeoutMs: clampedTimeout
        })

        if (!spawnRes.success) {
          terminalSessionManager.off('exit', onExit)
          if (activeLegacySessionId === sessionId) {
            activeLegacySessionId = null
          }
          resolve({
            success: false,
            stdout: '',
            stderr: '',
            exitCode: null,
            timedOut: false,
            error: spawnRes.error || 'Failed to spawn process.'
          })
        }
      })
    }
  )

  // Handle stopping active child command (backward-compatible scoped mechanism)
  ipcMain.handle(
    IPC_CHANNELS.STOP_COMMAND,
    async (_event, sessionId?: string): Promise<{ success: boolean; error?: string }> => {
      try {
        if (typeof sessionId === 'string' && sessionId.trim().length > 0) {
          const killRes = await terminalSessionManager.killSession(sessionId.trim())
          return { success: killRes.success, error: killRes.error }
        }

        if (activeLegacySessionId) {
          const killRes = await terminalSessionManager.killSession(activeLegacySessionId)
          activeLegacySessionId = null
          return { success: killRes.success, error: killRes.error }
        }

        // Scoped fallback: only stop active user or transient sessions, avoiding AI agent processes
        const sessions = terminalSessionManager.listSessions()
        const runningTargets = sessions.filter(
          (s) => s.running && (s.source === 'user' || s.source === 'transient')
        )
        if (runningTargets.length > 0) {
          const target = runningTargets[runningTargets.length - 1]
          const killRes = await terminalSessionManager.killSession(target.sessionId)
          return { success: killRes.success, error: killRes.error }
        }

        return { success: true }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return { success: false, error: msg }
      }
    }
  )

  // Handle spawning a new isolated terminal session
  ipcMain.handle(
    IPC_CHANNELS.TERMINAL_SPAWN,
    async (event, options: TerminalSpawnOptions): Promise<TerminalSpawnResult> => {
      if (!event.sender || event.sender.isDestroyed()) {
        return { success: false, error: 'Unauthorized or destroyed IPC sender.' }
      }
      return terminalSessionManager.spawnSession(options)
    }
  )

  // Handle writing to a terminal session stdin
  ipcMain.handle(
    IPC_CHANNELS.TERMINAL_WRITE_INPUT,
    async (event, sessionId: string, inputData: string): Promise<TerminalWriteInputResult> => {
      if (!event.sender || event.sender.isDestroyed()) {
        return { success: false, error: 'Unauthorized or destroyed IPC sender.' }
      }
      return terminalSessionManager.writeInput(sessionId, inputData)
    }
  )

  // Handle resizing a terminal session (cols, rows)
  ipcMain.handle(
    IPC_CHANNELS.TERMINAL_RESIZE,
    async (
      event,
      sessionId: string,
      cols: number,
      rows: number
    ): Promise<import('../shared/types').TerminalResizeResult> => {
      if (!event.sender || event.sender.isDestroyed()) {
        return { success: false, error: 'Unauthorized or destroyed IPC sender.' }
      }
      return terminalSessionManager.resizeSession(sessionId, cols, rows)
    }
  )

  // Handle killing a specific terminal session
  ipcMain.handle(
    IPC_CHANNELS.TERMINAL_KILL,
    async (event, sessionId: string): Promise<TerminalKillResult> => {
      if (!event.sender || event.sender.isDestroyed()) {
        return { success: false, error: 'Unauthorized or destroyed IPC sender.' }
      }
      return terminalSessionManager.killSession(sessionId)
    }
  )

  // Handle killing all terminal sessions
  ipcMain.handle(
    IPC_CHANNELS.TERMINAL_KILL_ALL,
    async (event): Promise<TerminalKillAllResult> => {
      if (!event.sender || event.sender.isDestroyed()) {
        return { success: false, killedCount: 0, error: 'Unauthorized or destroyed IPC sender.' }
      }
      return terminalSessionManager.killAllSessions()
    }
  )

  // Handle listing all tracked terminal sessions
  ipcMain.handle(
    IPC_CHANNELS.TERMINAL_LIST_SESSIONS,
    async (event): Promise<TerminalListSessionsResult> => {
      if (!event.sender || event.sender.isDestroyed()) {
        return { success: false, sessions: [], error: 'Unauthorized or destroyed IPC sender.' }
      }
      return {
        success: true,
        sessions: terminalSessionManager.listSessions()
      }
    }
  )

  interface GitExecutionResult {
    success: boolean
    stdout: string
    stderr: string
    exitCode: number | null
    isRepo: boolean
    notInstalled: boolean
    error?: string
  }

  function executeGitCommand(
    args: string[],
    cwd: string,
    timeoutMs = 15000
  ): Promise<GitExecutionResult> {
    return new Promise<GitExecutionResult>((resolve) => {
      let stdout = ''
      let stderr = ''
      let isFinished = false
      let timer: NodeJS.Timeout | null = null

      try {
        const child = spawn('git', args, {
          cwd: path.resolve(cwd),
          windowsHide: true,
          env: { ...process.env, LANG: 'C', LC_ALL: 'C' }
        })

        if (timeoutMs > 0) {
          timer = setTimeout(() => {
            if (!isFinished) {
              isFinished = true
              try {
                if (child.pid) {
                  if (process.platform === 'win32') {
                    exec(`taskkill /pid ${child.pid} /T /F`)
                  } else {
                    child.kill('SIGTERM')
                  }
                }
              } catch {
                // ignore
              }
              resolve({
                success: false,
                stdout,
                stderr: stderr + '\nGit command timed out.',
                exitCode: null,
                isRepo: true,
                notInstalled: false,
                error: 'Git command timed out.'
              })
            }
          }, timeoutMs)
        }

        child.stdout?.on('data', (data) => {
          if (stdout.length < 200000) {
            stdout += data.toString()
          }
        })

        child.stderr?.on('data', (data) => {
          if (stderr.length < 50000) {
            stderr += data.toString()
          }
        })

        child.on('error', (err: any) => {
          if (timer) clearTimeout(timer)
          if (!isFinished) {
            isFinished = true
            const notInstalled = err?.code === 'ENOENT'
            resolve({
              success: false,
              stdout,
              stderr: err.message,
              exitCode: null,
              isRepo: false,
              notInstalled,
              error: notInstalled
                ? 'Git is not installed or could not be executed.'
                : err.message
            })
          }
        })

        child.on('close', (code) => {
          if (timer) clearTimeout(timer)
          if (!isFinished) {
            isFinished = true
            const isNotRepo =
              code === 128 &&
              (stderr.toLowerCase().includes('not a git repository') ||
                stderr.toLowerCase().includes('must be run in a work tree'))
            resolve({
              success: code === 0,
              stdout,
              stderr,
              exitCode: code,
              isRepo: !isNotRepo,
              notInstalled: false,
              error: isNotRepo ? 'This workspace is not a Git repository.' : undefined
            })
          }
        })
      } catch (err: unknown) {
        if (timer) clearTimeout(timer)
        const msg = err instanceof Error ? err.message : String(err)
        resolve({
          success: false,
          stdout: '',
          stderr: msg,
          exitCode: null,
          isRepo: false,
          notInstalled: false,
          error: msg
        })
      }
    })
  }

  // Handle Read-Only Git Status
  ipcMain.handle(
    IPC_CHANNELS.GIT_STATUS,
    async (_event, rootPath: string): Promise<GitStatusResult> => {
      if (!rootPath || !isSafePath(rootPath)) {
        return {
          success: false,
          isRepository: false,
          branch: null,
          staged: [],
          unstaged: [],
          untracked: [],
          conflicted: [],
          clean: false,
          error: 'No workspace folder is currently open or path is invalid.'
        }
      }

      const gitRes = await executeGitCommand(['status', '--porcelain=v1', '-b'], rootPath)

      if (gitRes.notInstalled) {
        return {
          success: false,
          isRepository: false,
          branch: null,
          staged: [],
          unstaged: [],
          untracked: [],
          conflicted: [],
          clean: false,
          error: 'Git is not installed or could not be executed.'
        }
      }

      if (!gitRes.isRepo) {
        return {
          success: true,
          isRepository: false,
          branch: null,
          staged: [],
          unstaged: [],
          untracked: [],
          conflicted: [],
          clean: false,
          error: 'This workspace is not a Git repository.'
        }
      }

      let branch: string | null = null
      const staged: string[] = []
      const unstaged: string[] = []
      const untracked: string[] = []
      const conflicted: string[] = []
      const files: GitFileStatus[] = []

      const lines = gitRes.stdout.split(/\r?\n/)
      for (const line of lines) {
        if (!line.trim()) continue

        // Branch header line: e.g. ## main...origin/main [ahead 1] or ## main
        if (line.startsWith('## ')) {
          const branchPart = line.slice(3).trim()
          if (branchPart.startsWith('No commits yet on ') || branchPart.startsWith('Initial commit on ')) {
            branch = branchPart.replace(/^(?:No commits yet on |Initial commit on )/, '').trim()
          } else if (branchPart.startsWith('HEAD (no branch)')) {
            branch = 'HEAD (detached)'
          } else {
            const match = branchPart.match(/^([^\s.]+)/)
            branch = match ? match[1] : branchPart
          }
          continue
        }

        const x = line[0]
        const y = line[1]
        const filePath = line.slice(3).trim()

        if (x === '?' && y === '?') {
          untracked.push(filePath)
          files.push({ path: filePath, status: 'untracked', staged: false })
        } else if (
          (x === 'U' || y === 'U') ||
          (x === 'A' && y === 'A') ||
          (x === 'D' && y === 'D')
        ) {
          conflicted.push(filePath)
          files.push({ path: filePath, status: 'conflicted', staged: false })
        } else {
          // Check staged status (X)
          if (x !== ' ' && x !== '?') {
            staged.push(`${x} ${filePath}`)
            let changeStatus: GitFileChangeStatus = 'modified'
            let fileRel = filePath
            let oldRel: string | undefined = undefined
            if (x === 'A') changeStatus = 'added'
            else if (x === 'D') changeStatus = 'deleted'
            else if (x === 'R') {
              changeStatus = 'renamed'
              if (filePath.includes(' -> ')) {
                const parts = filePath.split(' -> ')
                oldRel = parts[0].trim()
                fileRel = parts[1].trim()
              }
            }
            files.push({ path: fileRel, status: changeStatus, staged: true, oldPath: oldRel })
          }
          // Check unstaged status (Y)
          if (y !== ' ' && y !== '?') {
            unstaged.push(`${y} ${filePath}`)
            let changeStatus: GitFileChangeStatus = 'modified'
            let fileRel = filePath
            if (y === 'D') changeStatus = 'deleted'
            files.push({ path: fileRel, status: changeStatus, staged: false })
          }
        }
      }

      const clean =
        staged.length === 0 &&
        unstaged.length === 0 &&
        untracked.length === 0 &&
        conflicted.length === 0

      return {
        success: true,
        isRepository: true,
        branch,
        staged,
        unstaged,
        untracked,
        conflicted,
        clean,
        files
      }
    }
  )

  // Handle Read-Only Git Diff
  ipcMain.handle(
    IPC_CHANNELS.GIT_DIFF,
    async (_event, rootPath: string): Promise<GitDiffResult> => {
      if (!rootPath || !isSafePath(rootPath)) {
        return {
          success: false,
          isRepository: false,
          unstagedDiff: '',
          stagedDiff: '',
          error: 'No workspace folder is currently open or path is invalid.'
        }
      }

      const unstagedRes = await executeGitCommand(['diff', '--no-color'], rootPath)

      if (unstagedRes.notInstalled) {
        return {
          success: false,
          isRepository: false,
          unstagedDiff: '',
          stagedDiff: '',
          error: 'Git is not installed or could not be executed.'
        }
      }

      if (!unstagedRes.isRepo) {
        return {
          success: true,
          isRepository: false,
          unstagedDiff: '',
          stagedDiff: '',
          error: 'This workspace is not a Git repository.'
        }
      }

      const stagedRes = await executeGitCommand(['diff', '--cached', '--no-color'], rootPath)

      const MAX_DIFF_LENGTH = 30000
      let truncated = false

      let unstagedDiff = unstagedRes.stdout || ''
      if (unstagedDiff.length > MAX_DIFF_LENGTH) {
        unstagedDiff =
          unstagedDiff.slice(0, MAX_DIFF_LENGTH) +
          '\n\n[...unstaged diff truncated at 30,000 characters]'
        truncated = true
      }

      let stagedDiff = stagedRes.stdout || ''
      if (stagedDiff.length > MAX_DIFF_LENGTH) {
        stagedDiff =
          stagedDiff.slice(0, MAX_DIFF_LENGTH) +
          '\n\n[...staged diff truncated at 30,000 characters]'
        truncated = true
      }

      return {
        success: true,
        isRepository: true,
        unstagedDiff,
        stagedDiff,
        truncated
      }
    }
  )

  // Handle Read-Only Git Log
  ipcMain.handle(
    IPC_CHANNELS.GIT_LOG,
    async (_event, rootPath: string, maxCount = 10): Promise<GitLogResult> => {
      if (!rootPath || !isSafePath(rootPath)) {
        return {
          success: false,
          isRepository: false,
          commits: [],
          error: 'No workspace folder is currently open or path is invalid.'
        }
      }

      const count = Math.min(Math.max(1, typeof maxCount === 'number' && Number.isFinite(maxCount) ? Math.floor(maxCount) : 10), 25)
      const gitRes = await executeGitCommand(
        ['log', `-${count}`, '--pretty=format:%H%x09%an%x09%ad%x09%s', '--date=short', '--no-color'],
        rootPath
      )

      if (gitRes.notInstalled) {
        return {
          success: false,
          isRepository: false,
          commits: [],
          error: 'Git is not installed or could not be executed.'
        }
      }

      if (!gitRes.isRepo) {
        return {
          success: true,
          isRepository: false,
          commits: [],
          error: 'This workspace is not a Git repository.'
        }
      }

      const commits: GitCommitInfo[] = []
      const lines = gitRes.stdout.split(/\r?\n/)
      for (const line of lines) {
        if (!line.trim()) continue
        const parts = line.split('\t')
        if (parts.length >= 4) {
          commits.push({
            hash: parts[0].trim(),
            author: parts[1].trim(),
            date: parts[2].trim(),
            message: parts.slice(3).join('\t').trim()
          })
        }
      }

      return {
        success: true,
        isRepository: true,
        commits
      }
    }
  )

  // Handle Staging a Single File
  ipcMain.handle(
    IPC_CHANNELS.GIT_STAGE_FILE,
    async (_event, workspaceRoot: string, relativePath: string): Promise<GitStageResult> => {
      const targetRes = resolveSafeWorkspaceTarget(workspaceRoot, relativePath)
      if (!targetRes.success) {
        return { success: false, error: targetRes.error }
      }

      if (!targetRes.relativePath || targetRes.relativePath === '.' || targetRes.relativePath === '*') {
        return {
          success: false,
          error: 'Cannot stage entire directory with single-file stage. Use stage all instead.'
        }
      }

      const gitRes = await executeGitCommand(['add', '--', targetRes.relativePath], targetRes.normalizedRoot)
      if (gitRes.notInstalled) {
        return { success: false, error: 'Git is not installed or could not be executed.' }
      }
      if (!gitRes.isRepo) {
        return { success: false, error: 'This workspace is not a Git repository.' }
      }
      if (!gitRes.success) {
        return { success: false, error: gitRes.error || gitRes.stderr || 'Failed to stage file.' }
      }

      return { success: true, path: targetRes.relativePath }
    }
  )

  // Handle Unstaging a Single File
  ipcMain.handle(
    IPC_CHANNELS.GIT_UNSTAGE_FILE,
    async (_event, workspaceRoot: string, relativePath: string): Promise<GitUnstageResult> => {
      const targetRes = resolveSafeWorkspaceTarget(workspaceRoot, relativePath)
      if (!targetRes.success) {
        return { success: false, error: targetRes.error }
      }

      if (!targetRes.relativePath || targetRes.relativePath === '.' || targetRes.relativePath === '*') {
        return {
          success: false,
          error: 'Cannot unstage entire directory with single-file unstage. Use unstage all instead.'
        }
      }

      // Try modern git restore --staged first, fallback to git reset HEAD if needed
      let gitRes = await executeGitCommand(['restore', '--staged', '--', targetRes.relativePath], targetRes.normalizedRoot)
      if (gitRes.notInstalled) {
        return { success: false, error: 'Git is not installed or could not be executed.' }
      }
      if (!gitRes.isRepo) {
        return { success: false, error: 'This workspace is not a Git repository.' }
      }
      if (!gitRes.success && (gitRes.stderr.includes('unknown option') || gitRes.stderr.includes('not a git command'))) {
        gitRes = await executeGitCommand(['reset', 'HEAD', '--', targetRes.relativePath], targetRes.normalizedRoot)
      }
      if (!gitRes.success) {
        return { success: false, error: gitRes.error || gitRes.stderr || 'Failed to unstage file.' }
      }

      return { success: true, path: targetRes.relativePath }
    }
  )

  // Handle Staging All Changes
  ipcMain.handle(
    IPC_CHANNELS.GIT_STAGE_ALL,
    async (_event, workspaceRoot: string): Promise<GitStageAllResult> => {
      if (!workspaceRoot || !isSafePath(workspaceRoot)) {
        return { success: false, error: 'Invalid or missing workspace root.' }
      }

      const normalizedRoot = path.resolve(workspaceRoot)
      const gitRes = await executeGitCommand(['add', '-A', '--', '.'], normalizedRoot)
      if (gitRes.notInstalled) {
        return { success: false, error: 'Git is not installed or could not be executed.' }
      }
      if (!gitRes.isRepo) {
        return { success: false, error: 'This workspace is not a Git repository.' }
      }
      if (!gitRes.success) {
        return { success: false, error: gitRes.error || gitRes.stderr || 'Failed to stage all changes.' }
      }

      return { success: true }
    }
  )

  // Handle Unstaging All Changes
  ipcMain.handle(
    IPC_CHANNELS.GIT_UNSTAGE_ALL,
    async (_event, workspaceRoot: string): Promise<GitUnstageAllResult> => {
      if (!workspaceRoot || !isSafePath(workspaceRoot)) {
        return { success: false, error: 'Invalid or missing workspace root.' }
      }

      const normalizedRoot = path.resolve(workspaceRoot)
      let gitRes = await executeGitCommand(['restore', '--staged', '--', '.'], normalizedRoot)
      if (gitRes.notInstalled) {
        return { success: false, error: 'Git is not installed or could not be executed.' }
      }
      if (!gitRes.isRepo) {
        return { success: false, error: 'This workspace is not a Git repository.' }
      }
      if (!gitRes.success && (gitRes.stderr.includes('unknown option') || gitRes.stderr.includes('not a git command'))) {
        gitRes = await executeGitCommand(['reset', 'HEAD', '--', '.'], normalizedRoot)
      }
      if (!gitRes.success) {
        return { success: false, error: gitRes.error || gitRes.stderr || 'Failed to unstage all changes.' }
      }

      return { success: true }
    }
  )

  // Handle Creating a Commit
  ipcMain.handle(
    IPC_CHANNELS.GIT_COMMIT,
    async (_event, workspaceRoot: string, message: string): Promise<GitCommitResult> => {
      if (!workspaceRoot || !isSafePath(workspaceRoot)) {
        return { success: false, error: 'Invalid or missing workspace root.' }
      }

      if (typeof message !== 'string' || !message.trim()) {
        return { success: false, error: 'Commit message cannot be empty.' }
      }

      if (message.length > 10000) {
        return { success: false, error: 'Commit message exceeds maximum length (10,000 characters).' }
      }

      const normalizedRoot = path.resolve(workspaceRoot)

      // First check if any staged changes exist
      const statusRes = await executeGitCommand(['status', '--porcelain=v1'], normalizedRoot)
      if (statusRes.notInstalled) {
        return { success: false, error: 'Git is not installed or could not be executed.' }
      }
      if (!statusRes.isRepo) {
        return { success: false, error: 'This workspace is not a Git repository.' }
      }

      const statusLines = statusRes.stdout.split(/\r?\n/).filter(Boolean)
      const hasStaged = statusLines.some((l) => {
        const x = l[0]
        return x !== ' ' && x !== '?'
      })

      if (!hasStaged) {
        return { success: false, error: 'No staged changes to commit. Please stage changes first.' }
      }

      const gitRes = await executeGitCommand(['commit', '-m', message.trim()], normalizedRoot)
      if (!gitRes.success) {
        const combinedErr = (gitRes.stderr + '\n' + gitRes.stdout).toLowerCase()
        if (
          combinedErr.includes('author identity unknown') ||
          combinedErr.includes('please tell me who you are') ||
          combinedErr.includes('*** please tell me who you are')
        ) {
          return {
            success: false,
            error:
              'Git author identity is not configured. Please configure your name and email using:\ngit config --global user.name "Your Name"\ngit config --global user.email "you@example.com"'
          }
        }
        if (combinedErr.includes('conflict') || combinedErr.includes('fix conflicts')) {
          return {
            success: false,
            error: 'Cannot commit while in a conflicted merge state. Resolve conflicts first.'
          }
        }
        return { success: false, error: gitRes.error || gitRes.stderr || 'Commit failed.' }
      }

      // Extract commit hash
      const hashRes = await executeGitCommand(['rev-parse', '--short', 'HEAD'], normalizedRoot)
      const commitHash = hashRes.success ? hashRes.stdout.trim() : undefined
      const summary = gitRes.stdout.split(/\r?\n/).find((l) => l.trim().length > 0) || undefined

      return {
        success: true,
        commitHash,
        summary
      }
    }
  )

  // Handle Listing Local Branches
  ipcMain.handle(
    IPC_CHANNELS.GIT_BRANCH_LIST,
    async (_event, workspaceRoot: string): Promise<GitBranchListResult> => {
      if (!workspaceRoot || !isSafePath(workspaceRoot)) {
        return {
          success: false,
          isRepository: false,
          currentBranch: null,
          branches: [],
          error: 'Invalid or missing workspace root.'
        }
      }

      const normalizedRoot = path.resolve(workspaceRoot)
      const gitRes = await executeGitCommand(['branch', '--list', '--no-color'], normalizedRoot)
      if (gitRes.notInstalled) {
        return {
          success: false,
          isRepository: false,
          currentBranch: null,
          branches: [],
          error: 'Git is not installed or could not be executed.'
        }
      }
      if (!gitRes.isRepo) {
        return {
          success: true,
          isRepository: false,
          currentBranch: null,
          branches: [],
          error: 'This workspace is not a Git repository.'
        }
      }

      let currentBranch: string | null = null
      const branches: string[] = []

      const lines = gitRes.stdout.split(/\r?\n/)
      for (const line of lines) {
        if (!line.trim()) continue
        const isCurrent = line.startsWith('* ')
        const bName = line.slice(2).trim()
        if (isCurrent) {
          if (bName.startsWith('(HEAD detached')) {
            currentBranch = 'HEAD (detached)'
          } else {
            currentBranch = bName
          }
        }
        if (!bName.startsWith('(HEAD detached')) {
          branches.push(bName)
        }
      }

      return {
        success: true,
        isRepository: true,
        currentBranch,
        branches
      }
    }
  )

  // Handle Creating and Checking out a New Branch
  ipcMain.handle(
    IPC_CHANNELS.GIT_BRANCH_CREATE,
    async (_event, workspaceRoot: string, branchName: string): Promise<GitBranchCreateResult> => {
      if (!workspaceRoot || !isSafePath(workspaceRoot)) {
        return { success: false, error: 'Invalid or missing workspace root.' }
      }

      const validation = isValidBranchName(branchName)
      if (!validation.valid) {
        return { success: false, error: validation.error || 'Invalid branch name.' }
      }

      const cleanBranch = (branchName as string).trim()
      const normalizedRoot = path.resolve(workspaceRoot)

      // Validate with Git's check-ref-format
      const checkRes = await executeGitCommand(['check-ref-format', '--branch', cleanBranch], normalizedRoot)
      if (checkRes.notInstalled) {
        return { success: false, error: 'Git is not installed or could not be executed.' }
      }
      if (!checkRes.isRepo) {
        return { success: false, error: 'This workspace is not a Git repository.' }
      }
      if (!checkRes.success) {
        return { success: false, error: `Invalid branch name format: '${cleanBranch}'.` }
      }

      const gitRes = await executeGitCommand(['checkout', '-b', cleanBranch], normalizedRoot)
      if (!gitRes.success) {
        if (gitRes.stderr.includes('already exists')) {
          return { success: false, error: `A branch named '${cleanBranch}' already exists.` }
        }
        return { success: false, error: gitRes.error || gitRes.stderr || 'Failed to create branch.' }
      }

      return { success: true, branch: cleanBranch }
    }
  )

  // Handle Switching to an Existing Branch
  ipcMain.handle(
    IPC_CHANNELS.GIT_BRANCH_CHECKOUT,
    async (_event, workspaceRoot: string, branchName: string): Promise<GitBranchCheckoutResult> => {
      if (!workspaceRoot || !isSafePath(workspaceRoot)) {
        return { success: false, error: 'Invalid or missing workspace root.' }
      }

      const validation = isValidBranchName(branchName)
      if (!validation.valid) {
        return { success: false, error: validation.error || 'Invalid branch name.' }
      }

      const cleanBranch = (branchName as string).trim()
      const normalizedRoot = path.resolve(workspaceRoot)

      const gitRes = await executeGitCommand(['checkout', cleanBranch], normalizedRoot)
      if (gitRes.notInstalled) {
        return { success: false, error: 'Git is not installed or could not be executed.' }
      }
      if (!gitRes.isRepo) {
        return { success: false, error: 'This workspace is not a Git repository.' }
      }
      if (!gitRes.success) {
        if (gitRes.stderr.includes('would be overwritten by checkout')) {
          return {
            success: false,
            error: 'Cannot switch branch: your uncommitted changes would be overwritten. Please commit or stash them first.'
          }
        }
        if (gitRes.stderr.includes('did not match any file(s) known to git')) {
          return { success: false, error: `Branch '${cleanBranch}' not found.` }
        }
        return { success: false, error: gitRes.error || gitRes.stderr || 'Failed to switch branch.' }
      }

      return { success: true, branch: cleanBranch }
    }
  )

  // Handle Retrieving Staged and Unstaged Diff for a Single File
  ipcMain.handle(
    IPC_CHANNELS.GIT_FILE_DIFF,
    async (_event, workspaceRoot: string, relativePath: string): Promise<GitFileDiffResult> => {
      const targetRes = resolveSafeWorkspaceTarget(workspaceRoot, relativePath)
      if (!targetRes.success) {
        return {
          success: false,
          isRepository: false,
          path: typeof relativePath === 'string' ? relativePath : '',
          unstagedDiff: '',
          stagedDiff: '',
          error: targetRes.error
        }
      }

      const normalizedRoot = targetRes.normalizedRoot
      const targetRel = targetRes.relativePath

      const unstagedRes = await executeGitCommand(['diff', '--no-color', '--', targetRel], normalizedRoot)
      if (unstagedRes.notInstalled) {
        return {
          success: false,
          isRepository: false,
          path: targetRel,
          unstagedDiff: '',
          stagedDiff: '',
          error: 'Git is not installed or could not be executed.'
        }
      }
      if (!unstagedRes.isRepo) {
        return {
          success: true,
          isRepository: false,
          path: targetRel,
          unstagedDiff: '',
          stagedDiff: '',
          error: 'This workspace is not a Git repository.'
        }
      }

      const stagedRes = await executeGitCommand(['diff', '--cached', '--no-color', '--', targetRel], normalizedRoot)

      let unstagedDiff = unstagedRes.stdout || ''
      let stagedDiff = stagedRes.stdout || ''

      // If both standard diffs are empty, check if the file is untracked in working tree
      if (!unstagedDiff && !stagedDiff) {
        const statusRes = await executeGitCommand(['status', '--porcelain=v1', '--', targetRel], normalizedRoot)
        if (statusRes.stdout.includes('?? ')) {
          const untrackedRes = await executeGitCommand(
            ['diff', '--no-index', '--no-color', '--', '/dev/null', targetRel],
            normalizedRoot
          )
          unstagedDiff = untrackedRes.stdout || ''
        }
      }

      const isBinary =
        unstagedRes.stdout.includes('Binary files differ') ||
        stagedRes.stdout.includes('Binary files differ') ||
        unstagedDiff.includes('Binary files differ')

      const MAX_DIFF = 50000
      let truncated = false

      if (unstagedDiff.length > MAX_DIFF) {
        unstagedDiff = unstagedDiff.slice(0, MAX_DIFF) + '\n\n[...diff truncated at 50,000 characters]'
        truncated = true
      }

      if (stagedDiff.length > MAX_DIFF) {
        stagedDiff = stagedDiff.slice(0, MAX_DIFF) + '\n\n[...diff truncated at 50,000 characters]'
        truncated = true
      }

      return {
        success: true,
        isRepository: true,
        path: targetRel,
        unstagedDiff,
        stagedDiff,
        isBinary,
        truncated
      }
    }
  )

  // Handle Discarding Changes for One Single Explicitly Validated File
  ipcMain.handle(
    IPC_CHANNELS.GIT_DISCARD_FILE,
    async (_event, workspaceRoot: string, relativePath: string): Promise<GitDiscardFileResult> => {
      const targetRes = resolveSafeWorkspaceTarget(workspaceRoot, relativePath)
      if (!targetRes.success) {
        return { success: false, error: targetRes.error }
      }

      const targetRel = targetRes.relativePath
      if (!targetRel || targetRel === '.' || targetRel === '*') {
        return {
          success: false,
          error: 'Discard operation requires one explicitly specified file path. Discarding all files is not permitted.'
        }
      }

      const normalizedRoot = targetRes.normalizedRoot
      const targetAbs = targetRes.normalizedTarget

      // Check current file status
      const statusRes = await executeGitCommand(['status', '--porcelain=v1', '--', targetRel], normalizedRoot)
      if (statusRes.notInstalled) {
        return { success: false, error: 'Git is not installed or could not be executed.' }
      }
      if (!statusRes.isRepo) {
        return { success: false, error: 'This workspace is not a Git repository.' }
      }

      const statusLine = statusRes.stdout.split(/\r?\n/).find((l) => l.includes(targetRel))

      // If file is untracked (??), safely unlink it
      if (statusLine && statusLine.startsWith('??')) {
        try {
          await fs.unlink(targetAbs)
          return { success: true, path: targetRel }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          return { success: false, error: `Failed to remove untracked file: ${msg}` }
        }
      }

      // If file was added in index (A  ), unstage and remove
      if (statusLine && statusLine.startsWith('A ')) {
        const rmRes = await executeGitCommand(['rm', '-f', '--', targetRel], normalizedRoot)
        if (!rmRes.success) {
          await executeGitCommand(['restore', '--staged', '--', targetRel], normalizedRoot)
          try {
            await fs.unlink(targetAbs)
          } catch {}
        }
        return { success: true, path: targetRel }
      }

      // Tracked file with modifications: restore from HEAD (restores both index and working tree)
      let restoreRes = await executeGitCommand(['restore', '--source=HEAD', '--staged', '--worktree', '--', targetRel], normalizedRoot)
      if (!restoreRes.success) {
        restoreRes = await executeGitCommand(['checkout', 'HEAD', '--', targetRel], normalizedRoot)
      }

      if (!restoreRes.success) {
        return { success: false, error: restoreRes.error || restoreRes.stderr || 'Failed to discard changes.' }
      }

      return { success: true, path: targetRel }
    }
  )
  console.log('[IPC] All main process IPC handlers registered successfully (including NVIDIA NIM)')
}

export {
  registerIpcHandlers,
  setupContentSecurityPolicy,
  terminalSessionManager,
  encryptSecret,
  decryptSecret,
  isEncryptionAvailable,
  getSettingsFilePath,
  loadSettings,
  saveSettings,
  cleanupOrphanSettingsTempFiles
}

const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  console.log('[App] Another instance is already running. Quitting...')
  app.quit()
} else {
  app.on('second-instance', () => {
    const windows = BrowserWindow.getAllWindows()
    if (windows.length > 0) {
      const mainWindow = windows[0]
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    cleanupOrphanSettingsTempFiles().catch((err) => {
      console.warn('[Settings] Failed to cleanup orphan settings temp files on startup:', err)
    })
    setupContentSecurityPolicy()
    registerIpcHandlers()
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('before-quit', async () => {
    try {
      await terminalSessionManager.killAllSessions()
    } catch (err) {
      console.error('[Terminal] Error during before-quit session cleanup:', err)
    }
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}
