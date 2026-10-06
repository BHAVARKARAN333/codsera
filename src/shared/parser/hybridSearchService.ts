/**
 * Hybrid Code Search Service (Phase 11.8)
 *
 * Combines BM25 lexical relevance, SymbolIndex AST definitions, direct path/filename
 * matching, and PageRank graph centrality into an efficient, deterministic code search.
 */

import { SymbolIndex } from './symbolIndex'
import { BM25Index } from './bm25Index'
import { tokenizeQuery, tokenizeIdentifier } from './codeTokenizer'
import {
  CodeSearchOptions,
  CodeSearchResult,
  DEFAULT_HYBRID_SEARCH_WEIGHTS,
  HybridSearchWeights
} from './hybridSearchTypes'
import { ExtractedSymbol } from './types'
import { normalizeWorkspacePath } from './moduleResolver'

export class HybridSearchService {
  private index: SymbolIndex
  private bm25: BM25Index

  constructor(index: SymbolIndex, bm25: BM25Index) {
    this.index = index
    this.bm25 = bm25
  }

  /**
   * Executes a hybrid code search across indexed workspace files and symbols.
   *
   * 1. Tokenizes query into identifier subwords & full terms.
   * 2. Retrieves candidate documents via inverted index and symbol index.
   * 3. Computes normalized BM25, Symbol, Path, and PageRank scores.
   * 4. Synthesizes final hybrid score with deterministic tie-breaking.
   *
   * Time complexity: O(C * Q), where C = candidates, Q = query tokens.
   */
  search(query: string, options?: CodeSearchOptions): CodeSearchResult[] {
    const trimmed = query.trim()
    if (!trimmed) {
      return []
    }

    const maxResults = options?.maxResults ?? 20
    const threshold = options?.threshold ?? 0.01
    const includeSymbols = options?.includeSymbols ?? true
    const activeFilePath = options?.activeFilePath
      ? normalizeWorkspacePath(options.activeFilePath)
      : null

    const weights: HybridSearchWeights = {
      ...DEFAULT_HYBRID_SEARCH_WEIGHTS,
      ...options?.weights
    }

    // 1. Tokenize query
    const queryTokens = tokenizeQuery(trimmed)
    if (queryTokens.length === 0) {
      return []
    }

    // 2. Candidate retrieval via inverted index postings (avoids full-workspace scan)
    const rawBm25Map = this.bm25.search(queryTokens)
    const candidateFiles = new Set<string>()

    for (const docId of rawBm25Map.keys()) {
      candidateFiles.add(docId)
    }

    // Also include candidate files from direct symbol index lookup
    const symbolMatches = this.index.searchSymbols(trimmed, {
      exact: options?.exactSymbol,
      kind: options?.kind,
      limit: 100
    })
    for (const sym of symbolMatches) {
      candidateFiles.add(sym.filePath)
    }

    // Include subword symbol matches
    for (const token of queryTokens) {
      if (token.length >= 3) {
        const tokenSyms = this.index.searchSymbols(token, {
          exact: options?.exactSymbol,
          kind: options?.kind,
          limit: 30
        })
        for (const sym of tokenSyms) {
          candidateFiles.add(sym.filePath)
        }
      }
    }

    // Include active file if it exists in indexed files
    if (activeFilePath && this.index.getFileSymbols(activeFilePath).length > 0) {
      candidateFiles.add(activeFilePath)
    }

    if (candidateFiles.size === 0) {
      return []
    }

    // 3. Find max raw BM25 score among candidates for normalization
    let maxRawBm25 = 0
    for (const filePath of candidateFiles) {
      const bm25Entry = rawBm25Map.get(filePath)
      if (bm25Entry && bm25Entry.rawScore > maxRawBm25) {
        maxRawBm25 = bm25Entry.rawScore
      }
    }

    // 4. Retrieve PageRank scores for candidate files
    const pageRankMap = this.index.getPageRank()

    // Precompute active file direct dependencies for proximity boost
    let activeDepsSet: Set<string> | null = null
    if (activeFilePath) {
      const deps = this.index.getDependencies(activeFilePath)
      activeDepsSet = new Set(deps.map((d) => d.to).filter((t): t is string => Boolean(t)))
    }

    // 5. Score candidate documents
    const results: CodeSearchResult[] = []

    for (const filePath of candidateFiles) {
      const allSymbols = this.index.getFileSymbols(filePath)
      const bm25Entry = rawBm25Map.get(filePath)
      const rawBm25Score = bm25Entry?.rawScore ?? 0
      const bm25Score =
        maxRawBm25 > 0 ? Math.round((rawBm25Score / maxRawBm25) * 10000) / 10000 : 0
      const matchedTokens = bm25Entry?.matchedTokens ?? []

      // Symbol match evaluation & candidate symbols collection
      const { symbolScore, matchingSymbols } = this.evaluateSymbolRelevance(
        allSymbols,
        queryTokens,
        trimmed,
        options?.exactSymbol,
        options?.kind,
        activeFilePath === filePath ? options?.cursorLine : undefined
      )

      // Direct file path & base name relevance score
      const queryScore = this.evaluatePathRelevance(filePath, queryTokens)

      // PageRank graph centrality
      const pageRankScore = pageRankMap.get(filePath) ?? 0

      // Active file proximity boost (bounded bonus: +0.05 for active, +0.03 for direct dep)
      let activeBoost = 0
      if (activeFilePath) {
        if (filePath === activeFilePath) {
          activeBoost = 0.05
        } else if (activeDepsSet && activeDepsSet.has(filePath)) {
          activeBoost = 0.03
        }
      }

      // Linear weighted hybrid combination
      const rawHybridScore =
        weights.bm25Weight * bm25Score +
        weights.symbolWeight * symbolScore +
        weights.queryWeight * queryScore +
        weights.pageRankWeight * pageRankScore +
        activeBoost

      const finalScore = Math.max(0, Math.min(1.0, Math.round(rawHybridScore * 10000) / 10000))

      if (finalScore >= threshold) {
        results.push({
          filePath,
          score: finalScore,
          bm25Score,
          rawBm25Score,
          symbolScore,
          pageRankScore,
          queryScore,
          matchedTokens: Array.from(new Set(matchedTokens)),
          matchedSymbols: includeSymbols ? matchingSymbols : []
        })
      }
    }

    // 6. Deterministic tie-breaking:
    // 1. score descending
    // 2. normalized filePath ascending
    // 3. first matching symbol name ascending
    results.sort((a, b) => {
      const scoreDiff = b.score - a.score
      if (Math.abs(scoreDiff) > 1e-6) return scoreDiff

      const pathDiff = a.filePath.localeCompare(b.filePath)
      if (pathDiff !== 0) return pathDiff

      const aFirst = a.matchedSymbols[0]?.name ?? ''
      const bFirst = b.matchedSymbols[0]?.name ?? ''
      return aFirst.localeCompare(bFirst)
    })

    return results.slice(0, maxResults)
  }

  /**
   * Evaluates AST symbol relevance for a file and collects matching symbols.
   */
  private evaluateSymbolRelevance(
    symbols: ExtractedSymbol[],
    queryTokens: string[],
    rawQuery: string,
    exactOnly?: boolean,
    filterKind?: string,
    cursorLine?: number
  ): { symbolScore: number; matchingSymbols: ExtractedSymbol[] } {
    if (symbols.length === 0) {
      return { symbolScore: 0, matchingSymbols: [] }
    }

    const lowerRaw = rawQuery.toLowerCase()
    const matchingSymbols: ExtractedSymbol[] = []
    let totalPoints = 0

    for (const sym of symbols) {
      if (filterKind && sym.kind !== filterKind) {
        continue
      }

      const symName = sym.name
      const symLower = symName.toLowerCase()
      const symTokens = tokenizeIdentifier(symName)
      let symPoints = 0
      let isMatch = false

      // 1. Exact name match
      if (symName === rawQuery) {
        symPoints += sym.exported ? 0.7 : 0.55
        isMatch = true
      } else if (symLower === lowerRaw) {
        symPoints += sym.exported ? 0.6 : 0.5
        isMatch = true
      } else if (!exactOnly) {
        // 2. Token / subword match
        for (const qToken of queryTokens) {
          if (symLower === qToken) {
            symPoints += sym.exported ? 0.4 : 0.3
            isMatch = true
          } else if (symTokens.includes(qToken)) {
            symPoints += sym.exported ? 0.3 : 0.2
            isMatch = true
          } else if (symLower.startsWith(qToken) && qToken.length >= 3) {
            symPoints += sym.exported ? 0.25 : 0.18
            isMatch = true
          } else if (symLower.includes(qToken) && qToken.length >= 3) {
            symPoints += sym.exported ? 0.18 : 0.12
            isMatch = true
          }
        }
      }

      if (isMatch) {
        // Architectural importance boost
        switch (sym.kind) {
          case 'class':
          case 'interface':
          case 'struct':
          case 'trait':
            symPoints += 0.1
            break
          case 'type':
          case 'enum':
            symPoints += 0.08
            break
          case 'function':
            symPoints += 0.06
            break
          default:
            symPoints += 0.03
            break
        }

        // Cursor proximity inside active file
        if (typeof cursorLine === 'number' && cursorLine >= 1) {
          if (sym.startLine <= cursorLine && cursorLine <= sym.endLine) {
            symPoints += 0.2 // Cursor is inside this symbol
          }
        }

        totalPoints += symPoints
        matchingSymbols.push(sym)
      }
    }

    // Sort matching symbols deterministically:
    // 1. exact match first
    // 2. exported first
    // 3. startLine ascending
    // 4. name ascending
    matchingSymbols.sort((a, b) => {
      const aExact = a.name.toLowerCase() === lowerRaw ? 1 : 0
      const bExact = b.name.toLowerCase() === lowerRaw ? 1 : 0
      if (aExact !== bExact) return bExact - aExact

      const aExp = a.exported ? 1 : 0
      const bExp = b.exported ? 1 : 0
      if (aExp !== bExp) return bExp - aExp

      const lineDiff = a.startLine - b.startLine
      if (lineDiff !== 0) return lineDiff

      return a.name.localeCompare(b.name)
    })

    const symbolScore = Math.min(1.0, Math.round(totalPoints * 100) / 100)
    return { symbolScore, matchingSymbols }
  }

  /**
   * Evaluates path & base name relevance against query tokens.
   */
  private evaluatePathRelevance(filePath: string, queryTokens: string[]): number {
    const norm = filePath.replace(/\\/g, '/')
    const segments = norm.split('/')
    const fileName = segments[segments.length - 1] || ''
    const baseName = fileName.replace(/\.[^.]+$/, '')
    const lowerBase = baseName.toLowerCase()
    const baseTokens = tokenizeIdentifier(baseName)

    let points = 0

    for (const token of queryTokens) {
      // Exact base name match
      if (lowerBase === token) {
        points += 0.6
      } else if (baseTokens.includes(token)) {
        points += 0.4
      } else if (lowerBase.startsWith(token) && token.length >= 3) {
        points += 0.3
      } else if (lowerBase.includes(token) && token.length >= 3) {
        points += 0.2
      }

      // Directory segment match
      for (let i = 0; i < segments.length - 1; i++) {
        const seg = segments[i].toLowerCase()
        if (seg === token) {
          points += 0.25
          break
        } else if (seg.includes(token) && token.length >= 3) {
          points += 0.15
          break
        }
      }
    }

    return Math.min(1.0, Math.round(points * 100) / 100)
  }
}
