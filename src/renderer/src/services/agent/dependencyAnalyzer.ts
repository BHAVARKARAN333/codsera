/**
 * Dependency-Aware Code Understanding - Phase 3
 * Lightweight static text analysis service for JavaScript / TypeScript files.
 * Provides multiline import/export parsing, TypeScript path alias resolution,
 * relative path & index resolution, symbol reference detection, likely test discovery,
 * dependency graph representation, and change impact previews.
 */

export interface ParsedImport {
  specifier: string
  resolvedPath: string | null
  importedSymbols: string[]
  isDefault: boolean
  isNamespace: boolean
  line: number
}

export interface ParsedExport {
  name: string
  kind: 'function' | 'variable' | 'class' | 'interface' | 'type' | 'enum' | 'reexport' | 'default'
  line: number
}

export interface FileDependencyInfo {
  path: string
  imports: ParsedImport[]
  exports: ParsedExport[]
  unresolvedImports: string[]
  lastAnalyzed: number
}

export interface SymbolReference {
  file: string
  line: number
  snippet: string
  isCall: boolean
  isImport: boolean
  isExport: boolean
}

export interface DependencyGraphNode {
  path: string
  directDependencies: string[] // [Directly Detected] files this file imports
  directImporters: string[] // [Directly Detected] files that directly import this file
  likelyTests: string[] // [Inferred] test files matching naming conventions
  indirectImporters: string[] // [Inferred] secondary downstream importers
  potentiallyAffected: string[] // combined list
  impactBreakdown: {
    directImporters: string[]
    relatedTests: string[]
    indirectImpact: string[]
  }
}

export interface PathAliasMap {
  [aliasPattern: string]: string[]
}

export interface DependencyAnalyzerConfig {
  maxDependencyCandidates?: number
  maxSymbolReferences?: number
  pathAliases?: PathAliasMap
  baseUrl?: string
  debug?: boolean
}

interface CompiledAlias {
  aliasPattern: string
  prefix: string
  suffix: string
  hasWildcard: boolean
  targets: string[]
}

const EXTENSIONS_TO_TRY = ['.ts', '.tsx', '.js', '.jsx', '.d.ts', '.mjs', '.cjs', '.json']

export class DependencyAnalyzer {
  private fileCache: Map<string, FileDependencyInfo> = new Map() // normalizedPath -> FileDependencyInfo
  private workspaceFileLookup: Map<string, string> = new Map() // normalizedKey -> normalizedPath
  private cachedFilesRef: string[] | null = null
  private cachedFilesLength = 0
  private cachedFirstFile: string | undefined = undefined
  private cachedLastFile: string | undefined = undefined
  private config: Required<DependencyAnalyzerConfig>
  private compiledAliases: CompiledAlias[] = []
  private baseUrl = '.'

  constructor(config?: DependencyAnalyzerConfig) {
    const maxDependencyCandidates = config?.maxDependencyCandidates ?? 5
    const maxSymbolReferences = config?.maxSymbolReferences ?? 20
    const baseUrl = config?.baseUrl ?? '.'
    const debug = config?.debug ?? false
    const pathAliases = config?.pathAliases ?? {
      '@/*': ['src/*'],
      '@shared/*': ['src/shared/*'],
      '@renderer/*': ['src/renderer/src/*']
    }

    this.config = {
      maxDependencyCandidates,
      maxSymbolReferences,
      pathAliases,
      baseUrl,
      debug
    }

    this.setPathAliases(pathAliases, baseUrl)
  }

  setDebug(enabled: boolean): void {
    this.config.debug = enabled
  }

  private normalizePath(filePath: string): string {
    return filePath.replace(/\\/g, '/').replace(/^\/+/, '')
  }

  private normalizeKey(filePath: string): string {
    return this.normalizePath(filePath).toLowerCase()
  }

  /**
   * Configures TypeScript path aliases (e.g. { "@/*": ["src/*"], "@shared/*": ["src/shared/*"] }).
   */
  setPathAliases(aliases: PathAliasMap, baseUrl = '.'): void {
    this.config.pathAliases = aliases
    this.baseUrl = baseUrl.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') || '.'
    this.compiledAliases = []

    for (const [pattern, targetList] of Object.entries(aliases)) {
      const normPattern = pattern.replace(/\\/g, '/')
      const targets = Array.isArray(targetList) ? targetList : [targetList]
      const normTargets = targets.map((t) => t.replace(/\\/g, '/'))

      const wildcardIndex = normPattern.indexOf('*')
      if (wildcardIndex !== -1) {
        this.compiledAliases.push({
          aliasPattern: normPattern,
          prefix: normPattern.slice(0, wildcardIndex),
          suffix: normPattern.slice(wildcardIndex + 1),
          hasWildcard: true,
          targets: normTargets
        })
      } else {
        this.compiledAliases.push({
          aliasPattern: normPattern,
          prefix: normPattern,
          suffix: '',
          hasWildcard: false,
          targets: normTargets
        })
      }
    }

    // Sort aliases: longer prefix first for higher specificity
    this.compiledAliases.sort((a, b) => b.prefix.length - a.prefix.length)

    if (this.config.debug) {
      console.debug(
        `[DependencyAnalyzer] Configured ${this.compiledAliases.length} path alias patterns (baseUrl: "${this.baseUrl}")`
      )
    }
  }

  /**
   * Loads path aliases directly from tsconfig.json JSON object or JSON string.
   */
  loadTsConfig(tsconfigContent: string | Record<string, unknown>): void {
    try {
      let parsed: Record<string, any>
      if (typeof tsconfigContent === 'string') {
        // Strip block and line comments to safely parse JSONC tsconfig files
        const cleaned = tsconfigContent.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '')
        parsed = JSON.parse(cleaned)
      } else {
        parsed = tsconfigContent
      }

      const compilerOptions = parsed?.compilerOptions || {}
      const baseUrl = typeof compilerOptions.baseUrl === 'string' ? compilerOptions.baseUrl : '.'
      const paths = (compilerOptions.paths as PathAliasMap) || {}

      this.setPathAliases(paths, baseUrl)
    } catch (err) {
      if (this.config.debug) {
        console.debug('[DependencyAnalyzer] Failed to parse tsconfig for path aliases:', err)
      }
    }
  }

  getPathAliases(): PathAliasMap {
    return { ...this.config.pathAliases }
  }

  clearCache(): void {
    this.fileCache.clear()
    this.workspaceFileLookup = new Map()
    this.cachedFilesRef = null
    this.cachedFilesLength = 0
    this.cachedFirstFile = undefined
    this.cachedLastFile = undefined
    if (this.config.debug) {
      console.debug('[DependencyAnalyzer] Cache cleared')
    }
  }

  invalidateFile(filePath: string): void {
    const key = this.normalizeKey(filePath)
    const existed = this.fileCache.delete(key)
    if (this.workspaceFileLookup.has(key)) {
      this.workspaceFileLookup.delete(key)
      this.cachedFilesRef = null
      this.cachedFilesLength = 0
      this.cachedFirstFile = undefined
      this.cachedLastFile = undefined
    }
    if (this.config.debug && existed) {
      console.debug(`[DependencyAnalyzer] Invalidated: ${key}`)
    }
  }

  /**
   * Sets and pre-indexes the workspace file lookup map.
   * If an empty array is provided, invalidates and empties the lookup cache.
   */
  setWorkspaceFiles(allWorkspaceFiles: string[]): void {
    if (!allWorkspaceFiles || allWorkspaceFiles.length === 0) {
      this.invalidateWorkspaceFiles()
      return
    }
    this.ensureWorkspaceFileLookup(allWorkspaceFiles)
  }

  /**
   * Invalidates the cached workspace file lookup map.
   */
  invalidateWorkspaceFiles(): void {
    this.workspaceFileLookup = new Map()
    this.cachedFilesRef = null
    this.cachedFilesLength = 0
    this.cachedFirstFile = undefined
    this.cachedLastFile = undefined
  }

  /**
   * Returns the count of files currently indexed in the lookup map.
   */
  getWorkspaceFilesCount(): number {
    return this.workspaceFileLookup.size
  }

  /**
   * Returns true if the given files array matches the active cached lookup map.
   */
  isWorkspaceFilesCached(allWorkspaceFiles?: string[]): boolean {
    if (!allWorkspaceFiles) return false
    return (
      this.cachedFilesRef === allWorkspaceFiles &&
      this.cachedFilesLength === allWorkspaceFiles.length &&
      (allWorkspaceFiles.length === 0 ||
        (this.cachedFirstFile === allWorkspaceFiles[0] &&
          this.cachedLastFile === allWorkspaceFiles[allWorkspaceFiles.length - 1]))
    )
  }

  /**
   * Ensures the normalized workspace file lookup map is built and up-to-date.
   * Reuses the existing map if the file list reference, length, and boundary items are unchanged.
   *
   * Note on Immutability-by-Reference:
   * To maintain O(1) resolution without an O(N) element scan on every lookup, arrays passed to
   * this method are assumed to be immutable by reference. If workspace files are modified, callers
   * must pass a new array instance or call `invalidateWorkspaceFiles()` / `setWorkspaceFiles()`.
   */
  private ensureWorkspaceFileLookup(allWorkspaceFiles?: string[]): Map<string, string> {
    if (!allWorkspaceFiles || allWorkspaceFiles.length === 0) {
      return this.workspaceFileLookup
    }

    if (
      this.cachedFilesRef === allWorkspaceFiles &&
      this.cachedFilesLength === allWorkspaceFiles.length &&
      this.cachedFirstFile === allWorkspaceFiles[0] &&
      this.cachedLastFile === allWorkspaceFiles[allWorkspaceFiles.length - 1]
    ) {
      return this.workspaceFileLookup
    }

    const map = new Map<string, string>()
    for (const f of allWorkspaceFiles) {
      map.set(this.normalizeKey(f), this.normalizePath(f))
    }
    this.workspaceFileLookup = map
    this.cachedFilesRef = allWorkspaceFiles
    this.cachedFilesLength = allWorkspaceFiles.length
    this.cachedFirstFile = allWorkspaceFiles[0]
    this.cachedLastFile = allWorkspaceFiles[allWorkspaceFiles.length - 1]

    return this.workspaceFileLookup
  }

  /**
   * Checks if an import specifier matches any configured path alias pattern.
   */
  private matchAliasPattern(specifier: string, alias: CompiledAlias): string | null {
    if (alias.hasWildcard) {
      if (
        specifier.startsWith(alias.prefix) &&
        (alias.suffix === '' || specifier.endsWith(alias.suffix)) &&
        specifier.length >= alias.prefix.length + alias.suffix.length
      ) {
        const matchedWildcard = specifier.slice(
          alias.prefix.length,
          alias.suffix.length > 0 ? specifier.length - alias.suffix.length : undefined
        )
        return matchedWildcard
      }
    } else {
      if (specifier === alias.prefix) {
        return ''
      }
    }
    return null
  }

  /**
   * Constructs candidate relative path from alias target pattern and matched wildcard subpath.
   */
  private resolveAliasTarget(targetPattern: string, matchedWildcard: string): string {
    let replaced = targetPattern.includes('*')
      ? targetPattern.replace('*', matchedWildcard)
      : targetPattern.replace(/\/+$/, '') + (matchedWildcard ? `/${matchedWildcard}` : '')

    replaced = this.normalizePath(replaced)

    if (this.baseUrl && this.baseUrl !== '.') {
      replaced = this.normalizePath(`${this.baseUrl}/${replaced}`)
    }

    return replaced
  }

  /**
   * Checks if a specifier is either local (relative/absolute) or matches a configured path alias.
   */
  isLocalOrAliasSpecifier(specifier: string): boolean {
    if (specifier.startsWith('.') || specifier.startsWith('/')) {
      return true
    }
    for (const alias of this.compiledAliases) {
      if (this.matchAliasPattern(specifier, alias) !== null) {
        return true
      }
    }
    return false
  }

  /**
   * Resolves a relative or aliased import specifier from a source file against available workspace files.
   */
  resolveImportPath(
    fromFilePath: string,
    importSpecifier: string,
    allWorkspaceFiles: string[] = []
  ): string | null {
    const fileLookup = this.ensureWorkspaceFileLookup(allWorkspaceFiles)

    const tryFindCandidate = (candidateBase: string): string | null => {
      // Path containment / security check: reject if attempts traversal above root
      if (
        candidateBase.startsWith('..') ||
        candidateBase.includes('/../') ||
        candidateBase.includes('\\..\\')
      ) {
        return null
      }

      const normalizedBase = this.normalizePath(candidateBase)

      // 1. Exact match with specifier
      const exactKey = normalizedBase.toLowerCase()
      if (fileLookup.has(exactKey)) {
        return fileLookup.get(exactKey)!
      }

      // 2. Try file extensions (.ts, .tsx, .js, .jsx, etc.)
      for (const ext of EXTENSIONS_TO_TRY) {
        const withExtKey = `${normalizedBase}${ext}`.toLowerCase()
        if (fileLookup.has(withExtKey)) {
          return fileLookup.get(withExtKey)!
        }
      }

      // 3. Try directory index files (e.g. dir/index.ts, dir/index.tsx)
      for (const ext of EXTENSIONS_TO_TRY) {
        const indexKey = `${normalizedBase}/index${ext}`.toLowerCase()
        if (fileLookup.has(indexKey)) {
          return fileLookup.get(indexKey)!
        }
      }

      return null
    }

    // 1. Relative or explicit local path resolution
    if (importSpecifier.startsWith('.') || importSpecifier.startsWith('/')) {
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
      return tryFindCandidate(candidateBase)
    }

    // 2. TypeScript path alias resolution
    for (const alias of this.compiledAliases) {
      const matchedWildcard = this.matchAliasPattern(importSpecifier, alias)
      if (matchedWildcard !== null) {
        for (const targetPattern of alias.targets) {
          const candidateBase = this.resolveAliasTarget(targetPattern, matchedWildcard)
          const resolved = tryFindCandidate(candidateBase)
          if (resolved) {
            return resolved
          }
        }
      }
    }

    // Third-party package or unmatched alias
    return null
  }

  /**
   * Parses imports and exports from a JavaScript/TypeScript file using static text analysis.
   * Supports single-line and multiline ESM imports/exports, CommonJS require, and TS path aliases.
   */
  analyzeFileContent(
    filePath: string,
    content: string,
    allWorkspaceFiles: string[] = []
  ): FileDependencyInfo {
    this.ensureWorkspaceFileLookup(allWorkspaceFiles)

    const key = this.normalizeKey(filePath)
    const normalizedPath = this.normalizePath(filePath)

    const lines = content.split(/\r?\n/)
    const imports: ParsedImport[] = []
    const exports: ParsedExport[] = []
    const unresolvedImports: string[] = []
    const seenImportSpecifiers = new Set<string>()

    let inBlockComment = false

    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1
      let line = lines[i].trim()

      // Handle multiline comments /* ... */
      if (inBlockComment) {
        if (line.includes('*/')) {
          inBlockComment = false
          line = line.split('*/')[1].trim()
        } else {
          continue
        }
      }

      if (line.startsWith('/*')) {
        if (line.includes('*/')) {
          line = line.split('*/')[1].trim()
        } else {
          inBlockComment = true
          continue
        }
      }

      // Skip single-line comments or empty lines
      if (line.startsWith('//') || line.startsWith('*') || !line) {
        continue
      }

      // 1. Detect and parse ESM Import Statements (single-line or multiline)
      if (
        line.startsWith('import ') ||
        line.startsWith('import\t') ||
        line.startsWith('import{') ||
        line.startsWith('import"') ||
        line.startsWith("import'")
      ) {
        let fullImport = line
        let endIndex = i

        // If statement does not contain the closing module specifier quotes, accumulate subsequent lines
        if (!/['"][^'"]+['"]/.test(fullImport)) {
          while (
            endIndex + 1 < lines.length &&
            !/['"][^'"]+['"]/.test(fullImport) &&
            endIndex - i < 50
          ) {
            endIndex++
            const nextLine = lines[endIndex].trim()
            if (nextLine.startsWith('//') || nextLine.startsWith('/*')) continue
            fullImport += ' ' + nextLine.split('//')[0].trim()
          }
        }

        i = endIndex // Advance main line pointer past multiline block

        // Normalize internal whitespace
        const cleanImport = fullImport
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\s+/g, ' ')
          .trim()

        const importFromMatch = cleanImport.match(
          /import\s+(?:(?:type\s+)?([\w*\s{},$]+)\s+from\s+)?['"]([^'"]+)['"]/
        )

        if (importFromMatch) {
          const rawSymbols = importFromMatch[1] ? importFromMatch[1].trim() : ''
          const specifier = importFromMatch[2].trim()

          let isDefault = false
          let isNamespace = false
          const importedSymbols: string[] = []

          if (rawSymbols) {
            if (rawSymbols.startsWith('* as ')) {
              isNamespace = true
              importedSymbols.push(rawSymbols.replace('* as ', '').trim())
            } else if (rawSymbols.startsWith('{')) {
              const inner = rawSymbols.replace(/[{}]/g, '')
              inner.split(',').forEach((s) => {
                const clean = s.trim().replace(/^type\s+/, '')
                const parts = clean.split(/\s+as\s+/)
                const orig = parts[0]?.trim()
                const alias = parts[1]?.trim()
                if (orig) importedSymbols.push(orig)
                if (alias && alias !== orig) importedSymbols.push(alias)
              })
            } else {
              // Default import or mixed: "React, { useState }"
              if (rawSymbols.includes(',')) {
                const parts = rawSymbols.split(',')
                const def = parts[0].trim().replace(/^type\s+/, '')
                if (def) {
                  importedSymbols.push(def)
                  isDefault = true
                }

                const rest = parts.slice(1).join(',').replace(/[{}]/g, '')
                rest.split(',').forEach((s) => {
                  const clean = s.trim().replace(/^type\s+/, '')
                  const subParts = clean.split(/\s+as\s+/)
                  const orig = subParts[0]?.trim()
                  const alias = subParts[1]?.trim()
                  if (orig) importedSymbols.push(orig)
                  if (alias && alias !== orig) importedSymbols.push(alias)
                })
              } else {
                isDefault = true
                importedSymbols.push(rawSymbols.replace(/^type\s+/, ''))
              }
            }
          }

          const resolvedPath = this.resolveImportPath(normalizedPath, specifier, allWorkspaceFiles)
          if (!resolvedPath && this.isLocalOrAliasSpecifier(specifier)) {
            if (!unresolvedImports.includes(specifier)) {
              unresolvedImports.push(specifier)
            }
          }

          imports.push({
            specifier,
            resolvedPath,
            importedSymbols: Array.from(new Set(importedSymbols)),
            isDefault,
            isNamespace,
            line: lineNum
          })
          seenImportSpecifiers.add(specifier)
        }
        continue
      }

      // Match CommonJS require(...)
      const requireMatch = line.match(
        /(?:const|let|var)\s+([\w\s{},]+)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/
      )
      if (requireMatch) {
        const rawSymbols = requireMatch[1].trim()
        const specifier = requireMatch[2].trim()
        const importedSymbols: string[] = []

        if (rawSymbols.startsWith('{')) {
          rawSymbols
            .replace(/[{}]/g, '')
            .split(',')
            .forEach((s) => {
              const sym = s.trim().split(':')[0].trim()
              if (sym) importedSymbols.push(sym)
            })
        } else {
          importedSymbols.push(rawSymbols)
        }

        const resolvedPath = this.resolveImportPath(normalizedPath, specifier, allWorkspaceFiles)
        if (!resolvedPath && this.isLocalOrAliasSpecifier(specifier)) {
          if (!unresolvedImports.includes(specifier)) {
            unresolvedImports.push(specifier)
          }
        }

        imports.push({
          specifier,
          resolvedPath,
          importedSymbols: Array.from(new Set(importedSymbols)),
          isDefault: true,
          isNamespace: false,
          line: lineNum
        })
        seenImportSpecifiers.add(specifier)
        continue
      }

      // 2. Detect and parse ESM Export Statements (single-line or multiline)
      if (
        line.startsWith('export ') ||
        line.startsWith('export\t') ||
        line.startsWith('export{') ||
        line.startsWith('export*')
      ) {
        // A. export { ... } or export type { ... } (supports multiline and export-from)
        if (/^export\s+(?:type\s+)?\{/.test(line)) {
          let fullExport = line
          let endIndex = i

          if (!fullExport.includes('}')) {
            while (
              endIndex + 1 < lines.length &&
              !fullExport.includes('}') &&
              endIndex - i < 50
            ) {
              endIndex++
              const nextLine = lines[endIndex].trim()
              if (nextLine.startsWith('//') || nextLine.startsWith('/*')) continue
              fullExport += ' ' + nextLine.split('//')[0].trim()
            }
          }

          // If statement contains 'from', verify closing quote is reached
          if (fullExport.includes('from') && !/['"][^'"]+['"]/.test(fullExport)) {
            while (
              endIndex + 1 < lines.length &&
              !/['"][^'"]+['"]/.test(fullExport) &&
              endIndex - i < 50
            ) {
              endIndex++
              const nextLine = lines[endIndex].trim()
              if (nextLine.startsWith('//') || nextLine.startsWith('/*')) continue
              fullExport += ' ' + nextLine.split('//')[0].trim()
            }
          }

          i = endIndex // Advance main line pointer past multiline export block

          const cleanExport = fullExport
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\s+/g, ' ')
            .trim()
          const exportFromMatch = cleanExport.match(
            /^export\s+(?:type\s+)?\{\s*([^}]+)\s*\}(?:\s*from\s*['"]([^'"]+)['"])?/
          )

          if (exportFromMatch) {
            const inner = exportFromMatch[1]
            const specifier = exportFromMatch[2]?.trim()

            inner.split(',').forEach((s) => {
              const clean = s.trim().replace(/^type\s+/, '')
              const parts = clean.split(/\s+as\s+/)
              const exportName = parts[parts.length - 1]?.trim() || parts[0]?.trim()
              if (exportName) {
                exports.push({ name: exportName, kind: 'reexport', line: lineNum })
              }
            })

            // If export-from has a source specifier, record dependency edge
            if (specifier) {
              const resolvedPath = this.resolveImportPath(
                normalizedPath,
                specifier,
                allWorkspaceFiles
              )
              if (!resolvedPath && this.isLocalOrAliasSpecifier(specifier)) {
                if (!unresolvedImports.includes(specifier)) {
                  unresolvedImports.push(specifier)
                }
              }

              if (!seenImportSpecifiers.has(specifier)) {
                imports.push({
                  specifier,
                  resolvedPath,
                  importedSymbols: [],
                  isDefault: false,
                  isNamespace: false,
                  line: lineNum
                })
                seenImportSpecifiers.add(specifier)
              }
            }
          }
          continue
        }

        // B. export * from './specifier' or export * as ns from './specifier'
        const exportAllMatch = line.match(
          /^export\s+\*\s*(?:as\s+([a-zA-Z_$][\w$]*)\s+)?from\s*['"]([^'"]+)['"]/
        )
        if (exportAllMatch) {
          const nsName = exportAllMatch[1]?.trim()
          const specifier = exportAllMatch[2].trim()
          if (nsName) {
            exports.push({ name: nsName, kind: 'reexport', line: lineNum })
          }

          const resolvedPath = this.resolveImportPath(normalizedPath, specifier, allWorkspaceFiles)
          if (!resolvedPath && this.isLocalOrAliasSpecifier(specifier)) {
            if (!unresolvedImports.includes(specifier)) {
              unresolvedImports.push(specifier)
            }
          }

          if (!seenImportSpecifiers.has(specifier)) {
            imports.push({
              specifier,
              resolvedPath,
              importedSymbols: [],
              isDefault: false,
              isNamespace: true,
              line: lineNum
            })
            seenImportSpecifiers.add(specifier)
          }
          continue
        }

        // C. Standard single-line declarations
        const fnExport = line.match(/export\s+(?:async\s+)?function\s+([a-zA-Z_$][\w$]*)/)
        if (fnExport) {
          exports.push({ name: fnExport[1], kind: 'function', line: lineNum })
          continue
        }

        const varExport = line.match(/export\s+(?:const|let|var)\s+([a-zA-Z_$][\w$]*)/)
        if (varExport) {
          exports.push({ name: varExport[1], kind: 'variable', line: lineNum })
          continue
        }

        const classExport = line.match(/export\s+class\s+([a-zA-Z_$][\w$]*)/)
        if (classExport) {
          exports.push({ name: classExport[1], kind: 'class', line: lineNum })
          continue
        }

        const typeExport = line.match(/export\s+(interface|type|enum)\s+([a-zA-Z_$][\w$]*)/)
        if (typeExport) {
          exports.push({
            name: typeExport[2],
            kind: typeExport[1] as 'interface' | 'type' | 'enum',
            line: lineNum
          })
          continue
        }

        const defaultExport = line.match(
          /export\s+default\s+(?:(?:async\s+)?function\s+([a-zA-Z_$][\w$]*)|class\s+([a-zA-Z_$][\w$]*)|([a-zA-Z_$][\w$]*))/
        )
        if (defaultExport) {
          const name = defaultExport[1] || defaultExport[2] || defaultExport[3] || 'default'
          exports.push({ name, kind: 'default', line: lineNum })
          continue
        }
      }
    }

    const info: FileDependencyInfo = {
      path: normalizedPath,
      imports,
      exports,
      unresolvedImports,
      lastAnalyzed: Date.now()
    }

    this.fileCache.set(key, info)
    return info
  }

  /**
   * Finds all files that import the target file.
   */
  findImporters(
    targetFilePath: string,
    allFilesWithContent: Array<{ path: string; content: string }>,
    allWorkspaceFiles: string[]
  ): string[] {
    const targetKey = this.normalizeKey(targetFilePath)
    const importers: string[] = []

    for (const item of allFilesWithContent) {
      if (this.normalizeKey(item.path) === targetKey) continue

      let info = this.fileCache.get(this.normalizeKey(item.path))
      if (!info) {
        info = this.analyzeFileContent(item.path, item.content, allWorkspaceFiles)
      }

      const importsTarget = info.imports.some((imp) => {
        if (imp.resolvedPath && this.normalizeKey(imp.resolvedPath) === targetKey) {
          return true
        }
        return false
      })

      if (importsTarget) {
        importers.push(this.normalizePath(item.path))
      }
    }

    return importers
  }

  /**
   * Discovers likely test files related to a target file.
   */
  findLikelyTests(targetFilePath: string, allWorkspaceFiles: string[]): string[] {
    const targetNorm = this.normalizePath(targetFilePath)
    const targetSegments = targetNorm.split('/')
    const targetBaseName = targetSegments[targetSegments.length - 1]

    const stem = targetBaseName.replace(/\.(ts|tsx|js|jsx|d\.ts)$/i, '')
    const stemLower = stem.toLowerCase()

    const likelyTests: string[] = []

    for (const rawFile of allWorkspaceFiles) {
      const fileNorm = this.normalizePath(rawFile)
      if (fileNorm === targetNorm) continue

      const fileLower = fileNorm.toLowerCase()
      const segments = fileNorm.split('/')
      const fileName = segments[segments.length - 1].toLowerCase()

      // Check if file is in test directory or has test suffix
      const isTestFile =
        fileName.includes('.test.') ||
        fileName.includes('.spec.') ||
        fileLower.includes('__tests__') ||
        fileLower.includes('/test/') ||
        fileLower.includes('/tests/')

      if (!isTestFile) continue

      // Match 1: exact stem in same dir (e.g. math.test.ts for math.ts)
      if (
        fileName === `${stemLower}.test.ts` ||
        fileName === `${stemLower}.test.tsx` ||
        fileName === `${stemLower}.test.js` ||
        fileName === `${stemLower}.spec.ts` ||
        fileName === `${stemLower}.spec.tsx` ||
        fileName === `${stemLower}.spec.js`
      ) {
        likelyTests.push(fileNorm)
        continue
      }

      // Match 2: inside __tests__ with same stem
      if (
        fileLower.includes('__tests__') &&
        (fileName.startsWith(stemLower + '.') || fileName.startsWith(stemLower + '_'))
      ) {
        likelyTests.push(fileNorm)
        continue
      }

      // Match 3: test file in nearby test folder with matching stem
      if (fileName.includes(stemLower)) {
        likelyTests.push(fileNorm)
      }
    }

    return likelyTests
  }

  /**
   * Finds symbol references in files (excluding comments and strings where practical).
   */
  findSymbolReferences(
    symbolName: string,
    filesWithContent: Array<{ path: string; content: string }>
  ): SymbolReference[] {
    const cleanSym = symbolName.trim()
    if (!cleanSym || cleanSym.length < 2) return []

    const references: SymbolReference[] = []
    // Match word boundary for symbol
    const symbolRegex = new RegExp(`\\b${cleanSym}\\b`)
    const callRegex = new RegExp(`\\b${cleanSym}\\s*\\(`)

    for (const item of filesWithContent) {
      if (references.length >= this.config.maxSymbolReferences) break

      const lines = item.content.split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        if (references.length >= this.config.maxSymbolReferences) break

        const lineNum = i + 1
        const rawLine = lines[i]
        const trimmed = rawLine.trim()

        // Skip pure comments
        if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
          continue
        }

        // Strip single-line comments before checking
        const codeOnly = rawLine.split('//')[0]

        if (symbolRegex.test(codeOnly)) {
          const isImport = codeOnly.includes('import ') || codeOnly.includes('require(')
          const isExport = codeOnly.includes('export ')
          const isCall = callRegex.test(codeOnly)

          references.push({
            file: this.normalizePath(item.path),
            line: lineNum,
            snippet: trimmed.slice(0, 120),
            isCall,
            isImport,
            isExport
          })
        }
      }
    }

    return references
  }

  /**
   * Builds lightweight dependency graph node for a target file with separated impact tiers.
   * Excludes package.json unless package metadata itself is the target.
   */
  buildGraphNode(
    targetFilePath: string,
    targetContent: string,
    allFilesWithContent: Array<{ path: string; content: string }>,
    allWorkspaceFiles: string[]
  ): DependencyGraphNode {
    const normalizedTarget = this.normalizePath(targetFilePath)
    const isTargetPackageJson = normalizedTarget.toLowerCase() === 'package.json'

    const targetInfo = this.analyzeFileContent(normalizedTarget, targetContent, allWorkspaceFiles)

    // Direct dependencies: all resolved import paths from target
    const directDependencies = targetInfo.imports
      .map((imp) => imp.resolvedPath)
      .filter((p): p is string => typeof p === 'string' && p.length > 0)

    // Direct importers: files that directly import target
    const rawDirectImporters = this.findImporters(
      normalizedTarget,
      allFilesWithContent,
      allWorkspaceFiles
    )
    const directImporters = rawDirectImporters.filter((p) =>
      isTargetPackageJson ? true : !p.toLowerCase().endsWith('package.json')
    )

    // Likely tests (inferred)
    const likelyTests = this.findLikelyTests(normalizedTarget, allWorkspaceFiles)

    // Indirect importers (inferred downstream impact: importers of direct importers)
    const indirectSet = new Set<string>()
    for (const directImporter of directImporters) {
      const secondHop = this.findImporters(directImporter, allFilesWithContent, allWorkspaceFiles)
      for (const sh of secondHop) {
        if (
          sh !== normalizedTarget &&
          !directImporters.includes(sh) &&
          !likelyTests.includes(sh) &&
          (isTargetPackageJson || !sh.toLowerCase().endsWith('package.json'))
        ) {
          indirectSet.add(sh)
        }
      }
    }
    const indirectImporters = Array.from(indirectSet)

    // Potentially affected files: combination of directImporters + likelyTests + indirect
    const affectedSet = new Set<string>([...directImporters, ...likelyTests, ...indirectImporters])
    affectedSet.delete(normalizedTarget)

    return {
      path: normalizedTarget,
      directDependencies: Array.from(new Set(directDependencies)),
      directImporters,
      likelyTests,
      indirectImporters,
      potentiallyAffected: Array.from(affectedSet).slice(0, this.config.maxDependencyCandidates),
      impactBreakdown: {
        directImporters,
        relatedTests: likelyTests,
        indirectImpact: indirectImporters
      }
    }
  }
}
