import { ITool, ToolContext, ToolExecutionResult } from './types'

export class ReadFileTool implements ITool {
  readonly name = 'read_file'
  readonly description =
    'Reads the contents of a specific file in the workspace. Use this tool ONLY when the user asks to inspect, explain, read, or analyze a specific file. Do NOT call this tool for greetings, general programming questions, or when only file names/structure are requested.'

  readonly parameters = {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'The relative path of the file to read within the workspace (e.g. "src/App.tsx", "package.json").'
      }
    },
    required: ['path']
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

    const filePath = typeof args.path === 'string' ? args.path.trim() : ''
    if (!filePath) {
      return {
        success: false,
        output: '',
        error: 'Missing or invalid "path" parameter. Please specify the relative path of the file to read.'
      }
    }

    try {
      if (!window?.electronAPI || typeof window.electronAPI.readWorkspaceFile !== 'function') {
        // Safe fallback to readFile if readWorkspaceFile is somehow not available
        if (typeof window?.electronAPI?.readFile === 'function') {
          const sep = context.workspaceRoot.includes('\\') ? '\\' : '/'
          const target = filePath.startsWith('/') || filePath.startsWith('\\') ? filePath.slice(1) : filePath
          const fullPath = `${context.workspaceRoot}${sep}${target}`
          const fallbackRes = await window.electronAPI.readFile(fullPath)
          if (fallbackRes.success && fallbackRes.content !== undefined) {
            return {
              success: true,
              output: JSON.stringify(
                {
                  path: filePath,
                  content: fallbackRes.content
                },
                null,
                2
              )
            }
          }
          return {
            success: false,
            output: '',
            error: fallbackRes.error || `Failed to read file: '${filePath}'`
          }
        }

        return {
          success: false,
          output: '',
          error: 'Filesystem read API is not available in this window.'
        }
      }

      const result = await window.electronAPI.readWorkspaceFile(context.workspaceRoot, filePath)

      if (result.success && result.content !== undefined) {
        return {
          success: true,
          output: JSON.stringify(
            {
              path: result.path || filePath,
              content: result.content
            },
            null,
            2
          )
        }
      } else {
        return {
          success: false,
          output: '',
          error: result.error || `Failed to read file: '${filePath}'`
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
