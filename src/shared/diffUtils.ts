/**
 * Git Diff and Language Utilities
 * Parses unified diffs into original and modified chunks for Monaco DiffEditor,
 * and provides language detection by file extension.
 */

export interface ParsedDiff {
  original: string
  modified: string
  hasChanges: boolean
}

/**
 * Parses unified diff text into original (base) and modified (target) text streams.
 */
export function parseUnifiedDiff(diffText: string): ParsedDiff {
  if (!diffText || typeof diffText !== 'string') {
    return { original: '', modified: '', hasChanges: false }
  }

  const lines = diffText.split(/\r?\n/)
  const originalLines: string[] = []
  const modifiedLines: string[] = []
  let inHunk = false
  let hasChanges = false
  let hunkCount = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (line.startsWith('@@')) {
      if (inHunk && (originalLines.length > 0 || modifiedLines.length > 0)) {
        // Add a visual hunk separator between non-contiguous hunks
        originalLines.push(`--- (hunk ${hunkCount}) ---`)
        modifiedLines.push(`--- (hunk ${hunkCount}) ---`)
      }
      hunkCount++
      inHunk = true
      continue
    }

    if (!inHunk) continue

    if (line.startsWith('+')) {
      hasChanges = true
      modifiedLines.push(line.slice(1))
    } else if (line.startsWith('-')) {
      hasChanges = true
      originalLines.push(line.slice(1))
    } else if (line.startsWith(' ')) {
      originalLines.push(line.slice(1))
      modifiedLines.push(line.slice(1))
    } else if (line.startsWith('\\')) {
      // e.g. '\ No newline at end of file' - skip
    }
  }

  return {
    original: originalLines.join('\n'),
    modified: modifiedLines.join('\n'),
    hasChanges
  }
}

/**
 * Detect language by file extension for Monaco Editor syntax highlighting.
 */
export function detectLanguage(filePath: string | null): string {
  if (!filePath) return 'plaintext'

  const ext = filePath.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'ts':
      return 'typescript'
    case 'tsx':
      return 'typescript'
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'javascript'
    case 'jsx':
      return 'javascript'
    case 'json':
      return 'json'
    case 'html':
    case 'htm':
      return 'html'
    case 'css':
      return 'css'
    case 'scss':
    case 'less':
      return 'css'
    case 'md':
    case 'markdown':
      return 'markdown'
    case 'py':
      return 'python'
    case 'rs':
      return 'rust'
    case 'go':
      return 'go'
    case 'java':
      return 'java'
    case 'c':
    case 'h':
      return 'c'
    case 'cpp':
    case 'hpp':
    case 'cc':
      return 'cpp'
    case 'yaml':
    case 'yml':
      return 'yaml'
    case 'xml':
    case 'svg':
      return 'xml'
    case 'sql':
      return 'sql'
    case 'sh':
    case 'bash':
      return 'shell'
    default:
      return 'plaintext'
  }
}

// ============================================================================
// Search/Replace Block Patching Engine (Industrial Fast-Apply)
// ============================================================================

export interface PatchBlock {
  search: string
  replace: string
}

export interface ParsePatchResult {
  success: boolean
  blocks?: PatchBlock[]
  error?: string
}

export interface ApplyPatchOptions {
  fuzzyThreshold?: number
}

export interface ApplyPatchResult {
  success: boolean
  content?: string
  error?: string
  matchedBy?: Array<'exact' | 'fuzzy'>
  appliedCount?: number
}

export interface BlockMatchResult {
  matched: boolean
  matchType?: 'exact' | 'fuzzy'
  startIndex?: number
  endIndex?: number
  matchedText?: string
  similarity?: number
  error?: string
}

/**
 * Computes memory-optimized Levenshtein distance between two strings using 2-row algorithm.
 * O(M * N) time complexity, O(min(M, N)) space complexity.
 */
export function levenshteinDistance(s1: string, s2: string): number {
  if (s1 === s2) return 0
  if (s1.length === 0) return s2.length
  if (s2.length === 0) return s1.length

  // Ensure s1 is shorter to minimize space
  let a = s1
  let b = s2
  if (a.length > b.length) {
    a = s2
    b = s1
  }

  const m = a.length
  const n = b.length
  let prevRow = new Array<number>(m + 1)
  let currRow = new Array<number>(m + 1)

  for (let i = 0; i <= m; i++) {
    prevRow[i] = i
  }

  for (let j = 1; j <= n; j++) {
    currRow[0] = j
    const char2 = b.charCodeAt(j - 1)

    for (let i = 1; i <= m; i++) {
      const cost = a.charCodeAt(i - 1) === char2 ? 0 : 1
      currRow[i] = Math.min(
        currRow[i - 1] + 1,      // insertion
        prevRow[i] + 1,          // deletion
        prevRow[i - 1] + cost    // substitution
      )
    }

    const tmp = prevRow
    prevRow = currRow
    currRow = tmp
  }

  return prevRow[m]
}

/**
 * Calculates similarity ratio between two strings: 1.0 (identical) to 0.0 (completely different).
 */
export function calculateSimilarity(a: string, b: string): number {
  if (a === b) return 1.0
  if (a.length === 0 && b.length === 0) return 1.0
  if (a.length === 0 || b.length === 0) return 0.0

  const maxLen = Math.max(a.length, b.length)
  if (maxLen === 0) return 1.0

  const dist = levenshteinDistance(a, b)
  return 1 - dist / maxLen
}

/**
 * Parses one or more SEARCH/REPLACE blocks formatted as:
 * <<<<<<< SEARCH
 * [code to find]
 * =======
 * [replacement code]
 * >>>>>>> REPLACE
 */
export function parseSearchReplaceBlocks(patchText: string): ParsePatchResult {
  if (!patchText || typeof patchText !== 'string' || !patchText.trim()) {
    return {
      success: false,
      error: 'Malformed patch: patch content is empty or invalid.'
    }
  }

  if (!patchText.includes('<<<<<<< SEARCH')) {
    return {
      success: false,
      error: "Malformed patch: missing '<<<<<<< SEARCH' marker."
    }
  }

  const lines = patchText.split(/\r?\n/)
  const blocks: PatchBlock[] = []

  let state: 'OUTSIDE' | 'IN_SEARCH' | 'IN_REPLACE' = 'OUTSIDE'
  let currentSearchLines: string[] = []
  let currentReplaceLines: string[] = []
  let blockStartLine = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()

    if (trimmed === '<<<<<<< SEARCH' || trimmed.startsWith('<<<<<<< SEARCH')) {
      if (state === 'IN_SEARCH') {
        return {
          success: false,
          error: `Malformed patch at line ${i + 1}: unexpected '<<<<<<< SEARCH' without closing previous search block started at line ${blockStartLine}.`
        }
      }
      if (state === 'IN_REPLACE') {
        return {
          success: false,
          error: `Malformed patch at line ${i + 1}: unexpected '<<<<<<< SEARCH' inside replacement block started at line ${blockStartLine}. Missing '>>>>>>> REPLACE'.`
        }
      }
      state = 'IN_SEARCH'
      blockStartLine = i + 1
      currentSearchLines = []
      continue
    }

    if (trimmed === '=======' || trimmed.startsWith('=======')) {
      if (state === 'OUTSIDE') {
        return {
          success: false,
          error: `Malformed patch at line ${i + 1}: unexpected '=======' separator without opening '<<<<<<< SEARCH'.`
        }
      }
      if (state === 'IN_REPLACE') {
        return {
          success: false,
          error: `Malformed patch at line ${i + 1}: duplicate '=======' separator in block started at line ${blockStartLine}.`
        }
      }
      state = 'IN_REPLACE'
      currentReplaceLines = []
      continue
    }

    if (trimmed === '>>>>>>> REPLACE' || trimmed.startsWith('>>>>>>> REPLACE')) {
      if (state === 'OUTSIDE') {
        return {
          success: false,
          error: `Malformed patch at line ${i + 1}: unexpected '>>>>>>> REPLACE' closing marker without opening '<<<<<<< SEARCH'.`
        }
      }
      if (state === 'IN_SEARCH') {
        return {
          success: false,
          error: `Malformed patch at line ${i + 1}: unexpected '>>>>>>> REPLACE' marker without '=======' separator in block started at line ${blockStartLine}.`
        }
      }

      const searchStr = currentSearchLines.join('\n')
      const replaceStr = currentReplaceLines.join('\n')

      if (searchStr.length === 0) {
        return {
          success: false,
          error: `Malformed patch in block started at line ${blockStartLine}: SEARCH block cannot be empty. Specify existing code to replace.`
        }
      }

      blocks.push({
        search: searchStr,
        replace: replaceStr
      })

      state = 'OUTSIDE'
      continue
    }

    if (state === 'IN_SEARCH') {
      currentSearchLines.push(line)
    } else if (state === 'IN_REPLACE') {
      currentReplaceLines.push(line)
    }
  }

  if (state === 'IN_SEARCH') {
    return {
      success: false,
      error: `Malformed patch: unclosed '<<<<<<< SEARCH' block started at line ${blockStartLine}. Missing '=======' and '>>>>>>> REPLACE'.`
    }
  }

  if (state === 'IN_REPLACE') {
    return {
      success: false,
      error: `Malformed patch: unclosed replacement block started at line ${blockStartLine}. Missing '>>>>>>> REPLACE' marker.`
    }
  }

  if (blocks.length === 0) {
    return {
      success: false,
      error: 'Malformed patch: no valid SEARCH/REPLACE blocks found.'
    }
  }

  return {
    success: true,
    blocks
  }
}

/**
 * Finds all character indices where `target` occurs in `source`.
 */
function findOccurrences(source: string, target: string): number[] {
  const indices: number[] = []
  if (!target) return indices
  let pos = 0
  while (pos < source.length) {
    const found = source.indexOf(target, pos)
    if (found === -1) break
    indices.push(found)
    pos = found + 1
  }
  return indices
}

/**
 * Normalizes text line endings to match the requested format.
 */
function normalizeLineEndings(text: string, toCrlf: boolean): string {
  if (toCrlf) {
    return text.replace(/\r?\n/g, '\r\n')
  } else {
    return text.replace(/\r\n/g, '\n')
  }
}

interface LineInfo {
  start: number
  end: number
  text: string
}

/**
 * Breaks text into line records tracking character offsets.
 */
function getLineInfos(text: string): LineInfo[] {
  const lines: LineInfo[] = []
  let pos = 0
  const rawLines = text.split(/\r?\n/)
  for (let i = 0; i < rawLines.length; i++) {
    const lineText = rawLines[i]
    const start = pos
    const end = start + lineText.length
    if (
      pos + lineText.length + 1 < text.length &&
      text.slice(pos + lineText.length, pos + lineText.length + 2) === '\r\n'
    ) {
      pos += lineText.length + 2
    } else if (
      pos + lineText.length < text.length &&
      (text[pos + lineText.length] === '\n' || text[pos + lineText.length] === '\r')
    ) {
      pos += lineText.length + 1
    } else {
      pos += lineText.length
    }
    lines.push({ start, end, text: lineText })
  }
  return lines
}

function normalizeWhitespace(line: string): string {
  return line.trim().replace(/\s+/g, ' ')
}

/**
 * Finds a match for a single SEARCH block within target content.
 * Follows exact match first, ambiguous match protection, and fuzzy match fallback with 0.85 threshold.
 */
export function findBlockMatch(
  content: string,
  search: string,
  options?: ApplyPatchOptions
): BlockMatchResult {
  if (!search) {
    return {
      matched: false,
      error: 'SEARCH block cannot be empty.'
    }
  }

  // --------------------------------------------------------------------------
  // 1. Exact Match First (Fast Path: O(N))
  // --------------------------------------------------------------------------
  let matches = findOccurrences(content, search)
  let matchedText = search

  if (matches.length === 0) {
    const isCrlf = content.includes('\r\n')
    const normalizedSearch = normalizeLineEndings(search, isCrlf)
    if (normalizedSearch !== search) {
      matches = findOccurrences(content, normalizedSearch)
      if (matches.length > 0) {
        matchedText = normalizedSearch
      }
    }
  }

  // Ambiguity Protection for Exact Match
  if (matches.length > 1) {
    return {
      matched: false,
      error: `Ambiguous match: SEARCH block was found ${matches.length} times in the file. Provide more surrounding context lines to make it unique.`
    }
  }

  if (matches.length === 1) {
    const startIndex = matches[0]
    const endIndex = startIndex + matchedText.length
    return {
      matched: true,
      matchType: 'exact',
      startIndex,
      endIndex,
      matchedText,
      similarity: 1.0
    }
  }

  // --------------------------------------------------------------------------
  // 2. Fuzzy Match Fallback (Whitespace / Indentation Tolerant: threshold 0.85)
  // --------------------------------------------------------------------------
  const fuzzyThreshold = options?.fuzzyThreshold ?? 0.85
  const lineInfos = getLineInfos(content)
  const searchLines = search.split(/\r?\n/)
  const m = searchLines.length

  if (lineInfos.length < m) {
    return {
      matched: false,
      error: `SEARCH block not found in file (file has ${lineInfos.length} lines, but search block requires ${m} lines).`
    }
  }

  interface Candidate {
    startIndex: number
    endIndex: number
    matchedText: string
    similarity: number
  }

  const candidates: Candidate[] = []

  // Slide window of size m across the file
  for (let i = 0; i <= lineInfos.length - m; i++) {
    const windowStart = lineInfos[i].start
    const windowEnd = lineInfos[i + m - 1].end
    const windowSlice = content.slice(windowStart, windowEnd)

    // A. Check for 100% whitespace/indentation normalized match
    let allNormalizedLinesMatch = true
    for (let k = 0; k < m; k++) {
      if (normalizeWhitespace(searchLines[k]) !== normalizeWhitespace(lineInfos[i + k].text)) {
        allNormalizedLinesMatch = false
        break
      }
    }

    if (allNormalizedLinesMatch) {
      const rawSim = calculateSimilarity(search, windowSlice)
      const sim = Math.max(rawSim, 0.95) // High confidence whitespace match
      candidates.push({
        startIndex: windowStart,
        endIndex: windowEnd,
        matchedText: windowSlice,
        similarity: sim
      })
      continue
    }

    // B. Calculate Levenshtein similarity on the window slice
    const sim = calculateSimilarity(search, windowSlice)
    if (sim >= fuzzyThreshold) {
      candidates.push({
        startIndex: windowStart,
        endIndex: windowEnd,
        matchedText: windowSlice,
        similarity: sim
      })
    }
  }

  // Also check window of size m - 1 and m + 1 if m > 2 to handle minor blank line differences
  if (m > 2) {
    const altSizes = [m - 1, m + 1]
    for (const altSize of altSizes) {
      if (altSize <= 0 || altSize > lineInfos.length) continue
      for (let i = 0; i <= lineInfos.length - altSize; i++) {
        const windowStart = lineInfos[i].start
        const windowEnd = lineInfos[i + altSize - 1].end
        const windowSlice = content.slice(windowStart, windowEnd)
        const sim = calculateSimilarity(search, windowSlice)
        if (sim >= fuzzyThreshold) {
          // Avoid duplicate range
          const exists = candidates.some(
            (c) => c.startIndex === windowStart && c.endIndex === windowEnd
          )
          if (!exists) {
            candidates.push({
              startIndex: windowStart,
              endIndex: windowEnd,
              matchedText: windowSlice,
              similarity: sim
            })
          }
        }
      }
    }
  }

  if (candidates.length === 0) {
    return {
      matched: false,
      error: `SEARCH block not found in file (closest fuzzy similarity was below the ${fuzzyThreshold} threshold).`
    }
  }

  // Sort candidates by similarity descending
  candidates.sort((a, b) => b.similarity - a.similarity)

  // Ambiguity Protection for Fuzzy Match
  if (candidates.length > 1) {
    const diff = candidates[0].similarity - candidates[1].similarity
    if (diff < 0.03) {
      return {
        matched: false,
        error: `Ambiguous match: SEARCH block matches multiple locations with similar similarity (~${(candidates[0].similarity * 100).toFixed(0)}%). Provide more surrounding context lines.`
      }
    }
  }

  const best = candidates[0]
  return {
    matched: true,
    matchType: 'fuzzy',
    startIndex: best.startIndex,
    endIndex: best.endIndex,
    matchedText: best.matchedText,
    similarity: best.similarity
  }
}

/**
 * Atomically applies one or more SEARCH/REPLACE blocks to originalContent.
 * If ANY block fails (not found, ambiguous, malformed), the entire patch is rejected
 * and originalContent is returned untouched with an error.
 */
export function applySearchReplacePatch(
  originalContent: string,
  patchTextOrBlocks: string | PatchBlock[],
  options?: ApplyPatchOptions
): ApplyPatchResult {
  let blocks: PatchBlock[]

  if (typeof patchTextOrBlocks === 'string') {
    const parseRes = parseSearchReplaceBlocks(patchTextOrBlocks)
    if (!parseRes.success || !parseRes.blocks) {
      return {
        success: false,
        error: parseRes.error || 'Failed to parse patch.'
      }
    }
    blocks = parseRes.blocks
  } else if (Array.isArray(patchTextOrBlocks)) {
    if (patchTextOrBlocks.length === 0) {
      return {
        success: false,
        error: 'No patch blocks provided.'
      }
    }
    for (let b = 0; b < patchTextOrBlocks.length; b++) {
      if (!patchTextOrBlocks[b].search || patchTextOrBlocks[b].search.length === 0) {
        return {
          success: false,
          error: `Malformed patch in block ${b + 1}: SEARCH block cannot be empty.`
        }
      }
    }
    blocks = patchTextOrBlocks
  } else {
    return {
      success: false,
      error: 'Invalid patch argument: expected string or array of PatchBlocks.'
    }
  }

  let workingContent = originalContent
  const matchedBy: Array<'exact' | 'fuzzy'> = []

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    const match = findBlockMatch(workingContent, block.search, options)

    if (!match.matched || match.startIndex === undefined || match.endIndex === undefined) {
      // Atomic rollback: workingContent is discarded
      return {
        success: false,
        error: `Patch failed at block ${i + 1} of ${blocks.length}: ${match.error || 'Match failed.'}`
      }
    }

    matchedBy.push(match.matchType || 'exact')

    // Adapt replacement line endings to match workingContent
    const useCrlf = workingContent.includes('\r\n')
    const adaptedReplace = normalizeLineEndings(block.replace, useCrlf)

    // Splice replacement safely without using String.replace to avoid special '$' patterns
    workingContent =
      workingContent.slice(0, match.startIndex) +
      adaptedReplace +
      workingContent.slice(match.endIndex)
  }

  return {
    success: true,
    content: workingContent,
    matchedBy,
    appliedCount: blocks.length
  }
}

// ============================================================================
// Line Range Slicing Utility (Surgical Code Slicing)
// ============================================================================

export interface SlicedLinesResult {
  content: string
  startLine: number
  endLine: number
  totalLines: number
  clipped: boolean
  lineCount: number
}

/**
 * Slices a specific 1-based line range from raw text content.
 * Handles both LF and CRLF line endings cleanly.
 */
export function sliceContentLines(
  rawContent: string,
  startLine: number,
  endLine: number
): SlicedLinesResult {
  if (!rawContent || rawContent.length === 0) {
    return {
      content: '',
      startLine: 0,
      endLine: 0,
      totalLines: 0,
      clipped: true,
      lineCount: 0
    }
  }

  const lines = rawContent.split(/\r?\n/)
  const totalLines = lines.length

  if (startLine > totalLines) {
    return {
      content: '',
      startLine,
      endLine: totalLines,
      totalLines,
      clipped: true,
      lineCount: 0
    }
  }

  const actualStart = Math.max(1, startLine)
  const isClipped = endLine > totalLines
  const actualEnd = isClipped ? totalLines : endLine

  const selected = lines.slice(actualStart - 1, actualEnd)
  return {
    content: selected.join('\n'),
    startLine: actualStart,
    endLine: actualEnd,
    totalLines,
    clipped: isClipped,
    lineCount: selected.length
  }
}
