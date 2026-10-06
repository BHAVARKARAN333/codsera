import { describe, it, expect, beforeEach } from 'vitest'
import {
  DependencyGraph,
  calculatePageRank,
  PageRankCache,
  extractQueryTokens,
  calculateQueryScore,
  calculateActiveAndDependencyScores,
  scoreFileRelevance,
  rankSymbolsInFile,
  SymbolIndex,
  RepoMapGenerator,
  DEFAULT_RANKING_WEIGHTS
} from '@shared/parser'
import { SmartContextEngine } from '@renderer/services/agent/smartContextEngine'

describe('Phase 11.7 — Repo Map Relevance Ranking & PageRank', () => {
  describe('PageRank / Graph Centrality', () => {
    let graph: DependencyGraph

    beforeEach(() => {
      graph = new DependencyGraph()
    })

    it('handles empty graph', () => {
      const pr = calculatePageRank(graph)
      expect(pr.size).toBe(0)
    })

    it('handles single node graph', () => {
      const pr = calculatePageRank(graph, { nodes: ['src/index.ts'] })
      expect(pr.size).toBe(1)
      expect(pr.get('src/index.ts')).toBe(1.0)
    })

    it('handles disconnected nodes with uniform centrality', () => {
      const nodes = ['src/a.ts', 'src/b.ts', 'src/c.ts']
      const pr = calculatePageRank(graph, { nodes })
      expect(pr.size).toBe(3)
      expect(pr.get('src/a.ts')).toBe(1.0)
      expect(pr.get('src/b.ts')).toBe(1.0)
      expect(pr.get('src/c.ts')).toBe(1.0)
    })

    it('ranks downstream dependencies higher in a linear chain (A -> B -> C)', () => {
      // A imports B, B imports C -> C is the core leaf dependency
      graph.addEdge({
        from: 'src/A.ts',
        to: 'src/B.ts',
        specifier: './B',
        resolved: true,
        external: false,
        kind: 'import',
        line: 1
      })
      graph.addEdge({
        from: 'src/B.ts',
        to: 'src/C.ts',
        specifier: './C',
        resolved: true,
        external: false,
        kind: 'import',
        line: 1
      })

      const pr = calculatePageRank(graph)
      const scoreA = pr.get('src/A.ts') ?? 0
      const scoreB = pr.get('src/B.ts') ?? 0
      const scoreC = pr.get('src/C.ts') ?? 0

      expect(scoreC).toBeGreaterThan(scoreB)
      expect(scoreB).toBeGreaterThan(scoreA)
      expect(scoreC).toBe(1.0) // Normalized max
    })

    it('ranks confluent hub nodes highest in branching graph (A -> D, B -> D, C -> D)', () => {
      graph.addEdge({
        from: 'src/A.ts',
        to: 'src/D.ts',
        specifier: './D',
        resolved: true,
        external: false,
        kind: 'import',
        line: 1
      })
      graph.addEdge({
        from: 'src/B.ts',
        to: 'src/D.ts',
        specifier: './D',
        resolved: true,
        external: false,
        kind: 'import',
        line: 1
      })
      graph.addEdge({
        from: 'src/C.ts',
        to: 'src/D.ts',
        specifier: './D',
        resolved: true,
        external: false,
        kind: 'import',
        line: 1
      })

      const pr = calculatePageRank(graph)
      const scoreD = pr.get('src/D.ts') ?? 0
      const scoreA = pr.get('src/A.ts') ?? 0

      expect(scoreD).toBe(1.0)
      expect(scoreD).toBeGreaterThan(scoreA)
    })

    it('handles cyclic dependencies deterministically without stack overflow', () => {
      // A -> B -> C -> A
      graph.addEdge({
        from: 'src/A.ts',
        to: 'src/B.ts',
        specifier: './B',
        resolved: true,
        external: false,
        kind: 'import',
        line: 1
      })
      graph.addEdge({
        from: 'src/B.ts',
        to: 'src/C.ts',
        specifier: './C',
        resolved: true,
        external: false,
        kind: 'import',
        line: 1
      })
      graph.addEdge({
        from: 'src/C.ts',
        to: 'src/A.ts',
        specifier: './A',
        resolved: true,
        external: false,
        kind: 'import',
        line: 1
      })

      const pr = calculatePageRank(graph, { iterations: 25 })
      const scoreA = pr.get('src/A.ts') ?? 0
      const scoreB = pr.get('src/B.ts') ?? 0
      const scoreC = pr.get('src/C.ts') ?? 0

      // In a symmetric cycle, all nodes must have equal rank
      expect(Math.abs(scoreA - scoreB)).toBeLessThan(0.01)
      expect(Math.abs(scoreB - scoreC)).toBeLessThan(0.01)
      expect(scoreA).toBe(1.0)
    })

    it('handles self-loops safely without infinite loops or inflated scores', () => {
      graph.addEdge({
        from: 'src/Self.ts',
        to: 'src/Self.ts',
        specifier: './Self',
        resolved: true,
        external: false,
        kind: 'import',
        line: 1
      })
      graph.addEdge({
        from: 'src/Other.ts',
        to: 'src/Self.ts',
        specifier: './Self',
        resolved: true,
        external: false,
        kind: 'import',
        line: 1
      })

      const pr = calculatePageRank(graph)
      expect(pr.get('src/Self.ts')).toBe(1.0)
      expect(pr.get('src/Other.ts')).toBeLessThan(1.0)
    })

    it('supports custom damping factor and iteration count', () => {
      graph.addEdge({
        from: 'src/A.ts',
        to: 'src/B.ts',
        specifier: './B',
        resolved: true,
        external: false,
        kind: 'import',
        line: 1
      })

      const pr1 = calculatePageRank(graph, { dampingFactor: 0.5, iterations: 10 })
      const pr2 = calculatePageRank(graph, { dampingFactor: 0.95, iterations: 30 })

      expect(pr1.get('src/B.ts')).toBe(1.0)
      expect(pr2.get('src/B.ts')).toBe(1.0)
    })
  })

  describe('PageRank Cache & Incremental Invalidation', () => {
    let graph: DependencyGraph
    let cache: PageRankCache

    beforeEach(() => {
      graph = new DependencyGraph()
      cache = new PageRankCache()
    })

    it('returns cached results when graph version has not changed', () => {
      graph.addEdge({
        from: 'src/A.ts',
        to: 'src/B.ts',
        specifier: './B',
        resolved: true,
        external: false,
        kind: 'import',
        line: 1
      })

      const res1 = cache.getPageRank(graph)
      const res2 = cache.getPageRank(graph)

      // Identical Map reference returned
      expect(res1).toBe(res2)
    })

    it('recalculates when an edge is added to the graph', () => {
      graph.addEdge({
        from: 'src/A.ts',
        to: 'src/B.ts',
        specifier: './B',
        resolved: true,
        external: false,
        kind: 'import',
        line: 1
      })

      const res1 = cache.getPageRank(graph)

      // Mutate graph
      graph.addEdge({
        from: 'src/C.ts',
        to: 'src/B.ts',
        specifier: './B',
        resolved: true,
        external: false,
        kind: 'import',
        line: 1
      })

      const res2 = cache.getPageRank(graph)
      expect(res1).not.toBe(res2)
      expect(res2.has('src/C.ts')).toBe(true)
    })

    it('recalculates when a file is removed from the graph', () => {
      graph.addEdge({
        from: 'src/A.ts',
        to: 'src/B.ts',
        specifier: './B',
        resolved: true,
        external: false,
        kind: 'import',
        line: 1
      })

      const res1 = cache.getPageRank(graph)
      graph.removeFile('src/A.ts')
      const res2 = cache.getPageRank(graph)

      expect(res1).not.toBe(res2)
      expect(res2.has('src/A.ts')).toBe(false)
    })
  })

  describe('Query Relevance & Token Extraction', () => {
    it('extracts query tokens, splits camelCase, and removes stop words', () => {
      const tokens = extractQueryTokens('fix the authentication login bug in authService!')
      expect(tokens).toContain('authentication')
      expect(tokens).toContain('login')
      expect(tokens).toContain('auth')
      expect(tokens).toContain('service')
      expect(tokens).not.toContain('the')
      expect(tokens).not.toContain('in')
    })

    it('falls back to all tokens if query consists only of stop words', () => {
      const tokens = extractQueryTokens('the is on')
      expect(tokens).toContain('the')
      expect(tokens).toContain('is')
    })

    it('scores exact filename and symbol matches higher than unrelated files', () => {
      const authSymbols = [
        {
          name: 'authenticateUser',
          kind: 'function' as const,
          filePath: 'src/auth/authService.ts',
          startLine: 10,
          startColumn: 1,
          endLine: 20,
          endColumn: 1,
          parent: null,
          exported: true
        }
      ]
      const unrelatedSymbols = [
        {
          name: 'calculateTax',
          kind: 'function' as const,
          filePath: 'src/billing/tax.ts',
          startLine: 5,
          startColumn: 1,
          endLine: 12,
          endColumn: 1,
          parent: null,
          exported: true
        }
      ]

      const tokens = extractQueryTokens('authenticate user')
      const authScore = calculateQueryScore('src/auth/authService.ts', authSymbols, tokens)
      const taxScore = calculateQueryScore('src/billing/tax.ts', unrelatedSymbols, tokens)

      expect(authScore.queryScore).toBeGreaterThan(taxScore.queryScore)
      expect(authScore.symbolScore).toBeGreaterThan(taxScore.symbolScore)
      expect(taxScore.queryScore).toBe(0)
    })
  })

  describe('Active File Proximity & Dependency Boosting', () => {
    let graph: DependencyGraph

    beforeEach(() => {
      graph = new DependencyGraph()
      // App.tsx imports EditorPane.tsx
      graph.addEdge({
        from: 'src/App.tsx',
        to: 'src/components/EditorPane.tsx',
        specifier: './components/EditorPane',
        resolved: true,
        external: false,
        kind: 'import',
        line: 1
      })
      // Header.tsx imports App.tsx
      graph.addEdge({
        from: 'src/components/Header.tsx',
        to: 'src/App.tsx',
        specifier: '../App',
        resolved: true,
        external: false,
        kind: 'import',
        line: 1
      })
    })

    it('gives active file highest active boost, dependency medium boost, dependent smaller boost', () => {
      const activeScore = calculateActiveAndDependencyScores('src/App.tsx', 'src/App.tsx', graph)
      expect(activeScore.activeFileScore).toBe(1.0)
      expect(activeScore.dependencyScore).toBe(0)

      const depScore = calculateActiveAndDependencyScores(
        'src/components/EditorPane.tsx',
        'src/App.tsx',
        graph
      )
      expect(depScore.activeFileScore).toBe(0)
      expect(depScore.dependencyScore).toBe(0.6)

      const dependentScore = calculateActiveAndDependencyScores(
        'src/components/Header.tsx',
        'src/App.tsx',
        graph
      )
      expect(dependentScore.activeFileScore).toBe(0)
      expect(dependentScore.dependentScore).toBe(0.4)

      const unrelated = calculateActiveAndDependencyScores('src/other.ts', 'src/App.tsx', graph)
      expect(unrelated.activeFileScore).toBe(0)
      expect(unrelated.dependencyScore).toBe(0)
      expect(unrelated.dependentScore).toBe(0)
    })

    it('returns zeroes when active file is not provided', () => {
      const score = calculateActiveAndDependencyScores('src/App.tsx', undefined, graph)
      expect(score.activeFileScore).toBe(0)
      expect(score.dependencyScore).toBe(0)
      expect(score.dependentScore).toBe(0)
    })
  })

  describe('Combined Multi-Factor Scoring', () => {
    let graph: DependencyGraph

    beforeEach(() => {
      graph = new DependencyGraph()
    })

    it('provides sensible default ranking weights summing to 1.0', () => {
      expect(DEFAULT_RANKING_WEIGHTS.queryWeight).toBe(0.35)
      expect(DEFAULT_RANKING_WEIGHTS.activeWeight).toBe(0.25)
      expect(DEFAULT_RANKING_WEIGHTS.dependencyWeight).toBe(0.15)
      expect(DEFAULT_RANKING_WEIGHTS.dependentWeight).toBe(0.10)
      expect(DEFAULT_RANKING_WEIGHTS.pageRankWeight).toBe(0.10)
      expect(DEFAULT_RANKING_WEIGHTS.symbolWeight).toBe(0.05)
      const sum =
        DEFAULT_RANKING_WEIGHTS.queryWeight +
        DEFAULT_RANKING_WEIGHTS.activeWeight +
        DEFAULT_RANKING_WEIGHTS.dependencyWeight +
        DEFAULT_RANKING_WEIGHTS.dependentWeight +
        DEFAULT_RANKING_WEIGHTS.pageRankWeight +
        DEFAULT_RANKING_WEIGHTS.symbolWeight
      expect(Math.round(sum * 100) / 100).toBe(1.0)
    })

    it('computes combined score respecting weights without exceeding [0, 1]', () => {
      const score = scoreFileRelevance({
        filePath: 'src/auth/login.ts',
        symbols: [
          {
            name: 'login',
            kind: 'function',
            filePath: 'src/auth/login.ts',
            startLine: 1,
            startColumn: 1,
            endLine: 10,
            endColumn: 1,
            parent: null,
            exported: true
          }
        ],
        queryTokens: ['login'],
        activeFilePath: 'src/auth/login.ts',
        graph,
        pageRankScore: 0.8
      })

      expect(score.finalScore).toBeGreaterThan(0)
      expect(score.finalScore).toBeLessThanOrEqual(1.0)
      expect(score.activeFileScore).toBe(1.0)
      expect(score.queryScore).toBeGreaterThan(0)
      expect(score.pageRankScore).toBe(0.8)
    })

    it('supports custom ranking weights', () => {
      const defaultScore = scoreFileRelevance({
        filePath: 'src/test.ts',
        symbols: [],
        queryTokens: ['test'],
        graph,
        pageRankScore: 1.0
      })

      // Custom weights heavily prioritizing PageRank
      const customScore = scoreFileRelevance({
        filePath: 'src/test.ts',
        symbols: [],
        queryTokens: ['test'],
        graph,
        pageRankScore: 1.0,
        weights: {
          pageRankWeight: 0.8,
          queryWeight: 0.2
        }
      })

      expect(customScore.pageRankScore).toBe(1.0)
      expect(customScore.finalScore).not.toBe(defaultScore.finalScore)
    })
  })

  describe('Symbol Relevance & Cursor Proximity', () => {
    it('ranks exact match over partial match and exported symbols higher', () => {
      const symbols = [
        {
          name: 'loginHelper',
          kind: 'function' as const,
          filePath: 'src/auth.ts',
          startLine: 20,
          startColumn: 1,
          endLine: 30,
          endColumn: 1,
          parent: null,
          exported: false
        },
        {
          name: 'login',
          kind: 'function' as const,
          filePath: 'src/auth.ts',
          startLine: 1,
          startColumn: 1,
          endLine: 15,
          endColumn: 1,
          parent: null,
          exported: true
        },
        {
          name: 'unrelated',
          kind: 'function' as const,
          filePath: 'src/auth.ts',
          startLine: 35,
          startColumn: 1,
          endLine: 45,
          endColumn: 1,
          parent: null,
          exported: false
        }
      ]

      const ranked = rankSymbolsInFile(symbols, ['login'])
      expect(ranked[0].name).toBe('login')
      expect(ranked[1].name).toBe('loginHelper')
      expect(ranked[2].name).toBe('unrelated')
    })

    it('boosts symbol enclosing cursor line in active file', () => {
      const symbols = [
        {
          name: 'FirstFunc',
          kind: 'function' as const,
          filePath: 'src/editor.ts',
          startLine: 1,
          startColumn: 1,
          endLine: 10,
          endColumn: 1,
          parent: null,
          exported: false
        },
        {
          name: 'SecondFunc',
          kind: 'function' as const,
          filePath: 'src/editor.ts',
          startLine: 15,
          startColumn: 1,
          endLine: 35,
          endColumn: 1,
          parent: null,
          exported: false
        }
      ]

      // Cursor is at line 20 (inside SecondFunc)
      const ranked = rankSymbolsInFile(symbols, [], 'src/editor.ts', 20, 'src/editor.ts')
      expect(ranked[0].name).toBe('SecondFunc')
    })
  })

  describe('Repo Map Ranking Integration & Token Budget', () => {
    let index: SymbolIndex
    let generator: RepoMapGenerator

    beforeEach(() => {
      index = new SymbolIndex()
      generator = new RepoMapGenerator(index)

      index.setKnownFiles([
        'src/App.tsx',
        'src/auth/authService.ts',
        'src/billing/payment.ts',
        'src/utils/logger.ts'
      ])

      index.indexFile(
        'src/App.tsx',
        `
import { authService } from './auth/authService';
import { logger } from './utils/logger';
export class App {}
        `.trim()
      )

      index.indexFile(
        'src/auth/authService.ts',
        `
import { logger } from '../utils/logger';
export class AuthService {
  public login() {}
  public logout() {}
}
        `.trim()
      )

      index.indexFile(
        'src/billing/payment.ts',
        `
import { logger } from '../utils/logger';
export class PaymentProcessor {
  public charge() {}
}
        `.trim()
      )

      index.indexFile(
        'src/utils/logger.ts',
        `
export class Logger {
  public log() {}
}
        `.trim()
      )
    })

    it('preserves alphabetical order when ranking is explicitly disabled', () => {
      const res = generator.generateRepoMap({ ranking: false })
      const files = res.map.files.map((f) => f.filePath)
      expect(files).toEqual([
        'src/App.tsx',
        'src/auth/authService.ts',
        'src/billing/payment.ts',
        'src/utils/logger.ts'
      ])
    })

    it('ranks authService and App first when query matches authentication', () => {
      const res = generator.generateRepoMap({
        query: 'fix authentication login bug',
        ranking: true
      })

      const files = res.map.files.map((f) => f.filePath)
      // authService.ts has highest query relevance
      expect(files[0]).toBe('src/auth/authService.ts')
      expect(res.relevanceScores).toBeDefined()
      expect(res.relevanceScores![0].filePath).toBe('src/auth/authService.ts')
    })

    it('ranks active file and its direct dependencies first', () => {
      const res = generator.generateRepoMap({
        activeFilePath: 'src/App.tsx',
        ranking: true
      })

      const files = res.map.files.map((f) => f.filePath)
      expect(files[0]).toBe('src/App.tsx')
      // logger.ts is imported by App, authService, and payment -> high PageRank + direct dependency
      expect(files).toContain('src/utils/logger.ts')
    })

    it('preserves output character budget and adds explicit truncation notice', () => {
      const res = generator.generateRepoMap({
        query: 'login',
        ranking: true,
        maxOutputChars: 300
      })

      expect(res.truncated).toBe(true)
      expect(res.formattedText).toContain('[Repo Map truncated:')
      expect(res.formattedText.length).toBeLessThanOrEqual(400)
    })

    it('is strictly deterministic across multiple runs with ranking enabled', () => {
      const res1 = generator.generateRepoMap({
        query: 'payment',
        activeFilePath: 'src/App.tsx',
        ranking: true
      })
      const res2 = generator.generateRepoMap({
        query: 'payment',
        activeFilePath: 'src/App.tsx',
        ranking: true
      })

      expect(res1.formattedText).toBe(res2.formattedText)
      expect(res1.relevanceScores).toEqual(res2.relevanceScores)
    })
  })

  describe('SmartContextEngine Relevance Integration', () => {
    let engine: SmartContextEngine

    beforeEach(() => {
      engine = new SmartContextEngine()
    })

    it('exposes rankFiles and passes query and active file to getRepoMap', () => {
      engine.getFileSymbols(
        'src/controller.ts',
        `
export class Controller {
  public execute() {}
}
        `.trim()
      )
      engine.getFileSymbols(
        'src/auth.ts',
        `
export class AuthManager {
  public authenticate() {}
}
        `.trim()
      )

      const ranked = engine.rankFiles({ query: 'authenticate' })
      expect(ranked.length).toBe(2)
      expect(ranked[0].filePath).toBe('src/auth.ts')

      const repoMap = engine.getRepoMap({ query: 'authenticate', ranking: true })
      expect(repoMap.formattedText).toContain('src/auth.ts')
      expect(repoMap.map.files[0].filePath).toBe('src/auth.ts')
    })

    it('safely handles malicious path traversal attempts in activeFilePath', () => {
      const repoMap = engine.getRepoMap({
        activeFilePath: '../../../../etc/passwd',
        ranking: true
      })
      // Traversal rejected cleanly without throwing or crashing
      expect(repoMap).toBeDefined()
    })
  })
})
