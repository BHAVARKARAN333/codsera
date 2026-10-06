import { ITool, ToolContext, ToolExecutionResult } from './types'
import { applySearchReplacePatch } from '@shared/diffUtils'
import type { ShadowBuffer } from '../agent/shadowBuffer'

export class EditFileTool implements ITool {
  readonly name = 'edit_file'
  readonly requiresApproval = true
  readonly description =
    'Proposes targeted modifications to an existing file in the workspace using SEARCH/REPLACE blocks. Use this tool ONLY when the user explicitly asks to modify, update, or fix code in an existing file. Provide one or more SEARCH/REPLACE blocks matching existing code to replace. The proposed changes will be displayed as a diff preview for explicit user approval before writing to disk. The file MUST already exist. Do NOT use this tool to create new files.\n\nExample:\n<<<<<<< SEARCH\nfunction add(a, b) {\n  return a - b;\n}\n=======\nfunction add(a, b) {\n  return a + b;\n}\n>>>>>>> REPLACE'

  private shadowBuffer?: ShadowBuffer

  constructor(shadowBuffer?: ShadowBuffer) {
    this.shadowBuffer = shadowBuffer
  }

  setShadowBuffer(buffer?: ShadowBuffer): void {
    this.shadowBuffer = buffer
  }

  getShadowBuffer(): ShadowBuffer | undefined {
    return this.shadowBuffer
  }

  readonly parameters = {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'The relative path of the existing file to edit inside the workspace (e.g. "src/utils/math.ts").'
      },
      patch: {
        type: 'string',
        description:
          'One or more SEARCH/REPLACE blocks defining the exact targeted code to replace:\n<<<<<<< SEARCH\nexact existing code\n=======\nreplacement code\n>>>>>>> REPLACE'
      },
      newContent: {
        type: 'string',
        description:
          'Patch containing SEARCH/REPLACE blocks, or legacy full file content.'
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

    const filePath = args && typeof args.path === 'string' ? args.path.trim() : ''

    if (!filePath) {
      return {
        success: false,
        output: '',
        error: 'Missing or invalid "path" parameter. Please specify the relative path of the file to edit.'
      }
    }

    const patchArg =
      args && typeof args.patch === 'string'
        ? args.patch
        : args && typeof args.edits === 'string'
        ? args.edits
        : undefined

    const newContentArg =
      args && typeof args.newContent === 'string' ? args.newContent : undefined

    if (patchArg === undefined && newContentArg === undefined) {
      return {
        success: false,
        output: '',
        error:
          'Missing or invalid "patch" or "newContent" parameter. Please provide SEARCH/REPLACE blocks or modified content.'
      }
    }

    // Step 1: Resolve existing baseline content (from ShadowBuffer if active, or disk)
    const effectiveShadowBuffer = this.shadowBuffer ?? context.shadowBuffer
    const hasExistingShadow = Boolean(
      effectiveShadowBuffer?.hasSnapshot(filePath, context.workspaceRoot)
    )
    const requestUseShadow = Boolean(args.useShadow || args.createShadow)

    let oldContent = ''
    let isFromShadow = false

    if (hasExistingShadow && effectiveShadowBuffer) {
      oldContent = effectiveShadowBuffer.getShadowContent(filePath, context.workspaceRoot) ?? ''
      isFromShadow = true
    } else {
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

      oldContent = readResult.content ?? ''

      if (requestUseShadow && effectiveShadowBuffer) {
        effectiveShadowBuffer.createSnapshot(filePath, oldContent, context.workspaceRoot)
        isFromShadow = true
      }
    }

    let resolvedNewContent = ''
    let patchMeta: { appliedCount?: number; matchedBy?: Array<'exact' | 'fuzzy'> } = {}

    // Determine whether to apply SEARCH/REPLACE patch or full-file content
    const isPatch =
      patchArg !== undefined ||
      (typeof newContentArg === 'string' && newContentArg.includes('<<<<<<< SEARCH'))

    if (isPatch) {
      const patchText = patchArg !== undefined ? patchArg : (newContentArg as string)
      const patchResult = applySearchReplacePatch(oldContent, patchText)

      if (!patchResult.success || typeof patchResult.content !== 'string') {
        return {
          success: false,
          output: '',
          error: patchResult.error || 'Failed to apply patch to file.'
        }
      }

      resolvedNewContent = patchResult.content
      patchMeta = {
        appliedCount: patchResult.appliedCount,
        matchedBy: patchResult.matchedBy
      }
    } else {
      // Backward compatibility: full-file replacement
      resolvedNewContent = newContentArg as string
    }

    // Step 2: Handle ShadowBuffer branch (in-memory AI staging or explicit commit)
    if (isFromShadow && effectiveShadowBuffer) {
      const updateRes = effectiveShadowBuffer.updateShadowContent(
        filePath,
        resolvedNewContent,
        context.workspaceRoot
      )

      if (!updateRes.success) {
        return {
          success: false,
          output: '',
          error: updateRes.error || 'Failed to update shadow buffer.'
        }
      }

      const revision = updateRes.entry?.revision ?? 1
      context.onShadowUpdated?.(filePath, resolvedNewContent, revision)

      // If commit flag is not explicitly set, complete the in-memory shadow update without touching disk
      if (args.commit !== true) {
        return {
          success: true,
          output: JSON.stringify(
            {
              status: 'shadow_updated',
              path: filePath,
              revision,
              dirty: true,
              isShadow: true,
              ...patchMeta
            },
            null,
            2
          )
        }
      }

      // Explicit commit requested: run full commit flow with stale protection and approval
      const commitRes = await effectiveShadowBuffer.commit(filePath, {
        workspaceRoot: context.workspaceRoot,
        requestApproval: context.requestApproval,
        onFileEdited: context.onFileEdited
      })

      if (!commitRes.success) {
        return {
          success: false,
          rejected: commitRes.rejected,
          output: '',
          error: commitRes.error || `Failed to commit shadow changes to '${filePath}'`
        }
      }

      return {
        success: true,
        output: JSON.stringify(
          {
            status: 'edited',
            path: commitRes.path || filePath,
            revision: commitRes.revision,
            committed: true,
            ...patchMeta
          },
          null,
          2
        )
      }
    }

    // Step 3: Standard non-shadow flow (explicit user approval + direct disk edit)
    if (!context.requestApproval) {
      return {
        success: false,
        rejected: true,
        output: 'Edit rejected: approval handler is required but was not provided.',
        error: 'Edit rejected: approval handler is required but was not provided.'
      }
    }

    const isApproved = await context.requestApproval({
      toolName: 'edit_file',
      path: filePath,
      oldContent,
      newContent: resolvedNewContent
    })

    if (!isApproved) {
      return {
        success: false,
        rejected: true,
        output: 'Edit rejected — no changes were made.',
        error: 'Edit rejected — no changes were made.'
      }
    }

    if (context.signal?.aborted) {
      return {
        success: false,
        rejected: true,
        output: 'Operation cancelled by user — no file was edited.',
        error: 'Operation cancelled by user.'
      }
    }

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
        resolvedNewContent,
        oldContent
      )

      if (result.success) {
        const editedPath = result.path || filePath
        context.onFileEdited?.(editedPath, resolvedNewContent)
        return {
          success: true,
          output: JSON.stringify(
            {
              status: 'edited',
              path: editedPath,
              ...patchMeta
            },
            null,
            2
          )
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
