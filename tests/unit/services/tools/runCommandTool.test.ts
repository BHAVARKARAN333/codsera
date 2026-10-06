import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RunCommandTool } from '../../../../src/renderer/src/services/tools/runCommandTool'
import type { ToolContext } from '../../../../src/renderer/src/services/tools/types'
import { setupMockElectron, resetMockElectron } from '../../../setup/electronMock'

describe('RunCommandTool Unit & Integration Tests (Phase 11.3)', () => {
  let tool: RunCommandTool
  const mockWorkspace = 'C:/Users/tester/workspace'

  beforeEach(() => {
    tool = new RunCommandTool()
    setupMockElectron({
      runCommand: vi.fn()
    })
    vi.restoreAllMocks()
  })

  afterEach(() => {
    resetMockElectron()
    vi.clearAllMocks()
  })

  // ==========================================================================
  // Group 1: Tool Declaration & Validation
  // ==========================================================================
  describe('Tool Declaration & Validation', () => {
    it('has expected metadata and requires user approval', () => {
      expect(tool.name).toBe('run_command')
      expect(tool.requiresApproval).toBe(true)
      expect(tool.description).toContain('Executes a terminal/shell command')
      expect(tool.parameters.required).toContain('command')
    })

    it('rejects execution if workspaceRoot is missing', async () => {
      const res = await tool.execute({ command: 'npm test' }, { workspaceRoot: null })
      expect(res.success).toBe(false)
      expect(res.error).toContain('No workspace folder is currently open')
    })

    it('rejects execution if command is empty or missing', async () => {
      const res = await tool.execute({ command: '   ' }, { workspaceRoot: mockWorkspace })
      expect(res.success).toBe(false)
      expect(res.error).toContain('Missing or empty "command" parameter')
    })

    it('rejects commands that attempt path traversal or workspace escape', async () => {
      const res = await tool.execute(
        { command: 'cd .. && dir' },
        { workspaceRoot: mockWorkspace }
      )
      expect(res.success).toBe(false)
      expect(res.error).toContain('Command rejected')
    })
  })

  // ==========================================================================
  // Group 2: User Approval & Abort Signal
  // ==========================================================================
  describe('Approval & Cancellation Handling', () => {
    it('rejects execution if requestApproval handler is not provided', async () => {
      const res = await tool.execute(
        { command: 'npm test' },
        { workspaceRoot: mockWorkspace }
      )
      expect(res.success).toBe(false)
      expect(res.rejected).toBe(true)
      expect(res.error).toContain('approval handler is required')
    })

    it('rejects execution without running command when user declines approval', async () => {
      const mockRunCommand = vi.fn()
      setupMockElectron({ runCommand: mockRunCommand })

      const context: ToolContext = {
        workspaceRoot: mockWorkspace,
        requestApproval: vi.fn().mockResolvedValue(false)
      }

      const res = await tool.execute({ command: 'npm test' }, context)
      expect(res.success).toBe(false)
      expect(res.rejected).toBe(true)
      expect(res.output).toContain('Command rejected — nothing was executed.')
      expect(mockRunCommand).not.toHaveBeenCalled()
    })

    it('aborts execution when signal is already cancelled', async () => {
      const mockRunCommand = vi.fn()
      setupMockElectron({ runCommand: mockRunCommand })

      const abortController = new AbortController()
      abortController.abort()

      const context: ToolContext = {
        workspaceRoot: mockWorkspace,
        signal: abortController.signal,
        requestApproval: vi.fn().mockResolvedValue(true)
      }

      const res = await tool.execute({ command: 'npm test' }, context)
      expect(res.success).toBe(false)
      expect(res.rejected).toBe(true)
      expect(mockRunCommand).not.toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // Group 3: ANSI Sanitization & Head/Tail Compression Integration
  // ==========================================================================
  describe('ANSI Sanitization & Head/Tail Compression Integration', () => {
    it('sanitizes ANSI escape sequences from stdout in the AI-facing structured result', async () => {
      const ansiStdout = '\x1b[32m[PASS]\x1b[0m All 10 tests passed in \x1b[1m42ms\x1b[22m\n'
      const mockRunCommand = vi.fn().mockResolvedValue({
        success: true,
        exitCode: 0,
        stdout: ansiStdout,
        stderr: ''
      })
      setupMockElectron({ runCommand: mockRunCommand })

      const context: ToolContext = {
        workspaceRoot: mockWorkspace,
        requestApproval: vi.fn().mockResolvedValue(true)
      }

      const res = await tool.execute({ command: 'npm test' }, context)
      expect(res.success).toBe(true)

      const structured = JSON.parse(res.output)
      expect(structured.stdout).toBe('[PASS] All 10 tests passed in 42ms\n')
      expect(structured.stdout).not.toContain('\x1b')
      expect(structured.compression.stdout.isCompressed).toBe(false)
    })

    it('compresses stdout exceeding 30 lines (first 5 and last 25 lines preserved) for AI context', async () => {
      const rawLines = Array.from({ length: 80 }, (_, i) => `Test Output Line #${i + 1}`)
      const rawStdout = rawLines.join('\n')

      const mockRunCommand = vi.fn().mockResolvedValue({
        success: true,
        exitCode: 0,
        stdout: rawStdout,
        stderr: ''
      })
      setupMockElectron({ runCommand: mockRunCommand })

      const context: ToolContext = {
        workspaceRoot: mockWorkspace,
        requestApproval: vi.fn().mockResolvedValue(true)
      }

      const res = await tool.execute({ command: 'npm run big-test' }, context)
      expect(res.success).toBe(true)

      const structured = JSON.parse(res.output)
      expect(structured.compression.stdout.isCompressed).toBe(true)
      expect(structured.compression.stdout.originalLines).toBe(80)
      expect(structured.compression.stdout.returnedLines).toBe(30)
      expect(structured.compression.stdout.omittedLines).toBe(50)

      const returnedLines = structured.stdout.split('\n')
      // 5 head + 1 marker + 25 tail = 31 lines
      expect(returnedLines).toHaveLength(31)
      expect(returnedLines.slice(0, 5)).toEqual([
        'Test Output Line #1',
        'Test Output Line #2',
        'Test Output Line #3',
        'Test Output Line #4',
        'Test Output Line #5'
      ])
      expect(returnedLines[5]).toBe('[... 50 lines omitted ...]')
      expect(returnedLines.slice(6)).toEqual(rawLines.slice(55))
    })

    it('notifies context.onCommandExecuted with RAW unmodified terminal output (UI stream unaffected)', async () => {
      const rawAnsiStdout =
        '\x1b[31m[FAIL]\x1b[0m Detailed stack trace with raw ANSI codes\r\n\x1b[2K\x1b[1GOverwritten line'
      const rawStderr = '\x1b[33m[WARN]\x1b[0m Deprecation notice'

      const mockRunCommand = vi.fn().mockResolvedValue({
        success: false,
        exitCode: 1,
        stdout: rawAnsiStdout,
        stderr: rawStderr
      })
      setupMockElectron({ runCommand: mockRunCommand })

      const onCommandExecuted = vi.fn()
      const context: ToolContext = {
        workspaceRoot: mockWorkspace,
        requestApproval: vi.fn().mockResolvedValue(true),
        onCommandExecuted
      }

      const res = await tool.execute({ command: 'npm test' }, context)
      expect(res.success).toBe(false)

      // 1. Terminal UI callback received RAW untouched stdout and stderr with all ANSI escapes
      expect(onCommandExecuted).toHaveBeenCalledTimes(1)
      expect(onCommandExecuted).toHaveBeenCalledWith('npm test', {
        stdout: rawAnsiStdout,
        stderr: rawStderr,
        exitCode: 1
      })

      // 2. AI model result is completely sanitized
      const structured = JSON.parse(res.output)
      expect(structured.stdout).not.toContain('\x1b')
      expect(structured.stderr).not.toContain('\x1b')
      expect(structured.stderr).toBe('[WARN] Deprecation notice')
      expect(res.error).not.toContain('\x1b')
    })

    it('sanitizes stderr in error message when command fails', async () => {
      const mockRunCommand = vi.fn().mockResolvedValue({
        success: false,
        exitCode: 2,
        stdout: '',
        stderr: '\x1b[31mSyntaxError: Unexpected token <\x1b[0m\n'
      })
      setupMockElectron({ runCommand: mockRunCommand })

      const context: ToolContext = {
        workspaceRoot: mockWorkspace,
        requestApproval: vi.fn().mockResolvedValue(true)
      }

      const res = await tool.execute({ command: 'node bad.js' }, context)
      expect(res.success).toBe(false)
      expect(res.error).toContain('SyntaxError: Unexpected token <')
      expect(res.error).not.toContain('\x1b')
    })

    it('handles unexpected runtime exceptions without crashing and without fabricating data', async () => {
      const mockRunCommand = vi.fn().mockRejectedValue(new Error('Process terminated unexpectedly'))
      setupMockElectron({ runCommand: mockRunCommand })

      const context: ToolContext = {
        workspaceRoot: mockWorkspace,
        requestApproval: vi.fn().mockResolvedValue(true)
      }

      const res = await tool.execute({ command: 'npm test' }, context)
      expect(res.success).toBe(false)
      expect(res.output).toBe('')
      expect(res.error).toContain('Command execution error: Process terminated unexpectedly')
    })
  })
})
