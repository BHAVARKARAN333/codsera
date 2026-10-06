import { ITool, ToolContext, ToolExecutionResult } from './types'
import { sliceContentLines } from '@shared/diffUtils'

export class ReadFileRangeTool implements ITool {
  readonly name = 'read_file_range'
  readonly requiresApproval = false
  readonly description =
    'Reads a specific 1-based line range from an existing file in the workspace. Use this tool when only a portion, section, or function within a file is needed instead of the entire file.'

  readonly parameters = {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'The relative path of the file to read within the workspace (e.g. "src/App.tsx", "package.json").'
      },
      startLine: {
        type: 'integer',
        description: '1-based line number where reading begins (must be an integer >= 1).'
      },
      endLine: {
        type: 'integer',
        description: '1-based line number where reading ends (must be an integer >= startLine).'
      }
    },
    required: ['path', 'startLine', 'endLine']
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

    if (context.signal?.aborted) {
      return {
        success: false,
        output: '',
        error: 'Tool execution was aborted by user.'
      }
    }

    const filePath = args && typeof args.path === 'string' ? args.path.trim() : ''
    if (!filePath) {
      return {
        success: false,
        output: '',
        error: 'Missing or invalid "path" parameter. Please specify the relative path of the file to read.'
      }
    }

    // Path traversal security check
    if (
      filePath.startsWith('..') ||
      filePath.includes('/../') ||
      filePath.includes('\\..\\') ||
      filePath.endsWith('/..') ||
      filePath.endsWith('\\..')
    ) {
      return {
        success: false,
        output: '',
        error: `Access denied: Path '${filePath}' is outside the current workspace.`
      }
    }

    // Line number validations
    const startLine = args ? args.startLine : undefined
    const endLine = args ? args.endLine : undefined

    if (
      typeof startLine !== 'number' ||
      !Number.isFinite(startLine) ||
      !Number.isInteger(startLine)
    ) {
      return {
        success: false,
        output: '',
        error: 'Missing or invalid "startLine" parameter. startLine must be an integer >= 1.'
      }
    }

    if (
      typeof endLine !== 'number' ||
      !Number.isFinite(endLine) ||
      !Number.isInteger(endLine)
    ) {
      return {
        success: false,
        output: '',
        error: 'Missing or invalid "endLine" parameter. endLine must be an integer >= startLine.'
      }
    }

    if (startLine < 1) {
      return {
        success: false,
        output: '',
        error: 'Invalid line range: startLine must be at least 1 (1-based line numbering).'
      }
    }

    if (endLine < startLine) {
      return {
        success: false,
        output: '',
        error: `Invalid line range: endLine (${endLine}) cannot be less than startLine (${startLine}).`
      }
    }

    // Maximum range protection for token safety
    const MAX_RANGE_LINES = 1000
    const requestedSpan = endLine - startLine + 1
    if (requestedSpan > MAX_RANGE_LINES) {
      return {
        success: false,
        output: '',
        error: `Requested range exceeds the maximum allowed limit of ${MAX_RANGE_LINES} lines per call (${requestedSpan} lines requested). Please request a smaller range or use read_file.`
      }
    }

    const MAX_RANGE_CHARS = 16000
    const TRUNCATION_NOTICE = '\n[... Truncated remainder of line range to conserve budget ...]'

    try {
      if (!window?.electronAPI || typeof window.electronAPI.readWorkspaceFile !== 'function') {
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
            return this.buildRangeOutput(filePath, fallbackRes.content, startLine, endLine, MAX_RANGE_CHARS, TRUNCATION_NOTICE)
          }

          const isNotFound =
            fallbackRes.error?.toLowerCase().includes('not found') ||
            fallbackRes.error?.toLowerCase().includes('no such file')

          return {
            success: false,
            output: '',
            error: isNotFound
              ? `File does not exist: '${filePath}'.`
              : fallbackRes.error || `Failed to read file: '${filePath}'`
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
        return this.buildRangeOutput(result.path || filePath, result.content, startLine, endLine, MAX_RANGE_CHARS, TRUNCATION_NOTICE)
      } else {
        const isNotFound =
          result.error?.toLowerCase().includes('not found') ||
          result.error?.toLowerCase().includes('no such file')

        return {
          success: false,
          output: '',
          error: isNotFound
            ? `File does not exist: '${filePath}'.`
            : result.error || `Failed to read file: '${filePath}'`
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

  private buildRangeOutput(
    filePath: string,
    rawContent: string,
    startLine: number,
    endLine: number,
    maxChars: number,
    truncationNotice: string
  ): ToolExecutionResult {
    const sliced = sliceContentLines(rawContent, startLine, endLine)

    let content = sliced.content
    let charTruncated = false
    if (content.length > maxChars) {
      content = content.slice(0, maxChars) + truncationNotice
      charTruncated = true
    }

    let message: string
    if (sliced.totalLines === 0) {
      message = `File '${filePath}' is empty (0 lines).`
    } else if (startLine > sliced.totalLines) {
      message = `Requested startLine ${startLine} is beyond end of file (file has ${sliced.totalLines} lines).`
    } else {
      const clipNotice = sliced.clipped
        ? ` [clipped: requested endLine ${endLine} exceeded total lines ${sliced.totalLines}]`
        : ''
      message = `Showing lines ${sliced.startLine}-${sliced.endLine} of file '${filePath}' (total ${sliced.totalLines} lines)${clipNotice}.`
    }

    return {
      success: true,
      output: JSON.stringify(
        {
          path: filePath,
          requestedRange: {
            startLine,
            endLine
          },
          returnedRange: {
            startLine: sliced.startLine,
            endLine: sliced.endLine
          },
          totalLines: sliced.totalLines,
          clipped: sliced.clipped,
          lineCount: sliced.lineCount,
          content,
          charTruncated,
          message
        },
        null,
        2
      )
    }
  }
}
