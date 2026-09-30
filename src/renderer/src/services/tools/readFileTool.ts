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

    if (context.signal?.aborted) {
      return {
        success: false,
        output: '',
        error: 'Tool execution was aborted by user.'
      }
    }

    const MAX_FILE_CHARS = 12000
    const TRUNCATION_NOTICE = '\n[... Truncated remainder of file to conserve budget ...]'

    const formatContentOutput = (pathVal: string, rawContent: string): ToolExecutionResult => {
      let content = rawContent
      let truncated = false
      const rawChars = rawContent.length

      if (content.length > MAX_FILE_CHARS) {
        content = content.slice(0, MAX_FILE_CHARS) + TRUNCATION_NOTICE
        truncated = true
      }

      return {
        success: true,
        output: JSON.stringify(
          {
            path: pathVal,
            content,
            truncated,
            charCount: content.length,
            rawChars
          },
          null,
          2
        )
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

          if (context.signal?.aborted) {
            return {
              success: false,
              output: '',
              error: 'Tool execution was aborted by user.'
            }
          }

          if (fallbackRes.success && fallbackRes.content !== undefined) {
            return formatContentOutput(filePath, fallbackRes.content)
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

      if (context.signal?.aborted) {
        return {
          success: false,
          output: '',
          error: 'Tool execution was aborted by user.'
        }
      }

      if (result.success && result.content !== undefined) {
        return formatContentOutput(result.path || filePath, result.content)
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
