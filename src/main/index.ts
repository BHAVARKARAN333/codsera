import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { join } from 'path'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as crypto from 'crypto'
import { watch, FSWatcher } from 'fs'
import { spawn, ChildProcess, exec } from 'child_process'
import {
  FileEntry,
  IPC_CHANNELS,
  OpenDirectoryResult,
  ReadFileResult,
  ReadWorkspaceFileResult,
  CreateWorkspaceFileResult,
  EditWorkspaceFileResult,
  WriteFileResult,
  RunCommandResult,
  GitStatusResult,
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
  OpenCodeModelItem
} from '../shared/types'
import { validateCommandSafety } from '../shared/commandValidator'

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
    if (!workspaceRoot || typeof workspaceRoot !== 'string') {
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
        const parts = rel.split(path.sep)
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

        // Determine event type
        let changeType: WorkspaceFileChangeType = 'change'
        try {
          const stat = await fs.stat(targetAbs)
          if (stat.isDirectory()) {
            // We ignore directory events, focus on file events
            return
          }
          if (eventType === 'rename') {
            changeType = 'add'
          } else {
            changeType = 'change'
          }
        } catch {
          // If stat fails, file was deleted
          changeType = 'unlink'
        }

        const payload: WorkspaceFileChangeEvent = {
          workspaceRoot: normalizedRoot.replace(/\\/g, '/'),
          relativePath: rel.replace(/\\/g, '/'),
          eventType: changeType
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
    if (!workspaceRoot || typeof workspaceRoot !== 'string' || !workspaceRoot.trim()) {
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
    if (!workspaceRoot || typeof workspaceRoot !== 'string' || !workspaceRoot.trim()) {
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
    if (!workspaceRoot || typeof workspaceRoot !== 'string' || !workspaceRoot.trim()) {
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

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 800,
    minHeight: 600,
    show: true,
    autoHideMenuBar: true,
    title: 'AI IDE',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
    mainWindow.focus()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // Load URL in dev, or local index.html in production
  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function getSettingsFilePath(): string {
  return path.join(app.getPath('userData'), 'settings.json')
}

async function loadSettings(): Promise<AppSettings> {
  try {
    const filePath = getSettingsFilePath()
    const data = await fs.readFile(filePath, 'utf-8')
    return JSON.parse(data)
  } catch {
    return {}
  }
}

async function saveSettings(partial: Partial<AppSettings>): Promise<void> {
  try {
    const current = await loadSettings()
    const updated: AppSettings = { ...current }

    if (partial.openRouterApiKey !== undefined) {
      if (typeof partial.openRouterApiKey === 'string' && partial.openRouterApiKey.trim()) {
        updated.openRouterApiKey = partial.openRouterApiKey.trim()
      } else {
        delete updated.openRouterApiKey
      }
    }

    if (partial.geminiApiKey !== undefined) {
      if (typeof partial.geminiApiKey === 'string' && partial.geminiApiKey.trim()) {
        updated.geminiApiKey = partial.geminiApiKey.trim()
      } else {
        delete updated.geminiApiKey
      }
    }

    if (partial.nvidiaApiKey !== undefined) {
      if (typeof partial.nvidiaApiKey === 'string' && partial.nvidiaApiKey.trim()) {
        updated.nvidiaApiKey = partial.nvidiaApiKey.trim()
      } else {
        delete updated.nvidiaApiKey
      }
    }

    if (partial.nvidiaModelId !== undefined) {
      if (typeof partial.nvidiaModelId === 'string' && partial.nvidiaModelId.trim()) {
        updated.nvidiaModelId = partial.nvidiaModelId.trim()
      } else {
        delete updated.nvidiaModelId
      }
    }

    if (partial.selectedProvider !== undefined) {
      updated.selectedProvider = partial.selectedProvider
    }

    if (partial.lastWorkspaceRoot !== undefined) {
      if (typeof partial.lastWorkspaceRoot === 'string' && partial.lastWorkspaceRoot.trim()) {
        updated.lastWorkspaceRoot = partial.lastWorkspaceRoot.trim()
      } else {
        delete updated.lastWorkspaceRoot
      }
    }

    const filePath = getSettingsFilePath()
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, JSON.stringify(updated, null, 2), 'utf-8')
  } catch (err) {
    console.error('Failed to save settings:', err)
  }
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
      await saveSettings({ lastWorkspaceRoot: rootPath })

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
        if (!rootPath || typeof rootPath !== 'string') {
          return { success: false, error: 'No workspace folder specified.' }
        }
        const tree = await readDirectoryTree(rootPath)
        return {
          success: true,
          rootPath,
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
        const content = await fs.readFile(filePath, 'utf-8')
        return { success: true, content }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return { success: false, error: message }
      }
    }
  )

  // Handle safe workspace file reading for the AI agent (with path traversal and directory guards)
  console.log('[IPC DEBUG] registering fs:readWorkspaceFile')
  ipcMain.handle(
    IPC_CHANNELS.READ_WORKSPACE_FILE,
    async (_event, rootPath: string, targetPath: string): Promise<ReadWorkspaceFileResult> => {
      try {
        if (!rootPath || typeof rootPath !== 'string') {
          return { success: false, error: 'No workspace folder is currently open.' }
        }
        if (!targetPath || typeof targetPath !== 'string' || !targetPath.trim()) {
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
        if (!rootPath || typeof rootPath !== 'string') {
          return { success: false, error: 'No workspace folder is currently open.' }
        }
        if (!targetPath || typeof targetPath !== 'string' || !targetPath.trim()) {
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
        if (!rootPath || typeof rootPath !== 'string') {
          return { success: false, error: 'No workspace folder is currently open.' }
        }
        if (!targetPath || typeof targetPath !== 'string' || !targetPath.trim()) {
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
        if (!filePath || typeof filePath !== 'string' || !filePath.trim()) {
          return { success: false, error: 'Invalid or missing file path.' }
        }
        if (typeof content !== 'string') {
          return { success: false, error: 'Invalid file content.' }
        }

        const normalizedTarget = path.resolve(filePath)
        await fs.mkdir(path.dirname(normalizedTarget), { recursive: true })
        await fs.writeFile(normalizedTarget, content, 'utf-8')
        return { success: true }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return { success: false, error: message }
      }
    }
  )

  // Handle compact token-efficient listing of project files for the AI Agent
  ipcMain.handle(
    IPC_CHANNELS.LIST_FILES,
    async (_event, rootPath: string, options?: { maxDepth?: number; relativePath?: string }) => {
      try {
        const targetPath = options?.relativePath
          ? path.resolve(rootPath, options.relativePath)
          : rootPath

        const maxDepth = options?.maxDepth ?? 5
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

  let activeChildProcess: ChildProcess | null = null

  // Handle running shell commands safely in workspace working directory
  ipcMain.handle(
    IPC_CHANNELS.RUN_COMMAND,
    async (
      _event,
      command: string,
      targetCwd?: string,
      timeoutMs: number = 60000
    ): Promise<RunCommandResult> => {
      if (!command || typeof command !== 'string' || !command.trim()) {
        return {
          success: false,
          stdout: '',
          stderr: '',
          exitCode: null,
          timedOut: false,
          error: 'No command specified.'
        }
      }

      // Ensure valid cwd
      let resolvedCwd = process.cwd()
      if (targetCwd && typeof targetCwd === 'string') {
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

      return new Promise<RunCommandResult>((resolve) => {
        let stdoutBuffer = ''
        let stderrBuffer = ''
        let isFinished = false
        let timer: NodeJS.Timeout | null = null

        const maxBufferLength = 50000

        try {
          const child = spawn(command, {
            cwd: resolvedCwd,
            shell: true,
            windowsHide: true,
            env: { ...process.env }
          })

          activeChildProcess = child

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
                activeChildProcess = null
                resolve({
                  success: false,
                  stdout: stdoutBuffer,
                  stderr: stderrBuffer + `\nCommand timed out after ${timeoutMs / 1000}s.`,
                  exitCode: null,
                  timedOut: true,
                  error: `Execution timed out after ${timeoutMs / 1000} seconds.`
                })
              }
            }, timeoutMs)
          }

          child.stdout?.on('data', (data) => {
            const str = data.toString()
            if (stdoutBuffer.length < maxBufferLength) {
              stdoutBuffer += str.slice(0, maxBufferLength - stdoutBuffer.length)
            }
          })

          child.stderr?.on('data', (data) => {
            const str = data.toString()
            if (stderrBuffer.length < maxBufferLength) {
              stderrBuffer += str.slice(0, maxBufferLength - stderrBuffer.length)
            }
          })

          child.on('error', (err) => {
            if (timer) clearTimeout(timer)
            if (!isFinished) {
              isFinished = true
              activeChildProcess = null
              resolve({
                success: false,
                stdout: stdoutBuffer,
                stderr: stderrBuffer,
                exitCode: null,
                timedOut: false,
                error: err.message
              })
            }
          })

          child.on('close', (code) => {
            if (timer) clearTimeout(timer)
            if (!isFinished) {
              isFinished = true
              activeChildProcess = null
              resolve({
                success: code === 0,
                stdout: stdoutBuffer,
                stderr: stderrBuffer,
                exitCode: code,
                timedOut: false
              })
            }
          })
        } catch (spawnErr: unknown) {
          if (timer) clearTimeout(timer)
          activeChildProcess = null
          const msg = spawnErr instanceof Error ? spawnErr.message : String(spawnErr)
          resolve({
            success: false,
            stdout: '',
            stderr: '',
            exitCode: null,
            timedOut: false,
            error: msg
          })
        }
      })
    }
  )

  // Handle stopping active child command
  ipcMain.handle(IPC_CHANNELS.STOP_COMMAND, async (): Promise<{ success: boolean }> => {
    try {
      if (activeChildProcess && activeChildProcess.pid) {
        if (process.platform === 'win32') {
          exec(`taskkill /pid ${activeChildProcess.pid} /T /F`)
        } else {
          activeChildProcess.kill('SIGTERM')
        }
        activeChildProcess = null
      }
      return { success: true }
    } catch {
      return { success: false }
    }
  })

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
      if (!rootPath || typeof rootPath !== 'string') {
        return {
          success: false,
          isRepository: false,
          branch: null,
          staged: [],
          unstaged: [],
          untracked: [],
          conflicted: [],
          clean: false,
          error: 'No workspace folder is currently open.'
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
        } else if (
          (x === 'U' || y === 'U') ||
          (x === 'A' && y === 'A') ||
          (x === 'D' && y === 'D')
        ) {
          conflicted.push(filePath)
        } else {
          // Check staged status (X)
          if (x !== ' ' && x !== '?') {
            staged.push(`${x} ${filePath}`)
          }
          // Check unstaged status (Y)
          if (y !== ' ' && y !== '?') {
            unstaged.push(`${y} ${filePath}`)
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
        clean
      }
    }
  )

  // Handle Read-Only Git Diff
  ipcMain.handle(
    IPC_CHANNELS.GIT_DIFF,
    async (_event, rootPath: string): Promise<GitDiffResult> => {
      if (!rootPath || typeof rootPath !== 'string') {
        return {
          success: false,
          isRepository: false,
          unstagedDiff: '',
          stagedDiff: '',
          error: 'No workspace folder is currently open.'
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
      if (!rootPath || typeof rootPath !== 'string') {
        return {
          success: false,
          isRepository: false,
          commits: [],
          error: 'No workspace folder is currently open.'
        }
      }

      const count = Math.min(Math.max(1, typeof maxCount === 'number' ? maxCount : 10), 25)
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
  console.log('[IPC] All main process IPC handlers registered successfully (including NVIDIA NIM)')
}

app.whenReady().then(() => {
  registerIpcHandlers()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
