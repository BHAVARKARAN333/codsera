/**
 * Deterministic PageRank / Graph Centrality (Phase 11.7)
 *
 * Computes graph centrality over workspace dependency graphs using
 * power-iteration with dangling-node handling and deterministic normalization.
 * Safe for renderer and main processes (100% offline, zero native deps).
 */

import { DependencyGraph } from './dependencyGraph'
import { PageRankOptions } from './repoMapTypes'
import { computeContentHash } from './parserCache'

const DEFAULT_DAMPING_FACTOR = 0.85
const DEFAULT_ITERATIONS = 20

/**
 * Calculates deterministic PageRank scores for all workspace files in the graph.
 *
 * Directed semantics:
 * - When file A imports file B (from: A, to: B), A casts a vote for B.
 * - Files that are heavily imported (or imported by central files) receive higher centrality.
 * - Dangling nodes (files importing nothing) distribute rank evenly across all nodes.
 */
export function calculatePageRank(
  graph: DependencyGraph,
  options?: PageRankOptions
): Map<string, number> {
  const dampingFactor = options?.dampingFactor ?? DEFAULT_DAMPING_FACTOR
  const iterations = options?.iterations ?? DEFAULT_ITERATIONS

  // Determine all unique nodes (combining provided nodes and graph nodes)
  const nodeSet = new Set<string>()
  if (options?.nodes) {
    for (const n of options.nodes) {
      if (n) nodeSet.add(n)
    }
  }
  for (const n of graph.getNodes()) {
    nodeSet.add(n)
  }

  const nodes = Array.from(nodeSet).sort()
  const N = nodes.length

  // Edge cases
  if (N === 0) {
    return new Map()
  }

  if (N === 1) {
    const single = new Map<string, number>()
    single.set(nodes[0], 1.0)
    return single
  }

  // 1. Assign deterministic integer indices 0..N-1
  const nodeIndexMap = new Map<string, number>()
  for (let i = 0; i < N; i++) {
    nodeIndexMap.set(nodes[i], i)
  }

  // 2. Precompute integer adjacency arrays
  const incomingIndices: number[][] = Array.from({ length: N }, () => [])
  const outDegrees = new Int32Array(N)
  const danglingIndicesList: number[] = []

  for (let i = 0; i < N; i++) {
    const node = nodes[i]
    const deps = graph.getDependencies(node)
    const validTargetIndices = new Set<number>()

    for (const dep of deps) {
      if (dep.to && dep.to !== node) {
        const toIdx = nodeIndexMap.get(dep.to)
        if (toIdx !== undefined) {
          validTargetIndices.add(toIdx)
        }
      }
    }

    outDegrees[i] = validTargetIndices.size
    if (outDegrees[i] === 0) {
      danglingIndicesList.push(i)
    }

    for (const targetIdx of validTargetIndices) {
      incomingIndices[targetIdx].push(i)
    }
  }

  // Pre-sort incoming indices for complete determinism
  for (let i = 0; i < N; i++) {
    incomingIndices[i].sort((a, b) => a - b)
  }

  const danglingIndices = new Int32Array(danglingIndicesList)
  const numDangling = danglingIndices.length

  // 3. Double-buffered Float64Array vectors (zero garbage collection in loop)
  let currentRanks = new Float64Array(N)
  let nextRanks = new Float64Array(N)
  const initialRank = 1.0 / N
  currentRanks.fill(initialRank)

  const oneMinusDampingOverN = (1.0 - dampingFactor) / N
  const dampingOverN = dampingFactor / N

  // 4. Power iteration with zero allocations
  for (let iter = 0; iter < iterations; iter++) {
    // Sum dangling mass
    let danglingSum = 0
    for (let d = 0; d < numDangling; d++) {
      danglingSum += currentRanks[danglingIndices[d]]
    }

    const baseRank = oneMinusDampingOverN + dampingOverN * danglingSum

    // Distribute rank through incoming edges
    for (let i = 0; i < N; i++) {
      const incList = incomingIndices[i]
      const incCount = incList.length
      let incomingRankSum = 0

      for (let j = 0; j < incCount; j++) {
        const inIdx = incList[j]
        const deg = outDegrees[inIdx]
        if (deg > 0) {
          incomingRankSum += currentRanks[inIdx] / deg
        }
      }

      nextRanks[i] = baseRank + dampingFactor * incomingRankSum
    }

    // Ping-pong swap buffers
    const temp = currentRanks
    currentRanks = nextRanks
    nextRanks = temp
  }

  // 5. Normalize scores to [0, 1] relative to the maximum score for intuitive relevance weighting
  let maxScore = 0
  for (let i = 0; i < N; i++) {
    if (currentRanks[i] > maxScore) {
      maxScore = currentRanks[i]
    }
  }

  const normalizedResults = new Map<string, number>()
  if (maxScore > 0) {
    for (let i = 0; i < N; i++) {
      normalizedResults.set(
        nodes[i],
        Math.round((currentRanks[i] / maxScore) * 10000) / 10000
      )
    }
  } else {
    for (let i = 0; i < N; i++) {
      normalizedResults.set(nodes[i], 1.0)
    }
  }

  return normalizedResults
}

/**
 * Invalidation-aware cache for PageRank calculations.
 * Keyed by graph version and parameters to eliminate redundant computation.
 */
export class PageRankCache {
  private cachedVersion = -1
  private cachedKey = ''
  private cachedResult: Map<string, number> | null = null

  /**
   * Retrieves or computes PageRank for the provided graph.
   * If the graph version and options match, returns cached result.
   */
  getPageRank(graph: DependencyGraph, options?: PageRankOptions): Map<string, number> {
    const currentVersion = graph.getVersion()
    const dampingFactor = options?.dampingFactor ?? DEFAULT_DAMPING_FACTOR
    const iterations = options?.iterations ?? DEFAULT_ITERATIONS
    const nodesHash = options?.nodes ? computeContentHash(options.nodes.join(';')) : 'default'
    const cacheKey = `${currentVersion}:::${dampingFactor}:::${iterations}:::${nodesHash}`

    if (
      this.cachedResult !== null &&
      this.cachedVersion === currentVersion &&
      this.cachedKey === cacheKey
    ) {
      return this.cachedResult
    }

    const calculated = calculatePageRank(graph, options)
    this.cachedVersion = currentVersion
    this.cachedKey = cacheKey
    this.cachedResult = calculated

    return calculated
  }

  /**
   * Explicitly clears the PageRank cache.
   */
  clear(): void {
    this.cachedVersion = -1
    this.cachedKey = ''
    this.cachedResult = null
  }
}
