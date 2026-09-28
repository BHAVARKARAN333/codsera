// Phase 7: Persistent Index Storage Automated Test Suite

import assert from 'node:assert'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import * as os from 'node:os'

const INDEX_SCHEMA_VERSION = 1
const EXTENSIONS_TO_TRY = ['.ts', '.tsx', '.js', '.jsx', '.d.ts', '.mjs', '.cjs', '.json']
const CODE_EXTENSIONS = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'])

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
    this.detectedTechnologies = new Set()
  }

  normalizePath(filePath) {
    return filePath.replace(/\\/g, '/').replace(/^\/+/, '')
  }

  normalizeKey(filePath) {
    return this.normalizePath(filePath).toLowerCase()
  }

  clear() {
    this.entries.clear()
    this.detectedTechnologies.clear()
    this.workspaceRoot = null
  }

  getAllFilePaths() {
    return Array.from(this.entries.values()).map((e) => e.normalizedPath)
  }

  serialize() {
    return {
      version: INDEX_SCHEMA_VERSION,
      workspaceRoot: this.workspaceRoot || '',
      savedAt: Date.now(),
      detectedTechnologies: Array.from(this.detectedTechnologies).sort(),
      entries: Array.from(this.entries.values())
    }
  }

  deserialize(payload, expectedWorkspaceRoot) {
    if (!payload || typeof payload !== 'object') {
      return false
    }

    const data = payload

    if (data.version !== INDEX_SCHEMA_VERSION) {
      return false
    }

    if (typeof data.workspaceRoot !== 'string' || !data.workspaceRoot.trim()) {
      return false
    }

    if (expectedWorkspaceRoot) {
      const normExpected = expectedWorkspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
      const normActual = data.workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
      if (normExpected !== normActual) {
        return false
      }
    }

    if (!Array.isArray(data.entries) || !Array.isArray(data.detectedTechnologies)) {
      return false
    }

    const validatedEntries = []
    for (const item of data.entries) {
      if (!item || typeof item !== 'object') return false
      const e = item
      if (typeof e.normalizedPath !== 'string' || !e.normalizedPath.trim()) return false
      if (e.normalizedPath.startsWith('..') || e.normalizedPath.includes('/../')) return false
      if (typeof e.fileType !== 'string' || typeof e.extension !== 'string') return false
      if (!Array.isArray(e.imports) || !Array.isArray(e.resolvedDependencies) || !Array.isArray(e.exports)) {
        return false
      }
      if (typeof e.contentHash !== 'string' || typeof e.fileSize !== 'number') return false

      const normPath = this.normalizePath(e.normalizedPath)
      const key = this.normalizeKey(normPath)
      validatedEntries.push({ key, entry: e })
    }

    this.clear()
    this.workspaceRoot = data.workspaceRoot
    for (const tech of data.detectedTechnologies) {
      if (typeof tech === 'string' && tech.trim()) {
        this.detectedTechnologies.add(tech)
      }
    }
    for (const { key, entry } of validatedEntries) {
      this.entries.set(key, entry)
    }

    return true
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
      fileType: isCode ? 'source' : 'unknown',
      extension: ext,
      imports,
      resolvedDependencies,
      unresolvedImports: [],
      exports,
      declaredSymbols: exports.map((e) => e.name),
      isTestFile: normPath.includes('.test.') || normPath.includes('.spec.'),
      isEntryPoint: normPath === 'src/index.ts',
      entryPointConfidence: 'detected',
      isConfigFile: normPath.endsWith('.json'),
      contentHash: hash,
      fileSize: content.length,
      lastIndexed: Date.now()
    }
    this.entries.set(key, entry)
    return entry
  }

  findFile(filePath) {
    return this.entries.get(this.normalizeKey(filePath)) || null
  }

  updateFile(filePath, content, allWorkspaceFiles) {
    return this.indexFile(filePath, content, allWorkspaceFiles)
  }

  removeFile(filePath) {
    return this.entries.delete(this.normalizeKey(filePath))
  }
}

// Simulated Main Process Storage Layer
class MainProcessIndexStorage {
  constructor(storageDir) {
    this.storageDir = storageDir
    this.saveQueueMap = new Map()
  }

  getWorkspaceIndexFilePath(workspaceRoot) {
    const normalized = workspaceRoot.replace(/\\/g, '/').toLowerCase()
    const hash = crypto.createHash('sha256').update(normalized).digest('hex')
    return path.join(this.storageDir, `${hash}.json`)
  }

  async safeWriteWorkspaceIndex(workspaceRoot, data) {
    if (!workspaceRoot || typeof workspaceRoot !== 'string') {
      return { success: false, error: 'Invalid workspace path.' }
    }
    if (!data || typeof data !== 'object') {
      return { success: false, error: 'Invalid index payload.' }
    }

    const payloadRoot = data.workspaceRoot
    if (typeof payloadRoot !== 'string' || !payloadRoot.trim()) {
      return { success: false, error: 'Payload missing workspaceRoot identity.' }
    }
    const normRequested = workspaceRoot.replace(/\\/g, '/').toLowerCase()
    const normPayload = payloadRoot.replace(/\\/g, '/').toLowerCase()
    if (normRequested !== normPayload) {
      return {
        success: false,
        error: `Workspace identity mismatch: requested "${normRequested}", payload was "${normPayload}".`
      }
    }

    const filePath = this.getWorkspaceIndexFilePath(workspaceRoot)
    const tempPath = `${filePath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`

    const currentQueue = this.saveQueueMap.get(filePath) || Promise.resolve()
    const writeOperation = currentQueue
      .then(async () => {
        await fs.mkdir(this.storageDir, { recursive: true })
        const jsonContent = JSON.stringify(data)
        await fs.writeFile(tempPath, jsonContent, 'utf-8')
        await fs.rename(tempPath, filePath)
      })
      .catch(async (err) => {
        try {
          await fs.unlink(tempPath)
        } catch {}
        throw err
      })

    this.saveQueueMap.set(filePath, writeOperation.catch(() => {}))
    await writeOperation

    return { success: true }
  }

  async safeLoadWorkspaceIndex(workspaceRoot) {
    if (!workspaceRoot || typeof workspaceRoot !== 'string') {
      return { success: false, error: 'Invalid workspace path.' }
    }

    const filePath = this.getWorkspaceIndexFilePath(workspaceRoot)
    const pendingWrite = this.saveQueueMap.get(filePath)
    if (pendingWrite) {
      await pendingWrite
    }

    let fileContent
    try {
      fileContent = await fs.readFile(filePath, 'utf-8')
    } catch {
      return { success: false, error: 'Index file not found.' }
    }

    let parsed
    try {
      parsed = JSON.parse(fileContent)
    } catch {
      try {
        await fs.unlink(filePath)
      } catch {}
      return { success: false, error: 'Corrupted index file discarded.' }
    }

    if (!parsed || typeof parsed !== 'object') {
      return { success: false, error: 'Malformed index payload.' }
    }

    const normRequested = workspaceRoot.replace(/\\/g, '/').toLowerCase()
    const normPayload = parsed.workspaceRoot
      ? parsed.workspaceRoot.replace(/\\/g, '/').toLowerCase()
      : null

    if (normPayload !== normRequested) {
      return {
        success: false,
        error: `Workspace identity mismatch in stored index: "${normPayload}" !== "${normRequested}".`
      }
    }

    return { success: true, data: parsed }
  }
}

class SimulatedSmartContextEngine {
  constructor(storage) {
    this.codebaseIndex = new CodebaseIndex()
    this.storage = storage
    this.activeIndexingSession = 0
    this.currentWorkspaceRoot = null
    this.indexedWorkspaceRoot = null
    this.restoredWorkspaceRoot = null
    this.isIndexRestored = false
    this.isIndexFresh = false
    this.isIndexing = false
  }

  clearCache() {
    this.codebaseIndex.clear()
    this.indexedWorkspaceRoot = null
    this.restoredWorkspaceRoot = null
    this.isIndexRestored = false
    this.isIndexFresh = false
  }

  onWorkspaceChange(newRoot) {
    const norm = newRoot ? newRoot.replace(/\\/g, '/').replace(/\/+$/, '') : null
    if (this.currentWorkspaceRoot !== norm) {
      this.currentWorkspaceRoot = norm
      this.clearCache()
    }
  }

  async initializeWorkspaceIndex(workspaceRoot, fileTreeProvider, fileContentProvider) {
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

    if (this.indexedWorkspaceRoot === normalizedRoot) {
      return
    }
    if (this.restoredWorkspaceRoot === normalizedRoot) {
      return
    }

    const sessionId = ++this.activeIndexingSession
    this.isIndexing = true

    try {
      // 1. Attempt restore from storage
      let restored = false
      if (this.storage) {
        const loadRes = await this.storage.safeLoadWorkspaceIndex(normalizedRoot)
        if (sessionId !== this.activeIndexingSession) return

        if (loadRes.success && loadRes.data) {
          const ok = this.codebaseIndex.deserialize(loadRes.data, normalizedRoot)
          if (ok && sessionId === this.activeIndexingSession) {
            restored = true
            this.restoredWorkspaceRoot = normalizedRoot
            this.isIndexRestored = true
            this.isIndexFresh = false
          }
        }
      }

      if (restored) {
        return
      }

      // 2. Fall back to full indexing
      const filePaths = await fileTreeProvider(normalizedRoot)
      if (sessionId !== this.activeIndexingSession) return

      await this.codebaseIndex.buildIndex(normalizedRoot, filePaths, async (rel) =>
        fileContentProvider(normalizedRoot, rel)
      )

      if (sessionId === this.activeIndexingSession) {
        this.indexedWorkspaceRoot = normalizedRoot
        this.restoredWorkspaceRoot = null
        this.isIndexFresh = true
        this.isIndexRestored = false

        if (this.storage) {
          await this.storage.safeWriteWorkspaceIndex(
            normalizedRoot,
            this.codebaseIndex.serialize()
          )
        }
      }
    } finally {
      if (sessionId === this.activeIndexingSession) {
        this.isIndexing = false
      }
    }
  }

  isWorkspaceIndexed(workspaceRoot) {
    if (workspaceRoot) {
      const norm = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '')
      return this.indexedWorkspaceRoot === norm || this.restoredWorkspaceRoot === norm
    }
    return this.indexedWorkspaceRoot !== null || this.restoredWorkspaceRoot !== null
  }
}

async function runPhase7Tests() {
  console.log('===========================================================')
  console.log('PHASE 7: PERSISTENT INDEX STORAGE AUTOMATED TESTS')
  console.log('===========================================================')

  const testTempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-ide-index-test-'))
  const storage = new MainProcessIndexStorage(testTempDir)

  try {
    // -------------------------------------------------------------
    // Test 1: Serialize/deserialize parity for entries and technologies
    // -------------------------------------------------------------
    console.log('\n[Test 1] Serialize/deserialize parity')
    const idx1 = new CodebaseIndex()
    await idx1.buildIndex(
      'C:/projects/app',
      ['src/index.ts', 'src/math.ts'],
      async (p) => (p === 'src/index.ts' ? 'import "./math";\nexport const start = 1;' : 'export const add = 2;')
    )
    idx1.detectedTechnologies.add('TypeScript')
    idx1.detectedTechnologies.add('React')

    const serialized = idx1.serialize()
    assert.strictEqual(serialized.version, 1)
    assert.strictEqual(serialized.workspaceRoot, 'C:/projects/app')
    assert.deepStrictEqual(serialized.detectedTechnologies, ['React', 'TypeScript'])
    assert.strictEqual(serialized.entries.length, 2)

    const idx2 = new CodebaseIndex()
    const ok = idx2.deserialize(serialized, 'C:/projects/app')
    assert.strictEqual(ok, true)
    assert.strictEqual(idx2.entries.size, 2)
    assert.strictEqual(idx2.detectedTechnologies.has('React'), true)
    assert.strictEqual(idx2.findFile('src/index.ts')?.exports[0]?.name, 'start')
    assert.strictEqual(idx2.findFile('src/math.ts')?.exports[0]?.name, 'add')
    console.log('✓ PASS: Serialized payload restored full parity for entries and detected technologies.')

    // -------------------------------------------------------------
    // Test 2: Malformed payload rejection
    // -------------------------------------------------------------
    console.log('\n[Test 2] Malformed payload rejection')
    const badIdx = new CodebaseIndex()
    assert.strictEqual(badIdx.deserialize(null), false)
    assert.strictEqual(badIdx.deserialize({ version: 1, entries: 'not-array' }), false)
    assert.strictEqual(badIdx.deserialize({ version: 1, workspaceRoot: '', entries: [] }), false)
    assert.strictEqual(badIdx.deserialize({ version: 1, workspaceRoot: 'C:/ws', entries: [{ normalizedPath: '../../secret.txt' }] }), false)
    console.log('✓ PASS: Malformed payloads, missing fields, and path traversal entries rejected safely.')

    // -------------------------------------------------------------
    // Test 3: Unsupported schema version rejection
    // -------------------------------------------------------------
    console.log('\n[Test 3] Unsupported schema version rejection')
    const vIdx = new CodebaseIndex()
    assert.strictEqual(vIdx.deserialize({ ...serialized, version: 999 }), false)
    assert.strictEqual(vIdx.deserialize({ ...serialized, version: 0 }), false)
    console.log('✓ PASS: Schema version mismatch rejected cleanly.')

    // -------------------------------------------------------------
    // Test 4: Workspace identity mismatch rejection
    // -------------------------------------------------------------
    console.log('\n[Test 4] Workspace identity mismatch rejection')
    const idIdx = new CodebaseIndex()
    assert.strictEqual(idIdx.deserialize(serialized, 'C:/projects/another-app'), false)
    console.log('✓ PASS: Stored index for Workspace A rejected when loaded for Workspace B.')

    // -------------------------------------------------------------
    // Test 5: Save and load round-trip to actual filesystem
    // -------------------------------------------------------------
    console.log('\n[Test 5] Save and load round-trip to filesystem')
    const saveRes = await storage.safeWriteWorkspaceIndex('C:/projects/app', serialized)
    assert.strictEqual(saveRes.success, true)

    const expectedHash = crypto.createHash('sha256').update('c:/projects/app').digest('hex')
    const expectedFilePath = path.join(testTempDir, `${expectedHash}.json`)
    const fileStat = await fs.stat(expectedFilePath)
    assert(fileStat.size > 0)

    const loadRes = await storage.safeLoadWorkspaceIndex('C:/projects/app')
    assert.strictEqual(loadRes.success, true)
    assert.strictEqual(loadRes.data.workspaceRoot, 'C:/projects/app')
    console.log('✓ PASS: Index successfully persisted to disk and reloaded via SHA-256 hashed path.')

    // -------------------------------------------------------------
    // Test 6: Atomic write and concurrent save safety
    // -------------------------------------------------------------
    console.log('\n[Test 6] Atomic write & concurrent save safety')
    const concurrentWrites = []
    for (let i = 0; i < 10; i++) {
      const payload = {
        ...serialized,
        savedAt: Date.now() + i,
        detectedTechnologies: [`Tech${i}`]
      }
      concurrentWrites.push(storage.safeWriteWorkspaceIndex('C:/projects/app', payload))
    }
    const results = await Promise.all(concurrentWrites)
    assert(results.every((r) => r.success === true))

    // Verify stored file is valid JSON and not corrupt
    const finalLoad = await storage.safeLoadWorkspaceIndex('C:/projects/app')
    assert.strictEqual(finalLoad.success, true)
    assert(finalLoad.data.detectedTechnologies.length > 0)
    console.log('✓ PASS: 10 concurrent asynchronous saves serialized cleanly without corruption.')

    // -------------------------------------------------------------
    // Test 7: Restore from valid index
    // -------------------------------------------------------------
    console.log('\n[Test 7] Restore from valid persistent index')
    const engine = new SimulatedSmartContextEngine(storage)
    let fullBuildTreeCalled = false
    const treeProvider = async () => {
      fullBuildTreeCalled = true
      return ['src/index.ts', 'src/math.ts']
    }

    await engine.initializeWorkspaceIndex('C:/projects/app', treeProvider, async () => null)
    assert.strictEqual(fullBuildTreeCalled, false, 'Full build tree read must not be invoked when index is restored!')
    assert.strictEqual(engine.isIndexRestored, true)
    assert.strictEqual(engine.isIndexFresh, false)
    assert.strictEqual(engine.isWorkspaceIndexed('C:/projects/app'), true)
    assert.strictEqual(engine.codebaseIndex.entries.size, 2)
    console.log('✓ PASS: Workspace initialized from restored persistent index without full rebuild.')

    // -------------------------------------------------------------
    // Test 8: Missing/corrupted index fallback to full build
    // -------------------------------------------------------------
    console.log('\n[Test 8] Missing/corrupted index fallback to full build')
    const fallbackEngine = new SimulatedSmartContextEngine(storage)

    // Intentionally corrupt index file on disk
    const corruptPath = storage.getWorkspaceIndexFilePath('C:/projects/app')
    await fs.writeFile(corruptPath, 'INVALID_JSON{{{', 'utf-8')

    let fallbackTreeCalled = false
    const mockFiles = new Map([
      ['src/index.ts', 'export const start = 1;'],
      ['src/math.ts', 'export const add = 2;']
    ])
    const fallbackTree = async () => {
      fallbackTreeCalled = true
      return Array.from(mockFiles.keys())
    }
    const fallbackReader = async (_root, rel) => mockFiles.get(rel) || null

    await fallbackEngine.initializeWorkspaceIndex('C:/projects/app', fallbackTree, fallbackReader)
    assert.strictEqual(fallbackTreeCalled, true, 'Corrupted index must trigger fallback full build')
    assert.strictEqual(fallbackEngine.isIndexFresh, true)
    assert.strictEqual(fallbackEngine.isIndexRestored, false)
    assert.strictEqual(fallbackEngine.codebaseIndex.entries.size, 2)

    // Confirm that a fresh, uncorrupted index was saved to storage
    const reloaded = await storage.safeLoadWorkspaceIndex('C:/projects/app')
    assert.strictEqual(reloaded.success, true)
    console.log('✓ PASS: Corrupted index safely fell back to full build and repaired storage on disk.')

    // -------------------------------------------------------------
    // Test 9: Existing watcher and lazy context behavior compatibility
    // -------------------------------------------------------------
    console.log('\n[Test 9] Watcher and lazy context compatibility')
    // After restore, watcher can still update and remove files
    fallbackEngine.codebaseIndex.updateFile('src/new.ts', 'export const x = 99;', ['src/index.ts', 'src/math.ts', 'src/new.ts'])
    assert.notStrictEqual(fallbackEngine.codebaseIndex.findFile('src/new.ts'), null)
    fallbackEngine.codebaseIndex.removeFile('src/new.ts')
    assert.strictEqual(fallbackEngine.codebaseIndex.findFile('src/new.ts'), null)
    console.log('✓ PASS: Codebase index continues to handle dynamic updates after restore.')

    console.log('\n===========================================================')
    console.log('ALL PHASE 7 PERSISTENT INDEX STORAGE TESTS PASSED! ✓')
    console.log('===========================================================')
  } finally {
    // Cleanup temporary test directory
    try {
      await fs.rm(testTempDir, { recursive: true, force: true })
    } catch {}
  }
}

runPhase7Tests().catch((err) => {
  console.error('Phase 7 test failed:', err)
  process.exit(1)
})
