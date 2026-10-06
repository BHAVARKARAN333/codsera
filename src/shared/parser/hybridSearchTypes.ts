/**
 * BM25 + Symbol Hybrid Code Search Types (Phase 11.8)
 *
 * Defines contracts, options, and structured results for multi-factor
 * hybrid search combining BM25 lexical relevance, SymbolIndex AST definitions,
 * direct query path matching, PageRank centrality, and active editor proximity.
 */

import { ExtractedSymbol, SymbolKind } from './types'

export interface HybridSearchWeights {
  /**
   * BM25 lexical relevance weight (Term Frequency, Inverse Document Frequency, length normalization).
   * Default: 0.35
   */
  bm25Weight: number

  /**
   * AST symbol match relevance weight (exact symbol name, exported status, kind importance).
   * Default: 0.25
   */
  symbolWeight: number

  /**
   * Direct path and file base name relevance weight.
   * Default: 0.25
   */
  queryWeight: number

  /**
   * Global dependency graph PageRank centrality weight.
   * Default: 0.15
   */
  pageRankWeight: number
}

export const DEFAULT_HYBRID_SEARCH_WEIGHTS: HybridSearchWeights = {
  bm25Weight: 0.35,
  symbolWeight: 0.25,
  queryWeight: 0.25,
  pageRankWeight: 0.15
}

export interface CodeSearchOptions {
  /** Search query string (optional if passed as first argument) */
  query?: string

  /** Maximum number of results to return (default: 20) */
  maxResults?: number

  /** Optional path to the currently active editor file */
  activeFilePath?: string

  /** Optional 1-based cursor line number in the active editor file */
  cursorLine?: number

  /** Whether to populate matchedSymbols array with matching definitions (default: true) */
  includeSymbols?: boolean

  /** Optional weight overrides for hybrid scoring components */
  weights?: Partial<HybridSearchWeights>

  /** Minimum hybrid score threshold to be included in results (default: 0.01) */
  threshold?: number

  /** Restrict symbol matches to exact name matches only */
  exactSymbol?: boolean

  /** Filter by specific symbol kind (e.g. 'class', 'function') */
  kind?: SymbolKind
}

export interface CodeSearchResult {
  /** Normalized workspace-relative file path */
  filePath: string

  /** Combined hybrid relevance score in [0, 1] */
  score: number

  /** Normalized BM25 score in [0, 1] */
  bm25Score: number

  /** Raw unnormalized BM25 score */
  rawBm25Score: number

  /** AST symbol match relevance score in [0, 1] */
  symbolScore: number

  /** Graph centrality PageRank score in [0, 1] */
  pageRankScore: number

  /** Direct file path & base name relevance score in [0, 1] */
  queryScore: number

  /** Query tokens that matched in this file */
  matchedTokens: string[]

  /** Code symbols in this file matching the query */
  matchedSymbols: ExtractedSymbol[]
}
