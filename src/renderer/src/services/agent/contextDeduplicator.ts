/**
 * Context Deduplicator - Phase 2
 * Prevents redundant files or duplicate tool outputs from entering the active prompt context.
 */

import { computeContentHash } from './contextCache'

export class ContextDeduplicator {
  private activeFiles: Map<string, string> = new Map() // normalizedPath -> contentHash
  private toolResults: Map<string, string> = new Map() // toolKey -> outputHash
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

  /**
   * Checks if a file is already loaded in the active context with matching hash.
   */
  isFileInContext(filePath: string, content?: string): boolean {
    const key = this.normalizeKey(filePath)
    if (!this.activeFiles.has(key)) return false
    if (content === undefined) return true
    const hash = computeContentHash(content)
    return this.activeFiles.get(key) === hash
  }

  /**
   * Marks a file as loaded into active context.
   */
  markFileInContext(filePath: string, content: string): void {
    const key = this.normalizeKey(filePath)
    const hash = computeContentHash(content)
    this.activeFiles.set(key, hash)
    if (this.debug) {
      console.debug(`[ContextDeduplicator] Marked file in context: ${key} (${hash.slice(0, 8)})`)
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
   * Invalidate a specific file from active context (e.g. after edit).
   */
  invalidateFile(filePath: string): void {
    const key = this.normalizeKey(filePath)
    this.activeFiles.delete(key)
  }

  /**
   * Clears all active context tracking.
   */
  reset(): void {
    this.activeFiles.clear()
    this.toolResults.clear()
    if (this.debug) {
      console.debug('[ContextDeduplicator] Reset active context records')
    }
  }

  /**
   * Gets list of all currently active files in context.
   */
  getActiveFiles(): string[] {
    return Array.from(this.activeFiles.keys())
  }
}
