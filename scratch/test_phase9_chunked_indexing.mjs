// Phase 9: Safe Chunked Indexing & Event-Loop Yielding Automated Test Suite

import assert from 'node:assert'

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

export function yieldToMain() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

const EXTENSIONS_TO_TRY = ['.ts', '.tsx', '.js', '.jsx', '.d.ts', '.mjs', '.cjs', '.json']
const CODE_EXTENSIONS = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'])

class DependencyAnalyzer {
  constructor() {
    this.workspaceFileLookup = new Map()
  }

  normalizePath(filePath) {
    return filePath.replace(/\\/g, '/').replace(/^\/+/, '')
  }

  normalizeKey(filePath) {
    return this.normalizePath(filePath).toLowerCase()
  }

  resolveImportPath(fromFilePath, importSpecifier, allWorkspaceFiles) {
    if (!importSpecifier.startsWith('.') && !importSpecifier.startsWith('/')) {
      return null
    }
    const fromNorm = this.normalizePath(fromFilePath)
    const fromDir = fromNorm.includes('/') ? fromNorm.slice(0, fromNorm.lastIndexOf('/')) : ''
    const parts = fromDir ? fromDir.split('/') : []
    const specParts = importSpecifier.replace(/\\/g, '/').split('/')

    for (const part of specParts) {
      if (part === '.' || part === '') continue
      if (part === '..') {
        parts.pop()
      } else {
        parts.push(part)
      }
    }

    const candidateBase = parts.join('/')
    const allNorm = allWorkspaceFiles.map((p) => this.normalizePath(p))
    const allLower = allNorm.map((p) => p.toLowerCase())

    for (const ext of EXTENSIONS_TO_TRY) {
      const candidate = `${candidateBase}${ext}`
      const idx = allLower.indexOf(candidate.toLowerCase())
      if (idx !== -1) return allNorm[idx]
    }

    const indexCandidate = `${candidateBase}/index`
    for (const ext of EXTENSIONS_TO_TRY) {
      const candidate = `${indexCandidate}${ext}`
      const idx = allLower.indexOf(candidate.toLowerCase())
      if (idx !== -1) return allNorm[idx]
    }

    return null
  }

  analyzeFileContent(filePath, content, allWorkspaceFiles) {
    const normPath = this.normalizePath(filePath)
    const imports = []
    const exports = []
    const unresolvedImports = []

    const importRegex = /(?:import\s+(?:[\w*\s{},]*\s+from\s+)?['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\))/g
    let match
    while ((match = importRegex.exec(content)) !== null) {
      const specifier = match[1] || match[2]
      if (specifier) {
        const resolved = this.resolveImportPath(normPath, specifier, allWorkspaceFiles)
        imports.push({ specifier, resolvedPath: resolved })
        if (!resolved && (specifier.startsWith('.') || specifier.startsWith('/'))) {
          unresolvedImports.push(specifier)
        }
      }
    }

    const exportRegex = /export\s+(?:const|let|var|function|class|type|interface)\s+([A-Za-z0-9_$]+)/g
    while ((match = exportRegex.exec(content)) !== null) {
      exports.push({ name: match[1], line: 1 })
    }

    return { imports, exports, unresolvedImports }
  }

  invalidateFile() {}
  clearCache() {}
}

class CodebaseIndex {
  constructor(dependencyAnalyzer) {
    this.dependencyAnalyzer = dependencyAnalyzer || new DependencyAnalyzer()
    this.entries = new Map()
    this.workspaceRoot = null
    this.activeBuildId = 0
    this.yieldCount = 0
  }

  normalizePath(filePath) {
    return filePath.replace(/\\/g, '/').replace(/^\/+/, '')
  }

  normalizeKey(filePath) {
    return this.normalizePath(filePath).toLowerCase()
  }

  clear() {
    this.activeBuildId++
    this.entries.clear()
    this.workspaceRoot = null
  }

  getAllFilePaths() {
    return Array.from(this.entries.values()).map((e) => e.normalizedPath)
  }

  findFile(filePath) {
    return this.entries.get(this.normalizeKey(filePath)) || null
  }

  removeFile(filePath) {
    const key = this.normalizeKey(filePath)
    return this.entries.delete(key)
  }

  updateFileMetadata(filePath, mtimeMs, fileSize) {
    const entry = this.findFile(filePath)
    if (entry) {
      if (mtimeMs !== undefined) entry.mtimeMs = mtimeMs
      if (fileSize !== undefined) entry.fileSize = fileSize
      entry.lastIndexed = Date.now()
    }
  }

  updateFile(filePath, content, allWorkspaceFiles, mtimeMs, fileSize) {
    return this.indexFile(filePath, content, allWorkspaceFiles, mtimeMs, fileSize)
  }

  serialize() {
    return {
      version: 1,
      workspaceRoot: this.workspaceRoot || '',
      entries: Array.from(this.entries.values())
    }
  }

  deserialize(payload) {
    if (!payload || !Array.isArray(payload.entries)) return false
    this.clear()
    this.workspaceRoot = payload.workspaceRoot || ''
    for (const e of payload.entries) {
      this.entries.set(this.normalizeKey(e.normalizedPath), e)
    }
    return true
  }

  async buildIndex(
    workspaceRoot,
    filePaths,
    fileReader,
    fileMetadataMap,
    shouldCancel,
    chunkSize = 25
  ) {
    this.clear()
    const buildId = ++this.activeBuildId
    this.workspaceRoot = workspaceRoot

    const cleanupIfActive = () => {
      if (this.activeBuildId === buildId && this.workspaceRoot === workspaceRoot) {
        this.clear()
      }
    }

    const normalizedPaths = filePaths.map((p) => this.normalizePath(p))
    let processedInChunk = 0

    for (const relPath of normalizedPaths) {
      if (shouldCancel && shouldCancel()) {
        cleanupIfActive()
        return false
      }

      if (relPath.startsWith('..') || relPath.includes('/../')) {
        continue
      }

      let content = null
      try {
        content = await fileReader(relPath)
      } catch (readErr) {
        cleanupIfActive()
        return false
      }

      if (shouldCancel && shouldCancel()) {
        cleanupIfActive()
        return false
      }

      if (content !== null) {
        const meta = fileMetadataMap?.get(relPath)
        this.indexFile(relPath, content, normalizedPaths, meta?.mtimeMs, meta?.size)
      }

      processedInChunk++
      if (processedInChunk >= chunkSize) {
        processedInChunk = 0
        this.yieldCount++
        await yieldToMain()
        if (shouldCancel && shouldCancel()) {
          cleanupIfActive()
          return false
        }
      }
    }

    return true
  }

  indexFile(filePath, content, allWorkspaceFiles, mtimeMs, fileSize) {
    const normPath = this.normalizePath(filePath)
    const key = this.normalizeKey(filePath)
    const ext = normPath.split('.').pop()?.toLowerCase() || ''
    const isCode = CODE_EXTENSIONS.has(ext)

    let imports = []
    let resolvedDependencies = []
    let exports = []

    if (isCode) {
      const depInfo = this.dependencyAnalyzer.analyzeFileContent(
        normPath,
        content,
        allWorkspaceFiles
      )
      imports = depInfo.imports.map((i) => i.specifier)
      resolvedDependencies = depInfo.imports.map((i) => i.resolvedPath).filter(Boolean)
      exports = depInfo.exports
    }

    const hash = computeContentHash(content)
    const entry = {
      normalizedPath: normPath,
      extension: ext,
      imports,
      resolvedDependencies,
      exports,
      contentHash: hash,
      fileSize: fileSize !== undefined ? fileSize : content.length,
      mtimeMs,
      lastIndexed: Date.now()
    }
    this.entries.set(key, entry)
    return entry
  }
}

class FullSmartContextEngine {
  constructor() {
    this.depAnalyzer = new DependencyAnalyzer()
    this.codebaseIndex = new CodebaseIndex(this.depAnalyzer)
    this.currentWorkspaceRoot = null
    this.activeIndexingSession = 0
    this.indexedWorkspaceRoot = null
    this.restoredWorkspaceRoot = null
    this.isIndexFresh = false
    this.isIndexRestored = false
    this.isIndexing = false
    this.isReconciling = false
    this.queuedWatcherEventsDuringRestore = []
    this.reconcileYieldCount = 0
    this.saveCount = 0
    this.mockFiles = new Map()
    this.mockTree = []
  }

  clearCache() {
    this.activeIndexingSession++
    this.isIndexing = false
    this.isReconciling = false
    this.queuedWatcherEventsDuringRestore = []
    this.codebaseIndex.clear()
  }

  onWorkspaceChange(newRoot) {
    const norm = newRoot ? newRoot.replace(/\\/g, '/').replace(/\/+$/, '') : null
    if (this.currentWorkspaceRoot !== norm) {
      this.currentWorkspaceRoot = norm
      this.clearCache()
    }
  }

  async initializeWorkspaceIndex(workspaceRoot) {
    if (!workspaceRoot) {
      this.currentWorkspaceRoot = null
      this.clearCache()
      return
    }

    const normalizedRoot = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '')
    if (this.currentWorkspaceRoot !== normalizedRoot) {
      this.currentWorkspaceRoot = normalizedRoot
      this.clearCache()
    }

    const sessionId = ++this.activeIndexingSession
    this.isIndexing = true

    try {
      const filePaths = Array.from(this.mockFiles.keys())
      const fileReader = async (relPath) => {
        if (sessionId !== this.activeIndexingSession || this.currentWorkspaceRoot !== normalizedRoot) return null
        return this.mockFiles.get(relPath) || null
      }

      const buildOk = await this.codebaseIndex.buildIndex(
        normalizedRoot,
        filePaths,
        fileReader,
        undefined,
        () => sessionId !== this.activeIndexingSession || this.currentWorkspaceRoot !== normalizedRoot,
        10 // Use 10 for testing chunks
      )

      if (buildOk && sessionId === this.activeIndexingSession && this.currentWorkspaceRoot === normalizedRoot) {
        this.indexedWorkspaceRoot = normalizedRoot
        this.isIndexFresh = true
        this.saveCount++
        await this.replayQueuedWatcherEvents(sessionId)
      } else {
        this.queuedWatcherEventsDuringRestore = []
        if (sessionId === this.activeIndexingSession && this.currentWorkspaceRoot === normalizedRoot) {
          this.codebaseIndex.clear()
        }
      }
    } catch (err) {
      this.queuedWatcherEventsDuringRestore = []
      if (sessionId === this.activeIndexingSession && this.currentWorkspaceRoot === normalizedRoot) {
        this.codebaseIndex.clear()
      }
    } finally {
      if (sessionId === this.activeIndexingSession) {
        this.isIndexing = false
      }
    }
  }

  async reconcileRestoredIndex(normalizedRoot, sessionId) {
    const diskPaths = Array.from(this.mockFiles.keys())
    const diskPathSet = new Set(diskPaths.map((p) => p.toLowerCase()))
    const indexedPaths = this.codebaseIndex.getAllFilePaths()
    const indexedPathSet = new Set(indexedPaths.map((p) => p.toLowerCase()))
    let indexChanged = false

    // Deletion loop
    let deletedCount = 0
    for (const indexedPath of indexedPaths) {
      if (sessionId !== this.activeIndexingSession || this.currentWorkspaceRoot !== normalizedRoot) return false
      const lower = indexedPath.toLowerCase()
      if (!diskPathSet.has(lower)) {
        this.codebaseIndex.removeFile(indexedPath)
        indexChanged = true
        deletedCount++
        if (deletedCount % 10 === 0) {
          this.reconcileYieldCount++
          await yieldToMain()
          if (sessionId !== this.activeIndexingSession || this.currentWorkspaceRoot !== normalizedRoot) return false
        }
      }
    }

    // Freshness loop
    let freshnessCount = 0
    for (const relPath of diskPaths) {
      if (sessionId !== this.activeIndexingSession || this.currentWorkspaceRoot !== normalizedRoot) return false
      const lower = relPath.toLowerCase()
      if (!indexedPathSet.has(lower)) continue

      const existingEntry = this.codebaseIndex.findFile(relPath)
      if (!existingEntry) continue

      const content = this.mockFiles.get(relPath) || ''
      const hash = computeContentHash(content)

      if (hash === existingEntry.contentHash) {
        // Fast-path
        freshnessCount++
        if (freshnessCount % 10 === 0) {
          this.reconcileYieldCount++
          await yieldToMain()
          if (sessionId !== this.activeIndexingSession || this.currentWorkspaceRoot !== normalizedRoot) return false
        }
        continue
      } else {
        this.codebaseIndex.updateFile(relPath, content, diskPaths)
        indexChanged = true
      }

      freshnessCount++
      if (freshnessCount % 10 === 0) {
        this.reconcileYieldCount++
        await yieldToMain()
        if (sessionId !== this.activeIndexingSession || this.currentWorkspaceRoot !== normalizedRoot) return false
      }
    }

    if (
      indexChanged &&
      sessionId === this.activeIndexingSession &&
      this.currentWorkspaceRoot === normalizedRoot
    ) {
      this.saveCount++
    }

    return sessionId === this.activeIndexingSession && this.currentWorkspaceRoot === normalizedRoot
  }

  async replayQueuedWatcherEvents(sessionId) {
    if (sessionId !== this.activeIndexingSession) return
    const queued = [...this.queuedWatcherEventsDuringRestore]
    this.queuedWatcherEventsDuringRestore = []
    for (const event of queued) {
      if (sessionId !== this.activeIndexingSession) return
      this.codebaseIndex.updateFile(event.relativePath, event.content, this.codebaseIndex.getAllFilePaths())
    }
  }

  queueWatcherEvent(event) {
    this.queuedWatcherEventsDuringRestore.push(event)
  }
}

async function runPhase9Tests() {
  console.log('===========================================================')
  console.log('PHASE 9: SAFE CHUNKED INDEXING & EVENT-LOOP YIELDING TESTS')
  console.log('===========================================================')

  // -------------------------------------------------------------
  // Test 1: yieldToMain executes a genuine macrotask
  // -------------------------------------------------------------
  console.log('\n[Test 1] yieldToMain executes a genuine macrotask')
  let macrotaskExecuted = false
  setTimeout(() => {
    macrotaskExecuted = true
  }, 0)

  // Before yielding, macrotask hasn't executed
  assert.strictEqual(macrotaskExecuted, false)
  // After genuine macrotask yield, setTimeout callback must have run
  await yieldToMain()
  assert.strictEqual(macrotaskExecuted, true, 'yieldToMain must yield to macrotask queue')
  console.log('✓ PASS: yieldToMain genuinely yielded to macrotask queue.')

  // -------------------------------------------------------------
  // Test 2: Bounded chunks trigger expected number of yields
  // -------------------------------------------------------------
  console.log('\n[Test 2] Bounded chunks trigger expected number of yields')
  const index = new CodebaseIndex()
  const files50 = []
  const filesStore = new Map()
  for (let i = 1; i <= 55; i++) {
    const p = `src/file_${i}.ts`
    files50.push(p)
    filesStore.set(p, `export const v${i} = ${i};`)
  }

  index.yieldCount = 0
  const reader = async (p) => filesStore.get(p)
  // 55 files with chunk size 20 => yields at file 20 and 40 (2 yields)
  const completed = await index.buildIndex('C:/ws', files50, reader, undefined, undefined, 20)
  assert.strictEqual(completed, true)
  assert.strictEqual(index.yieldCount, 2, `Expected 2 chunk yields for 55 files with chunkSize 20, got ${index.yieldCount}`)
  assert.strictEqual(index.entries.size, 55)
  console.log(`✓ PASS: 55 files in chunks of 20 yielded ${index.yieldCount} times and indexed all 55 files.`)

  // -------------------------------------------------------------
  // Test 3: Deterministic parity between synchronous and chunked builds
  // -------------------------------------------------------------
  console.log('\n[Test 3] Deterministic parity between chunked and unchunked builds')
  const syncIndex = new CodebaseIndex()
  await syncIndex.buildIndex('C:/ws', files50, reader, undefined, undefined, 1000) // unchunked

  const chunkedIndex = new CodebaseIndex()
  await chunkedIndex.buildIndex('C:/ws', files50, reader, undefined, undefined, 7) // chunked every 7 files

  assert.strictEqual(syncIndex.entries.size, chunkedIndex.entries.size)
  for (const [key, syncEntry] of syncIndex.entries.entries()) {
    const chunkEntry = chunkedIndex.entries.get(key)
    assert.notStrictEqual(chunkEntry, undefined, `Missing entry for ${key}`)
    assert.strictEqual(chunkEntry.contentHash, syncEntry.contentHash)
    assert.strictEqual(chunkEntry.fileSize, syncEntry.fileSize)
    assert.strictEqual(chunkEntry.exports[0].name, syncEntry.exports[0].name)
  }
  console.log('✓ PASS: Chunked build results are 100% identical in hashes, sizes, and exports.')

  // -------------------------------------------------------------
  // Test 4: Cancellation on workspace switch stops build immediately
  // -------------------------------------------------------------
  console.log('\n[Test 4] Cancellation on workspace switch stops build immediately')
  const engine = new FullSmartContextEngine()
  for (let i = 1; i <= 60; i++) {
    engine.mockFiles.set(`src/file_${i}.ts`, `export const v${i} = ${i};`)
  }

  // Start indexing workspace A
  const pA = engine.initializeWorkspaceIndex('C:/workspaceA')

  // Let first chunk process, then switch workspace before it finishes
  await new Promise((r) => setTimeout(r, 5))
  engine.onWorkspaceChange('C:/workspaceB')

  await pA

  // Workspace A must NOT have been marked fresh or persisted
  assert.notStrictEqual(engine.indexedWorkspaceRoot, 'C:/workspaceA')
  assert.strictEqual(engine.saveCount, 0, 'Cancelled indexing must not trigger persistence save')
  console.log('✓ PASS: Workspace change aborted in-flight build without saving or marking fresh.')

  // -------------------------------------------------------------
  // Test 5: Reconciliation yields on deleted files and respects cancellation
  // -------------------------------------------------------------
  console.log('\n[Test 5] Reconciliation yields on deleted files and respects cancellation')
  const recEngine = new FullSmartContextEngine()
  recEngine.currentWorkspaceRoot = 'C:/recWs'
  const sessionId = ++recEngine.activeIndexingSession

  // Pre-populate index with 35 files
  for (let i = 1; i <= 35; i++) {
    recEngine.codebaseIndex.indexFile(`src/file_${i}.ts`, `export const val = ${i};`, [])
  }
  assert.strictEqual(recEngine.codebaseIndex.entries.size, 35)

  // Empty mockFiles on disk (all 35 files deleted)
  recEngine.mockFiles.clear()
  recEngine.reconcileYieldCount = 0

  const recPromise = recEngine.reconcileRestoredIndex('C:/recWs', sessionId)
  // Let one yield occur, then cancel session
  await new Promise((r) => setTimeout(r, 2))
  recEngine.activeIndexingSession++ // Invalidate session

  const recResult = await recPromise
  assert.strictEqual(recResult, false, 'Cancelled reconciliation must return false')
  assert(recEngine.reconcileYieldCount >= 1, 'Reconciliation should have yielded at least once')
  console.log('✓ PASS: Reconciliation yielded during deletions and halted cleanly when session became stale.')

  // -------------------------------------------------------------
  // Test 6: Fast-path metadata verification yields on large workspace
  // -------------------------------------------------------------
  console.log('\n[Test 6] Fast-path metadata verification yields on unchanged files')
  const fastEngine = new FullSmartContextEngine()
  fastEngine.currentWorkspaceRoot = 'C:/fastWs'
  const fastSession = ++fastEngine.activeIndexingSession

  // Populate 45 unchanged files
  for (let i = 1; i <= 45; i++) {
    const content = `export const fast_${i} = ${i};`
    fastEngine.mockFiles.set(`src/fast_${i}.ts`, content)
    fastEngine.codebaseIndex.indexFile(`src/fast_${i}.ts`, content, [])
  }

  fastEngine.reconcileYieldCount = 0
  const fastResult = await fastEngine.reconcileRestoredIndex('C:/fastWs', fastSession)
  assert.strictEqual(fastResult, true)
  assert(fastEngine.reconcileYieldCount >= 4, `Expected at least 4 yields for 45 files in chunks of 10, got ${fastEngine.reconcileYieldCount}`)
  console.log(`✓ PASS: Fast-path verification yielded ${fastEngine.reconcileYieldCount} times across 45 files.`)

  // -------------------------------------------------------------
  // Test 7: Watcher events arriving during chunked build are queued and replayed
  // -------------------------------------------------------------
  console.log('\n[Test 7] Watcher events during chunked build are queued and replayed')
  const watchEngine = new FullSmartContextEngine()
  for (let i = 1; i <= 30; i++) {
    watchEngine.mockFiles.set(`src/w_${i}.ts`, `export const w = ${i};`)
  }

  const buildPromise = watchEngine.initializeWorkspaceIndex('C:/watchWs')

  // While build is in-flight and yielding chunks, a watcher event arrives
  watchEngine.queueWatcherEvent({
    workspaceRoot: 'C:/watchWs',
    relativePath: 'src/watcherAdded.ts',
    content: 'export const fromWatcher = true;'
  })

  await buildPromise

  assert.strictEqual(watchEngine.isIndexFresh, true)
  const watcherEntry = watchEngine.codebaseIndex.findFile('src/watcherAdded.ts')
  assert.notStrictEqual(watcherEntry, null, 'Queued watcher event must be indexed on replay')
  assert.strictEqual(watcherEntry.exports[0].name, 'fromWatcher')
  console.log('✓ PASS: Watcher event buffered during chunked indexing was safely replayed.')

  // -------------------------------------------------------------
  // Test 8: Mid-chunk cancellation cleans up in-memory index state
  // -------------------------------------------------------------
  console.log('\n[Test 8] Mid-chunk cancellation cleans up in-memory index state')
  const cancelIndex = new CodebaseIndex()
  const files30 = []
  const filesMap30 = new Map()
  for (let i = 1; i <= 30; i++) {
    const p = `src/chunk_file_${i}.ts`
    files30.push(p)
    filesMap30.set(p, `export const c${i} = ${i};`)
  }

  let cancelReaderCalls = 0
  let shouldCancelFlag = false
  const cancellableReader = async (p) => {
    cancelReaderCalls++
    if (cancelReaderCalls === 7) {
      // Cancel in the middle of the first chunk (chunkSize = 20)
      shouldCancelFlag = true
    }
    return filesMap30.get(p)
  }

  const cancelResult = await cancelIndex.buildIndex(
    'C:/cancelWs',
    files30,
    cancellableReader,
    undefined,
    () => shouldCancelFlag,
    20
  )

  assert.strictEqual(cancelResult, false, 'Cancelled buildIndex must return false')
  assert.strictEqual(cancelIndex.entries.size, 0, 'In-memory index entries must be completely cleared on cancellation')
  assert.strictEqual(cancelIndex.findFile('src/chunk_file_1.ts'), null, 'Previously indexed files in cancelled build must not remain in index')
  assert.strictEqual(cancelIndex.workspaceRoot, null, 'workspaceRoot must be reset on cancellation cleanup')
  console.log('✓ PASS: Mid-chunk cancellation cleanly aborted and left in-memory index completely empty.')

  // -------------------------------------------------------------
  // Test 9: Newer session/workspace index is not wiped by older cancelled session
  // -------------------------------------------------------------
  console.log('\n[Test 9] Newer session/workspace index is not wiped by older cancelled session')
  const sharedIndex = new CodebaseIndex()
  let buildACancelled = false

  // Build A: Workspace A starts indexing
  const buildAPromise = sharedIndex.buildIndex(
    'C:/workspaceA',
    ['src/a1.ts', 'src/a2.ts', 'src/a3.ts', 'src/a4.ts'],
    async (p) => {
      if (p === 'src/a2.ts') {
        // While Build A is in progress, user switches to Workspace B and Build B starts
        buildACancelled = true
        await sharedIndex.buildIndex(
          'C:/workspaceB',
          ['src/b1.ts', 'src/b2.ts'],
          async (bp) => `export const b = "${bp}";`,
          undefined,
          undefined,
          10
        )
      }
      return `export const a = "${p}";`
    },
    undefined,
    () => buildACancelled,
    10
  )

  const buildAResult = await buildAPromise
  assert.strictEqual(buildAResult, false, 'Build A must report cancelled/false')
  // Build B should remain fully intact in sharedIndex
  assert.strictEqual(sharedIndex.workspaceRoot, 'C:/workspaceB', 'Workspace B root must be preserved')
  assert.strictEqual(sharedIndex.entries.size, 2, 'Workspace B entries must NOT have been wiped by Build A cleanup')
  assert.notStrictEqual(sharedIndex.findFile('src/b1.ts'), null, 'Workspace B files must be present')
  assert.strictEqual(sharedIndex.findFile('src/a1.ts'), null, 'Workspace A files must not be present')
  console.log('✓ PASS: Stale cancelled build cleanup did not corrupt or wipe newer workspace index.')

  // -------------------------------------------------------------
  // Test 10: fileReader() unexpected exception during a chunk triggers cleanup and returns false
  // -------------------------------------------------------------
  console.log('\n[Test 10] fileReader() exception during a chunk triggers cleanup and returns false')
  const errorIndex = new CodebaseIndex()
  let readAttempts = 0
  const faultyReader = async (p) => {
    readAttempts++
    if (readAttempts === 5) {
      throw new Error('EACCES: permission denied')
    }
    return `export const data = "${p}";`
  }

  const errResult = await errorIndex.buildIndex(
    'C:/errorWs',
    ['src/f1.ts', 'src/f2.ts', 'src/f3.ts', 'src/f4.ts', 'src/f5.ts', 'src/f6.ts'],
    faultyReader,
    undefined,
    undefined,
    25
  )

  assert.strictEqual(errResult, false, 'buildIndex with throwing fileReader must return false')
  assert.strictEqual(errorIndex.entries.size, 0, 'Entries must be cleared when buildIndex fails due to an exception')
  assert.strictEqual(errorIndex.findFile('src/f1.ts'), null, 'Partial entries before error must not remain')
  assert.strictEqual(errorIndex.workspaceRoot, null)

  // Also verify that a null return from fileReader is handled gracefully without failing the build
  const nullSkipIndex = new CodebaseIndex()
  const nullSkipResult = await nullSkipIndex.buildIndex(
    'C:/nullWs',
    ['src/valid.ts', 'src/unreadable.ts'],
    async (p) => (p === 'src/unreadable.ts' ? null : 'export const ok = 1;'),
    undefined,
    undefined,
    25
  )
  assert.strictEqual(nullSkipResult, true, 'buildIndex with unreadable (null) file must return true')
  assert.strictEqual(nullSkipIndex.entries.size, 1, 'Valid file should be indexed')
  assert.strictEqual(nullSkipIndex.findFile('src/unreadable.ts'), null, 'Unreadable file should be skipped')
  console.log('✓ PASS: fileReader exception safely aborted with clean state, while null content skipped gracefully.')

  // -------------------------------------------------------------
  // Test 11: Confirmation that cancelled or failed builds are not treated as completed
  // -------------------------------------------------------------
  console.log('\n[Test 11] Confirmation that cancelled or failed builds are not treated as completed')
  const failEngine = new FullSmartContextEngine()
  failEngine.mockFiles.set('src/good.ts', 'export const good = 1;')
  failEngine.mockFiles.set('src/bad.ts', 'export const bad = 1;')

  // Override codebaseIndex.buildIndex to simulate a failure
  const originalBuildIndex = failEngine.codebaseIndex.buildIndex.bind(failEngine.codebaseIndex)
  failEngine.codebaseIndex.buildIndex = async (...args) => {
    await originalBuildIndex(...args)
    return false // Simulate build failure / cancellation return
  }

  await failEngine.initializeWorkspaceIndex('C:/failedWs')

  assert.strictEqual(failEngine.isIndexFresh, false, 'Failed build must not set isIndexFresh')
  assert.strictEqual(failEngine.indexedWorkspaceRoot, null, 'Failed build must not set indexedWorkspaceRoot')
  assert.strictEqual(failEngine.saveCount, 0, 'Failed build must not trigger persistent save')
  assert.strictEqual(failEngine.codebaseIndex.entries.size, 0, 'Failed build must leave codebaseIndex cleared')
  assert.strictEqual(failEngine.isIndexing, false, 'isIndexing flag must be reset')
  console.log('✓ PASS: Cancelled and failed builds are definitively not treated as completed or saved.')

  console.log('\n===========================================================')
  console.log('ALL PHASE 9 CHUNKED INDEXING & YIELDING TESTS PASSED! ✓')
  console.log('===========================================================')
}

runPhase9Tests().catch((err) => {
  console.error('Phase 9 test failed:', err)
  process.exit(1)
})
