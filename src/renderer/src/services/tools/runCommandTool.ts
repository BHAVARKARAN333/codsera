import { ITool, ToolContext, ToolExecutionResult } from './types'
import { validateCommandSafety } from '../../../../shared/commandValidator'
import { processTerminalOutputForAI } from '../../../../shared/terminalSanitizer'

const DANGEROUS_PATTERNS = [
  /\brm\s+-[rf]+/i,
  /\brmdir\b/i,
  /\bdel\s+[\/f\/s\/q]*/i,
  /\berase\b/i,
  /\bformat\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bdiskpart\b/i,
  /\breg\s+delete\b/i,
  /\bRemove-Item\b/i,
  /\bDrop-Database\b/i,
  /\bgit\s+(?:clean\s+-[a-z]*f|reset\s+--hard)/i
]

function isPotentiallyDangerous(cmd: string): boolean {
  return DANGEROUS_PATTERNS.some((pattern) => pattern.test(cmd))
}

export class RunCommandTool implements ITool {
  readonly name = 'run_command'
  readonly requiresApproval = true
  readonly description =
    'Executes a terminal/shell command inside the currently opened workspace. Use this tool ONLY when the user explicitly requests running a command, executing tests, building the project, or running scripts. The command requires explicit user approval before execution. The working directory is strictly locked to the workspace root.'

  readonly parameters = {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description:
          'The shell command to execute in the workspace root directory (e.g. "npm test", "npm run build", "python script.py").'
      }
    },
    required: ['command']
  }

  async execute(
    args: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    if (!context.workspaceRoot) {
      return {
        success: false,
        output: '',
        error: 'No workspace folder is currently open. Please open a folder first.'
      }
    }

    const command = args && typeof args.command === 'string' ? args.command.trim() : ''

    if (!command) {
      return {
        success: false,
        output: '',
        error: 'Missing or empty "command" parameter. Please specify the command to execute.'
      }
    }

    // Step 1: Pre-approval Safety Validation - Prevent workspace escape and path traversal
    const safetyCheck = validateCommandSafety(command, context.workspaceRoot)
    if (!safetyCheck.safe) {
      return {
        success: false,
        output: '',
        error:
          safetyCheck.error ||
          'Command rejected: working directory must remain inside the current workspace.'
      }
    }

    const isDangerous = isPotentiallyDangerous(command)

    // Step 2: Require explicit user approval before running any command (fail-safe if missing)
    if (!context.requestApproval) {
      return {
        success: false,
        rejected: true,
        output: 'Command rejected: approval handler is required but was not provided.',
        error: 'Command rejected: approval handler is required but was not provided.'
      }
    }

    const isApproved = await context.requestApproval({
      toolName: 'run_command',
      path: context.workspaceRoot,
      command,
      isDangerous
    })

    if (!isApproved) {
      return {
        success: false,
        rejected: true,
        output: 'Command rejected — nothing was executed.',
        error: 'Command rejected — nothing was executed.'
      }
    }

    if (context.signal?.aborted) {
      return {
        success: false,
        rejected: true,
        output: 'Operation cancelled by user — no command was executed.',
        error: 'Operation cancelled by user.'
      }
    }

    // Step 3: Execute command safely in Electron main process
    try {
      if (!window?.electronAPI || typeof window.electronAPI.runCommand !== 'function') {
        return {
          success: false,
          output: '',
          error: 'Command execution API is not available in this window.'
        }
      }

      const result = await window.electronAPI.runCommand(command, context.workspaceRoot)

      // Step 4: Notify active terminal panels with RAW unmodified stdout/stderr
      context.onCommandExecuted?.(command, {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode
      })

      // Step 5: Sanitize ANSI/control sequences and apply deterministic head/tail compression for AI context
      const processedStdout = processTerminalOutputForAI(result.stdout || '')
      const processedStderr = processTerminalOutputForAI(result.stderr || '')

      const structuredResult = {
        success: result.success,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        stdout: processedStdout.text,
        stderr: processedStderr.text,
        error: result.error,
        compression: {
          stdout: {
            originalLines: processedStdout.originalLineCount,
            returnedLines: processedStdout.returnedLineCount,
            isCompressed: processedStdout.isCompressed,
            omittedLines: processedStdout.omittedLineCount,
            isCharacterTruncated: processedStdout.isCharacterTruncated
          },
          stderr: {
            originalLines: processedStderr.originalLineCount,
            returnedLines: processedStderr.returnedLineCount,
            isCompressed: processedStderr.isCompressed,
            omittedLines: processedStderr.omittedLineCount,
            isCharacterTruncated: processedStderr.isCharacterTruncated
          }
        }
      }

      if (result.success) {
        return {
          success: true,
          output: JSON.stringify(structuredResult, null, 2)
        }
      } else {
        const stderrSnippet = processedStderr.text
          ? ` Stderr: ${processedStderr.text.slice(0, 300)}`
          : ''
        return {
          success: false,
          output: JSON.stringify(structuredResult, null, 2),
          error:
            result.error ||
            `Command exited with code ${result.exitCode ?? 'unknown'}.${stderrSnippet}`
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        success: false,
        output: '',
        error: `Command execution error: ${message}`
      }
    }
  }
}
