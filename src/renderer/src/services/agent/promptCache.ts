/**
 * Prompt Cache & Static Prompt Snapshot Management (Phase 11.4)
 *
 * Implements local, deterministic prompt caching and static/dynamic context separation.
 * Separates immutable agent instructions, rules, and tool declarations (STATIC)
 * from ephemeral query context, file slices, active editor state, and history (DYNAMIC).
 *
 * Provides bounded in-memory caching with deterministic hashing and safe eviction.
 */

import type { FunctionDeclaration } from '../ai/types'
import { computeContentHash } from './contextCache'

export interface StaticPromptSnapshot {
  /**
   * Deterministic version hash calculated from static system instructions and tool schemas.
   */
  hash: string

  /**
   * Static prompt cache key (matches hash).
   */
  key: string

  /**
   * Semantic version string / digest representing this snapshot.
   */
  version: string

  /**
   * Static system instructions containing stable agent rules, tool instructions, and anti-fabrication contracts.
   */
  systemPrompt: string

  /**
   * Tool declarations array (FunctionDeclaration[]).
   */
  toolDeclarations: FunctionDeclaration[]

  /**
   * Hash of the normalized, serialized tool schemas.
   */
  toolSchemaHash: string

  /**
   * Character length of the static system prompt.
   */
  systemPromptChars: number
}

export interface PromptCacheDiagnostics {
  cacheHit: boolean
  staticPromptKey: string
  staticPromptVersion: string
  dynamicContextChars: number
  deduplicatedContextChars: number
}

export class StaticPromptCache {
  private cache: Map<string, StaticPromptSnapshot> = new Map()
  private maxEntries: number
  private debug = false
  private hits = 0
  private misses = 0

  constructor(maxEntries = 20, debug = false) {
    this.maxEntries = Math.max(1, maxEntries)
    this.debug = debug
  }

  setDebug(enabled: boolean): void {
    this.debug = enabled
  }

  /**
   * Computes a deterministic cache key from static system instructions and tool declarations.
   * Does NOT incorporate random values, timestamps, API credentials, or dynamic context.
   */
  computeKey(systemPrompt: string, tools: FunctionDeclaration[]): { key: string; toolSchemaHash: string } {
    const normalizedTools = [...(tools || [])]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => ({
        name: t.name,
        description: t.description || '',
        parameters: t.parameters || {}
      }))

    const serializedTools = JSON.stringify(normalizedTools)
    const toolSchemaHash = computeContentHash(serializedTools)
    const combinedContent = `rules:${systemPrompt.trim()}###tools:${serializedTools}`
    const key = computeContentHash(combinedContent)

    return { key, toolSchemaHash }
  }

  /**
   * Retrieves a cached snapshot by key. If found, marks LRU freshness.
   */
  get(key: string): StaticPromptSnapshot | undefined {
    const entry = this.cache.get(key)
    if (entry) {
      this.hits++
      // LRU refresh: re-insert at end
      this.cache.delete(key)
      this.cache.set(key, entry)
      if (this.debug) {
        console.debug(`[PromptCache] HIT key=${key}`)
      }
      return entry
    }
    this.misses++
    if (this.debug) {
      console.debug(`[PromptCache] MISS key=${key}`)
    }
    return undefined
  }

  /**
   * Stores a snapshot in cache, evicting the oldest entry if exceeding maxEntries.
   */
  set(key: string, snapshot: StaticPromptSnapshot): void {
    if (this.cache.has(key)) {
      this.cache.delete(key)
    } else if (this.cache.size >= this.maxEntries) {
      const oldestKey = this.cache.keys().next().value
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey)
      }
    }
    this.cache.set(key, snapshot)
  }

  has(key: string): boolean {
    return this.cache.has(key)
  }

  clear(): void {
    this.cache.clear()
    this.hits = 0
    this.misses = 0
  }

  size(): number {
    return this.cache.size
  }

  getStats(): { hits: number; misses: number; size: number; maxEntries: number } {
    return {
      hits: this.hits,
      misses: this.misses,
      size: this.cache.size,
      maxEntries: this.maxEntries
    }
  }

  /**
   * Creates or resolves a snapshot from the cache.
   */
  getOrCreateSnapshot(systemPrompt: string, tools: FunctionDeclaration[]): {
    snapshot: StaticPromptSnapshot
    cacheHit: boolean
  } {
    const { key, toolSchemaHash } = this.computeKey(systemPrompt, tools)
    const existing = this.get(key)
    if (existing) {
      return { snapshot: existing, cacheHit: true }
    }

    const snapshot: StaticPromptSnapshot = {
      hash: key,
      key,
      version: key,
      systemPrompt: systemPrompt.trim(),
      toolDeclarations: tools,
      toolSchemaHash,
      systemPromptChars: systemPrompt.trim().length
    }

    this.set(key, snapshot)
    return { snapshot, cacheHit: false }
  }
}
