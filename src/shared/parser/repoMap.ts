/**
 * Compact Deterministic Repo Map Generator (Phase 11.6 & Phase 11.7)
 *
 * Produces structured, token-bounded workspace summaries with key symbols
 * and dependency edges for AI context consumption, with relevance ranking
 * driven by user query, active file, and PageRank graph centrality.
 */

import { ExtractedSymbol } from './types'
import {
  FileRelevanceScore,
  RepoMapData,
  RepoMapFileEntry,
  RepoMapOptions,
  RepoMapResult
} from './repoMapTypes'
import { SymbolIndex } from './symbolIndex'
import { detectLanguageFromPath } from './languageDetector'
import { extractQueryTokens, rankSymbolsInFile } from './relevanceScorer'

const DEFAULT_MAX_FILES = 50
const DEFAULT_MAX_SYMBOLS_PER_FILE = 8
const DEFAULT_MAX_EDGES = 100
const DEFAULT_MAX_OUTPUT_CHARS = 6000 // ~1200-1500 tokens

export class RepoMapGenerator {
  private index: SymbolIndex

  constructor(index: SymbolIndex) {
    this.index = index
  }

  /**
   * Ranks workspace files based on query, active editor file, dependency graph, and PageRank.
   */
  rankFiles(options?: RepoMapOptions): FileRelevanceScore[] {
    return this.index.rankFiles(options)
  }

  /**
   * Generates a typed RepoMap and compact formatted representation.
   */
  generateRepoMap(options?: RepoMapOptions): RepoMapResult {
    const maxFiles = options?.maxFiles ?? DEFAULT_MAX_FILES
    const maxSymbolsPerFile = options?.maxSymbolsPerFile ?? DEFAULT_MAX_SYMBOLS_PER_FILE
    const maxEdges = options?.maxEdges ?? DEFAULT_MAX_EDGES
    const maxOutputChars = options?.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS
    const includeDependencies = options?.includeDependencies ?? true

    const allIndexedFiles = this.index.getIndexedFiles()
    let isTruncated = false
    let truncationReason: string | undefined = undefined

    // 1. File ordering: relevance ranking vs. alphabetical
    const rankingEnabled =
      options?.ranking === true ||
      (options?.ranking !== false &&
        (Boolean(options?.query && options.query.trim()) ||
          Boolean(options?.activeFilePath && options.activeFilePath.trim())))

    let sortedFiles: string[]
    let relevanceScores: FileRelevanceScore[] | undefined = undefined

    if (rankingEnabled) {
      const ranked = this.index.rankFiles(options)
      relevanceScores = ranked
      sortedFiles = ranked.map((r) => r.filePath)
    } else {
      sortedFiles = [...allIndexedFiles].sort()
    }

    // 2. Enforce maxFiles limit
    let candidateFiles = sortedFiles
    if (candidateFiles.length > maxFiles) {
      candidateFiles = sortedFiles.slice(0, maxFiles)
      isTruncated = true
      truncationReason = `Exceeded maxFiles (${maxFiles})`
    }

    const queryTokens = extractQueryTokens(options?.query)
    let totalSymbolsCount = 0
    let totalEdgesCount = 0
    const fileEntries: RepoMapFileEntry[] = []

    // Index relevance scores in O(N) map to avoid O(N^2) .find() in file loop
    const scoreMap = relevanceScores
      ? new Map<string, FileRelevanceScore>(relevanceScores.map((r) => [r.filePath, r]))
      : null

    for (const filePath of candidateFiles) {
      const allSymbols = this.index.getFileSymbols(filePath)
      totalSymbolsCount += allSymbols.length

      // Prioritize symbols: relevance-driven if ranking or architectural importance
      let selectedSymbols: ExtractedSymbol[]
      if (rankingEnabled) {
        const rankedSymbols = rankSymbolsInFile(
          allSymbols,
          queryTokens,
          options?.activeFilePath,
          options?.cursorLine,
          filePath
        )
        selectedSymbols = rankedSymbols.slice(0, maxSymbolsPerFile)
      } else {
        selectedSymbols = this.prioritizeSymbols(allSymbols, maxSymbolsPerFile)
      }

      // Get resolved outgoing dependencies
      let resolvedTargets: string[] = []
      if (includeDependencies) {
        const outgoing = this.index.getDependencies(filePath)
        resolvedTargets = Array.from(
          new Set(
            outgoing
              .filter((e) => e.resolved && e.to !== null)
              .map((e) => e.to!)
          )
        ).sort()

        totalEdgesCount += resolvedTargets.length
      }

      const scoreEntry = scoreMap?.get(filePath)

      fileEntries.push({
        filePath,
        language: detectLanguageFromPath(filePath).language,
        symbols: selectedSymbols,
        dependencies: resolvedTargets,
        relevanceScore: scoreEntry
      })
    }

    // Limit edges if needed
    if (totalEdgesCount > maxEdges) {
      let remainingEdges = maxEdges
      for (const entry of fileEntries) {
        if (entry.dependencies.length > remainingEdges) {
          entry.dependencies = entry.dependencies.slice(0, remainingEdges)
          remainingEdges = 0
          isTruncated = true
          truncationReason = `Exceeded maxEdges (${maxEdges})`
        } else {
          remainingEdges -= entry.dependencies.length
        }
      }
    }

    // 3. Construct typed RepoMapData
    const mapData: RepoMapData = {
      files: fileEntries,
      totalFilesIndexed: allIndexedFiles.length,
      totalSymbolsIndexed: totalSymbolsCount,
      totalEdges: totalEdgesCount,
      truncated: isTruncated,
      truncationReason,
      relevanceScores
    }

    // 4. Format into compact textual representation
    let formattedText = this.formatRepoMapText(mapData, includeDependencies)

    // 5. Enforce character/token budget
    if (formattedText.length > maxOutputChars) {
      isTruncated = true
      truncationReason = `Exceeded maxOutputChars (${maxOutputChars})`
      mapData.truncated = true
      mapData.truncationReason = truncationReason

      const availableChars = Math.max(200, maxOutputChars - 120)
      const lastNewline = formattedText.lastIndexOf('\n', availableChars)
      const cutPoint = lastNewline !== -1 ? lastNewline : availableChars
      formattedText =
        formattedText.slice(0, cutPoint) +
        `\n\n[Repo Map truncated: ${fileEntries.length} of ${allIndexedFiles.length} files included (budget limit reached)]\n`
    } else if (isTruncated) {
      formattedText += `\n[Repo Map truncated: ${fileEntries.length} of ${allIndexedFiles.length} files included (${truncationReason})]\n`
    }

    const tokenEstimate = Math.ceil(formattedText.length / 4)

    return {
      map: mapData,
      formattedText,
      tokenEstimate,
      truncated: isTruncated,
      relevanceScores
    }
  }

  /**
   * Prioritizes key symbols for compact presentation when ranking is disabled.
   */
  private prioritizeSymbols(symbols: ExtractedSymbol[], maxSymbols: number): ExtractedSymbol[] {
    if (symbols.length <= maxSymbols) {
      return [...symbols].sort((a, b) => a.startLine - b.startLine)
    }

    const score = (s: ExtractedSymbol): number => {
      let score = 0
      if (s.exported) score += 20
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
          score += 1
          break
      }
      return score
    }

    return [...symbols]
      .sort((a, b) => score(b) - score(a) || a.startLine - b.startLine)
      .slice(0, maxSymbols)
      .sort((a, b) => a.startLine - b.startLine)
  }

  /**
   * Formats RepoMapData into a clean, human- and AI-readable tree/outline.
   */
  private formatRepoMapText(data: RepoMapData, includeDependencies: boolean): string {
    const lines: string[] = []

    lines.push('PROJECT STRUCTURE & KEY SYMBOLS')

    for (const entry of data.files) {
      lines.push(`├── ${entry.filePath}`)

      for (const sym of entry.symbols) {
        const exportedTag = sym.exported ? ' [exported]' : ''
        const parentTag = sym.parent ? ` (parent: ${sym.parent})` : ''
        const lineTag = `L${sym.startLine}`
        lines.push(`│   ├── ${sym.kind} ${sym.name} (${lineTag})${parentTag}${exportedTag}`)
      }

      if (includeDependencies && entry.dependencies.length > 0) {
        const depList = entry.dependencies.join(', ')
        lines.push(`│   └── imports: ${depList}`)
      }
    }

    if (includeDependencies) {
      const filesWithDeps = data.files.filter((f) => f.dependencies.length > 0)
      if (filesWithDeps.length > 0) {
        lines.push('')
        lines.push('DEPENDENCIES (RESOLVED)')
        for (const entry of filesWithDeps) {
          lines.push(entry.filePath)
          for (const dep of entry.dependencies) {
            lines.push(`  → ${dep}`)
          }
        }
      }
    }

    return lines.join('\n')
  }
}
