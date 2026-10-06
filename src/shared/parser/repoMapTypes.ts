/**
 * Repo Map & Dependency Graph Types (Phase 11.6 & Phase 11.7)
 *
 * Type contracts for project intelligence, symbol indexing,
 * cross-file dependency graph, PageRank centrality, relevance ranking,
 * and compact Repo Map generation.
 */

import { ExtractedSymbol, LanguageId, SymbolKind } from './types'

export type DependencyKind =
  | 'import'
  | 'require'
  | 'export_from'
  | 'include'
  | 'using'
  | 'use'

export interface ExtractedDependency {
  specifier: string
  line: number
  kind: DependencyKind
  importedSymbols?: string[]
  isExternalHint?: boolean
}

export interface DependencyEdge {
  from: string
  to: string | null
  specifier: string
  resolved: boolean
  external: boolean
  kind: DependencyKind
  line: number
}

export interface IndexedFile {
  filePath: string
  language: LanguageId
  symbols: ExtractedSymbol[]
  dependencies: DependencyEdge[]
  exports: string[]
  lastContentHash: string
  indexedAt: number
  size: number
}

export interface SymbolSearchOptions {
  exact?: boolean
  caseSensitive?: boolean
  limit?: number
  kind?: SymbolKind
  filePath?: string
}

export interface RankingWeights {
  queryWeight: number
  activeWeight: number
  dependencyWeight: number
  dependentWeight: number
  pageRankWeight: number
  symbolWeight: number
}

export interface FileRelevanceScore {
  filePath: string
  queryScore: number
  activeFileScore: number
  dependencyScore: number
  dependentScore: number
  pageRankScore: number
  symbolScore: number
  finalScore: number
}

export interface PageRankOptions {
  dampingFactor?: number
  iterations?: number
  nodes?: string[]
}

export interface RepoMapOptions {
  query?: string
  activeFilePath?: string
  cursorLine?: number
  ranking?: boolean
  weights?: Partial<RankingWeights>
  dampingFactor?: number
  iterations?: number
  maxFiles?: number
  maxSymbolsPerFile?: number
  maxEdges?: number
  maxOutputChars?: number
  includeDependencies?: boolean
}

export interface RepoMapFileEntry {
  filePath: string
  language: LanguageId
  symbols: ExtractedSymbol[]
  dependencies: string[]
  relevanceScore?: FileRelevanceScore
}

export interface RepoMapData {
  files: RepoMapFileEntry[]
  totalFilesIndexed: number
  totalSymbolsIndexed: number
  totalEdges: number
  truncated: boolean
  truncationReason?: string
  relevanceScores?: FileRelevanceScore[]
}

export interface RepoMapResult {
  map: RepoMapData
  formattedText: string
  tokenEstimate: number
  truncated: boolean
  relevanceScores?: FileRelevanceScore[]
}
