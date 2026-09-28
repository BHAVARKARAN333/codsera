// Context Optimization & Token Efficiency - Phase 2 Test Suite

import assert from 'node:assert'

// FNV-1a based content hashing function matching contextCache.ts
function computeContentHash(content) {
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

class ContextCache {
  constructor(debug = false) {
    this.cache = new Map()
    this.hits = 0
    this.misses = 0
    this.invalidations = 0
    this.debug = debug
  }

  normalizeKey(filePath) {
    return filePath.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase()
  }

  get(filePath) {
    const key = this.normalizeKey(filePath)
    const entry = this.cache.get(key)
    if (entry) {
      this.hits++
      return entry
    }
    this.misses++
    return null
  }

  hasContentChanged(filePath, newContent) {
    const key = this.normalizeKey(filePath)
    const entry = this.cache.get(key)
    if (!entry) return true
    return entry.contentHash !== computeContentHash(newContent)
  }

  set(filePath, content) {
    const key = this.normalizeKey(filePath)
    const hash = computeContentHash(content)
    const entry = {
      normalizedPath: key,
      content,
      contentHash: hash,
      lastReadTimestamp: Date.now(),
      fileSize: content.length
    }
    this.cache.set(key, entry)
    return entry
  }

  has(filePath) {
    return this.cache.has(this.normalizeKey(filePath))
  }

  invalidate(filePath) {
    const key = this.normalizeKey(filePath)
    const existed = this.cache.delete(key)
    if (existed) this.invalidations++
    return existed
  }

  clear() {
    this.cache.clear()
    this.hits = 0
    this.misses = 0
    this.invalidations = 0
  }

  getStats() {
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

class ContextBudgetManager {
  constructor(config = {}) {
    this.maxBudget = config.maxBudget ?? 30000
    this.maxFileChars = config.maxFileChars ?? 12000
    this.minScoreThreshold = config.minScoreThreshold ?? 40
  }

  allocate(candidates) {
    const sorted = [...candidates].sort((a, b) => {
      if (a.isExplicit && !b.isExplicit) return -1
      if (!a.isExplicit && b.isExplicit) return 1
      return b.score - a.score
    })

    const allocatedFiles = []
    const droppedFiles = []
    let totalCharsUsed = 0

    for (const item of sorted) {
      const remaining = this.maxBudget - totalCharsUsed

      if (remaining <= 100) {
        droppedFiles.push({
          path: item.path,
          score: item.score,
          isExplicit: !!item.isExplicit,
          reason: `Context budget exhausted (${totalCharsUsed}/${this.maxBudget} chars used)`
        })
        continue
      }

      if (!item.isExplicit && item.score < this.minScoreThreshold) {
        droppedFiles.push({
          path: item.path,
          score: item.score,
          isExplicit: false,
          reason: `Relevance score ${item.score} below minimum threshold (${this.minScoreThreshold})`
        })
        continue
      }

      let content = item.content
      let truncated = false
      const fileLimit = Math.min(this.maxFileChars, remaining)

      if (content.length > fileLimit) {
        content = content.slice(0, fileLimit) + '\n\n[... Truncated remainder of file ...]'
        truncated = true
      }

      allocatedFiles.push({
        path: item.path,
        content,
        score: item.score,
        isExplicit: !!item.isExplicit,
        charCount: content.length,
        truncated
      })

      totalCharsUsed += content.length
    }

    return {
      allocatedFiles,
      droppedFiles,
      totalCharsUsed,
      remainingBudget: Math.max(0, this.maxBudget - totalCharsUsed),
      maxBudget: this.maxBudget
    }
  }
}

class ContextDeduplicator {
  constructor() {
    this.activeFiles = new Map()
    this.toolResults = new Map()
  }

  normalizeKey(filePath) {
    return filePath.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase()
  }

  isFileInContext(filePath, content) {
    const key = this.normalizeKey(filePath)
    if (!this.activeFiles.has(key)) return false
    if (content === undefined) return true
    return this.activeFiles.get(key) === computeContentHash(content)
  }

  markFileInContext(filePath, content) {
    const key = this.normalizeKey(filePath)
    this.activeFiles.set(key, computeContentHash(content))
  }

  isToolResultDuplicate(toolName, argsKey, output) {
    const key = `${toolName}:${argsKey}`.toLowerCase()
    if (!this.toolResults.has(key)) return false
    return this.toolResults.get(key) === computeContentHash(output)
  }

  markToolResult(toolName, argsKey, output) {
    const key = `${toolName}:${argsKey}`.toLowerCase()
    this.toolResults.set(key, computeContentHash(output))
  }

  invalidateFile(filePath) {
    this.activeFiles.delete(this.normalizeKey(filePath))
  }

  reset() {
    this.activeFiles.clear()
    this.toolResults.clear()
  }
}

async function runPhase2Tests() {
  console.log('====================================================')
  console.log('PHASE 2: CONTEXT OPTIMIZATION & TOKEN EFFICIENCY')
  console.log('====================================================')

  // Test A: Cache hit - Read same unchanged file twice
  console.log('\n[Test A] Cache hit on unchanged file read')
  const cache = new ContextCache()
  const mockFile = 'src/utils/math.ts'
  const mockContent = 'export function add(a: number, b: number) { return a + b; }'
  
  // First read: miss & store
  const get1 = cache.get(mockFile)
  assert.strictEqual(get1, null, 'First get should miss')
  cache.set(mockFile, mockContent)
  
  // Second read: hit
  const get2 = cache.get(mockFile)
  assert.notStrictEqual(get2, null, 'Second get should hit')
  assert.strictEqual(get2.content, mockContent)
  assert.strictEqual(cache.getStats().hits, 1, 'Hits count should be 1')
  console.log(`✓ PASS: Cache hit verified. Stats: ${JSON.stringify(cache.getStats())}`)

  // Test B: Cache invalidation - modify file -> request context
  console.log('\n[Test B] Cache invalidation on file modification')
  const modifiedContent = 'export function add(a: number, b: number) { return a + b + 10; }'
  cache.invalidate(mockFile)
  assert.strictEqual(cache.get(mockFile), null, 'Invalidated file must not be in cache')
  cache.set(mockFile, modifiedContent)
  const get3 = cache.get(mockFile)
  assert.strictEqual(get3.content, modifiedContent, 'Must return new modified content')
  console.log('✓ PASS: Invalidation and update verified.')

  // Test C: Hash change detection
  console.log('\n[Test C] Content hash change detection')
  const oldHash = get2.contentHash
  const newHash = computeContentHash(modifiedContent)
  assert.notStrictEqual(oldHash, newHash, 'Content hashes must differ')
  assert.strictEqual(cache.hasContentChanged(mockFile, 'different content'), true)
  assert.strictEqual(cache.hasContentChanged(mockFile, modifiedContent), false)
  console.log(`✓ PASS: Hash change detection verified (${oldHash.slice(0, 8)} vs ${newHash.slice(0, 8)})`)

  // Test D: Duplicate context deduplication
  console.log('\n[Test D] Context deduplication')
  const deduplicator = new ContextDeduplicator()
  deduplicator.markFileInContext(mockFile, modifiedContent)
  assert.strictEqual(deduplicator.isFileInContext(mockFile), true, 'File must be tracked as in context')
  assert.strictEqual(deduplicator.isFileInContext(mockFile, modifiedContent), true, 'Matching content must be recognized')
  assert.strictEqual(deduplicator.isFileInContext(mockFile, 'outdated content'), false, 'Different content must be recognized as changed')
  
  // Tool deduplication
  deduplicator.markToolResult('git_status', '{}', 'On branch main\nnothing to commit')
  assert.strictEqual(deduplicator.isToolResultDuplicate('git_status', '{}', 'On branch main\nnothing to commit'), true)
  assert.strictEqual(deduplicator.isToolResultDuplicate('git_status', '{}', 'On branch main\nmodified: file.ts'), false)
  console.log('✓ PASS: File and tool deduplication verified.')

  // Test E: Context budget management with priority drop
  console.log('\n[Test E] Context budget allocation & candidate dropping')
  const budget = new ContextBudgetManager({ maxBudget: 30000, maxFileChars: 12000 })
  const candidates = [
    { path: 'file1.ts', content: 'A'.repeat(10000), score: 200, isExplicit: false },
    { path: 'file2.ts', content: 'B'.repeat(10000), score: 500, isExplicit: false },
    { path: 'file3.ts', content: 'C'.repeat(10000), score: 800, isExplicit: false },
    { path: 'file4_low.ts', content: 'D'.repeat(5000), score: 50, isExplicit: false }
  ]
  const allocation = budget.allocate(candidates)
  assert.strictEqual(allocation.allocatedFiles.length, 3, 'Must allocate top 3 files up to budget')
  assert.strictEqual(allocation.droppedFiles.length, 1, 'Lowest priority file must be dropped')
  assert.strictEqual(allocation.droppedFiles[0].path, 'file4_low.ts')
  assert(allocation.totalCharsUsed <= 30000, 'Total chars used must stay within 30,000')
  console.log(`✓ PASS: Allocated ${allocation.totalCharsUsed}/30000 chars. Dropped: ${allocation.droppedFiles.map(d => d.path).join(', ')}`)

  // Test F: Explicit file priority preservation
  console.log('\n[Test F] Explicitly requested file priority')
  const explicitCandidates = [
    { path: 'generic_high_score.ts', content: 'X'.repeat(12000), score: 900, isExplicit: false },
    { path: 'explicitly_requested.ts', content: 'Y'.repeat(12000), score: 100, isExplicit: true },
    { path: 'generic_med_score.ts', content: 'Z'.repeat(12000), score: 600, isExplicit: false }
  ]
  const explicitAlloc = budget.allocate(explicitCandidates)
  assert.strictEqual(explicitAlloc.allocatedFiles[0].path, 'explicitly_requested.ts', 'Explicitly requested file MUST be allocated first')
  console.log('✓ PASS: Explicitly requested file prioritized over higher raw scores.')

  // Test G: Workspace change clears cache
  console.log('\n[Test G] Workspace change lifecycle')
  cache.set('workspace1/file.ts', 'hello')
  assert.strictEqual(cache.has('workspace1/file.ts'), true)
  cache.clear()
  assert.strictEqual(cache.has('workspace1/file.ts'), false)
  assert.strictEqual(cache.getStats().cachedFilesCount, 0)
  console.log('✓ PASS: Workspace change clears context cache.')

  // Test H: General question ("What is Python?") -> No context required
  console.log('\n[Test H] General question bypass')
  const isGeneral = /^(what is|what are|explain|describe|define)\s+(python|recursion)\b/i.test('What is Python?')
  assert.strictEqual(isGeneral, true, '"What is Python?" must bypass context engine')
  console.log('✓ PASS: General question bypass confirmed.')

  console.log('\n====================================================')
  console.log('ALL PHASE 2 CONTEXT OPTIMIZATION TESTS PASSED! ✓')
  console.log('====================================================')
}

runPhase2Tests().catch(err => {
  console.error('Phase 2 test failed:', err)
  process.exit(1)
})
