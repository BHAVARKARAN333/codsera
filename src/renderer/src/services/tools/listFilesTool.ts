import { ITool, ToolContext, ToolExecutionResult } from './types'

export class ListFilesTool implements ITool {
  readonly name = 'list_files'
  readonly description =
    'Lists files and directories in the workspace. Use this tool ONLY when the user asks about the files, folders, or directory structure of the project. Do NOT call this tool for greetings, general programming questions, or conversational requests.'

  readonly parameters = {
    type: 'object',
    properties: {
      relativePath: {
        type: 'string',
        description: 'Optional relative path within the workspace to inspect (defaults to root).'
      },
      maxDepth: {
        type: 'number',
        description: 'Maximum depth for directory traversal (default: 4, range 1-6).'
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

    const relativePath = typeof args.relativePath === 'string' ? args.relativePath : undefined
    const maxDepth = typeof args.maxDepth === 'number' ? args.maxDepth : 4

    try {
      const result = await window.electronAPI.listFiles(context.workspaceRoot, {
        relativePath,
        maxDepth
      })

      if (result.success && result.treeString !== undefined) {
        return {
          success: true,
          output: `Project Tree (${result.totalFiles || 0} files, ${result.totalDirs || 0} folders):\n${result.treeString}`
        }
      } else {
        return {
          success: false,
          output: '',
          error: result.error || 'Failed to list directory contents.'
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        success: false,
        output: '',
        error: `Tool execution error: ${message}`
      }
    }
  }
}
