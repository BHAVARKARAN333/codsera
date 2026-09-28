import { ITool, ToolContext, ToolExecutionResult } from './types'

export class GitStatusTool implements ITool {
  readonly name = 'git_status'
  readonly description =
    'Inspects the current Git repository status in the workspace, including current branch, staged files, unstaged changes, untracked files, and conflicts. Strictly read-only.'

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
      if (!window?.electronAPI || typeof window.electronAPI.gitStatus !== 'function') {
        return {
          success: false,
          output: '',
          error: 'Git status API is not available in this window.'
        }
      }

      const result = await window.electronAPI.gitStatus(context.workspaceRoot)

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
          error: result.error || 'Git command failed to execute.'
        }
      }

      const structured = {
        isRepository: true,
        branch: result.branch,
        clean: result.clean,
        staged: result.staged,
        unstaged: result.unstaged,
        untracked: result.untracked,
        conflicted: result.conflicted
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
        error: `Git status error: ${msg}`
      }
    }
  }
}
