/**
 * Terminal Output Sanitization and Head/Tail Compression
 *
 * Provides utilities to sanitize terminal/shell output (stripping ANSI color/style
 * escape sequences, cursor movements, OSC sequences, erase controls, and C0 control codes)
 * and perform deterministic head/tail compression for large outputs before injecting
 * them into AI context or tool execution results.
 *
 * Architecture Guideline:
 * - HEAD: first 5 lines
 * - TAIL: last 25 lines
 * - Marker: [... N lines omitted ...]
 * - Safe per-line and total character bounds to prevent token budget exhaustion
 */

export const DEFAULT_HEAD_LINES = 5
export const DEFAULT_TAIL_LINES = 25
export const DEFAULT_MAX_LINES = 30
export const DEFAULT_MAX_CHARS_PER_LINE = 2000
export const DEFAULT_MAX_TOTAL_CHARS = 16000

export interface TerminalCompressionOptions {
  /**
   * Number of lines to preserve at the start of output.
   * Default: 5
   */
  headLines?: number

  /**
   * Number of lines to preserve at the end of output.
   * Default: 25
   */
  tailLines?: number

  /**
   * Maximum lines before head/tail compression is triggered.
   * Default: headLines + tailLines (30)
   */
  maxLines?: number

  /**
   * Maximum allowed characters for any individual line before truncation.
   * Default: 2000
   */
  maxCharsPerLine?: number

  /**
   * Overall maximum character ceiling for the entire returned output.
   * Default: 16000
   */
  maxTotalChars?: number
}

export interface TerminalCompressionResult {
  /**
   * The compressed (or complete) text output.
   */
  text: string

  /**
   * Total number of lines in the input prior to line compression.
   */
  originalLineCount: number

  /**
   * Number of original lines preserved in the output (excluding the omission marker).
   */
  returnedLineCount: number

  /**
   * True if line compression occurred (middle lines were omitted).
   */
  isCompressed: boolean

  /**
   * Number of lines omitted between head and tail.
   */
  omittedLineCount: number

  /**
   * True if any line exceeded maxCharsPerLine or total output exceeded maxTotalChars.
   */
  isCharacterTruncated: boolean
}

export const DEFAULT_TERMINAL_COMPRESSION_OPTIONS: Required<TerminalCompressionOptions> = {
  headLines: DEFAULT_HEAD_LINES,
  tailLines: DEFAULT_TAIL_LINES,
  maxLines: DEFAULT_MAX_LINES,
  maxCharsPerLine: DEFAULT_MAX_CHARS_PER_LINE,
  maxTotalChars: DEFAULT_MAX_TOTAL_CHARS
}

/**
 * Sanitizes raw terminal output by stripping ANSI escape codes, terminal control sequences,
 * OSC sequences, cursor movements, screen clearing codes, and non-printable control characters,
 * while strictly preserving readable printable text, meaningful whitespace, newlines, tabs, and Unicode.
 *
 * Safe against malformed or incomplete escape sequences at buffer boundaries.
 */
export function sanitizeTerminalOutput(raw: string): string {
  if (!raw) return ''
  if (typeof raw !== 'string') return String(raw)

  // 1. Normalize line endings: CRLF -> LF, standalone CR -> LF
  let cleaned = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n')

  // 2. Strip OSC (Operating System Command) sequences (e.g. \x1b]0;Title\x07 or OSC 8 hyperlinks \x1b]8;;url\x1b\\)
  // Supports both 7-bit (\x1b]) and 8-bit (\u009d) OSC
  cleaned = cleaned.replace(/(?:\x1b\]|\u009d)[\s\S]*?(?:\x07|\x1b\\|$)/g, '')

  // 3. Strip DCS (Device Control String), PM (Privacy Message), APC (Application Program Command)
  cleaned = cleaned.replace(/\x1b[P\^_][\s\S]*?(?:\x07|\x1b\\|$)/g, '')

  // 4. Strip CSI (Control Sequence Introducer) sequences (colors, cursor movements, erase line/screen, private modes)
  // Format: ESC [ + parameter bytes (0x30-0x3F) + intermediate bytes (0x20-0x2F) + final byte (0x40-0x7E)
  cleaned = cleaned.replace(/(?:\x1b\[|\u009b)[0-9:;<=>?]*[ -/]*[@-~]/g, '')

  // Strip incomplete/truncated CSI at string boundary (e.g. \x1b[31)
  cleaned = cleaned.replace(/(?:\x1b\[|\u009b)[0-9:;<=>?]*[ -/]*$/g, '')

  // 5. Strip 2-character / short escape sequences (e.g. charset designations, DEC cursor save/restore, keypad)
  // Charset selection: ESC ( or ) or # or % followed by designation char
  cleaned = cleaned.replace(/\x1b[()#%*+-][0-9A-Za-z]/g, '')
  // Single ESC followed by DEC numeric command (0-9 e.g. \x1b7, \x1b8) or @ through _ or keypad (=, >, <, c)
  cleaned = cleaned.replace(/\x1b[0-9=@><~A-Za-z]/g, '')
  // Strip any lingering lone ESC characters
  cleaned = cleaned.replace(/\x1b+/g, '')

  // 6. Strip non-printing C0 control characters (except \t = 0x09 and \n = 0x0A) and DEL (0x7F)
  // Preserves: \t (0x09), \n (0x0A), printable ASCII (0x20-0x7E), and all Unicode (>= 0x80)
  cleaned = cleaned.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')

  return cleaned
}

/**
 * Applies deterministic head/tail line compression and character safety limits to sanitized terminal output.
 *
 * If output lines <= maxLines (default 30):
 *   Returns complete output without line compression.
 *
 * If output lines > maxLines:
 *   Preserves first `headLines` (default 5) and last `tailLines` (default 25),
 *   inserting a deterministic omission marker `[... N lines omitted ...]`.
 *
 * Also enforces `maxCharsPerLine` and `maxTotalChars` to guard against single massive lines
 * or giant payloads exhausting model context budgets.
 */
export function compressTerminalOutput(
  text: string,
  options?: TerminalCompressionOptions
): TerminalCompressionResult {
  const headLines = Math.max(0, options?.headLines ?? DEFAULT_HEAD_LINES)
  const tailLines = Math.max(0, options?.tailLines ?? DEFAULT_TAIL_LINES)
  const maxLines = Math.max(1, options?.maxLines ?? (headLines + tailLines))
  const maxCharsPerLine = Math.max(50, options?.maxCharsPerLine ?? DEFAULT_MAX_CHARS_PER_LINE)
  const maxTotalChars = Math.max(200, options?.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS)

  if (!text || text.length === 0) {
    return {
      text: '',
      originalLineCount: 0,
      returnedLineCount: 0,
      isCompressed: false,
      omittedLineCount: 0,
      isCharacterTruncated: false
    }
  }

  // Handle trailing newline so trailing newline is not counted as an extra ghost line
  const hasTrailingNewline = text.endsWith('\n')
  const content = hasTrailingNewline ? text.slice(0, -1) : text
  const rawLines = content.split('\n')

  let isCharacterTruncated = false

  // Step 1: Enforce per-line character safety limit
  const lines = rawLines.map((line) => {
    if (line.length > maxCharsPerLine) {
      isCharacterTruncated = true
      const marker = ' [... line truncated ...]'
      const keep = Math.max(0, maxCharsPerLine - marker.length)
      return line.slice(0, keep) + marker
    }
    return line
  })

  const originalLineCount = lines.length
  let returnedLines: string[]
  let isCompressed = false
  let omittedLineCount = 0

  // Step 2: Enforce head/tail line compression if line count exceeds threshold
  if (originalLineCount <= maxLines) {
    returnedLines = lines
  } else {
    const headCount = Math.min(headLines, originalLineCount)
    const tailCount = Math.min(tailLines, Math.max(0, originalLineCount - headCount))
    omittedLineCount = originalLineCount - headCount - tailCount

    if (omittedLineCount <= 0) {
      // Overlapping head/tail safety: no lines omitted, preserve all lines
      returnedLines = lines
    } else {
      isCompressed = true
      const head = lines.slice(0, headCount)
      const tail = lines.slice(originalLineCount - tailCount)
      const marker = `[... ${omittedLineCount} line${omittedLineCount === 1 ? '' : 's'} omitted ...]`
      returnedLines = [...head, marker, ...tail]
    }
  }

  const returnedLineCount = isCompressed
    ? originalLineCount - omittedLineCount
    : originalLineCount

  // Step 3: Join and enforce overall total character ceiling
  let resultText = returnedLines.join('\n')
  if (hasTrailingNewline && !isCompressed) {
    resultText += '\n'
  }

  if (resultText.length > maxTotalChars) {
    isCharacterTruncated = true
    const truncNotice = `\n[... output truncated to ${maxTotalChars} characters ...]`
    const keepTotal = Math.max(0, maxTotalChars - truncNotice.length)
    resultText = resultText.slice(0, keepTotal) + truncNotice
  }

  return {
    text: resultText,
    originalLineCount,
    returnedLineCount,
    isCompressed,
    omittedLineCount,
    isCharacterTruncated
  }
}

/**
 * End-to-end processing pipeline for terminal output destined for AI model context:
 * raw terminal output -> ANSI/control sanitization -> head/tail compression -> AI context result.
 *
 * Never throws an unhandled error; returns a safe fallback on unexpected input.
 */
export function processTerminalOutputForAI(
  raw: unknown,
  options?: TerminalCompressionOptions
): TerminalCompressionResult {
  try {
    const rawStr =
      typeof raw === 'string'
        ? raw
        : raw === null || raw === undefined
          ? ''
          : String(raw)

    const sanitized = sanitizeTerminalOutput(rawStr)
    return compressTerminalOutput(sanitized, options)
  } catch (err) {
    // Fail-safe: never crash the agent, return a bounded fallback
    const fallbackText = typeof raw === 'string' ? raw.slice(0, 1000) : ''
    return {
      text: fallbackText,
      originalLineCount: 0,
      returnedLineCount: 0,
      isCompressed: false,
      omittedLineCount: 0,
      isCharacterTruncated: true
    }
  }
}
