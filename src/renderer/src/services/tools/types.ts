import { FunctionDeclaration } from '../ai/types'

export interface ToolApprovalRequest {
  toolName: string
  path: string
  content?: string
  oldContent?: string
  newContent?: string
  command?: string
  isDangerous?: boolean
}

export interface ToolContext {
  workspaceRoot: string | null
  signal?: AbortSignal
  requestApproval?: (request: ToolApprovalRequest) => Promise<boolean>
  onFileCreated?: (path: string) => void
  onFileEdited?: (path: string, newContent: string) => void
  onCommandExecuted?: (
    command: string,
    result: { stdout: string; stderr: string; exitCode: number | null }
  ) => void
}

export interface ToolExecutionResult {
  success: boolean
  output: string
  error?: string
  rejected?: boolean
}

export interface ITool {
  readonly name: string
  readonly description: string
  readonly parameters: FunctionDeclaration['parameters']
  readonly requiresApproval?: boolean

  execute(
    args: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult>
}
