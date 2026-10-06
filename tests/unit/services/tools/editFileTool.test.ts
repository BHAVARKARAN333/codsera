import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EditFileTool } from '@renderer/services/tools/editFileTool'
import { ToolContext } from '@renderer/services/tools/types'
import { setupMockElectron, resetMockElectron } from '../../../setup/electronMock'

describe('EditFileTool Unit Tests', () => {
  let tool: EditFileTool
  let mockContext: ToolContext

  beforeEach(() => {
    tool = new EditFileTool()

    mockContext = {
      workspaceRoot: 'C:/mock/workspace',
      requestApproval: vi.fn().mockResolvedValue(true),
      onFileEdited: vi.fn()
    }

    setupMockElectron({
      readWorkspaceFile: vi.fn(),
      editWorkspaceFile: vi.fn()
    })
  })

  afterEach(() => {
    resetMockElectron()
    vi.clearAllMocks()
  })

  describe('Tool Definition & Schema', () => {
    it('has correct tool name and approval requirement', () => {
      expect(tool.name).toBe('edit_file')
      expect(tool.requiresApproval).toBe(true)
    })

    it('has detailed description containing SEARCH/REPLACE instructions and example', () => {
      expect(tool.description).toContain('SEARCH/REPLACE')
      expect(tool.description).toContain('<<<<<<< SEARCH')
      expect(tool.description).toContain('>>>>>>> REPLACE')
    })

    it('declares path, patch, and newContent parameters with path required', () => {
      expect(tool.parameters.properties).toHaveProperty('path')
      expect(tool.parameters.properties).toHaveProperty('patch')
      expect(tool.parameters.properties).toHaveProperty('newContent')
      expect(tool.parameters.required).toEqual(['path'])
    })
  })

  describe('Input Validation', () => {
    it('returns error when workspaceRoot is missing', async () => {
      const res = await tool.execute(
        { path: 'test.ts', patch: '<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE' },
        { ...mockContext, workspaceRoot: null }
      )
      expect(res.success).toBe(false)
      expect(res.error).toContain('No workspace folder is currently open')
    })

    it('returns error when path is missing or empty', async () => {
      const res = await tool.execute(
        { path: '   ', patch: '<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE' },
        mockContext
      )
      expect(res.success).toBe(false)
      expect(res.error).toContain('Missing or invalid "path" parameter')
    })

    it('returns error when neither patch nor newContent is provided', async () => {
      const res = await tool.execute({ path: 'test.ts' }, mockContext)
      expect(res.success).toBe(false)
      expect(res.error).toContain('Missing or invalid "patch" or "newContent"')
    })
  })

  describe('Filesystem Read Errors', () => {
    it('returns error when readWorkspaceFile reports file not found', async () => {
      vi.mocked(window.electronAPI.readWorkspaceFile).mockResolvedValue({
        success: false,
        error: 'File not found: test.ts'
      })

      const res = await tool.execute(
        {
          path: 'test.ts',
          patch: '<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE'
        },
        mockContext
      )

      expect(res.success).toBe(false)
      expect(res.error).toContain("File does not exist: 'test.ts'. Use create_file instead.")
      expect(mockContext.requestApproval).not.toHaveBeenCalled()
    })

    it('returns error when readWorkspaceFile encounters generic failure', async () => {
      vi.mocked(window.electronAPI.readWorkspaceFile).mockResolvedValue({
        success: false,
        error: 'EACCES: permission denied'
      })

      const res = await tool.execute(
        {
          path: 'test.ts',
          patch: '<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE'
        },
        mockContext
      )

      expect(res.success).toBe(false)
      expect(res.error).toBe('EACCES: permission denied')
      expect(mockContext.requestApproval).not.toHaveBeenCalled()
    })
  })

  describe('Patch Application & Safety', () => {
    it('fails before requesting approval if patch syntax is malformed', async () => {
      vi.mocked(window.electronAPI.readWorkspaceFile).mockResolvedValue({
        success: true,
        content: 'const a = 1;\n'
      })

      const res = await tool.execute(
        {
          path: 'test.ts',
          patch: '<<<<<<< SEARCH\nconst a = 1;\nmissing replace marker'
        },
        mockContext
      )

      expect(res.success).toBe(false)
      expect(res.error).toContain('Malformed patch')
      // Critical safety check: neither approval nor write was triggered
      expect(mockContext.requestApproval).not.toHaveBeenCalled()
      expect(window.electronAPI.editWorkspaceFile).not.toHaveBeenCalled()
    })

    it('fails before requesting approval if search block is ambiguous', async () => {
      vi.mocked(window.electronAPI.readWorkspaceFile).mockResolvedValue({
        success: true,
        content: 'const x = 1;\nconst x = 1;\n'
      })

      const patch = [
        '<<<<<<< SEARCH',
        'const x = 1;',
        '=======',
        'const x = 2;',
        '>>>>>>> REPLACE'
      ].join('\n')

      const res = await tool.execute({ path: 'test.ts', patch }, mockContext)

      expect(res.success).toBe(false)
      expect(res.error).toContain('Ambiguous match')
      expect(mockContext.requestApproval).not.toHaveBeenCalled()
      expect(window.electronAPI.editWorkspaceFile).not.toHaveBeenCalled()
    })

    it('fails before requesting approval if search block is not found', async () => {
      vi.mocked(window.electronAPI.readWorkspaceFile).mockResolvedValue({
        success: true,
        content: 'function hello() {\n  return "world";\n}\n'
      })

      const patch = [
        '<<<<<<< SEARCH',
        'function goodbye() {',
        '  return 42;',
        '}',
        '=======',
        'function goodbye() {',
        '  return 100;',
        '}',
        '>>>>>>> REPLACE'
      ].join('\n')

      const res = await tool.execute({ path: 'test.ts', patch }, mockContext)

      expect(res.success).toBe(false)
      expect(res.error).toContain('SEARCH block not found in file')
      expect(mockContext.requestApproval).not.toHaveBeenCalled()
      expect(window.electronAPI.editWorkspaceFile).not.toHaveBeenCalled()
    })

    it('successfully applies patch, requests approval with diff, and writes to disk upon approval', async () => {
      const originalFile = [
        'function calculate(a, b) {',
        '  return a - b;',
        '}'
      ].join('\n')

      vi.mocked(window.electronAPI.readWorkspaceFile).mockResolvedValue({
        success: true,
        content: originalFile
      })

      vi.mocked(window.electronAPI.editWorkspaceFile).mockResolvedValue({
        success: true,
        path: 'src/calc.ts'
      })

      const patch = [
        '<<<<<<< SEARCH',
        '  return a - b;',
        '=======',
        '  return a + b;',
        '>>>>>>> REPLACE'
      ].join('\n')

      const res = await tool.execute({ path: 'src/calc.ts', patch }, mockContext)

      expect(res.success).toBe(true)

      // Verify approval received correct old and patched content
      const expectedNewContent = [
        'function calculate(a, b) {',
        '  return a + b;',
        '}'
      ].join('\n')

      expect(mockContext.requestApproval).toHaveBeenCalledWith({
        toolName: 'edit_file',
        path: 'src/calc.ts',
        oldContent: originalFile,
        newContent: expectedNewContent
      })

      // Verify editWorkspaceFile was called with the resolved content
      expect(window.electronAPI.editWorkspaceFile).toHaveBeenCalledWith(
        'C:/mock/workspace',
        'src/calc.ts',
        expectedNewContent,
        originalFile
      )

      expect(mockContext.onFileEdited).toHaveBeenCalledWith('src/calc.ts', expectedNewContent)

      const parsed = JSON.parse(res.output)
      expect(parsed.status).toBe('edited')
      expect(parsed.path).toBe('src/calc.ts')
      expect(parsed.appliedCount).toBe(1)
    })

    it('handles user rejection gracefully without writing to disk', async () => {
      vi.mocked(window.electronAPI.readWorkspaceFile).mockResolvedValue({
        success: true,
        content: 'const a = 1;'
      })

      vi.mocked(mockContext.requestApproval!).mockResolvedValue(false)

      const patch = [
        '<<<<<<< SEARCH',
        'const a = 1;',
        '=======',
        'const a = 2;',
        '>>>>>>> REPLACE'
      ].join('\n')

      const res = await tool.execute({ path: 'test.ts', patch }, mockContext)

      expect(res.success).toBe(false)
      expect(res.rejected).toBe(true)
      expect(res.output).toContain('Edit rejected — no changes were made.')
      expect(window.electronAPI.editWorkspaceFile).not.toHaveBeenCalled()
    })

    it('handles aborted operation signal', async () => {
      vi.mocked(window.electronAPI.readWorkspaceFile).mockResolvedValue({
        success: true,
        content: 'const a = 1;'
      })

      const controller = new AbortController()
      controller.abort()

      const patch = [
        '<<<<<<< SEARCH',
        'const a = 1;',
        '=======',
        'const a = 2;',
        '>>>>>>> REPLACE'
      ].join('\n')

      const res = await tool.execute(
        { path: 'test.ts', patch },
        { ...mockContext, signal: controller.signal }
      )

      expect(res.success).toBe(false)
      expect(res.rejected).toBe(true)
      expect(res.error).toContain('Operation cancelled by user')
      expect(window.electronAPI.editWorkspaceFile).not.toHaveBeenCalled()
    })

    it('supports backward compatibility when passing legacy full newContent without SEARCH block', async () => {
      const originalFile = 'const a = 1;'
      const newFile = 'const a = 1;\nconst b = 2;'

      vi.mocked(window.electronAPI.readWorkspaceFile).mockResolvedValue({
        success: true,
        content: originalFile
      })

      vi.mocked(window.electronAPI.editWorkspaceFile).mockResolvedValue({
        success: true,
        path: 'test.ts'
      })

      const res = await tool.execute(
        { path: 'test.ts', newContent: newFile },
        mockContext
      )

      expect(res.success).toBe(true)
      expect(mockContext.requestApproval).toHaveBeenCalledWith({
        toolName: 'edit_file',
        path: 'test.ts',
        oldContent: originalFile,
        newContent: newFile
      })
      expect(window.electronAPI.editWorkspaceFile).toHaveBeenCalledWith(
        'C:/mock/workspace',
        'test.ts',
        newFile,
        originalFile
      )
    })

    it('treats newContent containing <<<<<<< SEARCH as a patch', async () => {
      const original = 'let x = 10;'
      vi.mocked(window.electronAPI.readWorkspaceFile).mockResolvedValue({
        success: true,
        content: original
      })
      vi.mocked(window.electronAPI.editWorkspaceFile).mockResolvedValue({
        success: true,
        path: 'test.ts'
      })

      const patchInNewContent = [
        '<<<<<<< SEARCH',
        'let x = 10;',
        '=======',
        'let x = 20;',
        '>>>>>>> REPLACE'
      ].join('\n')

      const res = await tool.execute(
        { path: 'test.ts', newContent: patchInNewContent },
        mockContext
      )

      expect(res.success).toBe(true)
      expect(window.electronAPI.editWorkspaceFile).toHaveBeenCalledWith(
        'C:/mock/workspace',
        'test.ts',
        'let x = 20;',
        original
      )
    })
  })

  describe('Phase 14.0 — Shadow Buffer Integration', () => {
    it('applies sequential AI edits to in-memory shadow buffer without disk modification', async () => {
      const { ShadowBuffer } = await import('@renderer/services/agent/shadowBuffer')
      const shadowBuffer = new ShadowBuffer()
      tool.setShadowBuffer(shadowBuffer)

      // Initialize snapshot
      shadowBuffer.createSnapshot('test.ts', 'const a = 1;\n', 'C:/mock/workspace')

      // Edit 1: a = 1 -> a = 2
      const patch1 = [
        '<<<<<<< SEARCH',
        'const a = 1;',
        '=======',
        'const a = 2;',
        '>>>>>>> REPLACE'
      ].join('\n')

      const res1 = await tool.execute({ path: 'test.ts', patch: patch1 }, mockContext)
      expect(res1.success).toBe(true)
      const data1 = JSON.parse(res1.output)
      expect(data1.status).toBe('shadow_updated')
      expect(data1.revision).toBe(1)
      expect(data1.dirty).toBe(true)
      // Real file was NOT written!
      expect(window.electronAPI.editWorkspaceFile).not.toHaveBeenCalled()
      expect(mockContext.requestApproval).not.toHaveBeenCalled()

      // Edit 2: a = 2 -> a = 3
      const patch2 = [
        '<<<<<<< SEARCH',
        'const a = 2;',
        '=======',
        'const a = 3;',
        '>>>>>>> REPLACE'
      ].join('\n')

      const res2 = await tool.execute({ path: 'test.ts', patch: patch2 }, mockContext)
      expect(res2.success).toBe(true)
      const data2 = JSON.parse(res2.output)
      expect(data2.status).toBe('shadow_updated')
      expect(data2.revision).toBe(2)
      expect(window.electronAPI.editWorkspaceFile).not.toHaveBeenCalled()

      // Shadow content is now 'const a = 3;\n'
      expect(shadowBuffer.getShadowContent('test.ts', 'C:/mock/workspace')).toBe('const a = 3;\n')
      expect(shadowBuffer.getOriginalContent('test.ts', 'C:/mock/workspace')).toBe('const a = 1;\n')
    })

    it('commits shadow changes to disk with user approval when commit: true is specified', async () => {
      const { ShadowBuffer } = await import('@renderer/services/agent/shadowBuffer')
      const shadowBuffer = new ShadowBuffer()
      tool.setShadowBuffer(shadowBuffer)

      shadowBuffer.createSnapshot('test.ts', 'const a = 1;\n', 'C:/mock/workspace')

      vi.mocked(window.electronAPI.readWorkspaceFile).mockResolvedValue({
        success: true,
        content: 'const a = 1;\n'
      })
      vi.mocked(window.electronAPI.editWorkspaceFile).mockResolvedValue({
        success: true,
        path: 'test.ts'
      })

      const patch = [
        '<<<<<<< SEARCH',
        'const a = 1;',
        '=======',
        'const a = 99;',
        '>>>>>>> REPLACE'
      ].join('\n')

      const res = await tool.execute(
        { path: 'test.ts', patch, commit: true },
        mockContext
      )

      expect(res.success).toBe(true)
      expect(mockContext.requestApproval).toHaveBeenCalled()
      expect(window.electronAPI.editWorkspaceFile).toHaveBeenCalledWith(
        'C:/mock/workspace',
        'test.ts',
        'const a = 99;\n',
        'const a = 1;\n'
      )

      const snapshot = shadowBuffer.getSnapshot('test.ts', 'C:/mock/workspace')
      expect(snapshot?.dirty).toBe(false)
      expect(snapshot?.originalContent).toBe('const a = 99;\n')
    })

    it('rejects commit when external disk changes cause a stale hash conflict', async () => {
      const { ShadowBuffer } = await import('@renderer/services/agent/shadowBuffer')
      const shadowBuffer = new ShadowBuffer()
      tool.setShadowBuffer(shadowBuffer)

      shadowBuffer.createSnapshot('test.ts', 'const a = 1;\n', 'C:/mock/workspace')

      // Simulate external modification to 'const a = 42;\n'
      vi.mocked(window.electronAPI.readWorkspaceFile).mockResolvedValue({
        success: true,
        content: 'const a = 42;\n'
      })

      const patch = [
        '<<<<<<< SEARCH',
        'const a = 1;',
        '=======',
        'const a = 99;',
        '>>>>>>> REPLACE'
      ].join('\n')

      const res = await tool.execute(
        { path: 'test.ts', patch, commit: true },
        mockContext
      )

      expect(res.success).toBe(false)
      expect(res.error).toContain('SHADOW_CONFLICT')
      expect(window.electronAPI.editWorkspaceFile).not.toHaveBeenCalled()
    })
  })
})
