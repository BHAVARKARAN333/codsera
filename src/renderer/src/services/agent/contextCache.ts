/**
 * Context Cache - Phase 2
 * Stores normalized file contents, content hashes, last-read timestamps, and sizes.
 * Provides change detection, cache hit/miss/invalidation statistics, and smart refresh.
 */

export function computeContentHash(content: string): string {
  let h1 = 0xdeadbeef ^ 0
  let h2 = 0x41c6ce57 ^ 0
  for (let i = 0; i < content.length; i++) {
    const ch = content.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(16, '0')
}

export interface ContextCacheEntry {
  normalizedPath: string
  content: string
  contentHash: string
  lastReadTimestamp: number
  fileSize: number
  version: number
}

export interface ContextCacheStats {
  hits: number
  misses: number
  invalidations: number
  cachedFilesCount: number
  totalCachedChars: number
}

export class ContextCache {
  private cache: Map<string, ContextCacheEntry> = new Map()
  private fileVersions: Map<string, number> = new Map()
  private hits = 0
  private misses = 0
  private invalidations = 0
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
   * Retrieves an entry if present.
   */
  get(filePath: string): ContextCacheEntry | null {
    const key = this.normalizeKey(filePath)
    const entry = this.cache.get(key)
    if (entry) {
      this.hits++
      if (this.debug) {
        console.debug(`[ContextCache] HIT: ${key} (hash: ${entry.contentHash.slice(0, 8)})`)
      }
      return entry
    }
    this.misses++
    if (this.debug) {
      console.debug(`[ContextCache] MISS: ${key}`)
    }
    return null
  }

  /**
   * Checks if entry exists and whether its content has changed against new content.
   */
  hasContentChanged(filePath: string, newContent: string): boolean {
    const key = this.normalizeKey(filePath)
    const entry = this.cache.get(key)
    if (!entry) return true
    const newHash = computeContentHash(newContent)
    return entry.contentHash !== newHash
  }

  /**
   * Gets the monotonic version for a file path (0 if never set).
   */
  getVersion(filePath: string): number {
    return this.fileVersions.get(this.normalizeKey(filePath)) || 0
  }

  /**
   * Stores or updates a file in the cache.
   */
  set(filePath: string, content: string): ContextCacheEntry {
    const key = this.normalizeKey(filePath)
    const nextVersion = (this.fileVersions.get(key) || 0) + 1
    this.fileVersions.set(key, nextVersion)
    const hash = computeContentHash(content)
    const entry: ContextCacheEntry = {
      normalizedPath: key,
      content,
      contentHash: hash,
      lastReadTimestamp: Date.now(),
      fileSize: content.length,
      version: nextVersion
    }
    this.cache.set(key, entry)
    return entry
  }

  /**
   * Checks if a file is in the cache.
   */
  has(filePath: string): boolean {
    return this.cache.has(this.normalizeKey(filePath))
  }

  /**
   * Invalidates a specific file (e.g. after edit or external change).
   */
  invalidate(filePath: string): boolean {
    const key = this.normalizeKey(filePath)
    const nextVersion = (this.fileVersions.get(key) || 0) + 1
    this.fileVersions.set(key, nextVersion)
    const existed = this.cache.delete(key)
    if (existed) {
      this.invalidations++
      if (this.debug) {
        console.debug(`[ContextCache] INVALIDATED: ${key}`)
      }
    }
    return existed
  }

  /**
   * Clears the entire cache (e.g. workspace switch or new chat).
   */
  clear(): void {
    const count = this.cache.size
    this.cache.clear()
    this.fileVersions.clear()
    this.hits = 0
    this.misses = 0
    this.invalidations = 0
    if (this.debug && count > 0) {
      console.debug(`[ContextCache] CLEARED ${count} cached entries`)
    }
  }

  /**
   * Returns current statistics.
   */
  getStats(): ContextCacheStats {
    let totalChars = 0
    for (const entry of this.cache.values()) {
      totalChars += entry.fileSize
    }
    return {
      hits: this.hits,
      misses: this.misses,
      invalidations: this.invalidations,
      cachedFilesCount: this.cache.size,
      totalCachedChars: totalChars
    }
  }
}
