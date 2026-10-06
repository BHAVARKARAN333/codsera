/**
 * Deterministic Inverted Index with BM25 Lexical Scoring (Phase 11.8)
 *
 * Implements standard Okapi / Lucene-style BM25 with term frequency (TF),
 * non-negative inverse document frequency (IDF), document length normalization,
 * and candidate-only retrieval over an inverted index.
 */

export interface BM25Options {
  k1?: number
  b?: number
}

export interface BM25DocumentRecord {
  filePath: string
  tokenCounts: Map<string, number>
  length: number
}

export interface BM25SearchResult {
  filePath: string
  rawScore: number
  normalizedScore: number
  matchedTokens: string[]
}

const DEFAULT_K1 = 1.2
const DEFAULT_B = 0.75

export class BM25Index {
  private k1: number
  private b: number

  // Document metadata: filePath -> BM25DocumentRecord
  private documents: Map<string, BM25DocumentRecord> = new Map()

  // Inverted index: token -> (filePath -> termFrequency)
  private invertedIndex: Map<string, Map<string, number>> = new Map()

  // Aggregate statistics
  private totalDocLength: number = 0
  private avgDL: number = 0

  constructor(options?: BM25Options) {
    this.k1 = options?.k1 ?? DEFAULT_K1
    this.b = options?.b ?? DEFAULT_B
  }

  /**
   * Returns current BM25 parameters.
   */
  getParameters(): { k1: number; b: number } {
    return { k1: this.k1, b: this.b }
  }

  /**
   * Sets BM25 tuning parameters.
   */
  setParameters(options: BM25Options): void {
    if (typeof options.k1 === 'number' && options.k1 >= 0) {
      this.k1 = options.k1
    }
    if (typeof options.b === 'number' && options.b >= 0 && options.b <= 1) {
      this.b = options.b
    }
  }

  /**
   * Returns total indexed document count.
   */
  getDocumentCount(): number {
    return this.documents.size
  }

  /**
   * Returns average document length (avgDL).
   */
  getAverageDocumentLength(): number {
    return this.avgDL
  }

  /**
   * Returns document frequency for a given token (DF).
   */
  getDocumentFrequency(token: string): number {
    return this.invertedIndex.get(token.toLowerCase())?.size ?? 0
  }

  /**
   * Returns total unique tokens indexed.
   */
  getVocabularySize(): number {
    return this.invertedIndex.size
  }

  /**
   * Adds or updates a document in the inverted index incrementally.
   * Time complexity: O(tokens in document).
   */
  addDocument(filePath: string, tokens: string[]): void {
    if (!filePath || typeof filePath !== 'string') return

    // 1. Remove previous document if already indexed
    if (this.documents.has(filePath)) {
      this.removeDocument(filePath)
    }

    const tokenCounts = new Map<string, number>()
    for (const rawToken of tokens) {
      const token = rawToken.toLowerCase()
      if (!token) continue
      tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1)
    }

    const length = tokens.length
    const record: BM25DocumentRecord = {
      filePath,
      tokenCounts,
      length
    }

    // 2. Add to inverted index
    for (const [token, tf] of tokenCounts.entries()) {
      let postings = this.invertedIndex.get(token)
      if (!postings) {
        postings = new Map<string, number>()
        this.invertedIndex.set(token, postings)
      }
      postings.set(filePath, tf)
    }

    // 3. Update document registry & aggregate stats
    this.documents.set(filePath, record)
    this.totalDocLength += length
    this.avgDL = this.documents.size > 0 ? this.totalDocLength / this.documents.size : 0
  }

  /**
   * Removes a document from the inverted index incrementally.
   * Time complexity: O(unique tokens in document).
   */
  removeDocument(filePath: string): boolean {
    const existing = this.documents.get(filePath)
    if (!existing) {
      return false
    }

    // 1. Remove from inverted index postings
    for (const token of existing.tokenCounts.keys()) {
      const postings = this.invertedIndex.get(token)
      if (postings) {
        postings.delete(filePath)
        if (postings.size === 0) {
          this.invertedIndex.delete(token)
        }
      }
    }

    // 2. Update aggregate statistics
    this.documents.delete(filePath)
    this.totalDocLength = Math.max(0, this.totalDocLength - existing.length)
    this.avgDL = this.documents.size > 0 ? this.totalDocLength / this.documents.size : 0

    return true
  }

  /**
   * Clears all documents, postings, and statistics.
   */
  clear(): void {
    this.documents.clear()
    this.invertedIndex.clear()
    this.totalDocLength = 0
    this.avgDL = 0
  }

  /**
   * Calculates Robertson / Lucene non-negative Inverse Document Frequency.
   * Always > 0 for all terms present in at least one document.
   *
   * IDF(q) = ln(1 + (N - n(q) + 0.5) / (n(q) + 0.5))
   */
  calculateIDF(token: string): number {
    const N = this.documents.size
    if (N === 0) return 0

    const n = this.getDocumentFrequency(token)
    if (n === 0) return 0

    const numerator = N - n + 0.5
    const denominator = n + 0.5
    return Math.log(1 + numerator / denominator)
  }

  /**
   * Searches the inverted index using BM25 scoring over candidate documents.
   * Avoids scanning the entire workspace by restricting scoring to documents
   * that contain at least one query token.
   *
   * Time complexity: O(C * Q), where C = candidates, Q = query tokens.
   */
  search(queryTokens: string[]): Map<string, { rawScore: number; matchedTokens: string[] }> {
    const results = new Map<string, { rawScore: number; matchedTokens: string[] }>()
    if (queryTokens.length === 0 || this.documents.size === 0) {
      return results
    }

    const avgDL = this.avgDL > 0 ? this.avgDL : 1

    // 1. Candidate document retrieval via inverted index postings
    const candidates = new Set<string>()
    const tokenPostingMap = new Map<string, Map<string, number>>()
    const tokenIDFMap = new Map<string, number>()

    for (const rawToken of queryTokens) {
      const token = rawToken.toLowerCase()
      if (tokenPostingMap.has(token)) continue

      const postings = this.invertedIndex.get(token)
      if (postings && postings.size > 0) {
        tokenPostingMap.set(token, postings)
        tokenIDFMap.set(token, this.calculateIDF(token))

        for (const docId of postings.keys()) {
          candidates.add(docId)
        }
      }
    }

    if (candidates.size === 0) {
      return results
    }

    // 2. Score candidate documents only
    for (const docId of candidates) {
      const doc = this.documents.get(docId)
      if (!doc) continue

      const docLength = doc.length
      const lenNorm = 1 - this.b + this.b * (docLength / avgDL)

      let totalScore = 0
      const matchedTokens: string[] = []

      for (const [token, postings] of tokenPostingMap.entries()) {
        const tf = postings.get(docId)
        if (tf && tf > 0) {
          const idf = tokenIDFMap.get(token) ?? 0
          const numerator = tf * (this.k1 + 1)
          const denominator = tf + this.k1 * lenNorm
          totalScore += idf * (numerator / denominator)
          matchedTokens.push(token)
        }
      }

      if (totalScore > 0) {
        results.set(docId, {
          rawScore: Math.round(totalScore * 10000) / 10000,
          matchedTokens
        })
      }
    }

    return results
  }

  /**
   * Searches and returns normalized BM25 results in [0, 1].
   */
  searchNormalized(queryTokens: string[]): BM25SearchResult[] {
    const rawMap = this.search(queryTokens)
    if (rawMap.size === 0) {
      return []
    }

    let maxScore = 0
    for (const val of rawMap.values()) {
      if (val.rawScore > maxScore) {
        maxScore = val.rawScore
      }
    }

    const output: BM25SearchResult[] = []
    for (const [filePath, data] of rawMap.entries()) {
      const normalizedScore =
        maxScore > 0 ? Math.round((data.rawScore / maxScore) * 10000) / 10000 : 0

      output.push({
        filePath,
        rawScore: data.rawScore,
        normalizedScore,
        matchedTokens: data.matchedTokens
      })
    }

    // Deterministic sort: score descending, then filePath ascending
    return output.sort((a, b) => {
      const scoreDiff = b.rawScore - a.rawScore
      if (Math.abs(scoreDiff) > 1e-6) return scoreDiff
      return a.filePath.localeCompare(b.filePath)
    })
  }
}
