import { describe, it, expect } from 'vitest'
import { sliceContentLines } from '@shared/diffUtils'

describe('sliceContentLines Unit Tests', () => {
  const sampleLF = [
    'line 1: import express from "express"',
    'line 2: const app = express()',
    'line 3: const port = 3000',
    'line 4: app.get("/", (req, res) => {',
    'line 5:   res.send("Hello World")',
    'line 6: })',
    'line 7: app.listen(port)'
  ].join('\n')

  const sampleCRLF = [
    'line 1: import express from "express"',
    'line 2: const app = express()',
    'line 3: const port = 3000',
    'line 4: app.get("/", (req, res) => {',
    'line 5:   res.send("Hello World")',
    'line 6: })',
    'line 7: app.listen(port)'
  ].join('\r\n')

  it('slices a valid multiline range correctly (lines 2-4)', () => {
    const res = sliceContentLines(sampleLF, 2, 4)
    expect(res.startLine).toBe(2)
    expect(res.endLine).toBe(4)
    expect(res.totalLines).toBe(7)
    expect(res.lineCount).toBe(3)
    expect(res.clipped).toBe(false)
    expect(res.content).toBe([
      'line 2: const app = express()',
      'line 3: const port = 3000',
      'line 4: app.get("/", (req, res) => {'
    ].join('\n'))
  })

  it('slices a single-line range correctly (startLine === endLine)', () => {
    const res = sliceContentLines(sampleLF, 3, 3)
    expect(res.startLine).toBe(3)
    expect(res.endLine).toBe(3)
    expect(res.totalLines).toBe(7)
    expect(res.lineCount).toBe(1)
    expect(res.clipped).toBe(false)
    expect(res.content).toBe('line 3: const port = 3000')
  })

  it('slices from startLine = 1 correctly', () => {
    const res = sliceContentLines(sampleLF, 1, 2)
    expect(res.startLine).toBe(1)
    expect(res.endLine).toBe(2)
    expect(res.lineCount).toBe(2)
    expect(res.clipped).toBe(false)
    expect(res.content).toBe('line 1: import express from "express"\nline 2: const app = express()')
  })

  it('clips range when requested endLine exceeds totalLines (endLine beyond EOF)', () => {
    const res = sliceContentLines(sampleLF, 5, 20)
    expect(res.startLine).toBe(5)
    expect(res.endLine).toBe(7)
    expect(res.totalLines).toBe(7)
    expect(res.lineCount).toBe(3)
    expect(res.clipped).toBe(true)
    expect(res.content).toBe('line 5:   res.send("Hello World")\nline 6: })\nline 7: app.listen(port)')
  })

  it('handles startLine beyond EOF gracefully', () => {
    const res = sliceContentLines(sampleLF, 10, 20)
    expect(res.startLine).toBe(10)
    expect(res.endLine).toBe(7)
    expect(res.totalLines).toBe(7)
    expect(res.lineCount).toBe(0)
    expect(res.clipped).toBe(true)
    expect(res.content).toBe('')
  })

  it('handles empty file content cleanly', () => {
    const res = sliceContentLines('', 1, 5)
    expect(res.totalLines).toBe(0)
    expect(res.lineCount).toBe(0)
    expect(res.startLine).toBe(0)
    expect(res.endLine).toBe(0)
    expect(res.clipped).toBe(true)
    expect(res.content).toBe('')
  })

  it('normalizes Windows CRLF files cleanly without trailing carriage returns', () => {
    const res = sliceContentLines(sampleCRLF, 2, 3)
    expect(res.startLine).toBe(2)
    expect(res.endLine).toBe(3)
    expect(res.totalLines).toBe(7)
    expect(res.lineCount).toBe(2)
    expect(res.content).toBe('line 2: const app = express()\nline 3: const port = 3000')
    expect(res.content).not.toContain('\r')
  })

  it('handles startLine clamp to 1 if passed less than 1', () => {
    const res = sliceContentLines(sampleLF, 0, 2)
    expect(res.startLine).toBe(1)
    expect(res.endLine).toBe(2)
    expect(res.lineCount).toBe(2)
  })
})
