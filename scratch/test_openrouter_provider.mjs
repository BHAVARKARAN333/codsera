// scratch/test_openrouter_provider.mjs
// Phase 3 — Task 4: OpenRouter Provider Reliability, Streaming & Tool-Call Suite
//
// Tests:
// 1. OpenAI-compatible message & tool formatting (system instruction, distinct tool call IDs, tool response pairing)
// 2. Non-streaming standard responses, tool calls, and malformed arguments/responses
// 3. SSE streaming chunk delivery, split chunk boundaries, incremental tool calls, and zero duplication
// 4. Cancellation boundaries (pre-request, in-flight, during stream, during retry) with NO unwanted retries
// 5. Error classification, Retry-After header respect, bounded backoff, and non-retryable failure handling

import assert from 'node:assert'
import esbuild from 'esbuild'

console.log('=================================================================')
console.log('PHASE 3 — TASK 4: OPENROUTER PROVIDER RELIABILITY & STREAMING')
console.log('=================================================================\n')

// 1. Transpile production openRouterProvider module with esbuild
const bundle = await esbuild.build({
  entryPoints: ['src/renderer/src/services/ai/openRouterProvider.ts'],
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'browser',
  target: 'es2022'
})

const { OpenRouterProvider } = await import(
  'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64')
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

// -----------------------------------------------------------------
// Group 1: OpenAI-Compatible Message & Tool Formatting
// -----------------------------------------------------------------
console.log('\n--- Group 1: OpenAI-Compatible Message & Tool Formatting ---')

await runTest('1.1 Formats system instruction, user text, and model turns into OpenAI chat completions schema', async () => {
  let capturedBody = null

  const mockFetch = async (_url, init) => {
    capturedBody = JSON.parse(init.body)
    return new Response(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'Understood.' } }]
      }),
      { status: 200 }
    )
  }

  const provider = new OpenRouterProvider({ fetchImpl: mockFetch })
  await provider.sendMessage(
    [{ role: 'user', parts: [{ text: 'Hello OpenRouter' }] }],
    [],
    { apiKey: 'test-key', systemInstruction: 'System instruction here' }
  )

  assert.ok(capturedBody)
  assert.strictEqual(capturedBody.messages[0].role, 'system')
  assert.strictEqual(capturedBody.messages[0].content, 'System instruction here')
  assert.strictEqual(capturedBody.messages[1].role, 'user')
  assert.strictEqual(capturedBody.messages[1].content, 'Hello OpenRouter')
})

await runTest('1.2 Preserves distinct tool call IDs and pairs subsequent tool responses correctly', async () => {
  let capturedBody = null

  const mockFetch = async (_url, init) => {
    capturedBody = JSON.parse(init.body)
    return new Response(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'Files processed.' } }]
      }),
      { status: 200 }
    )
  }

  const messages = [
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

  const provider = new OpenRouterProvider({ fetchImpl: mockFetch })
  await provider.sendMessage(messages, [], { apiKey: 'test-key' })

  assert.ok(capturedBody)
  const assistantMsg = capturedBody.messages[1]
  assert.strictEqual(assistantMsg.role, 'assistant')
  assert.strictEqual(assistantMsg.tool_calls.length, 2)
  assert.strictEqual(assistantMsg.tool_calls[0].id, 'call_read_a')
  assert.strictEqual(assistantMsg.tool_calls[1].id, 'call_read_b')

  const toolResponseA = capturedBody.messages[2]
  assert.strictEqual(toolResponseA.role, 'tool')
  assert.strictEqual(toolResponseA.tool_call_id, 'call_read_a')
  assert.ok(toolResponseA.content.includes('content A'))

  const toolResponseB = capturedBody.messages[3]
  assert.strictEqual(toolResponseB.role, 'tool')
  assert.strictEqual(toolResponseB.tool_call_id, 'call_read_b')
  assert.ok(toolResponseB.content.includes('content B'))
})

await runTest('1.3 Serializes non-standard tool response without producing literal string "undefined"', async () => {
  let capturedBody = null

  const mockFetch = async (_url, init) => {
    capturedBody = JSON.parse(init.body)
    return new Response(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'Done' } }]
      }),
      { status: 200 }
    )
  }

  const messages = [
    {
      role: 'function',
      parts: [
        {
          tool_call_id: 'call_bare',
          functionResponse: {
            name: 'bare_result',
            // Bare result without 'content' key
            response: { success: true, count: 5 }
          }
        }
      ]
    }
  ]

  const provider = new OpenRouterProvider({ fetchImpl: mockFetch })
  await provider.sendMessage(messages, [], { apiKey: 'test-key' })

  const toolMsg = capturedBody.messages[0]
  assert.strictEqual(toolMsg.role, 'tool')
  assert.notStrictEqual(toolMsg.content, 'undefined')
  assert.ok(toolMsg.content.includes('"count": 5'))
})

// -----------------------------------------------------------------
// Group 2: Non-Streaming Standard Responses & Malformed Data Handling
// -----------------------------------------------------------------
console.log('\n--- Group 2: Non-Streaming Standard Responses & Malformed Data Handling ---')

await runTest('2.1 Successful text response parses text and rawModelParts cleanly', async () => {
  const mockFetch = async () => {
    return new Response(
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
  }

  const provider = new OpenRouterProvider({ fetchImpl: mockFetch })
  const res = await provider.sendMessage(
    [{ role: 'user', parts: [{ text: 'Prompt' }] }],
    [],
    { apiKey: 'test-key' }
  )

  assert.strictEqual(res.text, 'OpenRouter normal response')
  assert.strictEqual(res.functionCalls, undefined)
  assert.strictEqual(res.rawModelParts?.length, 1)
  assert.strictEqual(res.rawModelParts[0].text, 'OpenRouter normal response')
})

await runTest('2.2 Parses multiple tool calls from choice message into functionCalls and rawModelParts', async () => {
  const mockFetch = async () => {
    return new Response(
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
  }

  const provider = new OpenRouterProvider({ fetchImpl: mockFetch })
  const res = await provider.sendMessage(
    [{ role: 'user', parts: [{ text: 'List and read' }] }],
    [],
    { apiKey: 'test-key' }
  )

  assert.strictEqual(res.text, 'Calling two tools:')
  assert.strictEqual(res.functionCalls?.length, 2)
  assert.strictEqual(res.functionCalls[0].name, 'list_files')
  assert.deepStrictEqual(res.functionCalls[0].args, { relativePath: 'src' })
  assert.strictEqual(res.functionCalls[1].name, 'read_file')
  assert.deepStrictEqual(res.functionCalls[1].args, { path: 'src/index.ts' })

  // Both assistant text and tool calls are preserved in rawModelParts
  assert.strictEqual(res.rawModelParts?.length, 3)
})

await runTest('2.3 Malformed JSON in tool_calls arguments defaults to empty object without throwing', async () => {
  const mockFetch = async () => {
    return new Response(
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
  }

  const provider = new OpenRouterProvider({ fetchImpl: mockFetch })
  const res = await provider.sendMessage(
    [{ role: 'user', parts: [{ text: 'Broken' }] }],
    [],
    { apiKey: 'test-key' }
  )

  assert.strictEqual(res.functionCalls?.length, 1)
  assert.strictEqual(res.functionCalls[0].name, 'broken_tool')
  assert.deepStrictEqual(res.functionCalls[0].args, {})
})

await runTest('2.4 Provider error payload in 200 response throws clean error', async () => {
  const mockFetch = async () => {
    return new Response(
      JSON.stringify({
        error: { message: 'Provider model is out of credits' }
      }),
      { status: 200 }
    )
  }

  const provider = new OpenRouterProvider({ fetchImpl: mockFetch })
  await assert.rejects(
    async () => {
      await provider.sendMessage(
        [{ role: 'user', parts: [{ text: 'Prompt' }] }],
        [],
        { apiKey: 'test-key' }
      )
    },
    (err) => {
      assert.ok(err.message.includes('out of credits'))
      return true
    }
  )
})

// -----------------------------------------------------------------
// Group 3: SSE Streaming Responses & Chunk Delivery
// -----------------------------------------------------------------
console.log('\n--- Group 3: SSE Streaming Responses & Chunk Delivery ---')

await runTest('3.1 Delivers text chunks incrementally through onChunk and returns matching final text without duplication', async () => {
  const chunksReceived = []

  const sseLines = [
    'data: {"id":"1","choices":[{"delta":{"content":"First"}}]}\n\n',
    'data: {"id":"1","choices":[{"delta":{"content":" second"}}]}\n\n',
    'data: {"id":"1","choices":[{"delta":{"content":" third."}}]}\n\n',
    'data: [DONE]\n\n'
  ]

  const mockFetch = async () => {
    return new Response(createMockSseStream(sseLines), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' }
    })
  }

  const provider = new OpenRouterProvider({ fetchImpl: mockFetch })
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

  assert.deepStrictEqual(chunksReceived, ['First', ' second', ' third.'])
  assert.strictEqual(res.text, 'First second third.')
  assert.strictEqual(res.text, chunksReceived.join(''))
})

await runTest('3.2 Correctly parses SSE events split across reader chunks', async () => {
  const chunksReceived = []

  // Split line across two reader reads
  const ssePart1 = 'data: {"id":"1","choices":[{"delta":{"content":"Hello'
  const ssePart2 = ' world!"}}]}\n\ndata: [DONE]\n\n'

  const mockFetch = async () => {
    return new Response(createMockSseStream([ssePart1, ssePart2]), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' }
    })
  }

  const provider = new OpenRouterProvider({ fetchImpl: mockFetch })
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

  assert.strictEqual(chunksReceived.join(''), 'Hello world!')
  assert.strictEqual(res.text, 'Hello world!')
})

await runTest('3.3 Assembles incremental streamed tool calls across multiple delta chunks', async () => {
  const sseLines = [
    'data: {"choices":[{"delta":{"content":"I will inspect files: "}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_dyn_1","type":"function","function":{"name":"read_file","arguments":"{\\"pa"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\": \\"config.json\\"}"}}]}}]}\n\n',
    'data: [DONE]\n\n'
  ]

  const mockFetch = async () => {
    return new Response(createMockSseStream(sseLines), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' }
    })
  }

  const provider = new OpenRouterProvider({ fetchImpl: mockFetch })
  const res = await provider.sendMessage(
    [{ role: 'user', parts: [{ text: 'Stream tool' }] }],
    [],
    {
      apiKey: 'test-key',
      onChunk: () => {}
    }
  )

  assert.strictEqual(res.text, 'I will inspect files: ')
  assert.strictEqual(res.functionCalls?.length, 1)
  assert.strictEqual(res.functionCalls[0].name, 'read_file')
  assert.deepStrictEqual(res.functionCalls[0].args, { path: 'config.json' })
})

await runTest('3.4 Handles stream error event in SSE payload cleanly', async () => {
  const sseLines = [
    'data: {"choices":[{"delta":{"content":"Starting..."}}]}\n\n',
    'data: {"error":{"message":"Rate limit exceeded during generation"}}\n\n'
  ]

  const mockFetch = async () => {
    return new Response(createMockSseStream(sseLines), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' }
    })
  }

  const provider = new OpenRouterProvider({ fetchImpl: mockFetch })
  await assert.rejects(
    async () => {
      await provider.sendMessage(
        [{ role: 'user', parts: [{ text: 'Prompt' }] }],
        [],
        {
          apiKey: 'test-key',
          onChunk: () => {}
        }
      )
    },
    (err) => {
      assert.ok(err.message.toLowerCase().includes('rate limit'))
      return true
    }
  )
})

// -----------------------------------------------------------------
// Group 4: Cancellation Boundaries & Non-Retryable User Abort
// -----------------------------------------------------------------
console.log('\n--- Group 4: Cancellation Boundaries & Non-Retryable User Abort ---')

await runTest('4.1 Pre-request cancellation aborts immediately without calling fetch', async () => {
  let fetchCalled = false
  const mockFetch = async () => {
    fetchCalled = true
    return new Response('{}', { status: 200 })
  }

  const controller = new AbortController()
  controller.abort()

  const provider = new OpenRouterProvider({ fetchImpl: mockFetch })
  await assert.rejects(
    async () => {
      await provider.sendMessage(
        [{ role: 'user', parts: [{ text: 'Cancelled' }] }],
        [],
        { apiKey: 'test-key', signal: controller.signal }
      )
    },
    (err) => {
      assert.strictEqual(err.message, 'Request was stopped by user.')
      return true
    }
  )

  assert.strictEqual(fetchCalled, false)
})

await runTest('4.2 In-flight cancellation immediately halts request and NEVER triggers retries', async () => {
  let fetchAttempts = 0
  const controller = new AbortController()

  const mockFetch = async () => {
    fetchAttempts++
    controller.abort()
    const abortErr = new Error('The operation was aborted.')
    abortErr.name = 'AbortError'
    throw abortErr
  }

  const provider = new OpenRouterProvider({ fetchImpl: mockFetch })
  await assert.rejects(
    async () => {
      await provider.sendMessage(
        [{ role: 'user', parts: [{ text: 'Cancel test' }] }],
        [],
        { apiKey: 'test-key', signal: controller.signal }
      )
    },
    (err) => {
      assert.strictEqual(err.message, 'Request was stopped by user.')
      return true
    }
  )

  assert.strictEqual(fetchAttempts, 1, 'Cancellation must not trigger retries')
})

await runTest('4.3 Cancellation during SSE stream reading immediately halts reader without retry', async () => {
  let fetchAttempts = 0
  const controller = new AbortController()
  let streamCancelled = false

  const mockFetch = async () => {
    fetchAttempts++
    const encoder = new TextEncoder()
    let pulledCount = 0

    const stream = new ReadableStream({
      async pull(streamController) {
        if (pulledCount === 0) {
          pulledCount++
          streamController.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Chunk 1"}}]}\n\n'))
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

  const provider = new OpenRouterProvider({ fetchImpl: mockFetch })
  await assert.rejects(
    async () => {
      await provider.sendMessage(
        [{ role: 'user', parts: [{ text: 'Stream cancel' }] }],
        [],
        {
          apiKey: 'test-key',
          signal: controller.signal,
          onChunk: () => {}
        }
      )
    },
    (err) => {
      assert.strictEqual(err.message, 'Request was stopped by user.')
      return true
    }
  )

  assert.strictEqual(fetchAttempts, 1)
  assert.strictEqual(streamCancelled, true)
})

await runTest('4.4 Cancellation during retry delay halts sleep immediately without launching next request', async () => {
  let fetchAttempts = 0
  const controller = new AbortController()

  const mockFetch = async () => {
    fetchAttempts++
    return new Response('{"error": {"message": "Service overloaded"}}', {
      status: 503,
      statusText: 'Service Unavailable'
    })
  }

  const provider = new OpenRouterProvider({ fetchImpl: mockFetch })
  const start = Date.now()

  await assert.rejects(
    async () => {
      await provider.sendMessage(
        [{ role: 'user', parts: [{ text: 'Retry cancel' }] }],
        [],
        {
          apiKey: 'test-key',
          signal: controller.signal,
          onRetry: () => {
            setTimeout(() => controller.abort(), 10)
          }
        }
      )
    },
    (err) => {
      assert.strictEqual(err.message, 'Request was stopped by user.')
      return true
    }
  )

  const elapsed = Date.now() - start
  assert.strictEqual(fetchAttempts, 1)
  assert.ok(elapsed < 800, `Expected cancellation to break sleep quickly, took ${elapsed}ms`)
})

// -----------------------------------------------------------------
// Group 5: Error Handling & Retry Mechanics
// -----------------------------------------------------------------
console.log('\n--- Group 5: Error Handling & Retry Mechanics ---')

await runTest('5.1 Non-retryable auth error (401) throws user-friendly error without retry', async () => {
  let fetchAttempts = 0
  const mockFetch = async () => {
    fetchAttempts++
    return new Response('{"error": {"message": "Invalid API key"}}', {
      status: 401,
      statusText: 'Unauthorized'
    })
  }

  const provider = new OpenRouterProvider({ fetchImpl: mockFetch })
  await assert.rejects(
    async () => {
      await provider.sendMessage(
        [{ role: 'user', parts: [{ text: 'Auth' }] }],
        [],
        { apiKey: 'bad-key' }
      )
    },
    (err) => {
      assert.ok(err.message.includes('Invalid OpenRouter API key'))
      return true
    }
  )

  assert.strictEqual(fetchAttempts, 1)
})

await runTest('5.2 Non-retryable model error (404) throws model unavailable error without retry', async () => {
  let fetchAttempts = 0
  const mockFetch = async () => {
    fetchAttempts++
    return new Response('{"error": {"message": "No model found"}}', {
      status: 404,
      statusText: 'Not Found'
    })
  }

  const provider = new OpenRouterProvider({ fetchImpl: mockFetch })
  await assert.rejects(
    async () => {
      await provider.sendMessage(
        [{ role: 'user', parts: [{ text: 'Model' }] }],
        [],
        { apiKey: 'test-key', modelName: 'retired/model' }
      )
    },
    (err) => {
      assert.ok(err.message.includes('was not found or has been deprecated'))
      return true
    }
  )

  assert.strictEqual(fetchAttempts, 1)
})

await runTest('5.3 Rate limit (429) retries and respects Retry-After header', async () => {
  let fetchAttempts = 0
  const retryCalls = []

  const mockFetch = async () => {
    fetchAttempts++
    if (fetchAttempts === 1) {
      return new Response('{"error": {"message": "Rate limit exceeded"}}', {
        status: 429,
        statusText: 'Too Many Requests',
        headers: { 'Retry-After': '1' }
      })
    }
    return new Response(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'Recovered after rate limit' } }]
      }),
      { status: 200 }
    )
  }

  const provider = new OpenRouterProvider({ fetchImpl: mockFetch })
  const res = await provider.sendMessage(
    [{ role: 'user', parts: [{ text: 'Rate limit' }] }],
    [],
    {
      apiKey: 'test-key',
      onRetry: (attempt, maxRetries, delayMs, reason) => {
        retryCalls.push({ attempt, maxRetries, delayMs, reason })
      }
    }
  )

  assert.strictEqual(fetchAttempts, 2)
  assert.strictEqual(res.text, 'Recovered after rate limit')
  assert.strictEqual(retryCalls.length, 1)
  assert.strictEqual(retryCalls[0].delayMs, 1000)
})

await runTest('5.4 Temporary server error (502) retries and recovers on next attempt', async () => {
  let fetchAttempts = 0
  const mockFetch = async () => {
    fetchAttempts++
    if (fetchAttempts === 1) {
      return new Response('Bad Gateway', { status: 502, statusText: 'Bad Gateway' })
    }
    return new Response(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'Success on retry' } }]
      }),
      { status: 200 }
    )
  }

  const provider = new OpenRouterProvider({ fetchImpl: mockFetch })
  const res = await provider.sendMessage(
    [{ role: 'user', parts: [{ text: 'Server error' }] }],
    [],
    { apiKey: 'test-key' }
  )

  assert.strictEqual(fetchAttempts, 2)
  assert.strictEqual(res.text, 'Success on retry')
})

await runTest('5.5 Retries exhausted (MAX_RETRIES exceeded) propagates final error cleanly', async () => {
  let fetchAttempts = 0
  const mockFetch = async () => {
    fetchAttempts++
    return new Response('{"error": {"message": "Overloaded, try again later"}}', {
      status: 503,
      statusText: 'Service Unavailable'
    })
  }

  const provider = new OpenRouterProvider({ fetchImpl: mockFetch })
  await assert.rejects(
    async () => {
      await provider.sendMessage(
        [{ role: 'user', parts: [{ text: 'Exhaust' }] }],
        [],
        { apiKey: 'test-key' }
      )
    },
    (err) => {
      assert.ok(err.message.includes('temporarily unavailable'))
      return true
    }
  )

  // 1 initial attempt + 2 retries = 3 total calls
  assert.strictEqual(fetchAttempts, 3)
})

console.log(`\n=================================================================`)
console.log(`OPENROUTER PROVIDER TEST RESULTS: ${passed} passed, ${failed} failed`)
console.log(`=================================================================\n`)

if (failed > 0) {
  process.exit(1)
}
