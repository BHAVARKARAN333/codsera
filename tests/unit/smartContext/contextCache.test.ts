import { describe, it, expect, beforeEach } from 'vitest'
import { ContextCache, computeContentHash } from '@renderer/services/agent/contextCache'

describe('contextCache Unit Tests', () => {
  describe('computeContentHash', () => {
    it('produces deterministic 16-character hexadecimal hash', () => {
      const hash1 = computeContentHash('export const x = 1')
      const hash2 = computeContentHash('export const x = 1')
      expect(hash1).toBe(hash2)
      expect(hash1).toHaveLength(16)
      expect(/^[0-9a-f]{16}$/.test(hash1)).toBe(true)
    })

    it('generates different hashes for different contents', () => {
      const hashA = computeContentHash('function testA() {}')
      const hashB = computeContentHash('function testB() {}')
      expect(hashA).not.toBe(hashB)
    })

    it('handles empty strings and large text deterministically', () => {
      const emptyHash = computeContentHash('')
      expect(emptyHash).toHaveLength(16)

      const largeText = 'const str = "hello world";\n'.repeat(1000)
      const largeHash = computeContentHash(largeText)
      expect(largeHash).toHaveLength(16)
      expect(computeContentHash(largeText)).toBe(largeHash)
    })
  })

  describe('ContextCache class', () => {
    let cache: ContextCache

    beforeEach(() => {
      cache = new ContextCache(false)
    })

    it('stores and retrieves normalized file entries', () => {
      cache.set('src/components/Header.tsx', 'export const Header = () => null')

      const entry = cache.get('src/components/Header.tsx')
      expect(entry).not.toBeNull()
      expect(entry?.normalizedPath).toBe('src/components/header.tsx')
      expect(entry?.content).toBe('export const Header = () => null')
      expect(entry?.fileSize).toBe('export const Header = () => null'.length)
      expect(entry?.version).toBe(1)
    })

    it('normalizes path keys across Windows backslashes and casing', () => {
      cache.set('SRC\\Utils\\Math.ts', 'export const add = (a, b) => a + b')

      const entry1 = cache.get('src/utils/math.ts')
      const entry2 = cache.get('SRC/UTILS/MATH.TS')
      const entry3 = cache.get('src\\utils\\math.ts')

      expect(entry1).not.toBeNull()
      expect(entry2).not.toBeNull()
      expect(entry3).not.toBeNull()
      expect(entry1?.content).toBe('export const add = (a, b) => a + b')
    })

    it('detects content changes accurately with hasContentChanged', () => {
      cache.set('src/index.ts', 'console.log("v1")')

      expect(cache.hasContentChanged('src/index.ts', 'console.log("v1")')).toBe(false)
      expect(cache.hasContentChanged('src/index.ts', 'console.log("v2")')).toBe(true)
      expect(cache.hasContentChanged('src/nonexistent.ts', 'console.log("v1")')).toBe(true)
    })

    it('increments version on updating existing cached file', () => {
      cache.set('src/app.ts', 'v1')
      expect(cache.get('src/app.ts')?.version).toBe(1)

      cache.set('src/app.ts', 'v2')
      expect(cache.get('src/app.ts')?.version).toBe(2)
      expect(cache.get('src/app.ts')?.content).toBe('v2')
    })

    it('invalidates entries and tracks statistics', () => {
      cache.set('file1.ts', 'content 1')
      cache.set('file2.ts', 'content 2')

      // 1 hit, 1 miss
      const hit = cache.get('file1.ts')
      const miss = cache.get('missing.ts')
      expect(hit).not.toBeNull()
      expect(miss).toBeNull()

      cache.invalidate('file1.ts')
      expect(cache.get('file1.ts')).toBeNull()

      const stats = cache.getStats()
      expect(stats.hits).toBe(1)
      expect(stats.misses).toBe(2) // 'missing.ts' and 'file1.ts' after invalidation
      expect(stats.invalidations).toBe(1)
      expect(stats.cachedFilesCount).toBe(1) // only file2.ts remains
    })

    it('clears all cached data and resets statistics', () => {
      cache.set('file1.ts', 'content 1')
      cache.set('file2.ts', 'content 2')

      cache.clear()
      const stats = cache.getStats()
      expect(stats.cachedFilesCount).toBe(0)
      expect(stats.totalCachedChars).toBe(0)
      expect(cache.get('file1.ts')).toBeNull()
    })
  })
})
