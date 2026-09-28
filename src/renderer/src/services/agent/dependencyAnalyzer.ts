/**
 * Dependency-Aware Code Understanding - Phase 3
 * Lightweight static text analysis service for JavaScript / TypeScript files.
 * Provides import/export parsing, relative path & index resolution, symbol reference detection,
 * likely test discovery, dependency graph representation, and change impact previews.
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

export interface DependencyAnalyzerConfig {
  maxDependencyCandidates?: number
  maxSymbolReferences?: number
  debug?: boolean
}

const EXTENSIONS_TO_TRY = ['.ts', '.tsx', '.js', '.jsx', '.d.ts', '.mjs', '.cjs', '.json']

export class DependencyAnalyzer {
  private fileCache: Map<string, FileDependencyInfo> = new Map() // normalizedPath -> FileDependencyInfo
  private config: Required<DependencyAnalyzerConfig>

  constructor(config?: DependencyAnalyzerConfig) {
    this.config = {
      maxDependencyCandidates: config?.maxDependencyCandidates ?? 5,
      maxSymbolReferences: config?.maxSymbolReferences ?? 20,
      debug: config?.debug ?? false
    }
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

  clearCache(): void {
    this.fileCache.clear()
    if (this.config.debug) {
      console.debug('[DependencyAnalyzer] Cache cleared')
    }
  }

  invalidateFile(filePath: string): void {
    const key = this.normalizeKey(filePath)
    const existed = this.fileCache.delete(key)
    if (this.config.debug && existed) {
      console.debug(`[DependencyAnalyzer] Invalidated: ${key}`)
    }
  }

  /**
   * Resolves a relative import specifier from a source file against available workspace files.
   */
  resolveImportPath(
    fromFilePath: string,
    importSpecifier: string,
    allWorkspaceFiles: string[]
  ): string | null {
    // Only resolve relative or explicit local imports
    if (!importSpecifier.startsWith('.') && !importSpecifier.startsWith('/')) {
      return null // Third-party package or bare alias (unresolved locally)
    }

    const fromNorm = this.normalizePath(fromFilePath)
    const fromDir = fromNorm.includes('/') ? fromNorm.slice(0, fromNorm.lastIndexOf('/')) : ''

    // Compute joined relative path
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
    const fileLookup = new Map<string, string>()

    for (const f of allWorkspaceFiles) {
      fileLookup.set(this.normalizeKey(f), this.normalizePath(f))
    }

    // 1. Exact match with specifier
    const exactKey = candidateBase.toLowerCase()
    if (fileLookup.has(exactKey)) {
      return fileLookup.get(exactKey)!
    }

    // 2. Try file extensions (.ts, .tsx, .js, .jsx, etc.)
    for (const ext of EXTENSIONS_TO_TRY) {
      const withExtKey = `${candidateBase}${ext}`.toLowerCase()
      if (fileLookup.has(withExtKey)) {
        return fileLookup.get(withExtKey)!
      }
    }

    // 3. Try directory index files (e.g. dir/index.ts, dir/index.tsx)
    for (const ext of EXTENSIONS_TO_TRY) {
      const indexKey = `${candidateBase}/index${ext}`.toLowerCase()
      if (fileLookup.has(indexKey)) {
        return fileLookup.get(indexKey)!
      }
    }

    return null
  }

  /**
   * Parses imports and exports from a JavaScript/TypeScript file using static text analysis.
   */
  analyzeFileContent(
    filePath: string,
    content: string,
    allWorkspaceFiles: string[] = []
  ): FileDependencyInfo {
    const key = this.normalizeKey(filePath)
    const normalizedPath = this.normalizePath(filePath)

    const lines = content.split(/\r?\n/)
    const imports: ParsedImport[] = []
    const exports: ParsedExport[] = []
    const unresolvedImports: string[] = []

    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1
      const line = lines[i].trim()

      // Skip pure single line comment lines
      if (line.startsWith('//') || line.startsWith('/*') || line.startsWith('*')) {
        continue
      }

      // 1. Match imports:
      // - import defaultExport from './specifier'
      // - import { a, b as c } from './specifier'
      // - import * as name from './specifier'
      // - import './specifier'
      const importFromMatch = line.match(
        /import\s+(?:(?:type\s+)?([\w*\s{},]+)\s+from\s+)?['"]([^'"]+)['"]/
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
              const sym = s.trim().split(/\s+as\s+/)[0].trim()
              if (sym) importedSymbols.push(sym)
            })
          } else {
            // Default import or mixed: "React, { useState }"
            if (rawSymbols.includes(',')) {
              const parts = rawSymbols.split(',')
              const def = parts[0].trim()
              if (def) importedSymbols.push(def)
              isDefault = true

              const rest = parts.slice(1).join(',').replace(/[{}]/g, '')
              rest.split(',').forEach((s) => {
                const sym = s.trim().split(/\s+as\s+/)[0].trim()
                if (sym) importedSymbols.push(sym)
              })
            } else {
              isDefault = true
              importedSymbols.push(rawSymbols)
            }
          }
        }

        const resolvedPath = this.resolveImportPath(normalizedPath, specifier, allWorkspaceFiles)
        if (!resolvedPath && (specifier.startsWith('.') || specifier.startsWith('/'))) {
          unresolvedImports.push(specifier)
        }

        imports.push({
          specifier,
          resolvedPath,
          importedSymbols,
          isDefault,
          isNamespace,
          line: lineNum
        })
      }

      // Match require(...)
      const requireMatch = line.match(/(?:const|let|var)\s+([\w\s{},]+)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/)
      if (requireMatch) {
        const rawSymbols = requireMatch[1].trim()
        const specifier = requireMatch[2].trim()
        const importedSymbols: string[] = []

        if (rawSymbols.startsWith('{')) {
          rawSymbols.replace(/[{}]/g, '').split(',').forEach((s) => {
            const sym = s.trim().split(':')[0].trim()
            if (sym) importedSymbols.push(sym)
          })
        } else {
          importedSymbols.push(rawSymbols)
        }

        const resolvedPath = this.resolveImportPath(normalizedPath, specifier, allWorkspaceFiles)
        if (!resolvedPath && (specifier.startsWith('.') || specifier.startsWith('/'))) {
          unresolvedImports.push(specifier)
        }

        imports.push({
          specifier,
          resolvedPath,
          importedSymbols,
          isDefault: true,
          isNamespace: false,
          line: lineNum
        })
      }

      // 2. Match exports:
      // - export function foo
      const fnExport = line.match(/export\s+(?:async\s+)?function\s+([a-zA-Z_$][\w$]*)/)
      if (fnExport) {
        exports.push({ name: fnExport[1], kind: 'function', line: lineNum })
      }

      // - export const / let / var
      const varExport = line.match(/export\s+(?:const|let|var)\s+([a-zA-Z_$][\w$]*)/)
      if (varExport) {
        exports.push({ name: varExport[1], kind: 'variable', line: lineNum })
      }

      // - export class
      const classExport = line.match(/export\s+class\s+([a-zA-Z_$][\w$]*)/)
      if (classExport) {
        exports.push({ name: classExport[1], kind: 'class', line: lineNum })
      }

      // - export interface / type / enum
      const typeExport = line.match(/export\s+(interface|type|enum)\s+([a-zA-Z_$][\w$]*)/)
      if (typeExport) {
        exports.push({
          name: typeExport[2],
          kind: typeExport[1] as 'interface' | 'type' | 'enum',
          line: lineNum
        })
      }

      // - export { a, b as c }
      const namedExport = line.match(/export\s*\{\s*([^}]+)\s*\}(?:\s*from\s*['"]([^'"]+)['"])?/)
      if (namedExport && !line.startsWith('export type')) {
        const inner = namedExport[1]
        inner.split(',').forEach((s) => {
          const sym = s.trim().split(/\s+as\s+/)[0].trim()
          if (sym) {
            exports.push({ name: sym, kind: 'reexport', line: lineNum })
          }
        })
      }

      // - export default
      const defaultExport = line.match(
        /export\s+default\s+(?:(?:async\s+)?function\s+([a-zA-Z_$][\w$]*)|class\s+([a-zA-Z_$][\w$]*)|([a-zA-Z_$][\w$]*))/
      )
      if (defaultExport) {
        const name = defaultExport[1] || defaultExport[2] || defaultExport[3] || 'default'
        exports.push({ name, kind: 'default', line: lineNum })
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

