/**
 * Symbol Index & Multi-File Code Intelligence (Phase 11.6)
 *
 * Maintains an in-memory index of symbols, exports, and dependency relationships
 * across workspace files with deterministic lookup and incremental invalidation.
 */

import { ExtractedSymbol, LanguageId } from './types'
import {
  DependencyEdge,
  FileRelevanceScore,
  IndexedFile,
  PageRankOptions,
  RepoMapOptions,
  SymbolSearchOptions
} from './repoMapTypes'
import { TreeSitterParserService, defaultParserService } from './treeSitterParserService'
import { computeContentHash } from './parserCache'
import { extractDependencies } from './dependencyExtractor'
import { ModuleResolver, normalizeWorkspacePath } from './moduleResolver'
import { DependencyGraph } from './dependencyGraph'
import { PageRankCache } from './pageRank'
import { extractQueryTokens, scoreFileRelevance } from './relevanceScorer'
import { BM25Index } from './bm25Index'
import { tokenizeDocumentMetadata } from './codeTokenizer'
import { HybridSearchService } from './hybridSearchService'
import { CodeSearchOptions, CodeSearchResult } from './hybridSearchTypes'
import { RRFSearchService } from './rrfSearchService'
import { RRFSearchOptions, RRFFusedResult } from './rrfTypes'

export class SymbolIndex {
  private parserService: TreeSitterParserService
  private files: Map<string, IndexedFile> = new Map() // normalizedPath -> IndexedFile
  private symbolIndex: Map<string, ExtractedSymbol[]> = new Map() // symbol name (lowercase) -> symbols
  private graph: DependencyGraph = new DependencyGraph()
  private resolver: ModuleResolver = new ModuleResolver()
  private knownFiles: Set<string> = new Set()
  private pageRankCache: PageRankCache = new PageRankCache()
  private bm25Index: BM25Index = new BM25Index()
  private hybridSearchService: HybridSearchService
  private rrfSearchService: RRFSearchService

  constructor(parserService?: TreeSitterParserService) {
    this.parserService = parserService || defaultParserService
    this.hybridSearchService = new HybridSearchService(this, this.bm25Index)
    this.rrfSearchService = new RRFSearchService(this, this.bm25Index)
  }

  /**
   * Updates the set of known workspace-relative file paths for dependency resolution.
   */
  setKnownFiles(files: string[]): void {
    this.knownFiles = new Set(files.map((f) => normalizeWorkspacePath(f) || '').filter(Boolean))
    this.resolver.setKnownFiles(this.knownFiles)
  }

  /**
   * Indexes or updates a workspace file's symbols and dependency edges.
   * If the file content is unchanged (matched hash), reuses cached metadata.
   */
  indexFile(rawPath: string, content: string): IndexedFile {
    const normPath = normalizeWorkspacePath(rawPath)
    if (!normPath) {
      throw new Error(`Invalid workspace path: ${rawPath}`)
    }

    const contentHash = computeContentHash(content)
    const existing = this.files.get(normPath)

    // Skip re-parsing if content hash has not changed
    if (existing && existing.lastContentHash === contentHash) {
      return existing
    }

    // If previously indexed, clean up old index entries, graph edges, and BM25 postings
    if (existing) {
      this.removeFileFromSymbolMap(normPath)
      this.graph.removeFile(normPath)
      this.bm25Index.removeDocument(normPath)
    }

    // Add to known files so relative imports resolve
    this.knownFiles.add(normPath)
    this.resolver.setKnownFiles(this.knownFiles)

    // 1. Parse source code & extract symbols using Phase 11.5 TreeSitterParserService
    const parseResult = this.parserService.parseSource({
      filePath: normPath,
      content
    })

    const language: LanguageId = parseResult.language
    const symbols: ExtractedSymbol[] = parseResult.symbols

    // 2. Extract dependencies
    const rawDeps = extractDependencies(normPath, content, language)

    // 3. Resolve dependencies against known files
    const dependencyEdges: DependencyEdge[] = []
    for (const dep of rawDeps) {
      const resolution = this.resolver.resolve(dep.specifier, normPath)
      const edge: DependencyEdge = {
        from: normPath,
        to: resolution.resolvedPath,
        specifier: dep.specifier,
        resolved: resolution.resolved,
        external: resolution.external,
        kind: dep.kind,
        line: dep.line
      }
      dependencyEdges.push(edge)
      this.graph.addEdge(edge)
    }

    // 4. Extract export names
    const exportNames = symbols
      .filter((s) => s.exported)
      .map((s) => s.name)

    // 5. Index symbols into lookup map
    for (const sym of symbols) {
      const lower = sym.name.toLowerCase()
      if (!this.symbolIndex.has(lower)) {
        this.symbolIndex.set(lower, [])
      }
      this.symbolIndex.get(lower)!.push(sym)
    }

    // 6. Index document code metadata into BM25 inverted index
    const docTokens = tokenizeDocumentMetadata(normPath, symbols)
    this.bm25Index.addDocument(normPath, docTokens)

    const indexedFile: IndexedFile = {
      filePath: normPath,
      language,
      symbols,
      dependencies: dependencyEdges,
      exports: exportNames,
      lastContentHash: contentHash,
      indexedAt: Date.now(),
      size: content.length
    }

    this.files.set(normPath, indexedFile)
    return indexedFile
  }

  /**
   * Removes a file and its symbols/edges from the index.
   */
  removeFile(rawPath: string): boolean {
    const normPath = normalizeWorkspacePath(rawPath)
    if (!normPath || !this.files.has(normPath)) {
      return false
    }

    this.removeFileFromSymbolMap(normPath)
    this.graph.removeFile(normPath)
    this.bm25Index.removeDocument(normPath)
    this.files.delete(normPath)
    this.knownFiles.delete(normPath)
    this.resolver.setKnownFiles(this.knownFiles)
    this.parserService.invalidateFile(normPath)

    return true
  }

  /**
   * Invalidates a file from the parser cache and marks it for re-indexing.
   */
  invalidateFile(rawPath: string): void {
    const normPath = normalizeWorkspacePath(rawPath)
    if (!normPath) return

    this.parserService.invalidateFile(normPath)
    if (this.files.has(normPath)) {
      this.removeFile(normPath)
    }
  }

  /**
   * Returns symbols for a specific file path.
   */
  getFileSymbols(rawPath: string): ExtractedSymbol[] {
    const normPath = normalizeWorkspacePath(rawPath)
    if (!normPath) return []

    const file = this.files.get(normPath)
    if (!file) return []

    return [...file.symbols].sort(
      (a, b) => a.startLine - b.startLine || a.startColumn - b.startColumn
    )
  }

  /**
   * Retrieves symbols with an exact matching name across all indexed files.
   * Deterministically ordered:
   * 1. Exact case match
   * 2. File path
   * 3. Start line
   */
  getSymbol(name: string): ExtractedSymbol[] {
    if (!name || !name.trim()) return []

    const lower = name.trim().toLowerCase()
    const matches = this.symbolIndex.get(lower) || []

    return [...matches]
      .filter((s) => s.name === name.trim())
      .sort((a, b) => a.filePath.localeCompare(b.filePath) || a.startLine - b.startLine)
  }

  /**
   * Deterministic symbol search supporting:
   * - exact match
   * - case-insensitive match
   * - qualified/nested search (e.g. "ClassName.methodName" or parent:child)
   *
   * Ordering:
   * 1. Exact name match
   * 2. Case-insensitive name match
   * 3. File path
   * 4. Start line number
   */
  searchSymbols(query: string, options?: SymbolSearchOptions): ExtractedSymbol[] {
    const trimmed = query.trim()
    if (!trimmed) return []

    const limit = options?.limit ?? 50
    const filterKind = options?.kind
    const filterFile = options?.filePath ? normalizeWorkspacePath(options.filePath) : null

    // Check for qualified search "Parent.Child"
    let parentQuery: string | null = null
    let childQuery: string = trimmed
    if (trimmed.includes('.')) {
      const parts = trimmed.split('.')
      parentQuery = parts[0].trim()
      childQuery = parts.slice(1).join('.').trim()
    }

    const lowerQuery = childQuery.toLowerCase()
    const candidateSymbols: ExtractedSymbol[] = []

    if (options?.exact) {
      const direct = this.symbolIndex.get(lowerQuery) || []
      for (const s of direct) {
        if (s.name === childQuery) {
          candidateSymbols.push(s)
        }
      }
    } else {
      // Find all matches where symbol name includes query or equals query
      for (const [key, syms] of this.symbolIndex.entries()) {
        if (key.includes(lowerQuery)) {
          candidateSymbols.push(...syms)
        }
      }
    }

    // Filter by parent, kind, and filePath
    const filtered = candidateSymbols.filter((s) => {
      if (filterKind && s.kind !== filterKind) return false
      if (filterFile && s.filePath !== filterFile) return false
      if (parentQuery) {
        const matchesParent =
          s.parent &&
          s.parent.toLowerCase() === parentQuery.toLowerCase()
        if (!matchesParent) return false
      }
      return true
    })

    // Deterministic ranking:
    // 1. Exact name match (rank 0)
    // 2. Case-insensitive exact name match (rank 1)
    // 3. Name starts with query (rank 2)
    // 4. Other contains (rank 3)
    // Then file path, then startLine
    filtered.sort((a, b) => {
      const getRank = (sym: ExtractedSymbol): number => {
        if (sym.name === childQuery) return 0
        if (sym.name.toLowerCase() === lowerQuery) return 1
        if (sym.name.toLowerCase().startsWith(lowerQuery)) return 2
        return 3
      }

      const rankDiff = getRank(a) - getRank(b)
      if (rankDiff !== 0) return rankDiff

      const fileDiff = a.filePath.localeCompare(b.filePath)
      if (fileDiff !== 0) return fileDiff

      return a.startLine - b.startLine
    })

    return filtered.slice(0, limit)
  }

  /**
   * Returns a deterministically sorted list of all currently indexed workspace file paths.
   */
  getIndexedFiles(): string[] {
    return Array.from(this.files.keys()).sort()
  }

  /**
   * Returns outgoing dependencies for a file.
   */
  getDependencies(rawPath: string): DependencyEdge[] {
    return this.graph.getDependencies(rawPath)
  }

  /**
   * Returns incoming dependents for a file.
   */
  getDependents(rawPath: string): DependencyEdge[] {
    return this.graph.getDependents(rawPath)
  }

  /**
   * Returns the underlying DependencyGraph.
   */
  getGraph(): DependencyGraph {
    return this.graph
  }

  /**
   * Returns the underlying ModuleResolver.
   */
  getResolver(): ModuleResolver {
    return this.resolver
  }

  /**
   * Returns total count of indexed files.
   */
  getFileCount(): number {
    return this.files.size
  }

  /**
   * Computes or retrieves cached PageRank scores for workspace files.
   */
  getPageRank(options?: PageRankOptions): Map<string, number> {
    const nodes = this.getIndexedFiles()
    return this.pageRankCache.getPageRank(this.graph, {
      ...options,
      nodes
    })
  }

  /**
   * Ranks all indexed workspace files based on query relevance, active file,
   * graph dependencies, and PageRank centrality.
   */
  rankFiles(options?: RepoMapOptions): FileRelevanceScore[] {
    const allFiles = this.getIndexedFiles()
    if (allFiles.length === 0) return []

    const queryTokens = extractQueryTokens(options?.query)
    const pageRankMap = this.getPageRank({
      dampingFactor: options?.dampingFactor,
      iterations: options?.iterations
    })

    const normActive = options?.activeFilePath ? normalizeWorkspacePath(options.activeFilePath) : null
    let activeNeighborhood: { directDependencies: Set<string>; directDependents: Set<string> } | undefined = undefined

    if (normActive) {
      const activeDeps = this.graph.getDependencies(normActive)
      const directDependencies = new Set<string>()
      for (const d of activeDeps) {
        if (d.to) directDependencies.add(d.to)
      }

      const activeDependents = this.graph.getDependents(normActive)
      const directDependents = new Set<string>()
      for (const d of activeDependents) {
        if (d.from) directDependents.add(d.from)
      }

      activeNeighborhood = { directDependencies, directDependents }
    }

    const scoredFiles: FileRelevanceScore[] = []

    for (const filePath of allFiles) {
      const symbols = this.getFileSymbols(filePath)
      const pageRankScore = pageRankMap.get(filePath) ?? 0

      const score = scoreFileRelevance({
        filePath,
        symbols,
        queryTokens,
        activeFilePath: options?.activeFilePath,
        graph: this.graph,
        pageRankScore,
        weights: options?.weights,
        activeNeighborhood
      })

      scoredFiles.push(score)
    }

    // Deterministic tie-breaking:
    // 1. finalScore descending
    // 2. queryScore descending
    // 3. pageRankScore descending
    // 4. normalized file path ascending
    return scoredFiles.sort((a, b) => {
      const finalDiff = b.finalScore - a.finalScore
      if (Math.abs(finalDiff) > 1e-6) return finalDiff

      const queryDiff = b.queryScore - a.queryScore
      if (Math.abs(queryDiff) > 1e-6) return queryDiff

      const prDiff = b.pageRankScore - a.pageRankScore
      if (Math.abs(prDiff) > 1e-6) return prDiff

      return a.filePath.localeCompare(b.filePath)
    })
  }

  /**
   * Returns the underlying BM25Index.
   */
  getBM25Index(): BM25Index {
    return this.bm25Index
  }

  /**
   * Executes a deterministic hybrid code search combining BM25 lexical relevance,
   * AST symbol definitions, direct path matching, and PageRank graph centrality.
   */
  searchCode(query: string, options?: CodeSearchOptions): CodeSearchResult[] {
    return this.hybridSearchService.search(query, options)
  }

  /**
   * Executes Reciprocal Rank Fusion (RRF) across BM25, AST symbols, PageRank,
   * and active context channels into a unified ranking.
   */
  searchCodeRRF(query: string, options?: RRFSearchOptions): RRFFusedResult[] {
    return this.rrfSearchService.search(query, options)
  }

  /**
   * Clears the entire index, graph, resolver state, and BM25 inverted index.
   */
  clear(): void {
    this.files.clear()
    this.symbolIndex.clear()
    this.graph.clear()
    this.knownFiles.clear()
    this.resolver.setKnownFiles([])
    this.pageRankCache.clear()
    this.bm25Index.clear()
  }

  private removeFileFromSymbolMap(normPath: string): void {
    const existing = this.files.get(normPath)
    if (existing) {
      // O(S_file) surgical removal using existing known symbols for this file
      for (const sym of existing.symbols) {
        const key = sym.name.toLowerCase()
        const list = this.symbolIndex.get(key)
        if (list) {
          const remaining = list.filter((s) => s.filePath !== normPath)
          if (remaining.length === 0) {
            this.symbolIndex.delete(key)
          } else {
            this.symbolIndex.set(key, remaining)
          }
        }
      }
      return
    }

    // Fallback: full traversal only if file record was not found
    for (const [key, list] of this.symbolIndex.entries()) {
      const remaining = list.filter((s) => s.filePath !== normPath)
      if (remaining.length === 0) {
        this.symbolIndex.delete(key)
      } else {
        this.symbolIndex.set(key, remaining)
      }
    }
  }
}
