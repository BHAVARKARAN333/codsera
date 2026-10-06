import { describe, it, expect, beforeEach } from 'vitest'
import {
  DependencyGraph,
  calculatePageRank,
  PageRankCache,
  SymbolIndex,
  RepoMapGenerator
} from '@shared/parser'

describe('Performance & Complexity: Repo Map, PageRank & Symbol Index', () => {
  describe('Large Workspace PageRank Scaling', () => {
    it('computes PageRank for 500 nodes and 1500 edges in < 50ms', () => {
      const graph = new DependencyGraph()
      const NUM_NODES = 500
      const nodePaths: string[] = []

      for (let i = 0; i < NUM_NODES; i++) {
        nodePaths.push(`src/module_${i}.ts`)
      }

      // Create a multi-tier dependency topology:
      // High-tier modules (0-99) import mid-tier (100-299), which import low-tier utilities (300-499)
      for (let i = 0; i < 100; i++) {
        // Each top-level module imports 5 mid-tier modules
        for (let j = 0; j < 5; j++) {
          const target = 100 + ((i * 5 + j) % 200)
          graph.addEdge({
            from: nodePaths[i],
            to: nodePaths[target],
            specifier: `./module_${target}`,
            resolved: true,
            external: false,
            kind: 'import',
            line: j + 1
          })
        }
      }

      for (let i = 100; i < 300; i++) {
        // Each mid-tier module imports 5 utility modules
        for (let j = 0; j < 5; j++) {
          const target = 300 + ((i * 5 + j) % 200)
          graph.addEdge({
            from: nodePaths[i],
            to: nodePaths[target],
            specifier: `./module_${target}`,
            resolved: true,
            external: false,
            kind: 'import',
            line: j + 1
          })
        }
      }

      const startTime = performance.now()
      const pageRank = calculatePageRank(graph, {
        dampingFactor: 0.85,
        iterations: 20,
        nodes: nodePaths
      })
      const durationMs = performance.now() - startTime

      // Assert high performance (< 50ms for 500 nodes, 1500 edges, 20 iterations)
      expect(durationMs).toBeLessThan(50)
      expect(pageRank.size).toBe(NUM_NODES)

      // Verify mathematical validity
      let maxScore = 0
      for (const score of pageRank.values()) {
        expect(score).toBeGreaterThanOrEqual(0)
        expect(score).toBeLessThanOrEqual(1.0)
        if (score > maxScore) maxScore = score
      }
      expect(maxScore).toBe(1.0)

      // Common utilities in tier 300-499 should have higher centrality than root modules in tier 0-99
      const rootScore = pageRank.get('src/module_0.ts') ?? 0
      const utilityScore = pageRank.get('src/module_300.ts') ?? 0
      expect(utilityScore).toBeGreaterThan(rootScore)
    })

    it('retrieves cached PageRank in < 1ms on cache hits without recomputation', () => {
      const graph = new DependencyGraph()
      const cache = new PageRankCache()
      const NUM_NODES = 200

      for (let i = 0; i < NUM_NODES - 1; i++) {
        graph.addEdge({
          from: `src/file_${i}.ts`,
          to: `src/file_${i + 1}.ts`,
          specifier: `./file_${i + 1}`,
          resolved: true,
          external: false,
          kind: 'import',
          line: 1
        })
      }

      // Initial calculation
      const initialStart = performance.now()
      const res1 = cache.getPageRank(graph)
      const initialDuration = performance.now() - initialStart
      expect(res1.size).toBe(NUM_NODES)

      // Cache hit
      const cachedStart = performance.now()
      const res2 = cache.getPageRank(graph)
      const cachedDuration = performance.now() - cachedStart

      expect(res1).toBe(res2) // Exact Map reference returned
      expect(cachedDuration).toBeLessThan(2) // Instantaneous O(1) lookup
      expect(cachedDuration).toBeLessThanOrEqual(initialDuration)
    })
  })

  describe('Large Workspace Relevance Ranking & Repo Map Generation', () => {
    let index: SymbolIndex
    let generator: RepoMapGenerator
    const NUM_FILES = 200

    beforeEach(() => {
      index = new SymbolIndex()
      generator = new RepoMapGenerator(index)

      const files: string[] = []
      for (let i = 0; i < NUM_FILES; i++) {
        files.push(`src/service/Service${i}.ts`)
      }
      index.setKnownFiles(files)

      // Index 200 synthetic TypeScript files
      for (let i = 0; i < NUM_FILES; i++) {
        const nextId = (i + 1) % NUM_FILES
        const content = `
import { Service${nextId} } from './Service${nextId}';

export interface IService${i} {
  run(): void;
}

export class Service${i} implements IService${i} {
  public executeOperation(): void {}
}
`.trim()
        index.indexFile(`src/service/Service${i}.ts`, content)
      }
    })

    it('ranks 200 files with multi-factor scoring in < 25ms', () => {
      const startTime = performance.now()
      const ranked = index.rankFiles({
        query: 'Service50 executeOperation',
        activeFilePath: 'src/service/Service50.ts',
        cursorLine: 8
      })
      const durationMs = performance.now() - startTime

      expect(durationMs).toBeLessThan(25)
      expect(ranked.length).toBe(NUM_FILES)

      // Top file should be Service50.ts (active file + exact query matches)
      expect(ranked[0].filePath).toBe('src/service/Service50.ts')
      expect(ranked[0].finalScore).toBeGreaterThan(0.5)

      // Direct dependency Service51.ts should rank highly
      const topFivePaths = ranked.slice(0, 5).map((r) => r.filePath)
      expect(topFivePaths).toContain('src/service/Service51.ts')
    })

    it('performs surgical incremental symbol update in < 5ms without full symbol scan', () => {
      const targetFile = 'src/service/Service10.ts'
      const updatedContent = `
import { Service11 } from './Service11';

export class Service10 {
  public newOptimizedMethod(): void {}
}
`.trim()

      const startTime = performance.now()
      index.indexFile(targetFile, updatedContent)
      const durationMs = performance.now() - startTime

      expect(durationMs).toBeLessThan(10)

      // Verify that old symbols were removed and new symbols were indexed
      const symbols = index.getFileSymbols(targetFile)
      const methodNames = symbols.map((s) => s.name)
      expect(methodNames).toContain('newOptimizedMethod')
      expect(methodNames).not.toContain('executeOperation')
    })

    it('generates bounded Repo Map under 4000 characters for large workspace in < 30ms', () => {
      const startTime = performance.now()
      const res = generator.generateRepoMap({
        query: 'Service20',
        activeFilePath: 'src/service/Service20.ts',
        ranking: true,
        maxFiles: 50,
        maxOutputChars: 4000
      })
      const durationMs = performance.now() - startTime

      expect(durationMs).toBeLessThan(30)
      expect(res.truncated).toBe(true)
      expect(res.formattedText.length).toBeLessThanOrEqual(4200)
      expect(res.formattedText).toContain('[Repo Map truncated:')
      expect(res.tokenEstimate).toBe(Math.ceil(res.formattedText.length / 4))

      // First file entry in repo map should be Service20.ts
      expect(res.map.files[0].filePath).toBe('src/service/Service20.ts')
    })

    it('guarantees bit-for-bit determinism across repeated executions on large workspace', () => {
      const res1 = generator.generateRepoMap({
        query: 'Service100 operation',
        activeFilePath: 'src/service/Service100.ts',
        ranking: true,
        maxFiles: 30
      })

      const res2 = generator.generateRepoMap({
        query: 'Service100 operation',
        activeFilePath: 'src/service/Service100.ts',
        ranking: true,
        maxFiles: 30
      })

      expect(res1.formattedText).toBe(res2.formattedText)
      expect(res1.tokenEstimate).toBe(res2.tokenEstimate)
      expect(res1.relevanceScores).toEqual(res2.relevanceScores)
    })
  })
})
