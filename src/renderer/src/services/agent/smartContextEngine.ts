import {
  FileEntry,
  WorkspaceFileChangeEvent,
  WorkspaceFileChangeType
} from '../../../../shared/types'
import { ContextCache, ContextCacheStats, computeContentHash } from './contextCache'
import { ContextBudgetManager, DroppedContextFile } from './contextBudgetManager'
import { ContextDeduplicator } from './contextDeduplicator'
import {
  DependencyAnalyzer,
  DependencyGraphNode,
  SymbolReference
} from './dependencyAnalyzer'
import { CodebaseIndex, ProjectSummary, yieldToMain } from './codebaseIndex'

export interface RankedCandidate {
  path: string
  score: number
  matchReason: string
  isExplicit?: boolean
}

export interface SmartContextFile {
  path: string
  content: string
  truncated: boolean
  charCount: number
  score: number
  isExplicit: boolean
}

export interface SmartContextResult {
  required: boolean
  reason?: string
  selectedFiles: RankedCandidate[]
  readFiles: SmartContextFile[]
  droppedFiles: DroppedContextFile[]
  formattedContext: string
  cacheStats?: ContextCacheStats
  dependencyGraph?: DependencyGraphNode | null
  dependencyGraphs?: DependencyGraphNode[]
  symbolReferences?: SymbolReference[]
  projectSummary?: ProjectSummary | null
}

export interface SmartContextEngineConfig {
  maxCandidates?: number
  maxAutoReadFiles?: number
  maxDependencyCandidates?: number
  maxFileChars?: number
  maxTotalContextChars?: number
  minScoreThreshold?: number
  watcherBatchDebounceMs?: number
  debug?: boolean
}

/**
 * Coalesces consecutive filesystem event types for the same file within a single debounce batch.
 */
export function coalesceEventTypes(
  prevType: WorkspaceFileChangeType,
  newType: WorkspaceFileChangeType
): WorkspaceFileChangeType {
  if (prevType === 'add') {
    if (newType === 'unlink') return 'unlink'
    return 'add' // 'add' + 'change' => 'add'
  }
  if (prevType === 'change') {
    if (newType === 'unlink') return 'unlink'
    return 'change' // 'change' + 'add' / 'change' + 'change' => 'change'
  }
  if (prevType === 'unlink') {
    if (newType === 'add' || newType === 'change') return 'change' // unlinked then recreated => 'change'
    return 'unlink'
  }
  return newType
}

const BINARY_AND_ASSET_EXTS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'ico',
  'webp',
  'svg',
  'mp4',
  'mp3',
  'pdf',
  'zip',
  'tar',
  'gz',
  'exe',
  'dll',
  'dylib',
  'so',
  'bin',
  'woff',
  'woff2',
  'ttf',
  'eot',
  'map',
  'wasm'
])

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'out',
  '.vscode',
  '.idea',
  '.cache',
  'coverage',
  '.parcel-cache'
])

const COMMON_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'has',
  'he',
  'in',
  'is',
  'it',
  'its',
  'of',
  'on',
  'that',
  'the',
  'to',
  'was',
  'were',
  'will',
  'with',
  'what',
  'how',
  'where',
  'which',
  'who',
  'why',
  'can',
  'could',
  'does',
  'do',
  'this',
  'our',
  'my',
  'me',
  'please',
  'tell',
  'explain',
  'show',
  'find'
])

/**
 * Safely extracts relative workspace path from an entry path, respecting OS platform casing
 * and enforcing strict path boundaries so sibling directories (e.g. C:/project-other)
 * are never mistaken for children of C:/project.
 *
 * Returns normalized relative path (e.g. "src/index.ts") or "" if fullPath equals workspaceRoot.
 * Returns null if fullPath is an absolute path that is outside workspaceRoot.
 */
export function toRelativeWorkspacePath(fullPath: string, workspaceRoot: string): string | null {
  const normEntry = fullPath.replace(/\\/g, '/')
  const normRoot = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '')

  if (!normRoot) {
    const clean = normEntry.replace(/^\/+/, '')
    return clean || null
  }

  const isWindows =
    (typeof process !== 'undefined' && process.platform === 'win32') ||
    (typeof navigator !== 'undefined' && /win/i.test(navigator.userAgent || navigator.platform || ''))

  const rootPrefix = normRoot + '/'

  if (isWindows) {
    const entryLower = normEntry.toLowerCase()
    const rootLower = normRoot.toLowerCase()
    const prefixLower = rootPrefix.toLowerCase()

    if (entryLower === rootLower) {
      return ''
    }
    if (entryLower.startsWith(prefixLower)) {
      return normEntry.slice(rootPrefix.length).replace(/^\/+/, '')
    }
  } else {
    if (normEntry === normRoot) {
      return ''
    }
    if (normEntry.startsWith(rootPrefix)) {
      return normEntry.slice(rootPrefix.length).replace(/^\/+/, '')
    }
  }

  // Check if fullPath was an absolute path that does not belong to workspaceRoot
  const isAbsolute = /^[a-zA-Z]:[\\/]/.test(fullPath) || fullPath.startsWith('/') || fullPath.startsWith('\\')
  if (isAbsolute) {
    return null
  }

  // It was already a relative path
  return normEntry.replace(/^\/+/, '')
}

export class SmartContextEngine {
  private config: Required<SmartContextEngineConfig>
  private cache: ContextCache
  private budgetManager: ContextBudgetManager
  private deduplicator: ContextDeduplicator
  private dependencyAnalyzer: DependencyAnalyzer
  private codebaseIndex: CodebaseIndex
  private currentWorkspaceRoot: string | null = null

  constructor(config?: SmartContextEngineConfig) {
    const maxCandidates = config?.maxCandidates ?? 15
    const maxAutoReadFiles = config?.maxAutoReadFiles ?? 3
    const maxDependencyCandidates = config?.maxDependencyCandidates ?? 5
    const maxFileChars = config?.maxFileChars ?? 12000
    const maxTotalContextChars = config?.maxTotalContextChars ?? 30000
    const minScoreThreshold = config?.minScoreThreshold ?? 40
    const watcherBatchDebounceMs = config?.watcherBatchDebounceMs ?? 50
    const debug = config?.debug ?? false

    this.config = {
      maxCandidates,
      maxAutoReadFiles,
      maxDependencyCandidates,
      maxFileChars,
      maxTotalContextChars,
      minScoreThreshold,
      watcherBatchDebounceMs,
      debug
    }

    this.cache = new ContextCache(debug)
    this.budgetManager = new ContextBudgetManager({
      maxBudget: maxTotalContextChars,
      maxFileChars,
      minScoreThreshold
    })
    this.deduplicator = new ContextDeduplicator(debug)
    this.dependencyAnalyzer = new DependencyAnalyzer({
      maxDependencyCandidates,
      debug
    })
    this.codebaseIndex = new CodebaseIndex(this.dependencyAnalyzer, debug)
  }

  setDebug(enabled: boolean): void {
    this.config.debug = enabled
    this.cache.setDebug(enabled)
    this.budgetManager.setDebug(enabled)
    this.deduplicator.setDebug(enabled)
    this.dependencyAnalyzer.setDebug(enabled)
    this.codebaseIndex.setDebug(enabled)
  }

  getCache(): ContextCache {
    return this.cache
  }

  getBudgetManager(): ContextBudgetManager {
    return this.budgetManager
  }

  getDeduplicator(): ContextDeduplicator {
    return this.deduplicator
  }

  getDependencyAnalyzer(): DependencyAnalyzer {
    return this.dependencyAnalyzer
  }

  getCodebaseIndex(): CodebaseIndex {
    return this.codebaseIndex
  }

  private activeIndexingSession = 0
  private indexedWorkspaceRoot: string | null = null
  private restoredWorkspaceRoot: string | null = null
  private isIndexRestored = false
  private isIndexFresh = false
  private isIndexing = false
  private isReconciling = false
  private queuedWatcherEventsDuringRestore: WorkspaceFileChangeEvent[] = []
  private saveIndexDebounceTimer: ReturnType<typeof setTimeout> | null = null
  private pendingEventBatch: Map<string, WorkspaceFileChangeEvent> = new Map()
  private watcherBatchTimer: ReturnType<typeof setTimeout> | null = null
  private isProcessingEventBatch = false
  private batchResolvers: Array<() => void> = []
  private recentlyModifiedBySelf: Map<string, number> = new Map()

  /**
   * Returns the count of pending file events in the active batch.
   */
  getPendingEventBatchCount(): number {
    return this.pendingEventBatch.size
  }

  /**
   * Clears in-memory file read cache, deduplication state, dependency analysis graph, and codebase index.
   */
  clearCache(): void {
    this.activeIndexingSession++
    this.isIndexing = false
    if (this.saveIndexDebounceTimer) {
      clearTimeout(this.saveIndexDebounceTimer)
      this.saveIndexDebounceTimer = null
    }
    this.isReconciling = false
    this.queuedWatcherEventsDuringRestore = []
    if (this.watcherBatchTimer) {
      clearTimeout(this.watcherBatchTimer)
      this.watcherBatchTimer = null
    }
    this.pendingEventBatch.clear()
    this.isProcessingEventBatch = false
    const resolvers = [...this.batchResolvers]
    this.batchResolvers = []
    resolvers.forEach((r) => r())
    this.recentlyModifiedBySelf.clear()
    this.cache.clear()
    this.deduplicator.reset()
    this.dependencyAnalyzer.clearCache()
    this.codebaseIndex.clear()
    this.indexedWorkspaceRoot = null
    this.restoredWorkspaceRoot = null
    this.isIndexRestored = false
    this.isIndexFresh = false
  }

  /**
   * Handles workspace switch (clears cache if workspace changed).
   */
  onWorkspaceChange(newWorkspaceRoot: string | null): void {
    const normalizedNew = newWorkspaceRoot
      ? newWorkspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '')
      : null
    if (this.currentWorkspaceRoot !== normalizedNew) {
      if (this.config.debug) {
        console.debug(
          `[SmartContextEngine] Workspace changed from "${this.currentWorkspaceRoot}" to "${normalizedNew}". Clearing cache.`
        )
      }
      this.currentWorkspaceRoot = normalizedNew
      this.clearCache()
    }
  }

  /**
   * Initializes or updates the workspace index when a workspace is opened or switched.
   * Prevents duplicate builds for the same workspace and eliminates race conditions
   * when workspaces are switched rapidly.
   */
  async initializeWorkspaceIndex(workspaceRoot: string | null): Promise<void> {
    if (!workspaceRoot) {
      this.currentWorkspaceRoot = null
      this.clearCache()
      return
    }

    const normalizedRoot = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '')

    // If workspace changed, clear prior cache immediately
    if (this.currentWorkspaceRoot !== normalizedRoot) {
      this.currentWorkspaceRoot = normalizedRoot
      this.clearCache()
    }

    // If already indexed fresh for this exact workspace, avoid redundant full rebuild
    if (this.indexedWorkspaceRoot === normalizedRoot) {
      if (this.config.debug) {
        console.debug(
          `[SmartContextEngine] Workspace "${normalizedRoot}" is already indexed. Skipping redundant rebuild.`
        )
      }
      return
    }

    // If already restored from storage and matches current workspace, avoid duplicate restoration
    if (this.restoredWorkspaceRoot === normalizedRoot) {
      if (this.config.debug) {
        console.debug(
          `[SmartContextEngine] Workspace "${normalizedRoot}" is already restored from persistent index.`
        )
      }
      return
    }

    // Increment session ID to cancel/ignore any in-flight indexing from previous workspace
    const sessionId = ++this.activeIndexingSession
    this.isIndexing = true

    try {
      if (typeof window === 'undefined' || !window.electronAPI) {
        if (this.config.debug) {
          console.debug('[SmartContextEngine] Electron API unavailable for workspace indexing.')
        }
        return
      }

      // 1. Attempt to restore persistent index from disk before running full build
      let restored = false
      if (window.electronAPI.loadWorkspaceIndex) {
        try {
          const loadRes = await window.electronAPI.loadWorkspaceIndex(normalizedRoot)
          if (sessionId !== this.activeIndexingSession) return

          if (loadRes.success && loadRes.data) {
            const ok = this.codebaseIndex.deserialize(loadRes.data, normalizedRoot)
            if (ok && sessionId === this.activeIndexingSession) {
              restored = true
              this.restoredWorkspaceRoot = normalizedRoot
              this.isIndexRestored = true
              this.isIndexFresh = false // Restored, but not yet verified as fresh
              if (this.config.debug) {
                console.debug(
                  `[SmartContextEngine] Restored persistent index for "${normalizedRoot}" (${this.codebaseIndex.getAllFilePaths().length} files).`
                )
              }
            }
          }
        } catch (loadErr) {
          if (this.config.debug) {
            console.debug(
              '[SmartContextEngine] Persistent index load failed, falling back to full build:',
              loadErr
            )
          }
        }
      }

      // If successfully restored from disk, reconcile with current disk state
      if (restored) {
        let reconciliationSucceeded = false
        this.isReconciling = true
        this.queuedWatcherEventsDuringRestore = []

        try {
          reconciliationSucceeded = await this.reconcileRestoredIndex(normalizedRoot, sessionId)
        } catch (recErr) {
          if (this.config.debug) {
            console.debug('[SmartContextEngine] Error during reconciliation:', recErr)
          }
          reconciliationSucceeded = false
        } finally {
          this.isReconciling = false
        }

        if (sessionId !== this.activeIndexingSession) return

        if (reconciliationSucceeded) {
          this.indexedWorkspaceRoot = normalizedRoot
          this.isIndexFresh = true
          this.isIndexRestored = true
          if (this.config.debug) {
            console.debug(
              `[SmartContextEngine] Offline reconciliation completed successfully for "${normalizedRoot}".`
            )
          }

          // Replay queued watcher events that arrived during reconciliation
          await this.replayQueuedWatcherEvents(sessionId)
          return
        }

        // If reconciliation failed, fall back to full build
        if (this.config.debug) {
          console.debug(
            `[SmartContextEngine] Reconciliation failed; falling back to full build for "${normalizedRoot}".`
          )
        }
        this.restoredWorkspaceRoot = null
        this.isIndexRestored = false
        this.isIndexFresh = false
      }

      // 2. Fall back to existing full indexing behavior if index is missing, incompatible, or reconciliation failed
      const treeRes = await window.electronAPI.readTree(normalizedRoot)
      if (sessionId !== this.activeIndexingSession) {
        // Workspace was switched while reading tree; discard result
        this.queuedWatcherEventsDuringRestore = []
        return
      }

      if (!treeRes.success || !Array.isArray(treeRes.tree)) {
        if (this.config.debug) {
          console.debug(
            `[SmartContextEngine] Failed to read workspace tree for "${normalizedRoot}": ${treeRes.error || 'Unknown error'}`
          )
        }
        // Failure path: clear any queued events from the failed restore/reconciliation session
        this.queuedWatcherEventsDuringRestore = []
        return
      }

      const treeEntries = treeRes.tree
      const filePaths = this.extractRelativePaths(treeEntries, normalizedRoot)
      const fileMetadataMap = this.extractFileMetadataMap(treeEntries, normalizedRoot)

      if (filePaths.length === 0) {
        // Only mark index fresh if readTree explicitly succeeded and confirmed the tree has no indexable files
        if (sessionId === this.activeIndexingSession) {
          this.indexedWorkspaceRoot = normalizedRoot
          this.isIndexFresh = true
          this.isIndexRestored = false
          await this.replayQueuedWatcherEvents(sessionId)
        } else {
          this.queuedWatcherEventsDuringRestore = []
        }
        return
      }

      // Safe file reader through Electron API and ContextCache
      const fileReader = async (relPath: string): Promise<string | null> => {
        if (sessionId !== this.activeIndexingSession) return null

        const cached = this.cache.get(relPath)
        if (cached) return cached.content

        const res = await window.electronAPI.readWorkspaceFile(normalizedRoot, relPath)
        if (sessionId !== this.activeIndexingSession) return null

        if (res.success && typeof res.content === 'string') {
          this.cache.set(relPath, res.content)
          return res.content
        }
        return null
      }

      // Build codebase index with metadata map for future fast-paths in bounded chunks
      const buildOk = await this.codebaseIndex.buildIndex(
        normalizedRoot,
        filePaths,
        fileReader,
        fileMetadataMap,
        () => sessionId !== this.activeIndexingSession || this.currentWorkspaceRoot !== normalizedRoot,
        25
      )

      // Only mark as successfully indexed if session and workspace root are still current
      if (buildOk && sessionId === this.activeIndexingSession && this.currentWorkspaceRoot === normalizedRoot) {
        this.indexedWorkspaceRoot = normalizedRoot
        this.restoredWorkspaceRoot = null
        this.isIndexFresh = true
        this.isIndexRestored = false
        if (this.config.debug) {
          console.debug(
            `[SmartContextEngine] Background workspace indexing completed for "${normalizedRoot}".`
          )
        }

        // Save index after successful full build
        if (window.electronAPI.saveWorkspaceIndex) {
          window.electronAPI
            .saveWorkspaceIndex(normalizedRoot, this.codebaseIndex.serialize())
            .catch((err) => {
              if (this.config.debug) {
                console.debug('[SmartContextEngine] Failed to save persistent workspace index:', err)
              }
            })
        }

        // Replay any queued watcher events from the reconciliation/build period so no file events are lost
        await this.replayQueuedWatcherEvents(sessionId)
      } else {
        this.queuedWatcherEventsDuringRestore = []
        if (sessionId === this.activeIndexingSession && this.currentWorkspaceRoot === normalizedRoot) {
          this.codebaseIndex.clear()
        }
      }
    } catch (err: unknown) {
      this.queuedWatcherEventsDuringRestore = []
      if (sessionId === this.activeIndexingSession && this.currentWorkspaceRoot === normalizedRoot) {
        this.codebaseIndex.clear()
      }
      // Safe error recovery: never throw or block UI
      if (this.config.debug) {
        console.debug(`[SmartContextEngine] Non-fatal error during workspace indexing:`, err)
      }
    } finally {
      if (sessionId === this.activeIndexingSession) {
        this.isIndexing = false
      }
    }
  }

  /**
   * Safely reconciles a restored persistent index against current disk state.
   * Returns true on success, or false if reconciliation failed (triggering fallback to full build).
   */
  private async reconcileRestoredIndex(
    normalizedRoot: string,
    sessionId: number
  ): Promise<boolean> {
    if (typeof window === 'undefined' || !window.electronAPI) {
      return false
    }

    // 1. Read current workspace tree and metadata from disk
    const treeRes = await window.electronAPI.readTree(normalizedRoot)
    if (sessionId !== this.activeIndexingSession) return false
    if (!treeRes.success || !treeRes.tree) {
      return false
    }

    const diskFileMap = this.extractFileMetadataMap(treeRes.tree, normalizedRoot)
    const diskPaths = Array.from(diskFileMap.keys())
    const diskPathSet = new Set(diskPaths.map((p) => p.toLowerCase()))

    const indexedPaths = this.codebaseIndex.getAllFilePaths()
    const indexedPathSet = new Set(indexedPaths.map((p) => p.toLowerCase()))

    let indexChanged = false

    // 2. Identify & remove deleted files (files in index that no longer exist on disk)
    let deletedCount = 0
    for (const indexedPath of indexedPaths) {
      if (sessionId !== this.activeIndexingSession || this.currentWorkspaceRoot !== normalizedRoot) return false
      const lower = indexedPath.toLowerCase()
      if (!diskPathSet.has(lower)) {
        this.codebaseIndex.removeFile(indexedPath)
        this.cache.invalidate(indexedPath)
        this.deduplicator.invalidateFile(indexedPath)
        this.dependencyAnalyzer.invalidateFile(indexedPath)
        indexChanged = true
        if (this.config.debug) {
          console.debug(
            `[SmartContextEngine] Reconcile: removed deleted file "${indexedPath}" from index`
          )
        }
        deletedCount++
        if (deletedCount % 25 === 0) {
          await yieldToMain()
          if (sessionId !== this.activeIndexingSession || this.currentWorkspaceRoot !== normalizedRoot) return false
        }
      }
    }

    // 3. Identify & index newly created files (files on disk not present in index)
    let createdCount = 0
    for (const diskPath of diskPaths) {
      if (sessionId !== this.activeIndexingSession || this.currentWorkspaceRoot !== normalizedRoot) return false
      const lower = diskPath.toLowerCase()
      if (!indexedPathSet.has(lower)) {
        try {
          const res = await window.electronAPI.readWorkspaceFile(normalizedRoot, diskPath)
          if (sessionId !== this.activeIndexingSession || this.currentWorkspaceRoot !== normalizedRoot) return false

          if (res.success && typeof res.content === 'string') {
            const meta = diskFileMap.get(diskPath)
            this.cache.set(diskPath, res.content)
            this.codebaseIndex.indexFile(
              diskPath,
              res.content,
              diskPaths,
              meta?.mtimeMs,
              meta?.size ?? res.content.length
            )
            indexChanged = true
            if (this.config.debug) {
              console.debug(
                `[SmartContextEngine] Reconcile: added new file "${diskPath}" to index`
              )
            }
          }
        } catch (err) {
          if (this.config.debug) {
            console.debug(`[SmartContextEngine] Failed reading new file "${diskPath}":`, err)
          }
        }
        createdCount++
        if (createdCount % 25 === 0) {
          await yieldToMain()
          if (sessionId !== this.activeIndexingSession || this.currentWorkspaceRoot !== normalizedRoot) return false
        }
      }
    }

    // 4. Verify freshness for common files
    let freshnessCheckCount = 0
    for (const relPath of diskPaths) {
      if (sessionId !== this.activeIndexingSession || this.currentWorkspaceRoot !== normalizedRoot) return false
      const lower = relPath.toLowerCase()
      if (!indexedPathSet.has(lower)) {
        // Handled above as new file
        continue
      }

      const existingEntry = this.codebaseIndex.findFile(relPath)
      if (!existingEntry) continue

      const diskMeta = diskFileMap.get(relPath)

      // Fast-path heuristic: If both size and mtimeMs exist and match exactly, file is unchanged.
      const hasFastMeta =
        diskMeta &&
        typeof diskMeta.size === 'number' &&
        typeof diskMeta.mtimeMs === 'number' &&
        typeof existingEntry.mtimeMs === 'number'

      const isFastMatch =
        hasFastMeta &&
        diskMeta.size === existingEntry.fileSize &&
        diskMeta.mtimeMs === existingEntry.mtimeMs

      if (isFastMatch) {
        // Zero file-read overhead: file is verified fresh via metadata fast-path
        freshnessCheckCount++
        if (freshnessCheckCount % 50 === 0) {
          await yieldToMain()
          if (sessionId !== this.activeIndexingSession || this.currentWorkspaceRoot !== normalizedRoot) return false
        }
        continue
      }

      // Metadata changed or unavailable: read file to verify content hash
      try {
        const res = await window.electronAPI.readWorkspaceFile(normalizedRoot, relPath)
        if (sessionId !== this.activeIndexingSession || this.currentWorkspaceRoot !== normalizedRoot) return false

        if (!res.success || typeof res.content !== 'string') {
          // File failed to read: remove from index
          this.codebaseIndex.removeFile(relPath)
          this.cache.invalidate(relPath)
          this.deduplicator.invalidateFile(relPath)
          this.dependencyAnalyzer.invalidateFile(relPath)
          indexChanged = true
        } else {
          const currentHash = computeContentHash(res.content)
          if (currentHash === existingEntry.contentHash) {
            // Content hash is identical: update mtimeMs and fileSize without reparsing AST
            this.codebaseIndex.updateFileMetadata(
              relPath,
              diskMeta?.mtimeMs,
              diskMeta?.size ?? res.content.length
            )
            this.cache.set(relPath, res.content)
            indexChanged = true
          } else {
            // Content hash changed: full incremental AST re-parse and dependency update
            this.cache.set(relPath, res.content)
            this.deduplicator.invalidateFile(relPath)
            this.dependencyAnalyzer.invalidateFile(relPath)
            this.codebaseIndex.updateFile(
              relPath,
              res.content,
              diskPaths,
              diskMeta?.mtimeMs,
              diskMeta?.size ?? res.content.length
            )
            indexChanged = true
            if (this.config.debug) {
              console.debug(
                `[SmartContextEngine] Reconcile: updated modified file "${relPath}" in index`
              )
            }
          }
        }
      } catch (err) {
        if (this.config.debug) {
          console.debug(
            `[SmartContextEngine] Error verifying freshness for "${relPath}":`,
            err
          )
        }
      }

      freshnessCheckCount++
      if (freshnessCheckCount % 50 === 0) {
        await yieldToMain()
        if (sessionId !== this.activeIndexingSession || this.currentWorkspaceRoot !== normalizedRoot) return false
      }
    }

    // 5. If index changed during reconciliation, persist updated index
    if (
      indexChanged &&
      window.electronAPI.saveWorkspaceIndex &&
      sessionId === this.activeIndexingSession &&
      this.currentWorkspaceRoot === normalizedRoot
    ) {
      try {
        await window.electronAPI.saveWorkspaceIndex(
          normalizedRoot,
          this.codebaseIndex.serialize()
        )
      } catch (err) {
        if (this.config.debug) {
          console.debug('[SmartContextEngine] Error saving reconciled index:', err)
        }
      }
    }

    return sessionId === this.activeIndexingSession && this.currentWorkspaceRoot === normalizedRoot
  }

  /**
   * Replays watcher events that were queued while offline reconciliation was in progress.
   */
  private async replayQueuedWatcherEvents(sessionId: number): Promise<void> {
    const queued = [...this.queuedWatcherEventsDuringRestore]
    this.queuedWatcherEventsDuringRestore = []

    const promises: Promise<void>[] = []
    for (const event of queued) {
      if (sessionId !== this.activeIndexingSession) return
      promises.push(this.handleFileEvent(event))
    }
    await Promise.all(promises)
  }

  /**
   * Schedules a debounced persistent save of the codebase index (1s debounce window).
   */
  scheduleSaveWorkspaceIndex(workspaceRoot: string): void {
    if (typeof window === 'undefined' || !window.electronAPI?.saveWorkspaceIndex) {
      return
    }

    const normalizedRoot = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '')

    if (this.saveIndexDebounceTimer) {
      clearTimeout(this.saveIndexDebounceTimer)
    }

    this.saveIndexDebounceTimer = setTimeout(async () => {
      this.saveIndexDebounceTimer = null
      if (this.currentWorkspaceRoot !== normalizedRoot) {
        return
      }

      try {
        await window.electronAPI.saveWorkspaceIndex(
          normalizedRoot,
          this.codebaseIndex.serialize()
        )
        if (this.config.debug) {
          console.debug(
            `[SmartContextEngine] Debounced save of persistent index completed for "${normalizedRoot}".`
          )
        }
      } catch (err) {
        if (this.config.debug) {
          console.debug('[SmartContextEngine] Failed debounced save of persistent index:', err)
        }
      }
    }, 1000)
  }

  isWorkspaceIndexed(workspaceRoot?: string | null): boolean {
    if (workspaceRoot) {
      const norm = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '')
      return this.indexedWorkspaceRoot === norm || this.restoredWorkspaceRoot === norm
    }
    return this.indexedWorkspaceRoot !== null || this.restoredWorkspaceRoot !== null
  }

  isWorkspaceIndexFresh(): boolean {
    return this.isIndexFresh
  }

  isWorkspaceIndexRestored(): boolean {
    return this.isIndexRestored
  }

  isWorkspaceIndexReconciling(): boolean {
    return this.isReconciling
  }

  getIndexingStatus(): {
    isIndexing: boolean
    indexedWorkspaceRoot: string | null
    isRestored: boolean
    isFresh: boolean
    isReconciling: boolean
  } {
    return {
      isIndexing: this.isIndexing,
      indexedWorkspaceRoot: this.indexedWorkspaceRoot,
      isRestored: this.isIndexRestored,
      isFresh: this.isIndexFresh,
      isReconciling: this.isReconciling
    }
  }

  /**
   * Records a file recently modified by AI tools or direct editor actions to avoid duplicate redundant re-indexing loops.
   */
  recordSelfModified(relativePath: string): void {
    const norm = relativePath.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase()
    this.recentlyModifiedBySelf.set(norm, Date.now())
  }

  /**
   * Invalidates a specific file in the cache, deduplicator, dependency analyzer, and codebase index.
   */
  invalidateFile(relativePath: string): void {
    this.recordSelfModified(relativePath)
    this.cache.invalidate(relativePath)
    this.deduplicator.invalidateFile(relativePath)
    this.dependencyAnalyzer.invalidateFile(relativePath)
    this.codebaseIndex.invalidateFile(relativePath)
    if (this.currentWorkspaceRoot) {
      this.scheduleSaveWorkspaceIndex(this.currentWorkspaceRoot)
    }
  }

  /**
   * Handles editor save event explicitly.
   */
  handleFileSave(filePath: string, content: string): void {
    const cleanRel = this.currentWorkspaceRoot
      ? toRelativeWorkspacePath(filePath, this.currentWorkspaceRoot)
      : filePath.replace(/\\/g, '/').replace(/^\/+/, '')

    if (!cleanRel || cleanRel.startsWith('..') || cleanRel.includes('/../')) return

    this.recordSelfModified(cleanRel)
    this.cache.set(cleanRel, content)
    this.deduplicator.invalidateFile(cleanRel)
    const allPaths = this.codebaseIndex.getAllFilePaths()
    if (!allPaths.includes(cleanRel)) {
      allPaths.push(cleanRel)
    }
    this.codebaseIndex.updateFile(cleanRel, content, allPaths)
    if (this.currentWorkspaceRoot) {
      this.scheduleSaveWorkspaceIndex(this.currentWorkspaceRoot)
    }
  }

  /**
   * Handles incoming file change events from the workspace filesystem watcher with debounced batching,
   * event coalescing, and path boundary validation.
   */
  async handleFileEvent(
    event: WorkspaceFileChangeEvent,
    overrideDebounceMs?: number
  ): Promise<void> {
    if (!event || !event.relativePath || !event.workspaceRoot) return

    const normalizedEventRoot = event.workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '')
    const activeRoot = this.currentWorkspaceRoot
      ? this.currentWorkspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '')
      : null

    // Ignore events from past or unselected workspaces
    if (!activeRoot || normalizedEventRoot.toLowerCase() !== activeRoot.toLowerCase()) {
      if (this.config.debug) {
        console.debug(
          `[SmartContextEngine] Ignoring watcher event from inactive workspace "${event.workspaceRoot}"`
        )
      }
      return
    }

    const cleanRel = event.relativePath.replace(/\\/g, '/').replace(/^\/+/, '')

    // Security: reject paths attempting traversal outside the workspace
    if (cleanRel.startsWith('..') || cleanRel.includes('/../')) {
      if (this.config.debug) {
        console.debug(`[SmartContextEngine] Rejected path traversal event for "${event.relativePath}"`)
      }
      return
    }

    // If currently reconciling restored index, queue the event for replay after reconciliation finishes
    if (this.isReconciling) {
      if (this.config.debug) {
        console.debug(
          `[SmartContextEngine] Queued watcher event during reconciliation: "${cleanRel}" (${event.eventType})`
        )
      }
      this.queuedWatcherEventsDuringRestore.push({ ...event, relativePath: cleanRel })
      return
    }

    const key = cleanRel.toLowerCase()

    // Coalesce with any existing pending event for this path in current batch
    const existing = this.pendingEventBatch.get(key)
    if (existing) {
      const mergedType = coalesceEventTypes(existing.eventType, event.eventType)
      this.pendingEventBatch.set(key, {
        workspaceRoot: event.workspaceRoot,
        relativePath: cleanRel,
        eventType: mergedType
      })
    } else {
      this.pendingEventBatch.set(key, {
        workspaceRoot: event.workspaceRoot,
        relativePath: cleanRel,
        eventType: event.eventType
      })
    }

    const debounceMs = overrideDebounceMs ?? this.config.watcherBatchDebounceMs

    if (this.watcherBatchTimer) {
      clearTimeout(this.watcherBatchTimer)
    }

    return new Promise<void>((resolve) => {
      this.batchResolvers.push(resolve)
      this.watcherBatchTimer = setTimeout(async () => {
        this.watcherBatchTimer = null
        await this.processPendingEventBatch()
      }, debounceMs)
    })
  }

  /**
   * Processes the collected batch of debounced file change events.
   * Ensures each affected path is processed at most once per batch,
   * avoiding duplicate reads, parsing, and persistent save operations.
   */
  private async processPendingEventBatch(): Promise<void> {
    if (this.isProcessingEventBatch) {
      return
    }

    if (this.pendingEventBatch.size === 0) {
      const resolvers = [...this.batchResolvers]
      this.batchResolvers = []
      resolvers.forEach((r) => r())
      return
    }

    // Atomically detach all pending events for this batch
    const batchToProcess = new Map(this.pendingEventBatch)
    this.pendingEventBatch.clear()

    const currentResolvers = [...this.batchResolvers]
    this.batchResolvers = []

    const activeRoot = this.currentWorkspaceRoot
    if (!activeRoot) {
      currentResolvers.forEach((r) => r())
      return
    }

    this.isProcessingEventBatch = true
    let indexChanged = false

    try {
      let allPaths = this.codebaseIndex.getAllFilePaths()

      for (const [key, event] of batchToProcess.entries()) {
        if (this.currentWorkspaceRoot !== activeRoot) return

        const relativePath = event.relativePath

        // Self-modification protection: check if recently modified by self
        const lastSelfModified = this.recentlyModifiedBySelf.get(key)
        if (lastSelfModified && Date.now() - lastSelfModified < 1500) {
          this.cache.invalidate(relativePath)
          this.deduplicator.invalidateFile(relativePath)
          continue
        }

        if (event.eventType === 'unlink') {
          if (this.config.debug) {
            console.debug(
              `[SmartContextEngine] Batch: file unlinked "${relativePath}". Removing from cache & index.`
            )
          }
          this.cache.invalidate(relativePath)
          this.deduplicator.invalidateFile(relativePath)
          this.dependencyAnalyzer.invalidateFile(relativePath)
          const removed = this.codebaseIndex.removeFile(relativePath)
          if (removed) {
            allPaths = allPaths.filter((p) => p.toLowerCase() !== key)
            indexChanged = true
          }
          continue
        }

        // 'add' or 'change': invalidate first, then read and index once
        this.cache.invalidate(relativePath)
        this.deduplicator.invalidateFile(relativePath)
        this.dependencyAnalyzer.invalidateFile(relativePath)

        if (typeof window !== 'undefined' && window.electronAPI) {
          try {
            const res = await window.electronAPI.readWorkspaceFile(activeRoot, relativePath)
            if (this.currentWorkspaceRoot !== activeRoot) return

            if (res.success && typeof res.content === 'string') {
              if (!allPaths.some((p) => p.toLowerCase() === key)) {
                allPaths.push(relativePath)
              }
              this.cache.set(relativePath, res.content)
              this.codebaseIndex.updateFile(relativePath, res.content, allPaths)
              indexChanged = true
              if (this.config.debug) {
                console.debug(
                  `[SmartContextEngine] Batch: updated index for file: "${relativePath}" (${event.eventType})`
                )
              }
            } else {
              // File could not be read or was removed
              this.codebaseIndex.removeFile(relativePath)
              allPaths = allPaths.filter((p) => p.toLowerCase() !== key)
              indexChanged = true
            }
          } catch (err) {
            if (this.config.debug) {
              console.debug(
                `[SmartContextEngine] Batch: failed reading file "${relativePath}":`,
                err
              )
            }
          }
        }
      }

      // If index changed, schedule exactly ONE persistent index save for the whole batch
      if (indexChanged && this.currentWorkspaceRoot === activeRoot) {
        this.scheduleSaveWorkspaceIndex(activeRoot)
      }
    } finally {
      this.isProcessingEventBatch = false
      currentResolvers.forEach((r) => r())

      // Check if new events arrived while this batch was processing
      if (this.pendingEventBatch.size > 0 && this.currentWorkspaceRoot === activeRoot) {
        if (!this.watcherBatchTimer) {
          this.watcherBatchTimer = setTimeout(() => {
            this.watcherBatchTimer = null
            this.processPendingEventBatch()
          }, this.config.watcherBatchDebounceMs)
        }
      }
    }
  }

  /**
   * Determines if project context is actually needed for a given user prompt.
   */
  isProjectContextRequired(
    prompt: string,
    workspaceRoot: string | null
  ): { required: boolean; reason: string } {
    if (!workspaceRoot) {
      return { required: false, reason: 'No workspace folder is currently open.' }
    }

    const trimmed = prompt.trim()
    if (!trimmed) {
      return { required: false, reason: 'Empty prompt.' }
    }

    const lower = trimmed.toLowerCase()

    // 1. General greetings and conversational one-liners
    const greetingRegex =
      /^(hi|hello|hey|greetings|good morning|good evening|good afternoon|who are you|what can you do|help)\b[!.?]*$/i
    if (greetingRegex.test(trimmed)) {
      return { required: false, reason: 'Conversational greeting does not require project context.' }
    }

    // 2. Explicit file path or file extension mentioned in prompt
    const fileMentionRegex = /([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]{1,8})/
    if (fileMentionRegex.test(trimmed)) {
      return { required: true, reason: 'Prompt explicitly mentions a file path or filename.' }
    }

    // 3. Project-specific action and question phrases
    const projectIndicators = [
      'this project',
      'the project',
      'our project',
      'this codebase',
      'the codebase',
      'our codebase',
      'this app',
      'the app',
      'our app',
      'in this repo',
      'in the repo',
      'project architecture',
      'file save',
      'file saving',
      'terminal command',
      'command execution',
      'git status',
      'git diff',
      'git log',
      'how does the project',
      'where is',
      'where are',
      'find where',
      'fix this problem',
      'fix the bug',
      'run test',
      'run tests',
      'run command',
      'edit file',
      'create file'
    ]

    for (const indicator of projectIndicators) {
      if (lower.includes(indicator)) {
        return { required: true, reason: `Prompt contains project indicator: "${indicator}".` }
      }
    }

    // 4. Pure general programming questions without project scope
    const generalConceptQuestions = [
      /^(what is|what are|explain|describe|define)\s+(python|javascript|typescript|rust|c\+\+|java|go|recursion|binary search|quicksort|rest api|graphql|sql|nosql|docker|kubernetes|oauth|jwt|http|https|css|html|polymorphism|encapsulation|inheritance|solid principles|git|react|vue|angular)\b[?.]*$/i,
      /^(how does|how do)\s+(recursion|binary search|quicksort|https|http|garbage collection|event loop|async\/await|dns|tcp|udp)\s+(work|function)\b[?.]*$/i,
      /^(write|show|give me)\s+an?\s+(example of|sample of|simple)\s+(recursion|binary search|quicksort|fibonacci|hello world)\b/i
    ]

    for (const pattern of generalConceptQuestions) {
      if (pattern.test(trimmed)) {
        return { required: false, reason: 'General programming or conceptual question.' }
      }
    }

    // 5. Default heuristic for queries asking about code implementations
    const implementationWords = [
      'implement',
      'architecture',
      'component',
      'function',
      'module',
      'service',
      'bug',
      'error',
      'save',
      'terminal',
      'editor',
      'settings'
    ]
    const hasImplementationWord = implementationWords.some((w) => lower.includes(w))

    if (hasImplementationWord) {
      return { required: true, reason: 'Prompt references implementation details or IDE features.' }
    }

    return { required: false, reason: 'No project-specific context identified.' }
  }

  /**
   * Recursively flattens directory tree into normalized relative paths.
   */
  extractRelativePaths(
    entries: FileEntry[],
    rootPath: string,
    maxDepth = 6,
    currentDepth = 0
  ): string[] {
    if (currentDepth > maxDepth || !entries) return []
    const paths: string[] = []

    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name)) continue

      const relPath = toRelativeWorkspacePath(entry.path, rootPath)
      if (!relPath) {
        if (entry.isDirectory && entry.children && entry.children.length > 0) {
          paths.push(...this.extractRelativePaths(entry.children, rootPath, maxDepth, currentDepth + 1))
        }
        continue
      }

      if (entry.isDirectory) {
        if (entry.children && entry.children.length > 0) {
          paths.push(...this.extractRelativePaths(entry.children, rootPath, maxDepth, currentDepth + 1))
        }
      } else {
        const ext = entry.name.split('.').pop()?.toLowerCase() || ''
        if (!BINARY_AND_ASSET_EXTS.has(ext)) {
          paths.push(relPath)
        }
      }
    }

    return paths
  }

  /**
   * Recursively extracts a map of normalized relative paths to file metadata (size, mtimeMs).
   */
  extractFileMetadataMap(
    entries: FileEntry[],
    rootPath: string,
    maxDepth = 6,
    currentDepth = 0
  ): Map<string, { size?: number; mtimeMs?: number }> {
    if (currentDepth > maxDepth || !entries) return new Map()
    const map = new Map<string, { size?: number; mtimeMs?: number }>()

    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name)) continue

      const relPath = toRelativeWorkspacePath(entry.path, rootPath)
      if (!relPath) {
        if (entry.isDirectory && entry.children && entry.children.length > 0) {
          const subMap = this.extractFileMetadataMap(
            entry.children,
            rootPath,
            maxDepth,
            currentDepth + 1
          )
          for (const [k, v] of subMap.entries()) {
            map.set(k, v)
          }
        }
        continue
      }

      if (entry.isDirectory) {
        if (entry.children && entry.children.length > 0) {
          const subMap = this.extractFileMetadataMap(
            entry.children,
            rootPath,
            maxDepth,
            currentDepth + 1
          )
          for (const [k, v] of subMap.entries()) {
            map.set(k, v)
          }
        }
      } else {
        const ext = entry.name.split('.').pop()?.toLowerCase() || ''
        if (!BINARY_AND_ASSET_EXTS.has(ext)) {
          map.set(relPath, { size: entry.size, mtimeMs: entry.mtimeMs })
        }
      }
    }

    return map
  }

  /**
   * Tokenizes a text into meaningful lowercase words (splitting camelCase, kebab-case, snake_case).
   */
  tokenize(text: string): string[] {
    const splitCamel = text.replace(/([a-z])([A-Z])/g, '$1 $2')
    const words = splitCamel.toLowerCase().split(/[^a-z0-9_.-]+/)
    const cleanTokens: string[] = []

    for (const w of words) {
      const stripped = w.replace(/^[._-]+|[._-]+$/g, '')
      if (stripped.length >= 2 && !COMMON_STOP_WORDS.has(stripped)) {
        cleanTokens.push(stripped)
      }
    }

    return cleanTokens
  }

  /**
   * Ranks candidate files against the user's prompt using multi-signal scoring.
   */
  rankCandidateFiles(prompt: string, filePaths: string[]): RankedCandidate[] {
    const promptLower = prompt.toLowerCase()
    const promptTokens = this.tokenize(prompt)
    const promptTokenSet = new Set(promptTokens)

    const explicitFileMentions = prompt.match(/[a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]{1,8}/g) || []
    const normalizedMentions = explicitFileMentions.map((m) =>
      m.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase()
    )

    const candidates: RankedCandidate[] = []

    const isSaveIntent = /\b(save|saving|editor|monaco|dirty|tab)\b/i.test(prompt)
    const isTerminalIntent =
      /\b(terminal|command|run_command|exec|shell|process|spawn|powershell|cmd)\b/i.test(prompt)
    const isGitIntent = /\b(git|status|diff|branch|commit|log)\b/i.test(prompt)
    const isArchIntent =
      /\b(architecture|overview|structure|entry point|components|how is the project structured)\b/i.test(
        prompt
      )
    const isConfigIntent =
      /\b(config|dependency|dependencies|package|build|vite|tsconfig|typescript)\b/i.test(prompt)
    const isTestIntent = /\b(test|tests|spec|verify|verification)\b/i.test(prompt)

    for (const relPath of filePaths) {
      const normalizedPath = relPath.replace(/\\/g, '/')
      const pathLower = normalizedPath.toLowerCase()
      const segments = pathLower.split('/')
      const fileName = segments[segments.length - 1]
      const fileTokens = this.tokenize(fileName)
      const pathTokens = this.tokenize(normalizedPath)

      let score = 0
      let isExplicit = false
      const reasons: string[] = []

      // 1. Exact path or basename mention in prompt
      for (const mention of normalizedMentions) {
        if (pathLower === mention || pathLower.endsWith(`/${mention}`)) {
          score += 1000
          isExplicit = true
          reasons.push(`Exact path match ("${mention}")`)
          break
        } else if (fileName === mention || fileName.startsWith(mention.split('.')[0])) {
          score += 500
          isExplicit = true
          reasons.push(`Exact file name match ("${mention}")`)
          break
        }
      }

      if (promptLower.includes(pathLower)) {
        score += 800
        isExplicit = true
        reasons.push('Full path appears in prompt')
      } else if (promptLower.includes(fileName)) {
        score += 300
        reasons.push(`File name "${fileName}" appears in prompt`)
      }

      // 2. Token overlap
      let matchingTokens = 0
      for (const token of fileTokens) {
        if (promptTokenSet.has(token)) {
          matchingTokens++
          score += 60
        }
      }
      for (const token of pathTokens) {
        if (!fileTokens.includes(token) && promptTokenSet.has(token)) {
          matchingTokens++
          score += 25
        }
      }
      if (matchingTokens > 0) {
        reasons.push(`${matchingTokens} matching token(s)`)
      }

      // 3. Domain Intent Heuristics
      if (isSaveIntent) {
        if (
          pathLower.includes('editor') ||
          pathLower.includes('save') ||
          pathLower.includes('app.tsx') ||
          pathLower.includes('fileexplorer')
        ) {
          score += 120
          reasons.push('Matches file saving / editor domain')
        }
      }

      if (isTerminalIntent) {
        if (
          pathLower.includes('terminal') ||
          pathLower.includes('runcommand') ||
          pathLower.includes('commandvalidator') ||
          pathLower.includes('command')
        ) {
          score += 150
          reasons.push('Matches terminal / command execution domain')
        }
      }

      if (isGitIntent) {
        if (
          pathLower.includes('git') ||
          pathLower.includes('gitstatus') ||
          pathLower.includes('gitdiff') ||
          pathLower.includes('gitlog')
        ) {
          score += 150
          reasons.push('Matches Git domain')
        }
      }

      if (isArchIntent) {
        const isEntryPoint =
          fileName === 'package.json' ||
          pathLower === 'src/main/index.ts' ||
          pathLower === 'src/renderer/src/app.tsx' ||
          pathLower === 'src/renderer/src/main.tsx' ||
          pathLower === 'src/preload/index.ts' ||
          fileName === 'tsconfig.json'

        if (isEntryPoint) {
          score += 100
          reasons.push('Key architectural entry point')
        }
      }

      if (isConfigIntent) {
        if (
          fileName === 'package.json' ||
          fileName.includes('config') ||
          fileName.includes('tsconfig')
        ) {
          score += 120
          reasons.push('Project configuration file')
        }
      }

      if (isTestIntent) {
        if (
          pathLower.includes('test') ||
          pathLower.includes('spec') ||
          pathLower.includes('mock')
        ) {
          score += 100
          reasons.push('Test / verification file')
        }
      }

      const depth = segments.length
      score = Math.max(0, score - depth * 2)

      if (score > 0) {
        candidates.push({
          path: normalizedPath,
          score,
          matchReason: reasons.join(', ') || 'Keyword relevance',
          isExplicit
        })
      }
    }

    candidates.sort((a, b) => b.score - a.score)
    return candidates.slice(0, this.config.maxCandidates)
  }

  /**
   * Resolves smart project context:
   * 1. Checks intent and workspace change.
   * 2. Ranks candidate files.
   * 3. Reads files using ContextCache with content hashing and smart refresh.
   * 4. Allocates budget using ContextBudgetManager.
   * 5. Deduplicates active context via ContextDeduplicator.
   */
  async resolveContext(
    prompt: string,
    workspaceRoot: string | null
  ): Promise<SmartContextResult> {
    this.onWorkspaceChange(workspaceRoot)

    const intent = this.isProjectContextRequired(prompt, workspaceRoot)
    if (!intent.required || !workspaceRoot) {
      return {
        required: false,
        reason: intent.reason,
        selectedFiles: [],
        readFiles: [],
        droppedFiles: [],
        formattedContext: '',
        cacheStats: this.cache.getStats()
      }
    }

    try {
      if (!window?.electronAPI) {
        return {
          required: false,
          reason: 'Electron API unavailable',
          selectedFiles: [],
          readFiles: [],
          droppedFiles: [],
          formattedContext: '',
          cacheStats: this.cache.getStats()
        }
      }

      // Fetch directory tree
      const treeRes = await window.electronAPI.readTree(workspaceRoot)
      const treeEntries = treeRes.success && treeRes.tree ? treeRes.tree : []
      const filePaths = this.extractRelativePaths(treeEntries, workspaceRoot)

      if (filePaths.length === 0) {
        return {
          required: true,
          reason: 'No source files found in workspace.',
          selectedFiles: [],
          readFiles: [],
          droppedFiles: [],
          formattedContext: '[Project Context]: Workspace contains no readable source files.',
          cacheStats: this.cache.getStats()
        }
      }

      // Rank candidate files
      const rankedCandidates = this.rankCandidateFiles(prompt, filePaths)

      // Filter top files that meet the minimum relevance threshold (or are explicitly requested)
      const filesToRead = rankedCandidates
        .filter((c) => c.score >= this.config.minScoreThreshold || c.isExplicit || c.score >= 500)
        .slice(0, this.config.maxAutoReadFiles)

      // Fetch file contents (via cache with smart refresh)
      const rawCandidatesToAllocate = []

      for (const candidate of filesToRead) {
        let content: string | null = null
        const cachedEntry = this.cache.get(candidate.path)

        if (cachedEntry) {
          content = cachedEntry.content
        } else {
          // Read from disk
          const readRes = await window.electronAPI.readWorkspaceFile(workspaceRoot, candidate.path)
          if (readRes.success && typeof readRes.content === 'string') {
            content = readRes.content
            this.cache.set(candidate.path, content)
          } else {
            if (this.config.debug) {
              console.debug(`[SmartContextEngine] Failed to read candidate: ${candidate.path}`)
            }
          }
        }

        if (content !== null) {
          rawCandidatesToAllocate.push({
            path: candidate.path,
            content,
            score: candidate.score,
            isExplicit: candidate.isExplicit
          })
        }
      }

      // Allocate via ContextBudgetManager
      const allocation = this.budgetManager.allocate(rawCandidatesToAllocate)

      // Mark allocated files into ContextDeduplicator
      const readFiles: SmartContextFile[] = []
      for (const allocated of allocation.allocatedFiles) {
        this.deduplicator.markFileInContext(allocated.path, allocated.content)
        readFiles.push({
          path: allocated.path,
          content: allocated.content,
          truncated: allocated.truncated,
          charCount: allocated.charCount,
          score: allocated.score,
          isExplicit: allocated.isExplicit
        })
      }

      // Codebase Indexing (Phase 5)
      for (const rf of readFiles) {
        this.codebaseIndex.indexFile(rf.path, rf.content, filePaths)
      }

      // Dependency Analysis & Change Impact Preview (Phase 3 & 5)
      let dependencyGraph: DependencyGraphNode | null = null
      const dependencyGraphs: DependencyGraphNode[] = []
      const symbolReferences: SymbolReference[] = []
      let projectSummary: ProjectSummary | null = null

      const promptLower = prompt.toLowerCase()
      const isStructureOrTechQuery =
        promptLower.includes('summary of this project') ||
        promptLower.includes('project structure') ||
        promptLower.includes('technologies does this project') ||
        promptLower.includes('technologies') ||
        promptLower.includes('architecture') ||
        promptLower.includes('entry points')

      if (readFiles.length > 0) {
        const filesWithContent = readFiles.map((rf) => ({
          path: rf.path,
          content: rf.content
        }))

        const seenTargetPaths = new Set<string>()

        // 1. Analyze dependencies for ALL auto-read code files
        for (const rf of readFiles) {
          const ext = rf.path.split('.').pop()?.toLowerCase() || ''
          if (!['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(ext)) {
            continue
          }

          const normTarget = rf.path.replace(/\\/g, '/').toLowerCase()
          if (seenTargetPaths.has(normTarget)) {
            continue
          }
          seenTargetPaths.add(normTarget)

          try {
            const node = this.dependencyAnalyzer.buildGraphNode(
              rf.path,
              rf.content,
              filesWithContent,
              filePaths
            )
            if (node) {
              dependencyGraphs.push(node)
            }
          } catch (nodeErr) {
            if (this.config.debug) {
              console.debug(
                `[SmartContextEngine] Failed to build dependency graph for ${rf.path}:`,
                nodeErr
              )
            }
          }
        }

        // Primary node for backwards compatibility
        dependencyGraph = dependencyGraphs.length > 0 ? dependencyGraphs[0] : null

        // 2. Find symbol references across filesWithContent (deduplicated)
        const symbolTokens = this.tokenize(prompt).filter((t) => t.length >= 3)
        const seenSymbolRefs = new Set<string>()

        for (const sym of symbolTokens) {
          const refs = this.dependencyAnalyzer.findSymbolReferences(sym, filesWithContent)
          for (const ref of refs) {
            const refKey = `${ref.file.toLowerCase()}:${ref.line}:${ref.snippet.trim()}`
            if (!seenSymbolRefs.has(refKey)) {
              seenSymbolRefs.add(refKey)
              symbolReferences.push(ref)
            }
          }
        }
      }

      if (isStructureOrTechQuery) {
        projectSummary = this.codebaseIndex.getProjectSummary()
      }

      // Format clean internal context
      let formattedContext = ''
      if (readFiles.length > 0 || projectSummary) {
        const summaryLines = readFiles.map(
          (f) => `- ${f.path} (Score: ${f.score}${f.isExplicit ? ', Explicitly Requested' : ''})`
        )
        const fileContentsBlocks = readFiles.map(
          (rf) => `--- File: ${rf.path}${rf.truncated ? ' (Truncated)' : ''} ---\n${rf.content}`
        )

        formattedContext = `[Smart Project Context Engine - Relevant Workspace Files]:\n${summaryLines.join('\n')}\n\n${fileContentsBlocks.join('\n\n')}`

        if (dependencyGraphs.length === 1) {
          const g = dependencyGraphs[0]
          const deps =
            g.directDependencies.length > 0
              ? g.directDependencies.join(', ')
              : 'None identified'
          const importers =
            g.directImporters.length > 0
              ? g.directImporters.join(', ')
              : 'None directly detected'
          const tests =
            g.likelyTests.length > 0 ? g.likelyTests.join(', ') : 'None inferred'
          const indirect =
            g.indirectImporters.length > 0
              ? g.indirectImporters.join(', ')
              : 'None inferred'
          const affected =
            g.potentiallyAffected.length > 0
              ? g.potentiallyAffected.join(', ')
              : 'None identified'

          formattedContext += `\n\n[Dependency Graph & Impact Analysis]:\n- Primary Target: ${g.path}\n- Direct Dependencies [Directly Detected]: ${deps}\n- Direct Importers [Directly Detected]: ${importers}\n- Related Test Files [Inferred from naming conventions]: ${tests}\n- Potential Indirect Impact [Inferred downstream consumers]: ${indirect}\n- Combined Affected Files: ${affected}\n- Note: package.json is excluded from code change impact unless package metadata itself is modified.`
        } else if (dependencyGraphs.length > 1) {
          const sections = dependencyGraphs.map((g) => {
            const deps =
              g.directDependencies.length > 0
                ? g.directDependencies.join(', ')
                : 'None identified'
            const importers =
              g.directImporters.length > 0
                ? g.directImporters.join(', ')
                : 'None directly detected'
            const tests =
              g.likelyTests.length > 0 ? g.likelyTests.join(', ') : 'None inferred'
            const indirect =
              g.indirectImporters.length > 0
                ? g.indirectImporters.join(', ')
                : 'None inferred'
            const affected =
              g.potentiallyAffected.length > 0
                ? g.potentiallyAffected.join(', ')
                : 'None identified'

            return `- Target: ${g.path}\n  * Direct Dependencies [Directly Detected]: ${deps}\n  * Direct Importers [Directly Detected]: ${importers}\n  * Related Test Files [Inferred from naming conventions]: ${tests}\n  * Potential Indirect Impact [Inferred downstream consumers]: ${indirect}\n  * Affected Files: ${affected}`
          })

          const combinedAffectedSet = new Set<string>()
          for (const g of dependencyGraphs) {
            for (const aff of g.potentiallyAffected) {
              combinedAffectedSet.add(aff)
            }
          }
          // Remove selected read files themselves from affected set
          for (const rf of readFiles) {
            combinedAffectedSet.delete(rf.path)
          }

          const combinedAffected =
            combinedAffectedSet.size > 0
              ? Array.from(combinedAffectedSet).sort().join(', ')
              : 'None identified'

          formattedContext += `\n\n[Dependency Graph & Impact Analysis]:\n${sections.join('\n\n')}\n\n- Combined Affected Files Across All Targets: ${combinedAffected}\n- Note: package.json is excluded from code change impact unless package metadata itself is modified.`
        }

        if (symbolReferences.length > 0) {
          const refLines = symbolReferences
            .slice(0, 5)
            .map((r) => `- ${r.file}:${r.line} -> \`${r.snippet}\``)
          formattedContext += `\n\n[Symbol References]:\n${refLines.join('\n')}`
        }

        if (projectSummary) {
          const techStr =
            projectSummary.detectedTechnologies.length > 0
              ? projectSummary.detectedTechnologies.join(', ')
              : 'None detected from configuration files'
          const entryStr =
            projectSummary.detectedEntryPoints.length > 0
              ? projectSummary.detectedEntryPoints
                  .map((e) => `${e.path} (${e.confidence}: ${e.reason})`)
                  .join(', ')
              : 'None detected'
          const configStr =
            projectSummary.configFiles.length > 0
              ? projectSummary.configFiles.join(', ')
              : 'None detected'
          const runtimeStr = projectSummary.runtimePlatform || 'Node.js Application'
          const testEnvStr = projectSummary.testEnvironment || 'None Detected'

          formattedContext += `\n\n[Codebase Index & Project Understanding]:\n- Workspace Files: ${filePaths.length} total (${projectSummary.sourceFilesCount} indexed source, ${projectSummary.testFilesCount} tests, ${projectSummary.configFilesCount} config)\n- Main Directories: ${projectSummary.mainDirectories.join(', ') || 'root'}\n- Runtime Platform [Confirmed]: ${runtimeStr}\n- Test Environment [Test Runner]: ${testEnvStr}\n- Detected Technologies (Evidence-backed): ${techStr}\n- Detected Entry Points: ${entryStr}\n- Configuration Files: ${configStr}`
        }
      }

      return {
        required: true,
        reason: intent.reason,
        selectedFiles: rankedCandidates,
        readFiles,
        droppedFiles: allocation.droppedFiles,
        formattedContext,
        cacheStats: this.cache.getStats(),
        dependencyGraph,
        dependencyGraphs,
        symbolReferences,
        projectSummary
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        required: true,
        reason: `Context engine error: ${message}`,
        selectedFiles: [],
        readFiles: [],
        droppedFiles: [],
        formattedContext: '',
        cacheStats: this.cache.getStats()
      }
    }
  }
}
