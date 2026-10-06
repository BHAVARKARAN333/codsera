import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  SmartContextEngine,
  extractLineRangeFromPrompt
} from '@renderer/services/agent/smartContextEngine'
import { setupMockElectron, resetMockElectron } from '../../setup/electronMock'
import { FileEntry } from '@shared/types'

describe('Surgical Code Slicing & SmartContext Line Range Integration', () => {
  describe('extractLineRangeFromPrompt', () => {
    it('extracts "lines X-Y" format', () => {
      const res = extractLineRangeFromPrompt('Explain lines 10-50 of src/App.tsx')
      expect(res).toEqual({ startLine: 10, endLine: 50 })
    })

    it('extracts "lines X to Y" format', () => {
      const res = extractLineRangeFromPrompt('Check lines 5 to 25 of index.ts')
      expect(res).toEqual({ startLine: 5, endLine: 25 })
    })

    it('extracts "lines X through Y" and "lines X..Y"', () => {
      expect(extractLineRangeFromPrompt('Review lines 20 through 40 in auth.ts')).toEqual({
        startLine: 20,
        endLine: 40
      })
      expect(extractLineRangeFromPrompt('Look at lines 15..30 of parser.ts')).toEqual({
        startLine: 15,
        endLine: 30
      })
    })

    it('extracts "L10-L20" format', () => {
      const res = extractLineRangeFromPrompt('See L10-L20 in utils.ts')
      expect(res).toEqual({ startLine: 10, endLine: 20 })
    })

    it('extracts single line request into a small bounded window (+/- 15 lines)', () => {
      const res = extractLineRangeFromPrompt('Fix error at line 40 of server.ts')
      expect(res).toEqual({ startLine: 25, endLine: 55 })
    })

    it('clamps single line startLine to 1 when near beginning of file', () => {
      const res = extractLineRangeFromPrompt('Look at line 5 in config.ts')
      expect(res).toEqual({ startLine: 1, endLine: 20 })
    })

    it('returns null when no line range is mentioned', () => {
      expect(extractLineRangeFromPrompt('Explain the authentication architecture')).toBeNull()
      expect(extractLineRangeFromPrompt('')).toBeNull()
    })
  })

  describe('SmartContextEngine Surgical Slicing in resolveContext', () => {
    let engine: SmartContextEngine
    const workspaceRoot = 'C:/mock/project'

    const mockTree: FileEntry[] = [
      {
        name: 'src',
        path: 'src',
        isDirectory: true,
        children: [
          {
            name: 'math.ts',
            path: 'src/math.ts',
            isDirectory: false
          },
          {
            name: 'utils.ts',
            path: 'src/utils.ts',
            isDirectory: false
          }
        ]
      }
    ]

    const fullMathContent = [
      'export function add(a: number, b: number): number {',
      '  return a + b;',
      '}',
      '',
      'export function subtract(a: number, b: number): number {',
      '  return a - b;',
      '}',
      '',
      'export function multiply(a: number, b: number): number {',
      '  return a * b;',
      '}',
      '',
      'export function divide(a: number, b: number): number {',
      '  if (b === 0) throw new Error("Divide by zero");',
      '  return a / b;',
      '}'
    ].join('\n')

    beforeEach(() => {
      engine = new SmartContextEngine({ maxAutoReadFiles: 2, maxFileChars: 8000 })

      setupMockElectron({
        readTree: vi.fn().mockResolvedValue({
          success: true,
          tree: mockTree
        }),
        readWorkspaceFile: vi.fn().mockImplementation(async (_root, filePath) => {
          if (filePath === 'src/math.ts') {
            return {
              success: true,
              path: 'src/math.ts',
              content: fullMathContent
            }
          }
          return {
            success: true,
            path: filePath,
            content: '// empty'
          }
        })
      })
    })

    afterEach(() => {
      resetMockElectron()
      vi.clearAllMocks()
    })

    it('surgically slices lines when explicit line range is requested in prompt', async () => {
      const res = await engine.resolveContext('Explain lines 5-7 of src/math.ts', workspaceRoot)

      expect(res.required).toBe(true)
      expect(res.readFiles.length).toBeGreaterThan(0)

      const mathFile = res.readFiles.find((f) => f.path === 'src/math.ts')
      expect(mathFile).toBeDefined()
      // Sliced lines 5-7: subtract function
      expect(mathFile!.content).toContain('Lines 5-7 of 16')
      expect(mathFile!.content).toContain('export function subtract')
      expect(mathFile!.content).toContain('return a - b;')
      // Should NOT include add or divide function from outside range
      expect(mathFile!.content).not.toContain('export function add')
      expect(mathFile!.content).not.toContain('export function divide')
    })

    it('conserves token budget by allocating based on sliced character length', async () => {
      const res = await engine.resolveContext('Review lines 1-3 of src/math.ts', workspaceRoot)
      const mathFile = res.readFiles.find((f) => f.path === 'src/math.ts')
      expect(mathFile).toBeDefined()
      expect(mathFile!.charCount).toBeLessThan(fullMathContent.length)
      expect(mathFile!.charCount).toBe(mathFile!.content.length)
    })

    it('preserves full file read when prompt does not specify a line range', async () => {
      const res = await engine.resolveContext('Explain src/math.ts in detail', workspaceRoot)
      const mathFile = res.readFiles.find((f) => f.path === 'src/math.ts')
      expect(mathFile).toBeDefined()
      expect(mathFile!.content).toContain('export function add')
      expect(mathFile!.content).toContain('export function subtract')
      expect(mathFile!.content).toContain('export function multiply')
      expect(mathFile!.content).toContain('export function divide')
    })

    it('integrates active editor context as metadata in formattedContext', async () => {
      const res = await engine.resolveContext('Refactor current function', workspaceRoot, {
        activeEditorContext: {
          filePath: 'src/math.ts',
          cursorLine: 6,
          cursorColumn: 12,
          visibleRange: {
            startLine: 1,
            endLine: 16
          }
        }
      })

      expect(res.formattedContext).toContain('[Active Editor Context]')
      expect(res.formattedContext).toContain('Active File: src/math.ts')
      expect(res.formattedContext).toContain('Cursor Position: line 6, col 12')
      expect(res.formattedContext).toContain('Visible Viewport: lines 1-16')
    })

    it('preserves isolation for explicit single-file requests', async () => {
      const res = await engine.resolveContext('Read only src/math.ts', workspaceRoot)
      expect(res.selectedFiles).toHaveLength(1)
      expect(res.selectedFiles[0].path).toBe('src/math.ts')
      expect(res.readFiles).toHaveLength(1)
      expect(res.readFiles[0].path).toBe('src/math.ts')
    })
  })
})
