import { describe, it, expect } from 'vitest'
import {
  parseSearchReplaceBlocks,
  findBlockMatch,
  applySearchReplacePatch,
  levenshteinDistance,
  calculateSimilarity
} from '@shared/diffUtils'

describe('Search/Replace Block Patching Engine', () => {
  describe('Levenshtein Distance & Similarity Calculation', () => {
    it('returns 0 distance and 1.0 similarity for identical strings', () => {
      expect(levenshteinDistance('hello', 'hello')).toBe(0)
      expect(calculateSimilarity('hello', 'hello')).toBe(1.0)
      expect(levenshteinDistance('', '')).toBe(0)
      expect(calculateSimilarity('', '')).toBe(1.0)
    })

    it('calculates proper distance and similarity for different strings', () => {
      expect(levenshteinDistance('kitten', 'sitting')).toBe(3)
      const sim = calculateSimilarity('kitten', 'sitting')
      expect(sim).toBeCloseTo(1 - 3 / 7, 2)
    })

    it('handles empty strings gracefully', () => {
      expect(levenshteinDistance('', 'abc')).toBe(3)
      expect(calculateSimilarity('', 'abc')).toBe(0.0)
      expect(levenshteinDistance('abc', '')).toBe(3)
      expect(calculateSimilarity('abc', '')).toBe(0.0)
    })
  })

  describe('parseSearchReplaceBlocks', () => {
    it('rejects empty or whitespace-only patch text', () => {
      expect(parseSearchReplaceBlocks('').success).toBe(false)
      expect(parseSearchReplaceBlocks('   \n\t  ').success).toBe(false)
      expect(parseSearchReplaceBlocks(null as unknown as string).success).toBe(false)
    })

    it('rejects patch text missing <<<<<<< SEARCH marker', () => {
      const res = parseSearchReplaceBlocks('some random text without markers')
      expect(res.success).toBe(false)
      expect(res.error).toContain("missing '<<<<<<< SEARCH' marker")
    })

    it('rejects unclosed search block (missing =======)', () => {
      const patch = [
        '<<<<<<< SEARCH',
        'const x = 1;',
        'const y = 2;'
      ].join('\n')
      const res = parseSearchReplaceBlocks(patch)
      expect(res.success).toBe(false)
      expect(res.error).toContain("unclosed '<<<<<<< SEARCH' block")
    })

    it('rejects unclosed replacement block (missing >>>>>>> REPLACE)', () => {
      const patch = [
        '<<<<<<< SEARCH',
        'const x = 1;',
        '=======',
        'const x = 2;'
      ].join('\n')
      const res = parseSearchReplaceBlocks(patch)
      expect(res.success).toBe(false)
      expect(res.error).toContain("unclosed replacement block")
    })

    it('rejects empty SEARCH block', () => {
      const patch = [
        '<<<<<<< SEARCH',
        '=======',
        'const x = 2;',
        '>>>>>>> REPLACE'
      ].join('\n')
      const res = parseSearchReplaceBlocks(patch)
      expect(res.success).toBe(false)
      expect(res.error).toContain('SEARCH block cannot be empty')
    })

    it('rejects unexpected ======= outside of search block', () => {
      const patch = [
        '<<<<<<< SEARCH',
        'const x = 1;',
        '=======',
        'const x = 2;',
        '>>>>>>> REPLACE',
        '=======',
        'const x = 3;'
      ].join('\n')
      const res = parseSearchReplaceBlocks(patch)
      expect(res.success).toBe(false)
      expect(res.error).toContain("unexpected '=======' separator")
    })

    it('rejects unexpected >>>>>>> REPLACE outside of any block', () => {
      const patch = '>>>>>>> REPLACE'
      const res = parseSearchReplaceBlocks(patch)
      expect(res.success).toBe(false)
    })

    it('rejects nested or duplicate <<<<<<< SEARCH without closing', () => {
      const patch = [
        '<<<<<<< SEARCH',
        'const x = 1;',
        '<<<<<<< SEARCH',
        'const y = 2;',
        '=======',
        'const y = 3;',
        '>>>>>>> REPLACE'
      ].join('\n')
      const res = parseSearchReplaceBlocks(patch)
      expect(res.success).toBe(false)
      expect(res.error).toContain("unexpected '<<<<<<< SEARCH'")
    })

    it('successfully parses single search/replace block', () => {
      const patch = [
        '<<<<<<< SEARCH',
        'function add(a, b) {',
        '  return a - b;',
        '}',
        '=======',
        'function add(a, b) {',
        '  return a + b;',
        '}',
        '>>>>>>> REPLACE'
      ].join('\n')

      const res = parseSearchReplaceBlocks(patch)
      expect(res.success).toBe(true)
      expect(res.blocks).toHaveLength(1)
      expect(res.blocks![0].search).toBe('function add(a, b) {\n  return a - b;\n}')
      expect(res.blocks![0].replace).toBe('function add(a, b) {\n  return a + b;\n}')
    })

    it('successfully parses multiple search/replace blocks', () => {
      const patch = [
        'Some preamble explanation',
        '<<<<<<< SEARCH',
        'const a = 1;',
        '=======',
        'const a = 10;',
        '>>>>>>> REPLACE',
        'Mid commentary',
        '<<<<<<< SEARCH',
        'const b = 2;',
        '=======',
        'const b = 20;',
        '>>>>>>> REPLACE'
      ].join('\n')

      const res = parseSearchReplaceBlocks(patch)
      expect(res.success).toBe(true)
      expect(res.blocks).toHaveLength(2)
      expect(res.blocks![0].search).toBe('const a = 1;')
      expect(res.blocks![0].replace).toBe('const a = 10;')
      expect(res.blocks![1].search).toBe('const b = 2;')
      expect(res.blocks![1].replace).toBe('const b = 20;')
    })
  })

  describe('findBlockMatch', () => {
    const sampleContent = [
      'import { useState } from "react";',
      '',
      'export function Counter() {',
      '  const [count, setCount] = useState(0);',
      '',
      '  const increment = () => {',
      '    setCount(count - 1);',
      '  };',
      '',
      '  return (',
      '    <div>',
      '      <p>Count: {count}</p>',
      '      <button onClick={increment}>+</button>',
      '    </div>',
      '  );',
      '}'
    ].join('\n')

    it('finds exact single-block match uniquely', () => {
      const search = [
        '  const increment = () => {',
        '    setCount(count - 1);',
        '  };'
      ].join('\n')

      const match = findBlockMatch(sampleContent, search)
      expect(match.matched).toBe(true)
      expect(match.matchType).toBe('exact')
      expect(match.similarity).toBe(1.0)
      expect(sampleContent.slice(match.startIndex!, match.endIndex!)).toBe(search)
    })

    it('rejects ambiguous exact match (found multiple times)', () => {
      const duplicateContent = 'foo\nbar\nfoo\nbar'
      const match = findBlockMatch(duplicateContent, 'bar')
      expect(match.matched).toBe(false)
      expect(match.error).toContain('Ambiguous match')
      expect(match.error).toContain('2 times')
    })

    it('rejects exact match when search string is not found and fuzzy similarity < 0.85', () => {
      const search = 'function completelyDifferentCode() {\n  return 999;\n}'
      const match = findBlockMatch(sampleContent, search)
      expect(match.matched).toBe(false)
      expect(match.error).toContain('SEARCH block not found in file')
    })

    it('tolerates line ending differences (CRLF in content vs LF in search)', () => {
      const crlfContent = 'line 1\r\nline 2\r\nline 3'
      const lfSearch = 'line 2'
      const match = findBlockMatch(crlfContent, lfSearch)
      expect(match.matched).toBe(true)
      expect(match.matchType).toBe('exact')
    })

    it('performs fuzzy match fallback for whitespace / indentation differences', () => {
      // Content has 2 spaces indent, search has 4 spaces indent or slightly different spaces
      const searchWithDifferentIndent = [
        '    const increment = () => {',
        '        setCount(count - 1);',
        '    };'
      ].join('\n')

      const match = findBlockMatch(sampleContent, searchWithDifferentIndent)
      expect(match.matched).toBe(true)
      expect(match.matchType).toBe('fuzzy')
      expect(match.similarity).toBeGreaterThanOrEqual(0.85)
      expect(sampleContent.slice(match.startIndex!, match.endIndex!)).toContain('setCount(count - 1);')
    })

    it('rejects fuzzy match when best similarity is below 0.85 threshold', () => {
      const lowSimilaritySearch = [
        '  const incrementSpecial = (x, y) => {',
        '    setCount(count - 999 + x);',
        '    console.log("unrelated");',
        '  };'
      ].join('\n')

      const match = findBlockMatch(sampleContent, lowSimilaritySearch, { fuzzyThreshold: 0.85 })
      expect(match.matched).toBe(false)
      expect(match.error).toContain('SEARCH block not found in file')
    })

    it('rejects fuzzy match when multiple candidate windows tie dangerously close (ambiguous match)', () => {
      const repeatedStructure = [
        'function itemA() {',
        '  const val = 100;',
        '  return val;',
        '}',
        '',
        'function itemB() {',
        '  const val = 100;',
        '  return val;',
        '}'
      ].join('\n')

      // Search matches both functions almost identically
      const search = [
        'function item() {',
        '  const val = 100;',
        '  return val;',
        '}'
      ].join('\n')

      const match = findBlockMatch(repeatedStructure, search)
      expect(match.matched).toBe(false)
      expect(match.error).toContain('Ambiguous match')
    })
  })

  describe('applySearchReplacePatch', () => {
    const baseCode = [
      'function add(a, b) {',
      '  return a - b;',
      '}',
      '',
      'function multiply(a, b) {',
      '  return a + b;',
      '}'
    ].join('\n')

    it('replaces exact single block correctly', () => {
      const patch = [
        '<<<<<<< SEARCH',
        'function add(a, b) {',
        '  return a - b;',
        '}',
        '=======',
        'function add(a, b) {',
        '  return a + b;',
        '}',
        '>>>>>>> REPLACE'
      ].join('\n')

      const result = applySearchReplacePatch(baseCode, patch)
      expect(result.success).toBe(true)
      expect(result.appliedCount).toBe(1)
      expect(result.content).toBe([
        'function add(a, b) {',
        '  return a + b;',
        '}',
        '',
        'function multiply(a, b) {',
        '  return a + b;',
        '}'
      ].join('\n'))
    })

    it('replaces multiple blocks atomically in order', () => {
      const patch = [
        '<<<<<<< SEARCH',
        'function add(a, b) {',
        '  return a - b;',
        '}',
        '=======',
        'function add(a, b) {',
        '  return a + b;',
        '}',
        '>>>>>>> REPLACE',
        '<<<<<<< SEARCH',
        'function multiply(a, b) {',
        '  return a + b;',
        '}',
        '=======',
        'function multiply(a, b) {',
        '  return a * b;',
        '}',
        '>>>>>>> REPLACE'
      ].join('\n')

      const result = applySearchReplacePatch(baseCode, patch)
      expect(result.success).toBe(true)
      expect(result.appliedCount).toBe(2)
      expect(result.content).toBe([
        'function add(a, b) {',
        '  return a + b;',
        '}',
        '',
        'function multiply(a, b) {',
        '  return a * b;',
        '}'
      ].join('\n'))
    })

    it('safely handles replacement strings containing special characters ($1, $&, quotes, backslashes)', () => {
      const content = 'const template = "PLACEHOLDER";'
      const patch = [
        '<<<<<<< SEARCH',
        'const template = "PLACEHOLDER";',
        '=======',
        'const template = "$1 $& $\' `test` \"quoted\" \\n \\t";',
        '>>>>>>> REPLACE'
      ].join('\n')

      const result = applySearchReplacePatch(content, patch)
      expect(result.success).toBe(true)
      // Must NOT be corrupted by String.prototype.replace escape tokens
      expect(result.content).toBe('const template = "$1 $& $\' `test` \"quoted\" \\n \\t";')
    })

    it('handles replacement containing multiline code', () => {
      const content = 'function greet() {\n  return "hi";\n}'
      const patch = [
        '<<<<<<< SEARCH',
        '  return "hi";',
        '=======',
        '  const name = "World";',
        '  const message = `Hello ${name}!`;',
        '  return message;',
        '>>>>>>> REPLACE'
      ].join('\n')

      const result = applySearchReplacePatch(content, patch)
      expect(result.success).toBe(true)
      expect(result.content).toBe([
        'function greet() {',
        '  const name = "World";',
        '  const message = `Hello ${name}!`;',
        '  return message;',
        '}'
      ].join('\n'))
    })

    it('applies whitespace-tolerant fuzzy match in applySearchReplacePatch', () => {
      const content = [
        'class User {',
        '  constructor(name) {',
        '    this.name = name;',
        '  }',
        '}'
      ].join('\n')

      // 4 spaces indentation in search instead of 2 spaces
      const patch = [
        '<<<<<<< SEARCH',
        '    constructor(name) {',
        '        this.name = name;',
        '    }',
        '=======',
        '  constructor(name, role = "user") {',
        '    this.name = name;',
        '    this.role = role;',
        '  }',
        '>>>>>>> REPLACE'
      ].join('\n')

      const result = applySearchReplacePatch(content, patch)
      expect(result.success).toBe(true)
      expect(result.matchedBy).toEqual(['fuzzy'])
      expect(result.content).toContain('this.role = role;')
    })

    it('guarantees atomicity: when second block fails, first block is NOT applied', () => {
      const original = [
        'const first = 1;',
        'const second = 2;',
        'const third = 3;'
      ].join('\n')

      const patch = [
        '<<<<<<< SEARCH',
        'const first = 1;',
        '=======',
        'const first = 100;',
        '>>>>>>> REPLACE',
        '<<<<<<< SEARCH',
        'const nonexistent = 999;',
        '=======',
        'const nonexistent = 0;',
        '>>>>>>> REPLACE'
      ].join('\n')

      const result = applySearchReplacePatch(original, patch)
      expect(result.success).toBe(false)
      expect(result.error).toContain('Patch failed at block 2 of 2')
      // Original content is NOT modified or returned as new content
      expect(result.content).toBeUndefined()
    })

    it('handles unchanged replacement (search === replace)', () => {
      const original = 'const val = 42;'
      const patch = [
        '<<<<<<< SEARCH',
        'const val = 42;',
        '=======',
        'const val = 42;',
        '>>>>>>> REPLACE'
      ].join('\n')

      const result = applySearchReplacePatch(original, patch)
      expect(result.success).toBe(true)
      expect(result.content).toBe(original)
    })

    it('rejects patch when search block matches multiple locations (ambiguous)', () => {
      const original = 'item\nitem\nitem'
      const patch = [
        '<<<<<<< SEARCH',
        'item',
        '=======',
        'item_updated',
        '>>>>>>> REPLACE'
      ].join('\n')

      const result = applySearchReplacePatch(original, patch)
      expect(result.success).toBe(false)
      expect(result.error).toContain('Ambiguous match')
    })

    it('accepts array of PatchBlocks directly', () => {
      const original = 'let x = 1;'
      const blocks = [{ search: 'let x = 1;', replace: 'let x = 10;' }]
      const result = applySearchReplacePatch(original, blocks)
      expect(result.success).toBe(true)
      expect(result.content).toBe('let x = 10;')
    })

    it('rejects invalid patch argument types', () => {
      expect(applySearchReplacePatch('abc', 123 as unknown as string).success).toBe(false)
      expect(applySearchReplacePatch('abc', []).success).toBe(false)
    })
  })
})
