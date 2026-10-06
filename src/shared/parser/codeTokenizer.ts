/**
 * Code Identifier & Metadata Tokenizer (Phase 11.8)
 *
 * Provides deterministic tokenization for code identifiers across camelCase,
 * PascalCase, snake_case, and kebab-case conventions, along with path segment
 * decomposition and document metadata indexing.
 */

import { ExtractedSymbol } from './types'

export const CODE_STOP_WORDS = new Set([
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
  'find',
  'search',
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
 * Splits an identifier (camelCase, PascalCase, snake_case, kebab-case) into subwords.
 * Preserves numeric digits attached to letters.
 */
export function splitIdentifierSubwords(text: string): string[] {
  if (!text || typeof text !== 'string') return []

  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[\s_\-./\\:;,!?()[\]{}|"'`*+=&^%$#@~<>]+/)
    .filter((w) => w.length > 0)
}

/**
 * Tokenizes a code identifier into both subwords and full normalized form.
 *
 * Example:
 *   'AuthServiceManager' -> ['auth', 'service', 'manager', 'authservicemanager']
 *   'user_auth_token'   -> ['user', 'auth', 'token', 'userauthtoken']
 *   'payment-api'       -> ['payment', 'api', 'paymentapi']
 */
export function tokenizeIdentifier(identifier: string): string[] {
  if (!identifier || typeof identifier !== 'string') return []

  const subwords = splitIdentifierSubwords(identifier)
  const collapsed = identifier.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()

  const tokens = [...subwords]
  if (collapsed.length > 0 && !tokens.includes(collapsed)) {
    tokens.push(collapsed)
  }

  return tokens
}

/**
 * Extracts normalized query tokens from a search string.
 * Decomposes identifiers and filters common stop words unless query consists only of stop words.
 */
export function tokenizeQuery(query: string): string[] {
  if (!query || typeof query !== 'string' || !query.trim()) {
    return []
  }

  // 1. Split on whitespace, punctuation, and delimiters while keeping identifier words intact
  const rawWords = query
    .split(/[\s,;:!?()[\]{}|"'`*+=&^%$#@~<>\\/]+/)
    .filter((w) => w.length > 0)

  // 2. Expand each word into identifier tokens (subwords + collapsed)
  const expandedTokens: string[] = []
  for (const word of rawWords) {
    const idTokens = tokenizeIdentifier(word)
    if (idTokens.length > 0) {
      expandedTokens.push(...idTokens)
    } else {
      expandedTokens.push(word.toLowerCase())
    }
  }

  // 3. Filter stop words unless all words are stop words
  const nonStopWords = expandedTokens.filter((t) => !CODE_STOP_WORDS.has(t))
  const effectiveTokens = nonStopWords.length > 0 ? nonStopWords : expandedTokens

  // 4. Deduplicate deterministically
  return Array.from(new Set(effectiveTokens))
}

/**
 * Generates an indexed token stream representing a workspace file's code metadata.
 *
 * Encodes:
 * - Normalized file path & directory segments
 * - Base filename (weighted)
 * - Symbol names (subwords & full identifiers)
 * - Symbol kinds & exported status
 */
export function tokenizeDocumentMetadata(
  filePath: string,
  symbols: ExtractedSymbol[]
): string[] {
  const tokens: string[] = []
  const norm = filePath.replace(/\\/g, '/')
  const segments = norm.split('/')
  const fileName = segments[segments.length - 1] || ''
  const baseName = fileName.replace(/\.[^.]+$/, '')

  // 1. Directory path segments (e.g. 'src', 'auth', 'services')
  for (let i = 0; i < segments.length - 1; i++) {
    const segTokens = tokenizeIdentifier(segments[i])
    for (const t of segTokens) {
      if (!CODE_STOP_WORDS.has(t)) {
        tokens.push(t)
      }
    }
  }

  // 2. Base filename tokens (boosted term frequency: 3x)
  const baseTokens = tokenizeIdentifier(baseName)
  for (let repeat = 0; repeat < 3; repeat++) {
    for (const t of baseTokens) {
      tokens.push(t)
    }
  }

  // 3. Symbols
  for (const sym of symbols) {
    const symTokens = tokenizeIdentifier(sym.name)

    // Exported symbols receive 2x frequency, internal receive 1x
    const multiplier = sym.exported ? 2 : 1
    for (let r = 0; r < multiplier; r++) {
      for (const t of symTokens) {
        tokens.push(t)
      }
    }

    // Symbol kind (e.g. 'class', 'function', 'interface')
    if (sym.kind) {
      tokens.push(sym.kind.toLowerCase())
    }

    // Exported marker
    if (sym.exported) {
      tokens.push('exported')
    }

    // Parent name tokens if nested
    if (sym.parent) {
      const parentTokens = tokenizeIdentifier(sym.parent)
      for (const t of parentTokens) {
        tokens.push(t)
      }
    }
  }

  return tokens
}
