import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ReadFileRangeTool } from '@renderer/services/tools/readFileRangeTool'
import { ReadFileTool } from '@renderer/services/tools/readFileTool'
import { ToolContext } from '@renderer/services/tools/types'
import { setupMockElectron, resetMockElectron } from '../../../setup/electronMock'

describe('ReadFileRangeTool Unit Tests', () => {
  let tool: ReadFileRangeTool
  let mockContext: ToolContext

  beforeEach(() => {
    tool = new ReadFileRangeTool()

    mockContext = {
      workspaceRoot: 'C:/mock/workspace'
    }

    setupMockElectron({
      readWorkspaceFile: vi.fn(),
      readFile: vi.fn()
    })
  })

  afterEach(() => {
    resetMockElectron()
    vi.clearAllMocks()
  })

  describe('Tool Definition & Schema', () => {
    it('has correct tool name and approval requirement', () => {
      expect(tool.name).toBe('read_file_range')
      expect(tool.requiresApproval).toBe(false)
    })

    it('has clear description specifying line range reading', () => {
      expect(tool.description).toContain('1-based line range')
      expect(tool.description).toContain('instead of the entire file')
    })

    it('declares path, startLine, and endLine parameters with all required', () => {
      expect(tool.parameters.properties).toHaveProperty('path')
      expect(tool.parameters.properties).toHaveProperty('startLine')
      expect(tool.parameters.properties).toHaveProperty('endLine')
      expect(tool.parameters.required).toEqual(['path', 'startLine', 'endLine'])
    })
  })

  describe('Validation & Security Protections', () => {
    it('returns error when workspaceRoot is missing', async () => {
      const res = await tool.execute(
        { path: 'src/App.tsx', startLine: 1, endLine: 10 },
        { workspaceRoot: null }
      )
      expect(res.success).toBe(false)
      expect(res.error).toContain('No workspace folder is currently open')
    })

    it('returns error when path is missing or empty', async () => {
      const res = await tool.execute(
        { path: '   ', startLine: 1, endLine: 10 },
        mockContext
      )
      expect(res.success).toBe(false)
      expect(res.error).toContain('Missing or invalid "path" parameter')
    })

    it('rejects path traversal attacks (starts with ..)', async () => {
      const res = await tool.execute(
        { path: '../secret.env', startLine: 1, endLine: 10 },
        mockContext
      )
      expect(res.success).toBe(false)
      expect(res.error).toContain('Access denied')
      expect(res.error).toContain('outside the current workspace')
    })

    it('rejects path traversal attacks (embedded /../)', async () => {
      const res = await tool.execute(
        { path: 'src/../../etc/passwd', startLine: 1, endLine: 10 },
        mockContext
      )
      expect(res.success).toBe(false)
      expect(res.error).toContain('Access denied')
    })

    it('rejects invalid, missing, or non-integer startLine', async () => {
      const invalidStarts = [undefined, null, '1', 1.5, NaN, Infinity, -Infinity]
      for (const badStart of invalidStarts) {
        const res = await tool.execute(
          { path: 'src/App.tsx', startLine: badStart, endLine: 10 },
          mockContext
        )
        expect(res.success).toBe(false)
        expect(res.error).toContain('startLine must be an integer >= 1')
      }
    })

    it('rejects invalid, missing, or non-integer endLine', async () => {
      const invalidEnds = [undefined, null, '10', 10.5, NaN, Infinity, -Infinity]
      for (const badEnd of invalidEnds) {
        const res = await tool.execute(
          { path: 'src/App.tsx', startLine: 1, endLine: badEnd },
          mockContext
        )
        expect(res.success).toBe(false)
        expect(res.error).toContain('endLine must be an integer >= startLine')
      }
    })

    it('rejects zero or negative startLine numbers', async () => {
      const resZero = await tool.execute(
        { path: 'src/App.tsx', startLine: 0, endLine: 10 },
        mockContext
      )
      expect(resZero.success).toBe(false)
      expect(resZero.error).toContain('startLine must be at least 1')

      const resNeg = await tool.execute(
        { path: 'src/App.tsx', startLine: -5, endLine: 10 },
        mockContext
      )
      expect(resNeg.success).toBe(false)
      expect(resNeg.error).toContain('startLine must be at least 1')
    })

    it('rejects startLine > endLine', async () => {
      const res = await tool.execute(
        { path: 'src/App.tsx', startLine: 50, endLine: 20 },
        mockContext
      )
      expect(res.success).toBe(false)
      expect(res.error).toContain('cannot be less than startLine')
    })

    it('enforces maximum range limit of 1000 lines (token safety)', async () => {
      const res = await tool.execute(
        { path: 'src/App.tsx', startLine: 1, endLine: 1001 },
        mockContext
      )
      expect(res.success).toBe(false)
      expect(res.error).toContain('exceeds the maximum allowed limit of 1000 lines per call')
    })

    it('handles aborted signal gracefully', async () => {
      const controller = new AbortController()
      controller.abort()

      const res = await tool.execute(
        { path: 'src/App.tsx', startLine: 1, endLine: 10 },
        { ...mockContext, signal: controller.signal }
      )
      expect(res.success).toBe(false)
      expect(res.error).toContain('aborted by user')
    })
  })

  describe('Filesystem Read Errors', () => {
    it('returns clear error when file does not exist', async () => {
      vi.mocked(window.electronAPI.readWorkspaceFile).mockResolvedValue({
        success: false,
        error: 'File not found: missing.ts'
      })

      const res = await tool.execute(
        { path: 'missing.ts', startLine: 1, endLine: 10 },
        mockContext
      )
      expect(res.success).toBe(false)
      expect(res.error).toBe("File does not exist: 'missing.ts'.")
    })

    it('returns generic error when readWorkspaceFile fails', async () => {
      vi.mocked(window.electronAPI.readWorkspaceFile).mockResolvedValue({
        success: false,
        error: 'EACCES: permission denied'
      })

      const res = await tool.execute(
        { path: 'protected.ts', startLine: 1, endLine: 10 },
        mockContext
      )
      expect(res.success).toBe(false)
      expect(res.error).toBe('EACCES: permission denied')
    })
  })

  describe('Range Reading Execution & Clipping', () => {
    const sampleCode = [
      'const a = 1;',
      'const b = 2;',
      'const c = 3;',
      'const d = 4;',
      'const e = 5;'
    ].join('\n')

    it('reads valid multiline range accurately', async () => {
      vi.mocked(window.electronAPI.readWorkspaceFile).mockResolvedValue({
        success: true,
        path: 'src/sample.ts',
        content: sampleCode
      })

      const res = await tool.execute(
        { path: 'src/sample.ts', startLine: 2, endLine: 4 },
        mockContext
      )

      expect(res.success).toBe(true)
      const parsed = JSON.parse(res.output)
      expect(parsed.path).toBe('src/sample.ts')
      expect(parsed.requestedRange).toEqual({ startLine: 2, endLine: 4 })
      expect(parsed.returnedRange).toEqual({ startLine: 2, endLine: 4 })
      expect(parsed.totalLines).toBe(5)
      expect(parsed.lineCount).toBe(3)
      expect(parsed.clipped).toBe(false)
      expect(parsed.content).toBe('const b = 2;\nconst c = 3;\nconst d = 4;')
      expect(parsed.message).toContain("Showing lines 2-4 of file 'src/sample.ts' (total 5 lines).")
    })

    it('reads a single-line range accurately', async () => {
      vi.mocked(window.electronAPI.readWorkspaceFile).mockResolvedValue({
        success: true,
        content: sampleCode
      })

      const res = await tool.execute(
        { path: 'src/sample.ts', startLine: 3, endLine: 3 },
        mockContext
      )

      expect(res.success).toBe(true)
      const parsed = JSON.parse(res.output)
      expect(parsed.returnedRange).toEqual({ startLine: 3, endLine: 3 })
      expect(parsed.lineCount).toBe(1)
      expect(parsed.content).toBe('const c = 3;')
    })

    it('clips range when endLine is beyond EOF and reports clipped status', async () => {
      vi.mocked(window.electronAPI.readWorkspaceFile).mockResolvedValue({
        success: true,
        content: sampleCode
      })

      const res = await tool.execute(
        { path: 'src/sample.ts', startLine: 3, endLine: 50 },
        mockContext
      )

      expect(res.success).toBe(true)
      const parsed = JSON.parse(res.output)
      expect(parsed.requestedRange).toEqual({ startLine: 3, endLine: 50 })
      expect(parsed.returnedRange).toEqual({ startLine: 3, endLine: 5 })
      expect(parsed.clipped).toBe(true)
      expect(parsed.lineCount).toBe(3)
      expect(parsed.content).toBe('const c = 3;\nconst d = 4;\nconst e = 5;')
      expect(parsed.message).toContain('clipped: requested endLine 50 exceeded total lines 5')
    })

    it('handles startLine beyond EOF gracefully', async () => {
      vi.mocked(window.electronAPI.readWorkspaceFile).mockResolvedValue({
        success: true,
        content: sampleCode
      })

      const res = await tool.execute(
        { path: 'src/sample.ts', startLine: 20, endLine: 30 },
        mockContext
      )

      expect(res.success).toBe(true)
      const parsed = JSON.parse(res.output)
      expect(parsed.clipped).toBe(true)
      expect(parsed.lineCount).toBe(0)
      expect(parsed.content).toBe('')
      expect(parsed.message).toContain('Requested startLine 20 is beyond end of file (file has 5 lines)')
    })

    it('handles empty file cleanly', async () => {
      vi.mocked(window.electronAPI.readWorkspaceFile).mockResolvedValue({
        success: true,
        content: ''
      })

      const res = await tool.execute(
        { path: 'empty.ts', startLine: 1, endLine: 5 },
        mockContext
      )

      expect(res.success).toBe(true)
      const parsed = JSON.parse(res.output)
      expect(parsed.totalLines).toBe(0)
      expect(parsed.lineCount).toBe(0)
      expect(parsed.content).toBe('')
      expect(parsed.message).toContain("File 'empty.ts' is empty (0 lines).")
    })

    it('supports Windows CRLF files cleanly', async () => {
      const crlfCode = 'line 1\r\nline 2\r\nline 3'
      vi.mocked(window.electronAPI.readWorkspaceFile).mockResolvedValue({
        success: true,
        content: crlfCode
      })

      const res = await tool.execute(
        { path: 'crlf.txt', startLine: 2, endLine: 3 },
        mockContext
      )

      expect(res.success).toBe(true)
      const parsed = JSON.parse(res.output)
      expect(parsed.content).toBe('line 2\nline 3')
      expect(parsed.content).not.toContain('\r')
    })

    it('truncates content when range character count exceeds MAX_RANGE_CHARS', async () => {
      // Create 10 lines of 2000 chars each = 20,000 chars (exceeds 16,000 char budget)
      const largeContent = Array.from({ length: 10 }, (_, i) => `Line ${i + 1}: ${'x'.repeat(2000)}`).join('\n')

      vi.mocked(window.electronAPI.readWorkspaceFile).mockResolvedValue({
        success: true,
        content: largeContent
      })

      const res = await tool.execute(
        { path: 'huge.txt', startLine: 1, endLine: 10 },
        mockContext
      )

      expect(res.success).toBe(true)
      const parsed = JSON.parse(res.output)
      expect(parsed.charTruncated).toBe(true)
      expect(parsed.content).toContain('Truncated remainder of line range to conserve budget')
    })

    it('falls back to window.electronAPI.readFile when readWorkspaceFile is missing', async () => {
      // @ts-expect-error test fallback
      delete window.electronAPI.readWorkspaceFile
      vi.mocked(window.electronAPI.readFile).mockResolvedValue({
        success: true,
        content: 'alpha\nbeta\ngamma'
      })

      const res = await tool.execute(
        { path: 'test.ts', startLine: 1, endLine: 2 },
        mockContext
      )

      expect(res.success).toBe(true)
      const parsed = JSON.parse(res.output)
      expect(parsed.content).toBe('alpha\nbeta')
    })
  })

  describe('Existing ReadFileTool Regression Verification', () => {
    it('preserves existing read_file tool contract and safety behavior', async () => {
      const readTool = new ReadFileTool()
      expect(readTool.name).toBe('read_file')
      expect(readTool.requiresApproval).toBe(false)

      vi.mocked(window.electronAPI.readWorkspaceFile).mockResolvedValue({
        success: true,
        path: 'src/main.ts',
        content: 'const x = 1;\nconst y = 2;'
      })

      const res = await readTool.execute({ path: 'src/main.ts' }, mockContext)
      expect(res.success).toBe(true)
      const parsed = JSON.parse(res.output)
      expect(parsed.path).toBe('src/main.ts')
      expect(parsed.content).toBe('const x = 1;\nconst y = 2;')
      expect(parsed.truncated).toBe(false)
    })
  })
})
