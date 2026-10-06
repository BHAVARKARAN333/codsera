import { describe, it, expect, beforeEach } from 'vitest'
import {
  BM25Index,
  tokenizeIdentifier,
  splitIdentifierSubwords,
  tokenizeQuery,
  tokenizeDocumentMetadata,
  SymbolIndex,
  DEFAULT_HYBRID_SEARCH_WEIGHTS,
  reciprocalRankFusion,
  calculateRRFScore,
  DEFAULT_RRF_K,
  DEFAULT_RRF_WEIGHTS,
  RankedSourceList,
  RRFSearchService
} from '@shared/parser'
import { SmartContextEngine } from '@renderer/services/agent/smartContextEngine'

describe('Phase 11.8 — BM25 + Symbol Hybrid Search', () => {
  describe('BM25 Lexical Search Layer', () => {
    let bm25: BM25Index

    beforeEach(() => {
      bm25 = new BM25Index({ k1: 1.2, b: 0.75 })
    })

    it('handles exact single token match', () => {
      bm25.addDocument('src/auth.ts', ['auth', 'service', 'login'])
      bm25.addDocument('src/billing.ts', ['payment', 'billing', 'charge'])

      const results = bm25.searchNormalized(['login'])
      expect(results.length).toBe(1)
      expect(results[0].filePath).toBe('src/auth.ts')
      expect(results[0].rawScore).toBeGreaterThan(0)
      expect(results[0].normalizedScore).toBe(1.0)
      expect(results[0].matchedTokens).toEqual(['login'])
    })

    it('scores documents matching multiple query tokens higher than single match', () => {
      bm25.addDocument('src/authService.ts', ['auth', 'service', 'login', 'token'])
      bm25.addDocument('src/tokenHelper.ts', ['token', 'generator'])
      bm25.addDocument('src/billing.ts', ['payment', 'invoice'])

      const results = bm25.searchNormalized(['auth', 'token'])
      expect(results.length).toBe(2)
      // authService matches both 'auth' and 'token', tokenHelper matches only 'token'
      expect(results[0].filePath).toBe('src/authService.ts')
      expect(results[1].filePath).toBe('src/tokenHelper.ts')
      expect(results[0].rawScore).toBeGreaterThan(results[1].rawScore)
    })

    it('demonstrates TF (term frequency) behavior with diminishing returns', () => {
      // Doc A has 1 occurrence of 'auth'
      bm25.addDocument('src/docA.ts', ['auth', 'other1', 'other2'])
      // Doc B has 4 occurrences of 'auth' with same total length
      bm25.addDocument('src/docB.ts', ['auth', 'auth', 'auth', 'auth'])

      const results = bm25.search(['auth'])
      const scoreA = results.get('src/docA.ts')?.rawScore ?? 0
      const scoreB = results.get('src/docB.ts')?.rawScore ?? 0

      // Higher TF yields higher score
      expect(scoreB).toBeGreaterThan(scoreA)
      // Diminishing returns: 4x TF does NOT yield 4x score due to (k1 + 1) saturation
      expect(scoreB).toBeLessThan(scoreA * 4)
    })

    it('demonstrates IDF (inverse document frequency) behavior where rare terms score higher', () => {
      // 'common' appears in 3 documents
      // 'rare' appears in only 1 document
      bm25.addDocument('src/doc1.ts', ['common', 'rare', 'util'])
      bm25.addDocument('src/doc2.ts', ['common', 'billing'])
      bm25.addDocument('src/doc3.ts', ['common', 'database'])

      const idfRare = bm25.calculateIDF('rare')
      const idfCommon = bm25.calculateIDF('common')

      expect(idfRare).toBeGreaterThan(idfCommon)

      // Querying rare term produces higher BM25 score than querying common term
      const resRare = bm25.search(['rare']).get('src/doc1.ts')?.rawScore ?? 0
      const resCommon = bm25.search(['common']).get('src/doc1.ts')?.rawScore ?? 0
      expect(resRare).toBeGreaterThan(resCommon)
    })

    it('normalizes document length: shorter document with same TF scores higher', () => {
      // Short document: length 3
      bm25.addDocument('src/short.ts', ['target', 'word1', 'word2'])
      // Long document: length 12 with same 1 target occurrence
      bm25.addDocument('src/long.ts', [
        'target',
        'word1',
        'word2',
        'word3',
        'word4',
        'word5',
        'word6',
        'word7',
        'word8',
        'word9',
        'word10',
        'word11'
      ])

      const results = bm25.search(['target'])
      const shortScore = results.get('src/short.ts')?.rawScore ?? 0
      const longScore = results.get('src/long.ts')?.rawScore ?? 0

      // Due to b = 0.75 length penalty, short doc receives higher score
      expect(shortScore).toBeGreaterThan(longScore)
    })

    it('returns empty results for empty query and unknown tokens', () => {
      bm25.addDocument('src/file.ts', ['token1', 'token2'])

      expect(bm25.search([])).toEqual(new Map())
      expect(bm25.searchNormalized([])).toEqual([])
      expect(bm25.search(['nonexistent', 'unknown'])).toEqual(new Map())
      expect(bm25.searchNormalized(['nonexistent', 'unknown'])).toEqual([])
    })
  })

  describe('Identifier Normalization & Tokenization', () => {
    it('splits identifiers into subwords across conventions', () => {
      expect(splitIdentifierSubwords('authService')).toEqual(['auth', 'service'])
      expect(splitIdentifierSubwords('user_token')).toEqual(['user', 'token'])
    })

    it('tokenizes camelCase into subwords and concatenated form', () => {
      const tokens = tokenizeIdentifier('authService')
      expect(tokens).toContain('auth')
      expect(tokens).toContain('service')
      expect(tokens).toContain('authservice')
    })

    it('tokenizes PascalCase into subwords and concatenated form', () => {
      const tokens = tokenizeIdentifier('AuthServiceManager')
      expect(tokens).toContain('auth')
      expect(tokens).toContain('service')
      expect(tokens).toContain('manager')
      expect(tokens).toContain('authservicemanager')
    })

    it('tokenizes snake_case into subwords and concatenated form', () => {
      const tokens = tokenizeIdentifier('user_auth_token')
      expect(tokens).toContain('user')
      expect(tokens).toContain('auth')
      expect(tokens).toContain('token')
      expect(tokens).toContain('userauthtoken')
    })

    it('tokenizes kebab-case into subwords and concatenated form', () => {
      const tokens = tokenizeIdentifier('payment-api-client')
      expect(tokens).toContain('payment')
      expect(tokens).toContain('api')
      expect(tokens).toContain('client')
      expect(tokens).toContain('paymentapiclient')
    })

    it('extracts query tokens, expands subwords, and strips stop words', () => {
      const tokens = tokenizeQuery('find the AuthServiceManager for payment')
      expect(tokens).toContain('auth')
      expect(tokens).toContain('service')
      expect(tokens).toContain('manager')
      expect(tokens).toContain('authservicemanager')
      expect(tokens).toContain('payment')
      expect(tokens).not.toContain('the')
      expect(tokens).not.toContain('for')
    })

    it('tokenizes document metadata from file path and AST symbols', () => {
      const tokens = tokenizeDocumentMetadata('src/auth/authHandler.ts', [
        {
          name: 'loginUser',
          kind: 'function',
          filePath: 'src/auth/authHandler.ts',
          startLine: 5,
          startColumn: 1,
          endLine: 15,
          endColumn: 1,
          parent: null,
          exported: true
        }
      ])

      expect(tokens).toContain('src')
      expect(tokens).toContain('auth')
      expect(tokens).toContain('handler')
      expect(tokens).toContain('authhandler')
      expect(tokens).toContain('login')
      expect(tokens).toContain('user')
      expect(tokens).toContain('loginuser')
      expect(tokens).toContain('function')
      expect(tokens).toContain('exported')
    })
  })

  describe('Hybrid Ranking & Symbol Integration', () => {
    let index: SymbolIndex

    beforeEach(() => {
      index = new SymbolIndex()
      index.setKnownFiles([
        'src/auth/authService.ts',
        'src/controllers/authController.ts',
        'src/utils/logger.ts',
        'src/billing/payment.ts'
      ])

      index.indexFile(
        'src/auth/authService.ts',
        `
import { logger } from '../utils/logger';

export class AuthService {
  public authenticateUser(credentials: any): boolean {
    return true;
  }
}
`.trim()
      )

      index.indexFile(
        'src/controllers/authController.ts',
        `
import { AuthService } from '../auth/authService';
import { logger } from '../utils/logger';

export class AuthController {
  public handleLogin(): void {}
}
`.trim()
      )

      index.indexFile(
        'src/billing/payment.ts',
        `
import { logger } from '../utils/logger';

export class PaymentProcessor {
  public chargeCard(): void {}
}
`.trim()
      )

      index.indexFile(
        'src/utils/logger.ts',
        `
export class Logger {
  public log(msg: string): void {}
}
`.trim()
      )
    })

    it('prioritizes exact symbol match over weak lexical match', () => {
      const results = index.searchCode('authenticateUser')
      expect(results.length).toBeGreaterThan(0)

      // Exact symbol match in authService.ts should rank first
      expect(results[0].filePath).toBe('src/auth/authService.ts')
      expect(results[0].symbolScore).toBeGreaterThan(0.5)
      expect(results[0].matchedSymbols.length).toBeGreaterThan(0)
      expect(results[0].matchedSymbols[0].name).toBe('authenticateUser')
    })

    it('leverages BM25 to rank relevant filenames and path segments appropriately', () => {
      const results = index.searchCode('auth controller')
      expect(results.length).toBeGreaterThan(0)

      expect(results[0].filePath).toBe('src/controllers/authController.ts')
      expect(results[0].bm25Score).toBeGreaterThan(0)
      expect(results[0].queryScore).toBeGreaterThan(0)
    })

    it('allows PageRank to contribute without dominating direct query relevance', () => {
      // logger.ts is imported by authService, authController, and payment -> highest PageRank
      const results = index.searchCode('authenticateUser')

      // logger.ts must NOT outrank authService.ts despite having higher PageRank
      expect(results[0].filePath).toBe('src/auth/authService.ts')
      const loggerResult = results.find((r) => r.filePath === 'src/utils/logger.ts')
      if (loggerResult) {
        expect(results[0].score).toBeGreaterThan(loggerResult.score)
      }
    })

    it('defines sensible default hybrid search weights summing to 1.0', () => {
      expect(DEFAULT_HYBRID_SEARCH_WEIGHTS.bm25Weight).toBe(0.35)
      expect(DEFAULT_HYBRID_SEARCH_WEIGHTS.symbolWeight).toBe(0.25)
      expect(DEFAULT_HYBRID_SEARCH_WEIGHTS.queryWeight).toBe(0.25)
      expect(DEFAULT_HYBRID_SEARCH_WEIGHTS.pageRankWeight).toBe(0.15)
      const sum =
        DEFAULT_HYBRID_SEARCH_WEIGHTS.bm25Weight +
        DEFAULT_HYBRID_SEARCH_WEIGHTS.symbolWeight +
        DEFAULT_HYBRID_SEARCH_WEIGHTS.queryWeight +
        DEFAULT_HYBRID_SEARCH_WEIGHTS.pageRankWeight
      expect(Math.round(sum * 100) / 100).toBe(1.0)
    })

    it('supports custom ranking weights', () => {
      const defaultResults = index.searchCode('payment')
      const customResults = index.searchCode('payment', {
        weights: {
          bm25Weight: 0.8,
          symbolWeight: 0.1,
          queryWeight: 0.05,
          pageRankWeight: 0.05
        }
      })

      expect(defaultResults.length).toBe(customResults.length)
      expect(defaultResults[0].filePath).toBe('src/billing/payment.ts')
      expect(customResults[0].filePath).toBe('src/billing/payment.ts')
    })

    it('guarantees deterministic result ordering and tie-breaking', () => {
      const res1 = index.searchCode('auth')
      const res2 = index.searchCode('auth')

      expect(res1.length).toBe(res2.length)
      for (let i = 0; i < res1.length; i++) {
        expect(res1[i].filePath).toBe(res2[i].filePath)
        expect(res1[i].score).toBe(res2[i].score)
        expect(res1[i].bm25Score).toBe(res2[i].bm25Score)
      }
    })
  })

  describe('Incremental Indexing & Invalidation', () => {
    let index: SymbolIndex

    beforeEach(() => {
      index = new SymbolIndex()
      index.setKnownFiles(['src/serviceA.ts', 'src/serviceB.ts'])
      index.indexFile('src/serviceA.ts', 'export class ServiceA { public run(): void {} }')
      index.indexFile('src/serviceB.ts', 'export class ServiceB { public run(): void {} }')
    })

    it('updates inverted index when a new file is added', () => {
      expect(index.searchCode('NewWidget').length).toBe(0)

      index.indexFile(
        'src/newWidget.ts',
        'export class NewWidget { public execute(): void {} }'
      )

      const results = index.searchCode('NewWidget')
      expect(results.length).toBe(1)
      expect(results[0].filePath).toBe('src/newWidget.ts')
    })

    it('updates inverted index and purges stale tokens when a file is modified', () => {
      // Initially has method 'run'
      expect(index.searchCode('run').length).toBe(2)

      // Modify serviceA to replace 'run' with 'executeBatch'
      index.indexFile(
        'src/serviceA.ts',
        'export class ServiceA { public executeBatch(): void {} }'
      )

      // Search for new token
      const newResults = index.searchCode('executeBatch')
      expect(newResults.length).toBe(1)
      expect(newResults[0].filePath).toBe('src/serviceA.ts')

      // Search for old token in serviceA - only serviceB should now match 'run'
      const oldResults = index.searchCode('run')
      expect(oldResults.length).toBe(1)
      expect(oldResults[0].filePath).toBe('src/serviceB.ts')
    })

    it('removes file and cleans inverted index postings when file is deleted', () => {
      expect(index.searchCode('servicea').length).toBe(1)
      expect(index.searchCode('servicea')[0].filePath).toBe('src/serviceA.ts')

      const removed = index.removeFile('src/serviceA.ts')
      expect(removed).toBe(true)

      const results = index.searchCode('servicea')
      expect(results.length).toBe(0)
      expect(index.getBM25Index().getDocumentCount()).toBe(1)
    })
  })

  describe('SmartContextEngine Search Integration', () => {
    let engine: SmartContextEngine

    beforeEach(() => {
      engine = new SmartContextEngine()
      const symbolIndex = engine.getSymbolIndex()
      symbolIndex.setKnownFiles(['src/editor.ts', 'src/terminal.ts'])
      symbolIndex.indexFile(
        'src/editor.ts',
        `
export class EditorPane {
  public focus(): void {}
  public formatCode(): void {}
}
`.trim()
      )
      symbolIndex.indexFile(
        'src/terminal.ts',
        `
export class TerminalSession {
  public spawn(): void {}
}
`.trim()
      )
    })

    it('exposes searchCode through SmartContextEngine with active editor context', () => {
      const results = engine.searchCode('formatCode', {
        activeFilePath: 'src/editor.ts',
        cursorLine: 3
      })

      expect(results.length).toBe(1)
      expect(results[0].filePath).toBe('src/editor.ts')
      expect(results[0].matchedSymbols[0].name).toBe('formatCode')
    })

    it('respects maxResults and threshold options', () => {
      const symbolIndex = engine.getSymbolIndex()
      for (let i = 0; i < 10; i++) {
        symbolIndex.indexFile(
          `src/item_${i}.ts`,
          `export class Item${i} { public testItem(): void {} }`
        )
      }

      const results = engine.searchCode('testItem', { maxResults: 3 })
      expect(results.length).toBe(3)
    })
  })
})

describe('Phase 11.9 — Reciprocal Rank Fusion (RRF) Layer', () => {
  describe('RRF Mathematics', () => {
    it('provides sensible default constants for k and source weights', () => {
      expect(DEFAULT_RRF_K).toBe(60)
      expect(DEFAULT_RRF_WEIGHTS.bm25).toBe(1.0)
      expect(DEFAULT_RRF_WEIGHTS.symbol).toBe(1.0)
      expect(DEFAULT_RRF_WEIGHTS.repoMap).toBe(0.75)
      expect(DEFAULT_RRF_WEIGHTS.activeContext).toBe(0.5)
    })

    it('calculates rank 1 score with default k=60 as 1/(60+1) ≈ 0.016393', () => {
      const score = calculateRRFScore(1, 60, 1.0)
      expect(score).toBeCloseTo(1 / 61, 5)
      expect(score).toBeCloseTo(0.016393, 5)
    })

    it('calculates rank 2 score with default k=60 as 1/(60+2) ≈ 0.016129', () => {
      const score = calculateRRFScore(2, 60, 1.0)
      expect(score).toBeCloseTo(1 / 62, 5)
      expect(score).toBeCloseTo(0.016129, 5)
    })

    it('handles custom k values correctly (e.g., k=10: rank 1 = 1/11, rank 2 = 1/12)', () => {
      const scoreRank1 = calculateRRFScore(1, 10, 1.0)
      const scoreRank2 = calculateRRFScore(2, 10, 1.0)

      expect(scoreRank1).toBeCloseTo(1 / 11, 5)
      expect(scoreRank1).toBeCloseTo(0.090909, 5)
      expect(scoreRank2).toBeCloseTo(1 / 12, 5)
      expect(scoreRank2).toBeCloseTo(0.083333, 5)
    })

    it('incorporates source weight into score calculation: weight * 1 / (k + rank)', () => {
      const unweighted = calculateRRFScore(1, 60, 1.0)
      const weightedDouble = calculateRRFScore(1, 60, 2.0)
      const weightedHalf = calculateRRFScore(1, 60, 0.5)

      expect(weightedDouble).toBeCloseTo(unweighted * 2, 5)
      expect(weightedHalf).toBeCloseTo(unweighted * 0.5, 5)
    })

    it('normalizes invalid or sub-1 ranks to rank 1', () => {
      const score0 = calculateRRFScore(0, 60, 1.0)
      const scoreNeg = calculateRRFScore(-5, 60, 1.0)
      const score1 = calculateRRFScore(1, 60, 1.0)

      expect(score0).toBe(score1)
      expect(scoreNeg).toBe(score1)
    })
  })

  describe('Multi-Source Fusion', () => {
    it('maintains relative rank order for a single source', () => {
      const source: RankedSourceList = {
        sourceId: 'bm25',
        weight: 1.0,
        items: [
          { filePath: 'src/first.ts', score: 10.0 },
          { filePath: 'src/second.ts', score: 8.0 },
          { filePath: 'src/third.ts', score: 5.0 }
        ]
      }

      const fused = reciprocalRankFusion([source])
      expect(fused.length).toBe(3)
      expect(fused[0].filePath).toBe('src/first.ts')
      expect(fused[0].fusedRank).toBe(1)
      expect(fused[1].filePath).toBe('src/second.ts')
      expect(fused[1].fusedRank).toBe(2)
      expect(fused[2].filePath).toBe('src/third.ts')
      expect(fused[2].fusedRank).toBe(3)
      expect(fused[0].rrfScore).toBeGreaterThan(fused[1].rrfScore)
      expect(fused[1].rrfScore).toBeGreaterThan(fused[2].rrfScore)
    })

    it('interleaves non-overlapping items from two sources based on individual RRF scores', () => {
      const sourceA: RankedSourceList = {
        sourceId: 'bm25',
        weight: 1.0,
        items: [
          { filePath: 'src/a1.ts', score: 10 },
          { filePath: 'src/a3.ts', score: 6 }
        ]
      }
      const sourceB: RankedSourceList = {
        sourceId: 'symbol',
        weight: 1.0,
        items: [
          { filePath: 'src/b2.ts', score: 8 },
          { filePath: 'src/b4.ts', score: 4 }
        ]
      }

      const fused = reciprocalRankFusion([sourceA, sourceB])
      expect(fused.map((r) => r.filePath)).toEqual([
        'src/a1.ts',
        'src/b2.ts',
        'src/a3.ts',
        'src/b4.ts'
      ])
    })

    it('demonstrates consensus effect: rank 5 in two sources outranks rank 1 in only one source', () => {
      // Doc X appears at rank 5 in both sources: 1/(60+5) + 1/(60+5) = 2/65 ≈ 0.030769
      // Doc Y appears at rank 1 in only one source: 1/(60+1) = 1/61 ≈ 0.016393
      const source1: RankedSourceList = {
        sourceId: 'bm25',
        weight: 1.0,
        items: [
          { filePath: 'src/docY.ts' },
          { filePath: 'src/dummy1.ts' },
          { filePath: 'src/dummy2.ts' },
          { filePath: 'src/dummy3.ts' },
          { filePath: 'src/docX.ts' }
        ]
      }
      const source2: RankedSourceList = {
        sourceId: 'symbol',
        weight: 1.0,
        items: [
          { filePath: 'src/dummy4.ts' },
          { filePath: 'src/dummy5.ts' },
          { filePath: 'src/dummy6.ts' },
          { filePath: 'src/dummy7.ts' },
          { filePath: 'src/docX.ts' }
        ]
      }

      const fused = reciprocalRankFusion([source1, source2])
      expect(fused[0].filePath).toBe('src/docX.ts')
      const docY = fused.find((f) => f.filePath === 'src/docY.ts')!
      expect(docY).toBeDefined()
      expect(fused[0].rrfScore).toBeGreaterThan(docY.rrfScore)
      expect(fused[0].contributingSources.length).toBe(2)
      expect(docY.contributingSources.length).toBe(1)
    })

    it('accumulates sourceContributions across multiple channels', () => {
      const source1: RankedSourceList = {
        sourceId: 'bm25',
        weight: 1.0,
        items: [{ filePath: 'src/shared.ts' }]
      }
      const source2: RankedSourceList = {
        sourceId: 'symbol',
        weight: 0.8,
        items: [{ filePath: 'src/shared.ts' }]
      }
      const source3: RankedSourceList = {
        sourceId: 'repoMap',
        weight: 0.5,
        items: [{ filePath: 'src/shared.ts' }]
      }

      const fused = reciprocalRankFusion([source1, source2, source3])
      expect(fused.length).toBe(1)
      expect(fused[0].contributingSources).toHaveLength(3)
      expect(fused[0].contributingSources).toEqual(['bm25', 'symbol', 'repoMap'])
      expect(fused[0].sourceContributions['bm25']).toBeGreaterThan(0)
      expect(fused[0].sourceContributions['symbol']).toBeGreaterThan(0)
      expect(fused[0].sourceContributions['repoMap']).toBeGreaterThan(0)
    })
  })

  describe('Weighted Fusion', () => {
    it('allows higher-weighted sources to influence final rank more strongly', () => {
      // Source A has weight 2.0, Source B has weight 0.5
      const sourceA: RankedSourceList = {
        sourceId: 'bm25',
        weight: 2.0,
        items: [{ filePath: 'src/dummy.ts' }, { filePath: 'src/highWeight.ts' }]
      }
      const sourceB: RankedSourceList = {
        sourceId: 'repoMap',
        weight: 0.5,
        items: [{ filePath: 'src/lowWeight.ts' }]
      }

      // highWeight rank 2 in A: 2.0 / (60 + 2) = 2.0 / 62 ≈ 0.032258
      // lowWeight rank 1 in B: 0.5 / (60 + 1) = 0.5 / 61 ≈ 0.008197
      const fused = reciprocalRankFusion([sourceA, sourceB])
      const highWeightIdx = fused.findIndex((f) => f.filePath === 'src/highWeight.ts')
      const lowWeightIdx = fused.findIndex((f) => f.filePath === 'src/lowWeight.ts')
      expect(highWeightIdx).toBeLessThan(lowWeightIdx)
    })

    it('eliminates contribution when source weight is 0', () => {
      const sourceActive: RankedSourceList = {
        sourceId: 'bm25',
        weight: 1.0,
        items: [{ filePath: 'src/active.ts' }]
      }
      const sourceIgnored: RankedSourceList = {
        sourceId: 'symbol',
        weight: 0,
        items: [{ filePath: 'src/ignored.ts' }, { filePath: 'src/active.ts' }]
      }

      const fused = reciprocalRankFusion([sourceActive, sourceIgnored])
      const ignoredItem = fused.find((f) => f.filePath === 'src/ignored.ts')
      expect(ignoredItem?.rrfScore).toBe(0)
      expect(fused[0].filePath).toBe('src/active.ts')
      expect(fused[0].sourceContributions['symbol']).toBe(0)
    })

    it('clamps negative or NaN weights safely', () => {
      const sourceNegative: RankedSourceList = {
        sourceId: 'bm25',
        weight: -1.5,
        items: [{ filePath: 'src/test.ts' }]
      }

      const fused = reciprocalRankFusion([sourceNegative])
      expect(fused.length).toBe(1)
      expect(fused[0].rrfScore).toBe(0)
    })
  })

  describe('Deterministic Tie-Breaking', () => {
    it('breaks ties in RRF score by contributing source count descending', () => {
      // We configure two items with the exact same RRF score:
      // Item A: present in 2 sources with weight 0.5 each at rank 1 => 0.5/61 + 0.5/61 = 1/61
      // Item B: present in 1 source with weight 1.0 at rank 1 => 1.0/61 = 1/61
      const source1: RankedSourceList = {
        sourceId: 'bm25',
        weight: 0.5,
        items: [{ filePath: 'src/twoSources.ts' }]
      }
      const source2: RankedSourceList = {
        sourceId: 'symbol',
        weight: 0.5,
        items: [{ filePath: 'src/twoSources.ts' }]
      }
      const source3: RankedSourceList = {
        sourceId: 'repoMap',
        weight: 1.0,
        items: [{ filePath: 'src/oneSource.ts' }]
      }

      const fused = reciprocalRankFusion([source1, source2, source3])
      expect(fused[0].rrfScore).toBe(fused[1].rrfScore)
      expect(fused[0].filePath).toBe('src/twoSources.ts')
      expect(fused[1].filePath).toBe('src/oneSource.ts')
    })

    it('breaks ties in score and source count by filePath ascending', () => {
      const source1: RankedSourceList = {
        sourceId: 'src1',
        weight: 1.0,
        items: [{ filePath: 'src/z_file.ts' }]
      }
      const source2: RankedSourceList = {
        sourceId: 'src2',
        weight: 1.0,
        items: [{ filePath: 'src/a_file.ts' }]
      }

      // Both rank 1 in 1 source with weight 1.0: same score (1/61) and source count (1)
      const fused = reciprocalRankFusion([source1, source2])
      expect(fused[0].filePath).toBe('src/a_file.ts')
      expect(fused[1].filePath).toBe('src/z_file.ts')
    })

    it('breaks ties deterministically and sorts matchedSymbols deterministically', () => {
      const source: RankedSourceList = {
        sourceId: 'bm25',
        weight: 1.0,
        items: [
          {
            filePath: 'src/item.ts',
            symbols: [
              {
                name: 'zebra',
                kind: 'function',
                filePath: 'src/item.ts',
                startLine: 10,
                startColumn: 1,
                endLine: 12,
                endColumn: 1,
                parent: null,
                exported: true
              },
              {
                name: 'alpha',
                kind: 'function',
                filePath: 'src/item.ts',
                startLine: 2,
                startColumn: 1,
                endLine: 5,
                endColumn: 1,
                parent: null,
                exported: true
              }
            ]
          }
        ]
      }

      const fused = reciprocalRankFusion([source])
      expect(fused.length).toBe(1)
      // Symbols sorted by startLine ascending
      expect(fused[0].matchedSymbols[0].name).toBe('alpha')
      expect(fused[0].matchedSymbols[1].name).toBe('zebra')
    })
  })

  describe('Edge Cases', () => {
    it('returns empty array when input sources array is empty', () => {
      const fused = reciprocalRankFusion([])
      expect(fused).toEqual([])
    })

    it('returns empty array when all sources contain empty items', () => {
      const fused = reciprocalRankFusion([
        { sourceId: 'bm25', weight: 1.0, items: [] },
        { sourceId: 'symbol', weight: 1.0, items: [] }
      ])
      expect(fused).toEqual([])
    })

    it('handles single item in single source correctly', () => {
      const fused = reciprocalRankFusion([
        {
          sourceId: 'bm25',
          weight: 1.0,
          items: [{ filePath: 'src/only.ts' }]
        }
      ])
      expect(fused.length).toBe(1)
      expect(fused[0].filePath).toBe('src/only.ts')
      expect(fused[0].fusedRank).toBe(1)
      expect(fused[0].rrfScore).toBe(0.016393)
    })

    it('returns empty array when maxResults is 0', () => {
      const fused = reciprocalRankFusion(
        [
          {
            sourceId: 'bm25',
            weight: 1.0,
            items: [{ filePath: 'src/doc.ts' }]
          }
        ],
        { maxResults: 0 }
      )
      expect(fused).toEqual([])
    })

    it('limits output correctly according to maxResults', () => {
      const items = Array.from({ length: 10 }, (_, i) => ({
        filePath: `src/doc_${i}.ts`
      }))

      const fused = reciprocalRankFusion([{ sourceId: 'bm25', weight: 1.0, items }], {
        maxResults: 4
      })
      expect(fused.length).toBe(4)
      expect(fused.map((f) => f.filePath)).toEqual([
        'src/doc_0.ts',
        'src/doc_1.ts',
        'src/doc_2.ts',
        'src/doc_3.ts'
      ])
    })

    it('deduplicates duplicate entries in a single source using the best (lowest) rank', () => {
      const sourceWithDups: RankedSourceList = {
        sourceId: 'bm25',
        weight: 1.0,
        items: [
          { filePath: 'src/dup.ts' },
          { filePath: 'src/other.ts' },
          { filePath: 'src/dup.ts' }
        ]
      }

      const fused = reciprocalRankFusion([sourceWithDups])
      expect(fused.length).toBe(2)
      const dup = fused.find((f) => f.filePath === 'src/dup.ts')
      expect(dup?.rrfScore).toBe(0.016393) // rank 1 score, not rank 3 or sum of both
      expect(dup?.sourceRanks['bm25']).toBe(1)
    })
  })

  describe('RRFSearchService Integration', () => {
    let symbolIndex: SymbolIndex
    let rrfService: RRFSearchService

    beforeEach(() => {
      symbolIndex = new SymbolIndex()
      symbolIndex.setKnownFiles(['src/authService.ts', 'src/tokenValidator.ts', 'src/billing.ts'])

      symbolIndex.indexFile(
        'src/authService.ts',
        `
import { validateToken } from './tokenValidator'

export class AuthService {
  public loginUser(username: string): string {
    return validateToken(username)
  }
}
`.trim()
      )

      symbolIndex.indexFile(
        'src/tokenValidator.ts',
        `
export function validateToken(token: string): string {
  return token.toUpperCase()
}
`.trim()
      )

      symbolIndex.indexFile(
        'src/billing.ts',
        `
export class BillingManager {
  public processPayment(): void {}
}
`.trim()
      )

      rrfService = new RRFSearchService(symbolIndex)
    })

    it('fuses BM25 and symbol search results with accurate source contributions', () => {
      const results = rrfService.search('loginUser validateToken')
      expect(results.length).toBeGreaterThan(0)

      const filePaths = results.map((r) => r.filePath)
      expect(filePaths).toContain('src/authService.ts')
      expect(filePaths).toContain('src/tokenValidator.ts')

      const topResult = results[0]
      expect(topResult.rrfScore).toBeGreaterThan(0)
      expect(topResult.contributingSources.length).toBeGreaterThanOrEqual(1)

      const sourceNames = topResult.contributingSources
      expect(sourceNames.some((n) => n === 'bm25' || n === 'symbol')).toBe(true)
    })

    it('boosts active file when activeFilePath context is provided', () => {
      const resultsWithActive = rrfService.search('validateToken', {
        activeFilePath: 'src/tokenValidator.ts'
      })

      const topResult = resultsWithActive[0]
      expect(topResult.filePath).toBe('src/tokenValidator.ts')
      expect(topResult.contributingSources.includes('activeContext')).toBe(true)
    })

    it('returns empty array when query is empty or whitespace', () => {
      expect(rrfService.search('')).toEqual([])
      expect(rrfService.search('   \t\n  ')).toEqual([])
    })

    it('respects minScoreThreshold option', () => {
      const results = rrfService.search('validateToken', {
        minScoreThreshold: 0.99 // Impossibly high threshold for standard single queries
      })
      expect(results).toEqual([])
    })
  })

  describe('SymbolIndex & SmartContextEngine End-to-End RRF Integration', () => {
    let engine: SmartContextEngine

    beforeEach(() => {
      engine = new SmartContextEngine()
      const symbolIndex = engine.getSymbolIndex()
      symbolIndex.setKnownFiles(['src/pipeline.ts', 'src/transformer.ts'])

      symbolIndex.indexFile(
        'src/pipeline.ts',
        `
import { DataTransformer } from './transformer'

export class DataPipeline {
  public runPipeline(): void {
    const t = new DataTransformer()
    t.transformData()
  }
}
`.trim()
      )

      symbolIndex.indexFile(
        'src/transformer.ts',
        `
export class DataTransformer {
  public transformData(): string {
    return 'transformed'
  }
}
`.trim()
      )
    })

    it('exposes searchCodeRRF via SymbolIndex directly', () => {
      const symbolIndex = engine.getSymbolIndex()
      const results = symbolIndex.searchCodeRRF('runPipeline')

      expect(results.length).toBeGreaterThan(0)
      expect(results[0].filePath).toBe('src/pipeline.ts')
      expect(results[0].matchedSymbols.some((s) => s.name === 'runPipeline')).toBe(true)
      expect(results[0].fusedRank).toBe(1)
    })

    it('exposes searchCodeRRF via SmartContextEngine delegating with active file context', () => {
      const results = engine.searchCodeRRF('transformData', {
        activeFilePath: 'src/transformer.ts',
        cursorLine: 2
      })

      expect(results.length).toBeGreaterThan(0)
      expect(results[0].filePath).toBe('src/transformer.ts')
      expect(results[0].contributingSources.includes('activeContext')).toBe(true)
    })

    it('returns empty array for empty queries via SmartContextEngine', () => {
      expect(engine.searchCodeRRF('')).toEqual([])
      expect(engine.searchCodeRRF('   ')).toEqual([])
    })
  })
})
