import { describe, it, expect } from 'vitest'
import {
  sanitizeTerminalOutput,
  compressTerminalOutput,
  processTerminalOutputForAI,
  DEFAULT_HEAD_LINES,
  DEFAULT_TAIL_LINES,
  DEFAULT_MAX_LINES,
  DEFAULT_MAX_CHARS_PER_LINE,
  DEFAULT_MAX_TOTAL_CHARS
} from '../../../src/shared/terminalSanitizer'

describe('terminalSanitizer Unit Tests', () => {
  describe('Default Architecture Constants', () => {
    it('exports expected architecture default constants', () => {
      expect(DEFAULT_HEAD_LINES).toBe(5)
      expect(DEFAULT_TAIL_LINES).toBe(25)
      expect(DEFAULT_MAX_LINES).toBe(30)
      expect(DEFAULT_MAX_CHARS_PER_LINE).toBe(2000)
      expect(DEFAULT_MAX_TOTAL_CHARS).toBe(16000)
    })
  })

  // ==========================================================================
  // Group 1: ANSI & Terminal Control Sequence Sanitization
  // ==========================================================================
  describe('ANSI / Control Sequence Sanitizer', () => {
    it('strips standard ANSI 8/16 color codes', () => {
      const input = '\x1b[31mRed text\x1b[0m \x1b[32mGreen text\x1b[0m \x1b[94mBright Blue\x1b[39m'
      expect(sanitizeTerminalOutput(input)).toBe('Red text Green text Bright Blue')
    })

    it('strips 256-color and 24-bit RGB truecolor escape sequences', () => {
      const input = '\x1b[38;5;196m256 Color Red\x1b[0m and \x1b[38;2;255;128;0m24-bit Orange\x1b[0m'
      expect(sanitizeTerminalOutput(input)).toBe('256 Color Red and 24-bit Orange')
    })

    it('strips background color codes', () => {
      const input = '\x1b[41mRed Background\x1b[49m \x1b[48;5;200m256 BG\x1b[0m'
      expect(sanitizeTerminalOutput(input)).toBe('Red Background 256 BG')
    })

    it('strips text styles (bold, dim, italic, underline, inverse, strikethrough)', () => {
      const input =
        '\x1b[1mBold\x1b[22m \x1b[2mDim\x1b[22m \x1b[3mItalic\x1b[23m \x1b[4mUnderline\x1b[24m \x1b[7mInverse\x1b[27m \x1b[9mStrikethrough\x1b[29m'
      expect(sanitizeTerminalOutput(input)).toBe('Bold Dim Italic Underline Inverse Strikethrough')
    })

    it('strips cursor movement and positioning sequences', () => {
      const input = 'Start\x1b[2AUp\x1b[3BDown\x1b[10CForward\x1b[5DBack\x1b[1;1HHome\x1b[10;20fPosition'
      expect(sanitizeTerminalOutput(input)).toBe('StartUpDownForwardBackHomePosition')
    })

    it('strips cursor save and restore sequences', () => {
      const input = 'Before\x1b[sSaved\x1b[uRestored\x1b7DECSave\x1b8DECRestore'
      expect(sanitizeTerminalOutput(input)).toBe('BeforeSavedRestoredDECSaveDECRestore')
    })

    it('strips erase in line and erase in screen/display sequences', () => {
      const input = 'EraseLine:\x1b[K cleared\x1b[2K whole line\x1b[2J clear screen\x1b[3J clear scrollback'
      expect(sanitizeTerminalOutput(input)).toBe('EraseLine: cleared whole line clear screen clear scrollback')
    })

    it('strips private mode terminal sequences', () => {
      const input = '\x1b[?25lHide cursor\x1b[?25hShow cursor\x1b[?1049hAlt buffer\x1b[?1049lMain buffer'
      expect(sanitizeTerminalOutput(input)).toBe('Hide cursorShow cursorAlt bufferMain buffer')
    })

    it('strips OSC title sequences terminated with BEL (\\x07)', () => {
      const input = '\x1b]0;npm test - Terminal\x07Test suite execution output'
      expect(sanitizeTerminalOutput(input)).toBe('Test suite execution output')
    })

    it('strips OSC title sequences terminated with String Terminator (\\x1b\\\\)', () => {
      const input = '\x1b]2;build:watch\x1b\\Starting compilation...'
      expect(sanitizeTerminalOutput(input)).toBe('Starting compilation...')
    })

    it('strips OSC 8 hyperlinks while preserving link label text', () => {
      const input = 'Check out \x1b]8;;https://github.com\x1b\\GitHub Repository\x1b]8;;\x1b\\ for updates'
      expect(sanitizeTerminalOutput(input)).toBe('Check out GitHub Repository for updates')
    })

    it('strips DCS, PM, and APC sequences', () => {
      const input = 'Device: \x1bP+q1234\x1b\\Message: \x1b^privacy\x07Command: \x1b_application\x1b\\Done'
      expect(sanitizeTerminalOutput(input)).toBe('Device: Message: Command: Done')
    })

    it('handles malformed and incomplete escape sequences safely at buffer end', () => {
      const truncatedCsi = 'Building \x1b[31'
      expect(sanitizeTerminalOutput(truncatedCsi)).toBe('Building ')

      const danglingEsc = 'Running tests\x1b'
      expect(sanitizeTerminalOutput(danglingEsc)).toBe('Running tests')

      const incompleteOsc = 'Header\x1b]0;Unterminated Title'
      expect(sanitizeTerminalOutput(incompleteOsc)).toBe('Header')
    })

    it('normalizes CRLF and standalone CR (progress bar overwrite) to newlines', () => {
      const crlf = 'Line 1\r\nLine 2\r\nLine 3'
      expect(sanitizeTerminalOutput(crlf)).toBe('Line 1\nLine 2\nLine 3')

      const standaloneCr = 'Progress: 10%\rProgress: 50%\rProgress: 100%\n'
      expect(sanitizeTerminalOutput(standaloneCr)).toBe('Progress: 10%\nProgress: 50%\nProgress: 100%\n')
    })

    it('strips non-printing C0 control characters but preserves tabs and newlines', () => {
      const input = 'Col1\tCol2\x07\x08\x0c\nLine2\tVal\x1b\x7f'
      expect(sanitizeTerminalOutput(input)).toBe('Col1\tCol2\nLine2\tVal')
    })

    it('preserves Unicode characters, emojis, non-ASCII and international text', () => {
      const unicodeInput =
        '\x1b[32m✓\x1b[0m Passed in 12ms 🚀 — 日本語 (Japanese), Русский (Russian), Español (café & niño)'
      expect(sanitizeTerminalOutput(unicodeInput)).toBe(
        '✓ Passed in 12ms 🚀 — 日本語 (Japanese), Русский (Russian), Español (café & niño)'
      )
    })

    it('returns already-clean text untouched', () => {
      const clean = 'This is 100% clean plain text with standard symbols: !@#$%^&*()_+-=[]{}|;:\',.<>/?\nNext line.'
      expect(sanitizeTerminalOutput(clean)).toBe(clean)
    })

    it('handles empty, null, and non-string inputs safely without throwing', () => {
      expect(sanitizeTerminalOutput('')).toBe('')
      expect(sanitizeTerminalOutput(null as any)).toBe('')
      expect(sanitizeTerminalOutput(undefined as any)).toBe('')
      expect(sanitizeTerminalOutput(12345 as any)).toBe('12345')
    })
  })

  // ==========================================================================
  // Group 2: Head/Tail Compression
  // ==========================================================================
  describe('Head/Tail Compression', () => {
    it('returns empty result for empty string', () => {
      const res = compressTerminalOutput('')
      expect(res.text).toBe('')
      expect(res.originalLineCount).toBe(0)
      expect(res.returnedLineCount).toBe(0)
      expect(res.isCompressed).toBe(false)
      expect(res.omittedLineCount).toBe(0)
      expect(res.isCharacterTruncated).toBe(false)
    })

    it('returns small output unmodified when below threshold', () => {
      const text = ['Line 1', 'Line 2', 'Line 3', 'Line 4', 'Line 5'].join('\n')
      const res = compressTerminalOutput(text)

      expect(res.text).toBe(text)
      expect(res.originalLineCount).toBe(5)
      expect(res.returnedLineCount).toBe(5)
      expect(res.isCompressed).toBe(false)
      expect(res.omittedLineCount).toBe(0)
      expect(res.isCharacterTruncated).toBe(false)
    })

    it('preserves exactly 30 lines without compression under default 30-line threshold', () => {
      const lines = Array.from({ length: 30 }, (_, i) => `Line ${i + 1}`)
      const text = lines.join('\n')
      const res = compressTerminalOutput(text)

      expect(res.text).toBe(text)
      expect(res.originalLineCount).toBe(30)
      expect(res.returnedLineCount).toBe(30)
      expect(res.isCompressed).toBe(false)
      expect(res.omittedLineCount).toBe(0)
    })

    it('compresses output when line count is just over limit (31 lines -> 1 line omitted)', () => {
      const lines = Array.from({ length: 31 }, (_, i) => `Line ${i + 1}`)
      const text = lines.join('\n')
      const res = compressTerminalOutput(text)

      expect(res.isCompressed).toBe(true)
      expect(res.originalLineCount).toBe(31)
      expect(res.returnedLineCount).toBe(30)
      expect(res.omittedLineCount).toBe(1)

      const resultLines = res.text.split('\n')
      // Head: lines 1-5 (5 lines)
      expect(resultLines.slice(0, 5)).toEqual(['Line 1', 'Line 2', 'Line 3', 'Line 4', 'Line 5'])
      // Marker
      expect(resultLines[5]).toBe('[... 1 line omitted ...]')
      // Tail: lines 7-31 (25 lines)
      expect(resultLines.slice(6)).toEqual(lines.slice(6))
      expect(resultLines.slice(6)).toHaveLength(25)
    })

    it('compresses large output (100 lines) preserving first 5 and last 25 lines', () => {
      const lines = Array.from({ length: 100 }, (_, i) => `Step #${i + 1}`)
      const text = lines.join('\n')
      const res = compressTerminalOutput(text)

      expect(res.isCompressed).toBe(true)
      expect(res.originalLineCount).toBe(100)
      expect(res.returnedLineCount).toBe(30)
      expect(res.omittedLineCount).toBe(70)

      const resultLines = res.text.split('\n')
      // 5 head lines + 1 marker + 25 tail lines = 31 total lines in string
      expect(resultLines).toHaveLength(31)
      expect(resultLines.slice(0, 5)).toEqual(['Step #1', 'Step #2', 'Step #3', 'Step #4', 'Step #5'])
      expect(resultLines[5]).toBe('[... 70 lines omitted ...]')
      expect(resultLines.slice(6)).toEqual(lines.slice(75))
    })

    it('handles very large output (1,000 lines)', () => {
      const lines = Array.from({ length: 1000 }, (_, i) => `Log entry [${i + 1}]`)
      const text = lines.join('\n')
      const res = compressTerminalOutput(text)

      expect(res.isCompressed).toBe(true)
      expect(res.originalLineCount).toBe(1000)
      expect(res.omittedLineCount).toBe(970)
      expect(res.returnedLineCount).toBe(30)
      expect(res.text).toContain('[... 970 lines omitted ...]')
      expect(res.text.startsWith('Log entry [1]\nLog entry [2]\nLog entry [3]\nLog entry [4]\nLog entry [5]')).toBe(
        true
      )
      expect(res.text.endsWith('Log entry [1000]')).toBe(true)
    })

    it('prevents duplication when configured head and tail overlap', () => {
      // Configuration where headLines (10) + tailLines (15) = 25 >= maxLines (20)
      // and total lines = 22
      const lines = Array.from({ length: 22 }, (_, i) => `Row ${i + 1}`)
      const text = lines.join('\n')
      const res = compressTerminalOutput(text, {
        headLines: 10,
        tailLines: 15,
        maxLines: 20
      })

      // When headCount + tailCount would exceed or equal total lines, no duplication occurs
      expect(res.omittedLineCount).toBe(0)
      expect(res.isCompressed).toBe(false)
      expect(res.text).toBe(text)
    })

    it('truncates an enormous single line exceeding maxCharsPerLine', () => {
      const giantLine = 'A'.repeat(5000)
      const res = compressTerminalOutput(giantLine, { maxCharsPerLine: 200 })

      expect(res.isCharacterTruncated).toBe(true)
      expect(res.text).toContain('[... line truncated ...]')
      expect(res.text.length).toBeLessThanOrEqual(200)
    })

    it('enforces maxTotalChars ceiling on overall output', () => {
      const lines = Array.from({ length: 10 }, (_, i) => `Section ${i + 1}: ${'X'.repeat(500)}`)
      const text = lines.join('\n')
      const res = compressTerminalOutput(text, { maxTotalChars: 1500, maxCharsPerLine: 1000 })

      expect(res.isCharacterTruncated).toBe(true)
      expect(res.text).toContain('[... output truncated to 1500 characters ...]')
      expect(res.text.length).toBeLessThanOrEqual(1500)
    })

    it('maintains mathematical consistency across metadata fields', () => {
      const lines = Array.from({ length: 85 }, (_, i) => `Item ${i + 1}`)
      const res = compressTerminalOutput(lines.join('\n'))

      expect(res.originalLineCount).toBe(85)
      expect(res.omittedLineCount).toBe(55)
      expect(res.returnedLineCount).toBe(30)
      expect(res.originalLineCount).toBe(res.returnedLineCount + res.omittedLineCount)
      expect(res.isCompressed).toBe(true)
    })

    it('produces completely deterministic output across repeat calls', () => {
      const lines = Array.from({ length: 60 }, (_, i) => `Deterministic line ${i + 1}`)
      const text = lines.join('\n')

      const res1 = compressTerminalOutput(text)
      const res2 = compressTerminalOutput(text)

      expect(res1.text).toBe(res2.text)
      expect(res1).toEqual(res2)
    })
  })

  // ==========================================================================
  // Group 3: End-to-End Pipeline (processTerminalOutputForAI)
  // ==========================================================================
  describe('processTerminalOutputForAI Pipeline', () => {
    it('executes sanitization then compression in exact pipeline order', () => {
      const rawLines = Array.from({ length: 50 }, (_, i) => {
        if (i % 2 === 0) {
          return `\x1b[32m[PASS]\x1b[0m Test #${i + 1} succeeded`
        }
        return `\x1b[1;34m[INFO]\x1b[0m Processing step ${i + 1}`
      })
      const rawOutput = rawLines.join('\r\n')

      const result = processTerminalOutputForAI(rawOutput)

      // 1. All ANSI codes are completely stripped
      expect(result.text).not.toContain('\x1b')
      expect(result.text).toContain('[PASS] Test #1 succeeded')
      expect(result.text).toContain('[INFO] Processing step 50')

      // 2. Output is compressed
      expect(result.isCompressed).toBe(true)
      expect(result.originalLineCount).toBe(50)
      expect(result.returnedLineCount).toBe(30)
      expect(result.omittedLineCount).toBe(20)
      expect(result.text).toContain('[... 20 lines omitted ...]')
    })

    it('handles unexpected non-string or throwing inputs with fail-safe fallback', () => {
      const fallbackResult = processTerminalOutputForAI(null)
      expect(fallbackResult.text).toBe('')
      expect(fallbackResult.originalLineCount).toBe(0)

      const numResult = processTerminalOutputForAI(99999)
      expect(numResult.text).toBe('99999')
    })
  })
})
