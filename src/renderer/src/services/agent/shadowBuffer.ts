/**
 * ShadowBuffer - Safe AI Editing In-Memory Abstraction (Phase 14.0)
 *
 * Maintains an in-memory representation of files undergoing AI-assisted editing.
 * Distinguishes original workspace content from modified shadow content,
 * tracks monotonically increasing revisions, enforces stale-write conflict detection,
 * and safely stages edits prior to user approval and disk commit.
 */

import { normalizeFilePath } from '@shared/pathUtils'
import { isSafePath } from '@shared/securityUtils'
import { applySearchReplacePatch, ApplyPatchOptions, ApplyPatchResult, PatchBlock } from '@shared/diffUtils'
import type { ToolApprovalRequest } from '../tools/types'

export interface ShadowEntry {
  normalizedPath: string
  originalContent: string
  shadowContent: string
  originalHash: string
  currentHash: string
  dirty: boolean
  revision: number
  isConflicted: boolean
  conflictReason?: string
  createdAt: number
  updatedAt: number
}

export interface ShadowUpdateResult {
  success: boolean
  entry?: ShadowEntry
  error?: string
  conflict?: boolean
}

export interface ShadowResetResult {
  success: boolean
  entry?: ShadowEntry
  error?: string
}

export interface ShadowCommitOptions {
  workspaceRoot: string
  requestApproval?: (request: ToolApprovalRequest) => Promise<boolean>
  skipApproval?: boolean
  onFileEdited?: (path: string, newContent: string) => void
}

export interface ShadowCommitResult {
  success: boolean
  path?: string
  revision?: number
  content?: string
  error?: string
  conflict?: boolean
  rejected?: boolean
}

/**
 * Computes a fast, deterministic 64-bit FNV-1a content hash with length prefix.
 * O(N) time complexity, O(1) space complexity. Fully synchronous and runs
 * identically in Node.js, Electron main/preload, and Browser/Web Worker contexts.
 */
export function computeContentHash(content: string): string {
  if (typeof content !== 'string') return '0_0000000000000000'
  let h1 = 0x811c9dc5
  let h2 = 0x811c9dc5 ^ 0x5a5a5a5a
  for (let i = 0; i < content.length; i++) {
    const ch = content.charCodeAt(i)
    h1 = Math.imul(h1 ^ (ch & 0xff), 0x01000193)
    h2 = Math.imul(h2 ^ ((ch >> 8) & 0xff), 0x01000193)
  }
  const part1 = (h1 >>> 0).toString(16).padStart(8, '0')
  const part2 = (h2 >>> 0).toString(16).padStart(8, '0')
  return `${content.length}_${part1}${part2}`
}

export type ShadowChangeListener = (filePath: string, entry?: ShadowEntry) => void

export class ShadowBuffer {
  private snapshots: Map<string, ShadowEntry> = new Map()
  private listeners: Set<ShadowChangeListener> = new Set()

  /**
   * Subscribes to changes across shadow snapshots.
   * Returns an unsubscribe function.
   */
  public subscribe(listener: ShadowChangeListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Notifies all registered listeners of a snapshot change.
   */
  private notify(filePath: string, entry?: ShadowEntry): void {
    for (const listener of this.listeners) {
      try {
        listener(filePath, entry)
      } catch (err) {
        console.error('ShadowBuffer listener error:', err)
      }
    }
  }

  /**
   * Canonicalizes a file path for index lookup.
   */
  private canonicalize(filePath: string, workspaceRoot?: string | null): string {
    const norm = normalizeFilePath(filePath, workspaceRoot)
    return norm.toLowerCase()
  }

  /**
   * Creates an in-memory shadow snapshot of a workspace file.
   * If a snapshot already exists for the path, returns the existing snapshot.
   */
  public createSnapshot(
    filePath: string,
    content: string,
    workspaceRoot?: string | null
  ): ShadowEntry {
    if (!isSafePath(filePath)) {
      throw new Error(`Invalid or unsafe file path: '${filePath}'`)
    }

    const key = this.canonicalize(filePath, workspaceRoot)
    const normalized = normalizeFilePath(filePath, workspaceRoot)
    const existing = this.snapshots.get(key)
    if (existing) {
      return existing
    }

    const hash = computeContentHash(content)
    const now = Date.now()

    const entry: ShadowEntry = {
      normalizedPath: normalized,
      originalContent: content,
      shadowContent: content,
      originalHash: hash,
      currentHash: hash,
      dirty: false,
      revision: 0,
      isConflicted: false,
      createdAt: now,
      updatedAt: now
    }

    this.snapshots.set(key, entry)
    this.notify(entry.normalizedPath, entry)
    return entry
  }

  /**
   * Retrieves an existing snapshot by path.
   */
  public getSnapshot(filePath: string, workspaceRoot?: string | null): ShadowEntry | undefined {
    const key = this.canonicalize(filePath, workspaceRoot)
    return this.snapshots.get(key)
  }

  /**
   * Checks if a snapshot exists for the specified path.
   */
  public hasSnapshot(filePath: string, workspaceRoot?: string | null): boolean {
    const key = this.canonicalize(filePath, workspaceRoot)
    return this.snapshots.has(key)
  }

  /**
   * Returns current shadow content if snapshot exists.
   */
  public getShadowContent(filePath: string, workspaceRoot?: string | null): string | undefined {
    return this.getSnapshot(filePath, workspaceRoot)?.shadowContent
  }

  /**
   * Returns original baseline content from when the snapshot was initialized.
   */
  public getOriginalContent(filePath: string, workspaceRoot?: string | null): string | undefined {
    return this.getSnapshot(filePath, workspaceRoot)?.originalContent
  }

  /**
   * Updates shadow content in-memory, incrementing the revision number.
   * Does NOT modify the physical workspace file on disk.
   */
  public updateShadowContent(
    filePath: string,
    newContent: string,
    workspaceRoot?: string | null
  ): ShadowUpdateResult {
    const key = this.canonicalize(filePath, workspaceRoot)
    const entry = this.snapshots.get(key)

    if (!entry) {
      return {
        success: false,
        error: `No shadow snapshot exists for: '${filePath}'`
      }
    }

    if (entry.isConflicted) {
      return {
        success: false,
        conflict: true,
        error: `Cannot update conflicted shadow buffer for '${filePath}': ${entry.conflictReason || 'Workspace file was modified externally.'}`
      }
    }

    const newHash = computeContentHash(newContent)
    entry.shadowContent = newContent
    entry.currentHash = newHash
    entry.dirty = newContent !== entry.originalContent
    entry.revision += 1
    entry.updatedAt = Date.now()

    this.notify(entry.normalizedPath, entry)

    return {
      success: true,
      entry
    }
  }

  /**
   * Applies one or more SEARCH/REPLACE patch blocks against the current shadow content.
   * If the patch matches and applies, updates the shadow buffer and increments revision.
   */
  public applyPatch(
    filePath: string,
    patchTextOrBlocks: string | PatchBlock[],
    options?: ApplyPatchOptions,
    workspaceRoot?: string | null
  ): ApplyPatchResult & { revision?: number; entry?: ShadowEntry } {
    const entry = this.getSnapshot(filePath, workspaceRoot)
    if (!entry) {
      return {
        success: false,
        error: `No shadow snapshot exists for: '${filePath}'`
      }
    }

    if (entry.isConflicted) {
      return {
        success: false,
        error: `Cannot patch conflicted shadow buffer: ${entry.conflictReason || 'Stale workspace file.'}`
      }
    }

    // Apply patch against current shadowContent
    const patchResult = applySearchReplacePatch(entry.shadowContent, patchTextOrBlocks, options)

    if (!patchResult.success || typeof patchResult.content !== 'string') {
      return {
        success: false,
        error: patchResult.error || 'Failed to apply patch to shadow buffer.'
      }
    }

    const updateRes = this.updateShadowContent(filePath, patchResult.content, workspaceRoot)
    if (!updateRes.success) {
      return {
        success: false,
        error: updateRes.error || 'Failed to update shadow buffer with patch.'
      }
    }

    return {
      success: true,
      content: patchResult.content,
      appliedCount: patchResult.appliedCount,
      matchedBy: patchResult.matchedBy,
      revision: updateRes.entry?.revision,
      entry: updateRes.entry
    }
  }

  /**
   * Resets shadow content back to original snapshot content.
   * Increments revision and clears dirty/conflict status without altering real file.
   */
  public reset(filePath: string, workspaceRoot?: string | null): ShadowResetResult {
    const key = this.canonicalize(filePath, workspaceRoot)
    const entry = this.snapshots.get(key)

    if (!entry) {
      return {
        success: false,
        error: `No shadow snapshot exists for: '${filePath}'`
      }
    }

    entry.shadowContent = entry.originalContent
    entry.currentHash = entry.originalHash
    entry.dirty = false
    entry.isConflicted = false
    entry.conflictReason = undefined
    entry.revision += 1
    entry.updatedAt = Date.now()

    this.notify(entry.normalizedPath, entry)

    return {
      success: true,
      entry
    }
  }

  /**
   * Removes a snapshot completely from memory.
   * Does NOT modify the physical workspace file.
   */
  public remove(filePath: string, workspaceRoot?: string | null): boolean {
    const key = this.canonicalize(filePath, workspaceRoot)
    const deleted = this.snapshots.delete(key)
    if (deleted) {
      this.notify(normalizeFilePath(filePath, workspaceRoot), undefined)
    }
    return deleted
  }

  /**
   * Marks a shadow entry as conflicted/stale (e.g. when external file changes occur).
   */
  public markConflicted(
    filePath: string,
    reason: string,
    workspaceRoot?: string | null
  ): boolean {
    const key = this.canonicalize(filePath, workspaceRoot)
    const entry = this.snapshots.get(key)
    if (!entry) return false

    entry.isConflicted = true
    entry.conflictReason = reason
    entry.updatedAt = Date.now()
    this.notify(entry.normalizedPath, entry)
    return true
  }

  /**
   * Checks whether a snapshot is dirty (shadow content differs from original).
   */
  public isDirty(filePath: string, workspaceRoot?: string | null): boolean {
    const entry = this.getSnapshot(filePath, workspaceRoot)
    return Boolean(entry?.dirty)
  }

  /**
   * Returns a list of all file paths currently marked dirty in the shadow buffer.
   */
  public listDirtyFiles(): string[] {
    const dirtyPaths: string[] = []
    for (const entry of this.snapshots.values()) {
      if (entry.dirty) {
        dirtyPaths.push(entry.normalizedPath)
      }
    }
    return dirtyPaths
  }

  /**
   * Returns all active shadow entries.
   */
  public listSnapshots(): ShadowEntry[] {
    return Array.from(this.snapshots.values())
  }

  /**
   * Clears all shadow snapshots from memory.
   */
  public clear(): void {
    this.snapshots.clear()
    this.notify('', undefined)
  }

  /**
   * Commits current shadow content to the physical workspace file on disk.
   *
   * Verifies:
   * 1. Snapshot existence and safe path boundaries.
   * 2. Stale workspace protection: verifies disk content matches original snapshot hash.
   * 3. User approval gating via existing approval mechanism.
   * 4. Secure filesystem edit IPC.
   * 5. Atomic state update on success.
   */
  public async commit(
    filePath: string,
    options: ShadowCommitOptions
  ): Promise<ShadowCommitResult> {
    const { workspaceRoot, requestApproval, skipApproval, onFileEdited } = options

    if (!workspaceRoot || !isSafePath(workspaceRoot)) {
      return {
        success: false,
        error: 'Invalid or missing workspace root.'
      }
    }

    if (!isSafePath(filePath)) {
      return {
        success: false,
        error: `Invalid or unsafe file path: '${filePath}'`
      }
    }

    const key = this.canonicalize(filePath, workspaceRoot)
    const entry = this.snapshots.get(key)

    if (!entry) {
      return {
        success: false,
        error: `No shadow snapshot exists to commit for: '${filePath}'`
      }
    }

    // If not dirty, commit is a no-op success
    if (!entry.dirty) {
      return {
        success: true,
        path: entry.normalizedPath,
        revision: entry.revision,
        content: entry.shadowContent
      }
    }

    // 1. Verify filesystem read API
    if (typeof window === 'undefined' || !window.electronAPI?.readWorkspaceFile) {
      return {
        success: false,
        error: 'Filesystem read API is not available in this context.'
      }
    }

    // 2. Read current workspace file from disk to detect stale/external changes
    const readResult = await window.electronAPI.readWorkspaceFile(workspaceRoot, filePath)
    if (!readResult.success) {
      this.markConflicted(filePath, 'Workspace file does not exist on disk.', workspaceRoot)
      return {
        success: false,
        conflict: true,
        error: `SHADOW_CONFLICT: Workspace file does not exist on disk: '${filePath}'.`
      }
    }

    const currentDiskContent = readResult.content ?? ''
    const currentDiskHash = computeContentHash(currentDiskContent)

    // 3. Stale workspace protection: verify hash against original snapshot baseline
    if (currentDiskHash !== entry.originalHash) {
      this.markConflicted(
        filePath,
        'The workspace file changed after the shadow snapshot was created.',
        workspaceRoot
      )
      return {
        success: false,
        conflict: true,
        error: 'SHADOW_CONFLICT: The workspace file changed after the shadow snapshot was created.'
      }
    }

    // 4. User approval gating
    if (!skipApproval && requestApproval) {
      const isApproved = await requestApproval({
        toolName: 'edit_file',
        path: filePath,
        oldContent: entry.originalContent,
        newContent: entry.shadowContent
      })

      if (!isApproved) {
        return {
          success: false,
          rejected: true,
          error: 'Edit rejected — changes were not committed to disk.'
        }
      }
    }

    // 5. Secure disk write via electronAPI.editWorkspaceFile
    if (typeof window.electronAPI.editWorkspaceFile !== 'function') {
      return {
        success: false,
        error: 'Filesystem edit API is not available in this context.'
      }
    }

    try {
      const writeResult = await window.electronAPI.editWorkspaceFile(
        workspaceRoot,
        filePath,
        entry.shadowContent,
        currentDiskContent
      )

      if (!writeResult.success) {
        return {
          success: false,
          error: writeResult.error || `Failed to commit shadow content to '${filePath}'.`
        }
      }

      // 6. Update snapshot baseline state
      entry.originalContent = entry.shadowContent
      entry.originalHash = entry.currentHash
      entry.dirty = false
      entry.isConflicted = false
      entry.conflictReason = undefined
      entry.updatedAt = Date.now()

      this.notify(entry.normalizedPath, entry)

      onFileEdited?.(entry.normalizedPath, entry.shadowContent)

      return {
        success: true,
        path: entry.normalizedPath,
        revision: entry.revision,
        content: entry.shadowContent
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        success: false,
        error: `Disk commit failed with exception: ${msg}`
      }
    }
  }

  /**
   * Synchronizes baseline state after an external or multi-file transactional commit.
   * Updates originalContent and shadowContent to committed content,
   * resets dirty and conflict flags, and notifies listeners.
   */
  public syncCommitted(
    filePath: string,
    committedContent: string,
    workspaceRoot?: string | null
  ): boolean {
    const key = this.canonicalize(filePath, workspaceRoot)
    const entry = this.snapshots.get(key)
    if (!entry) return false

    const newHash = computeContentHash(committedContent)
    entry.originalContent = committedContent
    entry.originalHash = newHash
    entry.shadowContent = committedContent
    entry.currentHash = newHash
    entry.dirty = false
    entry.isConflicted = false
    entry.conflictReason = undefined
    entry.revision += 1
    entry.updatedAt = Date.now()

    this.notify(entry.normalizedPath, entry)
    return true
  }
}

