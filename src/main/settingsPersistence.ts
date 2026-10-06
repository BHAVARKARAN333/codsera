import { app } from 'electron'
import path from 'path'
import fs from 'fs/promises'
import { encryptSecret, decryptSecret } from './safeStorage'
import type { AppSettings } from '../shared/types'

let customSettingsPathResolver: (() => string) | null = null

/**
 * Configure a custom settings path resolver (primarily for testing and overrides).
 */
export function setSettingsPathResolver(resolver: (() => string) | null): void {
  customSettingsPathResolver = resolver
}

/**
 * Resolves the absolute path to the production settings.json file.
 */
export function getSettingsFilePath(): string {
  if (customSettingsPathResolver) {
    return customSettingsPathResolver()
  }
  try {
    if (typeof app !== 'undefined' && typeof app.getPath === 'function') {
      return path.join(app.getPath('userData'), 'settings.json')
    }
  } catch {
    // If Electron app is not ready or app.getPath is unavailable
  }
  return path.join(process.cwd(), 'settings.json')
}

export interface AtomicWriteOptions {
  maxRetries?: number
  retryDelayMs?: number
}

const DEFAULT_MAX_RETRIES = 5
const DEFAULT_RETRY_DELAY_MS = 25

/**
 * Renames a file with exponential backoff retries to handle transient locks on Windows
 * (e.g. anti-virus, Windows Search indexer, or fleeting reader locks causing EPERM/EBUSY/EACCES).
 */
export async function renameWithRetry(
  sourcePath: string,
  targetPath: string,
  maxRetries = DEFAULT_MAX_RETRIES,
  delayMs = DEFAULT_RETRY_DELAY_MS
): Promise<void> {
  let attempt = 0
  while (true) {
    try {
      await fs.rename(sourcePath, targetPath)
      return
    } catch (err: unknown) {
      attempt++
      const nodeErr = err as { code?: string }
      const isTransientWindowsError =
        nodeErr && (nodeErr.code === 'EPERM' || nodeErr.code === 'EBUSY' || nodeErr.code === 'EACCES')
      if (attempt < maxRetries && isTransientWindowsError) {
        await new Promise((resolve) => setTimeout(resolve, delayMs * Math.pow(2, attempt - 1)))
        continue
      }
      throw err
    }
  }
}

/**
 * Atomically writes content to a target file using the write-to-temp-then-rename strategy.
 *
 * 1. Creates a unique temporary file in the same directory (preventing cross-device EXDEV).
 * 2. Writes the full content.
 * 3. Flushes OS buffers to physical disk via fileHandle.sync().
 * 4. Closes the file handle before attempting rename (mandatory on Windows).
 * 5. Replaces the destination file using renameWithRetry.
 * 6. In case of ANY error (write failure, sync failure, or replacement failure), the temp file
 *    is cleaned up immediately, and the pre-existing target file remains completely untouched.
 */
export async function atomicWriteFile(
  targetPath: string,
  content: string,
  options?: AtomicWriteOptions
): Promise<void> {
  const dir = path.dirname(targetPath)
  await fs.mkdir(dir, { recursive: true })

  const tempFileName = `.settings.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
  const tempPath = path.join(dir, tempFileName)

  let fileHandle: fs.FileHandle | null = null
  let writeSuccess = false

  try {
    // 1. Open temp file exclusively for writing
    fileHandle = await fs.open(tempPath, 'w')

    // 2. Write complete content
    await fileHandle.writeFile(content, 'utf-8')

    // 3. Flush to physical storage
    await fileHandle.sync()

    // 4. Close the handle before renaming (essential for Windows file locking semantics)
    await fileHandle.close()
    fileHandle = null

    // 5. Atomically replace target file
    await renameWithRetry(
      tempPath,
      targetPath,
      options?.maxRetries,
      options?.retryDelayMs
    )

    writeSuccess = true
  } finally {
    if (fileHandle) {
      try {
        await fileHandle.close()
      } catch {
        // Ignore close error on cleanup
      }
    }

    if (!writeSuccess) {
      try {
        await fs.unlink(tempPath)
      } catch {
        // Ignore unlink error if temp file does not exist
      }
    }
  }
}

/**
 * Cleans up any orphaned .settings.*.tmp files in the settings directory
 * (e.g. from prior power loss or abrupt process termination).
 */
export async function cleanupOrphanSettingsTempFiles(dirPath?: string): Promise<number> {
  try {
    const dir = dirPath || path.dirname(getSettingsFilePath())
    const entries = await fs.readdir(dir)
    let cleanedCount = 0
    for (const entry of entries) {
      if (entry.startsWith('.settings.') && entry.endsWith('.tmp')) {
        const fullPath = path.join(dir, entry)
        try {
          await fs.unlink(fullPath)
          cleanedCount++
        } catch {
          // Ignore files that may currently be in use or inaccessible
        }
      }
    }
    return cleanedCount
  } catch {
    return 0
  }
}

// Queue of pending settings operations to serialize concurrent writes and prevent race conditions
let saveQueue: Promise<void> = Promise.resolve()

/**
 * Serializes settings save operations so that concurrent calls execute in strict order.
 * Catches errors on queue links so a failed save does not break subsequent saves.
 */
export function serializeSettingsOperation<T>(operation: () => Promise<T>): Promise<T> {
  const current = saveQueue.then(operation, operation)
  saveQueue = current.then(
    () => {},
    () => {}
  )
  return current
}

export function resetSettingsQueueForTesting(): void {
  saveQueue = Promise.resolve()
}

/**
 * Loads and decrypts application settings from disk.
 * If file is missing or corrupted, returns an empty settings object {} without throwing.
 */
export async function loadSettings(customPath?: string): Promise<AppSettings> {
  try {
    const filePath = customPath || getSettingsFilePath()
    const data = await fs.readFile(filePath, 'utf-8')
    const settings: AppSettings = JSON.parse(data)

    if (settings.openRouterApiKey) {
      settings.openRouterApiKey = decryptSecret(settings.openRouterApiKey)
    }
    if (settings.geminiApiKey) {
      settings.geminiApiKey = decryptSecret(settings.geminiApiKey)
    }
    if (settings.nvidiaApiKey) {
      settings.nvidiaApiKey = decryptSecret(settings.nvidiaApiKey)
    }
    if (settings.opencodeApiKey) {
      settings.opencodeApiKey = decryptSecret(settings.opencodeApiKey)
    }

    return settings
  } catch {
    return {}
  }
}

/**
 * Sanitizes, encrypts, and atomically persists partial settings updates.
 * Queues concurrent writes to prevent lost updates or temporary-file collisions.
 */
export async function saveSettings(
  partial: Partial<AppSettings>,
  customPath?: string
): Promise<void> {
  return serializeSettingsOperation(async () => {
    const filePath = customPath || getSettingsFilePath()
    const current = await loadSettings(filePath)
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

    if (partial.opencodeApiKey !== undefined) {
      if (typeof partial.opencodeApiKey === 'string' && partial.opencodeApiKey.trim()) {
        updated.opencodeApiKey = partial.opencodeApiKey.trim()
      } else {
        delete updated.opencodeApiKey
      }
    }

    if (partial.opencodeModelId !== undefined) {
      if (typeof partial.opencodeModelId === 'string' && partial.opencodeModelId.trim()) {
        updated.opencodeModelId = partial.opencodeModelId.trim()
      } else {
        delete updated.opencodeModelId
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

    const toSave: AppSettings = { ...updated }
    if (toSave.openRouterApiKey) {
      toSave.openRouterApiKey = encryptSecret(toSave.openRouterApiKey)
    }
    if (toSave.geminiApiKey) {
      toSave.geminiApiKey = encryptSecret(toSave.geminiApiKey)
    }
    if (toSave.nvidiaApiKey) {
      toSave.nvidiaApiKey = encryptSecret(toSave.nvidiaApiKey)
    }
    if (toSave.opencodeApiKey) {
      toSave.opencodeApiKey = encryptSecret(toSave.opencodeApiKey)
    }

    try {
      await atomicWriteFile(filePath, JSON.stringify(toSave, null, 2))
    } catch (err) {
      console.error('Failed to save settings:', err)
      throw err
    }
  })
}
