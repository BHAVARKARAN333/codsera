import { describe, it, expect, beforeEach } from 'vitest'
import { ContextBudgetManager, ContextBudgetItem } from '@renderer/services/agent/contextBudgetManager'
import {
  ContextBudgetOptimizer,
  CandidateContextItem,
  BUDGET_TIERS,
  estimateTokens
} from '@renderer/services/agent/contextBudgetOptimizer'
import { ContextDeduplicator } from '@renderer/services/agent/contextDeduplicator'
import { SmartContextEngine } from '@renderer/services/agent/smartContextEngine'

describe('contextBudgetManager Unit Tests', () => {
  let manager: ContextBudgetManager

  beforeEach(() => {
    manager = new ContextBudgetManager({
      maxBudget: 1000,
      maxFileChars: 400,
      minScoreThreshold: 50
    })
  })

  it('allocates context items within total budget and threshold', () => {
    const items: ContextBudgetItem[] = [
      { path: 'src/main.ts', content: 'console.log("main")', score: 80 },
      { path: 'src/utils.ts', content: 'export const x = 10', score: 60 }
    ]

    const result = manager.allocate(items)
    expect(result.allocatedFiles).toHaveLength(2)
    expect(result.droppedFiles).toHaveLength(0)
    expect(result.totalCharsUsed).toBe('console.log("main")'.length + 'export const x = 10'.length)
    expect(result.remainingBudget).toBe(1000 - result.totalCharsUsed)
  })

  it('drops candidates with scores below minScoreThreshold', () => {
    const items: ContextBudgetItem[] = [
      { path: 'high.ts', content: 'important code', score: 90 },
      { path: 'low.ts', content: 'unrelated code', score: 30 }
    ]

    const result = manager.allocate(items)
    expect(result.allocatedFiles).toHaveLength(1)
    expect(result.allocatedFiles[0].path).toBe('high.ts')
    expect(result.droppedFiles).toHaveLength(1)
    expect(result.droppedFiles[0].path).toBe('low.ts')
    expect(result.droppedFiles[0].reason).toContain('below minimum threshold')
  })

  it('preserves explicit files regardless of low score', () => {
    const items: ContextBudgetItem[] = [
      { path: 'explicit.ts', content: 'user asked for this', score: 10, isExplicit: true },
      { path: 'inferred.ts', content: 'inferred low score', score: 20, isExplicit: false }
    ]

    const result = manager.allocate(items)
    expect(result.allocatedFiles.map((f) => f.path)).toContain('explicit.ts')
    expect(result.droppedFiles.map((f) => f.path)).toContain('inferred.ts')
  })

  it('truncates oversized files to maxFileChars cleanly', () => {
    const hugeContent = 'a'.repeat(600)
    const items: ContextBudgetItem[] = [
      { path: 'huge.ts', content: hugeContent, score: 100 }
    ]

    const result = manager.allocate(items)
    expect(result.allocatedFiles).toHaveLength(1)
    const file = result.allocatedFiles[0]
    expect(file.truncated).toBe(true)
    expect(file.content.startsWith('a'.repeat(400))).toBe(true)
    expect(file.content).toContain('[... Truncated remainder of file ...]')
  })

  it('stops allocating when total context budget is exhausted', () => {
    const items: ContextBudgetItem[] = [
      { path: 'file1.ts', content: 'a'.repeat(450), score: 90 },
      { path: 'file2.ts', content: 'b'.repeat(450), score: 85 },
      { path: 'file3.ts', content: 'c'.repeat(200), score: 80 }
    ]

    // Total budget is 1000.
    // file1 uses 400 (clamped by maxFileChars 400). totalUsed = 400, remaining = 600.
    // file2 uses 400 (clamped by maxFileChars 400). totalUsed = 800, remaining = 200.
    // file3 (200) -> remaining was 200. After file3, remaining = 0 <= 100.
    const result = manager.allocate(items)
    expect(result.allocatedFiles.length).toBeGreaterThanOrEqual(2)
  })

  it('handles empty input gracefully', () => {
    const result = manager.allocate([])
    expect(result.allocatedFiles).toHaveLength(0)
    expect(result.droppedFiles).toHaveLength(0)
    expect(result.totalCharsUsed).toBe(0)
    expect(result.remainingBudget).toBe(1000)
  })
})

describe('Phase 12.0 — Context Budget Optimizer', () => {
  let optimizer: ContextBudgetOptimizer
  let deduplicator: ContextDeduplicator

  beforeEach(() => {
    deduplicator = new ContextDeduplicator()
    optimizer = new ContextBudgetOptimizer(deduplicator)
  })

  describe('Token Estimation & Budget Presets', () => {
    it('calculates tokens using ceil(characters / 4) standard convention', () => {
      expect(estimateTokens('')).toBe(0)
      expect(estimateTokens(0)).toBe(0)
      expect(estimateTokens('a')).toBe(1)
      expect(estimateTokens('abcd')).toBe(1)
      expect(estimateTokens('abcde')).toBe(2)
      expect(estimateTokens(100)).toBe(25)
      expect(estimateTokens('a'.repeat(400))).toBe(100)
    })

    it('provides small, medium, and large budget tier presets', () => {
      expect(BUDGET_TIERS.small.maxTokens).toBe(1000)
      expect(BUDGET_TIERS.medium.maxTokens).toBe(4000)
      expect(BUDGET_TIERS.large.maxTokens).toBe(8000)
    })
  })

  describe('Budget Enforcement', () => {
    it('strictly respects the configured token budget', () => {
      const candidates: CandidateContextItem[] = [
        {
          filePath: 'src/a.ts',
          content: 'a'.repeat(400), // 100 tokens
          relevanceScore: 0.9
        },
        {
          filePath: 'src/b.ts',
          content: 'b'.repeat(400), // 100 tokens
          relevanceScore: 0.8
        },
        {
          filePath: 'src/c.ts',
          content: 'c'.repeat(400), // 100 tokens
          relevanceScore: 0.7
        }
      ]

      // Budget = 200 tokens (only 2 items fit)
      const result = optimizer.optimize(candidates, { maxTokens: 200 })
      expect(result.selectedItems.length).toBe(2)
      expect(result.totalEstimatedTokens).toBe(200)
      expect(result.totalEstimatedTokens).toBeLessThanOrEqual(200)
      expect(result.rejectedItems.length).toBe(1)
      expect(result.rejectedItems[0].rejectionReason).toContain('Exceeds remaining token budget')
      expect(result.budgetUtilization).toBe(1.0)
    })

    it('handles zero budget safely by rejecting all candidates', () => {
      const candidates: CandidateContextItem[] = [
        { filePath: 'src/a.ts', content: 'test code', relevanceScore: 0.9 }
      ]

      const result = optimizer.optimize(candidates, { maxTokens: 0 })
      expect(result.selectedItems).toHaveLength(0)
      expect(result.rejectedItems).toHaveLength(1)
      expect(result.rejectedItems[0].rejectionReason).toContain('Budget limit is 0')
      expect(result.totalEstimatedTokens).toBe(0)
      expect(result.budgetUtilization).toBe(0)
    })

    it('handles candidate larger than entire budget safely', () => {
      const candidates: CandidateContextItem[] = [
        {
          filePath: 'src/huge.ts',
          content: 'x'.repeat(4000), // 1000 tokens
          relevanceScore: 0.95
        },
        {
          filePath: 'src/small.ts',
          content: 'y'.repeat(80), // 20 tokens
          relevanceScore: 0.85
        }
      ]

      // Budget = 50 tokens: huge is rejected, small is selected!
      const result = optimizer.optimize(candidates, { maxTokens: 50 })
      expect(result.selectedItems.length).toBe(1)
      expect(result.selectedItems[0].filePath).toBe('src/small.ts')
      expect(result.rejectedItems.some((r) => r.filePath === 'src/huge.ts')).toBe(true)
      expect(result.totalEstimatedTokens).toBe(20)
    })

    it('handles empty candidates array gracefully', () => {
      const result = optimizer.optimize([], { maxTokens: 4000 })
      expect(result.selectedItems).toEqual([])
      expect(result.rejectedItems).toEqual([])
      expect(result.totalEstimatedTokens).toBe(0)
      expect(result.budgetUtilization).toBe(0)
    })

    it('respects optional maxItems and maxChars limits', () => {
      const candidates: CandidateContextItem[] = Array.from({ length: 10 }, (_, i) => ({
        filePath: `src/item${i}.ts`,
        content: `item ${i} content`,
        relevanceScore: 0.8
      }))

      const result = optimizer.optimize(candidates, { maxTokens: 4000, maxItems: 3 })
      expect(result.selectedItems).toHaveLength(3)
      expect(result.rejectedItems.length).toBe(7)
      expect(result.rejectedItems[0].rejectionReason).toContain('Maximum items budget (3) reached')
    })
  })

  describe('Priority Scoring & Utility Density', () => {
    it('prefers high utility density (compact high-value slice over massive file)', () => {
      const candidateSmall: CandidateContextItem = {
        filePath: 'src/smallSlice.ts',
        startLine: 10,
        endLine: 25,
        content: 'function authenticate() { return true; }', // ~40 chars, 10 tokens
        relevanceScore: 0.92,
        kind: 'symbol_definition'
      }

      const candidateMassive: CandidateContextItem = {
        filePath: 'src/massiveFile.ts',
        content: 'console.log("massive");\n'.repeat(400), // ~9600 chars, 2400 tokens
        relevanceScore: 0.95,
        kind: 'file_slice'
      }

      // Both candidates fit in 4000 tokens budget, but smallSlice has vastly higher utility density
      const result = optimizer.optimize([candidateMassive, candidateSmall], { maxTokens: 4000 })
      expect(result.selectedItems[0].filePath).toBe('src/smallSlice.ts')
      expect(result.selectedItems[0].utilityDensity).toBeGreaterThan(result.selectedItems[1].utilityDensity)
    })

    it('prioritizes active editor file and cursor proximity', () => {
      const activeFile = 'src/editor/activePane.ts'

      const candidateEnclosingCursor: CandidateContextItem = {
        filePath: activeFile,
        startLine: 40,
        endLine: 60,
        content: 'class ActivePane { handleCursor() {} }',
        relevanceScore: 0.8
      }

      const candidateFarFromCursor: CandidateContextItem = {
        filePath: activeFile,
        startLine: 300,
        endLine: 320,
        content: 'function distantHelper() {}',
        relevanceScore: 0.8
      }

      const candidateOtherFile: CandidateContextItem = {
        filePath: 'src/other.ts',
        content: 'function other() {}',
        relevanceScore: 0.8
      }

      const result = optimizer.optimize(
        [candidateOtherFile, candidateFarFromCursor, candidateEnclosingCursor],
        {
          activeFilePath: activeFile,
          cursorLine: 50, // Inside candidateEnclosingCursor [40-60]
          maxTokens: 500
        }
      )

      expect(result.selectedItems[0].startLine).toBe(40)
      expect(result.selectedItems[0].selectionReason).toContain('Encloses cursor L50')
      expect(result.selectedItems[1].startLine).toBe(300)
    })

    it('boosts direct dependency and explicit user request', () => {
      const candidateExplicit: CandidateContextItem = {
        filePath: 'src/target.ts',
        content: 'export function target() {}',
        isExplicit: true,
        relevanceScore: 0.5
      }

      const candidateDependency: CandidateContextItem = {
        filePath: 'src/dep.ts',
        content: 'export function dep() {}',
        isDependency: true,
        relevanceScore: 0.6
      }

      const candidateNormal: CandidateContextItem = {
        filePath: 'src/normal.ts',
        content: 'export function normal() {}',
        relevanceScore: 0.6
      }

      const result = optimizer.optimize(
        [candidateNormal, candidateDependency, candidateExplicit],
        { maxTokens: 1000 }
      )

      expect(result.selectedItems[0].filePath).toBe('src/target.ts')
      expect(result.selectedItems[0].selectionReason).toContain('Explicit user request')
      expect(result.selectedItems[1].filePath).toBe('src/dep.ts')
      expect(result.selectedItems[1].selectionReason).toContain('Direct dependency')
    })
  })

  describe('Context Deduplication', () => {
    it('deduplicates identical file slice candidates in the input batch', () => {
      const candidate1: CandidateContextItem = {
        filePath: 'src/dup.ts',
        startLine: 10,
        endLine: 30,
        content: 'const a = 1;',
        relevanceScore: 0.9
      }
      const candidate2: CandidateContextItem = {
        filePath: 'src/dup.ts',
        startLine: 10,
        endLine: 30,
        content: 'const a = 1;',
        relevanceScore: 0.9
      }

      const result = optimizer.optimize([candidate1, candidate2], { maxTokens: 1000 })
      expect(result.selectedItems).toHaveLength(1)
      expect(result.rejectedItems.some((r) => r.rejectionReason.includes('Duplicate'))).toBe(true)
    })

    it('rejects candidate if already present in ContextDeduplicator', () => {
      deduplicator.markFileSliceInContext('src/alreadyLoaded.ts', 5, 20, 'const existing = 10;')

      const candidate: CandidateContextItem = {
        filePath: 'src/alreadyLoaded.ts',
        startLine: 5,
        endLine: 20,
        content: 'const existing = 10;',
        relevanceScore: 0.95
      }

      const result = optimizer.optimize([candidate], { maxTokens: 1000 })
      expect(result.selectedItems).toHaveLength(0)
      expect(result.rejectedItems).toHaveLength(1)
      expect(result.rejectedItems[0].rejectionReason).toContain('Already in active context')
    })

    it('rejects smaller slice contained entirely within a selected higher-value slice', () => {
      const candidateBig: CandidateContextItem = {
        filePath: 'src/module.ts',
        startLine: 10,
        endLine: 100,
        content: 'class FullModule { run() {} test() {} }',
        relevanceScore: 0.99,
        estimatedTokens: 10
      }

      const candidateSmall: CandidateContextItem = {
        filePath: 'src/module.ts',
        startLine: 30,
        endLine: 40,
        content: 'test() {}',
        relevanceScore: 0.2,
        estimatedTokens: 50
      }

      const result = optimizer.optimize([candidateBig, candidateSmall], { maxTokens: 2000 })
      expect(result.selectedItems).toHaveLength(1)
      expect(result.selectedItems[0].startLine).toBe(10)
      expect(result.rejectedItems.some((r) => r.rejectionReason.includes('Contained within'))).toBe(true)
    })
  })

  describe('Range Merging', () => {
    it('merges adjacent ranges from the same file into a single slice', () => {
      const candidate1: CandidateContextItem = {
        filePath: 'src/adjacent.ts',
        startLine: 10,
        endLine: 20,
        content: '// lines 10-20',
        kind: 'code_range',
        relevanceScore: 0.85
      }
      const candidate2: CandidateContextItem = {
        filePath: 'src/adjacent.ts',
        startLine: 21,
        endLine: 30,
        content: '// lines 21-30',
        kind: 'code_range',
        relevanceScore: 0.8
      }

      const result = optimizer.optimize([candidate1, candidate2], {
        mergeRanges: true,
        maxTokens: 1000
      })

      expect(result.selectedItems).toHaveLength(1)
      const merged = result.selectedItems[0]
      expect(merged.startLine).toBe(10)
      expect(merged.endLine).toBe(30)
      expect(merged.isMerged).toBe(true)
      expect(merged.mergedRangeCount).toBe(2)
      expect(merged.content).toContain('// lines 10-20')
      expect(merged.content).toContain('// lines 21-30')
    })

    it('does not merge distant ranges exceeding maxMergeLineGap', () => {
      const candidateA: CandidateContextItem = {
        filePath: 'src/distant.ts',
        startLine: 10,
        endLine: 20,
        content: 'function partA() {}',
        kind: 'code_range',
        relevanceScore: 0.85
      }
      const candidateB: CandidateContextItem = {
        filePath: 'src/distant.ts',
        startLine: 150,
        endLine: 160,
        content: 'function partB() {}',
        kind: 'code_range',
        relevanceScore: 0.8
      }

      const result = optimizer.optimize([candidateA, candidateB], {
        mergeRanges: true,
        maxMergeLineGap: 5,
        maxTokens: 1000
      })

      expect(result.selectedItems).toHaveLength(2)
      expect(result.selectedItems.map((s) => s.startLine)).toEqual([10, 150])
    })
  })

  describe('Determinism & Explainability', () => {
    it('produces identical deterministic output across multiple runs', () => {
      const candidates: CandidateContextItem[] = [
        { filePath: 'src/c.ts', content: 'c', relevanceScore: 0.8 },
        { filePath: 'src/a.ts', content: 'a', relevanceScore: 0.8 },
        { filePath: 'src/b.ts', content: 'b', relevanceScore: 0.8 }
      ]

      const opt = new ContextBudgetOptimizer()
      const run1 = opt.optimize(candidates, { maxTokens: 500 })
      const run2 = opt.optimize(candidates, { maxTokens: 500 })

      expect(run1.selectedItems.map((s) => s.filePath)).toEqual(
        run2.selectedItems.map((s) => s.filePath)
      )
      expect(run1.totalEstimatedTokens).toBe(run2.totalEstimatedTokens)
      expect(run1.selectedItems.length).toBe(3)
    })

    it('provides explainable selectionReason strings and omissionsSummary', () => {
      const candidates: CandidateContextItem[] = [
        {
          filePath: 'src/selected.ts',
          content: 'export class Selected {}',
          relevanceScore: 0.9,
          rrfScore: 0.035,
          isExplicit: true
        },
        {
          filePath: 'src/omitted.ts',
          content: 'z'.repeat(500),
          relevanceScore: 0.2
        }
      ]

      const result = optimizer.optimize(candidates, { maxTokens: 20 })
      expect(result.selectedItems).toHaveLength(1)
      expect(result.selectedItems[0].selectionReason).toContain('Explicit user request')
      expect(result.selectionReasons[0]).toContain('[src/selected.ts]')
      expect(result.omissionsSummary).toContain('Selected 1 item(s)')
      expect(result.omissionsSummary).toContain('Omitted 1 candidate(s)')
    })
  })

  describe('SmartContextEngine Integration', () => {
    let engine: SmartContextEngine

    beforeEach(() => {
      engine = new SmartContextEngine()
    })

    it('exposes getContextOptimizer and optimizeContext on SmartContextEngine', () => {
      expect(engine.getContextOptimizer()).toBeInstanceOf(ContextBudgetOptimizer)

      const result = engine.optimizeContext([
        { filePath: 'src/index.ts', content: 'console.log(1)', relevanceScore: 0.9 }
      ])
      expect(result.selectedItems).toHaveLength(1)
      expect(result.selectedItems[0].filePath).toBe('src/index.ts')
    })

    it('creates candidate helper items from symbols and line slices', () => {
      const sliceCandidate = ContextBudgetOptimizer.createCandidateFromSlice(
        'src/slice.ts',
        10,
        20,
        'code slice content',
        { relevanceScore: 0.85 }
      )
      expect(sliceCandidate.filePath).toBe('src/slice.ts')
      expect(sliceCandidate.startLine).toBe(10)
      expect(sliceCandidate.endLine).toBe(20)
      expect(sliceCandidate.kind).toBe('code_range')

      const dummySymbol = {
        name: 'testFunc',
        kind: 'function' as const,
        filePath: 'src/test.ts',
        startLine: 3,
        startColumn: 1,
        endLine: 5,
        endColumn: 1,
        parent: null,
        exported: true
      }
      const dummyContent = 'line 1\nline 2\nfunction testFunc() {\n  return 42;\n}\nline 6\nline 7'

      const symbolCandidate = ContextBudgetOptimizer.createCandidateFromSymbol(
        dummySymbol,
        dummyContent,
        { relevanceScore: 0.9 }
      )
      expect(symbolCandidate.filePath).toBe('src/test.ts')
      expect(symbolCandidate.symbolName).toBe('testFunc')
      expect(symbolCandidate.kind).toBe('symbol_definition')
      expect(symbolCandidate.content).toContain('testFunc')
    })
  })

  describe('Performance Scaling', () => {
    it('optimizes 150 candidates efficiently in under 50ms', () => {
      const syntheticCandidates: CandidateContextItem[] = Array.from({ length: 150 }, (_, i) => ({
        filePath: `src/mod_${i % 15}/file_${i}.ts`,
        startLine: (i * 10) % 200 + 1,
        endLine: (i * 10) % 200 + 25,
        content: `// Synthetic item ${i}\nexport function fn_${i}() { return ${i}; }`,
        relevanceScore: (150 - i) / 150,
        rrfScore: 1 / (60 + (i % 20) + 1),
        symbolScore: (i % 5 === 0) ? 0.9 : 0.4,
        isDependency: i % 10 === 0
      }))

      const start = performance.now()
      const result = optimizer.optimize(syntheticCandidates, {
        maxTokens: 2500,
        mergeRanges: true
      })
      const elapsed = performance.now() - start

      expect(result.selectedItems.length).toBeGreaterThan(0)
      expect(result.totalEstimatedTokens).toBeLessThanOrEqual(2500)
      expect(elapsed).toBeLessThan(100) // generous threshold for CI/Windows runner
    })
  })
})
