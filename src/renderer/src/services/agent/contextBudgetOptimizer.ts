/**
 * Context Budget Optimizer (Phase 12.0)
 *
 * Intelligently selects the highest-value code context for the AI agent while
 * strictly respecting token, character, and item budgets.
 *
 * Employs utility-density ranking (relevance / tokens), symbol-aware surgical slicing,
 * active editor proximity prioritization, range merging, and context deduplication.
 */

import { ContextDeduplicator } from './contextDeduplicator'
import { ExtractedSymbol } from '@shared/parser/types'

export type ContextItemKind =
  | 'file_slice'
  | 'symbol_definition'
  | 'repo_map'
  | 'search_result'
  | 'dependency'
  | 'active_editor'
  | 'code_range'

export interface CandidateContextItem {
  /** Unique identifier for the candidate */
  id?: string

  /** Workspace-relative file path */
  filePath: string

  /** 1-based start line (optional for full-file or repo map items) */
  startLine?: number

  /** 1-based end line (optional for full-file or repo map items) */
  endLine?: number

  /** Text content of the context slice */
  content: string

  /** What kind of context this candidate represents */
  kind?: ContextItemKind

  /** Estimated tokens (if omitted, calculated as ceil(content.length / 4)) */
  estimatedTokens?: number

  /** Estimated characters (if omitted, content.length) */
  estimatedChars?: number

  /** Base relevance score [0, 1] or raw score */
  relevanceScore?: number

  /** Reciprocal Rank Fusion score [0, 1] if available */
  rrfScore?: number

  /** AST Symbol match relevance score [0, 1] if available */
  symbolScore?: number

  /** Lexical BM25 score [0, 1] if available */
  bm25Score?: number

  /** PageRank graph centrality [0, 1] if available */
  pageRankScore?: number

  /** Direct user query relevance score [0, 1] if available */
  queryScore?: number

  /** Active file affinity score [0, 1] if available */
  activeFileScore?: number

  /** Proximity to cursor line in active file */
  cursorProximity?: number

  /** Direct dependency relationship to active file */
  isDependency?: boolean

  /** Direct dependent relationship to active file */
  isDependent?: boolean

  /** Whether this candidate was explicitly requested by user */
  isExplicit?: boolean

  /** Optional symbol name or metadata */
  symbolName?: string

  /** Retrieval source channel (e.g. 'rrf', 'bm25', 'symbol', 'repoMap') */
  source?: string

  /** Additional arbitrary metadata */
  metadata?: Record<string, unknown>
}

export type ContextBudgetTier = 'small' | 'medium' | 'large' | 'custom'

export interface ContextBudgetTierConfig {
  maxTokens: number
  maxChars?: number
  maxItems?: number
}

export const BUDGET_TIERS: Record<Exclude<ContextBudgetTier, 'custom'>, ContextBudgetTierConfig> = {
  small: { maxTokens: 1000, maxChars: 4000, maxItems: 10 },
  medium: { maxTokens: 4000, maxChars: 16000, maxItems: 25 },
  large: { maxTokens: 8000, maxChars: 32000, maxItems: 50 }
}

export interface PriorityWeights {
  /** Weight for Reciprocal Rank Fusion score (default: 1.0) */
  rrf?: number

  /** Weight for AST symbol match relevance (default: 0.9) */
  symbol?: number

  /** Weight for user query match score (default: 0.8) */
  query?: number

  /** Weight for BM25 lexical score (default: 0.7) */
  bm25?: number

  /** Weight for active editor file affinity (default: 0.6) */
  activeEditor?: number

  /** Weight for cursor line proximity (default: 0.5) */
  cursorProximity?: number

  /** Weight for dependency/dependent relationship (default: 0.4) */
  dependency?: number

  /** Weight for PageRank centrality (default: 0.3, kept bounded) */
  pageRank?: number

  /** Weight for surgical specificity (small slices over huge files) (default: 0.3) */
  specificity?: number

  /** Bonus multiplier for explicitly requested items (default: 2.0) */
  explicit?: number
}

export const DEFAULT_PRIORITY_WEIGHTS: Required<PriorityWeights> = {
  rrf: 1.0,
  symbol: 0.9,
  query: 0.8,
  bm25: 0.7,
  activeEditor: 0.6,
  cursorProximity: 0.5,
  dependency: 0.4,
  pageRank: 0.3,
  specificity: 0.3,
  explicit: 2.0
}

export interface ContextBudgetOptions {
  /** Maximum token budget (overrides tier if specified) */
  maxTokens?: number

  /** Optional maximum character budget */
  maxChars?: number

  /** Optional maximum items budget */
  maxItems?: number

  /** Budget tier preset (default: 'medium' = 4000 tokens) */
  tier?: ContextBudgetTier

  /** Currently active file path in the editor */
  activeFilePath?: string

  /** 1-based cursor line in active file */
  cursorLine?: number

  /** Whether to merge nearby/adjacent ranges from the same file (default: true) */
  mergeRanges?: boolean

  /** Maximum line gap to consider merging adjacent ranges in same file (default: 5 lines) */
  maxMergeLineGap?: number

  /** Minimum priority score threshold to include in selection */
  minPriorityThreshold?: number

  /** Custom scoring weights */
  weights?: PriorityWeights

  /** Optional ContextDeduplicator instance to check and record active context */
  deduplicator?: ContextDeduplicator
}

export interface SelectedContextItem {
  id: string
  filePath: string
  startLine?: number
  endLine?: number
  content: string
  kind: ContextItemKind
  estimatedTokens: number
  estimatedChars: number
  relevanceScore: number
  finalPriority: number
  utilityDensity: number
  selectionReason: string
  source: string
  symbolName?: string
  isMerged?: boolean
  mergedRangeCount?: number
  metadata?: Record<string, unknown>
}

export interface RejectedContextItem {
  id: string
  filePath: string
  startLine?: number
  endLine?: number
  estimatedTokens: number
  estimatedChars: number
  relevanceScore: number
  finalPriority: number
  rejectionReason: string
  source: string
}

export interface OptimizedContextResult {
  selectedItems: SelectedContextItem[]
  rejectedItems: RejectedContextItem[]
  totalEstimatedTokens: number
  totalEstimatedChars: number
  budgetTokens: number
  budgetChars?: number
  budgetUtilization: number
  selectionReasons: string[]
  omissionsSummary?: string
}

/**
 * Standard token estimation convention: ceil(characters / 4).
 */
export function estimateTokens(textOrChars: string | number): number {
  const chars = typeof textOrChars === 'string' ? textOrChars.length : textOrChars
  if (chars <= 0) return 0
  return Math.ceil(chars / 4)
}

/**
 * Normalizes file path to lowercase forward slashes.
 */
function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase()
}

/**
 * Context Budget Optimizer implementation.
 */
export class ContextBudgetOptimizer {
  private deduplicator?: ContextDeduplicator

  constructor(deduplicator?: ContextDeduplicator) {
    this.deduplicator = deduplicator
  }

  setDeduplicator(deduplicator: ContextDeduplicator): void {
    this.deduplicator = deduplicator
  }

  /**
   * Optimizes a collection of candidate context items to fit strictly within a token budget.
   *
   * Time Complexity: O(N log N) where N is candidate count (sorting by utility density).
   * Space Complexity: O(N) for candidate tracking and selection state.
   */
  optimize(
    candidates: CandidateContextItem[],
    options?: ContextBudgetOptions
  ): OptimizedContextResult {
    // 1. Resolve budget limits
    const tier = options?.tier ?? 'medium'
    const tierConfig = tier !== 'custom' ? BUDGET_TIERS[tier] : BUDGET_TIERS.medium
    const budgetTokens = options?.maxTokens ?? tierConfig.maxTokens ?? 4000
    const budgetChars = options?.maxChars ?? tierConfig.maxChars
    const budgetItems = options?.maxItems ?? tierConfig.maxItems

    // Edge case: zero budget
    if (budgetTokens <= 0 || (budgetChars !== undefined && budgetChars <= 0) || (budgetItems !== undefined && budgetItems <= 0)) {
      const rejectedItems: RejectedContextItem[] = candidates.map((c, idx) => ({
        id: c.id || `${c.filePath}:${c.startLine ?? 0}-${c.endLine ?? 0}:${idx}`,
        filePath: c.filePath,
        startLine: c.startLine,
        endLine: c.endLine,
        estimatedTokens: c.estimatedTokens ?? estimateTokens(c.content),
        estimatedChars: c.estimatedChars ?? c.content.length,
        relevanceScore: c.relevanceScore ?? 0,
        finalPriority: 0,
        rejectionReason: 'Budget limit is 0',
        source: c.source || 'unknown'
      }))

      return {
        selectedItems: [],
        rejectedItems,
        totalEstimatedTokens: 0,
        totalEstimatedChars: 0,
        budgetTokens: Math.max(0, budgetTokens),
        budgetChars,
        budgetUtilization: 0,
        selectionReasons: [],
        omissionsSummary: candidates.length > 0 ? `Omitted all ${candidates.length} item(s) due to zero budget.` : undefined
      }
    }

    // Edge case: empty candidates
    if (!candidates || candidates.length === 0) {
      return {
        selectedItems: [],
        rejectedItems: [],
        totalEstimatedTokens: 0,
        totalEstimatedChars: 0,
        budgetTokens,
        budgetChars,
        budgetUtilization: 0,
        selectionReasons: []
      }
    }

    const weights: Required<PriorityWeights> = {
      ...DEFAULT_PRIORITY_WEIGHTS,
      ...options?.weights
    }

    const activeNormPath = options?.activeFilePath ? normalizePath(options.activeFilePath) : null
    const cursorLine = options?.cursorLine

    // 2. Prepare and normalize candidates
    interface PreparedCandidate {
      candidate: CandidateContextItem
      id: string
      normPath: string
      startLine?: number
      endLine?: number
      content: string
      kind: ContextItemKind
      estimatedTokens: number
      estimatedChars: number
      finalPriority: number
      utilityDensity: number
      rankScore: number
      reasons: string[]
    }

    const preparedList: PreparedCandidate[] = []
    const rejectedItems: RejectedContextItem[] = []

    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i]
      if (!c || !c.filePath || typeof c.content !== 'string') {
        continue
      }

      const normPath = normalizePath(c.filePath)
      const id = c.id || `${normPath}:${c.startLine ?? 0}-${c.endLine ?? 0}:${i}`
      const estimatedChars = c.estimatedChars ?? c.content.length
      const estimatedTokens = c.estimatedTokens ?? estimateTokens(estimatedChars)
      const kind: ContextItemKind = c.kind || (c.startLine ? 'file_slice' : 'search_result')

      // Calculate priority signals
      const reasons: string[] = []

      // RRF signal
      const rrf = Math.max(0, Math.min(1, c.rrfScore ?? 0))
      if (rrf > 0) reasons.push(`RRF: ${rrf.toFixed(3)}`)

      // AST Symbol signal
      const symbol = Math.max(0, Math.min(1, c.symbolScore ?? 0))
      if (symbol > 0) reasons.push(`Symbol: ${symbol.toFixed(2)}`)

      // BM25 lexical signal
      const bm25 = Math.max(0, Math.min(1, c.bm25Score ?? 0))
      if (bm25 > 0) reasons.push(`BM25: ${bm25.toFixed(2)}`)

      // User query relevance
      const query = Math.max(0, Math.min(1, c.queryScore ?? c.relevanceScore ?? 0))
      if (query > 0) reasons.push(`Query: ${query.toFixed(2)}`)

      // PageRank centrality
      const pr = Math.max(0, Math.min(1, c.pageRankScore ?? 0))
      if (pr > 0.1) reasons.push(`PageRank: ${pr.toFixed(2)}`)

      // Active editor affinity
      let activeScore = 0
      if (activeNormPath && normPath === activeNormPath) {
        activeScore = c.activeFileScore ?? 1.0
        reasons.push('Active editor file')
      }

      // Cursor proximity
      let cursorScore = 0
      if (activeNormPath && normPath === activeNormPath && typeof cursorLine === 'number' && cursorLine >= 1) {
        if (typeof c.startLine === 'number' && typeof c.endLine === 'number') {
          if (cursorLine >= c.startLine && cursorLine <= c.endLine) {
            cursorScore = 1.0
            reasons.push(`Encloses cursor L${cursorLine}`)
          } else {
            const dist = cursorLine < c.startLine ? c.startLine - cursorLine : cursorLine - c.endLine
            cursorScore = Math.max(0, 1 / (1 + dist / 20))
            if (cursorScore > 0.3) {
              reasons.push(`Near cursor (${dist} lines away)`)
            }
          }
        } else {
          cursorScore = 0.5
        }
      }

      // Dependency bonus
      let depScore = 0
      if (c.isDependency) {
        depScore = 1.0
        reasons.push('Direct dependency')
      } else if (c.isDependent) {
        depScore = 0.8
        reasons.push('Direct dependent')
      }

      // Surgical specificity (small bounded slices score higher than huge entire files)
      let specificityScore = 0.5
      if (c.kind === 'symbol_definition' || (typeof c.startLine === 'number' && typeof c.endLine === 'number' && (c.endLine - c.startLine) <= 100)) {
        specificityScore = 1.0
        reasons.push('Surgical slice')
      } else if (estimatedTokens > 500) {
        specificityScore = 0.2
      }

      // Explicit request bonus
      let explicitBonus = 0
      if (c.isExplicit) {
        explicitBonus = weights.explicit
        reasons.unshift('Explicit user request')
      }

      // Weighted priority sum
      const weightedSum =
        weights.rrf * rrf +
        weights.symbol * symbol +
        weights.query * query +
        weights.bm25 * bm25 +
        weights.activeEditor * activeScore +
        weights.cursorProximity * cursorScore +
        weights.dependency * depScore +
        weights.pageRank * pr +
        weights.specificity * specificityScore +
        explicitBonus

      const finalPriority = Math.round(weightedSum * 10000) / 10000
      const utilityDensity = Math.round((finalPriority / Math.max(1, estimatedTokens)) * 1000000) / 1000000
      // Rank score blends utility density with final priority for stable tie-breaking
      const rankScore = utilityDensity * 1000 + finalPriority

      // Filter by minPriorityThreshold if specified
      if (typeof options?.minPriorityThreshold === 'number' && finalPriority < options.minPriorityThreshold) {
        rejectedItems.push({
          id,
          filePath: c.filePath,
          startLine: c.startLine,
          endLine: c.endLine,
          estimatedTokens,
          estimatedChars,
          relevanceScore: c.relevanceScore ?? 0,
          finalPriority,
          rejectionReason: `Priority ${finalPriority} below threshold (${options.minPriorityThreshold})`,
          source: c.source || 'unknown'
        })
        continue
      }

      preparedList.push({
        candidate: c,
        id,
        normPath,
        startLine: c.startLine,
        endLine: c.endLine,
        content: c.content,
        kind,
        estimatedTokens,
        estimatedChars,
        finalPriority,
        utilityDensity,
        rankScore,
        reasons
      })
    }

    // 3. Deduplication against external ContextDeduplicator and within candidate set
    const deduplicator = options?.deduplicator || this.deduplicator
    const seenContentHashes = new Set<string>()
    const nonDuplicateList: PreparedCandidate[] = []

    for (const p of preparedList) {
      // Check if already in active prompt context via ContextDeduplicator
      if (deduplicator) {
        const alreadyInContext =
          p.startLine !== undefined && p.endLine !== undefined
            ? deduplicator.isFileSliceInContext(p.candidate.filePath, p.startLine, p.endLine, p.content)
            : deduplicator.isFileInContext(p.candidate.filePath, p.content)

        if (alreadyInContext) {
          rejectedItems.push({
            id: p.id,
            filePath: p.candidate.filePath,
            startLine: p.startLine,
            endLine: p.endLine,
            estimatedTokens: p.estimatedTokens,
            estimatedChars: p.estimatedChars,
            relevanceScore: p.candidate.relevanceScore ?? 0,
            finalPriority: p.finalPriority,
            rejectionReason: 'Already in active context (deduplicated)',
            source: p.candidate.source || 'deduplicator'
          })
          continue
        }
      }

      // Check within-batch duplicate content hash
      const contentHash = `${p.normPath}:${p.startLine ?? 0}-${p.endLine ?? 0}`
      if (seenContentHashes.has(contentHash)) {
        rejectedItems.push({
          id: p.id,
          filePath: p.candidate.filePath,
          startLine: p.startLine,
          endLine: p.endLine,
          estimatedTokens: p.estimatedTokens,
          estimatedChars: p.estimatedChars,
          relevanceScore: p.candidate.relevanceScore ?? 0,
          finalPriority: p.finalPriority,
          rejectionReason: 'Duplicate candidate slice in batch',
          source: p.candidate.source || 'batch'
        })
        continue
      }
      seenContentHashes.add(contentHash)
      nonDuplicateList.push(p)
    }

    // 4. Sort candidates by utility density / rankScore descending (O(N log N))
    // Deterministic tie-breakers:
    // 1. rankScore descending
    // 2. finalPriority descending
    // 3. estimatedTokens ascending (prefer more compact slice)
    // 4. filePath ascending
    // 5. startLine ascending
    nonDuplicateList.sort((a, b) => {
      const rankDiff = b.rankScore - a.rankScore
      if (Math.abs(rankDiff) > 1e-6) return rankDiff

      const prioDiff = b.finalPriority - a.finalPriority
      if (Math.abs(prioDiff) > 1e-6) return prioDiff

      const tokenDiff = a.estimatedTokens - b.estimatedTokens
      if (tokenDiff !== 0) return tokenDiff

      const pathDiff = a.normPath.localeCompare(b.normPath)
      if (pathDiff !== 0) return pathDiff

      return (a.startLine ?? 0) - (b.startLine ?? 0)
    })

    // 5. Greedy bounded selection (O(N))
    let totalEstimatedTokens = 0
    let totalEstimatedChars = 0
    const preliminarySelected: PreparedCandidate[] = []

    for (const p of nonDuplicateList) {
      const remainingTokens = budgetTokens - totalEstimatedTokens
      const remainingChars = budgetChars !== undefined ? budgetChars - totalEstimatedChars : undefined
      const remainingItems = budgetItems !== undefined ? budgetItems - preliminarySelected.length : undefined

      // Check if item count exhausted
      if (remainingItems !== undefined && remainingItems <= 0) {
        rejectedItems.push({
          id: p.id,
          filePath: p.candidate.filePath,
          startLine: p.startLine,
          endLine: p.endLine,
          estimatedTokens: p.estimatedTokens,
          estimatedChars: p.estimatedChars,
          relevanceScore: p.candidate.relevanceScore ?? 0,
          finalPriority: p.finalPriority,
          rejectionReason: `Maximum items budget (${budgetItems}) reached`,
          source: p.candidate.source || 'unknown'
        })
        continue
      }

      // Check if candidate exceeds remaining token budget
      if (p.estimatedTokens > remainingTokens) {
        rejectedItems.push({
          id: p.id,
          filePath: p.candidate.filePath,
          startLine: p.startLine,
          endLine: p.endLine,
          estimatedTokens: p.estimatedTokens,
          estimatedChars: p.estimatedChars,
          relevanceScore: p.candidate.relevanceScore ?? 0,
          finalPriority: p.finalPriority,
          rejectionReason: `Exceeds remaining token budget (${p.estimatedTokens} > ${remainingTokens})`,
          source: p.candidate.source || 'unknown'
        })
        continue
      }

      // Check character budget if configured
      if (remainingChars !== undefined && p.estimatedChars > remainingChars) {
        rejectedItems.push({
          id: p.id,
          filePath: p.candidate.filePath,
          startLine: p.startLine,
          endLine: p.endLine,
          estimatedTokens: p.estimatedTokens,
          estimatedChars: p.estimatedChars,
          relevanceScore: p.candidate.relevanceScore ?? 0,
          finalPriority: p.finalPriority,
          rejectionReason: `Exceeds remaining character budget (${p.estimatedChars} > ${remainingChars})`,
          source: p.candidate.source || 'unknown'
        })
        continue
      }

      // Check range containment / redundancy against already selected items from same file
      let isContained = false
      if (p.startLine !== undefined && p.endLine !== undefined) {
        for (const sel of preliminarySelected) {
          if (sel.normPath === p.normPath && sel.startLine !== undefined && sel.endLine !== undefined) {
            // If already selected range completely contains p's range
            if (sel.startLine <= p.startLine && sel.endLine >= p.endLine) {
              isContained = true
              break
            }
          }
        }
      }

      if (isContained) {
        rejectedItems.push({
          id: p.id,
          filePath: p.candidate.filePath,
          startLine: p.startLine,
          endLine: p.endLine,
          estimatedTokens: p.estimatedTokens,
          estimatedChars: p.estimatedChars,
          relevanceScore: p.candidate.relevanceScore ?? 0,
          finalPriority: p.finalPriority,
          rejectionReason: 'Contained within higher-value slice from same file',
          source: p.candidate.source || 'unknown'
        })
        continue
      }

      // Allocate candidate
      preliminarySelected.push(p)
      totalEstimatedTokens += p.estimatedTokens
      totalEstimatedChars += p.estimatedChars
    }

    // 6. Range Merging (Section 8)
    const shouldMerge = options?.mergeRanges !== false
    const maxGap = options?.maxMergeLineGap ?? 5
    let finalSelectedList: SelectedContextItem[] = []

    if (shouldMerge && preliminarySelected.length > 1) {
      // Group items by normalized file path
      const fileGroups = new Map<string, PreparedCandidate[]>()
      const nonSliceItems: PreparedCandidate[] = []

      for (const p of preliminarySelected) {
        if (typeof p.startLine === 'number' && typeof p.endLine === 'number') {
          const list = fileGroups.get(p.normPath) || []
          list.push(p)
          fileGroups.set(p.normPath, list)
        } else {
          nonSliceItems.push(p)
        }
      }

      for (const group of fileGroups.values()) {
        if (group.length <= 1) {
          for (const item of group) {
            finalSelectedList.push(this.toSelectedItem(item))
          }
          continue
        }

        // Sort group by startLine ascending
        group.sort((a, b) => (a.startLine ?? 0) - (b.startLine ?? 0))

        let current = group[0]
        let currentMergedCount = 1

        for (let j = 1; j < group.length; j++) {
          const next = group[j]
          const currentEnd = current.endLine ?? 0
          const nextStart = next.startLine ?? 0
          const nextEnd = next.endLine ?? 0

          // Check if ranges are adjacent or within maxGap
          if (nextStart <= currentEnd + 1 + maxGap) {
            // Attempt merge
            const mergedEnd = Math.max(currentEnd, nextEnd)
            const mergedContent = current.content + '\n' + next.content
            const mergedTokens = estimateTokens(mergedContent)
            const tokenDelta = mergedTokens - (current.estimatedTokens + next.estimatedTokens)

            // Ensure merged range doesn't blow remaining budget
            if (tokenDelta <= (budgetTokens - totalEstimatedTokens)) {
              totalEstimatedTokens += tokenDelta
              totalEstimatedChars += mergedContent.length - (current.estimatedChars + next.estimatedChars)
              current = {
                ...current,
                endLine: mergedEnd,
                content: mergedContent,
                estimatedTokens: mergedTokens,
                estimatedChars: mergedContent.length,
                finalPriority: Math.max(current.finalPriority, next.finalPriority),
                utilityDensity: Math.round((Math.max(current.finalPriority, next.finalPriority) / Math.max(1, mergedTokens)) * 1000000) / 1000000,
                reasons: Array.from(new Set([...current.reasons, ...next.reasons]))
              }
              currentMergedCount++
              continue
            }
          }

          // Could not merge, push current and advance
          const sel = this.toSelectedItem(current)
          if (currentMergedCount > 1) {
            sel.isMerged = true
            sel.mergedRangeCount = currentMergedCount
          }
          finalSelectedList.push(sel)
          current = next
          currentMergedCount = 1
        }

        const sel = this.toSelectedItem(current)
        if (currentMergedCount > 1) {
          sel.isMerged = true
          sel.mergedRangeCount = currentMergedCount
        }
        finalSelectedList.push(sel)
      }

      // Add non-slice items back
      for (const nonSlice of nonSliceItems) {
        finalSelectedList.push(this.toSelectedItem(nonSlice))
      }
    } else {
      finalSelectedList = preliminarySelected.map((p) => this.toSelectedItem(p))
    }

    // 7. Mark selected files/slices in deduplicator if supplied
    if (deduplicator) {
      for (const item of finalSelectedList) {
        if (item.startLine !== undefined && item.endLine !== undefined) {
          deduplicator.markFileSliceInContext(item.filePath, item.startLine, item.endLine, item.content)
        } else {
          deduplicator.markFileInContext(item.filePath, item.content)
        }
      }
    }

    // 8. Re-compute final token/char totals accurately
    totalEstimatedTokens = 0
    totalEstimatedChars = 0
    for (const item of finalSelectedList) {
      totalEstimatedTokens += item.estimatedTokens
      totalEstimatedChars += item.estimatedChars
    }

    const budgetUtilization =
      budgetTokens > 0
        ? Math.round((totalEstimatedTokens / budgetTokens) * 1000) / 1000
        : 0

    // 9. Generate explainability summary
    const selectionReasons = finalSelectedList.map(
      (s) => `[${s.filePath}${s.startLine ? `:${s.startLine}-${s.endLine}` : ''}] ${s.selectionReason} (${s.estimatedTokens} tokens)`
    )

    let omissionsSummary: string | undefined
    if (rejectedItems.length > 0) {
      const budgetRejections = rejectedItems.filter((r) => r.rejectionReason.includes('budget') || r.rejectionReason.includes('threshold'))
      omissionsSummary = `Selected ${finalSelectedList.length} item(s) (${totalEstimatedTokens}/${budgetTokens} tokens, ${(budgetUtilization * 100).toFixed(1)}% budget). Omitted ${rejectedItems.length} candidate(s) (${budgetRejections.length} due to budget/threshold).`
    }

    return {
      selectedItems: finalSelectedList,
      rejectedItems,
      totalEstimatedTokens,
      totalEstimatedChars,
      budgetTokens,
      budgetChars,
      budgetUtilization,
      selectionReasons,
      omissionsSummary
    }
  }

  private toSelectedItem(p: {
    candidate: CandidateContextItem
    id: string
    startLine?: number
    endLine?: number
    content: string
    kind: ContextItemKind
    estimatedTokens: number
    estimatedChars: number
    finalPriority: number
    utilityDensity: number
    reasons: string[]
  }): SelectedContextItem {
    const c = p.candidate
    const reasonText = p.reasons.length > 0 ? p.reasons.join(' + ') : 'Relevant context'
    return {
      id: p.id,
      filePath: c.filePath,
      startLine: p.startLine !== undefined ? p.startLine : c.startLine,
      endLine: p.endLine !== undefined ? p.endLine : c.endLine,
      content: p.content,
      kind: p.kind,
      estimatedTokens: p.estimatedTokens,
      estimatedChars: p.estimatedChars,
      relevanceScore: c.relevanceScore ?? 0,
      finalPriority: p.finalPriority,
      utilityDensity: p.utilityDensity,
      selectionReason: reasonText,
      source: c.source || 'optimizer',
      symbolName: c.symbolName,
      metadata: c.metadata
    }
  }

  /**
   * Helper to create a candidate item from an AST extracted symbol with bounded context range.
   */
  static createCandidateFromSymbol(
    symbol: ExtractedSymbol,
    fileContent: string,
    options?: {
      relevanceScore?: number
      paddingLines?: number
      source?: string
      isExplicit?: boolean
    }
  ): CandidateContextItem {
    const padding = options?.paddingLines ?? 2
    const startLine = Math.max(1, symbol.startLine - padding)
    const endLine = symbol.endLine + padding

    const lines = fileContent.split('\n')
    const sliced = lines.slice(startLine - 1, endLine).join('\n')

    return {
      id: `${symbol.filePath}:${symbol.name}:${startLine}-${endLine}`,
      filePath: symbol.filePath,
      startLine,
      endLine,
      content: sliced,
      kind: 'symbol_definition',
      symbolName: symbol.name,
      relevanceScore: options?.relevanceScore ?? 0.8,
      symbolScore: 1.0,
      source: options?.source || 'symbol_index',
      isExplicit: options?.isExplicit ?? false
    }
  }

  /**
   * Helper to create a candidate from a line slice.
   */
  static createCandidateFromSlice(
    filePath: string,
    startLine: number,
    endLine: number,
    content: string,
    options?: {
      relevanceScore?: number
      source?: string
      isExplicit?: boolean
      kind?: ContextItemKind
    }
  ): CandidateContextItem {
    return {
      id: `${filePath}:${startLine}-${endLine}`,
      filePath,
      startLine,
      endLine,
      content,
      kind: options?.kind || 'code_range',
      relevanceScore: options?.relevanceScore ?? 0.7,
      source: options?.source || 'slice',
      isExplicit: options?.isExplicit ?? false
    }
  }
}
