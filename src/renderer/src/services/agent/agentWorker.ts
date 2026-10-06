import { IAIProvider } from '../ai/types'
import { providerRegistry } from '../ai/providerRegistry'
import { AgentOrchestrator, AgentStepEvent } from './orchestrator'
import { WorkerProxyTool, WorkerToolBridge } from './agentWorkerBridge'
import {
  AGENT_WORKER_MSG,
  AGENT_WORKER_PROTOCOL_VERSION,
  MessageFromWorker,
  MessageToWorker,
  RequestAbortMessage,
  RequestCancelMessage,
  RequestStartMessage,
  SerializedToolDeclaration,
  serializeError
} from './agentWorkerProtocol'

export interface ActiveWorkerRequestContext {
  requestId: string
  abortController: AbortController
  orchestrator: AgentOrchestrator
  isCancelled: boolean
  chunkSeq: number
  stepSeq: number
}

/**
 * Standard default tool declarations recognized by the AI IDE.
 */
export const DEFAULT_WORKER_TOOL_DECLARATIONS: SerializedToolDeclaration[] = [
  {
    name: 'list_files',
    description: 'Lists the directory tree of the workspace.',
    parameters: {
      type: 'object',
      properties: {
        maxDepth: { type: 'number', description: 'Maximum directory recursion depth.' }
      }
    },
    requiresApproval: false
  },
  {
    name: 'read_file',
    description: 'Reads the contents of a specific file in the workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path of the file to read.' }
      },
      required: ['path']
    },
    requiresApproval: false
  },
  {
    name: 'read_file_range',
    description: 'Reads a 1-based line range of a specific file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path of the file to read.' },
        startLine: { type: 'number', description: '1-based starting line number.' },
        endLine: { type: 'number', description: '1-based ending line number.' }
      },
      required: ['path', 'startLine', 'endLine']
    },
    requiresApproval: false
  },
  {
    name: 'create_file',
    description: 'Creates a new file in the workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path of the new file.' },
        content: { type: 'string', description: 'Initial file content.' }
      },
      required: ['path']
    },
    requiresApproval: true
  },
  {
    name: 'edit_file',
    description: 'Modifies an existing file using SEARCH/REPLACE blocks.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path of the file to edit.' },
        searchBlock: { type: 'string', description: 'Exact existing lines to replace.' },
        replaceBlock: { type: 'string', description: 'New lines to substitute.' }
      },
      required: ['path', 'searchBlock', 'replaceBlock']
    },
    requiresApproval: true
  },
  {
    name: 'run_command',
    description: 'Executes a command in the workspace terminal.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Terminal command to execute.' }
      },
      required: ['command']
    },
    requiresApproval: true
  },
  {
    name: 'git_status',
    description: 'Returns Git working tree status.',
    parameters: { type: 'object', properties: {} },
    requiresApproval: false
  },
  {
    name: 'git_diff',
    description: 'Returns working tree Git diffs.',
    parameters: { type: 'object', properties: {} },
    requiresApproval: false
  },
  {
    name: 'git_log',
    description: 'Returns recent Git commits.',
    parameters: {
      type: 'object',
      properties: {
        maxCount: { type: 'number', description: 'Max commits to retrieve.' }
      }
    },
    requiresApproval: false
  }
]

/**
 * Core Agent Worker Handler.
 * Manages orchestrator instances, request routing, tool proxying, and streaming events.
 */
export class AgentWorkerHandler {
  private postMessageFn: (msg: MessageFromWorker) => void
  private bridge: WorkerToolBridge
  private activeRequests = new Map<string, ActiveWorkerRequestContext>()
  private customProviders = new Map<string, IAIProvider>()
  private isTerminated = false

  constructor(postMessageFn: (msg: MessageFromWorker) => void) {
    this.postMessageFn = postMessageFn
    this.bridge = new WorkerToolBridge((msg) => this.postMessage(msg))

    // Expose simulated electronAPI in global scope if in worker environment
    this.setupGlobalWorkerScope()
  }

  private postMessage(msg: MessageFromWorker): void {
    if (this.isTerminated) return
    this.postMessageFn(msg)
  }

  private setupGlobalWorkerScope(): void {
    const adapter = this.bridge.getElectronApiAdapter()
    if (typeof self !== 'undefined') {
      try {
        const globalScope = self as unknown as Record<string, unknown>
        globalScope.electronAPI = adapter
        if (typeof globalScope.window === 'undefined') {
          globalScope.window = { electronAPI: adapter }
        }
      } catch {
        // Ignore if self is frozen or non-extensible
      }
    }
  }

  registerCustomProvider(provider: IAIProvider): void {
    this.customProviders.set(provider.id, provider)
  }

  getActiveRequestsCount(): number {
    return this.activeRequests.size
  }

  isRequestActive(requestId: string): boolean {
    return this.activeRequests.has(requestId)
  }

  handleMessage(msg: MessageToWorker): void {
    if (this.isTerminated) return

    switch (msg.type) {
      case AGENT_WORKER_MSG.WORKER_INIT:
        this.handleInit()
        break

      case AGENT_WORKER_MSG.REQUEST_START:
        this.handleRequestStart(msg)
        break

      case AGENT_WORKER_MSG.REQUEST_CANCEL:
      case AGENT_WORKER_MSG.REQUEST_ABORT:
        this.handleRequestCancel(msg)
        break

      case AGENT_WORKER_MSG.TOOL_RESULT:
        this.bridge.handleToolResult(msg)
        break

      case AGENT_WORKER_MSG.IPC_CALL_RESULT:
        this.bridge.handleIpcResult(msg)
        break

      case AGENT_WORKER_MSG.WORKER_TERMINATE:
        this.handleTerminate()
        break

      default:
        this.postMessage({
          type: AGENT_WORKER_MSG.WORKER_DIAGNOSTIC,
          level: 'warn',
          message: `Unknown worker message type received: ${(msg as { type: string }).type}`
        })
    }
  }

  private handleInit(): void {
    this.postMessage({
      type: AGENT_WORKER_MSG.WORKER_READY,
      version: AGENT_WORKER_PROTOCOL_VERSION,
      timestamp: Date.now()
    })
  }

  private resolveProvider(providerType: string): IAIProvider {
    if (this.customProviders.has(providerType)) {
      return this.customProviders.get(providerType)!
    }
    if (providerRegistry.has(providerType)) {
      return providerRegistry.get(providerType)
    }
    // Fallback to gemini if unrecognized
    return providerRegistry.get('gemini')
  }

  private async handleRequestStart(msg: RequestStartMessage): Promise<void> {
    const { requestId, prompt, options } = msg

    // If an existing request with the same ID is running, abort it first
    if (this.activeRequests.has(requestId)) {
      this.handleRequestCancel({ type: AGENT_WORKER_MSG.REQUEST_CANCEL, requestId })
    }

    const abortController = new AbortController()
    const provider = this.resolveProvider(options.providerType)
    const orchestrator = new AgentOrchestrator(provider)

    // Register proxy tools
    const toolDeclarations =
      options.tools && options.tools.length > 0
        ? options.tools
        : DEFAULT_WORKER_TOOL_DECLARATIONS

    for (const decl of toolDeclarations) {
      orchestrator.registerTool(new WorkerProxyTool(decl, () => requestId, this.bridge))
    }

    const reqCtx: ActiveWorkerRequestContext = {
      requestId,
      abortController,
      orchestrator,
      isCancelled: false,
      chunkSeq: 0,
      stepSeq: 0
    }

    this.activeRequests.set(requestId, reqCtx)

    try {
      const response = await orchestrator.run(prompt, {
        apiKey: options.apiKey,
        modelName: options.modelName,
        workspaceRoot: options.workspaceRoot,
        currentBranch: options.currentBranch,
        activeEditorContext: options.activeEditorContext,
        timeoutMs: options.timeoutMs,
        signal: abortController.signal,
        onChunk: (chunk: string) => {
          if (reqCtx.isCancelled || abortController.signal.aborted) return
          this.postMessage({
            type: AGENT_WORKER_MSG.STREAM_CHUNK,
            requestId,
            chunk,
            sequence: ++reqCtx.chunkSeq
          })
        },
        onStep: (event: AgentStepEvent) => {
          if (reqCtx.isCancelled || abortController.signal.aborted) return
          this.postMessage({
            type: AGENT_WORKER_MSG.AGENT_EVENT,
            requestId,
            event,
            sequence: ++reqCtx.stepSeq
          })
        }
      })

      if (!reqCtx.isCancelled && !abortController.signal.aborted) {
        this.postMessage({
          type: AGENT_WORKER_MSG.REQUEST_COMPLETE,
          requestId,
          response
        })
      }
    } catch (err: unknown) {
      if (!reqCtx.isCancelled && !abortController.signal.aborted) {
        this.postMessage({
          type: AGENT_WORKER_MSG.REQUEST_ERROR,
          requestId,
          error: serializeError(err)
        })
      }
    } finally {
      this.bridge.cancelPendingCallsForRequest(requestId)
      this.activeRequests.delete(requestId)
    }
  }

  private handleRequestCancel(msg: RequestCancelMessage | RequestAbortMessage): void {
    const { requestId } = msg
    const reqCtx = this.activeRequests.get(requestId)
    if (reqCtx) {
      reqCtx.isCancelled = true
      reqCtx.abortController.abort()
      reqCtx.orchestrator.stop()
      this.bridge.cancelPendingCallsForRequest(requestId)
      this.activeRequests.delete(requestId)
    }
  }

  private handleTerminate(): void {
    this.isTerminated = true
    for (const [requestId, reqCtx] of this.activeRequests) {
      reqCtx.isCancelled = true
      reqCtx.abortController.abort()
      reqCtx.orchestrator.stop()
      this.bridge.cancelPendingCallsForRequest(requestId)
    }
    this.activeRequests.clear()
    this.bridge.clearAll()
  }
}

// ---------------------------------------------------------------------------
// Worker entrypoint initialization (if running in real Web Worker environment)
// ---------------------------------------------------------------------------

let workerHandlerInstance: AgentWorkerHandler | null = null

if (
  typeof self !== 'undefined' &&
  typeof (self as unknown as Record<string, unknown>).postMessage === 'function'
) {
  workerHandlerInstance = new AgentWorkerHandler((msg) => {
    ;(self as unknown as Worker).postMessage(msg)
  })

  ;(self as unknown as Worker).onmessage = (event: MessageEvent<MessageToWorker>) => {
    if (event && event.data) {
      workerHandlerInstance?.handleMessage(event.data)
    }
  }

  // Notify host that worker script has loaded
  workerHandlerInstance.handleMessage({ type: AGENT_WORKER_MSG.WORKER_INIT })
}
