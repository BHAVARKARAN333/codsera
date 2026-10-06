/**
 * Multi-Source RRF Search Service (Phase 11.9)
 *
 * Coordinates independent retrieval channels (BM25 lexical search, AST symbol definitions,
 * RepoMap/PageRank graph centrality, and active editor context) and fuses their ranked
 * outputs using Reciprocal Rank Fusion.
 */

import { SymbolIndex } from './symbolIndex'
import { BM25Index } from './bm25Index'
import { tokenizeQuery } from './codeTokenizer'
import {
  RankedItem,
  RankedSourceList,
  RRFSearchOptions,
  RRFFusedResult,
  DEFAULT_RRF_K,
  DEFAULT_RRF_WEIGHTS
} from './rrfTypes'
import { reciprocalRankFusion } from './reciprocalRankFusion'
import { normalizeWorkspacePath } from './moduleResolver'

export class RRFSearchService {
  private index: SymbolIndex
  private bm25: BM25Index

  constructor(index: SymbolIndex, bm25?: BM25Index) {
    this.index = index
    this.bm25 = bm25 || index.getBM25Index()
  }

  /**
   * Executes multi-source retrieval and applies Reciprocal Rank Fusion.
   *
   * Channels:
   * 1. BM25 Lexical Channel: Term frequency, rarity, document length
   * 2. Symbol Relevance Channel: AST exact and subword matches
   * 3. RepoMap / PageRank Channel: Global dependency graph centrality
   * 4. Active Context Channel: Active editor tab and direct dependencies
   *
   * Time complexity: O(R + U log U), where R = total items retrieved across channels,
   * U = unique documents.
   */
  search(query: string, options?: RRFSearchOptions): RRFFusedResult[] {
    const trimmed = (query ?? options?.query ?? '').trim()
    if (!trimmed) {
      return []
    }

    if (options?.maxResults === 0) {
      return []
    }

    const queryTokens = tokenizeQuery(trimmed)
    if (queryTokens.length === 0) {
      return []
    }

    const activeFilePath = options?.activeFilePath
      ? normalizeWorkspacePath(options.activeFilePath)
      : null

    const weights = {
      ...DEFAULT_RRF_WEIGHTS,
      ...options?.weights
    }

    const channelLimits = Math.max(50, (options?.maxResults ?? 20) * 3)

    // ==========================================
    // Channel 1: BM25 Lexical Channel
    // ==========================================
    const bm25RawResults = this.bm25.searchNormalized(queryTokens)
    const bm25Items: RankedItem[] = bm25RawResults.slice(0, channelLimits).map((r) => ({
      filePath: r.filePath,
      score: r.rawScore,
      metadata: { rawBm25Score: r.rawScore, matchedTokens: r.matchedTokens }
    }))

    // ==========================================
    // Channel 2: Symbol Relevance Channel
    // ==========================================
    const symbolMatches = this.index.searchSymbols(trimmed, {
      exact: options?.exactSymbol,
      kind: options?.kind,
      limit: channelLimits
    })

    // Group matching symbols by file and count
    const symbolsByFile = new Map<string, typeof symbolMatches>()
    for (const sym of symbolMatches) {
      const norm = normalizeWorkspacePath(sym.filePath)
      if (!norm) continue
      let list = symbolsByFile.get(norm)
      if (!list) {
        list = []
        symbolsByFile.set(norm, list)
      }
      list.push(sym)
    }

    // Also include subword symbol matches if query has multiple or longer subwords
    for (const token of queryTokens) {
      if (token.length >= 3) {
        const subwordMatches = this.index.searchSymbols(token, {
          exact: options?.exactSymbol,
          kind: options?.kind,
          limit: 20
        })
        for (const sym of subwordMatches) {
          const norm = normalizeWorkspacePath(sym.filePath)
          if (!norm) continue
          let list = symbolsByFile.get(norm)
          if (!list) {
            list = []
            symbolsByFile.set(norm, list)
          }
          if (!list.some((s) => s.name === sym.name && s.startLine === sym.startLine)) {
            list.push(sym)
          }
        }
      }
    }

    // Rank symbol items: files with exact symbol matches first, then by match count
    const symbolItems: RankedItem[] = Array.from(symbolsByFile.entries())
      .map(([filePath, syms]) => {
        const lowerTrimmed = trimmed.toLowerCase()
        const hasExact = syms.some((s) => s.name.toLowerCase() === lowerTrimmed)
        const hasExported = syms.some((s) => s.exported)
        // Score heuristic purely for sorting Channel 2 ordinal ranks
        const sortScore = (hasExact ? 100 : 0) + (hasExported ? 20 : 0) + syms.length
        return {
          filePath,
          score: sortScore,
          symbols: syms,
          metadata: { symbolCount: syms.length }
        }
      })
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.filePath.localeCompare(b.filePath))
      .slice(0, channelLimits)

    // ==========================================
    // Channel 3: RepoMap / PageRank Channel
    // ==========================================
    // Rank files using existing multi-factor RepoMap / PageRank ranking
    const repoMapRanked = this.index.rankFiles({
      query: trimmed,
      activeFilePath: activeFilePath ?? undefined,
      cursorLine: options?.cursorLine
    })

    const repoMapItems: RankedItem[] = repoMapRanked
      .filter((r) => r.finalScore > 0 || r.pageRankScore > 0)
      .slice(0, channelLimits)
      .map((r) => ({
        filePath: r.filePath,
        score: r.finalScore,
        metadata: { pageRankScore: r.pageRankScore, finalScore: r.finalScore }
      }))

    // ==========================================
    // Channel 4: Active Context Channel (Optional)
    // ==========================================
    const activeItems: RankedItem[] = []
    if (activeFilePath && this.index.getFileSymbols(activeFilePath).length > 0) {
      activeItems.push({
        filePath: activeFilePath,
        score: 1.0,
        metadata: { reason: 'active_file' }
      })

      const directDeps = this.index.getDependencies(activeFilePath)
      for (const dep of directDeps) {
        if (dep.to && dep.to !== activeFilePath) {
          activeItems.push({
            filePath: dep.to,
            score: 0.6,
            metadata: { reason: 'direct_dependency' }
          })
        }
      }
    }

    // Assemble source lists
    const sources: RankedSourceList[] = [
      {
        sourceId: 'bm25',
        weight: weights.bm25,
        items: bm25Items
      },
      {
        sourceId: 'symbol',
        weight: weights.symbol,
        items: symbolItems
      },
      {
        sourceId: 'repoMap',
        weight: weights.repoMap,
        items: repoMapItems
      }
    ]

    if (activeItems.length > 0) {
      sources.push({
        sourceId: 'activeContext',
        weight: weights.activeContext,
        items: activeItems
      })
    }

    // Apply Reciprocal Rank Fusion
    const fused = reciprocalRankFusion(sources, {
      k: options?.k ?? DEFAULT_RRF_K,
      maxResults: options?.maxResults ?? 20,
      sourceWeights: weights
    })

    if (typeof options?.minScoreThreshold === 'number') {
      return fused.filter((r) => r.rrfScore >= options.minScoreThreshold!)
    }

    return fused
  }
}
