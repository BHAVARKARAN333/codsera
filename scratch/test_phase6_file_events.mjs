// Phase 6: Filesystem Watcher, Real-Time Cache & Index Invalidation Automated Test Suite

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

const EXTENSIONS_TO_TRY = ['.ts', '.tsx', '.js', '.jsx', '.d.ts', '.mjs', '.cjs', '.json']
const CODE_EXTENSIONS = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'])

class DependencyAnalyzer {
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
    this.entries = new Map()
    this.workspaceRoot = null
    this.dependencyAnalyzer = dependencyAnalyzer || new DependencyAnalyzer()
  }

  normalizePath(filePath) {
    return filePath.replace(/\\/g, '/').replace(/^\/+/, '')
  }

  normalizeKey(filePath) {
    return this.normalizePath(filePath).toLowerCase()
  }

  clear() {
    this.entries.clear()
    this.workspaceRoot = null
  }

  getAllFilePaths() {
    return Array.from(this.entries.values()).map((e) => e.normalizedPath)
  }

  async buildIndex(workspaceRoot, filePaths, fileReader) {
    this.clear()
    this.workspaceRoot = workspaceRoot
    const normalizedPaths = filePaths.map((p) => this.normalizePath(p))

    for (const relPath of normalizedPaths) {
      if (relPath.startsWith('..') || relPath.includes('/../')) continue
      const content = await fileReader(relPath)
      if (content !== null) {
        this.indexFile(relPath, content, normalizedPaths)
      }
    }
  }

  indexFile(filePath, content, allWorkspaceFiles) {
    const normPath = this.normalizePath(filePath)
    const key = this.normalizeKey(filePath)
    const ext = normPath.split('.').pop()?.toLowerCase() || ''

    const isCode = CODE_EXTENSIONS.has(ext)
    let imports = []
    let resolvedDependencies = []
    let exports = []

    if (isCode) {
      const depInfo = this.dependencyAnalyzer.analyzeFileContent(normPath, content, allWorkspaceFiles)
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
      content,
      fileSize: content.length,
      lastIndexed: Date.now()
    }
    this.entries.set(key, entry)
    return entry
  }

  updateFile(filePath, content, allWorkspaceFiles) {
    this.dependencyAnalyzer.invalidateFile(filePath)
    return this.indexFile(filePath, content, allWorkspaceFiles)
  }

  removeFile(filePath) {
    const key = this.normalizeKey(filePath)
    this.dependencyAnalyzer.invalidateFile(filePath)
    return this.entries.delete(key)
  }

  invalidateFile(filePath) {
    const key = this.normalizeKey(filePath)
    this.dependencyAnalyzer.invalidateFile(filePath)
    this.entries.delete(key)
  }

  findFile(filePath) {
    return this.entries.get(this.normalizeKey(filePath)) || null
  }

  findDependencies(filePath) {
    const entry = this.findFile(filePath)
    return entry ? [...entry.resolvedDependencies] : []
  }
}

class ContextCache {
  constructor() {
    this.cache = new Map()
  }
  get(path) {
    return this.cache.get(path.toLowerCase()) || null
  }
  set(path, content) {
    this.cache.set(path.toLowerCase(), { path, content, hash: computeContentHash(content) })
  }
  invalidate(path) {
    this.cache.delete(path.toLowerCase())
  }
  clear() {
    this.cache.clear()
  }
}

class FullSmartContextEngine {
  constructor() {
    this.cache = new ContextCache()
    this.depAnalyzer = new DependencyAnalyzer()
    this.codebaseIndex = new CodebaseIndex(this.depAnalyzer)
    this.currentWorkspaceRoot = null
    this.pendingEvents = new Map()
    this.recentlyModifiedBySelf = new Map()
    this.readWorkspaceFileMock = null
  }

  clearCache() {
    for (const item of this.pendingEvents.values()) {
      clearTimeout(item.timer)
    }
    this.pendingEvents.clear()
    this.recentlyModifiedBySelf.clear()
    this.cache.clear()
    this.depAnalyzer.clearCache()
    this.codebaseIndex.clear()
  }

  onWorkspaceChange(newWorkspaceRoot) {
    const normalizedNew = newWorkspaceRoot
      ? newWorkspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '')
      : null
    if (this.currentWorkspaceRoot !== normalizedNew) {
      this.currentWorkspaceRoot = normalizedNew
      this.clearCache()
    }
  }

  recordSelfModified(relativePath) {
    const norm = relativePath.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase()
    this.recentlyModifiedBySelf.set(norm, Date.now())
  }

  invalidateFile(relativePath) {
    this.recordSelfModified(relativePath)
    this.cache.invalidate(relativePath)
    this.depAnalyzer.invalidateFile(relativePath)
    this.codebaseIndex.invalidateFile(relativePath)
  }

  handleFileSave(filePath, content) {
    const normPath = filePath.replace(/\\/g, '/')
    let relPath = normPath
    if (this.currentWorkspaceRoot && normPath.toLowerCase().startsWith(this.currentWorkspaceRoot.toLowerCase())) {
      relPath = normPath.slice(this.currentWorkspaceRoot.length).replace(/^[/\\]+/, '')
    }
    const cleanRel = relPath.replace(/\\/g, '/').replace(/^\/+/, '')
    if (!cleanRel || cleanRel.startsWith('..') || cleanRel.includes('/../')) return

    this.recordSelfModified(cleanRel)
    this.cache.set(cleanRel, content)
    const allPaths = this.codebaseIndex.getAllFilePaths()
    if (!allPaths.includes(cleanRel)) {
      allPaths.push(cleanRel)
    }
    this.codebaseIndex.updateFile(cleanRel, content, allPaths)
  }

  async handleFileEvent(event, debounceMs = 20) {
    if (!event || !event.relativePath || !event.workspaceRoot) return

    const normalizedEventRoot = event.workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '')
    const activeRoot = this.currentWorkspaceRoot
      ? this.currentWorkspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '')
      : null

    if (!activeRoot || normalizedEventRoot.toLowerCase() !== activeRoot.toLowerCase()) {
      return // Inactive workspace event dropped
    }

    const cleanRel = event.relativePath.replace(/\\/g, '/').replace(/^\/+/, '')

    if (cleanRel.startsWith('..') || cleanRel.includes('/../')) {
      return // Path traversal rejected
    }

    const key = cleanRel.toLowerCase()

    const existing = this.pendingEvents.get(key)
    if (existing) {
      clearTimeout(existing.timer)
      if (existing.resolve) existing.resolve()
    }

    return new Promise((resolve) => {
      const timer = setTimeout(async () => {
        this.pendingEvents.delete(key)
        await this.processDebouncedFileEvent(event.workspaceRoot, cleanRel, event.eventType)
        resolve()
      }, debounceMs)

      this.pendingEvents.set(key, { event, timer, resolve })
    })
  }

  async processDebouncedFileEvent(workspaceRoot, relativePath, eventType) {
    const normalizedRoot = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '')
    if (this.currentWorkspaceRoot !== normalizedRoot) {
      return
    }

    const key = relativePath.toLowerCase()
    const lastSelfModified = this.recentlyModifiedBySelf.get(key)
    if (lastSelfModified && Date.now() - lastSelfModified < 1500) {
      this.cache.invalidate(relativePath)
      return
    }

    if (eventType === 'unlink') {
      this.cache.invalidate(relativePath)
      this.depAnalyzer.invalidateFile(relativePath)
      this.codebaseIndex.removeFile(relativePath)
      return
    }

    this.cache.invalidate(relativePath)
    this.depAnalyzer.invalidateFile(relativePath)

    if (this.readWorkspaceFileMock) {
      try {
        const res = await this.readWorkspaceFileMock(normalizedRoot, relativePath)
        if (this.currentWorkspaceRoot !== normalizedRoot) return

        if (res.success && typeof res.content === 'string') {
          const allPaths = this.codebaseIndex.getAllFilePaths()
          if (!allPaths.includes(relativePath)) {
            allPaths.push(relativePath)
          }
          this.cache.set(relativePath, res.content)
          this.codebaseIndex.updateFile(relativePath, res.content, allPaths)
        } else {
          this.codebaseIndex.removeFile(relativePath)
        }
      } catch (err) {
        // Safe non-fatal error recovery
      }
    }
  }
}

async function runPhase6Tests() {
  console.log('===========================================================')
  console.log('PHASE 6: FILESYSTEM WATCHER & REAL-TIME CACHE/INDEX TESTS')
  console.log('===========================================================')

  const wsRoot = 'C:/workspace'
  const filesStore = new Map([
    ['src/math.ts', 'export function add(a, b) { return a + b; }'],
    ['src/app.ts', 'import { add } from "./math";\nexport const res = add(1, 2);']
  ])

  const engine = new FullSmartContextEngine()
  engine.readWorkspaceFileMock = async (_root, rel) => {
    if (filesStore.has(rel)) {
      return { success: true, content: filesStore.get(rel) }
    }
    return { success: false, error: 'File not found' }
  }

  // Initial workspace load
  engine.onWorkspaceChange(wsRoot)
  await engine.codebaseIndex.buildIndex(wsRoot, Array.from(filesStore.keys()), async (p) => filesStore.get(p))
  engine.cache.set('src/math.ts', filesStore.get('src/math.ts'))

  // -------------------------------------------------------------
  // Test 1: Saved file invalidates the correct cache and index entry
  // -------------------------------------------------------------
  console.log('\n[Test 1] Saved file updates cache and index immediately')
  const newMathContent = 'export function add(a, b) { return a + b; }\nexport function multiply(a, b) { return a * b; }'
  filesStore.set('src/math.ts', newMathContent)

  engine.handleFileSave('C:/workspace/src/math.ts', newMathContent)
  const cachedMath = engine.cache.get('src/math.ts')
  assert.strictEqual(cachedMath?.content, newMathContent)
  const indexedMath = engine.codebaseIndex.findFile('src/math.ts')
  assert.strictEqual(indexedMath?.exports.some((e) => e.name === 'multiply'), true)
  console.log('✓ PASS: Saved file updated cache and indexed new export "multiply".')

  // -------------------------------------------------------------
  // Test 2: Created file is added to the index via watcher event
  // -------------------------------------------------------------
  console.log('\n[Test 2] Created file via watcher event is indexed')
  const newHelperContent = 'export function helper() { return "ok"; }'
  filesStore.set('src/helper.ts', newHelperContent)

  await engine.handleFileEvent({
    workspaceRoot: wsRoot,
    relativePath: 'src/helper.ts',
    eventType: 'add'
  })

  const indexedHelper = engine.codebaseIndex.findFile('src/helper.ts')
  assert.notStrictEqual(indexedHelper, null)
  assert.strictEqual(indexedHelper?.exports[0]?.name, 'helper')
  console.log('✓ PASS: Created file was detected and added to codebase index.')

  // -------------------------------------------------------------
  // Test 3: Deleted file is removed from the index via watcher event
  // -------------------------------------------------------------
  console.log('\n[Test 3] Deleted file via watcher event is removed')
  filesStore.delete('src/helper.ts')

  await engine.handleFileEvent({
    workspaceRoot: wsRoot,
    relativePath: 'src/helper.ts',
    eventType: 'unlink'
  })

  assert.strictEqual(engine.codebaseIndex.findFile('src/helper.ts'), null)
  assert.strictEqual(engine.cache.get('src/helper.ts'), null)
  console.log('✓ PASS: Deleted file was removed from codebase index and cache.')

  // -------------------------------------------------------------
  // Test 4: Rapid repeated events are coalesced
  // -------------------------------------------------------------
  console.log('\n[Test 4] Rapid repeated events coalesced')
  let readCallCount = 0
  const origReader = engine.readWorkspaceFileMock
  engine.readWorkspaceFileMock = async (_root, rel) => {
    readCallCount++
    return origReader(_root, rel)
  }

  filesStore.set('src/rapid.ts', 'export const v = 1;')
  // Fire 5 rapid events within debounce window
  const p1 = engine.handleFileEvent({ workspaceRoot: wsRoot, relativePath: 'src/rapid.ts', eventType: 'change' }, 30)
  const p2 = engine.handleFileEvent({ workspaceRoot: wsRoot, relativePath: 'src/rapid.ts', eventType: 'change' }, 30)
  const p3 = engine.handleFileEvent({ workspaceRoot: wsRoot, relativePath: 'src/rapid.ts', eventType: 'change' }, 30)
  const p4 = engine.handleFileEvent({ workspaceRoot: wsRoot, relativePath: 'src/rapid.ts', eventType: 'change' }, 30)
  const p5 = engine.handleFileEvent({ workspaceRoot: wsRoot, relativePath: 'src/rapid.ts', eventType: 'change' }, 30)

  await Promise.all([p1, p2, p3, p4, p5])
  assert.strictEqual(readCallCount, 1, `Expected 1 read call due to coalescing, got ${readCallCount}`)
  console.log('✓ PASS: 5 rapid events coalesced into 1 disk read/index update.')

  // Restore reader
  engine.readWorkspaceFileMock = origReader

  // -------------------------------------------------------------
  // Test 5: Events from a previous workspace are ignored after switching
  // -------------------------------------------------------------
  console.log('\n[Test 5] Events from previous workspace ignored')
  engine.onWorkspaceChange('C:/other-workspace')

  await engine.handleFileEvent({
    workspaceRoot: wsRoot, // old workspace
    relativePath: 'src/math.ts',
    eventType: 'change'
  })

  // Old workspace file should NOT be added to other-workspace index
  assert.strictEqual(engine.codebaseIndex.findFile('src/math.ts'), null)
  console.log('✓ PASS: File event from inactive workspace was ignored.')

  // Switch back to wsRoot
  engine.onWorkspaceChange(wsRoot)

  // -------------------------------------------------------------
  // Test 6: Paths outside the workspace are rejected
  // -------------------------------------------------------------
  console.log('\n[Test 6] Path traversal events rejected')
  await engine.handleFileEvent({
    workspaceRoot: wsRoot,
    relativePath: '../../etc/passwd',
    eventType: 'change'
  })
  assert.strictEqual(engine.codebaseIndex.findFile('../../etc/passwd'), null)
  console.log('✓ PASS: Path traversal rejected.')

  // -------------------------------------------------------------
  // Test 7: Watcher failure does not break chat or context resolution
  // -------------------------------------------------------------
  console.log('\n[Test 7] Watcher failure error recovery')
  // Corrupt mock reader to simulate watcher / file read failure
  engine.readWorkspaceFileMock = async () => {
    throw new Error('EIO: i/o error')
  }

  // Must not throw or crash
  await engine.handleFileEvent({
    workspaceRoot: wsRoot,
    relativePath: 'src/math.ts',
    eventType: 'change'
  })
  console.log('✓ PASS: Watcher read error was handled gracefully without throwing.')

  // Restore reader
  engine.readWorkspaceFileMock = origReader

  // -------------------------------------------------------------
  // Test 8: Existing AI tool create/edit invalidation remains compatible
  // -------------------------------------------------------------
  console.log('\n[Test 8] AI tool create/edit invalidation compatibility')
  filesStore.set('src/toolCreated.ts', 'export const fromTool = true;')
  engine.invalidateFile('src/toolCreated.ts')
  assert.strictEqual(engine.cache.get('src/toolCreated.ts'), null)
  assert.strictEqual(engine.codebaseIndex.findFile('src/toolCreated.ts'), null)
  console.log('✓ PASS: Invalidation method clears cache and index as expected.')

  console.log('\n===========================================================')
  console.log('ALL PHASE 6 FILE WATCHER & EVENT TESTS PASSED! ✓')
  console.log('===========================================================')
}

runPhase6Tests().catch((err) => {
  console.error('Phase 6 test failed:', err)
  process.exit(1)
})
