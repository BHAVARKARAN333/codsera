import { ITool, ToolContext, ToolExecutionResult } from './types'

export class GitDiffTool implements ITool {
  readonly name = 'git_diff'
  readonly description =
    'Inspects the current Git diff in the workspace, including unstaged and staged changes. Strictly read-only.'

  readonly parameters = {
    type: 'object',
    properties: {}
  }

  async execute(
    _args: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    if (!context.workspaceRoot) {
      return {
        success: false,
        output: '',
        error: 'No workspace folder is currently open. Please open a folder first.'
      }
    }

    try {
      if (!window?.electronAPI || typeof window.electronAPI.gitDiff !== 'function') {
        return {
          success: false,
          output: '',
          error: 'Git diff API is not available in this window.'
        }
      }

      const result = await window.electronAPI.gitDiff(context.workspaceRoot)

      if (!result.isRepository) {
        return {
          success: true,
          output: JSON.stringify(
            {
              isRepository: false,
              message: result.error || 'This workspace is not a Git repository.'
            },
            null,
            2
          )
        }
      }

      if (!result.success) {
        return {
          success: false,
          output: '',
          error: result.error || 'Git diff failed to execute.'
        }
      }

      const structured = {
        isRepository: true,
        hasChanges: !!(result.unstagedDiff?.trim() || result.stagedDiff?.trim()),
        unstagedDiff: result.unstagedDiff || '(no unstaged changes)',
        stagedDiff: result.stagedDiff || '(no staged changes)',
        truncated: result.truncated || false
      }

      return {
        success: true,
        output: JSON.stringify(structured, null, 2)
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        success: false,
        output: '',
        error: `Git diff error: ${msg}`
      }
    }
  }
}
