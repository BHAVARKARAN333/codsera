/**
 * Context Deduplicator - Phase 11.4 Optimization
 * Prevents redundant files, file slices, or duplicate tool outputs from entering active prompt context.
 * Uses deterministic 64-bit content hashing and range-aware slice tracking.
 */

import { computeContentHash } from './contextCache'

export class ContextDeduplicator {
  private activeFiles: Map<string, string> = new Map() // normalizedPath -> contentHash
  private activeSlices: Map<string, string> = new Map() // sliceKey -> contentHash
  private toolResults: Map<string, string> = new Map() // toolKey -> outputHash
  private deduplicatedCharsSaved = 0
  private debug = false

  constructor(debug = false) {
    this.debug = debug
  }

  setDebug(enabled: boolean): void {
    this.debug = enabled
  }

  private normalizeKey(filePath: string): string {
    return filePath.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase()
  }

  private getSliceKey(filePath: string, startLine?: number, endLine?: number): string {
    const norm = this.normalizeKey(filePath)
    if (typeof startLine === 'number' && typeof endLine === 'number') {
      return `${norm}:lines:${startLine}-${endLine}`
    }
    return `${norm}:full`
  }

  /**
   * Checks if a file (full file) is already loaded in the active context with matching hash.
   */
  isFileInContext(filePath: string, content?: string): boolean {
    const key = this.normalizeKey(filePath)
    if (this.activeFiles.has(key)) {
      if (content === undefined) return true
      const hash = computeContentHash(content)
      if (this.activeFiles.get(key) === hash) return true
    }
    return this.isFileSliceInContext(filePath, undefined, undefined, content)
  }

  /**
   * Checks if a specific file slice (defined by path and optional 1-based startLine/endLine)
   * is already present in context with matching content.
   */
  isFileSliceInContext(filePath: string, startLine?: number, endLine?: number, content?: string): boolean {
    const sliceKey = this.getSliceKey(filePath, startLine, endLine)
    if (!this.activeSlices.has(sliceKey)) return false
    if (content === undefined) return true
    const hash = computeContentHash(content)
    return this.activeSlices.get(sliceKey) === hash
  }

  /**
   * Marks a full file as loaded into active context.
   */
  markFileInContext(filePath: string, content: string): void {
    const key = this.normalizeKey(filePath)
    const hash = computeContentHash(content)
    this.activeFiles.set(key, hash)
    this.markFileSliceInContext(filePath, undefined, undefined, content)
    if (this.debug) {
      console.debug(`[ContextDeduplicator] Marked file in context: ${key} (${hash.slice(0, 8)})`)
    }
  }

  /**
   * Marks a specific file slice into active context.
   */
  markFileSliceInContext(filePath: string, startLine?: number, endLine?: number, content?: string): void {
    const sliceKey = this.getSliceKey(filePath, startLine, endLine)
    const hash = computeContentHash(content || '')
    this.activeSlices.set(sliceKey, hash)
    if (!startLine && !endLine) {
      this.activeFiles.set(this.normalizeKey(filePath), hash)
    }
    if (this.debug) {
      console.debug(`[ContextDeduplicator] Marked slice in context: ${sliceKey} (${hash.slice(0, 8)})`)
    }
  }

  /**
   * Checks if a tool result with identical output has already been provided.
   */
  isToolResultDuplicate(toolName: string, argsKey: string, output: string): boolean {
    const key = `${toolName}:${argsKey}`.toLowerCase()
    if (!this.toolResults.has(key)) return false
    const hash = computeContentHash(output)
    return this.toolResults.get(key) === hash
  }

  /**
   * Marks a tool execution result in context.
   */
  markToolResult(toolName: string, argsKey: string, output: string): void {
    const key = `${toolName}:${argsKey}`.toLowerCase()
    const hash = computeContentHash(output)
    this.toolResults.set(key, hash)
  }

  /**
   * Invalidate a specific file (and all its line slices) from active context (e.g. after edit).
   */
  invalidateFile(filePath: string): void {
    const key = this.normalizeKey(filePath)
    this.activeFiles.delete(key)
    for (const sliceKey of Array.from(this.activeSlices.keys())) {
      if (sliceKey === key || sliceKey.startsWith(`${key}:`)) {
        this.activeSlices.delete(sliceKey)
      }
    }
  }

  /**
   * Clears all active context tracking.
   */
  reset(): void {
    this.activeFiles.clear()
    this.activeSlices.clear()
    this.toolResults.clear()
    this.deduplicatedCharsSaved = 0
    if (this.debug) {
      console.debug('[ContextDeduplicator] Reset active context records')
    }
  }

  /**
   * Records characters saved by omitting redundant context or duplicate tool output.
   */
  recordDeduplicatedChars(chars: number): void {
    if (chars > 0) {
      this.deduplicatedCharsSaved += chars
    }
  }

  /**
   * Returns total characters saved through deduplication in this session.
   */
  getDeduplicatedCharsSaved(): number {
    return this.deduplicatedCharsSaved
  }

  /**
   * Gets list of all currently active files in context.
   */
  getActiveFiles(): string[] {
    return Array.from(this.activeFiles.keys())
  }
}
