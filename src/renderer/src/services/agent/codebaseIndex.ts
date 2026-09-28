/**
 * Codebase Index - Phase 5
 * Lightweight, deterministic static index for workspace source files and project understanding.
 * Reuses DependencyAnalyzer for JS/TS parsing.
 * Provides entry point detection, configuration mapping, technology detection with zero hallucination,
 * dependency querying, test mapping, and project summaries.
 */

import { computeContentHash } from './contextCache'
import {
  DependencyAnalyzer,
  ParsedExport
} from './dependencyAnalyzer'

export type FileType = 'source' | 'test' | 'config' | 'entry' | 'structure' | 'unknown'

export interface FileIndexEntry {
  normalizedPath: string
  fileType: FileType
  extension: string
  imports: string[]
  resolvedDependencies: string[]
  unresolvedImports: string[]
  exports: ParsedExport[]
  declaredSymbols: string[]
  isTestFile: boolean
  isEntryPoint: boolean
  entryPointConfidence: 'detected' | 'likely' | 'unknown'
  isConfigFile: boolean
  contentHash: string
  fileSize: number
  lastIndexed: number
}

export interface SymbolLocation {
  name: string
  file: string
  kind: 'export' | 'declaration'
  line?: number
}

export interface ProjectSummary {
  workspaceRoot: string
  totalFiles: number
  sourceFilesCount: number
  testFilesCount: number
  configFilesCount: number
  mainDirectories: string[]
  detectedEntryPoints: Array<{ path: string; confidence: string; reason: string }>
  configFiles: string[]
  unresolvedLocalImports: Array<{ from: string; specifier: string }>
  detectedTestFrameworks: string[]
  detectedTechnologies: string[]
  runtimePlatform?: string
  testEnvironment?: string
}

const CODE_EXTENSIONS = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'])
const STRUCTURE_EXTENSIONS = new Set(['json', 'css', 'html'])
const CONFIG_FILE_NAMES = new Set([
  'package.json',
  'tsconfig.json',
  'tsconfig.node.json',
  'tsconfig.web.json',
  'vite.config.ts',
  'vite.config.js',
  'electron.vite.config.ts',
  'electron.vite.config.js',
  'webpack.config.js',
  'jest.config.js',
  'jest.config.ts',
  'vitest.config.ts',
  'vitest.config.js',
  '.eslintrc.json',
  '.eslintrc.js',
  '.prettierrc'
])

export class CodebaseIndex {
  private entries: Map<string, FileIndexEntry> = new Map() // normalizedPath -> FileIndexEntry
  private workspaceRoot: string | null = null
  private dependencyAnalyzer: DependencyAnalyzer
  private detectedTechnologies: Set<string> = new Set()
  private debug = false

  constructor(dependencyAnalyzer?: DependencyAnalyzer, debug = false) {
    this.dependencyAnalyzer = dependencyAnalyzer || new DependencyAnalyzer({ debug })
    this.debug = debug
  }

  setDebug(enabled: boolean): void {
    this.debug = enabled
    this.dependencyAnalyzer.setDebug(enabled)
  }

  private normalizePath(filePath: string): string {
    return filePath.replace(/\\/g, '/').replace(/^\/+/, '')
  }

  private normalizeKey(filePath: string): string {
    return this.normalizePath(filePath).toLowerCase()
  }

  clear(): void {
    this.entries.clear()
    this.detectedTechnologies.clear()
    this.workspaceRoot = null
    if (this.debug) {
      console.debug('[CodebaseIndex] Index cleared')
    }
  }

  /**
   * Builds index for the workspace from candidate file list and file reader.
   */
  async buildIndex(
    workspaceRoot: string,
    filePaths: string[],
    fileReader: (path: string) => Promise<string | null>
  ): Promise<void> {
    this.clear()
    this.workspaceRoot = workspaceRoot

    const normalizedPaths = filePaths.map((p) => this.normalizePath(p))

    for (const relPath of normalizedPaths) {
      // Validate path traversal security
      if (relPath.startsWith('..') || relPath.includes('/../')) {
        continue
      }

      const content = await fileReader(relPath)
      if (content !== null) {
        this.indexFile(relPath, content, normalizedPaths)
      }
    }

    if (this.debug) {
      console.debug(
        `[CodebaseIndex] Built index for ${this.entries.size} files in "${workspaceRoot}"`
      )
    }
  }

  /**
   * Indexes a single file and updates metadata.
   */
  indexFile(filePath: string, content: string, allWorkspaceFiles: string[]): FileIndexEntry {
    const normPath = this.normalizePath(filePath)
    const key = this.normalizeKey(filePath)
    const ext = normPath.split('.').pop()?.toLowerCase() || ''
    const baseName = normPath.split('/').pop() || ''
    const baseNameLower = baseName.toLowerCase()

    const isCode = CODE_EXTENSIONS.has(ext)
    const isStructure = STRUCTURE_EXTENSIONS.has(ext)
    const isConfig = CONFIG_FILE_NAMES.has(baseNameLower) || baseNameLower.includes('.config.')

    // Test file detection
    const isTestFile =
      baseNameLower.includes('.test.') ||
      baseNameLower.includes('.spec.') ||
      normPath.toLowerCase().includes('/__tests__/') ||
      normPath.toLowerCase().includes('/tests/') ||
      normPath.toLowerCase().includes('/test/')

    // Entry point detection
    let isEntryPoint = false
    let entryPointConfidence: 'detected' | 'likely' | 'unknown' = 'unknown'

    if (
      normPath === 'src/main/index.ts' ||
      normPath === 'src/main.ts' ||
      normPath === 'src/index.ts' ||
      normPath === 'src/index.tsx' ||
      normPath === 'src/renderer/src/main.tsx' ||
      normPath === 'src/renderer/src/App.tsx' ||
      normPath === 'index.html'
    ) {
      isEntryPoint = true
      entryPointConfidence = normPath === 'index.html' || normPath === 'src/main/index.ts' ? 'detected' : 'likely'
    }

    // Determine FileType
    let fileType: FileType = 'unknown'
    if (isTestFile) fileType = 'test'
    else if (isEntryPoint) fileType = 'entry'
    else if (isConfig) fileType = 'config'
    else if (isCode) fileType = 'source'
    else if (isStructure) fileType = 'structure'

    let imports: string[] = []
    let resolvedDependencies: string[] = []
    let unresolvedImports: string[] = []
    let exports: ParsedExport[] = []
    let declaredSymbols: string[] = []

    if (isCode) {
      const depInfo = this.dependencyAnalyzer.analyzeFileContent(
        normPath,
        content,
        allWorkspaceFiles
      )
      imports = depInfo.imports.map((i) => i.specifier)
      resolvedDependencies = depInfo.imports
        .map((i) => i.resolvedPath)
        .filter((p): p is string => typeof p === 'string' && p.length > 0)
      unresolvedImports = depInfo.unresolvedImports
      exports = depInfo.exports
      declaredSymbols = exports.map((e) => e.name)
    }

    // Technology detection from actual package.json evidence (Zero hallucination)
    if (baseNameLower === 'package.json') {
      try {
        const pkg = JSON.parse(content)
        const allDeps = {
          ...(pkg.dependencies || {}),
          ...(pkg.devDependencies || {})
        }

        if (allDeps['react']) this.detectedTechnologies.add('React')
        if (allDeps['electron']) this.detectedTechnologies.add('Electron')
        if (allDeps['typescript'] || this.entries.has('tsconfig.json')) this.detectedTechnologies.add('TypeScript')
        if (allDeps['vite'] || allDeps['electron-vite']) this.detectedTechnologies.add('Vite')
        if (allDeps['@monaco-editor/react']) this.detectedTechnologies.add('Monaco Editor')
        if (allDeps['tailwindcss']) this.detectedTechnologies.add('Tailwind CSS')
        if (allDeps['jest']) this.detectedTechnologies.add('Jest')
        if (allDeps['vitest']) this.detectedTechnologies.add('Vitest')
        if (allDeps['lucide-react']) this.detectedTechnologies.add('Lucide Icons')

        // Check package.json main field for entry point
        if (pkg.main && typeof pkg.main === 'string') {
          const mainTarget = this.normalizePath(pkg.main)
          const mainKey = this.normalizeKey(mainTarget)
          if (this.entries.has(mainKey)) {
            const entry = this.entries.get(mainKey)!
            entry.isEntryPoint = true
            entry.entryPointConfidence = 'detected'
          }
        }
      } catch {
        // Invalid JSON, ignore
      }
    }

    if (ext === 'ts' || ext === 'tsx' || baseNameLower.includes('tsconfig')) {
      this.detectedTechnologies.add('TypeScript')
    }

    const hash = computeContentHash(content)
    const entry: FileIndexEntry = {
      normalizedPath: normPath,
      fileType,
      extension: ext,
      imports,
      resolvedDependencies,
      unresolvedImports,
      exports,
      declaredSymbols,
      isTestFile,
      isEntryPoint,
      entryPointConfidence,
      isConfigFile: isConfig,
      contentHash: hash,
      fileSize: content.length,
      lastIndexed: Date.now()
    }

    this.entries.set(key, entry)
    return entry
  }

  /**
   * Incremental update for a modified or newly created file.
   */
  updateFile(filePath: string, content: string, allWorkspaceFiles: string[]): FileIndexEntry {
    this.dependencyAnalyzer.invalidateFile(filePath)
    return this.indexFile(filePath, content, allWorkspaceFiles)
  }

  /**
   * Removes a deleted file from the index.
   */
  removeFile(filePath: string): boolean {
    const key = this.normalizeKey(filePath)
    this.dependencyAnalyzer.invalidateFile(filePath)
    return this.entries.delete(key)
  }

  /**
   * Invalidates a file from the index.
   */
  invalidateFile(filePath: string): void {
    const key = this.normalizeKey(filePath)
    this.dependencyAnalyzer.invalidateFile(filePath)
    this.entries.delete(key)
  }

  /**
   * Query API: Finds file entry by path.
   */
  findFile(filePath: string): FileIndexEntry | null {
    return this.entries.get(this.normalizeKey(filePath)) || null
  }

  /**
   * Query API: Finds all files that import target file.
   */
  findImporters(filePath: string): string[] {
    const targetKey = this.normalizeKey(filePath)
    const targetNorm = this.normalizePath(filePath)
    const importers: string[] = []

    for (const entry of this.entries.values()) {
      if (entry.normalizedPath.toLowerCase() === targetKey) continue

      const importsTarget = entry.resolvedDependencies.some(
        (dep) => this.normalizeKey(dep) === targetKey || dep === targetNorm
      )
      if (importsTarget) {
        importers.push(entry.normalizedPath)
      }
    }

    return importers
  }

  /**
   * Query API: Finds all direct dependencies of a file.
   */
  findDependencies(filePath: string): string[] {
    const entry = this.findFile(filePath)
    return entry ? [...entry.resolvedDependencies] : []
  }

  /**
   * Query API: Finds files that export or declare a symbol.
   */
  findSymbol(symbolName: string): SymbolLocation[] {
    const cleanSym = symbolName.trim().toLowerCase()
    if (!cleanSym) return []
    const locations: SymbolLocation[] = []

    for (const entry of this.entries.values()) {
      for (const exp of entry.exports) {
        if (exp.name.toLowerCase() === cleanSym) {
          locations.push({
            name: exp.name,
            file: entry.normalizedPath,
            kind: 'export',
            line: exp.line
          })
        }
      }
    }

    return locations
  }

  /**
   * Query API: Finds likely test files for a specific file.
   */
  findTestsForFile(filePath: string): string[] {
    const allPaths = Array.from(this.entries.values()).map((e) => e.normalizedPath)
    return this.dependencyAnalyzer.findLikelyTests(filePath, allPaths)
  }

  /**
   * Query API: Finds detected or likely entry points.
   */
  findLikelyEntryPoints(): FileIndexEntry[] {
    return Array.from(this.entries.values()).filter((e) => e.isEntryPoint)
  }

  /**
   * Query API: Finds configuration files.
   */
  findConfigFiles(): FileIndexEntry[] {
    return Array.from(this.entries.values()).filter((e) => e.isConfigFile)
  }

  /**
   * Query API: Returns potentially affected files (direct importers + tests).
   */
  getAffectedFiles(filePath: string): string[] {
    const normTarget = this.normalizePath(filePath)
    const isTargetPackageJson = normTarget.toLowerCase() === 'package.json'
    const importers = this.findImporters(normTarget)
    const tests = this.findTestsForFile(normTarget)

    const affected = new Set([...importers, ...tests])
    affected.delete(normTarget)

    // Factual accuracy refinement: do not claim package.json is affected unless package.json itself is the target
    if (!isTargetPackageJson) {
      affected.delete('package.json')
    }

    return Array.from(affected)
  }

  /**
   * Query API: Generates comprehensive, factual project summary with zero hallucination.
   */
  getProjectSummary(): ProjectSummary {
    const allEntries = Array.from(this.entries.values())
    const sourceFiles = allEntries.filter((e) => e.fileType === 'source' || e.fileType === 'entry')
    const testFiles = allEntries.filter((e) => e.isTestFile)
    const configFiles = allEntries.filter((e) => e.isConfigFile)

    // Discover main directories (top-level subfolders)
    const mainDirs = new Set<string>()
    for (const entry of allEntries) {
      const parts = entry.normalizedPath.split('/')
      if (parts.length > 1) {
        mainDirs.add(parts[0])
      }
    }

    // Collect entry points with clear provenance
    const entryPoints = allEntries
      .filter((e) => e.isEntryPoint)
      .map((e) => ({
        path: e.normalizedPath,
        confidence: e.entryPointConfidence,
        reason:
          e.entryPointConfidence === 'detected'
            ? '[Directly Detected] Explicitly designated primary entry point in package.json or root'
            : '[Inferred from standard convention] Typical application entry point'
      }))

    // Collect unresolved local imports
    const unresolvedList: Array<{ from: string; specifier: string }> = []
    for (const entry of allEntries) {
      for (const unres of entry.unresolvedImports) {
        unresolvedList.push({ from: entry.normalizedPath, specifier: unres })
      }
    }

    // Runtime platform vs test environment separation
    let runtimePlatform = 'Node.js Application'
    if (this.detectedTechnologies.has('Electron')) {
      runtimePlatform = 'Electron (Desktop Application)'
    } else if (
      this.detectedTechnologies.has('React') ||
      this.detectedTechnologies.has('Vite') ||
      allEntries.some((e) => e.normalizedPath.toLowerCase() === 'index.html')
    ) {
      runtimePlatform = 'Browser / Web Client'
    }

    let testEnvironment = 'None Detected'
    if (this.detectedTechnologies.has('Jest')) {
      testEnvironment = 'Jest (Node.js Test Runner / JSDOM)'
    } else if (this.detectedTechnologies.has('Vitest')) {
      testEnvironment = 'Vitest (Vite-native Node Test Runner)'
    } else if (testFiles.length > 0) {
      testEnvironment = 'Node.js Test Runner / Inferred Test Suite'
    }

    // Test frameworks
    const testFrameworks: string[] = []
    if (this.detectedTechnologies.has('Jest')) testFrameworks.push('Jest')
    if (this.detectedTechnologies.has('Vitest')) testFrameworks.push('Vitest')
    if (testFiles.length > 0 && testFrameworks.length === 0) {
      testFrameworks.push('Node Test Runner / Standard JS Tests')
    }

    return {
      workspaceRoot: this.workspaceRoot || '',
      totalFiles: allEntries.length,
      sourceFilesCount: sourceFiles.length,
      testFilesCount: testFiles.length,
      configFilesCount: configFiles.length,
      mainDirectories: Array.from(mainDirs).sort(),
      detectedEntryPoints: entryPoints,
      configFiles: configFiles.map((c) => c.normalizedPath).sort(),
      unresolvedLocalImports: unresolvedList,
      detectedTestFrameworks: testFrameworks,
      detectedTechnologies: Array.from(this.detectedTechnologies).sort(),
      runtimePlatform,
      testEnvironment
    }
  }
}
