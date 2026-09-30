import { ITool, ToolContext, ToolExecutionResult } from './types'
import { validateCommandSafety } from '../../../../shared/commandValidator'

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

      // Notify any active terminal panels
      context.onCommandExecuted?.(command, {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode
      })

      // Limit output size returned to AI model to prevent token exhaustion (max 20,000 chars)
      let formattedStdout = result.stdout || ''
      if (formattedStdout.length > 20000) {
        formattedStdout = formattedStdout.slice(0, 20000) + '\n\n[...stdout truncated at 20,000 characters]'
      }

      let formattedStderr = result.stderr || ''
      if (formattedStderr.length > 10000) {
        formattedStderr = formattedStderr.slice(0, 10000) + '\n\n[...stderr truncated at 10,000 characters]'
      }

      const structuredResult = {
        success: result.success,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        stdout: formattedStdout,
        stderr: formattedStderr,
        error: result.error
      }

      if (result.success) {
        return {
          success: true,
          output: JSON.stringify(structuredResult, null, 2)
        }
      } else {
        return {
          success: false,
          output: JSON.stringify(structuredResult, null, 2),
          error:
            result.error ||
            `Command exited with code ${result.exitCode ?? 'unknown'}.${result.stderr ? ` Stderr: ${result.stderr.slice(0, 300)}` : ''}`
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
