import { ITool, ToolContext, ToolExecutionResult } from './types'

export class CreateFileTool implements ITool {
  readonly name = 'create_file'
  readonly requiresApproval = true
  readonly description =
    'Creates a new file in the workspace. Use this tool ONLY when the user explicitly asks to create or add a new file. The user will be asked to preview and approve the file content before it is created. Do NOT use this tool to overwrite or modify existing files.'

  readonly parameters = {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'The relative path of the new file to create inside the workspace (e.g. "src/utils/math.ts").'
      },
      content: {
        type: 'string',
        description: 'The complete initial code or text content to write into the new file.'
      }
    },
    required: ['path', 'content']
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

    const filePath = args && typeof args.path === 'string' ? args.path.trim() : ''
    const fileContent = args && typeof args.content === 'string' ? args.content : ''

    if (!filePath) {
      return {
        success: false,
        output: '',
        error: 'Missing or invalid "path" parameter. Please specify the relative path of the new file.'
      }
    }

    // Require explicit user approval before writing to disk (fail-safe if missing)
    if (!context.requestApproval) {
      return {
        success: false,
        rejected: true,
        output: 'File creation rejected: approval handler is required but was not provided.',
        error: 'File creation rejected: approval handler is required but was not provided.'
      }
    }

    const isApproved = await context.requestApproval({
      toolName: 'create_file',
      path: filePath,
      content: fileContent
    })

    if (!isApproved) {
      return {
        success: false,
        rejected: true,
        output: 'File creation rejected — no changes were made.',
        error: 'File creation rejected — no changes were made.'
      }
    }

    if (context.signal?.aborted) {
      return {
        success: false,
        rejected: true,
        output: 'Operation cancelled by user — no file was created.',
        error: 'Operation cancelled by user.'
      }
    }

    try {
      if (!window?.electronAPI || typeof window.electronAPI.createWorkspaceFile !== 'function') {
        return {
          success: false,
          output: '',
          error: 'Filesystem file creation API is not available in this window.'
        }
      }

      const result = await window.electronAPI.createWorkspaceFile(
        context.workspaceRoot,
        filePath,
        fileContent
      )

      if (result.success) {
        const createdPath = result.path || filePath
        context.onFileCreated?.(createdPath)
        return {
          success: true,
          output: JSON.stringify({ status: 'created', path: createdPath }, null, 2)
        }
      } else {
        return {
          success: false,
          output: '',
          error: result.error || `Failed to create file: '${filePath}'`
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
