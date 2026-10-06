import { FunctionDeclaration } from '../ai/types'
import { ITool, ToolApprovalRequest, ToolContext, ToolExecutionResult } from '../tools/types'
import { AgentRunOptions } from './orchestrator'
import {
  AGENT_WORKER_MSG,
  AllowedWorkerIpcMethod,
  IpcCallRequestMessage,
  IpcCallResultMessage,
  MessageFromWorker,
  MessageToWorker,
  SerializedToolDeclaration,
  ToolRequestMessage,
  ToolResultMessage
} from './agentWorkerProtocol'

/**
 * Worker-side bridge that proxies tool executions and safe read-only IPC calls
 * from the worker across the message boundary to the host process.
 */
export class WorkerToolBridge {
  private pendingToolCalls = new Map<
    string,
    {
      resolve: (res: ToolExecutionResult) => void
      reject: (err: Error) => void
      requestId: string
      signal?: AbortSignal
      cleanup: () => void
    }
  >()

  private pendingIpcCalls = new Map<
    string,
    {
      resolve: (res: IpcCallResultMessage) => void
      reject: (err: Error) => void
      cleanup: () => void
    }
  >()

  private postMessageFn: (msg: MessageFromWorker) => void

  constructor(postMessageFn: (msg: MessageFromWorker) => void) {
    this.postMessageFn = postMessageFn
  }

  setPostMessageFn(fn: (msg: MessageFromWorker) => void): void {
    this.postMessageFn = fn
  }

  handleToolResult(msg: ToolResultMessage): void {
    const entry = this.pendingToolCalls.get(msg.toolCallId)
    if (entry) {
      if (entry.requestId !== msg.requestId) {
        // Discard mismatched tool results to prevent cross-request contamination
        return
      }
      this.pendingToolCalls.delete(msg.toolCallId)
      entry.cleanup()
      entry.resolve(msg.result)
    }
  }

  handleIpcResult(msg: IpcCallResultMessage): void {
    const entry = this.pendingIpcCalls.get(msg.callId)
    if (entry) {
      this.pendingIpcCalls.delete(msg.callId)
      entry.cleanup()
      entry.resolve(msg)
    }
  }

  cancelPendingCallsForRequest(requestId: string): void {
    for (const [toolCallId, entry] of Array.from(this.pendingToolCalls.entries())) {
      if (entry.requestId === requestId) {
        this.pendingToolCalls.delete(toolCallId)
        entry.cleanup()
        entry.resolve({
          success: false,
          output: '',
          error: 'Tool execution was aborted by user.'
        })
      }
    }
  }

  clearAll(): void {
    for (const [, entry] of this.pendingToolCalls) {
      entry.cleanup()
      entry.resolve({
        success: false,
        output: '',
        error: 'Worker bridge reset or closed.'
      })
    }
    this.pendingToolCalls.clear()

    for (const [, entry] of this.pendingIpcCalls) {
      entry.cleanup()
      entry.resolve({
        type: AGENT_WORKER_MSG.IPC_CALL_RESULT,
        callId: '',
        success: false,
        error: 'Worker bridge reset or closed.'
      })
    }
    this.pendingIpcCalls.clear()
  }

  async requestToolExecution(
    requestId: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<ToolExecutionResult> {
    if (signal?.aborted) {
      return {
        success: false,
        output: '',
        error: 'Tool execution was aborted by user.'
      }
    }

    const toolCallId = `tc_${crypto.randomUUID()}`

    return new Promise<ToolExecutionResult>((resolve, reject) => {
      const onAbort = () => {
        cleanup()
        this.pendingToolCalls.delete(toolCallId)
        resolve({
          success: false,
          output: '',
          error: 'Tool execution was aborted by user.'
        })
      }

      const cleanup = () => {
        signal?.removeEventListener('abort', onAbort)
      }

      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true })
      }

      this.pendingToolCalls.set(toolCallId, {
        resolve,
        reject,
        requestId,
        signal,
        cleanup
      })

      this.postMessageFn({
        type: AGENT_WORKER_MSG.TOOL_REQUEST,
        requestId,
        toolCallId,
        toolName,
        args
      })
    })
  }

  async callIpc(method: AllowedWorkerIpcMethod, ...args: unknown[]): Promise<unknown> {
    const callId = `ipc_${crypto.randomUUID()}`

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingIpcCalls.delete(callId)
        reject(new Error(`IPC call to '${method}' timed out after 30 seconds.`))
      }, 30000)

      const cleanup = () => {
        clearTimeout(timeout)
      }

      this.pendingIpcCalls.set(callId, {
        resolve: (res) => {
          cleanup()
          if (res.success) {
            resolve(res.result)
          } else {
            reject(new Error(res.error || `IPC call to '${method}' failed.`))
          }
        },
        reject: (err) => {
          cleanup()
          reject(err)
        },
        cleanup
      })

      this.postMessageFn({
        type: AGENT_WORKER_MSG.IPC_CALL_REQUEST,
        callId,
        method,
        args
      })
    })
  }

  getElectronApiAdapter(): Record<string, unknown> {
    return {
      readTree: (root: string) => this.callIpc('readTree', root),
      readWorkspaceFile: (root: string, path: string) =>
        this.callIpc('readWorkspaceFile', root, path),
      loadWorkspaceIndex: (root: string) => this.callIpc('loadWorkspaceIndex', root),
      saveWorkspaceIndex: (root: string, data: unknown) =>
        this.callIpc('saveWorkspaceIndex', root, data),
      nvidiaChatCompletion: (req: unknown) => this.callIpc('nvidiaChatCompletion', req),
      opencodeChatCompletion: (req: unknown) => this.callIpc('opencodeChatCompletion', req),
      cancelChatCompletion: (reqId: string) => this.callIpc('cancelChatCompletion', reqId)
    }
  }
}

/**
 * Proxy tool registered inside the worker. When executed by the orchestrator,
 * it forwards the tool execution request to the host process via the bridge.
 */
export class WorkerProxyTool implements ITool {
  readonly name: string
  readonly description: string
  readonly parameters: FunctionDeclaration['parameters']
  readonly requiresApproval: boolean

  constructor(
    declaration: SerializedToolDeclaration,
    private readonly getRequestId: () => string,
    private readonly bridge: WorkerToolBridge
  ) {
    this.name = declaration.name
    this.description = declaration.description
    this.parameters = declaration.parameters
    this.requiresApproval = declaration.requiresApproval ?? false
  }

  async execute(
    args: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const requestId = this.getRequestId()
    return this.bridge.requestToolExecution(requestId, this.name, args, context.signal)
  }
}

/**
 * Host-side tool bridge running in the renderer UI process.
 * Receives tool requests from the worker, performs user approval gating,
 * executes real tools via contextBridge/Main IPC, and routes results back.
 */
export class HostToolBridge {
  private tools: Map<string, ITool> = new Map()
  private postToWorkerFn: (msg: MessageToWorker) => void

  constructor(postToWorkerFn: (msg: MessageToWorker) => void) {
    this.postToWorkerFn = postToWorkerFn
  }

  setPostToWorkerFn(fn: (msg: MessageToWorker) => void): void {
    this.postToWorkerFn = fn
  }

  registerTool(tool: ITool): void {
    this.tools.set(tool.name, tool)
  }

  getTool(name: string): ITool | undefined {
    return this.tools.get(name)
  }

  getTools(): Map<string, ITool> {
    return this.tools
  }

  getToolDeclarations(): SerializedToolDeclaration[] {
    return Array.from(this.tools.values()).map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      requiresApproval: t.requiresApproval ?? false
    }))
  }

  async handleToolRequest(
    msg: ToolRequestMessage,
    activeRunOptions?: AgentRunOptions,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const { requestId, toolCallId, toolName, args } = msg

    if (abortSignal?.aborted) {
      this.postToWorkerFn({
        type: AGENT_WORKER_MSG.TOOL_RESULT,
        requestId,
        toolCallId,
        result: {
          success: false,
          output: '',
          error: 'Tool execution was aborted by user.'
        }
      })
      return
    }

    const tool = this.tools.get(toolName)
    if (!tool) {
      this.postToWorkerFn({
        type: AGENT_WORKER_MSG.TOOL_RESULT,
        requestId,
        toolCallId,
        result: {
          success: false,
          output: '',
          error: `Tool '${toolName}' is not recognized or available.`
        }
      })
      return
    }

    // Enforce approval if tool requires it
    if (tool.requiresApproval && activeRunOptions?.requestApproval) {
      const approvalReq: ToolApprovalRequest = {
        toolName,
        path:
          (args.path as string) ||
          (args.targetFile as string) ||
          (args.relativePath as string) ||
          '',
        content: args.content as string,
        oldContent: args.expectedOldContent as string,
        newContent: args.newContent as string,
        command: args.command as string,
        isDangerous: toolName === 'run_command'
      }

      let approved = false
      try {
        approved = await activeRunOptions.requestApproval(approvalReq)
      } catch {
        approved = false
      }

      if (abortSignal?.aborted) {
        this.postToWorkerFn({
          type: AGENT_WORKER_MSG.TOOL_RESULT,
          requestId,
          toolCallId,
          result: {
            success: false,
            output: '',
            error: 'Tool execution was aborted by user.'
          }
        })
        return
      }

      if (!approved) {
        this.postToWorkerFn({
          type: AGENT_WORKER_MSG.TOOL_RESULT,
          requestId,
          toolCallId,
          result: {
            success: false,
            output: 'Tool execution was rejected by user.',
            rejected: true
          }
        })
        return
      }
    }

    const toolContext: ToolContext = {
      workspaceRoot: activeRunOptions?.workspaceRoot ?? null,
      signal: abortSignal,
      onFileCreated: (p) => activeRunOptions?.onFileCreated?.(p),
      onFileEdited: (p, c) => activeRunOptions?.onFileEdited?.(p, c),
      onCommandExecuted: (cmd, r) => activeRunOptions?.onCommandExecuted?.(cmd, r),
      shadowBuffer: activeRunOptions?.shadowBuffer,
      onShadowUpdated: (p, c, rev) => activeRunOptions?.onShadowUpdated?.(p, c, rev)
    }

    try {
      const result = await tool.execute(args, toolContext)
      this.postToWorkerFn({
        type: AGENT_WORKER_MSG.TOOL_RESULT,
        requestId,
        toolCallId,
        result: result || {
          success: false,
          output: '',
          error: 'Tool returned invalid result.'
        }
      })
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      this.postToWorkerFn({
        type: AGENT_WORKER_MSG.TOOL_RESULT,
        requestId,
        toolCallId,
        result: {
          success: false,
          output: '',
          error: `Tool execution failed with exception: ${errorMsg}`
        }
      })
    }
  }

  async handleIpcCallRequest(msg: IpcCallRequestMessage): Promise<void> {
    const { callId, method, args } = msg
    const ALLOWED_METHODS = new Set<string>([
      'readTree',
      'readWorkspaceFile',
      'loadWorkspaceIndex',
      'saveWorkspaceIndex',
      'nvidiaChatCompletion',
      'opencodeChatCompletion',
      'cancelChatCompletion'
    ])

    if (!ALLOWED_METHODS.has(method)) {
      this.postToWorkerFn({
        type: AGENT_WORKER_MSG.IPC_CALL_RESULT,
        callId,
        success: false,
        error: `Privileged method '${method}' is not allowed across worker bridge.`
      })
      return
    }

    try {
      if (typeof window === 'undefined' || !window.electronAPI) {
        throw new Error('electronAPI is not available in host context')
      }
      const apiFn = (window.electronAPI as unknown as Record<string, unknown>)[method]
      if (typeof apiFn !== 'function') {
        throw new Error(`Method '${method}' is not implemented on electronAPI`)
      }
      const result = await (apiFn as (...a: unknown[]) => Promise<unknown>)(...args)
      this.postToWorkerFn({
        type: AGENT_WORKER_MSG.IPC_CALL_RESULT,
        callId,
        success: true,
        result
      })
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      this.postToWorkerFn({
        type: AGENT_WORKER_MSG.IPC_CALL_RESULT,
        callId,
        success: false,
        error: errorMsg
      })
    }
  }
}
