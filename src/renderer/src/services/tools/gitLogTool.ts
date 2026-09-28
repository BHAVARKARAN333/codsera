import { ITool, ToolContext, ToolExecutionResult } from './types'

export class GitLogTool implements ITool {
  readonly name = 'git_log'
  readonly description =
    'Inspects recent Git commits in the workspace (hash, author, date, message). Strictly read-only.'

  readonly parameters = {
    type: 'object',
    properties: {
      maxCount: {
        type: 'number',
        description:
          'Maximum number of recent commits to inspect (default 10, maximum 25).'
      }
    }
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

    const maxCount =
      typeof args?.maxCount === 'number' && args.maxCount > 0 ? args.maxCount : 10

    try {
      if (!window?.electronAPI || typeof window.electronAPI.gitLog !== 'function') {
        return {
          success: false,
          output: '',
          error: 'Git log API is not available in this window.'
        }
      }

      const result = await window.electronAPI.gitLog(context.workspaceRoot, maxCount)

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
          error: result.error || 'Git log failed to execute.'
        }
      }

      const structured = {
        isRepository: true,
        commitCount: result.commits.length,
        commits: result.commits
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
        error: `Git log error: ${msg}`
      }
    }
  }
}
