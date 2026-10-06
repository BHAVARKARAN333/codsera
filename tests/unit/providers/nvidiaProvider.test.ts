import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NvidiaProvider } from '@renderer/services/ai/nvidiaProvider'
import type { FunctionDeclaration, LLMMessage } from '@renderer/services/ai/types'
import type { NvidiaChatCompletionRequest } from '@shared/types'
import { setupMockElectron, resetMockElectron } from '../../setup/electronMock'

describe('NvidiaProvider Unit Tests', () => {
  beforeEach(() => {
    resetMockElectron()
  })

  afterEach(() => {
    resetMockElectron()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  describe('Capabilities, Configuration & Validation', () => {
    it('initializes with correct provider metadata and capabilities', () => {
      const provider = new NvidiaProvider()

      expect(provider.id).toBe('nvidia')
      expect(provider.name).toBe('NVIDIA NIM')
      expect(provider.capabilities).toEqual({
        supportsStreaming: false,
        supportsTools: true,
        requiresApiKey: true,
        supportsModelListing: true
      })
    })

    it('respects custom constructor options and setDebug method', async () => {
      let capturedReq: any = null
      const provider = new NvidiaProvider({
        defaultModel: 'meta/llama-3.1-8b-instruct',
        defaultTimeoutMs: 15000,
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
        { apiKey: 'nvapi-test' }
      )

      expect(res.text).toBe('Debug response')
      expect(capturedReq).not.toBeNull()
      expect(capturedReq.model).toBe('meta/llama-3.1-8b-instruct')
      expect(capturedReq.timeoutMs).toBe(15000)
      expect(consoleDebugSpy).toHaveBeenCalled()

      // Toggling setDebug(false) suppresses debug output
      consoleDebugSpy.mockClear()
      provider.setDebug(false)
      await provider.sendMessage(
        [{ role: 'user', parts: [{ text: 'Hello 2' }] }],
        [],
        { apiKey: 'nvapi-test' }
      )
      expect(consoleDebugSpy).not.toHaveBeenCalled()
    })

    it('throws error when API key is missing or whitespace without invoking IPC', async () => {
      const ipcCaller = vi.fn()
      const provider = new NvidiaProvider({
        defaultModel: 'meta/llama-3.1-8b-instruct',
        ipcCaller
      })

      await expect(
        provider.sendMessage([{ role: 'user', parts: [{ text: 'Hi' }] }], [], { apiKey: '' })
      ).rejects.toThrow('NVIDIA NIM API key is not configured. Please provide a valid API key in Settings.')

      await expect(
        provider.sendMessage([{ role: 'user', parts: [{ text: 'Hi' }] }], [], { apiKey: '   ' })
      ).rejects.toThrow('NVIDIA NIM API key is not configured. Please provide a valid API key in Settings.')

      expect(ipcCaller).not.toHaveBeenCalled()
    })

    it('throws error when model name is missing and no default model is configured', async () => {
      const ipcCaller = vi.fn()
      const provider = new NvidiaProvider({ ipcCaller })

      await expect(
        provider.sendMessage([{ role: 'user', parts: [{ text: 'Hi' }] }], [], {
          apiKey: 'nvapi-test',
          modelName: ''
        })
      ).rejects.toThrow('No NVIDIA NIM model configured. Please open Settings, fetch available models, and select one.')

      await expect(
        provider.sendMessage([{ role: 'user', parts: [{ text: 'Hi' }] }], [], {
          apiKey: 'nvapi-test',
          modelName: '   '
        })
      ).rejects.toThrow('No NVIDIA NIM model configured. Please open Settings, fetch available models, and select one.')

      expect(ipcCaller).not.toHaveBeenCalled()
    })

    it('uses custom modelName over constructor defaultModel when specified', async () => {
      let capturedReq: any = null
      const provider = new NvidiaProvider({
        defaultModel: 'meta/llama-3.1-8b-instruct',
        ipcCaller: async (req) => {
          capturedReq = req
          return {
            success: true,
            data: { choices: [{ message: { role: 'assistant', content: 'OK' } }] }
          }
        }
      })

      await provider.sendMessage([{ role: 'user', parts: [{ text: 'Hi' }] }], [], {
        apiKey: 'nvapi-test',
        modelName: 'nvidia/llama-3.1-nemotron-70b-instruct'
      })

      expect(capturedReq.model).toBe('nvidia/llama-3.1-nemotron-70b-instruct')
    })
  })

  describe('Request Payload and Message/Tool Formatting', () => {
    it('formats system instruction, user text, and assistant turns into OpenAI schema', async () => {
      let capturedReq: any = null
      const provider = new NvidiaProvider({
        ipcCaller: async (req) => {
          capturedReq = req
          return {
            success: true,
            data: { choices: [{ message: { role: 'assistant', content: 'Hello!' } }] }
          }
        }
      })

      const messages: LLMMessage[] = [
        { role: 'user', parts: [{ text: 'Hi NVIDIA' }] },
        { role: 'model', parts: [{ text: 'Hello human' }] },
        { role: 'user', parts: [{ text: 'Next question' }] }
      ]

      const resp = await provider.sendMessage(messages, [], {
        apiKey: 'nvapi-test-key',
        modelName: 'meta/llama-3.1-70b-instruct',
        systemInstruction: 'Be a helpful coding assistant.',
        temperature: 0.7,
        timeoutMs: 25000
      })

      expect(resp.text).toBe('Hello!')
      expect(capturedReq).not.toBeNull()
      expect(capturedReq.model).toBe('meta/llama-3.1-70b-instruct')
      expect(capturedReq.apiKey).toBe('nvapi-test-key')
      expect(capturedReq.temperature).toBe(0.7)
      expect(capturedReq.timeoutMs).toBe(25000)
      expect(capturedReq.requestId).toMatch(/^nvidia_\d+_[a-z0-9]+_att0$/)

      expect(capturedReq.messages).toHaveLength(4)
      expect(capturedReq.messages[0]).toEqual({ role: 'system', content: 'Be a helpful coding assistant.' })
      expect(capturedReq.messages[1]).toEqual({ role: 'user', content: 'Hi NVIDIA' })
      expect(capturedReq.messages[2]).toEqual({ role: 'assistant', content: 'Hello human' })
      expect(capturedReq.messages[3]).toEqual({ role: 'user', content: 'Next question' })
    })

    it('correctly pairs multiple tool calls with distinct tool results and IDs', async () => {
      let capturedReq: any = null
      const provider = new NvidiaProvider({
        ipcCaller: async (req) => {
          capturedReq = req
          return {
            success: true,
            data: { choices: [{ message: { role: 'assistant', content: 'All done' } }] }
          }
        }
      })

      const messages: LLMMessage[] = [
        { role: 'user', parts: [{ text: 'Read two files' }] },
        {
          role: 'model',
          parts: [
            {
              id: 'call_101',
              tool_call_id: 'call_101',
              functionCall: { name: 'read_file', args: { path: 'a.txt' } }
            },
            {
              id: 'call_102',
              tool_call_id: 'call_102',
              functionCall: { name: 'read_file', args: { path: 'b.txt' } }
            }
          ]
        },
        {
          role: 'function',
          parts: [
            {
              tool_call_id: 'call_101',
              functionResponse: { name: 'read_file', response: { name: 'read_file', content: { data: 'Content A' } } }
            }
          ]
        },
        {
          role: 'function',
          parts: [
            {
              tool_call_id: 'call_102',
              functionResponse: { name: 'read_file', response: { name: 'read_file', content: { data: 'Content B' } } }
            }
          ]
        }
      ]

      await provider.sendMessage(messages, [], {
        apiKey: 'nvapi-test',
        modelName: 'meta/llama-3.1-70b-instruct'
      })

      expect(capturedReq).not.toBeNull()
      const assistantMsg = capturedReq.messages.find((m: any) => m.role === 'assistant')
      expect(assistantMsg).toBeDefined()
      expect(assistantMsg.tool_calls).toHaveLength(2)
      expect(assistantMsg.tool_calls[0].id).toBe('call_101')
      expect(assistantMsg.tool_calls[1].id).toBe('call_102')

      const toolMsgs = capturedReq.messages.filter((m: any) => m.role === 'tool')
      expect(toolMsgs).toHaveLength(2)
      expect(toolMsgs[0].tool_call_id).toBe('call_101')
      expect(toolMsgs[0].content).toContain('Content A')
      expect(toolMsgs[1].tool_call_id).toBe('call_102')
      expect(toolMsgs[1].content).toContain('Content B')
    })

    it('formats tool declarations into OpenAI schema with tool_choice auto', async () => {
      let capturedReq: any = null
      const provider = new NvidiaProvider({
        ipcCaller: async (req) => {
          capturedReq = req
          return {
            success: true,
            data: { choices: [{ message: { role: 'assistant', content: 'Tools configured' } }] }
          }
        }
      })

      const tools: FunctionDeclaration[] = [
        {
          name: 'get_gpu_info',
          description: 'Get GPU telemetry information',
          parameters: {
            type: 'object',
            properties: { deviceId: { type: 'number' } },
            required: ['deviceId']
          }
        }
      ]

      await provider.sendMessage([{ role: 'user', parts: [{ text: 'Check GPU' }] }], tools, {
        apiKey: 'nvapi-test',
        modelName: 'meta/llama-3.1-70b-instruct'
      })

      expect(capturedReq.tool_choice).toBe('auto')
      expect(capturedReq.tools).toHaveLength(1)
      expect(capturedReq.tools[0].type).toBe('function')
      expect(capturedReq.tools[0].function.name).toBe('get_gpu_info')
      expect(capturedReq.tools[0].function.parameters.required).toEqual(['deviceId'])
    })
  })

  describe('Response Parsing & Tool-Call Handling', () => {
    it('parses text responses and rawModelParts cleanly', async () => {
      const provider = new NvidiaProvider({
        ipcCaller: async () => ({
          success: true,
          data: {
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: 'NVIDIA NIM response text'
                }
              }
            ]
          }
        })
      })

      const res = await provider.sendMessage(
        [{ role: 'user', parts: [{ text: 'Prompt' }] }],
        [],
        { apiKey: 'nvapi-test', modelName: 'meta/llama-3.1-70b-instruct' }
      )

      expect(res.text).toBe('NVIDIA NIM response text')
      expect(res.functionCalls).toBeUndefined()
      expect(res.rawModelParts).toHaveLength(1)
      expect(res.rawModelParts?.[0].text).toBe('NVIDIA NIM response text')
    })

    it('parses multiple tool calls from choice message into functionCalls and rawModelParts', async () => {
      const provider = new NvidiaProvider({
        ipcCaller: async () => ({
          success: true,
          data: {
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: 'Running tools',
                  tool_calls: [
                    {
                      id: 'call_1',
                      type: 'function',
                      function: {
                        name: 'query_db',
                        arguments: '{"table": "users"}'
                      }
                    },
                    {
                      id: 'call_2',
                      type: 'function',
                      function: {
                        name: 'fetch_profile',
                        arguments: '{"userId": 42}'
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
        [{ role: 'user', parts: [{ text: 'Query user' }] }],
        [],
        { apiKey: 'nvapi-test', modelName: 'meta/llama-3.1-70b-instruct' }
      )

      expect(res.text).toBe('Running tools')
      expect(res.functionCalls).toHaveLength(2)
      expect(res.functionCalls?.[0].name).toBe('query_db')
      expect(res.functionCalls?.[0].args).toEqual({ table: 'users' })
      expect(res.functionCalls?.[1].name).toBe('fetch_profile')
      expect(res.functionCalls?.[1].args).toEqual({ userId: 42 })

      expect(res.rawModelParts).toHaveLength(3)
      expect(res.rawModelParts?.[0].id).toBe('call_1')
      expect(res.rawModelParts?.[1].id).toBe('call_2')
      expect(res.rawModelParts?.[2].text).toBe('Running tools')
    })

    it('defaults malformed JSON in tool_calls arguments to empty object without throwing', async () => {
      const provider = new NvidiaProvider({
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
                        arguments: 'broken JSON {'
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
        [{ role: 'user', parts: [{ text: 'Broken tool' }] }],
        [],
        { apiKey: 'nvapi-test', modelName: 'meta/llama-3.1-70b-instruct' }
      )

      expect(res.functionCalls).toHaveLength(1)
      expect(res.functionCalls?.[0].name).toBe('broken_func')
      expect(res.functionCalls?.[0].args).toEqual({})
    })

    it('returns fallback text when choices array is empty or message is missing', async () => {
      const provider = new NvidiaProvider({
        ipcCaller: async () => ({
          success: true,
          data: { choices: [] }
        })
      })

      const res = await provider.sendMessage(
        [{ role: 'user', parts: [{ text: 'Empty' }] }],
        [],
        { apiKey: 'nvapi-test', modelName: 'meta/llama-3.1-70b-instruct' }
      )

      expect(res.text).toBe('No response returned from NVIDIA NIM.')
    })

    it('completes normally when onChunk is provided without attempting streaming deltas', async () => {
      const chunksEmitted: string[] = []
      const provider = new NvidiaProvider({
        ipcCaller: async () => ({
          success: true,
          data: {
            choices: [{ message: { role: 'assistant', content: 'Completed response without streaming' } }]
          }
        })
      })

      const res = await provider.sendMessage(
        [{ role: 'user', parts: [{ text: 'Prompt' }] }],
        [],
        {
          apiKey: 'nvapi-test',
          modelName: 'meta/llama-3.1-70b-instruct',
          onChunk: (c) => chunksEmitted.push(c)
        }
      )

      expect(res.text).toBe('Completed response without streaming')
      // Since capabilities.supportsStreaming is false, chunks are not emitted incrementally
      expect(chunksEmitted).toEqual([])
    })
  })

  describe('IPC Execution & Direct Fetch Fallback', () => {
    it('executes via window.electronAPI.nvidiaChatCompletion when electronAPI is available', async () => {
      let electronApiCalled = false
      setupMockElectron({
        nvidiaChatCompletion: async (req: NvidiaChatCompletionRequest) => {
          electronApiCalled = true
          expect(req.apiKey).toBe('nvapi-electron')
          return {
            success: true,
            data: { choices: [{ message: { role: 'assistant', content: 'Electron IPC Response' } }] }
          }
        }
      })

      const provider = new NvidiaProvider()
      const res = await provider.sendMessage(
        [{ role: 'user', parts: [{ text: 'Hello Electron' }] }],
        [],
        { apiKey: 'nvapi-electron', modelName: 'meta/llama-3.1-8b-instruct' }
      )

      expect(electronApiCalled).toBe(true)
      expect(res.text).toBe('Electron IPC Response')
    })

    it('returns clear error when window is defined but nvidiaChatCompletion IPC handler is missing', async () => {
      // Mock window without nvidiaChatCompletion
      const globalTarget = globalThis as unknown as { window?: Record<string, unknown> }
      const originalWindow = globalTarget.window
      globalTarget.window = { electronAPI: {} }

      try {
        const provider = new NvidiaProvider()
        await expect(
          provider.sendMessage([{ role: 'user', parts: [{ text: 'Test' }] }], [], {
            apiKey: 'nvapi-test',
            modelName: 'meta/llama-3.1-8b-instruct'
          })
        ).rejects.toThrow(/window\.electronAPI\.nvidiaChatCompletion is undefined/i)
      } finally {
        globalTarget.window = originalWindow
      }
    })

    it('executes via direct fetch fallback when fetchImpl is provided', async () => {
      let capturedUrl = ''
      let capturedBody: any = null
      let capturedHeaders: any = null

      const mockFetch = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
        capturedUrl = url
        capturedBody = JSON.parse(init.body as string)
        capturedHeaders = init.headers
        return new Response(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'Direct fetch reply' } }]
          }),
          { status: 200 }
        )
      })

      const provider = new NvidiaProvider({
        fetchImpl: mockFetch as unknown as typeof fetch
      })

      const res = await provider.sendMessage(
        [{ role: 'user', parts: [{ text: 'Fetch prompt' }] }],
        [],
        { apiKey: 'nvapi-direct', modelName: 'meta/llama-3.1-70b-instruct' }
      )

      expect(res.text).toBe('Direct fetch reply')
      expect(capturedUrl).toBe('https://integrate.api.nvidia.com/v1/chat/completions')
      expect(capturedHeaders['Authorization']).toBe('Bearer nvapi-direct')
      expect(capturedHeaders['Content-Type']).toBe('application/json')
      expect(capturedBody.model).toBe('meta/llama-3.1-70b-instruct')
      expect(capturedBody.messages).toHaveLength(1)
    })
  })

  describe('Cancellation Boundaries', () => {
    it('aborts immediately before making request when signal is already aborted', async () => {
      const controller = new AbortController()
      controller.abort()

      const ipcCaller = vi.fn()
      const provider = new NvidiaProvider({ ipcCaller })

      await expect(
        provider.sendMessage([{ role: 'user', parts: [{ text: 'Hi' }] }], [], {
          apiKey: 'nvapi-test',
          modelName: 'meta/llama-3.1-70b-instruct',
          signal: controller.signal
        })
      ).rejects.toThrow('Request was stopped by user.')

      expect(ipcCaller).not.toHaveBeenCalled()
    })

    it('in-flight cancellation calls cancelChatCompletion(requestId) and throws without retry', async () => {
      let callCount = 0
      let cancelledRequestId: string | null = null

      setupMockElectron({
        cancelChatCompletion: async (reqId: string) => {
          cancelledRequestId = reqId
          return { success: true, canceled: true }
        }
      })

      const controller = new AbortController()
      let requestCaptured: any = null

      const provider = new NvidiaProvider({
        ipcCaller: async (req) => {
          callCount++
          requestCaptured = req
          controller.abort() // Trigger abort while request is in flight
          return {
            success: false,
            error: 'Request was stopped by user.',
            errorDetails: 'Request was stopped by user.',
            stage: 'cancelled'
          }
        }
      })

      await expect(
        provider.sendMessage([{ role: 'user', parts: [{ text: 'Cancel test' }] }], [], {
          apiKey: 'nvapi-test',
          modelName: 'meta/llama-3.1-70b-instruct',
          signal: controller.signal
        })
      ).rejects.toThrow('Request was stopped by user.')

      expect(callCount).toBe(1)
      expect(requestCaptured).not.toBeNull()
      expect(cancelledRequestId).toBe(requestCaptured.requestId)
      expect(cancelledRequestId).toMatch(/^nvidia_\d+_[a-z0-9]+_att0$/)
    })

    it('cancels during retry delay sleep immediately without launching subsequent attempts', async () => {
      let attempts = 0
      const controller = new AbortController()

      const provider = new NvidiaProvider({
        ipcCaller: async () => {
          attempts++
          return {
            success: false,
            status: 503,
            error: 'Service Unavailable'
          }
        }
      })

      const sendPromise = provider.sendMessage(
        [{ role: 'user', parts: [{ text: 'Retry abort' }] }],
        [],
        {
          apiKey: 'nvapi-test',
          modelName: 'meta/llama-3.1-70b-instruct',
          signal: controller.signal,
          onRetry: () => {
            // Abort during backoff sleep
            controller.abort()
          }
        }
      )

      await expect(sendPromise).rejects.toThrow('Request was stopped by user.')
      expect(attempts).toBe(1)
    })

    it('direct fetch halts immediately when signal is aborted in flight', async () => {
      const controller = new AbortController()

      const mockFetch = vi.fn().mockImplementation(async (_url: string, _init: RequestInit) => {
        controller.abort()
        const abortErr = new Error('The operation was aborted.')
        abortErr.name = 'AbortError'
        throw abortErr
      })

      const provider = new NvidiaProvider({
        fetchImpl: mockFetch as unknown as typeof fetch
      })

      await expect(
        provider.sendMessage([{ role: 'user', parts: [{ text: 'Cancel fetch' }] }], [], {
          apiKey: 'nvapi-test',
          modelName: 'meta/llama-3.1-70b-instruct',
          signal: controller.signal
        })
      ).rejects.toThrow('Request was stopped by user.')

      expect(mockFetch).toHaveBeenCalledTimes(1)
    })
  })

  describe('Error Handling, Classification & Retries', () => {
    it('throws user-friendly error without retry on non-retryable 401 Unauthorized', async () => {
      let callCount = 0
      const provider = new NvidiaProvider({
        ipcCaller: async () => {
          callCount++
          return {
            success: false,
            status: 401,
            error: 'Unauthorized',
            errorDetails: 'Invalid NVIDIA API key'
          }
        }
      })

      await expect(
        provider.sendMessage([{ role: 'user', parts: [{ text: 'Auth' }] }], [], {
          apiKey: 'bad-key',
          modelName: 'meta/llama-3.1-70b-instruct'
        })
      ).rejects.toThrow(/Invalid NVIDIA NIM API key/i)

      expect(callCount).toBe(1)
    })

    it('throws user-friendly error without retry on non-retryable 404 Model Not Found', async () => {
      let callCount = 0
      const provider = new NvidiaProvider({
        ipcCaller: async () => {
          callCount++
          return {
            success: false,
            status: 404,
            error: 'Model not found'
          }
        }
      })

      await expect(
        provider.sendMessage([{ role: 'user', parts: [{ text: 'Model' }] }], [], {
          apiKey: 'nvapi-test',
          modelName: 'retired/model'
        })
      ).rejects.toThrow(/was not found or has been deprecated/i)

      expect(callCount).toBe(1)
    })

    it('throws user-friendly error without retry when model does not support tool calling (400)', async () => {
      let callCount = 0
      const provider = new NvidiaProvider({
        ipcCaller: async () => {
          callCount++
          return {
            success: false,
            status: 400,
            error: 'The model does not support tools or function calling'
          }
        }
      })

      await expect(
        provider.sendMessage(
          [{ role: 'user', parts: [{ text: 'Tools' }] }],
          [{ name: 'sample_tool', description: 'desc' }],
          {
            apiKey: 'nvapi-test',
            modelName: 'simple-model'
          }
        )
      ).rejects.toThrow(/does not support tool calling/i)

      expect(callCount).toBe(1)
    })

    it('retries on 429 Rate Limit error, respects retryAfter header, and recovers', async () => {
      vi.useFakeTimers()
      let attempts = 0
      let reportedDelay = 0

      const provider = new NvidiaProvider({
        ipcCaller: async () => {
          attempts++
          if (attempts === 1) {
            return {
              success: false,
              status: 429,
              error: 'Rate limit exceeded',
              retryAfter: 1 // 1 second
            }
          }
          return {
            success: true,
            data: { choices: [{ message: { role: 'assistant', content: 'Recovered from 429' } }] }
          }
        }
      })

      const sendPromise = provider.sendMessage(
        [{ role: 'user', parts: [{ text: 'Rate limit' }] }],
        [],
        {
          apiKey: 'nvapi-test',
          modelName: 'meta/llama-3.1-70b-instruct',
          onRetry: (_att, _max, delay) => {
            reportedDelay = delay
          }
        }
      )

      await vi.runAllTimersAsync()
      const res = await sendPromise

      expect(res.text).toBe('Recovered from 429')
      expect(attempts).toBe(2)
      expect(reportedDelay).toBe(1000)
    })

    it('retries on temporary 502/503 server errors with exponential backoff and succeeds', async () => {
      vi.useFakeTimers()
      let attempts = 0

      const provider = new NvidiaProvider({
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
        { apiKey: 'nvapi-test', modelName: 'meta/llama-3.1-70b-instruct' }
      )

      await vi.runAllTimersAsync()
      const res = await sendPromise

      expect(attempts).toBe(2)
      expect(res.text).toBe('Success on retry')
    })

    it('retries on network/connection errors (e.g. ECONNRESET) and succeeds', async () => {
      vi.useFakeTimers()
      let attempts = 0

      const provider = new NvidiaProvider({
        ipcCaller: async () => {
          attempts++
          if (attempts === 1) {
            return {
              success: false,
              isNetworkError: true,
              error: 'Network error: ECONNRESET'
            }
          }
          return {
            success: true,
            data: { choices: [{ message: { role: 'assistant', content: 'Recovered after network blip' } }] }
          }
        }
      })

      const sendPromise = provider.sendMessage(
        [{ role: 'user', parts: [{ text: 'Network blip' }] }],
        [],
        { apiKey: 'nvapi-test', modelName: 'meta/llama-3.1-70b-instruct' }
      )

      await vi.runAllTimersAsync()
      const res = await sendPromise

      expect(attempts).toBe(2)
      expect(res.text).toBe('Recovered after network blip')
    })

    it('propagates final error after MAX_RETRIES (3 total attempts) are exhausted', async () => {
      vi.useFakeTimers()
      let attempts = 0

      const provider = new NvidiaProvider({
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
        { apiKey: 'nvapi-test', modelName: 'meta/llama-3.1-70b-instruct' }
      )

      sendPromise.catch(() => {})
      await vi.runAllTimersAsync()

      await expect(sendPromise).rejects.toThrow(/temporarily unavailable/i)
      expect(attempts).toBe(3)
    })
  })
})
