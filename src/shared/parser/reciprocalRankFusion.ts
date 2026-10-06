/**
 * Reciprocal Rank Fusion (RRF) Implementation (Phase 11.9)
 *
 * Implements standard, deterministic Reciprocal Rank Fusion over multiple
 * independent retrieval channels with configurable weights, k constant,
 * and deterministic tie-breaking.
 */

import {
  DEFAULT_RRF_K,
  DEFAULT_RRF_WEIGHTS,
  RankedSourceList,
  RRFOptions,
  RRFFusedResult
} from './rrfTypes'
import { normalizeWorkspacePath } from './moduleResolver'

/**
 * Calculates the reciprocal rank fusion contribution for an item at 1-based rank r.
 *
 * formula: score = weight / (k + rank)
 */
export function calculateRRFScore(rank: number, k: number = DEFAULT_RRF_K, weight: number = 1.0): number {
  const safeK = typeof k === 'number' && k > 0 ? k : DEFAULT_RRF_K
  const safeRank = typeof rank === 'number' && rank >= 1 ? rank : 1
  const safeWeight = typeof weight === 'number' && !isNaN(weight) ? Math.max(0, weight) : 1.0

  return safeWeight / (safeK + safeRank)
}

/**
 * Fuses multiple independent ranked source lists into a unified, deterministic ranking.
 *
 * Time complexity: O(R + U log U), where:
 *   R = total items across all ranked source lists
 *   U = number of unique documents fused (U <= R)
 * Space complexity: O(U) for the accumulator map
 *
 * Tie-breaking hierarchy:
 * 1. rrfScore descending
 * 2. number of contributing sources descending
 * 3. normalized filePath ascending
 * 4. first symbol name ascending
 */
export function reciprocalRankFusion(
  sources: RankedSourceList[],
  options?: RRFOptions
): RRFFusedResult[] {
  // Edge case: maxResults === 0
  if (options?.maxResults === 0) {
    return []
  }

  // Edge case: empty source list or all sources empty
  if (!sources || sources.length === 0) {
    return []
  }

  const k = typeof options?.k === 'number' && options.k > 0 ? options.k : DEFAULT_RRF_K
  const maxResults = options?.maxResults

  // Accumulator map: normalizedFilePath -> RRFFusedResult
  const fusedMap = new Map<string, RRFFusedResult>()

  for (const source of sources) {
    if (!source || !source.items || source.items.length === 0) {
      continue
    }

    const sourceId =
      source.sourceId || (source as unknown as { name?: string }).name || 'default'

    // Determine weight for this source:
    // 1. Explicit source.weight
    // 2. options.sourceWeights[sourceId]
    // 3. DEFAULT_RRF_WEIGHTS[sourceId]
    // 4. Fallback 1.0
    let weight = source.weight
    if (typeof weight !== 'number' || isNaN(weight)) {
      if (options?.sourceWeights) {
        weight = (options.sourceWeights as Record<string, number | undefined>)[sourceId]
      }
    }
    if (typeof weight !== 'number' || isNaN(weight)) {
      weight = (DEFAULT_RRF_WEIGHTS as Record<string, number>)[sourceId] ?? 1.0
    }
    weight = Math.max(0, weight)

    const seenInSource = new Set<string>()
    let rank = 1 // 1-based rank

    for (const item of source.items) {
      if (!item || !item.filePath) continue

      const normPath = normalizeWorkspacePath(item.filePath)
      if (!normPath) continue

      // Edge case: handle duplicate documents inside malformed source lists
      if (seenInSource.has(normPath)) {
        continue
      }
      seenInSource.add(normPath)

      const contribution = calculateRRFScore(rank, k, weight)

      let fused = fusedMap.get(normPath)
      if (!fused) {
        fused = {
          filePath: normPath,
          rrfScore: 0,
          sourceRanks: {},
          sourceContributions: {},
          contributingSources: [],
          matchedSymbols: [],
          metadata: {}
        }
        fusedMap.set(normPath, fused)
      }

      fused.rrfScore += contribution
      fused.sourceRanks[sourceId] = rank
      fused.sourceContributions[sourceId] = Math.round(contribution * 1000000) / 1000000
      fused.contributingSources.push(sourceId)

      // Collect matched symbols if present
      if (item.symbols && Array.isArray(item.symbols)) {
        for (const sym of item.symbols) {
          const alreadyHas = fused.matchedSymbols.some(
            (s) => s.name === sym.name && s.startLine === sym.startLine
          )
          if (!alreadyHas) {
            fused.matchedSymbols.push(sym)
          }
        }
      }

      // Merge metadata
      if (item.metadata) {
        Object.assign(fused.metadata, item.metadata)
      }

      rank++
    }
  }

  const results = Array.from(fusedMap.values())

  // Round final RRF scores to 6 decimal places for stable precision
  for (const r of results) {
    r.rrfScore = Math.round(r.rrfScore * 1000000) / 1000000
    // Sort matched symbols deterministically
    r.matchedSymbols.sort((a, b) => a.startLine - b.startLine || a.name.localeCompare(b.name))
  }

  // Deterministic tie-breaking:
  // 1. rrfScore descending
  // 2. number of contributing sources descending
  // 3. normalized filePath ascending
  // 4. first symbol name ascending
  results.sort((a, b) => {
    const scoreDiff = b.rrfScore - a.rrfScore
    if (Math.abs(scoreDiff) > 1e-9) return scoreDiff

    const sourcesDiff = b.contributingSources.length - a.contributingSources.length
    if (sourcesDiff !== 0) return sourcesDiff

    const pathDiff = a.filePath.localeCompare(b.filePath)
    if (pathDiff !== 0) return pathDiff

    const aSym = a.matchedSymbols[0]?.name ?? ''
    const bSym = b.matchedSymbols[0]?.name ?? ''
    return aSym.localeCompare(bSym)
  })

  // Assign 1-based fused rank
  for (let i = 0; i < results.length; i++) {
    results[i].fusedRank = i + 1
  }

  if (typeof maxResults === 'number' && maxResults >= 0) {
    return results.slice(0, maxResults)
  }

  return results
}
