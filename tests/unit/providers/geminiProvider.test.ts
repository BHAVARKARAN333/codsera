import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { GeminiProvider, formatGeminiContents } from '@renderer/services/ai/geminiProvider'
import type { LLMMessage, FunctionDeclaration } from '@renderer/services/ai/types'

// Helper to create mock ReadableStream for SSE streaming tests
function createMockSseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let index = 0

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]))
        index++
      } else {
        controller.close()
      }
    }
  })
}

describe('geminiProvider Unit Tests', () => {
  describe('formatGeminiContents', () => {
    it('formats simple user message to Gemini schema', () => {
      const messages: LLMMessage[] = [
        { role: 'user', parts: [{ text: 'Hello Gemini' }] }
      ]
      const formatted = formatGeminiContents(messages)

      expect(formatted).toHaveLength(1)
      expect(formatted[0].role).toBe('user')
      expect(formatted[0].parts[0]).toEqual({ text: 'Hello Gemini' })
    })

    it('merges consecutive function responses into a single user turn', () => {
      const messages: LLMMessage[] = [
        { role: 'user', parts: [{ text: 'List files and read index' }] },
        {
          role: 'model',
          parts: [
            { functionCall: { name: 'list_files', args: {} } },
            { functionCall: { name: 'read_file', args: { path: 'index.ts' } } }
          ]
        },
        {
          role: 'function',
          parts: [
            {
              functionResponse: {
                name: 'list_files',
                response: { name: 'list_files', content: { files: ['index.ts'] } }
              }
            }
          ]
        },
        {
          role: 'function',
          parts: [
            {
              functionResponse: {
                name: 'read_file',
                response: { name: 'read_file', content: { content: 'console.log("hello")' } }
              }
            }
          ]
        }
      ]

      const formatted = formatGeminiContents(messages)

      // Must strictly uphold Gemini's alternating turn contract (user -> model -> user)
      expect(formatted).toHaveLength(3)
      expect(formatted[0].role).toBe('user')
      expect(formatted[1].role).toBe('model')
      expect(formatted[2].role).toBe('user')

      // The two function responses must be merged into the 3rd turn
      expect(formatted[2].parts).toHaveLength(2)
      expect(formatted[2].parts[0]).toEqual({
        functionResponse: {
          name: 'list_files',
          response: { name: 'list_files', content: { files: ['index.ts'] } }
        }
      })
      expect(formatted[2].parts[1]).toEqual({
        functionResponse: {
          name: 'read_file',
          response: { name: 'read_file', content: { content: 'console.log("hello")' } }
        }
      })
    })

    it('formats function calls and preserves thought properties', () => {
      const messages: LLMMessage[] = [
        {
          role: 'model',
          parts: [
            {
              functionCall: { name: 'run_cmd', args: { command: 'npm test' } },
              thought: 'Need to run tests first',
              thoughtSignature: 'sig-123'
            }
          ]
        }
      ]

      const formatted = formatGeminiContents(messages)
      expect(formatted).toHaveLength(1)
      expect(formatted[0].role).toBe('model')
      expect(formatted[0].parts[0]).toEqual({
        functionCall: { name: 'run_cmd', args: { command: 'npm test' } },
        thought: 'Need to run tests first',
        thoughtSignature: 'sig-123'
      })
    })

    it('merges consecutive user turns into a single turn', () => {
      const messages: LLMMessage[] = [
        { role: 'user', parts: [{ text: 'First part' }] },
        { role: 'user', parts: [{ text: 'Second part' }] }
      ]

      const formatted = formatGeminiContents(messages)
      expect(formatted).toHaveLength(1)
      expect(formatted[0].role).toBe('user')
      expect(formatted[0].parts).toHaveLength(2)
    })
  })

  describe('GeminiProvider Class', () => {
    let mockFetch: ReturnType<typeof vi.fn>

    beforeEach(() => {
      mockFetch = vi.fn()
    })

    afterEach(() => {
      vi.restoreAllMocks()
      vi.useRealTimers()
    })

    describe('Instantiation & Configuration', () => {
      it('has correct default properties and capabilities', () => {
        const provider = new GeminiProvider()
        expect(provider.id).toBe('gemini')
        expect(provider.name).toBe('Google Gemini')
        expect(provider.capabilities).toEqual({
          supportsStreaming: true,
          supportsTools: true,
          requiresApiKey: true,
          supportsModelListing: false
        })
      })

      it('respects custom model and timeout config', () => {
        const provider = new GeminiProvider({
          defaultModel: 'gemini-1.5-pro',
          defaultTimeoutMs: 45000,
          fetchImpl: mockFetch as unknown as typeof fetch
        })
        expect(provider).toBeDefined()
      })
    })

    describe('Non-Streaming Requests', () => {
      it('throws immediately if API key is missing or blank', async () => {
        const provider = new GeminiProvider({ fetchImpl: mockFetch as unknown as typeof fetch })

        await expect(
          provider.sendMessage([{ role: 'user', parts: [{ text: 'Hi' }] }], [], { apiKey: '' })
        ).rejects.toThrow('Gemini API key is not configured')

        await expect(
          provider.sendMessage([{ role: 'user', parts: [{ text: 'Hi' }] }], [], { apiKey: '   ' })
        ).rejects.toThrow('Gemini API key is not configured')

        expect(mockFetch).not.toHaveBeenCalled()
      })

      it('sends correctly configured POST request and parses text response', async () => {
        const fakeResponse = {
          candidates: [
            {
              content: {
                parts: [{ text: 'Hello from Gemini!' }]
              }
            }
          ]
        }

        mockFetch.mockResolvedValueOnce(
          new Response(JSON.stringify(fakeResponse), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          })
        )

        const provider = new GeminiProvider({ fetchImpl: mockFetch as unknown as typeof fetch })
        const response = await provider.sendMessage(
          [{ role: 'user', parts: [{ text: 'Hi' }] }],
          [],
          {
            apiKey: 'test-key-123',
            modelName: 'gemini-3.8-flash',
            systemInstruction: 'You are an AI assistant',
            temperature: 0.5
          }
        )

        expect(mockFetch).toHaveBeenCalledTimes(1)
        const [url, init] = mockFetch.mock.calls[0]
        expect(url).toContain('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?')
        expect(url).toContain('key=test-key-123')
        expect(init.method).toBe('POST')

        const body = JSON.parse(init.body)
        expect(body.systemInstruction).toEqual({ parts: [{ text: 'You are an AI assistant' }] })
        expect(body.generationConfig).toEqual({ temperature: 0.5 })
        expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'Hi' }] }])

        expect(response.text).toBe('Hello from Gemini!')
        expect(response.functionCalls).toBeUndefined()
      })

      it('parses function calls from model response', async () => {
        const fakeResponse = {
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: {
                      name: 'read_file',
                      args: { path: 'src/main.ts' }
                    }
                  }
                ]
              }
            }
          ]
        }

        mockFetch.mockResolvedValueOnce(
          new Response(JSON.stringify(fakeResponse), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          })
        )

        const tools: FunctionDeclaration[] = [
          {
            name: 'read_file',
            description: 'Reads file content',
            parameters: {
              type: 'object',
              properties: { path: { type: 'string' } },
              required: ['path']
            }
          }
        ]

        const provider = new GeminiProvider({ fetchImpl: mockFetch as unknown as typeof fetch })
        const response = await provider.sendMessage(
          [{ role: 'user', parts: [{ text: 'Read main.ts' }] }],
          tools,
          { apiKey: 'test-key' }
        )

        expect(response.functionCalls).toHaveLength(1)
        expect(response.functionCalls?.[0]).toEqual({
          name: 'read_file',
          args: { path: 'src/main.ts' }
        })
      })

      it('isolates reasoning thoughts from user-visible response text', async () => {
        const fakeResponse = {
          candidates: [
            {
              content: {
                parts: [
                  { text: 'Internal reasoning here...', thought: true },
                  { text: 'Final answer to user.' }
                ]
              }
            }
          ]
        }

        mockFetch.mockResolvedValueOnce(
          new Response(JSON.stringify(fakeResponse), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          })
        )

        const provider = new GeminiProvider({ fetchImpl: mockFetch as unknown as typeof fetch })
        const response = await provider.sendMessage(
          [{ role: 'user', parts: [{ text: 'Explain x' }] }],
          [],
          { apiKey: 'test-key' }
        )

        expect(response.text).toBe('Final answer to user.')
        expect(response.text).not.toContain('Internal reasoning')
        expect(response.rawModelParts).toHaveLength(2)
      })

      it('throws when prompt is blocked by safety filters', async () => {
        const fakeResponse = {
          promptFeedback: {
            blockReason: 'SAFETY'
          }
        }

        mockFetch.mockResolvedValueOnce(
          new Response(JSON.stringify(fakeResponse), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          })
        )

        const provider = new GeminiProvider({ fetchImpl: mockFetch as unknown as typeof fetch })
        await expect(
          provider.sendMessage([{ role: 'user', parts: [{ text: 'blocked query' }] }], [], { apiKey: 'key' })
        ).rejects.toThrow('Prompt was blocked: SAFETY')
      })
    })

    describe('Streaming Requests', () => {
      it('connects to streamGenerateContent SSE endpoint and delivers chunks incrementally', async () => {
        const sseChunks = [
          'data: {"candidates":[{"content":{"parts":[{"text":"Chunk 1"}]}}]}\n\n',
          'data: {"candidates":[{"content":{"parts":[{"text":" and Chunk 2"}]}}]}\n\n',
          'data: [DONE]\n\n'
        ]

        const stream = createMockSseStream(sseChunks)
        mockFetch.mockResolvedValueOnce(
          new Response(stream, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' }
          })
        )

        const deliveredChunks: string[] = []
        const provider = new GeminiProvider({ fetchImpl: mockFetch as unknown as typeof fetch })

        const response = await provider.sendMessage(
          [{ role: 'user', parts: [{ text: 'Stream me' }] }],
          [],
          {
            apiKey: 'test-key',
            onChunk: (chunk) => deliveredChunks.push(chunk)
          }
        )

        expect(mockFetch).toHaveBeenCalledTimes(1)
        const [url] = mockFetch.mock.calls[0]
        expect(url).toContain('streamGenerateContent?alt=sse&')

        expect(deliveredChunks).toEqual(['Chunk 1', ' and Chunk 2'])
        expect(response.text).toBe('Chunk 1 and Chunk 2')
      })

      it('suppresses thought parts from streaming onChunk callback', async () => {
        const sseChunks = [
          'data: {"candidates":[{"content":{"parts":[{"text":"Thinking step...", "thought": true}]}}]}\n\n',
          'data: {"candidates":[{"content":{"parts":[{"text":"Visible output"}]}}]}\n\n'
        ]

        const stream = createMockSseStream(sseChunks)
        mockFetch.mockResolvedValueOnce(
          new Response(stream, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' }
          })
        )

        const deliveredChunks: string[] = []
        const provider = new GeminiProvider({ fetchImpl: mockFetch as unknown as typeof fetch })

        const response = await provider.sendMessage(
          [{ role: 'user', parts: [{ text: 'Think and speak' }] }],
          [],
          {
            apiKey: 'test-key',
            onChunk: (chunk) => deliveredChunks.push(chunk)
          }
        )

        expect(deliveredChunks).toEqual(['Visible output'])
        expect(response.text).toBe('Visible output')
      })
    })

    describe('Cancellation Boundaries', () => {
      it('aborts immediately if AbortSignal is already cancelled', async () => {
        const controller = new AbortController()
        controller.abort()

        const provider = new GeminiProvider({ fetchImpl: mockFetch as unknown as typeof fetch })

        await expect(
          provider.sendMessage(
            [{ role: 'user', parts: [{ text: 'Hi' }] }],
            [],
            { apiKey: 'test-key', signal: controller.signal }
          )
        ).rejects.toThrow('Request was stopped by user.')

        expect(mockFetch).not.toHaveBeenCalled()
      })

      it('cancels in-flight request when signal is triggered', async () => {
        const controller = new AbortController()

        mockFetch.mockImplementationOnce((_url, init) => {
          return new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              const err = new Error('The operation was aborted')
              err.name = 'AbortError'
              reject(err)
            })
          })
        })

        const provider = new GeminiProvider({ fetchImpl: mockFetch as unknown as typeof fetch })
        const sendPromise = provider.sendMessage(
          [{ role: 'user', parts: [{ text: 'Cancel me' }] }],
          [],
          { apiKey: 'test-key', signal: controller.signal }
        )

        controller.abort()

        await expect(sendPromise).rejects.toThrow('Request was stopped by user.')
      })
    })

    describe('Error Handling & Retry Behavior', () => {
      it('throws immediately on 400 Bad Request without retrying', async () => {
        mockFetch.mockResolvedValueOnce(
          new Response(JSON.stringify({ error: { message: 'Invalid field parameter' } }), {
            status: 400,
            statusText: 'Bad Request',
            headers: { 'Content-Type': 'application/json' }
          })
        )

        const onRetry = vi.fn()
        const provider = new GeminiProvider({ fetchImpl: mockFetch as unknown as typeof fetch })

        await expect(
          provider.sendMessage(
            [{ role: 'user', parts: [{ text: 'Invalid' }] }],
            [],
            { apiKey: 'test-key', onRetry }
          )
        ).rejects.toThrow()

        expect(mockFetch).toHaveBeenCalledTimes(1)
        expect(onRetry).not.toHaveBeenCalled()
      })

      it('retries on 429 Rate Limit error with exponential backoff', async () => {
        vi.useFakeTimers()

        mockFetch
          .mockResolvedValueOnce(
            new Response(JSON.stringify({ error: { message: 'Resource exhausted' } }), {
              status: 429,
              statusText: 'Too Many Requests',
              headers: { 'Content-Type': 'application/json' }
            })
          )
          .mockResolvedValueOnce(
            new Response(
              JSON.stringify({
                candidates: [{ content: { parts: [{ text: 'Success after retry' }] } }]
              }),
              {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
              }
            )
          )

        const onRetry = vi.fn()
        const provider = new GeminiProvider({ fetchImpl: mockFetch as unknown as typeof fetch })

        const sendPromise = provider.sendMessage(
          [{ role: 'user', parts: [{ text: 'Retry me' }] }],
          [],
          { apiKey: 'test-key', onRetry }
        )

        // Advance timers to trigger backoff delay
        await vi.runAllTimersAsync()

        const response = await sendPromise

        expect(mockFetch).toHaveBeenCalledTimes(2)
        expect(onRetry).toHaveBeenCalledTimes(1)
        expect(onRetry).toHaveBeenCalledWith(1, 2, expect.any(Number), expect.stringContaining('Resource exhausted'))
        expect(response.text).toBe('Success after retry')
      })
    })
  })
})
