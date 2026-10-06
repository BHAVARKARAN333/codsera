/**
 * Multi-Factor Relevance Scorer (Phase 11.7)
 *
 * Combines query token relevance, active-file proximity, graph dependency
 * relationships, and PageRank centrality into deterministic file and symbol scores.
 */

import { ExtractedSymbol } from './types'
import {
  FileRelevanceScore,
  RankingWeights
} from './repoMapTypes'
import { DependencyGraph } from './dependencyGraph'
import { normalizeWorkspacePath } from './moduleResolver'

export const DEFAULT_RANKING_WEIGHTS: RankingWeights = {
  queryWeight: 0.35,
  activeWeight: 0.25,
  dependencyWeight: 0.15,
  dependentWeight: 0.10,
  pageRankWeight: 0.10,
  symbolWeight: 0.05
}

const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'in',
  'on',
  'at',
  'to',
  'for',
  'of',
  'with',
  'by',
  'from',
  'is',
  'are',
  'was',
  'were',
  'it',
  'this',
  'that',
  'as',
  'be',
  'do',
  'how',
  'what',
  'why',
  'can',
  'please',
  'help',
  'code',
  'file',
  'files',
  'my',
  'me',
  'i',
  'we',
  'our',
  'you',
  'your',
  'about',
  'some',
  'any',
  'all'
])

/**
 * Extracts normalized query tokens from user prompt string.
 * Splits camelCase, snake_case, and kebab-case tokens and strips common stop words.
 */
export function extractQueryTokens(query?: string): string[] {
  if (!query || typeof query !== 'string' || !query.trim()) {
    return []
  }

  // 1. Split on whitespace, punctuation, and camelCase boundaries
  const words = query
    .replace(/([a-z])([A-Z])/g, '$1 $2') // camelCase -> camel Case
    .toLowerCase()
    .split(/[\s.,;:!?'"()[\]{}|/\\<>=+\-_*&#@%^~`]+/)
    .filter((w) => w.length > 0)

  // 2. Filter out stop words unless all words are stop words
  const nonStopWords = words.filter((w) => !STOP_WORDS.has(w))
  const effectiveTokens = nonStopWords.length > 0 ? nonStopWords : words

  // 3. Deduplicate
  return Array.from(new Set(effectiveTokens))
}

/**
 * Splits text into subwords based on camelCase, snake_case, and kebab-case.
 */
function splitSubwords(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[\s_\-.]+/)
    .filter((w) => w.length > 0)
}

function hasStemOrPrefixMatch(a: string, b: string, minLen = 3): boolean {
  if (a.length < minLen || b.length < minLen) {
    return false
  }
  return a.startsWith(b) || b.startsWith(a)
}

/**
 * Scores a file's relevance to the user query based on file path, base name, and symbols.
 * Returns a normalized score in [0, 1].
 */
export function calculateQueryScore(
  filePath: string,
  symbols: ExtractedSymbol[],
  queryTokens: string[]
): { queryScore: number; symbolScore: number } {
  if (queryTokens.length === 0) {
    return { queryScore: 0, symbolScore: 0 }
  }

  const norm = filePath.replace(/\\/g, '/')
  const segments = norm.split('/')
  const fileName = segments[segments.length - 1] || ''
  const baseName = fileName.replace(/\.[^.]+$/, '')
  const lowerBase = baseName.toLowerCase()
  const baseSubwords = splitSubwords(baseName)

  let fileMatchPoints = 0
  let symbolMatchPoints = 0

  // Precompute symbol lowercase and subwords once per symbol instead of per query token
  const parsedSymbols = symbols.map((sym) => ({
    sym,
    lower: sym.name.toLowerCase(),
    subwords: splitSubwords(sym.name)
  }))

  for (const token of queryTokens) {
    // 1. Exact base name match or subword/prefix match
    if (lowerBase === token) {
      fileMatchPoints += 0.5
    } else if (lowerBase.includes(token)) {
      fileMatchPoints += 0.3
    } else if (hasStemOrPrefixMatch(lowerBase, token, 3)) {
      fileMatchPoints += 0.25
    } else if (baseSubwords.some((sw) => sw === token || hasStemOrPrefixMatch(sw, token, 3))) {
      fileMatchPoints += 0.2
    }

    // 2. Path segment match
    for (let i = 0; i < segments.length - 1; i++) {
      const segLower = segments[i].toLowerCase()
      if (segLower === token) {
        fileMatchPoints += 0.25
        break
      } else if (hasStemOrPrefixMatch(segLower, token, 3)) {
        fileMatchPoints += 0.15
        break
      }
    }

    // 3. Symbol matches using precomputed parsed symbols
    for (const { sym, lower: symLower, subwords: symSubwords } of parsedSymbols) {
      if (symLower === token) {
        symbolMatchPoints += sym.exported ? 0.4 : 0.3
      } else if (symSubwords.includes(token)) {
        symbolMatchPoints += sym.exported ? 0.3 : 0.2
      } else if (symLower.includes(token) || hasStemOrPrefixMatch(symLower, token, 4)) {
        symbolMatchPoints += sym.exported ? 0.2 : 0.15
      } else if (symSubwords.some((sw) => hasStemOrPrefixMatch(sw, token, 4))) {
        symbolMatchPoints += sym.exported ? 0.15 : 0.1
      }
    }
  }

  // Symbol relevance boosts overall file query relevance
  if (symbolMatchPoints > 0) {
    fileMatchPoints += Math.min(0.5, symbolMatchPoints * 0.5)
  }

  // Normalize scores to [0, 1]
  const queryScore = Math.min(1.0, Math.round(fileMatchPoints * 100) / 100)
  const symbolScore = Math.min(1.0, Math.round(symbolMatchPoints * 100) / 100)

  return { queryScore, symbolScore }
}

/**
 * Precomputed neighborhood sets for O(1) active dependency checks.
 */
export interface ActiveNeighborhoodSets {
  directDependencies?: Set<string>
  directDependents?: Set<string>
}

/**
 * Calculates active file score and dependency / dependent relationship scores.
 * Supports optional precomputed sets to eliminate O(N * D) redundant sorting/scanning.
 */
export function calculateActiveAndDependencyScores(
  filePath: string,
  activeFilePath: string | undefined,
  graph: DependencyGraph,
  precomputedNeighborhood?: ActiveNeighborhoodSets
): { activeFileScore: number; dependencyScore: number; dependentScore: number } {
  const normFile = normalizeWorkspacePath(filePath)
  const normActive = activeFilePath ? normalizeWorkspacePath(activeFilePath) : null

  if (!normActive || !normFile) {
    return { activeFileScore: 0, dependencyScore: 0, dependentScore: 0 }
  }

  // 1. Exact active file
  if (normFile === normActive) {
    return { activeFileScore: 1.0, dependencyScore: 0, dependentScore: 0 }
  }

  // 2. Direct dependencies (files imported by active file)
  let isDirectDependency = false
  if (precomputedNeighborhood?.directDependencies) {
    isDirectDependency = precomputedNeighborhood.directDependencies.has(normFile)
  } else {
    const activeDeps = graph.getDependencies(normActive)
    isDirectDependency = activeDeps.some((d) => d.to === normFile)
  }
  const dependencyScore = isDirectDependency ? 0.6 : 0

  // 3. Direct dependents (files that import active file)
  let isDirectDependent = false
  if (precomputedNeighborhood?.directDependents) {
    isDirectDependent = precomputedNeighborhood.directDependents.has(normFile)
  } else {
    const activeDependents = graph.getDependents(normActive)
    isDirectDependent = activeDependents.some((d) => d.from === normFile)
  }
  const dependentScore = isDirectDependent ? 0.4 : 0

  return {
    activeFileScore: 0,
    dependencyScore,
    dependentScore
  }
}

/**
 * Computes the combined relevance score for a single file.
 */
export function scoreFileRelevance(options: {
  filePath: string
  symbols: ExtractedSymbol[]
  queryTokens: string[]
  activeFilePath?: string
  graph: DependencyGraph
  pageRankScore: number
  weights?: Partial<RankingWeights>
  activeNeighborhood?: ActiveNeighborhoodSets
}): FileRelevanceScore {
  const weights: RankingWeights = {
    ...DEFAULT_RANKING_WEIGHTS,
    ...options.weights
  }

  const { queryScore, symbolScore } = calculateQueryScore(
    options.filePath,
    options.symbols,
    options.queryTokens
  )

  const { activeFileScore, dependencyScore, dependentScore } =
    calculateActiveAndDependencyScores(
      options.filePath,
      options.activeFilePath,
      options.graph,
      options.activeNeighborhood
    )

  const pageRankScore = Math.max(0, Math.min(1.0, options.pageRankScore))

  // Weighted linear combination
  const rawFinal =
    weights.queryWeight * queryScore +
    weights.activeWeight * activeFileScore +
    weights.dependencyWeight * dependencyScore +
    weights.dependentWeight * dependentScore +
    weights.pageRankWeight * pageRankScore +
    weights.symbolWeight * symbolScore

  const finalScore = Math.max(0, Math.min(1.0, Math.round(rawFinal * 1000) / 1000))

  return {
    filePath: options.filePath,
    queryScore,
    activeFileScore,
    dependencyScore,
    dependentScore,
    pageRankScore,
    symbolScore,
    finalScore
  }
}

/**
 * Deterministically ranks symbols inside a file according to query match,
 * exported status, kind, and cursor proximity.
 */
export function rankSymbolsInFile(
  symbols: ExtractedSymbol[],
  queryTokens: string[],
  activeFilePath?: string,
  cursorLine?: number,
  targetFile?: string
): ExtractedSymbol[] {
  if (symbols.length <= 1) {
    return [...symbols]
  }

  const isCurrentActive =
    activeFilePath &&
    targetFile &&
    normalizeWorkspacePath(activeFilePath) === normalizeWorkspacePath(targetFile)

  const scoreSymbol = (s: ExtractedSymbol): { score: number; exactMatch: boolean } => {
    let score = 0
    let exactMatch = false
    const lowerName = s.name.toLowerCase()

    // 1. Kind architectural importance
    switch (s.kind) {
      case 'class':
      case 'interface':
      case 'struct':
      case 'trait':
        score += 15
        break
      case 'type':
      case 'enum':
        score += 12
        break
      case 'function':
        score += 10
        break
      case 'method':
      case 'constructor':
        score += 8
        break
      case 'property':
      case 'constant':
        score += 5
        break
      default:
        score += 2
        break
    }

    // 2. Exported status
    if (s.exported) {
      score += 15
    }

    // 3. Query token match
    for (const token of queryTokens) {
      if (lowerName === token) {
        score += 50
        exactMatch = true
      } else if (lowerName.startsWith(token)) {
        score += 30
      } else if (lowerName.includes(token)) {
        score += 20
      }
    }

    // 4. Cursor proximity in active file
    if (isCurrentActive && typeof cursorLine === 'number' && cursorLine >= 1) {
      if (s.startLine <= cursorLine && cursorLine <= s.endLine) {
        score += 40 // Cursor is directly inside this symbol
      } else {
        const lineDistance = Math.abs(s.startLine - cursorLine)
        if (lineDistance <= 50) {
          score += Math.round(20 * (1 - lineDistance / 50))
        }
      }
    }

    return { score, exactMatch }
  }

  return [...symbols].sort((a, b) => {
    const metaA = scoreSymbol(a)
    const metaB = scoreSymbol(b)

    // 1. Score descending
    const scoreDiff = metaB.score - metaA.score
    if (scoreDiff !== 0) return scoreDiff

    // 2. Exact match descending
    if (metaA.exactMatch !== metaB.exactMatch) {
      return metaA.exactMatch ? -1 : 1
    }

    // 3. Exported status descending
    if (a.exported !== b.exported) {
      return a.exported ? -1 : 1
    }

    // 4. Start line ascending
    const lineDiff = a.startLine - b.startLine
    if (lineDiff !== 0) return lineDiff

    // 5. Symbol name ascending
    return a.name.localeCompare(b.name)
  })
}
