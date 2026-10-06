/**
 * Bounded In-Memory Parse Cache for Tree-sitter Parser (Phase 11.5)
 *
 * Implements a bounded LRU cache for parsed source files and extracted symbols.
 * Safe for both Electron main and renderer processes (zero native dependencies).
 */

import { ParseResult } from './types'

export interface CacheStats {
  size: number
  maxEntries: number
  hits: number
  misses: number
  evictions: number
  hitRate: number
}

/**
 * Deterministic fast 64-bit hash for source code strings.
 * Renderer-safe (no Node crypto dependency).
 */
export function computeContentHash(content: string): string {
  let h1 = 0xdeadbeef ^ content.length
  let h2 = 0x41c6ce57 ^ content.length
  for (let i = 0; i < content.length; i++) {
    const ch = content.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return `${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`
}

export class ParserCache {
  private readonly maxEntries: number
  private readonly cache = new Map<string, ParseResult>()
  private hits = 0
  private misses = 0
  private evictions = 0

  constructor(maxEntries = 100) {
    this.maxEntries = Math.max(1, maxEntries)
  }

  private buildKey(filePath: string, content: string): string {
    return `${filePath}:::${computeContentHash(content)}`
  }

  /**
   * Retrieves a cached ParseResult if the file path and content hash match.
   * Updates LRU order on hit.
   */
  get(filePath: string, content: string): ParseResult | undefined {
    const key = this.buildKey(filePath, content)
    const result = this.cache.get(key)

    if (result) {
      this.hits++
      // Move to back of Map for LRU freshness
      this.cache.delete(key)
      this.cache.set(key, result)
      return {
        ...result,
        cached: true
      }
    }

    this.misses++
    return undefined
  }

  /**
   * Caches a ParseResult. Evicts the oldest entry if maxEntries is reached.
   */
  set(filePath: string, content: string, result: ParseResult): void {
    const key = this.buildKey(filePath, content)

    if (this.cache.has(key)) {
      this.cache.delete(key)
    } else if (this.cache.size >= this.maxEntries) {
      // Map keys iterator yields keys in insertion order; first is the least recently used
      const oldestKey = this.cache.keys().next().value
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey)
        this.evictions++
      }
    }

    this.cache.set(key, result)
  }

  /**
   * Checks whether an exact entry is in the cache without updating hit/miss stats.
   */
  has(filePath: string, content: string): boolean {
    const key = this.buildKey(filePath, content)
    return this.cache.has(key)
  }

  /**
   * Invalidates all entries for a specific filePath.
   */
  invalidateFile(filePath: string): void {
    const prefix = `${filePath}:::`
    for (const key of Array.from(this.cache.keys())) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key)
      }
    }
  }

  /**
   * Clears all cached entries and resets statistics.
   */
  clear(): void {
    this.cache.clear()
    this.hits = 0
    this.misses = 0
    this.evictions = 0
  }

  /**
   * Returns cache utilization and hit/miss statistics.
   */
  getStats(): CacheStats {
    const totalRequests = this.hits + this.misses
    return {
      size: this.cache.size,
      maxEntries: this.maxEntries,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      hitRate: totalRequests > 0 ? this.hits / totalRequests : 0
    }
  }
}
