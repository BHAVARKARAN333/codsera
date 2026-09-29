// Phase 8: Safe Offline Reconciliation Automated Test Suite

import assert from 'node:assert'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import * as os from 'node:os'

const INDEX_SCHEMA_VERSION = 1
const EXTENSIONS_TO_TRY = ['.ts', '.tsx', '.js', '.jsx', '.d.ts', '.mjs', '.cjs', '.json']
const CODE_EXTENSIONS = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'])

const PACKAGE_JSON_TECHNOLOGIES = new Set([
  'React',
  'Electron',
  'Vite',
  'Monaco Editor',
  'Tailwind CSS',
  'Jest',
  'Vitest',
  'Lucide Icons'
])

function toRelativeWorkspacePath(fullPath, workspaceRoot) {
  const normEntry = fullPath.replace(/\\/g, '/')
  const normRoot = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '')

  if (!normRoot) {
    const clean = normEntry.replace(/^\/+/, '')
    return clean || null
  }

  const isWindows =
    (typeof process !== 'undefined' && process.platform === 'win32') ||
    (typeof navigator !== 'undefined' && /win/i.test(navigator.userAgent || navigator.platform || ''))

  const rootPrefix = normRoot + '/'

  if (isWindows) {
    const entryLower = normEntry.toLowerCase()
    const rootLower = normRoot.toLowerCase()
    const prefixLower = rootPrefix.toLowerCase()

    if (entryLower === rootLower) {
      return ''
    }
    if (entryLower.startsWith(prefixLower)) {
      return normEntry.slice(rootPrefix.length).replace(/^\/+/, '')
    }
  } else {
    if (normEntry === normRoot) {
      return ''
    }
    if (normEntry.startsWith(rootPrefix)) {
      return normEntry.slice(rootPrefix.length).replace(/^\/+/, '')
    }
  }

  const isAbsolute = /^[a-zA-Z]:[\\/]/.test(fullPath) || fullPath.startsWith('/') || fullPath.startsWith('\\')
  if (isAbsolute) {
    return null
  }

  return normEntry.replace(/^\/+/, '')
}

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
  constructor() {
    this.invalidatedFiles = []
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

  invalidateFile(filePath) {
    this.invalidatedFiles.push(this.normalizePath(filePath))
  }

  clearCache() {
    this.invalidatedFiles = []
  }
}

class CodebaseIndex {
  constructor(dependencyAnalyzer) {
    this.entries = new Map()
    this.reverseDependencies = new Map()
    this.workspaceRoot = null
    this.dependencyAnalyzer = dependencyAnalyzer || new DependencyAnalyzer()
    this.detectedTechnologies = new Set()
    this.parseCount = 0
  }

  normalizePath(filePath) {
    return filePath.replace(/\\/g, '/').replace(/^\/+/, '')
  }

  normalizeKey(filePath) {
    return this.normalizePath(filePath).toLowerCase()
  }

  unregisterReverseDependencies(importerKey, dependencies) {
    for (const dep of dependencies) {
      const depKey = this.normalizeKey(dep)
      const set = this.reverseDependencies.get(depKey)
      if (set) {
        set.delete(importerKey)
        if (set.size === 0) {
          this.reverseDependencies.delete(depKey)
        }
      }
    }
  }

  registerReverseDependencies(importerKey, dependencies) {
    for (const dep of dependencies) {
      const depKey = this.normalizeKey(dep)
      let set = this.reverseDependencies.get(depKey)
      if (!set) {
        set = new Set()
        this.reverseDependencies.set(depKey, set)
      }
      set.add(importerKey)
    }
  }

  clear() {
    this.entries.clear()
    this.reverseDependencies.clear()
    this.detectedTechnologies.clear()
    this.workspaceRoot = null
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
    if (!payload || typeof payload !== 'object') return false
    const data = payload
    if (data.version !== INDEX_SCHEMA_VERSION) return false
    if (typeof data.workspaceRoot !== 'string' || !data.workspaceRoot.trim()) return false

    if (expectedWorkspaceRoot) {
      const normExpected = expectedWorkspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
      const normActual = data.workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
      if (normExpected !== normActual) return false
    }

    if (!Array.isArray(data.entries) || !Array.isArray(data.detectedTechnologies)) return false

    const validatedEntries = []
    for (const item of data.entries) {
      if (!item || typeof item !== 'object') return false
      const e = item
      if (typeof e.normalizedPath !== 'string' || !e.normalizedPath.trim()) return false
      if (e.normalizedPath.startsWith('..') || e.normalizedPath.includes('/../')) return false
      if (typeof e.fileType !== 'string' || typeof e.extension !== 'string') return false
      if (!Array.isArray(e.imports) || !Array.isArray(e.resolvedDependencies) || !Array.isArray(e.exports)) return false
      if (typeof e.contentHash !== 'string' || typeof e.fileSize !== 'number') return false
      if (e.mtimeMs !== undefined && typeof e.mtimeMs !== 'number') return false

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
      this.registerReverseDependencies(key, entry.resolvedDependencies)
    }
    return true
  }

  async buildIndex(workspaceRoot, filePaths, fileReader, fileMetadataMap) {
    this.clear()
    this.workspaceRoot = workspaceRoot
    const normalizedPaths = filePaths.map((p) => this.normalizePath(p))

    for (const relPath of normalizedPaths) {
      if (relPath.startsWith('..') || relPath.includes('/../')) continue
      const content = await fileReader(relPath)
      if (content !== null) {
        const meta = fileMetadataMap?.get(relPath)
        this.indexFile(relPath, content, normalizedPaths, meta?.mtimeMs, meta?.size)
      }
    }
  }

  indexFile(filePath, content, allWorkspaceFiles, mtimeMs, fileSize) {
    this.parseCount++
    const normPath = this.normalizePath(filePath)
    const key = this.normalizeKey(filePath)
    const ext = normPath.split('.').pop()?.toLowerCase() || ''

    let imports = []
    let resolvedDependencies = []
    let unresolvedImports = []
    let exports = []
    let declaredSymbols = []

    if (CODE_EXTENSIONS.has(ext)) {
      const depInfo = this.dependencyAnalyzer.analyzeFileContent(normPath, content, allWorkspaceFiles)
      imports = depInfo.imports.map((i) => i.specifier)
      resolvedDependencies = depInfo.imports
        .map((i) => i.resolvedPath)
        .filter((p) => typeof p === 'string' && p.length > 0)
      unresolvedImports = depInfo.unresolvedImports
      exports = depInfo.exports
      declaredSymbols = exports.map((e) => e.name)
    }

    const hash = computeContentHash(content)
    const baseName = normPath.includes('/') ? normPath.slice(normPath.lastIndexOf('/') + 1) : normPath
    const baseNameLower = baseName.toLowerCase()

    if (baseNameLower === 'package.json') {
      this.refreshPackageJsonTechnologies(content)
    }

    if (ext === 'ts' || ext === 'tsx' || baseNameLower.includes('tsconfig')) {
      this.detectedTechnologies.add('TypeScript')
    }

    const entry = {
      normalizedPath: normPath,
      fileType: ext === 'ts' || ext === 'tsx' || ext === 'js' ? 'source' : 'unknown',
      extension: ext,
      imports,
      resolvedDependencies,
      unresolvedImports,
      exports,
      declaredSymbols,
      isTestFile: false,
      isEntryPoint: false,
      entryPointConfidence: 'unknown',
      isConfigFile: false,
      contentHash: hash,
      fileSize: fileSize !== undefined ? fileSize : content.length,
      mtimeMs,
      lastIndexed: Date.now()
    }

    const previousEntry = this.entries.get(key)
    if (previousEntry && previousEntry.resolvedDependencies) {
      this.unregisterReverseDependencies(key, previousEntry.resolvedDependencies)
    }
    this.registerReverseDependencies(key, resolvedDependencies)

    this.entries.set(key, entry)
    return entry
  }

  refreshPackageJsonTechnologies(content) {
    for (const tech of PACKAGE_JSON_TECHNOLOGIES) {
      this.detectedTechnologies.delete(tech)
    }

    try {
      const pkg = JSON.parse(content)
      const allDeps = {
        ...(pkg.dependencies || {}),
        ...(pkg.devDependencies || {})
      }

      if (allDeps['react']) this.detectedTechnologies.add('React')
      if (allDeps['electron']) this.detectedTechnologies.add('Electron')
      if (allDeps['typescript']) this.detectedTechnologies.add('TypeScript')
      if (allDeps['vite'] || allDeps['electron-vite']) this.detectedTechnologies.add('Vite')
      if (allDeps['@monaco-editor/react']) this.detectedTechnologies.add('Monaco Editor')
      if (allDeps['tailwindcss']) this.detectedTechnologies.add('Tailwind CSS')
      if (allDeps['jest']) this.detectedTechnologies.add('Jest')
      if (allDeps['vitest']) this.detectedTechnologies.add('Vitest')
      if (allDeps['lucide-react']) this.detectedTechnologies.add('Lucide Icons')
    } catch {}

    if (!this.detectedTechnologies.has('TypeScript')) {
      for (const entry of this.entries.values()) {
        if (
          entry.extension === 'ts' ||
          entry.extension === 'tsx' ||
          entry.normalizedPath.toLowerCase().includes('tsconfig')
        ) {
          this.detectedTechnologies.add('TypeScript')
          break
        }
      }
    }
  }

  updateFile(filePath, content, allWorkspaceFiles, mtimeMs, fileSize) {
    this.dependencyAnalyzer.invalidateFile(filePath)
    return this.indexFile(filePath, content, allWorkspaceFiles, mtimeMs, fileSize)
  }

  updateFileMetadata(filePath, mtimeMs, fileSize) {
    const entry = this.findFile(filePath)
    if (entry) {
      if (mtimeMs !== undefined) {
        entry.mtimeMs = mtimeMs
      }
      if (fileSize !== undefined) {
        entry.fileSize = fileSize
      }
      entry.lastIndexed = Date.now()
    }
  }

  removeFile(filePath) {
    const key = this.normalizeKey(filePath)
    const normPath = this.normalizePath(filePath)
    this.dependencyAnalyzer.invalidateFile(filePath)

    // 1. Clean up references in entries that imported this file
    const importerKeys = this.reverseDependencies.get(key)
    if (importerKeys && importerKeys.size > 0) {
      for (const importerKey of importerKeys) {
        if (importerKey === key) continue
        const importerEntry = this.entries.get(importerKey)
        if (importerEntry && importerEntry.resolvedDependencies) {
          importerEntry.resolvedDependencies = importerEntry.resolvedDependencies.filter(
            (dep) => this.normalizeKey(dep) !== key && dep !== normPath
          )
        }
      }
      this.reverseDependencies.delete(key)
    }

    // 2. Clean up outgoing dependencies from reverse map
    const existingEntry = this.entries.get(key)
    if (existingEntry && existingEntry.resolvedDependencies) {
      this.unregisterReverseDependencies(key, existingEntry.resolvedDependencies)
    }

    const removed = this.entries.delete(key)

    if (normPath.toLowerCase() === 'package.json') {
      for (const tech of PACKAGE_JSON_TECHNOLOGIES) {
        this.detectedTechnologies.delete(tech)
      }
      let hasTs = false
      for (const entry of this.entries.values()) {
        if (
          entry.extension === 'ts' ||
          entry.extension === 'tsx' ||
          entry.normalizedPath.toLowerCase().includes('tsconfig')
        ) {
          hasTs = true
          break
        }
      }
      if (!hasTs) {
        this.detectedTechnologies.delete('TypeScript')
      }
    }

    return removed
  }

  getAllFilePaths() {
    return Array.from(this.entries.values()).map((e) => e.normalizedPath)
  }

  findFile(filePath) {
    return this.entries.get(this.normalizeKey(filePath)) || null
  }
}

class SimulatedPersistentIndexStorage {
  constructor(storageDir) {
    this.storageDir = storageDir
    this.saveQueues = new Map()
  }

  getWorkspaceIndexFilePath(workspaceRoot) {
    const normalizedRoot = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '')
    const hash = crypto.createHash('sha256').update(normalizedRoot).digest('hex')
    return path.join(this.storageDir, `${hash}.json`)
  }

  async safeSaveWorkspaceIndex(workspaceRoot, payload) {
    const targetFile = this.getWorkspaceIndexFilePath(workspaceRoot)
    const jsonString = JSON.stringify(payload, null, 2)
    const tempFile = path.join(this.storageDir, `${path.basename(targetFile)}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`)

    const currentOp = this.saveQueues.get(targetFile) || Promise.resolve()
    const nextOp = currentOp
      .catch(() => {})
      .then(async () => {
        await fs.mkdir(this.storageDir, { recursive: true })
        await fs.writeFile(tempFile, jsonString, 'utf-8')
        await fs.rename(tempFile, targetFile)
        return { success: true }
      })
      .catch((err) => {
        try {
          fs.unlink(tempFile).catch(() => {})
        } catch {}
        return { success: false, error: err.message }
      })

    this.saveQueues.set(targetFile, nextOp)
    return nextOp
  }

  async safeLoadWorkspaceIndex(workspaceRoot) {
    const targetFile = this.getWorkspaceIndexFilePath(workspaceRoot)
    try {
      const raw = await fs.readFile(targetFile, 'utf-8')
      const parsed = JSON.parse(raw)
      return { success: true, data: parsed }
    } catch (err) {
      if (err.code === 'ENOENT') {
        return { success: false, notFound: true }
      }
      return { success: false, error: err.message }
    }
  }
}

class SimulatedSmartContextEngine {
  constructor(storage) {
    this.storage = storage
    this.dependencyAnalyzer = new DependencyAnalyzer()
    this.codebaseIndex = new CodebaseIndex(this.dependencyAnalyzer)
    this.currentWorkspaceRoot = null
    this.activeIndexingSession = 0
    this.indexedWorkspaceRoot = null
    this.restoredWorkspaceRoot = null
    this.isIndexRestored = false
    this.isIndexFresh = false
    this.isIndexing = false
    this.isReconciling = false
    this.queuedWatcherEventsDuringRestore = []
    this.cache = new Map()
    this.readCount = 0
    this.replayedEvents = []
  }

  extractFileMetadataMap(entries, rootPath, maxDepth = 6, currentDepth = 0) {
    if (currentDepth > maxDepth || !entries) return new Map()
    const map = new Map()

    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue

      const relPath = toRelativeWorkspacePath(entry.path, rootPath)
      if (!relPath) {
        if (entry.isDirectory && entry.children && entry.children.length > 0) {
          const subMap = this.extractFileMetadataMap(entry.children, rootPath, maxDepth, currentDepth + 1)
          for (const [k, v] of subMap.entries()) {
            map.set(k, v)
          }
        }
        continue
      }

      if (entry.isDirectory) {
        if (entry.children && entry.children.length > 0) {
          const subMap = this.extractFileMetadataMap(entry.children, rootPath, maxDepth, currentDepth + 1)
          for (const [k, v] of subMap.entries()) {
            map.set(k, v)
          }
        }
      } else {
        map.set(relPath, { size: entry.size, mtimeMs: entry.mtimeMs })
      }
    }
    return map
  }

  clearCache() {
    this.activeIndexingSession++
    this.isIndexing = false
    this.cache.clear()
    this.dependencyAnalyzer.clearCache()
    this.currentWorkspaceRoot = null
    this.indexedWorkspaceRoot = null
    this.restoredWorkspaceRoot = null
    this.isIndexRestored = false
    this.isIndexFresh = false
    this.isReconciling = false
    this.queuedWatcherEventsDuringRestore = []
  }

  async handleFileEvent(event) {
    if (!event || !event.relativePath || !event.workspaceRoot) return
    const cleanRel = event.relativePath.replace(/\\/g, '/').replace(/^\/+/, '')

    if (this.isReconciling) {
      this.queuedWatcherEventsDuringRestore.push({ ...event, relativePath: cleanRel })
      return
    }

    this.replayedEvents.push({ ...event, relativePath: cleanRel })
    if (event.eventType === 'unlink') {
      this.codebaseIndex.removeFile(cleanRel)
      this.cache.delete(cleanRel)
    } else {
      this.codebaseIndex.updateFile(cleanRel, event.content || '', this.codebaseIndex.getAllFilePaths())
      this.cache.set(cleanRel, event.content || '')
    }
  }

  async replayQueuedWatcherEvents(sessionId) {
    const queued = [...this.queuedWatcherEventsDuringRestore]
    this.queuedWatcherEventsDuringRestore = []
    for (const event of queued) {
      if (sessionId !== this.activeIndexingSession) return
      await this.handleFileEvent(event)
    }
  }

  async reconcileRestoredIndex(normalizedRoot, sessionId, readTreeFn, readWorkspaceFileFn) {
    const treeRes = await readTreeFn(normalizedRoot)
    if (sessionId !== this.activeIndexingSession) return false
    if (!treeRes.success || !treeRes.tree) return false

    const diskFileMap = this.extractFileMetadataMap(treeRes.tree, normalizedRoot)
    const diskPaths = Array.from(diskFileMap.keys())
    const diskPathSet = new Set(diskPaths.map((p) => p.toLowerCase()))

    const indexedPaths = this.codebaseIndex.getAllFilePaths()
    const indexedPathSet = new Set(indexedPaths.map((p) => p.toLowerCase()))

    let indexChanged = false

    // 1. Remove deleted files
    for (const indexedPath of indexedPaths) {
      if (sessionId !== this.activeIndexingSession) return false
      const lower = indexedPath.toLowerCase()
      if (!diskPathSet.has(lower)) {
        this.codebaseIndex.removeFile(indexedPath)
        this.cache.delete(indexedPath)
        this.dependencyAnalyzer.invalidateFile(indexedPath)
        indexChanged = true
      }
    }

    // 2. Add new files
    for (const diskPath of diskPaths) {
      if (sessionId !== this.activeIndexingSession) return false
      const lower = diskPath.toLowerCase()
      if (!indexedPathSet.has(lower)) {
        this.readCount++
        const res = await readWorkspaceFileFn(normalizedRoot, diskPath)
        if (sessionId !== this.activeIndexingSession) return false

        if (res.success && typeof res.content === 'string') {
          const meta = diskFileMap.get(diskPath)
          this.cache.set(diskPath, res.content)
          this.codebaseIndex.indexFile(
            diskPath,
            res.content,
            diskPaths,
            meta?.mtimeMs,
            meta?.size ?? res.content.length
          )
          indexChanged = true
        }
      }
    }

    // 3. Verify freshness for common files
    for (const relPath of diskPaths) {
      if (sessionId !== this.activeIndexingSession) return false
      const lower = relPath.toLowerCase()
      if (!indexedPathSet.has(lower)) continue

      const existingEntry = this.codebaseIndex.findFile(relPath)
      if (!existingEntry) continue

      const diskMeta = diskFileMap.get(relPath)

      // Fast-path heuristic: If both size and mtimeMs exist and match exactly
      const hasFastMeta =
        diskMeta &&
        typeof diskMeta.size === 'number' &&
        typeof diskMeta.mtimeMs === 'number' &&
        typeof existingEntry.mtimeMs === 'number'

      const isFastMatch =
        hasFastMeta &&
        diskMeta.size === existingEntry.fileSize &&
        diskMeta.mtimeMs === existingEntry.mtimeMs

      if (isFastMatch) {
        // Fast-path hit! Zero file reads, zero AST re-parsing.
        continue
      }

      // Fast-path miss: read file to check hash
      this.readCount++
      const res = await readWorkspaceFileFn(normalizedRoot, relPath)
      if (sessionId !== this.activeIndexingSession) return false

      if (!res.success || typeof res.content !== 'string') {
        this.codebaseIndex.removeFile(relPath)
        this.cache.delete(relPath)
        this.dependencyAnalyzer.invalidateFile(relPath)
        indexChanged = true
        continue
      }

      const currentHash = computeContentHash(res.content)
      if (currentHash === existingEntry.contentHash) {
        // Content hash identical: update metadata without AST re-parsing
        this.codebaseIndex.updateFileMetadata(
          relPath,
          diskMeta?.mtimeMs,
          diskMeta?.size ?? res.content.length
        )
        this.cache.set(relPath, res.content)
        indexChanged = true
      } else {
        // Content hash changed: full incremental AST re-parse
        this.cache.set(relPath, res.content)
        this.dependencyAnalyzer.invalidateFile(relPath)
        this.codebaseIndex.updateFile(
          relPath,
          res.content,
          diskPaths,
          diskMeta?.mtimeMs,
          diskMeta?.size ?? res.content.length
        )
        indexChanged = true
      }
    }

    if (indexChanged && this.storage) {
      await this.storage.safeSaveWorkspaceIndex(normalizedRoot, this.codebaseIndex.serialize())
    }

    return true
  }

  async initializeWorkspaceIndex(workspaceRoot, readTreeFn, readWorkspaceFileFn) {
    const normalizedRoot = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '')
    this.currentWorkspaceRoot = normalizedRoot

    const sessionId = ++this.activeIndexingSession
    this.isIndexing = true

    try {
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
        let reconciliationSucceeded = false
        this.isReconciling = true
        this.queuedWatcherEventsDuringRestore = []

        try {
          reconciliationSucceeded = await this.reconcileRestoredIndex(
            normalizedRoot,
            sessionId,
            readTreeFn,
            readWorkspaceFileFn
          )
        } catch {
          reconciliationSucceeded = false
        } finally {
          this.isReconciling = false
        }

        if (sessionId !== this.activeIndexingSession) return

        if (reconciliationSucceeded) {
          this.indexedWorkspaceRoot = normalizedRoot
          this.isIndexFresh = true
          this.isIndexRestored = true
          await this.replayQueuedWatcherEvents(sessionId)
          return
        }

        this.restoredWorkspaceRoot = null
        this.isIndexRestored = false
        this.isIndexFresh = false
      }

      // Fallback full build
      const treeRes = await readTreeFn(normalizedRoot)
      if (sessionId !== this.activeIndexingSession) return
      if (!treeRes.success || !Array.isArray(treeRes.tree)) {
        this.queuedWatcherEventsDuringRestore = []
        return
      }

      const fileMetadataMap = this.extractFileMetadataMap(treeRes.tree, normalizedRoot)
      const filePaths = Array.from(fileMetadataMap.keys())

      if (filePaths.length === 0) {
        this.indexedWorkspaceRoot = normalizedRoot
        this.restoredWorkspaceRoot = null
        this.isIndexFresh = true
        this.isIndexRestored = false
        await this.replayQueuedWatcherEvents(sessionId)
        return
      }

      const fileReader = async (rel) => {
        if (sessionId !== this.activeIndexingSession) return null
        this.readCount++
        const r = await readWorkspaceFileFn(normalizedRoot, rel)
        return r.success ? r.content : null
      }

      await this.codebaseIndex.buildIndex(normalizedRoot, filePaths, fileReader, fileMetadataMap)

      if (sessionId === this.activeIndexingSession) {
        this.indexedWorkspaceRoot = normalizedRoot
        this.restoredWorkspaceRoot = null
        this.isIndexFresh = true
        this.isIndexRestored = false
        await this.replayQueuedWatcherEvents(sessionId)

        if (this.storage) {
          await this.storage.safeSaveWorkspaceIndex(normalizedRoot, this.codebaseIndex.serialize())
        }
      }
    } finally {
      if (sessionId === this.activeIndexingSession) {
        this.isIndexing = false
      }
    }
  }
}

// =========================================================================
// TEST RUNNER
// =========================================================================

async function runPhase8Tests() {
  console.log('===========================================================')
  console.log('PHASE 8: SAFE OFFLINE RECONCILIATION AUTOMATED TESTS')
  console.log('===========================================================')

  const testTempDir = path.join(os.tmpdir(), `ai-ide-phase8-test-${Date.now()}`)
  await fs.mkdir(testTempDir, { recursive: true })

  try {
    const storage = new SimulatedPersistentIndexStorage(testTempDir)
    const wsRoot = 'C:/projects/reconcile-app'

    // -------------------------------------------------------------
    // Test 1: Fast-Path Hit (Zero File Reads / Zero AST Re-parse)
    // -------------------------------------------------------------
    console.log('\n[Test 1] Fast-path hit for unchanged files')
    {
      const initialEngine = new SimulatedSmartContextEngine(storage)
      const files = {
        'src/math.ts': { content: 'export const add = (a, b) => a + b;', mtimeMs: 1700000000000, size: 36 },
        'src/utils.ts': { content: 'export const log = (m) => console.log(m);', mtimeMs: 1700000000000, size: 41 }
      }

      const readTree = async () => ({
        success: true,
        tree: [
          { name: 'src', path: 'C:/projects/reconcile-app/src', isDirectory: true, children: [
            { name: 'math.ts', path: 'C:/projects/reconcile-app/src/math.ts', isDirectory: false, size: 36, mtimeMs: 1700000000000 },
            { name: 'utils.ts', path: 'C:/projects/reconcile-app/src/utils.ts', isDirectory: false, size: 41, mtimeMs: 1700000000000 }
          ]}
        ]
      })
      const readFile = async (_root, rel) => ({ success: true, content: files[rel]?.content })

      // Initial build & persist
      await initialEngine.initializeWorkspaceIndex(wsRoot, readTree, readFile)
      assert.strictEqual(initialEngine.isIndexFresh, true)
      assert.strictEqual(initialEngine.codebaseIndex.getAllFilePaths().length, 2)

      // Restart application with new engine instance
      const freshEngine = new SimulatedSmartContextEngine(storage)
      const initialParseCount = freshEngine.codebaseIndex.parseCount

      await freshEngine.initializeWorkspaceIndex(wsRoot, readTree, readFile)
      assert.strictEqual(freshEngine.isIndexFresh, true, 'Index must be fresh after reconciliation')
      assert.strictEqual(freshEngine.isIndexRestored, true, 'Index should be restored from disk')
      assert.strictEqual(freshEngine.readCount, 0, 'Fast-path must NOT read files from disk')
      assert.strictEqual(freshEngine.codebaseIndex.parseCount, initialParseCount, 'Fast-path must NOT reparse AST')
      console.log('✓ PASS: Fast-path confirmed: zero disk reads and zero AST reparsing for unchanged files.')
    }

    // -------------------------------------------------------------
    // Test 2: Timestamp Changed, Identical Content Hash
    // -------------------------------------------------------------
    console.log('\n[Test 2] Modified timestamp but identical content hash')
    {
      const engine = new SimulatedSmartContextEngine(storage)
      // File has newer timestamp (e.g. touch or git checkout) but identical length and content
      const newerTree = async () => ({
        success: true,
        tree: [
          { name: 'src', path: 'C:/projects/reconcile-app/src', isDirectory: true, children: [
            { name: 'math.ts', path: 'C:/projects/reconcile-app/src/math.ts', isDirectory: false, size: 36, mtimeMs: 1700000009999 }, // Newer mtime
            { name: 'utils.ts', path: 'C:/projects/reconcile-app/src/utils.ts', isDirectory: false, size: 41, mtimeMs: 1700000000000 }  // Unchanged
          ]}
        ]
      })
      const readFile = async (_root, rel) => {
        if (rel === 'src/math.ts') return { success: true, content: 'export const add = (a, b) => a + b;' }
        return { success: true, content: 'export const log = (m) => console.log(m);' }
      }

      const initialParseCount = engine.codebaseIndex.parseCount
      await engine.initializeWorkspaceIndex(wsRoot, newerTree, readFile)

      assert.strictEqual(engine.readCount, 1, 'Only the touched file should be read to verify hash')
      assert.strictEqual(engine.codebaseIndex.parseCount, initialParseCount, 'AST must NOT be re-parsed when hash matches')
      const mathEntry = engine.codebaseIndex.findFile('src/math.ts')
      assert.strictEqual(mathEntry.mtimeMs, 1700000009999, 'Metadata mtimeMs should be updated in entry')
      console.log('✓ PASS: Identical content hash with touched timestamp updated metadata without AST re-parsing.')
    }

    // -------------------------------------------------------------
    // Test 3: Timestamp & Content Hash Changed (Incremental Re-parse)
    // -------------------------------------------------------------
    console.log('\n[Test 3] Modified timestamp and modified content hash')
    {
      const engine = new SimulatedSmartContextEngine(storage)
      const modifiedContent = 'export const add = (a, b) => a + b;\nexport const multiply = (a, b) => a * b;'
      const modifiedTree = async () => ({
        success: true,
        tree: [
          { name: 'src', path: 'C:/projects/reconcile-app/src', isDirectory: true, children: [
            { name: 'math.ts', path: 'C:/projects/reconcile-app/src/math.ts', isDirectory: false, size: modifiedContent.length, mtimeMs: 1700000099999 },
            { name: 'utils.ts', path: 'C:/projects/reconcile-app/src/utils.ts', isDirectory: false, size: 41, mtimeMs: 1700000000000 }
          ]}
        ]
      })
      const readFile = async (_root, rel) => {
        if (rel === 'src/math.ts') return { success: true, content: modifiedContent }
        return { success: true, content: 'export const log = (m) => console.log(m);' }
      }

      await engine.initializeWorkspaceIndex(wsRoot, modifiedTree, readFile)

      const mathEntry = engine.codebaseIndex.findFile('src/math.ts')
      assert.strictEqual(mathEntry.declaredSymbols.includes('multiply'), true, 'Newly added symbol "multiply" must be indexed')
      assert.strictEqual(engine.dependencyAnalyzer.invalidatedFiles.includes('src/math.ts'), true, 'Dependency analyzer must be invalidated for modified file')
      console.log('✓ PASS: Modified content hash triggered incremental AST re-parse and updated symbols.')
    }

    // -------------------------------------------------------------
    // Test 4: File Size Changed (Fast-Path Miss -> Re-parse)
    // -------------------------------------------------------------
    console.log('\n[Test 4] File size changed misses fast path')
    {
      const engine = new SimulatedSmartContextEngine(storage)
      const shorterContent = 'export const add = 1;'
      const sizeChangedTree = async () => ({
        success: true,
        tree: [
          { name: 'src', path: 'C:/projects/reconcile-app/src', isDirectory: true, children: [
            { name: 'math.ts', path: 'C:/projects/reconcile-app/src/math.ts', isDirectory: false, size: shorterContent.length, mtimeMs: 1700000099999 },
            { name: 'utils.ts', path: 'C:/projects/reconcile-app/src/utils.ts', isDirectory: false, size: 41, mtimeMs: 1700000000000 }
          ]}
        ]
      })
      const readFile = async (_root, rel) => {
        if (rel === 'src/math.ts') return { success: true, content: shorterContent }
        return { success: true, content: 'export const log = (m) => console.log(m);' }
      }

      await engine.initializeWorkspaceIndex(wsRoot, sizeChangedTree, readFile)
      const mathEntry = engine.codebaseIndex.findFile('src/math.ts')
      assert.strictEqual(mathEntry.fileSize, shorterContent.length)
      assert.strictEqual(engine.readCount >= 1, true)
      console.log('✓ PASS: Changed file size bypassed fast-path and updated index.')
    }

    // -------------------------------------------------------------
    // Test 5: Missing or Undefined Metadata Fallback
    // -------------------------------------------------------------
    console.log('\n[Test 5] Missing/undefined metadata fallback')
    {
      const engine = new SimulatedSmartContextEngine(storage)
      const treeWithoutStats = async () => ({
        success: true,
        tree: [
          { name: 'src', path: 'C:/projects/reconcile-app/src', isDirectory: true, children: [
            { name: 'math.ts', path: 'C:/projects/reconcile-app/src/math.ts', isDirectory: false }, // No size or mtimeMs
            { name: 'utils.ts', path: 'C:/projects/reconcile-app/src/utils.ts', isDirectory: false }
          ]}
        ]
      })
      const readFile = async (_root, rel) => ({ success: true, content: 'export const add = 1;' })

      await engine.initializeWorkspaceIndex(wsRoot, treeWithoutStats, readFile)
      assert.strictEqual(engine.isIndexFresh, true, 'Index must still be marked fresh')
      assert.strictEqual(engine.readCount >= 1, true, 'Files must be read to verify when metadata missing')
      console.log('✓ PASS: Missing metadata safely fell back to content verification.')
    }

    // -------------------------------------------------------------
    // Test 6: Offline File Addition
    // -------------------------------------------------------------
    console.log('\n[Test 6] Offline file addition')
    {
      const engine = new SimulatedSmartContextEngine(storage)
      const addedTree = async () => ({
        success: true,
        tree: [
          { name: 'src', path: 'C:/projects/reconcile-app/src', isDirectory: true, children: [
            { name: 'math.ts', path: 'C:/projects/reconcile-app/src/math.ts', isDirectory: false, size: 21, mtimeMs: 1700000099999 },
            { name: 'utils.ts', path: 'C:/projects/reconcile-app/src/utils.ts', isDirectory: false, size: 41, mtimeMs: 1700000000000 },
            { name: 'service.ts', path: 'C:/projects/reconcile-app/src/service.ts', isDirectory: false, size: 50, mtimeMs: 1700000100000 } // NEW FILE
          ]}
        ]
      })
      const readFile = async (_root, rel) => {
        if (rel === 'src/service.ts') return { success: true, content: 'import { add } from "./math";\nexport const compute = add;' }
        if (rel === 'src/math.ts') return { success: true, content: 'export const add = 1;' }
        return { success: true, content: 'export const log = (m) => console.log(m);' }
      }

      await engine.initializeWorkspaceIndex(wsRoot, addedTree, readFile)
      const serviceEntry = engine.codebaseIndex.findFile('src/service.ts')
      assert.notStrictEqual(serviceEntry, null, 'New offline file must be indexed')
      assert.strictEqual(serviceEntry.resolvedDependencies.includes('src/math.ts'), true, 'Dependencies of new file must be resolved')
      console.log('✓ PASS: Offline added file indexed with resolved dependencies.')
    }

    // -------------------------------------------------------------
    // Test 7: Offline File Deletion
    // -------------------------------------------------------------
    console.log('\n[Test 7] Offline file deletion')
    {
      const engine = new SimulatedSmartContextEngine(storage)
      // Delete service.ts while app was closed
      const deletedTree = async () => ({
        success: true,
        tree: [
          { name: 'src', path: 'C:/projects/reconcile-app/src', isDirectory: true, children: [
            { name: 'math.ts', path: 'C:/projects/reconcile-app/src/math.ts', isDirectory: false, size: 21, mtimeMs: 1700000099999 },
            { name: 'utils.ts', path: 'C:/projects/reconcile-app/src/utils.ts', isDirectory: false, size: 41, mtimeMs: 1700000000000 }
          ]}
        ]
      })
      const readFile = async (_root, rel) => ({ success: true, content: 'dummy' })

      await engine.initializeWorkspaceIndex(wsRoot, deletedTree, readFile)
      assert.strictEqual(engine.codebaseIndex.findFile('src/service.ts'), null, 'Deleted file must be removed from index')
      assert.strictEqual(engine.codebaseIndex.getAllFilePaths().length, 2)
      console.log('✓ PASS: Offline deleted file safely removed from index and caches.')
    }

    // -------------------------------------------------------------
    // Test 8: Offline File Rename (Handled as Unlink + Add)
    // -------------------------------------------------------------
    console.log('\n[Test 8] Offline file rename')
    {
      const engine = new SimulatedSmartContextEngine(storage)
      // Rename utils.ts to helper.ts while app was closed
      const renamedTree = async () => ({
        success: true,
        tree: [
          { name: 'src', path: 'C:/projects/reconcile-app/src', isDirectory: true, children: [
            { name: 'math.ts', path: 'C:/projects/reconcile-app/src/math.ts', isDirectory: false, size: 21, mtimeMs: 1700000099999 },
            { name: 'helper.ts', path: 'C:/projects/reconcile-app/src/helper.ts', isDirectory: false, size: 45, mtimeMs: 1700000200000 }
          ]}
        ]
      })
      const readFile = async (_root, rel) => {
        if (rel === 'src/helper.ts') return { success: true, content: 'export const helperFn = () => "ok";' }
        return { success: true, content: 'export const add = 1;' }
      }

      await engine.initializeWorkspaceIndex(wsRoot, renamedTree, readFile)
      assert.strictEqual(engine.codebaseIndex.findFile('src/utils.ts'), null, 'Old file name must be removed')
      assert.notStrictEqual(engine.codebaseIndex.findFile('src/helper.ts'), null, 'New file name must be indexed')
      console.log('✓ PASS: Offline rename handled safely as removal of old path and indexing of new path.')
    }

    // -------------------------------------------------------------
    // Test 9: Watcher Event Queueing During Active Reconciliation
    // -------------------------------------------------------------
    console.log('\n[Test 9] Watcher event queueing during active reconciliation')
    {
      const engine = new SimulatedSmartContextEngine(storage)
      let resolveTree
      const delayedTreePromise = new Promise((resolve) => {
        resolveTree = resolve
      })

      const asyncTree = async () => {
        return delayedTreePromise
      }
      const readFile = async (_root, rel) => ({ success: true, content: 'export const x = 1;' })

      // Start initialization asynchronously
      const initPromise = engine.initializeWorkspaceIndex(wsRoot, asyncTree, readFile)

      // Allow event loop to enter reconciliation
      for (let i = 0; i < 100 && !engine.isReconciling; i++) {
        await new Promise((r) => setTimeout(r, 5))
      }
      assert.strictEqual(engine.isReconciling, true, 'Engine must be in isReconciling state')

      // Emit watcher events during reconciliation
      await engine.handleFileEvent({
        workspaceRoot: wsRoot,
        relativePath: 'src/queued.ts',
        eventType: 'add',
        content: 'export const queued = true;'
      })
      assert.strictEqual(engine.queuedWatcherEventsDuringRestore.length, 1, 'Watcher event must be queued')
      assert.strictEqual(engine.codebaseIndex.findFile('src/queued.ts'), null, 'Queued event must not be processed yet')

      // Resolve tree to allow reconciliation to complete
      resolveTree({
        success: true,
        tree: [
          { name: 'src', path: 'C:/projects/reconcile-app/src', isDirectory: true, children: [
            { name: 'math.ts', path: 'C:/projects/reconcile-app/src/math.ts', isDirectory: false, size: 21, mtimeMs: 1700000099999 },
            { name: 'helper.ts', path: 'C:/projects/reconcile-app/src/helper.ts', isDirectory: false, size: 45, mtimeMs: 1700000200000 }
          ]}
        ]
      })

      await initPromise
      assert.strictEqual(engine.isReconciling, false, 'isReconciling must reset to false')
      assert.strictEqual(engine.queuedWatcherEventsDuringRestore.length, 0, 'Reconciliation queue must be emptied')
      assert.notStrictEqual(engine.codebaseIndex.findFile('src/queued.ts'), null, 'Queued event must be replayed and indexed')
      console.log('✓ PASS: Watcher events during reconciliation were safely queued and replayed.')
    }

    // -------------------------------------------------------------
    // Test 10: Workspace Switch Session Guard During Reconciliation
    // -------------------------------------------------------------
    console.log('\n[Test 10] Workspace switch session guard during reconciliation')
    {
      const engine = new SimulatedSmartContextEngine(storage)
      let resolveTreeWsA
      const delayedTreeWsA = new Promise((resolve) => {
        resolveTreeWsA = resolve
      })

      const slowTreeA = async () => delayedTreeWsA
      const readFile = async (_root, _rel) => ({ success: true, content: 'export const a = 1;' })

      // Start indexing Workspace A
      const initWsA = engine.initializeWorkspaceIndex('C:/projects/workspaceA', slowTreeA, readFile)
      await new Promise((r) => setImmediate(r))

      // User immediately switches to Workspace B
      const fastTreeB = async () => ({
        success: true,
        tree: [
          { name: 'index.ts', path: 'C:/projects/workspaceB/index.ts', isDirectory: false, size: 20, mtimeMs: 1700000000000 }
        ]
      })
      const initWsB = engine.initializeWorkspaceIndex('C:/projects/workspaceB', fastTreeB, readFile)
      await initWsB

      assert.strictEqual(engine.currentWorkspaceRoot, 'C:/projects/workspaceB')
      assert.strictEqual(engine.codebaseIndex.workspaceRoot, 'C:/projects/workspaceB')

      // Now resolve Workspace A's delayed tree
      resolveTreeWsA({
        success: true,
        tree: [
          { name: 'stale.ts', path: 'C:/projects/workspaceA/stale.ts', isDirectory: false, size: 20, mtimeMs: 1700000000000 }
        ]
      })
      await initWsA

      // Verify that Workspace A's delayed indexing did NOT corrupt Workspace B's index
      assert.strictEqual(engine.currentWorkspaceRoot, 'C:/projects/workspaceB')
      assert.strictEqual(engine.codebaseIndex.findFile('stale.ts'), null, 'Delayed workspace indexing must be discarded')
      console.log('✓ PASS: Workspace switch safely aborted in-flight reconciliation and protected active workspace.')
    }

    // -------------------------------------------------------------
    // Test 11: Reconciliation Failure Fallback to Full Build
    // -------------------------------------------------------------
    console.log('\n[Test 11] Reconciliation failure fallback to full build')
    {
      const engine = new SimulatedSmartContextEngine(storage)
      let treeCalls = 0
      const failingTreeThenSuccess = async () => {
        treeCalls++
        if (treeCalls === 1) {
          // Simulate readTree failure during reconciliation
          return { success: false, error: 'EACCES: permission denied' }
        }
        // Second call (fallback full build)
        return {
          success: true,
          tree: [
            { name: 'main.ts', path: 'C:/projects/reconcile-app/main.ts', isDirectory: false, size: 25, mtimeMs: 1700000000000 }
          ]
        }
      }
      const readFile = async (_root, _rel) => ({ success: true, content: 'export const app = true;' })

      await engine.initializeWorkspaceIndex(wsRoot, failingTreeThenSuccess, readFile)
      assert.strictEqual(treeCalls, 2, 'Must call readTree second time for full build fallback')
      assert.strictEqual(engine.isIndexFresh, true, 'Fallback build must mark index fresh')
      assert.strictEqual(engine.isIndexRestored, false, 'Fallback build is fresh, not restored')
      assert.notStrictEqual(engine.codebaseIndex.findFile('main.ts'), null, 'Fallback files must be indexed')
      console.log('✓ PASS: Reconciliation failure safely triggered fallback to full index build.')
    }

    // -------------------------------------------------------------
    // Test 12: Reconciled Index Persistence Round-Trip
    // -------------------------------------------------------------
    console.log('\n[Test 12] Reconciled index persistence round-trip')
    {
      // Verify that the disk storage now contains the reconciled entries
      const diskData = await storage.safeLoadWorkspaceIndex(wsRoot)
      assert.strictEqual(diskData.success, true, 'Persistent index must be successfully loaded')
      assert.strictEqual(diskData.data.workspaceRoot, wsRoot)
      assert.strictEqual(diskData.data.entries.some((e) => e.normalizedPath === 'main.ts'), true)

      // Instantiate a third engine and load the saved index
      const thirdEngine = new SimulatedSmartContextEngine(storage)
      const dummyTree = async () => ({
        success: true,
        tree: [
          { name: 'main.ts', path: 'C:/projects/reconcile-app/main.ts', isDirectory: false, size: 25, mtimeMs: 1700000000000 }
        ]
      })
      const dummyReader = async () => ({ success: true, content: 'export const app = true;' })

      await thirdEngine.initializeWorkspaceIndex(wsRoot, dummyTree, dummyReader)
      assert.strictEqual(thirdEngine.isIndexFresh, true)
      assert.strictEqual(thirdEngine.readCount, 0, 'Reconciled restored index with matching metadata hits fast path')
      assert.notStrictEqual(thirdEngine.codebaseIndex.findFile('main.ts'), null)
      console.log('✓ PASS: Reconciled index persisted and reloaded with immediate fast-path validation.')
    }

    // -------------------------------------------------------------
    // Test 13: Failed readTree must not mark index fresh (Issue 1)
    // -------------------------------------------------------------
    console.log('\n[Test 13] Failed readTree must not mark index fresh; genuinely empty workspace does')
    {
      const failEngine = new SimulatedSmartContextEngine(null)
      const failedTree = async () => ({ success: false, error: 'EACCES: permission denied' })
      const dummyReader = async () => ({ success: true, content: '' })

      await failEngine.initializeWorkspaceIndex('C:/projects/fail-app', failedTree, dummyReader)
      assert.strictEqual(failEngine.isIndexFresh, false, 'Failed readTree must NOT mark index fresh')
      assert.strictEqual(failEngine.isIndexing, false)

      const emptyEngine = new SimulatedSmartContextEngine(null)
      const emptyTree = async () => ({ success: true, tree: [] })

      await emptyEngine.initializeWorkspaceIndex('C:/projects/empty-app', emptyTree, dummyReader)
      assert.strictEqual(emptyEngine.isIndexFresh, true, 'Explicitly empty workspace must mark index fresh')
      assert.strictEqual(emptyEngine.codebaseIndex.getAllFilePaths().length, 0)
      console.log('✓ PASS: Failed readTree left index un-fresh; genuine empty workspace marked fresh.')
    }

    // -------------------------------------------------------------
    // Test 14: Invalidate in-flight indexing in clearCache() (Issue 2)
    // -------------------------------------------------------------
    console.log('\n[Test 14] clearCache() invalidates in-flight indexing session')
    {
      const engine = new SimulatedSmartContextEngine(null)
      let resolveTree
      const delayedTree = new Promise((r) => {
        resolveTree = r
      })
      const treeFn = async () => delayedTree
      const readFn = async (_root, _rel) => ({ success: true, content: 'export const x = 1;' })

      // Start indexing
      const initPromise = engine.initializeWorkspaceIndex('C:/projects/in-flight', treeFn, readFn)

      assert.strictEqual(engine.isIndexing, true)
      const sessionBefore = engine.activeIndexingSession

      // Clear cache mid-flight (e.g. user closes workspace or switches to null)
      engine.clearCache()

      assert.strictEqual(engine.activeIndexingSession > sessionBefore, true, 'clearCache must bump activeIndexingSession')
      assert.strictEqual(engine.isIndexing, false, 'clearCache must set isIndexing = false')
      assert.strictEqual(engine.currentWorkspaceRoot, null)

      // Allow the delayed indexing to finish
      resolveTree({
        success: true,
        tree: [
          { name: 'file.ts', path: 'C:/projects/in-flight/file.ts', isDirectory: false, size: 20, mtimeMs: 1700000000000 }
        ]
      })
      await initPromise

      // Must not have resurrected state
      assert.strictEqual(engine.isIndexFresh, false, 'Stale indexing must not mark index fresh')
      assert.strictEqual(engine.currentWorkspaceRoot, null, 'Workspace root must remain null after stale indexing')
      assert.strictEqual(engine.codebaseIndex.findFile('file.ts'), null, 'Stale files must not be indexed')
      console.log('✓ PASS: clearCache() safely invalidated in-flight indexing and protected state.')
    }

    // -------------------------------------------------------------
    // Test 15: Watcher queue during fallback build (Issue 3)
    // -------------------------------------------------------------
    console.log('\n[Test 15] Watcher events during restore preserved across fallback build')
    {
      const engine = new SimulatedSmartContextEngine(storage)
      let treeCalls = 0
      let resolveFirstTree
      const firstTreePromise = new Promise((r) => {
        resolveFirstTree = r
      })

      const treeFn = async () => {
        treeCalls++
        if (treeCalls === 1) {
          return firstTreePromise
        }
        return {
          success: true,
          tree: [
            { name: 'fallback.ts', path: 'C:/projects/reconcile-app/fallback.ts', isDirectory: false, size: 20, mtimeMs: 1700000000000 }
          ]
        }
      }
      const readFile = async (_root, _rel) => ({ success: true, content: 'export const fallback = 1;' })

      // Start initialization
      const initPromise = engine.initializeWorkspaceIndex(wsRoot, treeFn, readFile)

      // Wait until engine enters reconciliation
      for (let i = 0; i < 100 && !engine.isReconciling; i++) {
        await new Promise((r) => setTimeout(r, 5))
      }
      assert.strictEqual(engine.isReconciling, true)

      // Emit watcher event during active reconciliation
      await engine.handleFileEvent({
        workspaceRoot: wsRoot,
        relativePath: 'queued-fallback.ts',
        eventType: 'add',
        content: 'export const queuedFallback = 2;'
      })
      assert.strictEqual(engine.queuedWatcherEventsDuringRestore.length, 1)

      // Now fail reconciliation (first tree read fails)
      resolveFirstTree({ success: false, error: 'Reconciliation readTree error' })

      // Await fallback build completion
      await initPromise

      assert.strictEqual(engine.isIndexFresh, true)
      assert.strictEqual(treeCalls, 2, 'Fallback full build must have been triggered')
      // Check that queued-fallback.ts was replayed after fallback build
      assert.notStrictEqual(engine.codebaseIndex.findFile('queued-fallback.ts'), null, 'Queued event must be replayed after fallback build')
      assert.strictEqual(engine.queuedWatcherEventsDuringRestore.length, 0, 'Queue must be drained')
      console.log('✓ PASS: Queued watcher events were preserved and replayed after fallback full build.')
    }

    // -------------------------------------------------------------
    // Test 16: Windows drive casing and strict boundary validation (Issue 4)
    // -------------------------------------------------------------
    console.log('\n[Test 16] Windows drive-letter casing and strict boundary validation')
    {
      // 1. Case-insensitive drive matching on Windows
      const rel1 = toRelativeWorkspacePath('C:/project/src/index.ts', 'c:/project')
      assert.strictEqual(rel1, 'src/index.ts', 'C: vs c: drive match')

      const rel2 = toRelativeWorkspacePath('c:/project/src/index.ts', 'C:/project')
      assert.strictEqual(rel2, 'src/index.ts', 'c: vs C: drive match')

      // 2. Strict boundary check: sibling directories must NOT match
      const relSibling = toRelativeWorkspacePath('C:/project-other/src/index.ts', 'C:/project')
      assert.strictEqual(relSibling, null, 'Sibling directory C:/project-other must NOT match C:/project')

      // 3. Exact root match returns empty string
      const relRoot = toRelativeWorkspacePath('C:/project', 'c:/project')
      assert.strictEqual(relRoot, '', 'Exact root returns empty string')

      // 4. Relative paths remain relative
      const relPure = toRelativeWorkspacePath('src/utils.ts', 'C:/project')
      assert.strictEqual(relPure, 'src/utils.ts', 'Relative paths preserved')

      // 5. extractFileMetadataMap with mixed entries
      const engine = new SimulatedSmartContextEngine(null)
      const mixedTree = [
        { name: 'valid.ts', path: 'c:/project/src/valid.ts', isDirectory: false, size: 10, mtimeMs: 1700000000000 },
        { name: 'sibling.ts', path: 'C:/project-other/sibling.ts', isDirectory: false, size: 20, mtimeMs: 1700000000000 }
      ]
      const metaMap = engine.extractFileMetadataMap(mixedTree, 'C:/project')
      assert.strictEqual(metaMap.has('src/valid.ts'), true, 'Case-insensitive child must be included')
      assert.strictEqual(metaMap.has('-other/sibling.ts'), false, 'Sibling must not be extracted with corrupted prefix')
      assert.strictEqual(metaMap.has('sibling.ts'), false, 'Sibling must not be extracted')
      console.log('✓ PASS: Windows drive casing and strict path boundary checks verified.')
    }

    // -------------------------------------------------------------
    // Test 17: Package.json technology refresh and TypeScript preservation (Issue 5)
    // -------------------------------------------------------------
    console.log('\n[Test 17] Package.json technology refresh and TypeScript preservation')
    {
      const index = new CodebaseIndex()
      const wsFiles = ['package.json', 'src/App.tsx']

      // 1. Index initial package.json with React, Vite, Tailwind
      const initialPkg = JSON.stringify({
        dependencies: {
          react: '^18.0.0',
          tailwindcss: '^3.0.0'
        },
        devDependencies: {
          vite: '^5.0.0',
          typescript: '^5.0.0'
        }
      })
      index.indexFile('package.json', initialPkg, wsFiles)
      index.indexFile('src/App.tsx', 'import React from "react"; export const App = () => null;', wsFiles)

      const techs1 = Array.from(index.detectedTechnologies).sort()
      assert.strictEqual(techs1.includes('React'), true)
      assert.strictEqual(techs1.includes('Tailwind CSS'), true)
      assert.strictEqual(techs1.includes('Vite'), true)
      assert.strictEqual(techs1.includes('TypeScript'), true)

      // 2. Update package.json to remove React and Tailwind (only keep Vite)
      const updatedPkg = JSON.stringify({
        dependencies: {},
        devDependencies: {
          vite: '^5.0.0'
        }
      })
      index.updateFile('package.json', updatedPkg, wsFiles)

      const techs2 = Array.from(index.detectedTechnologies).sort()
      assert.strictEqual(techs2.includes('React'), false, 'React must be removed when dropped from package.json')
      assert.strictEqual(techs2.includes('Tailwind CSS'), false, 'Tailwind must be removed when dropped from package.json')
      assert.strictEqual(techs2.includes('Vite'), true, 'Vite must remain')
      assert.strictEqual(techs2.includes('TypeScript'), true, 'TypeScript must remain because src/App.tsx is present')

      // 3. Remove package.json entirely
      index.removeFile('package.json')
      const techs3 = Array.from(index.detectedTechnologies).sort()
      assert.strictEqual(techs3.includes('Vite'), false, 'Vite must be removed when package.json is unlinked')
      assert.strictEqual(techs3.includes('TypeScript'), true, 'TypeScript must be preserved by remaining .tsx file')
      console.log('✓ PASS: Package.json technologies refreshed cleanly without dropping TS from source files.')
    }

    console.log('\n===========================================================')
    console.log('ALL PHASE 8 OFFLINE RECONCILIATION TESTS PASSED! ✓')
    console.log('===========================================================')
  } finally {
    try {
      await fs.rm(testTempDir, { recursive: true, force: true })
    } catch {}
  }
}

runPhase8Tests().catch((err) => {
  console.error('Phase 8 test failed:', err)
  process.exit(1)
})
