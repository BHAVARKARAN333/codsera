import { ITool, ToolContext, ToolExecutionResult } from './types'

export class EditFileTool implements ITool {
  readonly name = 'edit_file'
  readonly description =
    'Proposes changes to an existing file in the workspace. Use this tool ONLY when the user explicitly asks to modify, update, or fix code in an existing file. The proposed changes will be displayed as a diff preview for explicit user approval before writing to disk. The file MUST already exist. Do NOT use this tool to create new files.'

  readonly parameters = {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'The relative path of the existing file to edit inside the workspace (e.g. "src/utils/math.ts").'
      },
      newContent: {
        type: 'string',
        description:
          'The complete modified code or text content to replace the existing file content.'
      }
    },
    required: ['path', 'newContent']
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
    const newContent = typeof args.newContent === 'string' ? args.newContent : ''

    if (!filePath) {
      return {
        success: false,
        output: '',
        error: 'Missing or invalid "path" parameter. Please specify the relative path of the file to edit.'
      }
    }

    if (typeof args.newContent !== 'string') {
      return {
        success: false,
        output: '',
        error: 'Missing or invalid "newContent" parameter. Please provide the modified content.'
      }
    }

    // Step 1: Read the existing file content from disk to verify existence and generate diff
    if (!window?.electronAPI || typeof window.electronAPI.readWorkspaceFile !== 'function') {
      return {
        success: false,
        output: '',
        error: 'Filesystem read API is not available in this window.'
      }
    }

    const readResult = await window.electronAPI.readWorkspaceFile(
      context.workspaceRoot,
      filePath
    )

    if (!readResult.success) {
      const isNotFound =
        readResult.error?.toLowerCase().includes('not found') ||
        readResult.error?.toLowerCase().includes('no such file')

      return {
        success: false,
        output: '',
        error: isNotFound
          ? `File does not exist: '${filePath}'. Use create_file instead.`
          : readResult.error || `Failed to read existing file: '${filePath}'`
      }
    }

    const oldContent = readResult.content ?? ''

    // Step 2: Request explicit user approval with diff preview before modifying the file
    if (context.requestApproval) {
      const isApproved = await context.requestApproval({
        toolName: 'edit_file',
        path: filePath,
        oldContent,
        newContent
      })

      if (!isApproved) {
        return {
          success: false,
          rejected: true,
          output: 'Edit rejected — no changes were made.',
          error: 'Edit rejected — no changes were made.'
        }
      }
    }

    // Step 3: Apply the approved changes with concurrency protection
    try {
      if (typeof window.electronAPI.editWorkspaceFile !== 'function') {
        return {
          success: false,
          output: '',
          error: 'Filesystem edit API is not available in this window.'
        }
      }

      const result = await window.electronAPI.editWorkspaceFile(
        context.workspaceRoot,
        filePath,
        newContent,
        oldContent
      )

      if (result.success) {
        const editedPath = result.path || filePath
        context.onFileEdited?.(editedPath, newContent)
        return {
          success: true,
          output: JSON.stringify({ status: 'edited', path: editedPath }, null, 2)
        }
      } else {
        return {
          success: false,
          output: '',
          error: result.error || `Failed to edit file: '${filePath}'`
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
