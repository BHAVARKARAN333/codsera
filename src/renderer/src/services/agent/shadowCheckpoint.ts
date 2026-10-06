/**
 * Shadow Checkpoint & Transactional Rollback System (Phase 14.2)
 *
 * Provides multi-file snapshotting, atomic preflight validation,
 * transactional commits, and safe recovery/rollback across AI-edited files.
 */

import { normalizeFilePath } from '@shared/pathUtils'
import { isSafePath } from '@shared/securityUtils'
import { computeContentHash, ShadowBuffer } from './shadowBuffer'

export type CheckpointState =
  | 'ACTIVE'
  | 'COMMITTING'
  | 'COMMITTED'
  | 'ROLLED_BACK'
  | 'CONFLICTED'
  | 'FAILED'

export interface CheckpointFileEntry {
  readonly path: string
  readonly originalContent: string
  readonly originalHash: string
  readonly shadowContent: string
  readonly shadowHash: string
  readonly revision: number
  readonly isConflicted?: boolean
  readonly conflictReason?: string
}

export interface ShadowCheckpoint {
  readonly checkpointId: string
  readonly createdAt: number
  readonly files: ReadonlyMap<string, CheckpointFileEntry>
  readonly state: CheckpointState
  readonly fileCount: number
}

export interface CheckpointPreflightError {
  path: string
  error: string
  conflict?: boolean
  expectedHash?: string
  actualHash?: string
}

export interface CheckpointPreflightResult {
  readonly valid: boolean
  readonly checkedFiles: number
  readonly errors: CheckpointPreflightError[]
  readonly conflictedFiles: string[]
}

export interface RollbackJournalEntry {
  path: string
  previousDiskContent: string
  previousHash: string
  newContent: string
  writeStatus: 'written' | 'restored' | 'restore_failed'
  error?: string
}

export interface ElectronFsApiBridge {
  readWorkspaceFile: (
    workspaceRoot: string,
    relativePath: string
  ) => Promise<{ success: boolean; content?: string; error?: string }>
  editWorkspaceFile: (
    workspaceRoot: string,
    relativePath: string,
    newContent: string,
    expectedOldContent?: string
  ) => Promise<{ success: boolean; path?: string; error?: string }>
  writeFile?: (filePath: string, content: string) => Promise<{ success: boolean; error?: string }>
}

export interface CheckpointCommitOptions {
  readonly workspaceRoot: string
  readonly requestApproval?: (files: CheckpointFileEntry[]) => Promise<boolean>
  readonly skipApproval?: boolean
  readonly onFileCommitted?: (path: string, newContent: string) => void
  /** For controlled test simulation of disk write failures */
  readonly _simulateWriteFailureOnPath?: string
  /** For controlled test simulation of rollback restoration failures */
  readonly _simulateRollbackFailureOnPath?: string
  /** Optional custom electron API hook for dependency injection / isolated testing */
  readonly electronAPI?: ElectronFsApiBridge
}

export interface CheckpointCommitResult {
  readonly success: boolean
  readonly checkpointId: string
  readonly state: CheckpointState
  readonly committedFiles: string[]
  readonly rolledBackFiles?: string[]
  readonly error?: string
  readonly conflict?: boolean
  readonly rejected?: boolean
  readonly recoveryError?: string
  readonly journal?: RollbackJournalEntry[]
}

export type CheckpointChangeListener = (checkpoint: ShadowCheckpoint) => void

let checkpointCounter = 0

/**
 * Generates a unique, deterministic-friendly checkpoint ID.
 */
export function generateCheckpointId(fileDescriptors: string[]): string {
  checkpointCounter += 1
  const sorted = [...fileDescriptors].sort()
  const hash = computeContentHash(sorted.join('|'))
  return `chk_${Date.now()}_${checkpointCounter}_${hash.slice(0, 16)}`
}

export class ShadowCheckpointManager {
  private shadowBuffer: ShadowBuffer
  private checkpoints: Map<string, ShadowCheckpoint> = new Map()
  private activeCheckpointId: string | null = null
  private listeners: Set<CheckpointChangeListener> = new Set()

  constructor(shadowBuffer: ShadowBuffer) {
    this.shadowBuffer = shadowBuffer
  }

  /**
   * Subscribes to checkpoint lifecycle changes.
   */
  public subscribe(listener: CheckpointChangeListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(checkpoint: ShadowCheckpoint): void {
    for (const listener of this.listeners) {
      try {
        listener(checkpoint)
      } catch (err) {
        console.error('CheckpointManager listener error:', err)
      }
    }
  }

  /**
   * Captures all currently dirty ShadowBuffer entries into an immutable checkpoint.
   * Clean files are strictly excluded. Later edits to ShadowBuffer will not mutate
   * this checkpoint's snapshot.
   */
  public createCheckpoint(workspaceRoot?: string | null): ShadowCheckpoint {
    const dirtyFiles = this.shadowBuffer.listDirtyFiles()
    const filesMap = new Map<string, CheckpointFileEntry>()
    const descriptors: string[] = []

    for (const filePath of dirtyFiles) {
      const snap = this.shadowBuffer.getSnapshot(filePath, workspaceRoot)
      if (snap && snap.dirty) {
        const fileEntry: CheckpointFileEntry = Object.freeze({
          path: snap.normalizedPath,
          originalContent: snap.originalContent,
          originalHash: snap.originalHash,
          shadowContent: snap.shadowContent,
          shadowHash: snap.currentHash,
          revision: snap.revision,
          isConflicted: snap.isConflicted,
          conflictReason: snap.conflictReason
        })
        filesMap.set(snap.normalizedPath.toLowerCase(), fileEntry)
        descriptors.push(`${snap.normalizedPath}:${snap.currentHash}`)
      }
    }

    const checkpointId = generateCheckpointId(descriptors)
    const checkpoint: ShadowCheckpoint = Object.freeze({
      checkpointId,
      createdAt: Date.now(),
      files: Object.freeze(filesMap) as ReadonlyMap<string, CheckpointFileEntry>,
      state: 'ACTIVE',
      fileCount: filesMap.size
    })

    this.checkpoints.set(checkpointId, checkpoint)
    this.activeCheckpointId = checkpointId
    this.notify(checkpoint)

    return checkpoint
  }

  /**
   * Returns the currently active checkpoint, if any.
   */
  public getActiveCheckpoint(): ShadowCheckpoint | null {
    if (!this.activeCheckpointId) return null
    return this.checkpoints.get(this.activeCheckpointId) || null
  }

  /**
   * Retrieves a checkpoint by ID.
   */
  public getCheckpoint(id: string): ShadowCheckpoint | null {
    return this.checkpoints.get(id) || null
  }

  /**
   * Lists all files in the active or specified checkpoint.
   */
  public listCheckpointFiles(checkpointId?: string): CheckpointFileEntry[] {
    const cp = checkpointId ? this.getCheckpoint(checkpointId) : this.getActiveCheckpoint()
    if (!cp) return []
    return Array.from(cp.files.values())
  }

  /**
   * Returns the number of files in the active or specified checkpoint.
   */
  public getFileCount(checkpointId?: string): number {
    const cp = checkpointId ? this.getCheckpoint(checkpointId) : this.getActiveCheckpoint()
    return cp ? cp.fileCount : 0
  }

  /**
   * Checks whether a file exists in the active or specified checkpoint.
   */
  public hasFile(filePath: string, checkpointId?: string, workspaceRoot?: string | null): boolean {
    const cp = checkpointId ? this.getCheckpoint(checkpointId) : this.getActiveCheckpoint()
    if (!cp) return false
    const norm = normalizeFilePath(filePath, workspaceRoot).toLowerCase()
    return cp.files.has(norm)
  }

  /**
   * Retrieves a file entry from the active or specified checkpoint.
   */
  public getFile(
    filePath: string,
    checkpointId?: string,
    workspaceRoot?: string | null
  ): CheckpointFileEntry | undefined {
    const cp = checkpointId ? this.getCheckpoint(checkpointId) : this.getActiveCheckpoint()
    if (!cp) return undefined
    const norm = normalizeFilePath(filePath, workspaceRoot).toLowerCase()
    return cp.files.get(norm)
  }

  /**
   * Updates a checkpoint's state and notifies listeners.
   */
  private updateCheckpointState(
    checkpointId: string,
    state: CheckpointState
  ): ShadowCheckpoint | null {
    const current = this.checkpoints.get(checkpointId)
    if (!current) return null

    const updated: ShadowCheckpoint = Object.freeze({
      ...current,
      state
    })
    this.checkpoints.set(checkpointId, updated)
    this.notify(updated)
    return updated
  }

  /**
   * Resolves the filesystem API bridge.
   */
  private resolveFsApi(options?: CheckpointCommitOptions): ElectronFsApiBridge | null {
    if (options?.electronAPI) return options.electronAPI
    if (typeof window !== 'undefined' && window.electronAPI) {
      return window.electronAPI as unknown as ElectronFsApiBridge
    }
    return null
  }

  /**
   * Preflight validation: validates the entire checkpoint before any file is written.
   *
   * For every file:
   * 1. Path is normalized and within workspace boundary.
   * 2. Reads current disk content.
   * 3. Compares current disk hash with checkpoint original hash.
   * 4. Detects conflicts and missing files.
   *
   * If ANY file fails, preflight returns valid = false.
   */
  public async preflight(
    checkpointId?: string,
    workspaceRoot?: string,
    fsApiOverride?: ElectronFsApiBridge
  ): Promise<CheckpointPreflightResult> {
    const cp = checkpointId ? this.getCheckpoint(checkpointId) : this.getActiveCheckpoint()
    if (!cp) {
      return {
        valid: false,
        checkedFiles: 0,
        errors: [{ path: '', error: 'No active checkpoint to validate.' }],
        conflictedFiles: []
      }
    }

    if (cp.fileCount === 0) {
      return {
        valid: true,
        checkedFiles: 0,
        errors: [],
        conflictedFiles: []
      }
    }

    if (!workspaceRoot || !isSafePath(workspaceRoot)) {
      return {
        valid: false,
        checkedFiles: 0,
        errors: [{ path: '', error: 'Invalid or missing workspace root.' }],
        conflictedFiles: []
      }
    }

    const fsApi = fsApiOverride || this.resolveFsApi()
    if (!fsApi || typeof fsApi.readWorkspaceFile !== 'function') {
      return {
        valid: false,
        checkedFiles: 0,
        errors: [{ path: '', error: 'Filesystem read API is not available.' }],
        conflictedFiles: []
      }
    }

    const errors: CheckpointPreflightError[] = []
    const conflictedFiles: string[] = []

    for (const file of cp.files.values()) {
      if (!isSafePath(file.path)) {
        errors.push({
          path: file.path,
          error: `Unsafe or invalid file path: '${file.path}'`
        })
        continue
      }

      // Check external modifications on disk
      try {
        const readResult = await fsApi.readWorkspaceFile(workspaceRoot, file.path)
        if (!readResult.success) {
          const errMsg = readResult.error || 'File does not exist on disk.'
          errors.push({
            path: file.path,
            error: `PREFLIGHT_FAIL: Cannot read '${file.path}': ${errMsg}`,
            conflict: true
          })
          conflictedFiles.push(file.path)
          this.shadowBuffer.markConflicted(file.path, errMsg, workspaceRoot)
          continue
        }

        const diskContent = readResult.content ?? ''
        const diskHash = computeContentHash(diskContent)

        if (diskHash !== file.originalHash) {
          const conflictReason = `SHADOW_CONFLICT: Workspace file '${file.path}' changed externally after checkpoint baseline.`
          errors.push({
            path: file.path,
            error: conflictReason,
            conflict: true,
            expectedHash: file.originalHash,
            actualHash: diskHash
          })
          conflictedFiles.push(file.path)
          this.shadowBuffer.markConflicted(file.path, conflictReason, workspaceRoot)
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        errors.push({
          path: file.path,
          error: `PREFLIGHT_ERROR reading '${file.path}': ${msg}`
        })
      }
    }

    const valid = errors.length === 0
    if (!valid) {
      this.updateCheckpointState(cp.checkpointId, 'CONFLICTED')
    }

    return {
      valid,
      checkedFiles: cp.fileCount,
      errors,
      conflictedFiles
    }
  }

  /**
   * Commits the checkpoint transactionally across all files.
   *
   * Flow:
   * 1. Preflight entire checkpoint.
   * 2. If any error/conflict: abort with zero writes.
   * 3. Request user approval (if not skipped).
   * 4. Begin commit sequence with recovery journaling.
   * 5. If any write fails: rollback previously written files in reverse order.
   * 6. Verify rollback restoration against original hashes.
   * 7. If all writes succeed: synchronize ShadowBuffer and mark COMMITTED.
   */
  public async commitCheckpoint(
    checkpointId?: string,
    options?: CheckpointCommitOptions
  ): Promise<CheckpointCommitResult> {
    const cp = checkpointId ? this.getCheckpoint(checkpointId) : this.getActiveCheckpoint()
    if (!cp) {
      return {
        success: false,
        checkpointId: checkpointId || '',
        state: 'FAILED',
        committedFiles: [],
        error: 'No checkpoint found to commit.'
      }
    }

    if (cp.fileCount === 0) {
      this.updateCheckpointState(cp.checkpointId, 'COMMITTED')
      return {
        success: true,
        checkpointId: cp.checkpointId,
        state: 'COMMITTED',
        committedFiles: []
      }
    }

    const workspaceRoot = options?.workspaceRoot
    if (!workspaceRoot || !isSafePath(workspaceRoot)) {
      return {
        success: false,
        checkpointId: cp.checkpointId,
        state: 'FAILED',
        committedFiles: [],
        error: 'Invalid or missing workspace root.'
      }
    }

    const fsApi = this.resolveFsApi(options)
    if (!fsApi || typeof fsApi.editWorkspaceFile !== 'function') {
      return {
        success: false,
        checkpointId: cp.checkpointId,
        state: 'FAILED',
        committedFiles: [],
        error: 'Filesystem edit API is not available.'
      }
    }

    // Step 1: Preflight validation across ALL files
    const preflightRes = await this.preflight(cp.checkpointId, workspaceRoot, fsApi)
    if (!preflightRes.valid) {
      const firstErr = preflightRes.errors[0]
      return {
        success: false,
        checkpointId: cp.checkpointId,
        state: 'CONFLICTED',
        committedFiles: [],
        conflict: true,
        error: `Preflight failed: ${firstErr?.error || 'Validation errors detected.'}`
      }
    }

    // Step 2: Approval flow
    if (!options?.skipApproval && options?.requestApproval) {
      const fileList = Array.from(cp.files.values())
      const isApproved = await options.requestApproval(fileList)
      if (!isApproved) {
        return {
          success: false,
          checkpointId: cp.checkpointId,
          state: cp.state,
          committedFiles: [],
          rejected: true,
          error: 'Transaction rejected by user.'
        }
      }
    }

    // Step 3: Begin commit transaction
    this.updateCheckpointState(cp.checkpointId, 'COMMITTING')
    const journal: RollbackJournalEntry[] = []
    const committedFiles: string[] = []
    let failedFile: string | null = null
    let writeError: string | null = null

    for (const file of cp.files.values()) {
      // Test simulation hook
      if (options?._simulateWriteFailureOnPath === file.path) {
        failedFile = file.path
        writeError = `Simulated disk write failure on '${file.path}'`
        break
      }

      try {
        const editRes = await fsApi.editWorkspaceFile(
          workspaceRoot,
          file.path,
          file.shadowContent,
          file.originalContent
        )

        if (!editRes.success) {
          failedFile = file.path
          writeError = editRes.error || `Failed to write file '${file.path}'`
          break
        }

        // Record in recovery journal
        journal.push({
          path: file.path,
          previousDiskContent: file.originalContent,
          previousHash: file.originalHash,
          newContent: file.shadowContent,
          writeStatus: 'written'
        })
        committedFiles.push(file.path)
      } catch (err: unknown) {
        failedFile = file.path
        writeError = err instanceof Error ? err.message : String(err)
        break
      }
    }

    // Step 4: Handle partial-commit failure and rollback
    if (failedFile !== null) {
      console.warn(`[Checkpoint] Write failed on '${failedFile}': ${writeError}. Initiating rollback.`)
      const rolledBackFiles: string[] = []
      let criticalRecoveryError: string | null = null

      // Rollback in reverse order of modifications
      for (let i = journal.length - 1; i >= 0; i--) {
        const item = journal[i]

        // Test simulation hook for rollback failure
        const simulateRollbackFail =
          options?._simulateRollbackFailureOnPath === item.path

        try {
          let restoreRes: { success: boolean; error?: string }
          if (simulateRollbackFail) {
            restoreRes = { success: false, error: 'Simulated restore write failure' }
          } else {
            restoreRes = await fsApi.editWorkspaceFile(
              workspaceRoot,
              item.path,
              item.previousDiskContent
            )
          }

          if (!restoreRes.success) {
            item.writeStatus = 'restore_failed'
            item.error = restoreRes.error
            criticalRecoveryError = `CRITICAL_RECOVERY_FAILURE: Could not restore file '${item.path}': ${restoreRes.error}`
            continue
          }

          // Step 5: Verify rollback by re-reading restored file and checking hash
          const verifyRead = await fsApi.readWorkspaceFile(workspaceRoot, item.path)
          const restoredHash = computeContentHash(verifyRead.content ?? '')

          if (restoredHash === item.previousHash) {
            item.writeStatus = 'restored'
            rolledBackFiles.push(item.path)
          } else {
            item.writeStatus = 'restore_failed'
            criticalRecoveryError = `CRITICAL_ROLLBACK_VERIFICATION_FAILED: Restored hash mismatch for '${item.path}'. Expected ${item.previousHash}, got ${restoredHash}`
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          item.writeStatus = 'restore_failed'
          item.error = msg
          criticalRecoveryError = `CRITICAL_RECOVERY_EXCEPTION on '${item.path}': ${msg}`
        }
      }

      const finalState: CheckpointState = criticalRecoveryError ? 'FAILED' : 'ROLLED_BACK'
      this.updateCheckpointState(cp.checkpointId, finalState)

      return {
        success: false,
        checkpointId: cp.checkpointId,
        state: finalState,
        committedFiles: [],
        rolledBackFiles,
        error: `TRANSACTION_ROLLED_BACK: Write failed on '${failedFile}': ${writeError}. Restored ${rolledBackFiles.length} file(s).`,
        recoveryError: criticalRecoveryError || undefined,
        journal
      }
    }

    // Step 6: Transaction succeeded completely!
    // Synchronize ShadowBuffer baselines for all committed files
    for (const file of cp.files.values()) {
      this.shadowBuffer.syncCommitted(file.path, file.shadowContent, workspaceRoot)
      options?.onFileCommitted?.(file.path, file.shadowContent)
    }

    this.updateCheckpointState(cp.checkpointId, 'COMMITTED')

    return {
      success: true,
      checkpointId: cp.checkpointId,
      state: 'COMMITTED',
      committedFiles,
      journal
    }
  }

  /**
   * Safely discards all staged in-memory changes across the checkpoint.
   * Leaves physical workspace files on disk 100% untouched.
   */
  public discard(
    checkpointId?: string,
    workspaceRoot?: string | null
  ): { success: boolean; discardedFiles: string[] } {
    const cp = checkpointId ? this.getCheckpoint(checkpointId) : this.getActiveCheckpoint()
    if (!cp) {
      return { success: false, discardedFiles: [] }
    }

    const discardedFiles: string[] = []
    for (const file of cp.files.values()) {
      this.shadowBuffer.reset(file.path, workspaceRoot)
      this.shadowBuffer.remove(file.path, workspaceRoot)
      discardedFiles.push(file.path)
    }

    this.updateCheckpointState(cp.checkpointId, 'ROLLED_BACK')
    return {
      success: true,
      discardedFiles
    }
  }

  /**
   * Marks a specific file and the active checkpoint as conflicted.
   */
  public markFileConflicted(
    filePath: string,
    reason: string,
    workspaceRoot?: string | null
  ): void {
    const norm = normalizeFilePath(filePath, workspaceRoot).toLowerCase()
    const active = this.getActiveCheckpoint()
    if (active && active.files.has(norm)) {
      this.updateCheckpointState(active.checkpointId, 'CONFLICTED')
    }
    this.shadowBuffer.markConflicted(filePath, reason, workspaceRoot)
  }
}
