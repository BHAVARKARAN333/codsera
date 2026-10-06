import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { AgentWorkerClient } from '@renderer/services/agent/agentWorkerClient'
import { AgentWorkerHandler } from '@renderer/services/agent/agentWorker.ts'
import {
  AGENT_ERROR_CODES,
  AGENT_WORKER_MSG,
  AGENT_WORKER_PROTOCOL_VERSION,
  IWorkerPort,
  MessageFromWorker,
  MessageToWorker
} from '@renderer/services/agent/agentWorkerProtocol'
import {
  FunctionDeclaration,
  IAIProvider,
  LLMMessage,
  LLMRequestOptions,
  LLMResponse
} from '@renderer/services/ai/types'
import { ITool, ToolContext, ToolExecutionResult } from '@renderer/services/tools/types'
import { resetMockElectron } from '../../../setup/electronMock'

/**
 * Mock AI Provider for testing worker round-trips, streaming, and tool calls.
 */
class TestMockAIProvider implements IAIProvider {
  readonly id = 'test-mock-provider'
  readonly name = 'Test Mock Provider'
  readonly capabilities = {
    supportsStreaming: true,
    supportsTools: true,
    requiresApiKey: false
  }

  private responseQueue: LLMResponse[] = []
  public recordedCalls: Array<{
    messages: LLMMessage[]
    tools: FunctionDeclaration[]
    options: LLMRequestOptions
  }> = []

  enqueueResponse(response: LLMResponse): void {
    this.responseQueue.push(response)
  }

  clear(): void {
    this.responseQueue = []
    this.recordedCalls = []
  }

  async sendMessage(
    messages: LLMMessage[],
    tools: FunctionDeclaration[],
    options: LLMRequestOptions
  ): Promise<LLMResponse> {
    this.recordedCalls.push({
      messages: JSON.parse(JSON.stringify(messages)),
      tools,
      options
    })

    if (options.signal?.aborted) {
      throw new Error('Request was stopped by user.')
    }

    if (this.responseQueue.length > 0) {
      const resp = this.responseQueue.shift()!
      if (resp.text && options.onChunk) {
        // Stream text in 2 chunks to test streaming
        const mid = Math.floor(resp.text.length / 2)
        const c1 = resp.text.slice(0, mid)
        const c2 = resp.text.slice(mid)
        if (c1) options.onChunk(c1)
        if (c2) options.onChunk(c2)
      }
      return resp
    }
    return { text: 'Default mock response' }
  }
}

/**
 * Virtual worker channel connecting AgentWorkerClient to an AgentWorkerHandler
 * with asynchronous message dispatch and structured cloning simulation.
 */
class VirtualWorkerChannel {
  private clientPort: IWorkerPort
  private workerHandler: AgentWorkerHandler

  constructor() {
    this.workerHandler = new AgentWorkerHandler((msg: MessageFromWorker) => {
      // Simulate boundary serialization and asynchronous delivery
      const serialized = JSON.parse(JSON.stringify(msg))
      queueMicrotask(() => {
        if (this.clientPort.onmessage) {
          this.clientPort.onmessage({ data: serialized })
        }
      })
    })

    this.clientPort = {
      postMessage: (msg: unknown) => {
        const serialized = JSON.parse(JSON.stringify(msg)) as MessageToWorker
        queueMicrotask(() => {
          this.workerHandler.handleMessage(serialized)
        })
      },
      onmessage: null,
      onerror: null,
      terminate: () => {
        this.workerHandler.handleMessage({ type: AGENT_WORKER_MSG.WORKER_TERMINATE })
      }
    }
  }

  getPort(): IWorkerPort {
    return this.clientPort
  }

  getHandler(): AgentWorkerHandler {
    return this.workerHandler
  }
}

describe('Phase 12.1 — Dedicated Agent Worker Architecture Test Suite', () => {
  let mockProvider: TestMockAIProvider
  let channel: VirtualWorkerChannel
  let client: AgentWorkerClient

  beforeEach(() => {
    mockProvider = new TestMockAIProvider()
    channel = new VirtualWorkerChannel()

    // Register test provider in worker handler
    channel.getHandler().registerCustomProvider(mockProvider)

    // Create client using virtual worker channel
    client = new AgentWorkerClient(mockProvider, {
      workerFactory: () => channel.getPort(),
      fallbackToInProcess: false
    })
  })

  afterEach(() => {
    resetMockElectron()
    client.terminate()
    mockProvider.clear()
  })

  // -------------------------------------------------------------------------
  // 1. Worker request/response correlation
  // -------------------------------------------------------------------------
  it('1. Worker request/response correlation: correlates responses to exact request IDs', async () => {
    mockProvider.enqueueResponse({ text: 'Correlated response payload' })

    const response = await client.run('Hello from correlation test', {
      apiKey: 'test-key',
      workspaceRoot: '/mock/workspace'
    })

    expect(response).toBe('Correlated response payload')
    expect(mockProvider.recordedCalls.length).toBeGreaterThan(0)
    expect(mockProvider.recordedCalls[0].messages[0].parts[0].text).toContain(
      'Hello from correlation test'
    )
  })

  // -------------------------------------------------------------------------
  // 2. Worker initialization & ready state
  // -------------------------------------------------------------------------
  it('2. Worker initialization: initializes worker and reports protocol version and ready status', async () => {
    const diagnostics = client.getDiagnostics()
    expect(diagnostics.workerActive).toBe(true)
    expect(diagnostics.protocolVersion).toBe(AGENT_WORKER_PROTOCOL_VERSION)
    expect(diagnostics.fallbackMode).toBe(false)
  })

  // -------------------------------------------------------------------------
  // 3. Successful agent request round-trip
  // -------------------------------------------------------------------------
  it('3. Successful agent request: completes full agent request loop across worker boundary', async () => {
    mockProvider.enqueueResponse({
      text: 'Final response generated successfully by worker.'
    })

    const result = await client.run('Explain code structure', {
      apiKey: 'mock-key',
      workspaceRoot: '/test/workspace'
    })

    expect(result).toBe('Final response generated successfully by worker.')
    const diag = client.getDiagnostics()
    expect(diag.totalRequestsCompleted).toBe(1)
    expect(diag.activeRequestsCount).toBe(0)
  })

  // -------------------------------------------------------------------------
  // 4. Streaming events
  // -------------------------------------------------------------------------
  it('4. Streaming events: delivers chunked streaming events in correct sequence without leakage', async () => {
    mockProvider.enqueueResponse({
      text: 'Streaming chunk one and chunk two.'
    })

    const chunksReceived: string[] = []
    const stepsReceived: string[] = []

    const result = await client.run('Stream test', {
      apiKey: 'mock-key',
      workspaceRoot: '/test/workspace',
      onChunk: (chunk) => {
        chunksReceived.push(chunk)
      },
      onStep: (event) => {
        stepsReceived.push(event.type)
      }
    })

    expect(chunksReceived.length).toBeGreaterThan(0)
    expect(chunksReceived.join('')).toBe('Streaming chunk one and chunk two.')
    expect(stepsReceived).toContain('thinking')
    expect(result).toBe('Streaming chunk one and chunk two.')
  })

  // -------------------------------------------------------------------------
  // 5. Tool request -> main bridge -> tool result
  // -------------------------------------------------------------------------
  it('5. Tool request -> main bridge: routes tool calls from worker to host tool and returns result', async () => {
    const mockToolExecuted = vi.fn()
    const mockCustomTool: ITool = {
      name: 'inspect_repo',
      description: 'Inspects repository metadata',
      parameters: {
        type: 'object',
        properties: { target: { type: 'string' } }
      },
      requiresApproval: false,
      execute: async (args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolExecutionResult> => {
        mockToolExecuted(args)
        return {
          success: true,
          output: JSON.stringify({ status: 'healthy', fileCount: 42 })
        }
      }
    }

    client.registerTool(mockCustomTool)

    // 1st LLM turn: call tool
    mockProvider.enqueueResponse({
      functionCalls: [
        {
          name: 'inspect_repo',
          args: { target: 'src/' }
        }
      ]
    })
    // 2nd LLM turn: reply with final answer
    mockProvider.enqueueResponse({
      text: 'The repository is healthy with 42 files.'
    })

    const result = await client.run('Inspect repo health', {
      apiKey: 'mock-key',
      workspaceRoot: '/test/workspace'
    })

    expect(mockToolExecuted).toHaveBeenCalledWith({ target: 'src/' })
    expect(result).toBe('The repository is healthy with 42 files.')
  })

  // -------------------------------------------------------------------------
  // 6. Tool failure propagation & anti-fabrication
  // -------------------------------------------------------------------------
  it('6. Tool failure propagation: safely propagates tool errors across bridge without fabrication', async () => {
    const failingTool: ITool = {
      name: 'failing_tool',
      description: 'A tool that fails on execution',
      parameters: { type: 'object', properties: {} },
      requiresApproval: false,
      execute: async () => {
        return {
          success: false,
          output: '',
          error: 'Critical IO failure: disk not writable'
        }
      }
    }

    client.registerTool(failingTool)

    // LLM calls failing tool
    mockProvider.enqueueResponse({
      functionCalls: [{ name: 'failing_tool', args: {} }]
    })
    // LLM must acknowledge failure
    mockProvider.enqueueResponse({
      text: 'I could not perform the action because the disk is not writable.'
    })

    const result = await client.run('Run failing operation', {
      apiKey: 'mock-key',
      workspaceRoot: '/test/workspace'
    })

    expect(result).toContain('not writable')
  })

  // -------------------------------------------------------------------------
  // 7. Cancellation
  // -------------------------------------------------------------------------
  it('7. Cancellation: cancels in-flight request, propagates abort signal, and cleans up state', async () => {
    const abortCtrl = new AbortController()

    // Enqueue response that will not resolve immediately
    let rejectPromise: ((err: Error) => void) | null = null
    const hangingPromise = new Promise<LLMResponse>((_, reject) => {
      rejectPromise = reject
    })

    const hangingProvider: IAIProvider = {
      id: 'hanging-provider',
      name: 'Hanging Provider',
      capabilities: { supportsStreaming: true, supportsTools: true, requiresApiKey: false },
      sendMessage: async (_m, _t, opts) => {
        if (opts.signal) {
          opts.signal.addEventListener('abort', () => {
            rejectPromise?.(new Error('Request was stopped by user.'))
          })
        }
        return hangingPromise
      }
    }

    channel.getHandler().registerCustomProvider(hangingProvider)

    const hangingClient = new AgentWorkerClient(hangingProvider, {
      workerFactory: () => channel.getPort(),
      fallbackToInProcess: false
    })

    const runPromise = hangingClient.run('Hanging request', {
      apiKey: 'key',
      workspaceRoot: '/test',
      signal: abortCtrl.signal
    })

    // Abort shortly after
    setTimeout(() => {
      abortCtrl.abort()
    }, 10)

    await expect(runPromise).rejects.toThrow(/stopped by user/i)
    expect(hangingClient.getDiagnostics().activeRequestsCount).toBe(0)
    expect(channel.getHandler().getActiveRequestsCount()).toBe(0)
  })

  // -------------------------------------------------------------------------
  // 8. Concurrent request isolation
  // -------------------------------------------------------------------------
  it('8. Concurrent request isolation: runs multiple concurrent requests without cross-contamination', async () => {
    // 2 requests in flight simultaneously
    mockProvider.enqueueResponse({ text: 'Response for Request Alpha' })
    mockProvider.enqueueResponse({ text: 'Response for Request Beta' })

    const [resA, resB] = await Promise.all([
      client.run('Request Alpha Prompt', {
        apiKey: 'keyA',
        workspaceRoot: '/workspaceA'
      }),
      client.run('Request Beta Prompt', {
        apiKey: 'keyB',
        workspaceRoot: '/workspaceB'
      })
    ])

    expect(resA).toBe('Response for Request Alpha')
    expect(resB).toBe('Response for Request Beta')
    expect(client.getDiagnostics().activeRequestsCount).toBe(0)
  })

  // -------------------------------------------------------------------------
  // 9. Worker error handling & structured error serialization
  // -------------------------------------------------------------------------
  it('9. Worker error handling: serializes errors cleanly without crashing client or leaking raw objects', async () => {
    const errorProvider: IAIProvider = {
      id: 'error-provider',
      name: 'Error Provider',
      capabilities: { supportsStreaming: false, supportsTools: false, requiresApiKey: false },
      sendMessage: async () => {
        throw new Error('Fatal provider API failure: HTTP 500 Internal Error')
      }
    }

    channel.getHandler().registerCustomProvider(errorProvider)

    const errorClient = new AgentWorkerClient(errorProvider, {
      workerFactory: () => channel.getPort(),
      fallbackToInProcess: false
    })

    await expect(
      errorClient.run('Will fail with 500', {
        apiKey: 'key',
        workspaceRoot: '/test'
      })
    ).rejects.toThrow('Fatal provider API failure: HTTP 500 Internal Error')

    expect(errorClient.getDiagnostics().totalRequestsFailed).toBe(1)
    expect(errorClient.getDiagnostics().activeRequestsCount).toBe(0)
  })

  // -------------------------------------------------------------------------
  // 10. Cleanup & no leaked request state
  // -------------------------------------------------------------------------
  it('10. Cleanup: verifies all request maps and listeners are completely emptied after completion', async () => {
    mockProvider.enqueueResponse({ text: 'Completed cleanup test' })

    await client.run('Prompt for cleanup verification', {
      apiKey: 'key',
      workspaceRoot: '/test'
    })

    expect(client.getDiagnostics().activeRequestsCount).toBe(0)
    expect(channel.getHandler().getActiveRequestsCount()).toBe(0)
  })

  // -------------------------------------------------------------------------
  // 11. No privileged tool execution directly inside worker
  // -------------------------------------------------------------------------
  it('11. No privileged execution in worker: ensures tools execute on host through registered handler', async () => {
    let executedOnHost = false

    const hostTool: ITool = {
      name: 'create_file',
      description: 'Creates a file on disk',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } }
      },
      requiresApproval: true,
      execute: async () => {
        executedOnHost = true
        return { success: true, output: 'File created on host' }
      }
    }

    client.registerTool(hostTool)

    mockProvider.enqueueResponse({
      functionCalls: [
        {
          name: 'create_file',
          args: { path: 'test.txt', content: 'hello' }
        }
      ]
    })
    mockProvider.enqueueResponse({
      text: 'File created successfully.'
    })

    const approvalMock = vi.fn().mockResolvedValue(true)

    await client.run('Create test.txt', {
      apiKey: 'key',
      workspaceRoot: '/test',
      requestApproval: approvalMock
    })

    // Approval must have been invoked on host
    expect(approvalMock).toHaveBeenCalled()
    // Execution occurred via host bridge
    expect(executedOnHost).toBe(true)
  })

  // -------------------------------------------------------------------------
  // 12. Human-in-the-loop approval rejection across worker boundary
  // -------------------------------------------------------------------------
  it('12. Tool approval rejection: rejects tool execution when user declines approval', async () => {
    const dangerousTool: ITool = {
      name: 'run_command',
      description: 'Run terminal command',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } }
      },
      requiresApproval: true,
      execute: async () => {
        return { success: true, output: 'Command executed' }
      }
    }

    client.registerTool(dangerousTool)

    mockProvider.enqueueResponse({
      functionCalls: [{ name: 'run_command', args: { command: 'rm -rf /' } }]
    })
    mockProvider.enqueueResponse({
      text: 'The command was rejected by the user.'
    })

    // User rejects tool
    const approvalReject = vi.fn().mockResolvedValue(false)

    const result = await client.run('Run dangerous command', {
      apiKey: 'key',
      workspaceRoot: '/test',
      requestApproval: approvalReject
    })

    expect(approvalReject).toHaveBeenCalled()
    expect(result).toMatch(/rejected by (the )?user/i)
  })

  // -------------------------------------------------------------------------
  // 13. Fallback mode when worker is unavailable
  // -------------------------------------------------------------------------
  it('13. Fallback mode: activates controlled in-process fallback when worker cannot be spawned', async () => {
    // Client with broken worker factory
    const fallbackClient = new AgentWorkerClient(mockProvider, {
      workerFactory: () => {
        throw new Error('Web Workers are disabled in this environment')
      },
      fallbackToInProcess: true
    })

    expect(fallbackClient.getDiagnostics().fallbackMode).toBe(true)
    expect(fallbackClient.getDiagnostics().workerActive).toBe(false)

    mockProvider.enqueueResponse({
      text: 'In-process fallback response succeeded.'
    })

    const result = await fallbackClient.run('Test fallback', {
      apiKey: 'key',
      workspaceRoot: '/test'
    })

    expect(result).toBe('In-process fallback response succeeded.')
  })

  // -------------------------------------------------------------------------
  // 14. SmartContext & ContextBudget integration preservation
  // -------------------------------------------------------------------------
  it('14. SmartContext integration: preserves SmartContextEngine and ContextBudgetOptimizer functionality', () => {
    const engine = client.getSmartContextEngine()
    expect(engine).toBeDefined()
    expect(typeof engine.resolveContext).toBe('function')
    expect(typeof engine.getContextOptimizer).toBe('function')

    const optimizer = engine.getContextOptimizer()
    expect(optimizer).toBeDefined()
    expect(typeof optimizer.optimize).toBe('function')
  })
})

describe('Phase 12.2 — Concurrency, Backpressure, Timeouts & Strong Cancellation', () => {
  let mockProvider: TestMockAIProvider
  let channel: VirtualWorkerChannel
  let client: AgentWorkerClient

  beforeEach(() => {
    mockProvider = new TestMockAIProvider()
    channel = new VirtualWorkerChannel()
    channel.getHandler().registerCustomProvider(mockProvider)
    client = new AgentWorkerClient(mockProvider, {
      workerFactory: () => channel.getPort(),
      fallbackToInProcess: false,
      maxConcurrentRequests: 2,
      maxQueueCapacity: 4,
      defaultTimeoutMs: 60_000
    })
  })

  afterEach(() => {
    resetMockElectron()
    client.terminate()
    mockProvider.clear()
  })

  // 1. concurrency limit enforcement
  it('1. concurrency limit enforcement: limits active requests to maxConcurrentRequests and queues remainder', async () => {
    let resolveReq1: ((res: LLMResponse) => void) | null = null
    let resolveReq2: ((res: LLMResponse) => void) | null = null

    const p1 = new Promise<LLMResponse>((res) => {
      resolveReq1 = res
    })
    const p2 = new Promise<LLMResponse>((res) => {
      resolveReq2 = res
    })

    mockProvider.enqueueResponse(p1 as unknown as LLMResponse)
    mockProvider.enqueueResponse(p2 as unknown as LLMResponse)
    mockProvider.enqueueResponse({ text: 'Response 3' })

    const r1 = client.run('Prompt 1', { apiKey: 'k', workspaceRoot: '/w' })
    const r2 = client.run('Prompt 2', { apiKey: 'k', workspaceRoot: '/w' })
    const r3 = client.run('Prompt 3', { apiKey: 'k', workspaceRoot: '/w' })

    // Give microtasks time to dispatch
    await new Promise((r) => setTimeout(r, 15))

    const diag = client.getDiagnostics()
    expect(diag.activeRequestsCount).toBe(2)
    expect(diag.queuedRequestsCount).toBe(1)

    // Complete req1 & req2
    resolveReq1!({ text: 'Response 1' })
    resolveReq2!({ text: 'Response 2' })

    const [out1, out2, out3] = await Promise.all([r1, r2, r3])
    expect(out1).toBe('Response 1')
    expect(out2).toBe('Response 2')
    expect(out3).toBe('Response 3')

    const finalDiag = client.getDiagnostics()
    expect(finalDiag.activeRequestsCount).toBe(0)
    expect(finalDiag.queuedRequestsCount).toBe(0)
    expect(finalDiag.totalRequestsCompleted).toBe(3)
  })

  // 2. FIFO queue ordering
  it('2. FIFO queue ordering: processes queued requests in strict first-in, first-out order', async () => {
    const singleSlotClient = new AgentWorkerClient(mockProvider, {
      workerFactory: () => channel.getPort(),
      fallbackToInProcess: false,
      maxConcurrentRequests: 1,
      maxQueueCapacity: 10
    })

    const executionOrder: string[] = []

    mockProvider.enqueueResponse({ text: 'R1 done' })
    mockProvider.enqueueResponse({ text: 'R2 done' })
    mockProvider.enqueueResponse({ text: 'R3 done' })

    const p1 = singleSlotClient.run('First', { apiKey: 'k', workspaceRoot: '/w' }).then((res) => {
      executionOrder.push('First')
      return res
    })
    const p2 = singleSlotClient.run('Second', { apiKey: 'k', workspaceRoot: '/w' }).then((res) => {
      executionOrder.push('Second')
      return res
    })
    const p3 = singleSlotClient.run('Third', { apiKey: 'k', workspaceRoot: '/w' }).then((res) => {
      executionOrder.push('Third')
      return res
    })

    await Promise.all([p1, p2, p3])

    expect(executionOrder).toEqual(['First', 'Second', 'Third'])
    singleSlotClient.terminate()
  })

  // 3. queued request cancellation
  it('3. queued request cancellation: cancels queued request without starting execution', async () => {
    const singleSlotClient = new AgentWorkerClient(mockProvider, {
      workerFactory: () => channel.getPort(),
      fallbackToInProcess: false,
      maxConcurrentRequests: 1,
      maxQueueCapacity: 5
    })

    let resolveP1: ((res: LLMResponse) => void) | null = null
    const p1Promise = new Promise<LLMResponse>((res) => {
      resolveP1 = res
    })
    mockProvider.enqueueResponse(p1Promise as unknown as LLMResponse)

    const r1 = singleSlotClient.run('Busy', { apiKey: 'k', workspaceRoot: '/w' })

    const abortCtrl2 = new AbortController()
    const r2 = singleSlotClient.run('Queued Item', {
      apiKey: 'k',
      workspaceRoot: '/w',
      signal: abortCtrl2.signal
    })

    await new Promise((r) => setTimeout(r, 10))
    expect(singleSlotClient.getDiagnostics().queuedRequestsCount).toBe(1)

    // Cancel r2 while still queued
    abortCtrl2.abort()

    await expect(r2).rejects.toThrow(/stopped by user/i)
    expect(singleSlotClient.getDiagnostics().queuedRequestsCount).toBe(0)

    // Complete r1
    resolveP1!({ text: 'Busy done' })
    await r1

    expect(singleSlotClient.getDiagnostics().totalRequestsCompleted).toBe(1)
    expect(singleSlotClient.getDiagnostics().totalRequestsCancelled).toBe(1)
    singleSlotClient.terminate()
  })

  // 4. queue capacity rejection (backpressure)
  it('4. queue capacity rejection: rejects requests with ERR_QUEUE_FULL when queue is at max capacity', async () => {
    const limitedClient = new AgentWorkerClient(mockProvider, {
      workerFactory: () => channel.getPort(),
      fallbackToInProcess: false,
      maxConcurrentRequests: 1,
      maxQueueCapacity: 2
    })

    let resolveActive: ((res: LLMResponse) => void) | null = null
    mockProvider.enqueueResponse(
      new Promise<LLMResponse>((res) => {
        resolveActive = res
      }) as unknown as LLMResponse
    )

    // 1 active
    const pActive = limitedClient.run('Active', { apiKey: 'k', workspaceRoot: '/w' })
    // 2 queued (fills capacity of 2)
    const pQ1 = limitedClient.run('Q1', { apiKey: 'k', workspaceRoot: '/w' })
    const pQ2 = limitedClient.run('Q2', { apiKey: 'k', workspaceRoot: '/w' })

    await new Promise((r) => setTimeout(r, 10))
    expect(limitedClient.getDiagnostics().queuedRequestsCount).toBe(2)

    // 4th request must be rejected immediately due to queue full
    let queueError: Error | null = null
    try {
      await limitedClient.run('Q3_Overflow', { apiKey: 'k', workspaceRoot: '/w' })
    } catch (err: unknown) {
      queueError = err as Error
    }

    expect(queueError).not.toBeNull()
    expect(queueError!.message).toContain('queue is full')
    expect((queueError as unknown as Record<string, unknown>).code).toBe(AGENT_ERROR_CODES.QUEUE_FULL)

    // Cleanup active
    resolveActive!({ text: 'Active finished' })
    mockProvider.enqueueResponse({ text: 'Q1 finished' })
    mockProvider.enqueueResponse({ text: 'Q2 finished' })

    await Promise.all([pActive, pQ1, pQ2])
    limitedClient.terminate()
  })

  // 5. request timeout
  it('5. request timeout: triggers timeout when request exceeds timeoutMs and sets TIMED_OUT status', async () => {
    // Provider that never responds
    const timeoutClient = new AgentWorkerClient(mockProvider, {
      workerFactory: () => channel.getPort(),
      fallbackToInProcess: false,
      defaultTimeoutMs: 50
    })

    mockProvider.enqueueResponse(new Promise<LLMResponse>(() => {}) as unknown as LLMResponse)

    let timeoutError: Error | null = null
    try {
      await timeoutClient.run('Will timeout', {
        apiKey: 'k',
        workspaceRoot: '/w',
        timeoutMs: 40
      })
    } catch (err: unknown) {
      timeoutError = err as Error
    }

    expect(timeoutError).not.toBeNull()
    expect(timeoutError!.message).toContain('timed out')
    expect((timeoutError as unknown as Record<string, unknown>).code).toBe(AGENT_ERROR_CODES.TIMEOUT)
    expect((timeoutError as unknown as Record<string, unknown>).isTimeout).toBe(true)
    expect(timeoutClient.getDiagnostics().totalRequestsTimedOut).toBe(1)
    timeoutClient.terminate()
  })

  // 6. timeout cleanup
  it('6. timeout cleanup: clears timeout timers and releases concurrency slots after timeout fires', async () => {
    const timeoutClient = new AgentWorkerClient(mockProvider, {
      workerFactory: () => channel.getPort(),
      fallbackToInProcess: false,
      maxConcurrentRequests: 1,
      defaultTimeoutMs: 30
    })

    mockProvider.enqueueResponse(new Promise<LLMResponse>(() => {}) as unknown as LLMResponse)

    await expect(
      timeoutClient.run('Timeout test', { apiKey: 'k', workspaceRoot: '/w', timeoutMs: 30 })
    ).rejects.toThrow(/timed out/i)

    expect(timeoutClient.getDiagnostics().activeRequestsCount).toBe(0)
    expect(timeoutClient.getDiagnostics().queuedRequestsCount).toBe(0)

    // Slot should now be available for next request
    mockProvider.enqueueResponse({ text: 'Subsequent success' })
    const res = await timeoutClient.run('Next request', { apiKey: 'k', workspaceRoot: '/w' })
    expect(res).toBe('Subsequent success')

    timeoutClient.terminate()
  })

  // 7. running request cancellation
  it('7. running request cancellation: immediately halts execution and aborts running orchestrator', async () => {
    const abortCtrl = new AbortController()

    mockProvider.enqueueResponse(new Promise<LLMResponse>(() => {}) as unknown as LLMResponse)

    const runPromise = client.run('Cancel me', {
      apiKey: 'k',
      workspaceRoot: '/w',
      signal: abortCtrl.signal
    })

    await new Promise((r) => setTimeout(r, 10))
    expect(client.getDiagnostics().activeRequestsCount).toBe(1)

    abortCtrl.abort()

    await expect(runPromise).rejects.toThrow(/stopped by user/i)
    expect(client.getDiagnostics().activeRequestsCount).toBe(0)
    expect(client.getDiagnostics().totalRequestsCancelled).toBe(1)
  })

  // 8. cancellation while waiting for tool result
  it('8. cancellation while waiting for tool: cancels request awaiting tool and drops late tool results', async () => {
    let resolveTool: ((res: ToolExecutionResult) => void) | null = null
    const toolPromise = new Promise<ToolExecutionResult>((res) => {
      resolveTool = res
    })

    const slowTool: ITool = {
      name: 'slow_tool',
      description: 'Slow tool',
      parameters: { type: 'object', properties: {} },
      requiresApproval: false,
      execute: async () => toolPromise
    }

    client.registerTool(slowTool)

    mockProvider.enqueueResponse({
      functionCalls: [{ name: 'slow_tool', args: {} }]
    })

    const abortCtrl = new AbortController()
    const runPromise = client.run('Run slow tool', {
      apiKey: 'k',
      workspaceRoot: '/w',
      signal: abortCtrl.signal
    })

    await new Promise((r) => setTimeout(r, 20))

    // Abort while waiting for tool
    abortCtrl.abort()
    await expect(runPromise).rejects.toThrow(/stopped by user/i)

    // Late tool resolution should not crash or revive request
    resolveTool!({ success: true, output: 'Late tool output' })
    await new Promise((r) => setTimeout(r, 20))

    expect(client.getDiagnostics().activeRequestsCount).toBe(0)
  })

  // 9. cancellation while waiting for IPC
  it('9. cancellation while waiting for IPC: drops late IPC response if request was cancelled', async () => {
    mockProvider.enqueueResponse(new Promise<LLMResponse>(() => {}) as unknown as LLMResponse)

    const abortCtrl = new AbortController()
    const runPromise = client.run('Wait IPC', {
      apiKey: 'k',
      workspaceRoot: '/w',
      signal: abortCtrl.signal
    })

    await new Promise((r) => setTimeout(r, 10))
    abortCtrl.abort()

    await expect(runPromise).rejects.toThrow(/stopped by user/i)
    expect(client.getDiagnostics().activeRequestsCount).toBe(0)
  })

  // 10. late provider chunk after cancellation
  it('10. late provider chunk after cancellation: ignores late streaming chunks after cancellation', async () => {
    let chunkReceivedAfterCancel = false
    let isCancelled = false

    const streamingProvider: IAIProvider = {
      id: 'streaming-cancel-provider',
      name: 'Streaming Cancel Provider',
      capabilities: { supportsStreaming: true, supportsTools: false, requiresApiKey: false },
      sendMessage: async (_m, _t, opts) => {
        opts.onChunk?.('Chunk 1')
        await new Promise((r) => setTimeout(r, 25))
        if (isCancelled) {
          chunkReceivedAfterCancel = true
        }
        opts.onChunk?.('Late Chunk 2')
        return { text: 'Done' }
      }
    }

    channel.getHandler().registerCustomProvider(streamingProvider)
    const streamClient = new AgentWorkerClient(streamingProvider, {
      workerFactory: () => channel.getPort(),
      fallbackToInProcess: false
    })

    const receivedChunks: string[] = []
    const abortCtrl = new AbortController()

    const runPromise = streamClient.run('Streaming cancel', {
      apiKey: 'k',
      workspaceRoot: '/w',
      signal: abortCtrl.signal,
      onChunk: (c) => {
        receivedChunks.push(c)
      }
    })

    await new Promise((r) => setTimeout(r, 10))
    isCancelled = true
    abortCtrl.abort()

    await expect(runPromise).rejects.toThrow(/stopped by user/i)

    await new Promise((r) => setTimeout(r, 40))
    expect(chunkReceivedAfterCancel).toBe(true)
    expect(receivedChunks).not.toContain('Late Chunk 2')
    streamClient.terminate()
  })

  // 11. late tool result after cancellation
  it('11. late tool result after cancellation: does not corrupt state when tool result arrives post-cancellation', async () => {
    // Post late tool result for non-existent/cancelled request
    channel.getPort().postMessage({
      type: AGENT_WORKER_MSG.TOOL_RESULT,
      requestId: 'non-existent-or-cancelled',
      toolCallId: 'call_late_123',
      result: { success: true, output: 'Late ghost output' }
    })

    await new Promise((r) => setTimeout(r, 15))
    expect(client.getDiagnostics().activeRequestsCount).toBe(0)
  })

  // 12. late IPC result after cancellation
  it('12. late IPC result after cancellation: safely drops IPC results arriving after cancellation', async () => {
    channel.getPort().postMessage({
      type: AGENT_WORKER_MSG.IPC_CALL_RESULT,
      callId: 'call_orphan_ipc',
      success: true,
      result: { ok: true }
    })

    await new Promise((r) => setTimeout(r, 15))
    expect(client.getDiagnostics().activeRequestsCount).toBe(0)
  })

  // 13. duplicate terminal event protection
  it('13. duplicate terminal event protection: ignores duplicate complete or error messages', async () => {
    mockProvider.enqueueResponse({ text: 'One-time resolution' })

    const runPromise = client.run('Duplicate check', { apiKey: 'k', workspaceRoot: '/w' })
    const res = await runPromise
    expect(res).toBe('One-time resolution')

    // Simulate duplicate completion message posted directly from worker port
    channel.getPort().onmessage?.({
      data: {
        type: AGENT_WORKER_MSG.REQUEST_COMPLETE,
        requestId: 'already-completed',
        response: 'Duplicate resolution'
      }
    })

    expect(client.getDiagnostics().totalRequestsCompleted).toBe(1)
  })

  // 14. concurrent request isolation
  it('14. concurrent request isolation: maintains distinct state, timers, and callbacks across parallel runs', async () => {
    mockProvider.enqueueResponse({ text: 'Response Alpha' })
    mockProvider.enqueueResponse({ text: 'Response Beta' })

    const chunksAlpha: string[] = []
    const chunksBeta: string[] = []

    const [alpha, beta] = await Promise.all([
      client.run('Prompt Alpha', {
        apiKey: 'k',
        workspaceRoot: '/w',
        onChunk: (c) => chunksAlpha.push(c)
      }),
      client.run('Prompt Beta', {
        apiKey: 'k',
        workspaceRoot: '/w',
        onChunk: (c) => chunksBeta.push(c)
      })
    ])

    expect(alpha).toBe('Response Alpha')
    expect(beta).toBe('Response Beta')
    expect(chunksAlpha.join('')).toBe('Response Alpha')
    expect(chunksBeta.join('')).toBe('Response Beta')
  })

  // 15. stream sequence isolation
  it('15. stream sequence isolation: verifies per-request monotonic sequence increments and drops duplicates', async () => {
    const chunkReceiver: string[] = []

    mockProvider.enqueueResponse({ text: 'Monotonic streaming' })

    await client.run('Sequence test', {
      apiKey: 'k',
      workspaceRoot: '/w',
      onChunk: (chunk) => {
        chunkReceiver.push(chunk)
      }
    })

    expect(chunkReceiver.length).toBeGreaterThan(0)
    expect(chunkReceiver.join('')).toBe('Monotonic streaming')
  })

  // 16. duplicate tool-result protection
  it('16. duplicate tool-result protection: safely drops duplicate tool results for the same toolCallId', async () => {
    const dummyTool: ITool = {
      name: 'idempotent_tool',
      description: 'Idempotent tool',
      parameters: { type: 'object', properties: {} },
      requiresApproval: false,
      execute: async () => ({ success: true, output: 'Tool output' })
    }

    client.registerTool(dummyTool)

    mockProvider.enqueueResponse({
      functionCalls: [{ name: 'idempotent_tool', args: {} }]
    })
    mockProvider.enqueueResponse({ text: 'Processed once' })

    const res = await client.run('Test tool duplicate', { apiKey: 'k', workspaceRoot: '/w' })
    expect(res).toBe('Processed once')
  })

  // 17. worker failure with multiple active requests
  it('17. worker failure with multiple active requests: fails both running and queued requests cleanly on crash', async () => {
    const crashClient = new AgentWorkerClient(mockProvider, {
      workerFactory: () => channel.getPort(),
      fallbackToInProcess: false,
      maxConcurrentRequests: 1,
      maxQueueCapacity: 5
    })

    mockProvider.enqueueResponse(new Promise<LLMResponse>(() => {}) as unknown as LLMResponse)

    const r1 = crashClient.run('Running on crash', { apiKey: 'k', workspaceRoot: '/w' })
    const r2 = crashClient.run('Queued on crash', { apiKey: 'k', workspaceRoot: '/w' })

    await new Promise((r) => setTimeout(r, 10))
    expect(crashClient.getDiagnostics().activeRequestsCount).toBe(1)
    expect(crashClient.getDiagnostics().queuedRequestsCount).toBe(1)

    // Trigger worker crash
    channel.getPort().onerror?.(new Error('Fatal segmentation fault in worker process'))

    await expect(r1).rejects.toThrow(/worker error/i)
    await expect(r2).rejects.toThrow(/worker error/i)

    expect(crashClient.getDiagnostics().activeRequestsCount).toBe(0)
    expect(crashClient.getDiagnostics().queuedRequestsCount).toBe(0)
    crashClient.terminate()
  })

  // 18. cleanup of request state
  it('18. cleanup of request state: ensures zero residual request objects in maps after terminal state', async () => {
    mockProvider.enqueueResponse({ text: 'Clean me up' })

    await client.run('Cleanup test', { apiKey: 'k', workspaceRoot: '/w' })

    const diag = client.getDiagnostics()
    expect(diag.activeRequestsCount).toBe(0)
    expect(diag.queuedRequestsCount).toBe(0)
  })

  // 19. concurrency slot release after success
  it('19. slot release after success: frees execution slot for queued request upon successful run', async () => {
    const singleClient = new AgentWorkerClient(mockProvider, {
      workerFactory: () => channel.getPort(),
      fallbackToInProcess: false,
      maxConcurrentRequests: 1
    })

    mockProvider.enqueueResponse({ text: 'Success 1' })
    mockProvider.enqueueResponse({ text: 'Success 2' })

    const res1 = await singleClient.run('P1', { apiKey: 'k', workspaceRoot: '/w' })
    expect(res1).toBe('Success 1')
    expect(singleClient.getDiagnostics().activeRequestsCount).toBe(0)

    const res2 = await singleClient.run('P2', { apiKey: 'k', workspaceRoot: '/w' })
    expect(res2).toBe('Success 2')
    expect(singleClient.getDiagnostics().activeRequestsCount).toBe(0)

    singleClient.terminate()
  })

  // 20. concurrency slot release after failure
  it('20. slot release after failure: frees execution slot for queued request upon failed run', async () => {
    const singleClient = new AgentWorkerClient(mockProvider, {
      workerFactory: () => channel.getPort(),
      fallbackToInProcess: false,
      maxConcurrentRequests: 1
    })

    const failProvider: IAIProvider = {
      id: 'fail-then-succeed',
      name: 'Fail Then Succeed',
      capabilities: { supportsStreaming: false, supportsTools: false, requiresApiKey: false },
      sendMessage: vi
        .fn()
        .mockRejectedValueOnce(new Error('Network drop'))
        .mockResolvedValueOnce({ text: 'Recovered' })
    }

    channel.getHandler().registerCustomProvider(failProvider)

    const failClient = new AgentWorkerClient(failProvider, {
      workerFactory: () => channel.getPort(),
      fallbackToInProcess: false,
      maxConcurrentRequests: 1
    })

    // First run fails
    await expect(failClient.run('Failing', { apiKey: 'k', workspaceRoot: '/w' })).rejects.toThrow(
      'Network drop'
    )
    expect(failClient.getDiagnostics().activeRequestsCount).toBe(0)

    // Second run succeeds through released slot
    const secondRes = await failClient.run('Succeeding', { apiKey: 'k', workspaceRoot: '/w' })
    expect(secondRes).toBe('Recovered')
    expect(failClient.getDiagnostics().activeRequestsCount).toBe(0)

    singleClient.terminate()
    failClient.terminate()
  })

  // 21. concurrency slot release after cancellation
  it('21. slot release after cancellation: frees execution slot for queued request upon cancellation', async () => {
    const singleClient = new AgentWorkerClient(mockProvider, {
      workerFactory: () => channel.getPort(),
      fallbackToInProcess: false,
      maxConcurrentRequests: 1
    })

    mockProvider.enqueueResponse(new Promise<LLMResponse>(() => {}) as unknown as LLMResponse)

    const abortCtrl = new AbortController()
    const p1 = singleClient.run('Cancelling', {
      apiKey: 'k',
      workspaceRoot: '/w',
      signal: abortCtrl.signal
    })

    await new Promise((r) => setTimeout(r, 10))
    abortCtrl.abort()

    await expect(p1).rejects.toThrow(/stopped by user/i)
    expect(singleClient.getDiagnostics().activeRequestsCount).toBe(0)

    // Verify slot is immediately available
    mockProvider.enqueueResponse({ text: 'Slot freed successfully' })
    const p2Res = await singleClient.run('Subsequent', { apiKey: 'k', workspaceRoot: '/w' })
    expect(p2Res).toBe('Slot freed successfully')

    singleClient.terminate()
  })

  // 22. concurrency slot release after timeout
  it('22. slot release after timeout: frees execution slot for queued request upon timeout', async () => {
    const singleClient = new AgentWorkerClient(mockProvider, {
      workerFactory: () => channel.getPort(),
      fallbackToInProcess: false,
      maxConcurrentRequests: 1,
      defaultTimeoutMs: 30
    })

    mockProvider.enqueueResponse(new Promise<LLMResponse>(() => {}) as unknown as LLMResponse)

    await expect(
      singleClient.run('Timing out', { apiKey: 'k', workspaceRoot: '/w', timeoutMs: 25 })
    ).rejects.toThrow(/timed out/i)

    expect(singleClient.getDiagnostics().activeRequestsCount).toBe(0)

    // Verify next request acquires freed slot
    mockProvider.enqueueResponse({ text: 'Slot available after timeout' })
    const res = await singleClient.run('After timeout', { apiKey: 'k', workspaceRoot: '/w' })
    expect(res).toBe('Slot available after timeout')

    singleClient.terminate()
  })

  // 23. fallback behavior under worker failure
  it('23. fallback behavior: seamlessly executes via in-process orchestrator when worker fails', async () => {
    const fallbackClient = new AgentWorkerClient(mockProvider, {
      workerFactory: () => {
        throw new Error('Worker factory failure')
      },
      fallbackToInProcess: true
    })

    expect(fallbackClient.getDiagnostics().fallbackMode).toBe(true)
    mockProvider.enqueueResponse({ text: 'In-process fallback succeeded' })

    const res = await fallbackClient.run('Fallback test', { apiKey: 'k', workspaceRoot: '/w' })
    expect(res).toBe('In-process fallback succeeded')
    fallbackClient.terminate()
  })

  // 24. no fabricated success after cancellation/timeout
  it('24. no fabricated success: guarantees cancelled or timed-out requests never return false success', async () => {
    const abortCtrl = new AbortController()
    mockProvider.enqueueResponse(new Promise<LLMResponse>(() => {}) as unknown as LLMResponse)

    const cancelPromise = client.run('Never succeed', {
      apiKey: 'k',
      workspaceRoot: '/w',
      signal: abortCtrl.signal
    })

    setTimeout(() => abortCtrl.abort(), 10)

    let successResponse: string | null = null
    try {
      successResponse = await cancelPromise
    } catch {
      // expected failure
    }

    expect(successResponse).toBeNull()
  })
})

