// scratch/test_nvidia_opencode_provider.mjs
// Phase 3 — Task 5: NVIDIA NIM & OpenCode Providers Reliability, IPC Lifecycle, Streaming & Cancellation Suite

import assert from 'node:assert'
import esbuild from 'esbuild'

console.log('=================================================================')
console.log('PHASE 3 — TASK 5: NVIDIA NIM & OPENCODE PROVIDERS RELIABILITY')
console.log('=================================================================\n')

// 1. Transpile production nvidiaProvider and opencodeProvider modules with esbuild
const nvidiaBundle = await esbuild.build({
  entryPoints: ['src/renderer/src/services/ai/nvidiaProvider.ts'],
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'browser',
  target: 'es2022'
})

const { NvidiaProvider } = await import(
  'data:text/javascript;base64,' + Buffer.from(nvidiaBundle.outputFiles[0].text).toString('base64')
)

const opencodeBundle = await esbuild.build({
  entryPoints: ['src/renderer/src/services/ai/opencodeProvider.ts'],
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'browser',
  target: 'es2022'
})

const { OpenCodeProvider } = await import(
  'data:text/javascript;base64,' + Buffer.from(opencodeBundle.outputFiles[0].text).toString('base64')
)

let passed = 0
let failed = 0

async function runTest(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failed++
    console.error(`  ✗ ${name}`)
    console.error(`    ${err instanceof Error ? err.stack || err.message : String(err)}`)
  }
}

// Helper to create mock ReadableStream from string chunks array
function createMockSseStream(chunks) {
  const encoder = new TextEncoder()
  let index = 0

  return new ReadableStream({
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

// =================================================================
// Group 1: NVIDIA NIM Message & Tool Serialization & Capability
// =================================================================
console.log('--- Group 1: NVIDIA NIM Message & Tool-Call Serialization & Pairing ---')

await runTest('1.1 NVIDIA capabilities contract: non-streaming, tool-calling enabled', async () => {
  const provider = new NvidiaProvider()
  assert.strictEqual(provider.id, 'nvidia')
  assert.strictEqual(provider.name, 'NVIDIA NIM')
  assert.strictEqual(provider.capabilities.supportsStreaming, false)
  assert.strictEqual(provider.capabilities.supportsTools, true)
  assert.strictEqual(provider.capabilities.requiresApiKey, true)
  assert.strictEqual(provider.capabilities.supportsModelListing, true)
})

await runTest('1.2 Serializes system instruction as role: system and formats user/model turns', async () => {
  let capturedReq = null
  const provider = new NvidiaProvider({
    ipcCaller: async (req) => {
      capturedReq = req
      return {
        success: true,
        data: { choices: [{ message: { role: 'assistant', content: 'Hello!' } }] }
      }
    }
  })

  const messages = [
    { role: 'user', parts: [{ text: 'Hi NVIDIA' }] },
    { role: 'model', parts: [{ text: 'Hello human' }] },
    { role: 'user', parts: [{ text: 'Next question' }] }
  ]

  const resp = await provider.sendMessage(messages, [], {
    apiKey: 'nvapi-test',
    modelName: 'meta/llama-3.1-70b-instruct',
    systemInstruction: 'Be a helpful coding assistant.'
  })

  assert.strictEqual(resp.text, 'Hello!')
  assert.ok(capturedReq)
  assert.strictEqual(capturedReq.messages[0].role, 'system')
  assert.strictEqual(capturedReq.messages[0].content, 'Be a helpful coding assistant.')
  assert.strictEqual(capturedReq.messages[1].role, 'user')
  assert.strictEqual(capturedReq.messages[1].content, 'Hi NVIDIA')
  assert.strictEqual(capturedReq.messages[2].role, 'assistant')
  assert.strictEqual(capturedReq.messages[2].content, 'Hello human')
  assert.strictEqual(capturedReq.messages[3].role, 'user')
  assert.strictEqual(capturedReq.messages[3].content, 'Next question')
})

await runTest('1.3 Correctly pairs multiple tool calls with distinct tool results and IDs', async () => {
  let capturedReq = null
  const provider = new NvidiaProvider({
    ipcCaller: async (req) => {
      capturedReq = req
      return {
        success: true,
        data: { choices: [{ message: { role: 'assistant', content: 'All done' } }] }
      }
    }
  })

  const messages = [
    { role: 'user', parts: [{ text: 'Read two files' }] },
    {
      role: 'model',
      parts: [
        {
          id: 'call_101',
          functionCall: { name: 'read_file', args: { path: 'a.txt' } }
        },
        {
          id: 'call_102',
          functionCall: { name: 'read_file', args: { path: 'b.txt' } }
        }
      ]
    },
    {
      role: 'function',
      parts: [
        {
          tool_call_id: 'call_101',
          functionResponse: { name: 'read_file', response: { content: { data: 'Content A' } } }
        },
        {
          tool_call_id: 'call_102',
          functionResponse: { name: 'read_file', response: { content: { data: 'Content B' } } }
        }
      ]
    }
  ]

  await provider.sendMessage(messages, [], {
    apiKey: 'nvapi-test',
    modelName: 'meta/llama-3.1-70b-instruct'
  })

  assert.ok(capturedReq)
  const assistantMsg = capturedReq.messages.find((m) => m.role === 'assistant')
  assert.ok(assistantMsg && assistantMsg.tool_calls)
  assert.strictEqual(assistantMsg.tool_calls.length, 2)
  assert.strictEqual(assistantMsg.tool_calls[0].id, 'call_101')
  assert.strictEqual(assistantMsg.tool_calls[1].id, 'call_102')

  const toolMsgs = capturedReq.messages.filter((m) => m.role === 'tool')
  assert.strictEqual(toolMsgs.length, 2)
  assert.strictEqual(toolMsgs[0].tool_call_id, 'call_101')
  assert.strictEqual(toolMsgs[1].tool_call_id, 'call_102')
})

await runTest('1.4 Parses tool calls from choice message into functionCalls and rawModelParts', async () => {
  const provider = new NvidiaProvider({
    ipcCaller: async () => ({
      success: true,
      data: {
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'Running tool now',
              tool_calls: [
                {
                  id: 'call_abc_123',
                  type: 'function',
                  function: {
                    name: 'list_files',
                    arguments: '{"directory": "src", "recursive": true}'
                  }
                }
              ]
            }
          }
        ]
      }
    })
  })

  const resp = await provider.sendMessage([{ role: 'user', parts: [{ text: 'List' }] }], [], {
    apiKey: 'nvapi-test',
    modelName: 'meta/llama-3.1-70b-instruct'
  })

  assert.strictEqual(resp.text, 'Running tool now')
  assert.ok(resp.functionCalls)
  assert.strictEqual(resp.functionCalls.length, 1)
  assert.strictEqual(resp.functionCalls[0].name, 'list_files')
  assert.deepStrictEqual(resp.functionCalls[0].args, { directory: 'src', recursive: true })
  assert.strictEqual(resp.rawModelParts.length, 2)
  assert.strictEqual(resp.rawModelParts[0].id, 'call_abc_123')
  assert.strictEqual(resp.rawModelParts[1].text, 'Running tool now')
})

// =================================================================
// Group 2: NVIDIA NIM Error Classification, Retries & Cancellation
// =================================================================
console.log('\n--- Group 2: NVIDIA NIM Error Classification, Retries & Cancellation ---')

await runTest('2.1 Non-retryable auth error (401) aborts without retry and shows friendly error', async () => {
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

  await assert.rejects(
    async () => {
      await provider.sendMessage([{ role: 'user', parts: [{ text: 'Hello' }] }], [], {
        apiKey: 'bad-key',
        modelName: 'meta/llama-3.1-70b-instruct'
      })
    },
    (err) => {
      assert.strictEqual(callCount, 1, 'Must NOT retry 401 auth error')
      assert.ok(err.message.toLowerCase().includes('api key'), `Expected friendly key error, got: ${err.message}`)
      return true
    }
  )
})

await runTest('2.2 Non-retryable model error (404) aborts without retry', async () => {
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

  await assert.rejects(
    async () => {
      await provider.sendMessage([{ role: 'user', parts: [{ text: 'Hello' }] }], [], {
        apiKey: 'nvapi-test',
        modelName: 'nonexistent/model'
      })
    },
    (err) => {
      assert.strictEqual(callCount, 1, 'Must NOT retry 404 model not found error')
      assert.ok(err.message.toLowerCase().includes('not found') || err.message.toLowerCase().includes('unavailable'))
      return true
    }
  )
})

await runTest('2.3 Rate limit (429) retries and respects retryAfter', async () => {
  let attempts = 0
  let retryReportedDelay = null

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
        data: { choices: [{ message: { role: 'assistant', content: 'Recovered!' } }] }
      }
    }
  })

  const resp = await provider.sendMessage([{ role: 'user', parts: [{ text: 'Hi' }] }], [], {
    apiKey: 'nvapi-test',
    modelName: 'meta/llama-3.1-70b-instruct',
    onRetry: (att, max, delay) => {
      retryReportedDelay = delay
    }
  })

  assert.strictEqual(attempts, 2)
  assert.strictEqual(resp.text, 'Recovered!')
  assert.ok(retryReportedDelay >= 1000, `Expected delay >= 1000ms, got ${retryReportedDelay}`)
})

await runTest('2.4 Pre-request cancellation aborts immediately without calling IPC', async () => {
  let ipcCalled = false
  const provider = new NvidiaProvider({
    ipcCaller: async () => {
      ipcCalled = true
      return { success: true }
    }
  })

  const controller = new AbortController()
  controller.abort()

  await assert.rejects(
    async () => {
      await provider.sendMessage([{ role: 'user', parts: [{ text: 'Hello' }] }], [], {
        apiKey: 'nvapi-test',
        modelName: 'meta/llama-3.1-70b-instruct',
        signal: controller.signal
      })
    },
    (err) => {
      assert.strictEqual(ipcCalled, false, 'IPC should never be called when pre-aborted')
      assert.strictEqual(err.message, 'Request was stopped by user.')
      return true
    }
  )
})

await runTest('2.5 In-flight cancellation calls cancelChatCompletion(requestId) and throws without retry', async () => {
  let callCount = 0
  let cancelledRequestId = null

  // Mock window.electronAPI
  globalThis.window = {
    electronAPI: {
      cancelChatCompletion: async (reqId) => {
        cancelledRequestId = reqId
        return { success: true, canceled: true }
      }
    }
  }

  const controller = new AbortController()
  const provider = new NvidiaProvider({
    ipcCaller: async (req) => {
      callCount++
      // Trigger abort while request is in flight
      controller.abort()
      // Simulate IPC cancellation response
      return {
        success: false,
        error: 'Request was stopped by user.',
        errorDetails: 'Request was stopped by user.',
        stage: 'cancelled'
      }
    }
  })

  try {
    await assert.rejects(
      async () => {
        await provider.sendMessage([{ role: 'user', parts: [{ text: 'Hello' }] }], [], {
          apiKey: 'nvapi-test',
          modelName: 'meta/llama-3.1-70b-instruct',
          signal: controller.signal
        })
      },
      (err) => {
        assert.strictEqual(callCount, 1, 'In-flight cancellation must NEVER retry')
        assert.strictEqual(err.message, 'Request was stopped by user.')
        assert.ok(cancelledRequestId && cancelledRequestId.startsWith('nvidia_'), `Expected valid requestId, got ${cancelledRequestId}`)
        return true
      }
    )
  } finally {
    delete globalThis.window
  }
})

await runTest('2.6 Cancellation during retry delay halts sleep immediately without launching subsequent attempts', async () => {
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

  const promise = provider.sendMessage([{ role: 'user', parts: [{ text: 'Hello' }] }], [], {
    apiKey: 'nvapi-test',
    modelName: 'meta/llama-3.1-70b-instruct',
    signal: controller.signal,
    onRetry: () => {
      // Abort during retry sleep!
      setTimeout(() => controller.abort(), 10)
    }
  })

  await assert.rejects(
    promise,
    (err) => {
      assert.strictEqual(attempts, 1, 'Should NOT start attempt 2 if aborted during retry sleep')
      assert.strictEqual(err.message, 'Request was stopped by user.')
      return true
    }
  )
})

// =================================================================
// Group 3: OpenCode Message & Tool Serialization
// =================================================================
console.log('\n--- Group 3: OpenCode Message & Tool Serialization ---')

await runTest('3.1 OpenCode capabilities contract: streaming enabled, no API key required', async () => {
  const provider = new OpenCodeProvider()
  assert.strictEqual(provider.id, 'opencode')
  assert.strictEqual(provider.name, 'OpenCode')
  assert.strictEqual(provider.capabilities.supportsStreaming, true)
  assert.strictEqual(provider.capabilities.supportsTools, true)
  assert.strictEqual(provider.capabilities.requiresApiKey, false)
  assert.strictEqual(provider.capabilities.supportsModelListing, true)
})

await runTest('3.2 Serializes system instruction, messages, and tools via shared serializers', async () => {
  let capturedReq = null
  const provider = new OpenCodeProvider({
    ipcCaller: async (req) => {
      capturedReq = req
      return {
        success: true,
        data: { choices: [{ message: { role: 'assistant', content: 'OpenCode Ready' } }] }
      }
    }
  })

  const tools = [
    {
      name: 'calculate',
      description: 'Calculator tool',
      parameters: { type: 'object', properties: { expr: { type: 'string' } } }
    }
  ]

  const resp = await provider.sendMessage([{ role: 'user', parts: [{ text: 'Compute 2+2' }] }], tools, {
    apiKey: '',
    modelName: 'space-bunny-free',
    systemInstruction: 'You are an OpenCode assistant'
  })

  assert.strictEqual(resp.text, 'OpenCode Ready')
  assert.ok(capturedReq)
  assert.strictEqual(capturedReq.messages[0].role, 'system')
  assert.strictEqual(capturedReq.messages[0].content, 'You are an OpenCode assistant')
  assert.strictEqual(capturedReq.messages[1].role, 'user')
  assert.strictEqual(capturedReq.messages[1].content, 'Compute 2+2')
  assert.ok(capturedReq.tools)
  assert.strictEqual(capturedReq.tools[0].function.name, 'calculate')
})

await runTest('3.3 Non-streaming completion parses tool calls and arguments cleanly', async () => {
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
                }
              ]
            }
          }
        ]
      }
    })
  })

  const resp = await provider.sendMessage([{ role: 'user', parts: [{ text: 'Run tests' }] }], [], {
    apiKey: '',
    modelName: 'space-bunny-free'
  })

  assert.strictEqual(resp.text, 'Executing command')
  assert.ok(resp.functionCalls)
  assert.strictEqual(resp.functionCalls.length, 1)
  assert.strictEqual(resp.functionCalls[0].name, 'run_command')
  assert.deepStrictEqual(resp.functionCalls[0].args, { command: 'npm test' })
})

// =================================================================
// Group 4: OpenCode Streaming, Chunk Delivery & Tool Assembly
// =================================================================
console.log('\n--- Group 4: OpenCode Streaming, Chunk Delivery & Tool Assembly ---')

await runTest('4.1 Emits text chunks incrementally through onChunk and returns matching final text without duplication', async () => {
  let streamListenerCallback = null
  const chunksReceived = []

  const provider = new OpenCodeProvider({
    streamListener: (cb) => {
      streamListenerCallback = cb
      return () => { streamListenerCallback = null }
    },
    ipcCaller: async (req) => {
      // Simulate main process streaming chunks
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

  const resp = await provider.sendMessage([{ role: 'user', parts: [{ text: 'Hi' }] }], [], {
    apiKey: '',
    modelName: 'space-bunny-free',
    onChunk: (chunk) => chunksReceived.push(chunk)
  })

  assert.deepStrictEqual(chunksReceived, ['Hello ', 'World!'])
  assert.strictEqual(resp.text, 'Hello World!')
  assert.strictEqual(resp.rawModelParts[0].text, 'Hello World!')
})

await runTest('4.2 Assembles incremental streaming tool calls in direct fetch fallback cleanly', async () => {
  const ssePayload = [
    'data: {"choices":[{"delta":{"content":"Thinking... "}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_99","function":{"name":"read_"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"file","arguments":"{\\"path\\": "}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"test.ts\\"}"}}]}}]}\n\n',
    'data: [DONE]\n\n'
  ]

  const mockFetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    body: createMockSseStream(ssePayload)
  })

  const provider = new OpenCodeProvider({
    fetchImpl: mockFetch
  })

  const streamedChunks = []
  const resp = await provider.sendMessage([{ role: 'user', parts: [{ text: 'Read test.ts' }] }], [], {
    apiKey: '',
    modelName: 'space-bunny-free',
    onChunk: (chunk) => streamedChunks.push(chunk)
  })

  assert.deepStrictEqual(streamedChunks, ['Thinking... '])
  assert.strictEqual(resp.text, 'Thinking...')
  assert.ok(resp.functionCalls)
  assert.strictEqual(resp.functionCalls.length, 1)
  assert.strictEqual(resp.functionCalls[0].name, 'read_file')
  assert.deepStrictEqual(resp.functionCalls[0].args, { path: 'test.ts' })
})

// =================================================================
// Group 5: IPC Request Isolation, Unique Request IDs & Cross-Talk Prevention
// =================================================================
console.log('\n--- Group 5: IPC Request Isolation, Unique Request IDs & Cross-Talk Prevention ---')

await runTest('5.1 Each request and retry attempt generates a unique request ID', async () => {
  const requestIds = []
  const provider = new OpenCodeProvider({
    ipcCaller: async (req) => {
      requestIds.push(req.requestId)
      if (requestIds.length < 2) {
        return { success: false, status: 502, error: 'Bad Gateway' }
      }
      return {
        success: true,
        data: { choices: [{ message: { role: 'assistant', content: 'Success' } }] }
      }
    }
  })

  await provider.sendMessage([{ role: 'user', parts: [{ text: 'Hello' }] }], [], {
    apiKey: '',
    modelName: 'space-bunny-free'
  })

  assert.strictEqual(requestIds.length, 2)
  assert.notStrictEqual(requestIds[0], requestIds[1], 'Retry attempt must generate a distinct request ID')
  assert.ok(requestIds[0].includes('_att0'))
  assert.ok(requestIds[1].includes('_att1'))
})

await runTest('5.2 Concurrent requests execute concurrently without cross-talk or ID collision', async () => {
  const capturedRequests = []

  const provider = new OpenCodeProvider({
    ipcCaller: async (req) => {
      capturedRequests.push(req)
      await new Promise((r) => setTimeout(r, 20))
      return {
        success: true,
        data: { choices: [{ message: { role: 'assistant', content: `Response for ${req.requestId}` } }] }
      }
    }
  })

  const [respA, respB] = await Promise.all([
    provider.sendMessage([{ role: 'user', parts: [{ text: 'Req A' }] }], [], { apiKey: '', modelName: 'model-a' }),
    provider.sendMessage([{ role: 'user', parts: [{ text: 'Req B' }] }], [], { apiKey: '', modelName: 'model-b' })
  ])

  assert.strictEqual(capturedRequests.length, 2)
  assert.notStrictEqual(capturedRequests[0].requestId, capturedRequests[1].requestId)
  assert.strictEqual(respA.text, `Response for ${capturedRequests[0].requestId}`)
  assert.strictEqual(respB.text, `Response for ${capturedRequests[1].requestId}`)
})

await runTest('5.3 Stream listener strictly rejects late chunks from previous retry attempts or other request IDs', async () => {
  let streamListenerCallback = null
  let attempt = 0
  const receivedChunks = []

  const provider = new OpenCodeProvider({
    streamListener: (cb) => {
      streamListenerCallback = cb
      return () => { streamListenerCallback = null }
    },
    ipcCaller: async (req) => {
      attempt++
      if (attempt === 1) {
        // Attempt 1 fails, but late chunk arrives later
        const staleId = req.requestId
        setTimeout(() => {
          if (streamListenerCallback) {
            // Emitting late chunk with attempt 1's ID during attempt 2!
            streamListenerCallback({ requestId: staleId, chunk: 'STALE CHUNK' })
          }
        }, 30)
        return { success: false, status: 502, error: 'Bad Gateway' }
      }

      // Attempt 2 succeeds
      await new Promise((r) => setTimeout(r, 50))
      if (streamListenerCallback) {
        streamListenerCallback({ requestId: req.requestId, chunk: 'FRESH CHUNK' })
      }
      return {
        success: true,
        data: { choices: [{ message: { role: 'assistant', content: 'FRESH CHUNK' } }] }
      }
    }
  })

  const resp = await provider.sendMessage([{ role: 'user', parts: [{ text: 'Hello' }] }], [], {
    apiKey: '',
    modelName: 'space-bunny-free',
    onChunk: (c) => receivedChunks.push(c)
  })

  assert.strictEqual(attempt, 2)
  assert.deepStrictEqual(receivedChunks, ['FRESH CHUNK'], 'Late chunk from attempt 1 must NOT be accepted!')
  assert.strictEqual(resp.text, 'FRESH CHUNK')
})

await runTest('5.4 Out-of-order completions between concurrent requests resolve correctly to their respective callers', async () => {
  const provider = new OpenCodeProvider({
    ipcCaller: async (req) => {
      // Fast request finishes in 10ms, slow request finishes in 50ms
      const isSlow = req.model === 'slow-model'
      await new Promise((r) => setTimeout(r, isSlow ? 50 : 10))
      return {
        success: true,
        data: { choices: [{ message: { role: 'assistant', content: `Resolved ${req.model}` } }] }
      }
    }
  })

  const slowPromise = provider.sendMessage([{ role: 'user', parts: [{ text: 'Slow' }] }], [], {
    apiKey: '',
    modelName: 'slow-model'
  })

  const fastPromise = provider.sendMessage([{ role: 'user', parts: [{ text: 'Fast' }] }], [], {
    apiKey: '',
    modelName: 'fast-model'
  })

  const [fastResp, slowResp] = await Promise.all([fastPromise, slowPromise])
  assert.strictEqual(fastResp.text, 'Resolved fast-model')
  assert.strictEqual(slowResp.text, 'Resolved slow-model')
})

// =================================================================
// Group 6: Cancellation Propagation & Main-Process Lifecycle Simulation
// =================================================================
console.log('\n--- Group 6: Cancellation Propagation & Main-Process Lifecycle ---')

await runTest('6.1 In-flight cancellation triggers cancelChatCompletion(requestId) targeting ONLY the matching request', async () => {
  let cancelledReqId = null
  globalThis.window = {
    electronAPI: {
      cancelChatCompletion: async (reqId) => {
        cancelledReqId = reqId
        return { success: true, canceled: true }
      }
    }
  }

  const controller = new AbortController()
  let requestCaptured = null

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

  try {
    await assert.rejects(
      async () => {
        await provider.sendMessage([{ role: 'user', parts: [{ text: 'Hello' }] }], [], {
          apiKey: '',
          modelName: 'space-bunny-free',
          signal: controller.signal
        })
      },
      (err) => {
        assert.strictEqual(err.message, 'Request was stopped by user.')
        assert.strictEqual(cancelledReqId, requestCaptured.requestId)
        return true
      }
    )
  } finally {
    delete globalThis.window
  }
})

await runTest('6.2 Cancelling Request A does NOT cancel or affect concurrent Request B', async () => {
  const cancelledIds = []
  globalThis.window = {
    electronAPI: {
      cancelChatCompletion: async (reqId) => {
        cancelledIds.push(reqId)
        return { success: true, canceled: true }
      }
    }
  }

  const controllerA = new AbortController()
  const controllerB = new AbortController()

  const provider = new OpenCodeProvider({
    ipcCaller: async (req) => {
      if (req.model === 'model-a') {
        controllerA.abort() // Cancel A
        return { success: false, error: 'Request was stopped by user.' }
      }
      // Request B proceeds
      await new Promise((r) => setTimeout(r, 25))
      return {
        success: true,
        data: { choices: [{ message: { role: 'assistant', content: 'B completed safely' } }] }
      }
    }
  })

  try {
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

    await assert.rejects(promiseA, (err) => {
      assert.strictEqual(err.message, 'Request was stopped by user.')
      return true
    })

    const respB = await promiseB
    assert.strictEqual(respB.text, 'B completed safely')
    assert.strictEqual(cancelledIds.length, 1)
  } finally {
    delete globalThis.window
  }
})

await runTest('6.3 Main-process active chat requests lifecycle simulation', async () => {
  // Directly simulate main process activeChatRequests Map and cancelChatCompletion handler
  const activeChatRequests = new Map()
  let fetchAborted = false
  let streamCancelled = false

  const cancelChatCompletion = async (reqId) => {
    const active = activeChatRequests.get(reqId)
    if (active) {
      activeChatRequests.delete(reqId)
      active.controller.abort('Request was stopped by user.')
      active.cancelStream?.()
      return { success: true, canceled: true }
    }
    return { success: true, canceled: false }
  }

  // Simulate Request A arriving in main process
  const controllerA = new AbortController()
  controllerA.signal.addEventListener('abort', () => { fetchAborted = true })

  activeChatRequests.set('req_123', {
    requestId: 'req_123',
    provider: 'opencode',
    controller: controllerA,
    cancelStream: () => { streamCancelled = true }
  })

  assert.strictEqual(activeChatRequests.size, 1)

  // Cancel non-matching ID
  const missRes = await cancelChatCompletion('req_999')
  assert.strictEqual(missRes.canceled, false)
  assert.strictEqual(fetchAborted, false)
  assert.strictEqual(activeChatRequests.size, 1)

  // Cancel matching ID
  const hitRes = await cancelChatCompletion('req_123')
  assert.strictEqual(hitRes.canceled, true)
  assert.strictEqual(fetchAborted, true)
  assert.strictEqual(streamCancelled, true)
  assert.strictEqual(activeChatRequests.size, 0)
})

await runTest('6.4 Cancelled stream stops emitting chunks immediately and cleans up listeners', async () => {
  let listenerActive = false
  let streamListenerCallback = null
  const controller = new AbortController()
  const chunksReceived = []

  const provider = new OpenCodeProvider({
    streamListener: (cb) => {
      listenerActive = true
      streamListenerCallback = cb
      return () => { listenerActive = false }
    },
    ipcCaller: async (req) => {
      // Send chunk 1
      streamListenerCallback({ requestId: req.requestId, chunk: 'Chunk 1' })
      // Abort
      controller.abort()
      // Send chunk 2 (should be ignored because signal is aborted)
      streamListenerCallback({ requestId: req.requestId, chunk: 'Chunk 2' })
      return { success: false, error: 'Request was stopped by user.' }
    }
  })

  await assert.rejects(
    async () => {
      await provider.sendMessage([{ role: 'user', parts: [{ text: 'Hello' }] }], [], {
        apiKey: '',
        modelName: 'space-bunny-free',
        signal: controller.signal,
        onChunk: (c) => chunksReceived.push(c)
      })
    },
    (err) => {
      assert.strictEqual(err.message, 'Request was stopped by user.')
      assert.deepStrictEqual(chunksReceived, ['Chunk 1'], 'Chunk 2 should have been suppressed after abort')
      assert.strictEqual(listenerActive, false, 'Listener must be cleaned up after abort')
      return true
    }
  )
})

await runTest('6.5 Retry exhaustion propagates final error and cleans up all active listeners', async () => {
  let attempts = 0
  let listenerActive = false

  const provider = new OpenCodeProvider({
    streamListener: () => {
      listenerActive = true
      return () => { listenerActive = false }
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

  await assert.rejects(
    async () => {
      await provider.sendMessage([{ role: 'user', parts: [{ text: 'Hello' }] }], [], {
        apiKey: '',
        modelName: 'space-bunny-free',
        onChunk: () => {}
      })
    },
    (err) => {
      assert.strictEqual(attempts, 3, 'Initial + 2 retries = 3 attempts total')
      assert.ok(err.message.includes('unavailable') || err.message.includes('Internal Server Error'))
      assert.strictEqual(listenerActive, false, 'Stream listener must be cleaned up on failure')
      return true
    }
  )
})

// =================================================================
// Summary
// =================================================================
console.log('\n=================================================================')
console.log(`NVIDIA & OPENCODE TEST RESULTS: ${passed} passed, ${failed} failed`)
console.log('=================================================================\n')

if (failed > 0) {
  process.exit(1)
}
