/**
 * Context Budget Manager - Phase 2
 * Enforces character-based limits (30k total, 12k per file), handles priority ranking,
 * truncates cleanly, and records dropped items with reasons.
 */

export interface ContextBudgetItem {
  path: string
  content: string
  score: number
  isExplicit?: boolean
  priority?: number
}

export interface AllocatedContextFile {
  path: string
  content: string
  score: number
  isExplicit: boolean
  charCount: number
  truncated: boolean
}

export interface DroppedContextFile {
  path: string
  score: number
  isExplicit: boolean
  reason: string
}

export interface BudgetAllocationResult {
  allocatedFiles: AllocatedContextFile[]
  droppedFiles: DroppedContextFile[]
  totalCharsUsed: number
  remainingBudget: number
  maxBudget: number
}

export interface ContextBudgetConfig {
  maxBudget?: number
  maxFileChars?: number
  minScoreThreshold?: number
}

export class ContextBudgetManager {
  private maxBudget: number
  private maxFileChars: number
  private minScoreThreshold: number
  private debug = false

  constructor(config?: ContextBudgetConfig) {
    this.maxBudget = config?.maxBudget ?? 30000
    this.maxFileChars = config?.maxFileChars ?? 12000
    this.minScoreThreshold = config?.minScoreThreshold ?? 40
  }

  setDebug(enabled: boolean): void {
    this.debug = enabled
  }

  getMaxBudget(): number {
    return this.maxBudget
  }

  getMaxFileChars(): number {
    return this.maxFileChars
  }

  /**
   * Allocates candidate files into the context budget based on priority and relevance.
   */
  allocate(candidates: ContextBudgetItem[]): BudgetAllocationResult {
    // Sort candidates:
    // 1. Explicitly requested files first (isExplicit === true)
    // 2. Highest score descending
    const sorted = [...candidates].sort((a, b) => {
      if (a.isExplicit && !b.isExplicit) return -1
      if (!a.isExplicit && b.isExplicit) return 1
      return b.score - a.score
    })

    const allocatedFiles: AllocatedContextFile[] = []
    const droppedFiles: DroppedContextFile[] = []
    let totalCharsUsed = 0

    for (const item of sorted) {
      const remaining = this.maxBudget - totalCharsUsed

      // If no space left
      if (remaining <= 100) {
        droppedFiles.push({
          path: item.path,
          score: item.score,
          isExplicit: !!item.isExplicit,
          reason: `Context budget exhausted (${totalCharsUsed}/${this.maxBudget} chars used)`
        })
        continue
      }

      // Check minimum score for non-explicit files
      if (!item.isExplicit && item.score < this.minScoreThreshold) {
        droppedFiles.push({
          path: item.path,
          score: item.score,
          isExplicit: false,
          reason: `Relevance score ${item.score} below minimum threshold (${this.minScoreThreshold})`
        })
        continue
      }

      let content = item.content
      let truncated = false

      const fileLimit = Math.min(this.maxFileChars, remaining)

      if (content.length > fileLimit) {
        content = content.slice(0, fileLimit) + '\n\n[... Truncated remainder of file ...]'
        truncated = true
      }

      allocatedFiles.push({
        path: item.path,
        content,
        score: item.score,
        isExplicit: !!item.isExplicit,
        charCount: content.length,
        truncated
      })

      totalCharsUsed += content.length

      if (this.debug) {
        console.debug(
          `[ContextBudget] Allocated ${item.path} (${content.length} chars, score: ${item.score}, remaining: ${this.maxBudget - totalCharsUsed})`
        )
      }
    }

    if (this.debug && droppedFiles.length > 0) {
      console.debug(
        `[ContextBudget] Dropped ${droppedFiles.length} file(s) due to budget/threshold:`,
        droppedFiles.map((d) => `${d.path} (${d.reason})`)
      )
    }

    return {
      allocatedFiles,
      droppedFiles,
      totalCharsUsed,
      remainingBudget: Math.max(0, this.maxBudget - totalCharsUsed),
      maxBudget: this.maxBudget
    }
  }
}
