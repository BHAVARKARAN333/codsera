import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { OpenRouterProvider } from '@renderer/services/ai/openRouterProvider'
import type { FunctionDeclaration, LLMMessage } from '@renderer/services/ai/types'

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

describe('OpenRouterProvider Unit Tests', () => {
  let mockFetch: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockFetch = vi.fn()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  describe('Capabilities & Configuration', () => {
    it('initializes with correct provider metadata and capabilities', () => {
      const provider = new OpenRouterProvider()

      expect(provider.id).toBe('openrouter')
      expect(provider.name).toBe('OpenRouter')
      expect(provider.capabilities).toEqual({
        supportsStreaming: true,
        supportsTools: true,
        requiresApiKey: true,
        supportsModelListing: false
      })
    })

    it('respects custom default model and timeout in constructor', async () => {
      let capturedBody: any = null
      mockFetch.mockImplementation(async (_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string)
        return new Response(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'Custom model response' } }]
          }),
          { status: 200 }
        )
      })

      const provider = new OpenRouterProvider({
        defaultModel: 'anthropic/claude-3-haiku',
        defaultTimeoutMs: 15000,
        fetchImpl: mockFetch as unknown as typeof fetch
      })

      const res = await provider.sendMessage(
        [{ role: 'user', parts: [{ text: 'Hello' }] }],
        [],
        { apiKey: 'test-key' }
      )

      expect(capturedBody).not.toBeNull()
      expect(capturedBody?.model).toBe('anthropic/claude-3-haiku')
      expect(res.text).toBe('Custom model response')
    })

    it('throws immediately when API key is missing or blank without calling fetch', async () => {
      const provider = new OpenRouterProvider({ fetchImpl: mockFetch as unknown as typeof fetch })

      await expect(
        provider.sendMessage([{ role: 'user', parts: [{ text: 'Test' }] }], [], { apiKey: '' })
      ).rejects.toThrow('OpenRouter API key is not configured.')

      await expect(
        provider.sendMessage([{ role: 'user', parts: [{ text: 'Test' }] }], [], { apiKey: '   ' })
      ).rejects.toThrow('OpenRouter API key is not configured.')

      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('exposes error classification and formatting utility methods', () => {
      const provider = new OpenRouterProvider()

      expect(provider.isRetryableError(429, 'Rate limit exceeded')).toBe(true)
      expect(provider.isRetryableError(503, 'Service unavailable')).toBe(true)
      expect(provider.isRetryableError(401, 'Unauthorized')).toBe(false)
      expect(provider.isRetryableError(400, 'Bad request')).toBe(false)

      const formatted401 = provider.formatUserFriendlyError(401, 'Invalid key')
      expect(formatted401).toContain('Invalid OpenRouter API key')

      const formatted404 = provider.formatUserFriendlyError(404, 'Not found')
      expect(formatted404).toContain('was not found or has been deprecated')
    })
  })

  describe('OpenAI-Compatible Message & Tool Formatting', () => {
    it('formats system instruction, user text, and model turns into OpenAI chat completions schema', async () => {
      let capturedBody: any = null
      let capturedHeaders: any = undefined

      mockFetch.mockImplementation(async (_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string)
        capturedHeaders = init.headers
        return new Response(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'Understood.' } }]
          }),
          { status: 200 }
        )
      })

      const provider = new OpenRouterProvider({ fetchImpl: mockFetch as unknown as typeof fetch })
      const res = await provider.sendMessage(
        [{ role: 'user', parts: [{ text: 'Hello OpenRouter' }] }],
        [],
        {
          apiKey: 'test-key',
          systemInstruction: 'System instruction here',
          temperature: 0.7
        }
      )

      expect(res.text).toBe('Understood.')
      expect(capturedBody).not.toBeNull()

      const messages = capturedBody.messages
      expect(messages).toHaveLength(2)
      expect(messages[0].role).toBe('system')
      expect(messages[0].content).toBe('System instruction here')
      expect(messages[1].role).toBe('user')
      expect(messages[1].content).toBe('Hello OpenRouter')

      expect(capturedBody?.temperature).toBe(0.7)
      expect(capturedBody?.model).toBe('openrouter/free')

      expect(capturedHeaders['Authorization']).toBe('Bearer test-key')
      expect(capturedHeaders['HTTP-Referer']).toBe('https://ai-ide.local')
      expect(capturedHeaders['X-Title']).toBe('AI IDE')
    })

    it('preserves distinct tool call IDs and pairs subsequent tool responses correctly', async () => {
      let capturedBody: any = null

      mockFetch.mockImplementation(async (_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string)
        return new Response(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'Files processed.' } }]
          }),
          { status: 200 }
        )
      })

      const messages: LLMMessage[] = [
        { role: 'user', parts: [{ text: 'Read files' }] },
        {
          role: 'model',
          parts: [
            {
              functionCall: { name: 'read_file', args: { path: 'a.txt' } },
              id: 'call_read_a',
              tool_call_id: 'call_read_a'
            },
            {
              functionCall: { name: 'read_file', args: { path: 'b.txt' } },
              id: 'call_read_b',
              tool_call_id: 'call_read_b'
            }
          ]
        },
        {
          role: 'function',
          parts: [
            {
              tool_call_id: 'call_read_a',
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
              tool_call_id: 'call_read_b',
              functionResponse: {
                name: 'read_file',
                response: { name: 'read_file', content: { text: 'content B' } }
              }
            }
          ]
        }
      ]

      const provider = new OpenRouterProvider({ fetchImpl: mockFetch as unknown as typeof fetch })
      await provider.sendMessage(messages, [], { apiKey: 'test-key' })

      expect(capturedBody).not.toBeNull()
      const formattedMessages = capturedBody.messages

      const assistantMsg = formattedMessages[1]
      expect(assistantMsg.role).toBe('assistant')
      expect(assistantMsg.tool_calls).toHaveLength(2)
      expect(assistantMsg.tool_calls[0].id).toBe('call_read_a')
      expect(assistantMsg.tool_calls[1].id).toBe('call_read_b')

      const toolResponseA = formattedMessages[2]
      expect(toolResponseA.role).toBe('tool')
      expect(toolResponseA.tool_call_id).toBe('call_read_a')
      expect(toolResponseA.content).toContain('content A')

      const toolResponseB = formattedMessages[3]
      expect(toolResponseB.role).toBe('tool')
      expect(toolResponseB.tool_call_id).toBe('call_read_b')
      expect(toolResponseB.content).toContain('content B')
    })

    it('serializes bare non-standard tool responses without producing literal "undefined"', async () => {
      let capturedBody: any = null

      mockFetch.mockImplementation(async (_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string)
        return new Response(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'Done' } }]
          }),
          { status: 200 }
        )
      })

      const messages: LLMMessage[] = [
        {
          role: 'function',
          parts: [
            {
              tool_call_id: 'call_bare',
              functionResponse: {
                name: 'bare_result',
                response: { success: true, count: 5 } as any
              }
            }
          ]
        }
      ]

      const provider = new OpenRouterProvider({ fetchImpl: mockFetch as unknown as typeof fetch })
      await provider.sendMessage(messages, [], { apiKey: 'test-key' })

      const toolMsg = capturedBody.messages[0]
      expect(toolMsg.role).toBe('tool')
      expect(toolMsg.content).not.toBe('undefined')
      expect(toolMsg.content).toContain('"count": 5')
    })

    it('formats tool declarations into OpenAI schema with tool_choice auto', async () => {
      let capturedBody: any = null

      mockFetch.mockImplementation(async (_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string)
        return new Response(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'Ready' } }]
          }),
          { status: 200 }
        )
      })

      const tools: FunctionDeclaration[] = [
        {
          name: 'get_weather',
          description: 'Get weather for location',
          parameters: {
            type: 'object',
            properties: {
              location: { type: 'string', description: 'City name' }
            },
            required: ['location']
          }
        }
      ]

      const provider = new OpenRouterProvider({ fetchImpl: mockFetch as unknown as typeof fetch })
      await provider.sendMessage(
        [{ role: 'user', parts: [{ text: 'What is the weather in Paris?' }] }],
        tools,
        { apiKey: 'test-key' }
      )

      expect(capturedBody).not.toBeNull()
      expect(capturedBody?.tool_choice).toBe('auto')
      const toolsPayload = capturedBody?.tools as any[]
      expect(toolsPayload).toHaveLength(1)
      expect(toolsPayload[0].type).toBe('function')
      expect(toolsPayload[0].function.name).toBe('get_weather')
      expect(toolsPayload[0].function.description).toBe('Get weather for location')
      expect(toolsPayload[0].function.parameters.required).toEqual(['location'])
    })
  })

  describe('Non-Streaming Responses', () => {
    it('parses standard text response and rawModelParts cleanly', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: 'OpenRouter normal response'
                }
              }
            ]
          }),
          { status: 200 }
        )
      )

      const provider = new OpenRouterProvider({ fetchImpl: mockFetch as unknown as typeof fetch })
      const res = await provider.sendMessage(
        [{ role: 'user', parts: [{ text: 'Prompt' }] }],
        [],
        { apiKey: 'test-key' }
      )

      expect(res.text).toBe('OpenRouter normal response')
      expect(res.functionCalls).toBeUndefined()
      expect(res.rawModelParts).toHaveLength(1)
      expect(res.rawModelParts?.[0].text).toBe('OpenRouter normal response')
    })

    it('parses multiple tool calls from choice message into functionCalls and rawModelParts', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: 'Calling two tools:',
                  tool_calls: [
                    {
                      id: 'call_1',
                      type: 'function',
                      function: {
                        name: 'list_files',
                        arguments: '{"relativePath": "src"}'
                      }
                    },
                    {
                      id: 'call_2',
                      type: 'function',
                      function: {
                        name: 'read_file',
                        arguments: '{"path": "src/index.ts"}'
                      }
                    }
                  ]
                }
              }
            ]
          }),
          { status: 200 }
        )
      )

      const provider = new OpenRouterProvider({ fetchImpl: mockFetch as unknown as typeof fetch })
      const res = await provider.sendMessage(
        [{ role: 'user', parts: [{ text: 'List and read' }] }],
        [],
        { apiKey: 'test-key' }
      )

      expect(res.text).toBe('Calling two tools:')
      expect(res.functionCalls).toHaveLength(2)
      expect(res.functionCalls?.[0].name).toBe('list_files')
      expect(res.functionCalls?.[0].args).toEqual({ relativePath: 'src' })
      expect(res.functionCalls?.[1].name).toBe('read_file')
      expect(res.functionCalls?.[1].args).toEqual({ path: 'src/index.ts' })

      // Assistant text and both tool calls preserved in rawModelParts
      expect(res.rawModelParts).toHaveLength(3)
    })

    it('defaults malformed JSON in tool_calls arguments to empty object without throwing', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  tool_calls: [
                    {
                      id: 'call_broken',
                      type: 'function',
                      function: {
                        name: 'broken_tool',
                        arguments: '{"broken": json... invalid'
                      }
                    }
                  ]
                }
              }
            ]
          }),
          { status: 200 }
        )
      )

      const provider = new OpenRouterProvider({ fetchImpl: mockFetch as unknown as typeof fetch })
      const res = await provider.sendMessage(
        [{ role: 'user', parts: [{ text: 'Broken' }] }],
        [],
        { apiKey: 'test-key' }
      )

      expect(res.functionCalls).toHaveLength(1)
      expect(res.functionCalls?.[0].name).toBe('broken_tool')
      expect(res.functionCalls?.[0].args).toEqual({})
    })

    it('throws clean error when provider error payload is returned in 200 response', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: { message: 'Provider model is out of credits' }
          }),
          { status: 200 }
        )
      )

      const provider = new OpenRouterProvider({ fetchImpl: mockFetch as unknown as typeof fetch })
      await expect(
        provider.sendMessage([{ role: 'user', parts: [{ text: 'Prompt' }] }], [], {
          apiKey: 'test-key'
        })
      ).rejects.toThrow('out of credits')
    })

    it('returns fallback text when choices array is empty or message is missing', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [] }), { status: 200 })
      )

      const provider = new OpenRouterProvider({ fetchImpl: mockFetch as unknown as typeof fetch })
      const res = await provider.sendMessage(
        [{ role: 'user', parts: [{ text: 'Empty' }] }],
        [],
        { apiKey: 'test-key' }
      )

      expect(res.text).toBe('No response returned from OpenRouter.')
    })
  })

  describe('SSE Streaming Responses & Chunk Delivery', () => {
    it('delivers text chunks incrementally through onChunk and returns matching final text without duplication', async () => {
      const chunksReceived: string[] = []
      const sseLines = [
        'data: {"id":"1","choices":[{"delta":{"content":"First"}}]}\n\n',
        'data: {"id":"1","choices":[{"delta":{"content":" second"}}]}\n\n',
        'data: {"id":"1","choices":[{"delta":{"content":" third."}}]}\n\n',
        'data: [DONE]\n\n'
      ]

      mockFetch.mockResolvedValueOnce(
        new Response(createMockSseStream(sseLines), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' }
        })
      )

      const provider = new OpenRouterProvider({ fetchImpl: mockFetch as unknown as typeof fetch })
      const res = await provider.sendMessage(
        [{ role: 'user', parts: [{ text: 'Stream me' }] }],
        [],
        {
          apiKey: 'test-key',
          onChunk: (chunk) => {
            chunksReceived.push(chunk)
          }
        }
      )

      expect(chunksReceived).toEqual(['First', ' second', ' third.'])
      expect(res.text).toBe('First second third.')
      expect(res.text).toBe(chunksReceived.join(''))

      // Verify streaming headers and request body flag
      const [, init] = mockFetch.mock.calls[0]
      expect((init.headers as Record<string, string>)['Accept']).toBe('text/event-stream')
      const body = JSON.parse(init.body as string)
      expect(body.stream).toBe(true)
    })

    it('correctly parses SSE events split across reader chunks', async () => {
      const chunksReceived: string[] = []
      const ssePart1 = 'data: {"id":"1","choices":[{"delta":{"content":"Hello'
      const ssePart2 = ' world!"}}]}\n\ndata: [DONE]\n\n'

      mockFetch.mockResolvedValueOnce(
        new Response(createMockSseStream([ssePart1, ssePart2]), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' }
        })
      )

      const provider = new OpenRouterProvider({ fetchImpl: mockFetch as unknown as typeof fetch })
      const res = await provider.sendMessage(
        [{ role: 'user', parts: [{ text: 'Split test' }] }],
        [],
        {
          apiKey: 'test-key',
          onChunk: (chunk) => {
            chunksReceived.push(chunk)
          }
        }
      )

      expect(chunksReceived.join('')).toBe('Hello world!')
      expect(res.text).toBe('Hello world!')
    })

    it('assembles incremental streamed tool calls across multiple delta chunks', async () => {
      const sseLines = [
        'data: {"choices":[{"delta":{"content":"I will inspect files: "}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_dyn_1","type":"function","function":{"name":"read_file","arguments":"{\\"pa"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\": \\"config.json\\"}"}}]}}]}\n\n',
        'data: [DONE]\n\n'
      ]

      mockFetch.mockResolvedValueOnce(
        new Response(createMockSseStream(sseLines), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' }
        })
      )

      const provider = new OpenRouterProvider({ fetchImpl: mockFetch as unknown as typeof fetch })
      const res = await provider.sendMessage(
        [{ role: 'user', parts: [{ text: 'Stream tool' }] }],
        [],
        {
          apiKey: 'test-key',
          onChunk: () => {}
        }
      )

      expect(res.text).toBe('I will inspect files: ')
      expect(res.functionCalls).toHaveLength(1)
      expect(res.functionCalls?.[0].name).toBe('read_file')
      expect(res.functionCalls?.[0].args).toEqual({ path: 'config.json' })
    })

    it('handles stream error event in SSE payload cleanly', async () => {
      const sseLines = [
        'data: {"choices":[{"delta":{"content":"Starting..."}}]}\n\n',
        'data: {"error":{"message":"Context length exceeded during generation"}}\n\n'
      ]

      mockFetch.mockResolvedValueOnce(
        new Response(createMockSseStream(sseLines), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' }
        })
      )

      const provider = new OpenRouterProvider({ fetchImpl: mockFetch as unknown as typeof fetch })
      await expect(
        provider.sendMessage([{ role: 'user', parts: [{ text: 'Prompt' }] }], [], {
          apiKey: 'test-key',
          onChunk: () => {}
        })
      ).rejects.toThrow(/Context length exceeded/i)

      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('handles retryable rate limit error in SSE payload with backoff and exhaustion', async () => {
      vi.useFakeTimers()

      const sseLines = [
        'data: {"choices":[{"delta":{"content":"Starting..."}}]}\n\n',
        'data: {"error":{"message":"Rate limit exceeded during generation"}}\n\n'
      ]

      mockFetch.mockImplementation(async () => {
        return new Response(createMockSseStream(sseLines), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' }
        })
      })

      const onRetry = vi.fn()
      const provider = new OpenRouterProvider({ fetchImpl: mockFetch as unknown as typeof fetch })

      const sendPromise = provider.sendMessage(
        [{ role: 'user', parts: [{ text: 'Prompt' }] }],
        [],
        {
          apiKey: 'test-key',
          onChunk: () => {},
          onRetry
        }
      )

      sendPromise.catch(() => {})
      await vi.runAllTimersAsync()

      await expect(sendPromise).rejects.toThrow(/rate limit/i)
      expect(mockFetch).toHaveBeenCalledTimes(3)
      expect(onRetry).toHaveBeenCalledTimes(2)
    })

    it('flushes trailing buffer line without newline at end of stream', async () => {
      const chunksReceived: string[] = []
      // No trailing newline after last data event
      const sseLine = 'data: {"choices":[{"delta":{"content":"Trailing token"}}]}'

      mockFetch.mockResolvedValueOnce(
        new Response(createMockSseStream([sseLine]), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' }
        })
      )

      const provider = new OpenRouterProvider({ fetchImpl: mockFetch as unknown as typeof fetch })
      const res = await provider.sendMessage(
        [{ role: 'user', parts: [{ text: 'Trailing' }] }],
        [],
        {
          apiKey: 'test-key',
          onChunk: (c) => chunksReceived.push(c)
        }
      )

      expect(chunksReceived).toEqual(['Trailing token'])
      expect(res.text).toBe('Trailing token')
    })
  })

  describe('Cancellation Boundaries', () => {
    it('aborts immediately before making network request when signal is already aborted', async () => {
      const controller = new AbortController()
      controller.abort()

      const provider = new OpenRouterProvider({ fetchImpl: mockFetch as unknown as typeof fetch })

      await expect(
        provider.sendMessage([{ role: 'user', parts: [{ text: 'Cancelled' }] }], [], {
          apiKey: 'test-key',
          signal: controller.signal
        })
      ).rejects.toThrow('Request was stopped by user.')

      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('immediately halts in-flight request and NEVER triggers retries on user abort', async () => {
      const controller = new AbortController()

      mockFetch.mockImplementation(async () => {
        controller.abort()
        const abortErr = new Error('The operation was aborted.')
        abortErr.name = 'AbortError'
        throw abortErr
      })

      const provider = new OpenRouterProvider({ fetchImpl: mockFetch as unknown as typeof fetch })

      await expect(
        provider.sendMessage([{ role: 'user', parts: [{ text: 'Cancel test' }] }], [], {
          apiKey: 'test-key',
          signal: controller.signal
        })
      ).rejects.toThrow('Request was stopped by user.')

      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('immediately halts SSE reader and cancels stream on abort without retry', async () => {
      const controller = new AbortController()
      let streamCancelled = false

      const mockFetchImpl = async () => {
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
              streamController.error(new Error('The operation was aborted'))
            }
          },
          cancel() {
            streamCancelled = true
          }
        })

        return new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' }
        })
      }

      const provider = new OpenRouterProvider({ fetchImpl: mockFetchImpl as unknown as typeof fetch })

      await expect(
        provider.sendMessage([{ role: 'user', parts: [{ text: 'Stream cancel' }] }], [], {
          apiKey: 'test-key',
          signal: controller.signal,
          onChunk: () => {}
        })
      ).rejects.toThrow('Request was stopped by user.')

      expect(streamCancelled).toBe(true)
    })

    it('halts sleep immediately during retry delay without launching subsequent request', async () => {
      const controller = new AbortController()

      mockFetch.mockResolvedValue(
        new Response('{"error": {"message": "Service overloaded"}}', {
          status: 503,
          statusText: 'Service Unavailable'
        })
      )

      const provider = new OpenRouterProvider({ fetchImpl: mockFetch as unknown as typeof fetch })

      await expect(
        provider.sendMessage([{ role: 'user', parts: [{ text: 'Retry cancel' }] }], [], {
          apiKey: 'test-key',
          signal: controller.signal,
          onRetry: () => {
            controller.abort()
          }
        })
      ).rejects.toThrow('Request was stopped by user.')

      expect(mockFetch).toHaveBeenCalledTimes(1)
    })
  })

  describe('Error Handling & Retry Mechanics', () => {
    it('throws user-friendly error without retry on non-retryable 401 Unauthorized', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('{"error": {"message": "Invalid API key"}}', {
          status: 401,
          statusText: 'Unauthorized'
        })
      )

      const provider = new OpenRouterProvider({ fetchImpl: mockFetch as unknown as typeof fetch })

      await expect(
        provider.sendMessage([{ role: 'user', parts: [{ text: 'Auth' }] }], [], {
          apiKey: 'bad-key'
        })
      ).rejects.toThrow(/Invalid OpenRouter API key/)

      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('throws user-friendly error without retry on non-retryable 403 Forbidden', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('{"error": {"message": "Forbidden access"}}', {
          status: 403,
          statusText: 'Forbidden'
        })
      )

      const provider = new OpenRouterProvider({ fetchImpl: mockFetch as unknown as typeof fetch })

      await expect(
        provider.sendMessage([{ role: 'user', parts: [{ text: 'Forbidden' }] }], [], {
          apiKey: 'test-key'
        })
      ).rejects.toThrow(/Invalid OpenRouter API key/)

      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('throws clear message without retry when model does not support tool calling (400)', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: { message: "The model does not support tools or function calling" }
          }),
          {
            status: 400,
            statusText: 'Bad Request'
          }
        )
      )

      const provider = new OpenRouterProvider({ fetchImpl: mockFetch as unknown as typeof fetch })

      await expect(
        provider.sendMessage(
          [{ role: 'user', parts: [{ text: 'Use tool' }] }],
          [{ name: 'test_tool', description: 'test' }],
          { apiKey: 'test-key', modelName: 'simple-model' }
        )
      ).rejects.toThrow(/does not support tool calling/i)

      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('throws model unavailable error without retry on non-retryable 404 Not Found', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('{"error": {"message": "No model found"}}', {
          status: 404,
          statusText: 'Not Found'
        })
      )

      const provider = new OpenRouterProvider({ fetchImpl: mockFetch as unknown as typeof fetch })

      await expect(
        provider.sendMessage([{ role: 'user', parts: [{ text: 'Model' }] }], [], {
          apiKey: 'test-key',
          modelName: 'retired/model'
        })
      ).rejects.toThrow(/was not found or has been deprecated/)

      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('retries on 429 Rate Limit error, respects Retry-After header, and recovers', async () => {
      vi.useFakeTimers()

      const retryCalls: Array<{ attempt: number; maxRetries: number; delayMs: number; reason: string }> = []

      mockFetch
        .mockResolvedValueOnce(
          new Response('{"error": {"message": "Rate limit exceeded"}}', {
            status: 429,
            statusText: 'Too Many Requests',
            headers: { 'Retry-After': '1' }
          })
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              choices: [{ message: { role: 'assistant', content: 'Recovered after rate limit' } }]
            }),
            { status: 200 }
          )
        )

      const provider = new OpenRouterProvider({ fetchImpl: mockFetch as unknown as typeof fetch })

      const sendPromise = provider.sendMessage(
        [{ role: 'user', parts: [{ text: 'Rate limit' }] }],
        [],
        {
          apiKey: 'test-key',
          onRetry: (attempt, maxRetries, delayMs, reason) => {
            retryCalls.push({ attempt, maxRetries, delayMs, reason })
          }
        }
      )

      await vi.runAllTimersAsync()
      const res = await sendPromise

      expect(mockFetch).toHaveBeenCalledTimes(2)
      expect(res.text).toBe('Recovered after rate limit')
      expect(retryCalls).toHaveLength(1)
      expect(retryCalls[0].attempt).toBe(1)
      expect(retryCalls[0].maxRetries).toBe(2)
      expect(retryCalls[0].delayMs).toBe(1000)
    })

    it('retries on temporary server error (502) and recovers on next attempt', async () => {
      vi.useFakeTimers()

      mockFetch
        .mockResolvedValueOnce(
          new Response('Bad Gateway', { status: 502, statusText: 'Bad Gateway' })
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              choices: [{ message: { role: 'assistant', content: 'Success on retry' } }]
            }),
            { status: 200 }
          )
        )

      const provider = new OpenRouterProvider({ fetchImpl: mockFetch as unknown as typeof fetch })

      const sendPromise = provider.sendMessage(
        [{ role: 'user', parts: [{ text: 'Server error' }] }],
        [],
        { apiKey: 'test-key' }
      )

      await vi.runAllTimersAsync()
      const res = await sendPromise

      expect(mockFetch).toHaveBeenCalledTimes(2)
      expect(res.text).toBe('Success on retry')
    })

    it('propagates final error cleanly after MAX_RETRIES (3 total attempts) are exhausted', async () => {
      vi.useFakeTimers()

      mockFetch.mockResolvedValue(
        new Response('{"error": {"message": "Overloaded, try again later"}}', {
          status: 503,
          statusText: 'Service Unavailable'
        })
      )

      const provider = new OpenRouterProvider({ fetchImpl: mockFetch as unknown as typeof fetch })

      const sendPromise = provider.sendMessage(
        [{ role: 'user', parts: [{ text: 'Exhaust' }] }],
        [],
        { apiKey: 'test-key' }
      )

      // Attach catch handler early so unhandled rejection isn't thrown while timers run
      sendPromise.catch(() => {})

      await vi.runAllTimersAsync()

      await expect(sendPromise).rejects.toThrow(/temporarily unavailable/)
      expect(mockFetch).toHaveBeenCalledTimes(3)
    })

    it('retries on request timeout and recovers on subsequent attempt', async () => {
      vi.useFakeTimers()

      let attempts = 0
      mockFetch.mockImplementation((_url: string, init: RequestInit) => {
        attempts++
        if (attempts === 1) {
          return new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              const err = new Error('The operation was aborted.')
              err.name = 'AbortError'
              reject(err)
            })
          })
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [{ message: { role: 'assistant', content: 'Success after timeout' } }]
            }),
            { status: 200 }
          )
        )
      })

      const onRetry = vi.fn()
      const provider = new OpenRouterProvider({
        defaultTimeoutMs: 5000,
        fetchImpl: mockFetch as unknown as typeof fetch
      })

      const sendPromise = provider.sendMessage(
        [{ role: 'user', parts: [{ text: 'Timeout test' }] }],
        [],
        { apiKey: 'test-key', timeoutMs: 2000, onRetry }
      )

      // Advance past timeout (2000ms) and retry backoff delay
      await vi.runAllTimersAsync()
      const res = await sendPromise

      expect(attempts).toBe(2)
      expect(res.text).toBe('Success after timeout')
      expect(onRetry).toHaveBeenCalledTimes(1)
      expect(onRetry).toHaveBeenCalledWith(
        1,
        2,
        expect.any(Number),
        expect.stringMatching(/timeout/i)
      )
    })
  })
})
