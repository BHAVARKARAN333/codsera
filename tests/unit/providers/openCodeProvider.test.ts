import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { OpenCodeProvider } from '@renderer/services/ai/opencodeProvider'
import type { FunctionDeclaration, LLMMessage } from '@renderer/services/ai/types'
import type {
  OpenCodeChatCompletionRequest,
  OpenCodeModelItem,
  OpenCodeStreamChunkEvent
} from '@shared/types'
import { setupMockElectron, resetMockElectron } from '../../setup/electronMock'

// Helper to create mock ReadableStream for SSE streaming tests
function createMockSseStream(
  chunks: string[],
  options?: { onCancel?: () => void; errorAfterIndex?: number; errorToThrow?: Error }
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let index = 0

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (options?.errorAfterIndex !== undefined && index >= options.errorAfterIndex) {
        controller.error(options.errorToThrow || new Error('Stream read error'))
        return
      }

      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]))
        index++
      } else {
        controller.close()
      }
    },
    cancel() {
      options?.onCancel?.()
    }
  })
}

describe('OpenCodeProvider Unit Tests', () => {
  beforeEach(() => {
    resetMockElectron()
  })

  afterEach(() => {
    resetMockElectron()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  describe('Capabilities & Configuration', () => {
    it('initializes with correct provider metadata and capabilities', () => {
      const provider = new OpenCodeProvider()

      expect(provider.id).toBe('opencode')
      expect(provider.name).toBe('OpenCode')
      expect(provider.capabilities).toEqual({
        supportsStreaming: true,
        supportsTools: true,
        requiresApiKey: false,
        supportsModelListing: true
      })
    })

    it('respects custom constructor configuration and setDebug method', async () => {
      let capturedReq: any = null
      const provider = new OpenCodeProvider({
        defaultModel: 'custom-free-model',
        defaultTimeoutMs: 45000,
        debug: true,
        ipcCaller: async (req) => {
          capturedReq = req
          return {
            success: true,
            data: { choices: [{ message: { role: 'assistant', content: 'Debug response' } }] }
          }
        }
      })

      const consoleDebugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})

      const res = await provider.sendMessage(
        [{ role: 'user', parts: [{ text: 'Hello' }] }],
        [],
        { apiKey: '' }
      )

      expect(res.text).toBe('Debug response')
      expect(capturedReq).not.toBeNull()
      expect(capturedReq?.model).toBe('custom-free-model')
      expect(capturedReq?.timeoutMs).toBe(45000)
      expect(consoleDebugSpy).toHaveBeenCalled()

      // Toggling setDebug(false) suppresses debug output
      consoleDebugSpy.mockClear()
      provider.setDebug(false)
      await provider.sendMessage(
        [{ role: 'user', parts: [{ text: 'Hello 2' }] }],
        [],
        { apiKey: '' }
      )
      expect(consoleDebugSpy).not.toHaveBeenCalled()
    })

    it('does NOT require an API key and succeeds with empty or blank key', async () => {
      let capturedReq: any = null
      const provider = new OpenCodeProvider({
        ipcCaller: async (req) => {
          capturedReq = req
          return {
            success: true,
            data: { choices: [{ message: { role: 'assistant', content: 'No key needed' } }] }
          }
        }
      })

      // Empty string
      const res1 = await provider.sendMessage(
        [{ role: 'user', parts: [{ text: 'Hi' }] }],
        [],
        { apiKey: '' }
      )
      expect(res1.text).toBe('No key needed')
      expect(capturedReq?.apiKey).toBeUndefined()

      // Whitespace string
      const res2 = await provider.sendMessage(
        [{ role: 'user', parts: [{ text: 'Hi' }] }],
        [],
        { apiKey: '   ' }
      )
      expect(res2.text).toBe('No key needed')
      expect(capturedReq?.apiKey).toBeUndefined()
    })
  })

  describe('Request Payload and Message/Tool Formatting', () => {
    it('formats system instruction, messages, and tools via OpenAI serializers', async () => {
      let capturedReq: OpenCodeChatCompletionRequest | null = null
      const provider = new OpenCodeProvider({
        ipcCaller: async (req) => {
          capturedReq = req
          return {
            success: true,
            data: { choices: [{ message: { role: 'assistant', content: 'OpenCode Ready' } }] }
          }
        }
      })

      const tools: FunctionDeclaration[] = [
        {
          name: 'calculate',
          description: 'Calculator tool',
          parameters: {
            type: 'object',
            properties: { expr: { type: 'string' } },
            required: ['expr']
          }
        }
      ]

      const messages: LLMMessage[] = [
        { role: 'user', parts: [{ text: 'Compute 2+2' }] },
        { role: 'model', parts: [{ text: 'Thinking' }] },
        { role: 'user', parts: [{ text: 'Go ahead' }] }
      ]

      const resp = await provider.sendMessage(messages, tools, {
        apiKey: 'opencode-key-123',
        modelName: 'space-bunny-free',
        systemInstruction: 'You are an OpenCode assistant',
        temperature: 0.5,
        timeoutMs: 30000
      })

      expect(resp.text).toBe('OpenCode Ready')
      expect(capturedReq).not.toBeNull()

      const req = capturedReq as unknown as OpenCodeChatCompletionRequest
      expect(req.model).toBe('space-bunny-free')
      expect(req.temperature).toBe(0.5)
      expect(req.timeoutMs).toBe(30000)
      expect(req.apiKey).toBe('opencode-key-123')
      expect(req.requestId).toMatch(/^opencode_\d+_[a-z0-9]+_att0$/)

      // Messages check
      expect(req.messages).toHaveLength(4)
      expect(req.messages[0]).toEqual({ role: 'system', content: 'You are an OpenCode assistant' })
      expect(req.messages[1]).toEqual({ role: 'user', content: 'Compute 2+2' })
      expect(req.messages[2]).toEqual({ role: 'assistant', content: 'Thinking' })
      expect(req.messages[3]).toEqual({ role: 'user', content: 'Go ahead' })

      // Tools check
      expect(req.tool_choice).toBe('auto')
      expect(req.tools).toHaveLength(1)
      expect(req.tools?.[0].type).toBe('function')
      expect(req.tools?.[0].function.name).toBe('calculate')
      expect(req.tools?.[0].function.parameters?.required).toEqual(['expr'])
    })

    it('pairs multiple tool calls and tool responses with distinct IDs correctly', async () => {
      let capturedReq: OpenCodeChatCompletionRequest | null = null
      const provider = new OpenCodeProvider({
        ipcCaller: async (req) => {
          capturedReq = req
          return {
            success: true,
            data: { choices: [{ message: { role: 'assistant', content: 'Files processed' } }] }
          }
        }
      })

      const messages: LLMMessage[] = [
        { role: 'user', parts: [{ text: 'Read files' }] },
        {
          role: 'model',
          parts: [
            {
              id: 'call_1',
              tool_call_id: 'call_1',
              functionCall: { name: 'read_file', args: { path: 'a.txt' } }
            },
            {
              id: 'call_2',
              tool_call_id: 'call_2',
              functionCall: { name: 'read_file', args: { path: 'b.txt' } }
            }
          ]
        },
        {
          role: 'function',
          parts: [
            {
              tool_call_id: 'call_1',
              functionResponse: {
                name: 'read_file',
                response: { name: 'read_file', content: { text: 'content A' } }
              }
            }
          ]
        },
        {
          role: 'function',
          parts: [
            {
              tool_call_id: 'call_2',
              functionResponse: {
                name: 'read_file',
                response: { name: 'read_file', content: { text: 'content B' } }
              }
            }
          ]
        }
      ]

      await provider.sendMessage(messages, [], { apiKey: '' })

      expect(capturedReq).not.toBeNull()
      const req = capturedReq as unknown as OpenCodeChatCompletionRequest
      expect(req.messages).toHaveLength(4)

      const assistantMsg = req.messages[1]
      expect(assistantMsg.role).toBe('assistant')
      expect(assistantMsg.tool_calls).toHaveLength(2)
      expect(assistantMsg.tool_calls?.[0].id).toBe('call_1')
      expect(assistantMsg.tool_calls?.[1].id).toBe('call_2')

      const toolMsg1 = req.messages[2]
      expect(toolMsg1.role).toBe('tool')
      expect(toolMsg1.tool_call_id).toBe('call_1')
      expect(toolMsg1.content).toContain('content A')

      const toolMsg2 = req.messages[3]
      expect(toolMsg2.role).toBe('tool')
      expect(toolMsg2.tool_call_id).toBe('call_2')
      expect(toolMsg2.content).toContain('content B')
    })
  })

  describe('Non-Streaming Responses', () => {
    it('parses standard assistant text response and rawModelParts cleanly', async () => {
      const provider = new OpenCodeProvider({
        ipcCaller: async () => ({
          success: true,
          data: {
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: 'OpenCode standard response'
                }
              }
            ]
          }
        })
      })

      const res = await provider.sendMessage(
        [{ role: 'user', parts: [{ text: 'Prompt' }] }],
        [],
        { apiKey: '' }
      )

      expect(res.text).toBe('OpenCode standard response')
      expect(res.functionCalls).toBeUndefined()
      expect(res.rawModelParts).toHaveLength(1)
      expect(res.rawModelParts?.[0].text).toBe('OpenCode standard response')
    })

    it('parses multiple tool calls and arguments cleanly into functionCalls and rawModelParts', async () => {
      const provider = new OpenCodeProvider({
        ipcCaller: async () => ({
          success: true,
          data: {
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: 'Executing command',
                  tool_calls: [
                    {
                      id: 'call_cmd_456',
                      type: 'function',
                      function: {
                        name: 'run_command',
                        arguments: '{"command": "npm test"}'
                      }
                    },
                    {
                      id: 'call_read_789',
                      type: 'function',
                      function: {
                        name: 'read_file',
                        arguments: '{"path": "package.json"}'
                      }
                    }
                  ]
                }
              }
            ]
          }
        })
      })

      const res = await provider.sendMessage(
        [{ role: 'user', parts: [{ text: 'Run tests and read package' }] }],
        [],
        { apiKey: '' }
      )

      expect(res.text).toBe('Executing command')
      expect(res.functionCalls).toHaveLength(2)
      expect(res.functionCalls?.[0].name).toBe('run_command')
      expect(res.functionCalls?.[0].args).toEqual({ command: 'npm test' })
      expect(res.functionCalls?.[1].name).toBe('read_file')
      expect(res.functionCalls?.[1].args).toEqual({ path: 'package.json' })
      expect(res.rawModelParts).toHaveLength(3)
    })

    it('defaults malformed JSON in tool_calls arguments to empty object without throwing', async () => {
      const provider = new OpenCodeProvider({
        ipcCaller: async () => ({
          success: true,
          data: {
            choices: [
              {
                message: {
                  role: 'assistant',
                  tool_calls: [
                    {
                      id: 'call_broken',
                      type: 'function',
                      function: {
                        name: 'broken_func',
                        arguments: 'invalid json {'
                      }
                    }
                  ]
                }
              }
            ]
          }
        })
      })

      const res = await provider.sendMessage(
        [{ role: 'user', parts: [{ text: 'Test' }] }],
        [],
        { apiKey: '' }
      )

      expect(res.functionCalls).toHaveLength(1)
      expect(res.functionCalls?.[0].name).toBe('broken_func')
      expect(res.functionCalls?.[0].args).toEqual({})
    })

    it('returns fallback text when choices array is empty or missing message', async () => {
      const provider = new OpenCodeProvider({
        ipcCaller: async () => ({
          success: true,
          data: { choices: [] }
        })
      })

      const res = await provider.sendMessage(
        [{ role: 'user', parts: [{ text: 'Empty' }] }],
        [],
        { apiKey: '' }
      )

      expect(res.text).toBe('No response returned from OpenCode.')
    })
  })

  describe('Streaming Responses & Chunk Delivery', () => {
    it('emits text chunks incrementally through onChunk and returns matching final text via IPC', async () => {
      let streamListenerCallback: ((event: OpenCodeStreamChunkEvent) => void) | null = null
      const chunksReceived: string[] = []

      const provider = new OpenCodeProvider({
        streamListener: (cb) => {
          streamListenerCallback = cb
          return () => {
            streamListenerCallback = null
          }
        },
        ipcCaller: async (req) => {
          expect(req.stream).toBe(true)
          if (streamListenerCallback && req.requestId) {
            streamListenerCallback({ requestId: req.requestId, chunk: 'Hello ' })
            streamListenerCallback({ requestId: req.requestId, chunk: 'World!' })
            streamListenerCallback({ requestId: req.requestId, done: true })
          }
          return {
            success: true,
            data: {
              choices: [{ message: { role: 'assistant', content: 'Hello World!' } }]
            }
          }
        }
      })

      const resp = await provider.sendMessage(
        [{ role: 'user', parts: [{ text: 'Hi' }] }],
        [],
        {
          apiKey: '',
          modelName: 'space-bunny-free',
          onChunk: (chunk) => chunksReceived.push(chunk)
        }
      )

      expect(chunksReceived).toEqual(['Hello ', 'World!'])
      expect(resp.text).toBe('Hello World!')
      expect(resp.rawModelParts?.[0].text).toBe('Hello World!')
    })

    it('assembles incremental streaming tool calls in direct fetch fallback cleanly', async () => {
      const ssePayload = [
        'data: {"choices":[{"delta":{"content":"Thinking... "}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_99","function":{"name":"read_"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"file","arguments":"{\\"path\\": "}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"test.ts\\"}"}}]}}]}\n\n',
        'data: [DONE]\n\n'
      ]

      const mockFetch = vi.fn().mockResolvedValue(
        new Response(createMockSseStream(ssePayload), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' }
        })
      )

      const provider = new OpenCodeProvider({
        fetchImpl: mockFetch as unknown as typeof fetch
      })

      const streamedChunks: string[] = []
      const resp = await provider.sendMessage(
        [{ role: 'user', parts: [{ text: 'Read test.ts' }] }],
        [],
        {
          apiKey: '',
          modelName: 'space-bunny-free',
          onChunk: (chunk) => streamedChunks.push(chunk)
        }
      )

      expect(streamedChunks).toEqual(['Thinking... '])
      expect(resp.text).toBe('Thinking...')
      expect(resp.functionCalls).toHaveLength(1)
      expect(resp.functionCalls?.[0].name).toBe('read_file')
      expect(resp.functionCalls?.[0].args).toEqual({ path: 'test.ts' })
    })

    it('handles direct fetch non-streaming fallback correctly', async () => {
      let capturedBody: any = null
      let capturedHeaders: any = null

      const mockFetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string)
        capturedHeaders = init.headers
        return new Response(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'Direct fetch reply' } }]
          }),
          { status: 200 }
        )
      })

      const provider = new OpenCodeProvider({
        fetchImpl: mockFetch as unknown as typeof fetch
      })

      const resp = await provider.sendMessage(
        [{ role: 'user', parts: [{ text: 'Direct prompt' }] }],
        [],
        { apiKey: 'console-key' }
      )

      expect(resp.text).toBe('Direct fetch reply')
      expect(capturedBody.model).toBe('space-bunny-free')
      expect(capturedHeaders['Authorization']).toBe('Bearer console-key')
      expect(capturedHeaders['Content-Type']).toBe('application/json')
    })
  })

  describe('IPC Request Isolation & Cross-Talk Prevention', () => {
    it('generates distinct request IDs for each request and retry attempt', async () => {
      const requestIds: string[] = []
      vi.useFakeTimers()

      const provider = new OpenCodeProvider({
        ipcCaller: async (req) => {
          requestIds.push(req.requestId!)
          if (requestIds.length < 2) {
            return { success: false, status: 502, error: 'Bad Gateway' }
          }
          return {
            success: true,
            data: { choices: [{ message: { role: 'assistant', content: 'Success on retry' } }] }
          }
        }
      })

      const sendPromise = provider.sendMessage(
        [{ role: 'user', parts: [{ text: 'Hello' }] }],
        [],
        { apiKey: '' }
      )

      await vi.runAllTimersAsync()
      const res = await sendPromise

      expect(res.text).toBe('Success on retry')
      expect(requestIds).toHaveLength(2)
      expect(requestIds[0]).not.toBe(requestIds[1])
      expect(requestIds[0]).toContain('_att0')
      expect(requestIds[1]).toContain('_att1')
    })

    it('executes concurrent requests concurrently without cross-talk or ID collision', async () => {
      const capturedRequests: OpenCodeChatCompletionRequest[] = []

      const provider = new OpenCodeProvider({
        ipcCaller: async (req) => {
          capturedRequests.push(req)
          await new Promise((r) => setTimeout(r, 20))
          return {
            success: true,
            data: {
              choices: [
                { message: { role: 'assistant', content: `Response for ${req.requestId}` } }
              ]
            }
          }
        }
      })

      const [respA, respB] = await Promise.all([
        provider.sendMessage([{ role: 'user', parts: [{ text: 'Req A' }] }], [], {
          apiKey: '',
          modelName: 'model-a'
        }),
        provider.sendMessage([{ role: 'user', parts: [{ text: 'Req B' }] }], [], {
          apiKey: '',
          modelName: 'model-b'
        })
      ])

      expect(capturedRequests).toHaveLength(2)
      expect(capturedRequests[0].requestId).not.toBe(capturedRequests[1].requestId)
      expect(respA.text).toBe(`Response for ${capturedRequests[0].requestId}`)
      expect(respB.text).toBe(`Response for ${capturedRequests[1].requestId}`)
    })

    it('strictly rejects late chunks from previous retry attempts or non-matching request IDs', async () => {
      let streamListenerCallback: ((event: OpenCodeStreamChunkEvent) => void) | null = null
      let attempt = 0
      const receivedChunks: string[] = []
      vi.useFakeTimers()

      const provider = new OpenCodeProvider({
        streamListener: (cb) => {
          streamListenerCallback = cb
          return () => {
            streamListenerCallback = null
          }
        },
        ipcCaller: async (req) => {
          attempt++
          if (attempt === 1) {
            const staleId = req.requestId
            // Emitting late chunk with attempt 1's ID during retry
            setTimeout(() => {
              if (streamListenerCallback) {
                streamListenerCallback({ requestId: staleId!, chunk: 'STALE CHUNK' })
                streamListenerCallback({ requestId: 'unrelated_req_id', chunk: 'UNRELATED CHUNK' })
              }
            }, 30)
            return { success: false, status: 502, error: 'Bad Gateway' }
          }

          if (streamListenerCallback) {
            streamListenerCallback({ requestId: req.requestId!, chunk: 'FRESH CHUNK' })
          }
          return {
            success: true,
            data: { choices: [{ message: { role: 'assistant', content: 'FRESH CHUNK' } }] }
          }
        }
      })

      const sendPromise = provider.sendMessage(
        [{ role: 'user', parts: [{ text: 'Hello' }] }],
        [],
        {
          apiKey: '',
          modelName: 'space-bunny-free',
          onChunk: (c) => receivedChunks.push(c)
        }
      )

      await vi.runAllTimersAsync()
      const resp = await sendPromise

      expect(attempt).toBe(2)
      expect(receivedChunks).toEqual(['FRESH CHUNK'])
      expect(resp.text).toBe('FRESH CHUNK')
    })
  })

  describe('Cancellation Boundaries', () => {
    it('aborts immediately before making request when signal is already aborted', async () => {
      const controller = new AbortController()
      controller.abort()

      const ipcCaller = vi.fn()
      const provider = new OpenCodeProvider({ ipcCaller })

      await expect(
        provider.sendMessage([{ role: 'user', parts: [{ text: 'Cancelled' }] }], [], {
          apiKey: '',
          signal: controller.signal
        })
      ).rejects.toThrow('Request was stopped by user.')

      expect(ipcCaller).not.toHaveBeenCalled()
    })

    it('in-flight cancellation triggers cancelChatCompletion(requestId) targeting matching request', async () => {
      let cancelledReqId: string | null = null
      setupMockElectron({
        cancelChatCompletion: async (reqId: string) => {
          cancelledReqId = reqId
          return { success: true, canceled: true }
        }
      })

      const controller = new AbortController()
      let requestCaptured: any = null

      const provider = new OpenCodeProvider({
        ipcCaller: async (req) => {
          requestCaptured = req
          controller.abort() // abort in flight
          return {
            success: false,
            error: 'Request was stopped by user.',
            errorDetails: 'Request was stopped by user.'
          }
        }
      })

      await expect(
        provider.sendMessage([{ role: 'user', parts: [{ text: 'Hello' }] }], [], {
          apiKey: '',
          modelName: 'space-bunny-free',
          signal: controller.signal
        })
      ).rejects.toThrow('Request was stopped by user.')

      expect(requestCaptured).not.toBeNull()
      expect(cancelledReqId).toBe(requestCaptured?.requestId)
    })

    it('cancelling Request A does NOT cancel or affect concurrent Request B', async () => {
      const cancelledIds: string[] = []
      setupMockElectron({
        cancelChatCompletion: async (reqId: string) => {
          cancelledIds.push(reqId)
          return { success: true, canceled: true }
        }
      })

      const controllerA = new AbortController()
      const controllerB = new AbortController()

      const provider = new OpenCodeProvider({
        ipcCaller: async (req) => {
          if (req.model === 'model-a') {
            controllerA.abort()
            return { success: false, error: 'Request was stopped by user.' }
          }
          await new Promise((r) => setTimeout(r, 20))
          return {
            success: true,
            data: { choices: [{ message: { role: 'assistant', content: 'B completed safely' } }] }
          }
        }
      })

      const promiseA = provider.sendMessage([{ role: 'user', parts: [{ text: 'A' }] }], [], {
        apiKey: '',
        modelName: 'model-a',
        signal: controllerA.signal
      })

      const promiseB = provider.sendMessage([{ role: 'user', parts: [{ text: 'B' }] }], [], {
        apiKey: '',
        modelName: 'model-b',
        signal: controllerB.signal
      })

      await expect(promiseA).rejects.toThrow('Request was stopped by user.')
      const respB = await promiseB

      expect(respB.text).toBe('B completed safely')
      expect(cancelledIds).toHaveLength(1)
    })

    it('cancelled stream stops emitting chunks immediately and cleans up listener', async () => {
      let listenerActive = false
      let streamListenerCallback: ((event: OpenCodeStreamChunkEvent) => void) | null = null
      const controller = new AbortController()
      const chunksReceived: string[] = []

      const provider = new OpenCodeProvider({
        streamListener: (cb) => {
          listenerActive = true
          streamListenerCallback = cb
          return () => {
            listenerActive = false
          }
        },
        ipcCaller: async (req) => {
          streamListenerCallback?.({ requestId: req.requestId!, chunk: 'Chunk 1' })
          controller.abort()
          // Should be dropped because signal is aborted
          streamListenerCallback?.({ requestId: req.requestId!, chunk: 'Chunk 2' })
          return { success: false, error: 'Request was stopped by user.' }
        }
      })

      await expect(
        provider.sendMessage([{ role: 'user', parts: [{ text: 'Hello' }] }], [], {
          apiKey: '',
          signal: controller.signal,
          onChunk: (c) => chunksReceived.push(c)
        })
      ).rejects.toThrow('Request was stopped by user.')

      expect(chunksReceived).toEqual(['Chunk 1'])
      expect(listenerActive).toBe(false)
    })

    it('direct fetch stream halts on user abort without retrying', async () => {
      const controller = new AbortController()

      const mockFetch = vi.fn().mockImplementation(async () => {
        const encoder = new TextEncoder()
        let pulledCount = 0

        const stream = new ReadableStream<Uint8Array>({
          async pull(streamController) {
            if (pulledCount === 0) {
              pulledCount++
              streamController.enqueue(
                encoder.encode('data: {"choices":[{"delta":{"content":"Chunk 1"}}]}\n\n')
              )
            } else {
              controller.abort()
              streamController.close()
            }
          }
        })

        return new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' }
        })
      })

      const provider = new OpenCodeProvider({
        fetchImpl: mockFetch as unknown as typeof fetch
      })

      await expect(
        provider.sendMessage([{ role: 'user', parts: [{ text: 'Cancel fetch' }] }], [], {
          apiKey: '',
          signal: controller.signal,
          onChunk: () => {}
        })
      ).rejects.toThrow('Request was stopped by user.')

      expect(mockFetch).toHaveBeenCalledTimes(1)
    })
  })

  describe('Error Handling, Classification & Retries', () => {
    it('throws user-friendly error without retry on non-retryable 401 Unauthorized', async () => {
      let attempts = 0
      const provider = new OpenCodeProvider({
        ipcCaller: async () => {
          attempts++
          return {
            success: false,
            status: 401,
            error: 'Invalid API key'
          }
        }
      })

      await expect(
        provider.sendMessage([{ role: 'user', parts: [{ text: 'Auth' }] }], [], { apiKey: 'bad-key' })
      ).rejects.toThrow(/Invalid OpenCode API key/i)

      expect(attempts).toBe(1)
    })

    it('throws model unavailable error without retry on non-retryable 404 Not Found', async () => {
      let attempts = 0
      const provider = new OpenCodeProvider({
        ipcCaller: async () => {
          attempts++
          return {
            success: false,
            status: 404,
            error: 'Model not found'
          }
        }
      })

      await expect(
        provider.sendMessage([{ role: 'user', parts: [{ text: 'Model' }] }], [], {
          apiKey: '',
          modelName: 'retired-model'
        })
      ).rejects.toThrow(/was not found or has been deprecated/i)

      expect(attempts).toBe(1)
    })

    it('retries on 429 Rate Limit error, calls onRetry callback, and recovers', async () => {
      vi.useFakeTimers()
      let attempts = 0
      const retryEvents: Array<{ attempt: number; maxRetries: number; delayMs: number; reason: string }> = []

      const provider = new OpenCodeProvider({
        ipcCaller: async () => {
          attempts++
          if (attempts === 1) {
            return {
              success: false,
              status: 429,
              error: 'Rate limit exceeded'
            }
          }
          return {
            success: true,
            data: { choices: [{ message: { role: 'assistant', content: 'Recovered from 429' } }] }
          }
        }
      })

      const sendPromise = provider.sendMessage(
        [{ role: 'user', parts: [{ text: 'Retry 429' }] }],
        [],
        {
          apiKey: '',
          onRetry: (attempt, maxRetries, delayMs, reason) => {
            retryEvents.push({ attempt, maxRetries, delayMs, reason })
          }
        }
      )

      await vi.runAllTimersAsync()
      const res = await sendPromise

      expect(res.text).toBe('Recovered from 429')
      expect(attempts).toBe(2)
      expect(retryEvents).toHaveLength(1)
      expect(retryEvents[0].attempt).toBe(1)
      expect(retryEvents[0].maxRetries).toBe(2)
      expect(retryEvents[0].reason).toBe('rate_limit')
    })

    it('retries on temporary 502/503 server errors with exponential backoff and succeeds', async () => {
      vi.useFakeTimers()
      let attempts = 0

      const provider = new OpenCodeProvider({
        ipcCaller: async () => {
          attempts++
          if (attempts === 1) {
            return { success: false, status: 503, error: 'Service Unavailable' }
          }
          return {
            success: true,
            data: { choices: [{ message: { role: 'assistant', content: 'Success on retry' } }] }
          }
        }
      })

      const sendPromise = provider.sendMessage(
        [{ role: 'user', parts: [{ text: 'Server error' }] }],
        [],
        { apiKey: '' }
      )

      await vi.runAllTimersAsync()
      const res = await sendPromise

      expect(attempts).toBe(2)
      expect(res.text).toBe('Success on retry')
    })

    it('retries on network/connection errors (e.g. ECONNRESET) and succeeds', async () => {
      vi.useFakeTimers()
      let attempts = 0

      const provider = new OpenCodeProvider({
        ipcCaller: async () => {
          attempts++
          if (attempts === 1) {
            return {
              success: false,
              isNetworkError: true,
              error: 'fetch failed: ECONNRESET'
            }
          }
          return {
            success: true,
            data: { choices: [{ message: { role: 'assistant', content: 'Recovered after network blip' } }] }
          }
        }
      })

      const sendPromise = provider.sendMessage(
        [{ role: 'user', parts: [{ text: 'Net error' }] }],
        [],
        { apiKey: '' }
      )

      await vi.runAllTimersAsync()
      const res = await sendPromise

      expect(attempts).toBe(2)
      expect(res.text).toBe('Recovered after network blip')
    })

    it('propagates final error after MAX_RETRIES (3 total attempts) are exhausted and cleans up listeners', async () => {
      vi.useFakeTimers()
      let attempts = 0
      let listenerActive = false

      const provider = new OpenCodeProvider({
        streamListener: () => {
          listenerActive = true
          return () => {
            listenerActive = false
          }
        },
        ipcCaller: async () => {
          attempts++
          return {
            success: false,
            status: 500,
            error: 'Internal Server Error'
          }
        }
      })

      const sendPromise = provider.sendMessage(
        [{ role: 'user', parts: [{ text: 'Exhaust' }] }],
        [],
        { apiKey: '', onChunk: () => {} }
      )

      sendPromise.catch(() => {})
      await vi.runAllTimersAsync()

      await expect(sendPromise).rejects.toThrow(/temporarily unavailable/i)
      expect(attempts).toBe(3)
      expect(listenerActive).toBe(false)
    })
  })

  describe('Model Listing (listFreeModels)', () => {
    it('lists free models via listModelsIpcCaller and maps isFree correctly', async () => {
      const mockModels: OpenCodeModelItem[] = [
        { id: 'space-bunny-free', created: 1000, owned_by: 'opencode', isFree: true },
        { id: 'fast-coder-free', created: 2000, owned_by: 'opencode', isFree: true }
      ]

      const provider = new OpenCodeProvider({
        listModelsIpcCaller: async (req) => {
          expect(req?.apiKey).toBe('test-key')
          return { success: true, models: mockModels }
        }
      })

      const models = await provider.listFreeModels('test-key')
      expect(models).toEqual(mockModels)
      expect(models).toHaveLength(2)
    })

    it('throws error when listModelsIpcCaller fails', async () => {
      const provider = new OpenCodeProvider({
        listModelsIpcCaller: async () => ({
          success: false,
          error: 'Failed to retrieve models from OpenCode API'
        })
      })

      await expect(provider.listFreeModels()).rejects.toThrow('Failed to retrieve models from OpenCode API')
    })

    it('lists models via window.electronAPI.opencodeListModels when no custom caller is configured', async () => {
      const electronModels: OpenCodeModelItem[] = [
        { id: 'deepseek-coder-free', created: 3000, owned_by: 'deepseek', isFree: true }
      ]

      setupMockElectron({
        opencodeListModels: async () => ({
          success: true,
          models: electronModels
        })
      })

      const provider = new OpenCodeProvider()
      const models = await provider.listFreeModels()

      expect(models).toEqual(electronModels)
    })

    it('fetches and filters free models via direct fetch fallback', async () => {
      const rawApiData = {
        data: [
          { id: 'model-paid-large', created: 100, owned_by: 'corp' },
          { id: 'space-bunny-free', created: 200, owned_by: 'opencode' },
          { id: 'general-chat-free', created: 300, owned_by: 'opencode' },
          { id: 'super-code-pro', created: 400, owned_by: 'corp' }
        ]
      }

      let capturedUrl = ''
      let capturedHeaders: any = null

      const mockFetch = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
        capturedUrl = url
        capturedHeaders = init.headers
        return new Response(JSON.stringify(rawApiData), { status: 200 })
      })

      const provider = new OpenCodeProvider({
        fetchImpl: mockFetch as unknown as typeof fetch
      })

      const models = await provider.listFreeModels('key-xyz')

      expect(capturedUrl).toBe('https://opencode.ai/inference/v1/models')
      expect(capturedHeaders['Accept']).toBe('application/json')
      expect(capturedHeaders['Authorization']).toBe('Bearer key-xyz')

      // Only models with 'free' in ID are returned
      expect(models).toHaveLength(2)
      expect(models.map((m) => m.id)).toEqual(['space-bunny-free', 'general-chat-free'])
      expect(models.every((m) => m.isFree)).toBe(true)
    })

    it('handles direct fetch HTTP errors in listFreeModels gracefully', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response('Service Unavailable', { status: 503, statusText: 'Service Unavailable' })
      )

      const provider = new OpenCodeProvider({
        fetchImpl: mockFetch as unknown as typeof fetch
      })

      await expect(provider.listFreeModels()).rejects.toThrow(/Failed to fetch models: HTTP 503/)
    })
  })
})
