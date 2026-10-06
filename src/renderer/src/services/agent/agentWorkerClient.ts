import { FunctionDeclaration, IAIProvider, LLMMessage } from '../ai/types'
import { ITool } from '../tools/types'
import {
  AgentOrchestrator,
  AgentRunOptions,
  PromptCacheDiagnostics,
  StaticPromptCache
} from './orchestrator'
import { AgentPlanner } from './agentPlanner'
import { SmartContextEngine } from './smartContextEngine'
import { HostToolBridge } from './agentWorkerBridge'
import {
  AGENT_ERROR_CODES,
  AGENT_REQUEST_STATUS,
  AGENT_WORKER_MSG,
  AGENT_WORKER_PROTOCOL_VERSION,
  AgentRequestStatus,
  AgentWorkerDiagnostics,
  IWorkerPort,
  MessageFromWorker,
  MessageToWorker,
  WorkerFactory,
  deserializeError,
  isTerminalStatus,
  isValidStatusTransition
} from './agentWorkerProtocol'

export interface AgentWorkerClientConfig {
  workerFactory?: WorkerFactory
  fallbackToInProcess?: boolean
  debug?: boolean
  maxConcurrentRequests?: number // default: 2
  maxQueueCapacity?: number // default: 16
  defaultTimeoutMs?: number // default: 120_000 (2 minutes)
}

interface ActiveClientRequestContext {
  readonly requestId: string
  readonly prompt: string
  readonly options: AgentRunOptions
  readonly abortController: AbortController
  status: AgentRequestStatus
  readonly startTime: number
  timeoutTimer: ReturnType<typeof setTimeout> | null
  lastChunkSeq: number
  lastStepSeq: number
  readonly resolve: (response: string) => void
  readonly reject: (error: Error) => void
}

interface QueuedClientRequest {
  readonly requestId: string
  readonly prompt: string
  readonly options: AgentRunOptions
  readonly abortController: AbortController
  readonly queuedTime: number
  timeoutTimer: ReturnType<typeof setTimeout> | null
  readonly resolve: (response: string) => void
  readonly reject: (error: Error) => void
}

function createAgentError(message: string, code: string, isTimeout = false): Error {
  const err = new Error(message)
  const errRecord = err as unknown as Record<string, unknown>
  errRecord.code = code
  if (isTimeout) {
    errRecord.isTimeout = true
  }
  return err
}

/**
 * AgentWorkerClient manages the lifecycle of the dedicated Agent Worker.
 * It offloads heavy orchestration, planning, and context computation to the worker,
 * provides bounded FIFO concurrency control, backpressure, per-request timeouts,
 * strong cancellation, and graceful fallback to in-process orchestration.
 */
export class AgentWorkerClient {
  private provider: IAIProvider
  private config: AgentWorkerClientConfig
  private worker: (Worker | IWorkerPort) | null = null
  private hostToolBridge: HostToolBridge
  private fallbackOrchestrator: AgentOrchestrator
  private fallbackMode = false
  private isReady = false
  private isTerminated = false
  private lastWorkerError: string | null = null

  // Concurrency & Queue Configuration
  private readonly maxConcurrentRequests: number
  private readonly maxQueueCapacity: number
  private readonly defaultTimeoutMs: number

  // State Tracking
  private runningRequests = new Map<string, ActiveClientRequestContext>()
  private queuedRequests: QueuedClientRequest[] = []

  // Metrics
  private totalCompleted = 0
  private totalFailed = 0
  private totalCancelled = 0
  private totalTimedOut = 0

  constructor(provider: IAIProvider, config?: AgentWorkerClientConfig) {
    this.provider = provider
    this.config = {
      fallbackToInProcess: true,
      debug: false,
      maxConcurrentRequests: 2,
      maxQueueCapacity: 16,
      defaultTimeoutMs: 120_000,
      ...config
    }

    this.maxConcurrentRequests = Math.max(1, this.config.maxConcurrentRequests ?? 2)
    this.maxQueueCapacity = Math.max(1, this.config.maxQueueCapacity ?? 16)
    this.defaultTimeoutMs = Math.max(1000, this.config.defaultTimeoutMs ?? 120_000)

    this.fallbackOrchestrator = new AgentOrchestrator(provider)
    this.hostToolBridge = new HostToolBridge((msg) => this.postToWorker(msg))

    this.initWorker()
  }

  private initWorker(): void {
    if (this.isTerminated) return

    try {
      if (this.config.workerFactory) {
        this.worker = this.config.workerFactory()
      } else if (typeof Worker !== 'undefined') {
        this.worker = new Worker(new URL('./agentWorker.ts', import.meta.url), {
          type: 'module'
        })
      } else {
        // In Node.js or environments without Worker support
        this.fallbackMode = true
        return
      }

      if (this.worker) {
        this.setupWorkerListeners(this.worker)
        this.postToWorker({ type: AGENT_WORKER_MSG.WORKER_INIT })
      }
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      this.lastWorkerError = `Worker instantiation failed: ${errorMsg}`
      if (this.config.fallbackToInProcess) {
        this.fallbackMode = true
        this.worker = null
      } else {
        throw err
      }
    }
  }

  private setupWorkerListeners(worker: Worker | IWorkerPort): void {
    worker.onmessage = (event: { data: unknown }) => {
      this.handleWorkerMessage(event.data as MessageFromWorker)
    }

    worker.onerror = (err: unknown) => {
      const errorMsg =
        err instanceof Error
          ? err.message
          : typeof err === 'object' && err !== null && 'message' in err
          ? String((err as { message: unknown }).message)
          : 'Unknown worker error'

      this.lastWorkerError = errorMsg
      this.handleWorkerCrash(new Error(`Agent worker error: ${errorMsg}`))
    }
  }

  private postToWorker(msg: MessageToWorker): void {
    if (this.isTerminated || !this.worker || this.fallbackMode) return
    try {
      this.worker.postMessage(msg)
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      this.lastWorkerError = `Failed to post message to worker: ${errorMsg}`
    }
  }

  private handleWorkerMessage(msg: MessageFromWorker): void {
    if (!msg || typeof msg !== 'object') return

    switch (msg.type) {
      case AGENT_WORKER_MSG.WORKER_READY:
        this.isReady = true
        break

      case AGENT_WORKER_MSG.STREAM_CHUNK: {
        const req = this.runningRequests.get(msg.requestId)
        if (
          req &&
          req.status === AGENT_REQUEST_STATUS.RUNNING &&
          !req.abortController.signal.aborted
        ) {
          // Monotonic sequence verification: reject duplicate or out-of-order chunks
          if (msg.sequence <= req.lastChunkSeq) {
            return
          }
          req.lastChunkSeq = msg.sequence
          req.options.onChunk?.(msg.chunk)
        }
        break
      }

      case AGENT_WORKER_MSG.AGENT_EVENT: {
        const req = this.runningRequests.get(msg.requestId)
        if (
          req &&
          req.status === AGENT_REQUEST_STATUS.RUNNING &&
          !req.abortController.signal.aborted
        ) {
          // Monotonic sequence verification
          if (msg.sequence <= req.lastStepSeq) {
            return
          }
          req.lastStepSeq = msg.sequence
          req.options.onStep?.(msg.event)
        }
        break
      }

      case AGENT_WORKER_MSG.TOOL_REQUEST: {
        const req = this.runningRequests.get(msg.requestId)
        if (!req || req.status !== AGENT_REQUEST_STATUS.RUNNING) {
          // Reject tool execution for non-running request to avoid orphan executions
          this.postToWorker({
            type: AGENT_WORKER_MSG.TOOL_RESULT,
            requestId: msg.requestId,
            toolCallId: msg.toolCallId,
            result: {
              success: false,
              output: '',
              error: `Request '${msg.requestId}' is no longer active.`
            }
          })
          return
        }
        this.hostToolBridge
          .handleToolRequest(msg, req.options, req.abortController.signal)
          .catch((err) => {
            console.error('[AgentWorkerClient] Tool request execution error:', err)
          })
        break
      }

      case AGENT_WORKER_MSG.IPC_CALL_REQUEST:
        this.hostToolBridge.handleIpcCallRequest(msg).catch((err) => {
          console.error('[AgentWorkerClient] IPC call execution error:', err)
        })
        break

      case AGENT_WORKER_MSG.REQUEST_COMPLETE: {
        const req = this.runningRequests.get(msg.requestId)
        if (req && req.status === AGENT_REQUEST_STATUS.RUNNING) {
          this.finalizeRequest(msg.requestId, 'COMPLETED', msg.response)
        }
        break
      }

      case AGENT_WORKER_MSG.REQUEST_ERROR: {
        const req = this.runningRequests.get(msg.requestId)
        if (req && req.status === AGENT_REQUEST_STATUS.RUNNING) {
          this.finalizeRequest(msg.requestId, 'FAILED', deserializeError(msg.error))
        }
        break
      }

      case AGENT_WORKER_MSG.WORKER_DIAGNOSTIC:
        if (this.config.debug) {
          console.debug('[AgentWorker]', msg.message, msg.details)
        }
        break
    }
  }

  // -------------------------------------------------------------------------
  // Concurrency & Queue Execution Engine
  // -------------------------------------------------------------------------

  private startRunningRequest(
    requestId: string,
    prompt: string,
    options: AgentRunOptions,
    abortController: AbortController,
    timeoutMs: number,
    resolve: (res: string) => void,
    reject: (err: Error) => void
  ): void {
    if (this.isTerminated || abortController.signal.aborted) {
      reject(new Error('Request was stopped by user.'))
      return
    }

    const reqCtx: ActiveClientRequestContext = {
      requestId,
      prompt,
      options,
      abortController,
      status: AGENT_REQUEST_STATUS.RUNNING,
      startTime: Date.now(),
      timeoutTimer: null,
      lastChunkSeq: 0,
      lastStepSeq: 0,
      resolve,
      reject
    }

    // Schedule per-request autonomous timeout timer
    if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
      reqCtx.timeoutTimer = setTimeout(() => {
        this.handleRequestTimeout(requestId, timeoutMs)
      }, timeoutMs)
    }

    this.runningRequests.set(requestId, reqCtx)

    const toolDeclarations = this.hostToolBridge.getToolDeclarations()

    this.postToWorker({
      type: AGENT_WORKER_MSG.REQUEST_START,
      requestId,
      prompt,
      options: {
        providerType: this.provider.id,
        apiKey: options.apiKey,
        modelName: options.modelName,
        workspaceRoot: options.workspaceRoot,
        currentBranch: options.currentBranch,
        activeEditorContext: options.activeEditorContext,
        timeoutMs,
        tools: toolDeclarations
      }
    })
  }

  private processQueue(): void {
    if (this.isTerminated || this.fallbackMode || !this.worker) return

    while (
      this.runningRequests.size < this.maxConcurrentRequests &&
      this.queuedRequests.length > 0
    ) {
      const next = this.queuedRequests.shift()!

      if (next.abortController.signal.aborted) {
        if (next.timeoutTimer) clearTimeout(next.timeoutTimer)
        continue
      }

      if (next.timeoutTimer) {
        clearTimeout(next.timeoutTimer)
        next.timeoutTimer = null
      }

      const timeoutMs = next.options.timeoutMs ?? this.defaultTimeoutMs
      this.startRunningRequest(
        next.requestId,
        next.prompt,
        next.options,
        next.abortController,
        timeoutMs,
        next.resolve,
        next.reject
      )
    }
  }

  private finalizeRequest(
    requestId: string,
    terminalStatus: 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT',
    resultOrError: string | Error
  ): void {
    const req = this.runningRequests.get(requestId)
    if (!req) return

    if (isTerminalStatus(req.status)) {
      return // Terminal states are strictly immutable; discard late duplicate events
    }

    if (!isValidStatusTransition(req.status, terminalStatus)) {
      return
    }

    if (req.timeoutTimer) {
      clearTimeout(req.timeoutTimer)
      req.timeoutTimer = null
    }

    req.status = terminalStatus
    this.runningRequests.delete(requestId)

    switch (terminalStatus) {
      case 'COMPLETED':
        this.totalCompleted++
        req.resolve(resultOrError as string)
        break
      case 'FAILED':
        this.totalFailed++
        req.reject(resultOrError as Error)
        break
      case 'CANCELLED':
        this.totalCancelled++
        req.reject(resultOrError as Error)
        break
      case 'TIMED_OUT':
        this.totalTimedOut++
        req.reject(resultOrError as Error)
        break
    }

    // Free concurrency slot and process next queued request
    this.processQueue()
  }

  private handleRequestTimeout(requestId: string, timeoutMs: number): void {
    const req = this.runningRequests.get(requestId)
    if (!req || isTerminalStatus(req.status)) return

    this.postToWorker({
      type: AGENT_WORKER_MSG.REQUEST_CANCEL,
      requestId,
      reason: 'timeout'
    })
    req.abortController.abort()

    const timeoutErr = createAgentError(
      `Agent request timed out after ${timeoutMs}ms.`,
      AGENT_ERROR_CODES.TIMEOUT,
      true
    )

    this.finalizeRequest(requestId, 'TIMED_OUT', timeoutErr)
  }

  private handleWorkerCrash(err: Error): void {
    // Fail all queued requests
    while (this.queuedRequests.length > 0) {
      const queued = this.queuedRequests.shift()!
      if (queued.timeoutTimer) {
        clearTimeout(queued.timeoutTimer)
        queued.timeoutTimer = null
      }
      this.totalFailed++
      queued.reject(err)
    }

    // Fail all running requests
    for (const [requestId, req] of Array.from(this.runningRequests.entries())) {
      if (!isTerminalStatus(req.status)) {
        this.finalizeRequest(requestId, 'FAILED', err)
      }
    }

    if (this.config.fallbackToInProcess) {
      this.fallbackMode = true
      this.terminateWorker()
    }
  }

  private terminateWorker(): void {
    if (this.worker) {
      try {
        if ('terminate' in this.worker && typeof this.worker.terminate === 'function') {
          this.worker.terminate()
        }
      } catch {
        // Ignore termination errors
      }
      this.worker = null
    }
    this.isReady = false
  }

  // -------------------------------------------------------------------------
  // Public Agent Interface (Identical to AgentOrchestrator)
  // -------------------------------------------------------------------------

  getSmartContextEngine(): SmartContextEngine {
    return this.fallbackOrchestrator.getSmartContextEngine()
  }

  getAgentPlanner(): AgentPlanner {
    return this.fallbackOrchestrator.getAgentPlanner()
  }

  getPromptCache(): StaticPromptCache {
    return this.fallbackOrchestrator.getPromptCache()
  }

  getLastCacheDiagnostics(): PromptCacheDiagnostics | null {
    return this.fallbackOrchestrator.getLastCacheDiagnostics()
  }

  setProvider(provider: IAIProvider): void {
    this.provider = provider
    this.fallbackOrchestrator.setProvider(provider)
  }

  getProvider(): IAIProvider {
    return this.provider
  }

  registerTool(tool: ITool): void {
    this.hostToolBridge.registerTool(tool)
    this.fallbackOrchestrator.registerTool(tool)
  }

  getToolDeclarations(): FunctionDeclaration[] {
    return this.fallbackOrchestrator.getToolDeclarations()
  }

  clearHistory(): void {
    this.fallbackOrchestrator.clearHistory()
  }

  getHistory(): LLMMessage[] {
    return this.fallbackOrchestrator.getHistory()
  }

  stop(): void {
    this.cancel()
    this.fallbackOrchestrator.stop()
  }

  cancel(requestId?: string): void {
    if (requestId) {
      // 1. Check if queued
      const queueIdx = this.queuedRequests.findIndex((q) => q.requestId === requestId)
      if (queueIdx !== -1) {
        const queued = this.queuedRequests.splice(queueIdx, 1)[0]
        if (queued.timeoutTimer) {
          clearTimeout(queued.timeoutTimer)
          queued.timeoutTimer = null
        }
        this.totalCancelled++
        queued.abortController.abort()
        const cancelErr = createAgentError(
          'Request was stopped by user.',
          AGENT_ERROR_CODES.CANCELLED
        )
        queued.reject(cancelErr)
        return
      }

      // 2. Check if running
      const running = this.runningRequests.get(requestId)
      if (running && !isTerminalStatus(running.status)) {
        running.abortController.abort()
        this.postToWorker({ type: AGENT_WORKER_MSG.REQUEST_CANCEL, requestId })
        const cancelErr = createAgentError(
          'Request was stopped by user.',
          AGENT_ERROR_CODES.CANCELLED
        )
        this.finalizeRequest(requestId, 'CANCELLED', cancelErr)
      }
    } else {
      // Cancel all queued
      while (this.queuedRequests.length > 0) {
        const queued = this.queuedRequests.shift()!
        if (queued.timeoutTimer) {
          clearTimeout(queued.timeoutTimer)
          queued.timeoutTimer = null
        }
        this.totalCancelled++
        queued.abortController.abort()
        const cancelErr = createAgentError(
          'Request was stopped by user.',
          AGENT_ERROR_CODES.CANCELLED
        )
        queued.reject(cancelErr)
      }

      // Cancel all running
      for (const [id, req] of Array.from(this.runningRequests.entries())) {
        if (!isTerminalStatus(req.status)) {
          req.abortController.abort()
          this.postToWorker({ type: AGENT_WORKER_MSG.REQUEST_CANCEL, requestId: id })
          const cancelErr = createAgentError(
            'Request was stopped by user.',
            AGENT_ERROR_CODES.CANCELLED
          )
          this.finalizeRequest(id, 'CANCELLED', cancelErr)
        }
      }

      this.fallbackOrchestrator.stop()
    }
  }

  async run(prompt: string, options: AgentRunOptions): Promise<string> {
    if (this.isTerminated) {
      throw new Error('AgentWorkerClient has been terminated.')
    }

    if (options.signal?.aborted) {
      throw new Error('Request was stopped by user.')
    }

    // If worker is unavailable or fallback mode active, run in-process
    if (this.fallbackMode || !this.worker) {
      return this.fallbackOrchestrator.run(prompt, options)
    }

    const requestId = crypto.randomUUID()
    const abortController = new AbortController()
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs

    return new Promise<string>((resolve, reject) => {
      // Propagate external signal to internal abort controller
      if (options.signal) {
        const onExternalAbort = () => {
          this.cancel(requestId)
        }
        options.signal.addEventListener('abort', onExternalAbort, { once: true })
      }

      // If concurrency slot available, execute immediately
      if (this.runningRequests.size < this.maxConcurrentRequests) {
        this.startRunningRequest(
          requestId,
          prompt,
          options,
          abortController,
          timeoutMs,
          resolve,
          reject
        )
      } else {
        // Enforce bounded queue capacity
        if (this.queuedRequests.length >= this.maxQueueCapacity) {
          const queueErr = createAgentError(
            `Agent request queue is full (capacity: ${this.maxQueueCapacity}). Cannot enqueue request.`,
            AGENT_ERROR_CODES.QUEUE_FULL
          )
          reject(queueErr)
          return
        }

        // Enqueue into FIFO queue
        const queuedEntry: QueuedClientRequest = {
          requestId,
          prompt,
          options,
          abortController,
          queuedTime: Date.now(),
          timeoutTimer: null,
          resolve,
          reject
        }

        // Schedule timeout while queued if applicable
        if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
          queuedEntry.timeoutTimer = setTimeout(() => {
            const idx = this.queuedRequests.indexOf(queuedEntry)
            if (idx !== -1) {
              this.queuedRequests.splice(idx, 1)
              this.totalTimedOut++
              const timeoutErr = createAgentError(
                `Agent request timed out while queued after ${timeoutMs}ms.`,
                AGENT_ERROR_CODES.TIMEOUT,
                true
              )
              reject(timeoutErr)
            }
          }, timeoutMs)
        }

        this.queuedRequests.push(queuedEntry)
      }
    })
  }

  isWorkerReady(): boolean {
    return this.isReady
  }

  getDiagnostics(): AgentWorkerDiagnostics {
    return {
      workerActive: !this.fallbackMode && !!this.worker,
      fallbackMode: this.fallbackMode,
      activeRequestsCount: this.runningRequests.size,
      queuedRequestsCount: this.queuedRequests.length,
      maxConcurrentRequests: this.maxConcurrentRequests,
      queueCapacity: this.maxQueueCapacity,
      totalRequestsCompleted: this.totalCompleted,
      totalRequestsFailed: this.totalFailed,
      totalRequestsCancelled: this.totalCancelled,
      totalRequestsTimedOut: this.totalTimedOut,
      lastWorkerError: this.lastWorkerError,
      protocolVersion: AGENT_WORKER_PROTOCOL_VERSION
    }
  }

  terminate(): void {
    this.isTerminated = true
    this.cancel()
    this.postToWorker({ type: AGENT_WORKER_MSG.WORKER_TERMINATE })
    this.terminateWorker()
  }
}
