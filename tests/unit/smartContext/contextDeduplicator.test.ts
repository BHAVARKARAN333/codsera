import { describe, it, expect, beforeEach } from 'vitest'
import { ContextDeduplicator } from '@renderer/services/agent/contextDeduplicator'

describe('contextDeduplicator Unit Tests', () => {
  let deduplicator: ContextDeduplicator

  beforeEach(() => {
    deduplicator = new ContextDeduplicator(false)
  })

  it('correctly tracks files marked in active context', () => {
    expect(deduplicator.isFileInContext('src/app.ts')).toBe(false)

    deduplicator.markFileInContext('src/app.ts', 'console.log("hello")')

    expect(deduplicator.isFileInContext('src/app.ts')).toBe(true)
    expect(deduplicator.isFileInContext('src/app.ts', 'console.log("hello")')).toBe(true)
    expect(deduplicator.isFileInContext('src/app.ts', 'console.log("changed")')).toBe(false)
  })

  it('normalizes paths across Windows separators and casing', () => {
    deduplicator.markFileInContext('SRC\\Components\\Nav.tsx', 'export const Nav = () => null')

    expect(deduplicator.isFileInContext('src/components/nav.tsx')).toBe(true)
    expect(deduplicator.isFileInContext('SRC/COMPONENTS/NAV.TSX')).toBe(true)
  })

  it('tracks and identifies duplicate tool execution outputs', () => {
    const toolName = 'read_file'
    const argsKey = '{"path":"src/index.ts"}'
    const output = 'export const ready = true'

    expect(deduplicator.isToolResultDuplicate(toolName, argsKey, output)).toBe(false)

    deduplicator.markToolResult(toolName, argsKey, output)

    expect(deduplicator.isToolResultDuplicate(toolName, argsKey, output)).toBe(true)
    expect(deduplicator.isToolResultDuplicate(toolName, argsKey, 'new output')).toBe(false)
    expect(deduplicator.isToolResultDuplicate(toolName, 'other_args', output)).toBe(false)
  })

  it('allows individual file invalidation and full reset', () => {
    deduplicator.markFileInContext('file1.ts', 'content 1')
    deduplicator.markFileInContext('file2.ts', 'content 2')

    deduplicator.invalidateFile('file1.ts')
    expect(deduplicator.isFileInContext('file1.ts')).toBe(false)
    expect(deduplicator.isFileInContext('file2.ts')).toBe(true)

    deduplicator.reset()
    expect(deduplicator.isFileInContext('file2.ts')).toBe(false)
  })

  it('tracks and validates targeted file line slices independently from full files', () => {
    const file = 'src/parser.ts'
    const sliceA = 'function parseToken() { return true; }'
    const sliceB = 'function parseAST() { return null; }'

    deduplicator.markFileSliceInContext(file, 10, 20, sliceA)

    expect(deduplicator.isFileSliceInContext(file, 10, 20)).toBe(true)
    expect(deduplicator.isFileSliceInContext(file, 10, 20, sliceA)).toBe(true)
    // Modified content in same range
    expect(deduplicator.isFileSliceInContext(file, 10, 20, 'modified code')).toBe(false)
    // Different range
    expect(deduplicator.isFileSliceInContext(file, 21, 30)).toBe(false)

    // Mark second range
    deduplicator.markFileSliceInContext(file, 21, 30, sliceB)
    expect(deduplicator.isFileSliceInContext(file, 21, 30, sliceB)).toBe(true)

    // Invalidate file clears all slices for that file
    deduplicator.invalidateFile(file)
    expect(deduplicator.isFileSliceInContext(file, 10, 20)).toBe(false)
    expect(deduplicator.isFileSliceInContext(file, 21, 30)).toBe(false)
  })

  it('tracks deduplicated characters saved', () => {
    expect(deduplicator.getDeduplicatedCharsSaved()).toBe(0)

    deduplicator.recordDeduplicatedChars(500)
    deduplicator.recordDeduplicatedChars(250)

    expect(deduplicator.getDeduplicatedCharsSaved()).toBe(750)

    deduplicator.reset()
    expect(deduplicator.getDeduplicatedCharsSaved()).toBe(0)
  })
})

