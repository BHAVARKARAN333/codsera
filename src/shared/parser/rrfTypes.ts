/**
 * Reciprocal Rank Fusion (RRF) Types & Contracts (Phase 11.9)
 *
 * Defines contracts for multi-source context fusion combining independent
 * ranked lists (BM25 lexical search, SymbolIndex AST definitions, PageRank/RepoMap
 * graph centrality, and active editor context) using standard RRF formulas.
 */

import { ExtractedSymbol, SymbolKind } from './types'

export const DEFAULT_RRF_K = 60

export interface RRFSourceWeights {
  /** Weight multiplier for BM25 lexical search results (default: 1.0) */
  bm25?: number

  /** Weight multiplier for AST symbol relevance results (default: 1.0) */
  symbol?: number

  /** Weight multiplier for RepoMap / PageRank centrality results (default: 0.75) */
  repoMap?: number

  /** Weight multiplier for active editor proximity results (default: 0.5) */
  activeContext?: number
}

export const DEFAULT_RRF_WEIGHTS: Required<RRFSourceWeights> = {
  bm25: 1.0,
  symbol: 1.0,
  repoMap: 0.75,
  activeContext: 0.5
}

export interface RankedItem {
  /** Workspace-relative file path */
  filePath: string

  /** Optional raw score from the source system for diagnostic inspection */
  score?: number

  /** Optional AST symbols matched in this item */
  symbols?: ExtractedSymbol[]

  /** Optional source-specific metadata */
  metadata?: Record<string, unknown>
}

export interface RankedSourceList {
  /** Unique identifier for this retrieval channel (e.g. 'bm25', 'symbol', 'repoMap', 'activeContext') */
  sourceId: string

  /** Optional weight override for this channel (defaults to 1.0 or RRFSourceWeights) */
  weight?: number

  /** Ranked list of items, ordered from highest relevance (rank 1) to lowest */
  items: RankedItem[]
}

export interface RRFOptions {
  /** RRF smoothing constant k (default: 60) */
  k?: number

  /** Maximum number of fused results to return */
  maxResults?: number

  /** Channel weight overrides */
  sourceWeights?: RRFSourceWeights
}

export interface RRFFusedResult {
  /** Normalized workspace-relative file path */
  filePath: string

  /** 1-based rank in the fused results list */
  fusedRank?: number

  /** Accumulated Reciprocal Rank Fusion score across all contributing channels */
  rrfScore: number

  /** 1-based rank at which this file appeared in each channel (e.g. { bm25: 1, symbol: 3 }) */
  sourceRanks: Record<string, number>

  /** Numeric RRF score contribution from each channel */
  sourceContributions: Record<string, number>

  /** Channel IDs that returned this file */
  contributingSources: string[]

  /** Deduplicated AST symbols matched across contributing channels */
  matchedSymbols: ExtractedSymbol[]

  /** Combined metadata aggregated from contributing channels */
  metadata: Record<string, unknown>
}

export interface RRFSearchOptions {
  /** Query string for search (optional if passed as first parameter) */
  query?: string

  /** Maximum number of results to return (default: 20) */
  maxResults?: number

  /** Minimum fused RRF score threshold to include in final results */
  minScoreThreshold?: number

  /** Currently active file path in the editor */
  activeFilePath?: string

  /** Current 1-based cursor line number in the active editor file */
  cursorLine?: number

  /** RRF smoothing constant k (default: 60) */
  k?: number

  /** Custom source weights */
  weights?: RRFSourceWeights

  /** Whether to populate matchedSymbols array (default: true) */
  includeSymbols?: boolean

  /** Restrict symbol matches to exact name matches only */
  exactSymbol?: boolean

  /** Filter by specific symbol kind (e.g. 'class', 'function') */
  kind?: SymbolKind
}
