// scratch/test_gemini_provider.mjs
// Phase 3 — Task 3: Gemini Provider Reliability, Alternating Turns & Streaming Test Suite
//
// Tests:
// 1. Gemini message formatting & alternating role contract (consecutive function responses merged)
// 2. Non-streaming standard responses, tool calls, and thought-part isolation
// 3. SSE streaming chunk delivery, incremental chunks, and final text assembly without duplication
// 4. Cancellation boundaries (pre-request, in-flight, during stream, during retry) with NO unwanted retries
// 5. Error classification, Retry-After header respect, bounded backoff, and non-retryable failure handling

import assert from 'node:assert'
import esbuild from 'esbuild'

console.log('=================================================================')
console.log('PHASE 3 — TASK 3: GEMINI PROVIDER RELIABILITY & STREAMING SUITE')
console.log('=================================================================\n')

// 1. Transpile production geminiProvider module with esbuild
const bundle = await esbuild.build({
  entryPoints: ['src/renderer/src/services/ai/geminiProvider.ts'],
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'browser',
  target: 'es2022'
})

const { GeminiProvider, formatGeminiContents } = await import(
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

// Helper to create mock ReadableStream from SSE chunks array
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
// Group 1: Gemini Message Formatting & Alternating Role Contract
// -----------------------------------------------------------------
console.log('\n--- Group 1: Gemini Message Formatting & Alternating Role Contract ---')

await runTest('1.1 Formats simple user message to Gemini schema', () => {
  const messages = [{ role: 'user', parts: [{ text: 'Hello Gemini' }] }]
  const formatted = formatGeminiContents(messages)
  assert.strictEqual(formatted.length, 1)
  assert.strictEqual(formatted[0].role, 'user')
  assert.strictEqual(formatted[0].parts[0].text, 'Hello Gemini')
})

await runTest('1.2 Merges consecutive function responses into a SINGLE user turn', () => {
  // Simulates multi-tool execution where orchestrator pushed two function responses
  const messages = [
    { role: 'user', parts: [{ text: 'List and read' }] },
    {
      role: 'model',
      parts: [
        { functionCall: { name: 'list_files', args: {} } },
        { functionCall: { name: 'read_file', args: { path: 'a.txt' } } }
      ]
    },
    {
      role: 'function',
      parts: [
        {
          functionResponse: {
            name: 'list_files',
            response: { name: 'list_files', content: { files: ['a.txt'] } }
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
            response: { name: 'read_file', content: { text: 'content' } }
          }
        }
      ]
    }
  ]

  const formatted = formatGeminiContents(messages)
  // Must be strictly alternating: user -> model -> user (length 3, NOT 4!)
  assert.strictEqual(formatted.length, 3, 'Consecutive function responses must be merged into 1 user turn')
  assert.strictEqual(formatted[0].role, 'user')
  assert.strictEqual(formatted[1].role, 'model')
  assert.strictEqual(formatted[2].role, 'user')

  // The merged user turn must have 2 functionResponse parts
  assert.strictEqual(formatted[2].parts.length, 2)
  assert.strictEqual(formatted[2].parts[0].functionResponse.name, 'list_files')
  assert.strictEqual(formatted[2].parts[1].functionResponse.name, 'read_file')
})

await runTest('1.3 Preserves thoughtSignature and thought on functionCall and text parts', () => {
  const messages = [
    {
      role: 'model',
      parts: [
        {
          functionCall: { name: 'run_test', args: {} },
          thoughtSignature: 'sig_123',
          thought: true
        }
      ]
    }
  ]

  const formatted = formatGeminiContents(messages)
  assert.strictEqual(formatted.length, 1)
  const part = formatted[0].parts[0]
  assert.strictEqual(part.functionCall?.name, 'run_test')
  assert.strictEqual(part.thoughtSignature, 'sig_123')
  assert.strictEqual(part.thought, true)
})

await runTest('1.4 Strips extraneous OpenAI-specific metadata from parts', () => {
  const messages = [
    {
      role: 'model',
      parts: [
        {
          functionCall: { name: 'list_files', args: {} },
          id: 'call_openai_99',
          tool_call_id: 'call_openai_99',
          type: 'function'
        }
      ]
    }
  ]

  const formatted = formatGeminiContents(messages)
  const fcPart = formatted[0].parts[0]
  assert.strictEqual(fcPart.id, undefined)
  assert.strictEqual(fcPart.tool_call_id, undefined)
})

// -----------------------------------------------------------------
// Group 2: Non-Streaming Standard Responses & Thought Filtering
// -----------------------------------------------------------------
console.log('\n--- Group 2: Non-Streaming Standard Responses & Thought Filtering ---')

await runTest('2.1 Successful non-streaming text generation returns text and rawModelParts', async () => {
  let requestedEndpoint = ''
  let requestedBody = null

  const mockFetch = async (url, init) => {
    requestedEndpoint = url
    requestedBody = JSON.parse(init.body)
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [{ text: 'Here is the response from Gemini.' }]
            }
          }
        ]
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  }

  const provider = new GeminiProvider({ fetchImpl: mockFetch })
  const res = await provider.sendMessage(
    [{ role: 'user', parts: [{ text: 'Hello' }] }],
    [],
    { apiKey: 'test-key-123' }
  )

  assert.ok(requestedEndpoint.includes(':generateContent?key=test-key-123'))
  assert.strictEqual(res.text, 'Here is the response from Gemini.')
  assert.strictEqual(res.functionCalls, undefined)
  assert.strictEqual(res.rawModelParts?.length, 1)
})

await runTest('2.2 Returns tool calls when candidate content includes functionCall parts', async () => {
  const mockFetch = async () => {
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: 'read_file',
                    args: { path: 'README.md' }
                  }
                }
              ]
            }
          }
        ]
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  }

  const provider = new GeminiProvider({ fetchImpl: mockFetch })
  const res = await provider.sendMessage(
    [{ role: 'user', parts: [{ text: 'Read readme' }] }],
    [{ name: 'read_file', description: 'Reads file' }],
    { apiKey: 'test-key' }
  )

  assert.ok(Array.isArray(res.functionCalls))
  assert.strictEqual(res.functionCalls.length, 1)
  assert.strictEqual(res.functionCalls[0].name, 'read_file')
  assert.deepStrictEqual(res.functionCalls[0].args, { path: 'README.md' })
})

await runTest('2.3 Thought Filtering: Excludes reasoning parts from response.text but preserves in rawModelParts', async () => {
  const mockFetch = async () => {
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                { text: 'I need to analyze the user request step by step.', thought: true },
                { text: 'Final answer: 42.' }
              ]
            }
          }
        ]
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  }

  const provider = new GeminiProvider({ fetchImpl: mockFetch })
  const res = await provider.sendMessage(
    [{ role: 'user', parts: [{ text: 'What is 6 * 7?' }] }],
    [],
    { apiKey: 'test-key' }
  )

  // Thought text must NOT be in user-visible text!
  assert.strictEqual(res.text, 'Final answer: 42.')
  assert.ok(!res.text.includes('step by step'))

  // But rawModelParts retains both for conversational reasoning continuity
  assert.strictEqual(res.rawModelParts?.length, 2)
  assert.strictEqual(res.rawModelParts[0].thought, true)
})

await runTest('2.4 Handles promptFeedback blockReason by throwing clear error', async () => {
  const mockFetch = async () => {
    return new Response(
      JSON.stringify({
        candidates: [],
        promptFeedback: { blockReason: 'SAFETY' }
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  }

  const provider = new GeminiProvider({ fetchImpl: mockFetch })
  await assert.rejects(
    async () => {
      await provider.sendMessage(
        [{ role: 'user', parts: [{ text: 'unsafe prompt' }] }],
        [],
        { apiKey: 'test-key' }
      )
    },
    (err) => {
      assert.ok(err.message.includes('Prompt was blocked: SAFETY'))
      return true
    }
  )
})

// -----------------------------------------------------------------
// Group 3: SSE Streaming Responses & Chunk Delivery
// -----------------------------------------------------------------
console.log('\n--- Group 3: SSE Streaming Responses & Chunk Delivery ---')

await runTest('3.1 Delivers text chunks incrementally through onChunk and returns matching accumulated text', async () => {
  let requestedEndpoint = ''
  const chunksReceived = []

  const sseLines = [
    'data: {"candidates": [{"content": {"parts": [{"text": "Hello"}]}}]}\n\n',
    'data: {"candidates": [{"content": {"parts": [{"text": " from"}]}}]}\n\n',
    'data: {"candidates": [{"content": {"parts": [{"text": " Gemini stream!"}]}}]}\n\n',
    'data: [DONE]\n\n'
  ]

  const mockFetch = async (url) => {
    requestedEndpoint = url
    return new Response(createMockSseStream(sseLines), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' }
    })
  }

  const provider = new GeminiProvider({ fetchImpl: mockFetch })
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

  // Verify stream endpoint was called
  assert.ok(requestedEndpoint.includes(':streamGenerateContent?alt=sse&key=test-key'))

  // Verify chunks delivered incrementally
  assert.deepStrictEqual(chunksReceived, ['Hello', ' from', ' Gemini stream!'])

  // Verify final response.text matches sum of chunks with zero duplication
  assert.strictEqual(res.text, 'Hello from Gemini stream!')
  assert.strictEqual(res.text, chunksReceived.join(''))
})

await runTest('3.2 Streaming Thought Filtering: Does NOT emit thought parts to onChunk or visible text', async () => {
  const chunksReceived = []

  const sseLines = [
    'data: {"candidates": [{"content": {"parts": [{"text": "Reasoning about algorithm...", "thought": true}]}}]}\n\n',
    'data: {"candidates": [{"content": {"parts": [{"text": "The answer is O(n)."}]}}]}\n\n'
  ]

  const mockFetch = async () => {
    return new Response(createMockSseStream(sseLines), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' }
    })
  }

  const provider = new GeminiProvider({ fetchImpl: mockFetch })
  const res = await provider.sendMessage(
    [{ role: 'user', parts: [{ text: 'Analyze' }] }],
    [],
    {
      apiKey: 'test-key',
      onChunk: (chunk) => {
        chunksReceived.push(chunk)
      }
    }
  )

  // Only non-thought chunk emitted
  assert.deepStrictEqual(chunksReceived, ['The answer is O(n).'])
  assert.strictEqual(res.text, 'The answer is O(n).')
  assert.ok(!chunksReceived.some((c) => c.includes('Reasoning')))

  // rawModelParts preserves all parts
  assert.strictEqual(res.rawModelParts?.length, 2)
  assert.strictEqual(res.rawModelParts[0].thought, true)
})

await runTest('3.3 Streaming with functionCall returns parsed tool calls alongside text', async () => {
  const sseLines = [
    'data: {"candidates": [{"content": {"parts": [{"text": "I will read the file."}]}}]}\n\n',
    'data: {"candidates": [{"content": {"parts": [{"functionCall": {"name": "read_file", "args": {"path": "main.ts"}}}]}}]}\n\n'
  ]

  const mockFetch = async () => {
    return new Response(createMockSseStream(sseLines), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' }
    })
  }

  const provider = new GeminiProvider({ fetchImpl: mockFetch })
  const res = await provider.sendMessage(
    [{ role: 'user', parts: [{ text: 'Read' }] }],
    [],
    {
      apiKey: 'test-key',
      onChunk: () => {}
    }
  )

  assert.strictEqual(res.text, 'I will read the file.')
  assert.strictEqual(res.functionCalls?.length, 1)
  assert.strictEqual(res.functionCalls[0].name, 'read_file')
  assert.deepStrictEqual(res.functionCalls[0].args, { path: 'main.ts' })
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

  const provider = new GeminiProvider({ fetchImpl: mockFetch })
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

  assert.strictEqual(fetchCalled, false, 'Fetch must not be invoked when signal is pre-aborted')
})

await runTest('4.2 In-flight cancellation immediately halts request and NEVER triggers retries', async () => {
  let fetchAttempts = 0
  const controller = new AbortController()

  const mockFetch = async () => {
    fetchAttempts++
    // Simulate user clicking Stop while fetch is pending
    controller.abort()
    const abortErr = new Error('The operation was aborted.')
    abortErr.name = 'AbortError'
    throw abortErr
  }

  const provider = new GeminiProvider({ fetchImpl: mockFetch })
  await assert.rejects(
    async () => {
      await provider.sendMessage(
        [{ role: 'user', parts: [{ text: 'Long running' }] }],
        [],
        { apiKey: 'test-key', signal: controller.signal }
      )
    },
    (err) => {
      assert.strictEqual(err.message, 'Request was stopped by user.')
      return true
    }
  )

  // Must have stopped on attempt 1 without retrying!
  assert.strictEqual(fetchAttempts, 1, 'In-flight cancellation must not trigger retries')
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
          streamController.enqueue(
            encoder.encode('data: {"candidates": [{"content": {"parts": [{"text": "Part 1"}]}}]}\n\n')
          )
        } else {
          // Abort during stream
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

  const provider = new GeminiProvider({ fetchImpl: mockFetch })
  await assert.rejects(
    async () => {
      await provider.sendMessage(
        [{ role: 'user', parts: [{ text: 'Stream' }] }],
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
  assert.strictEqual(streamCancelled, true, 'Stream reader must be cancelled on abort')
})

await runTest('4.4 Cancellation during retry delay immediately aborts sleep and cancels next request', async () => {
  let fetchAttempts = 0
  const controller = new AbortController()

  const mockFetch = async () => {
    fetchAttempts++
    // Return retryable 503 error
    return new Response('{"error": {"message": "Service overloaded"}}', {
      status: 503,
      statusText: 'Service Unavailable'
    })
  }

  const provider = new GeminiProvider({ fetchImpl: mockFetch })
  const start = Date.now()

  await assert.rejects(
    async () => {
      await provider.sendMessage(
        [{ role: 'user', parts: [{ text: 'Retry me' }] }],
        [],
        {
          apiKey: 'test-key',
          signal: controller.signal,
          onRetry: () => {
            // User clicks Stop as soon as retry event fires!
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
  assert.strictEqual(fetchAttempts, 1, 'Second fetch attempt must not occur after cancellation during delay')
  assert.ok(elapsed < 800, `Expected cancellation to break sleep quickly, took ${elapsed}ms`)
})

// -----------------------------------------------------------------
// Group 5: Error Handling & Retry Mechanics
// -----------------------------------------------------------------
console.log('\n--- Group 5: Error Handling & Retry Mechanics ---')

await runTest('5.1 Non-retryable auth error (401) throws user-friendly message without retry', async () => {
  let fetchAttempts = 0
  const mockFetch = async () => {
    fetchAttempts++
    return new Response('{"error": {"message": "API key not valid"}}', {
      status: 401,
      statusText: 'Unauthorized'
    })
  }

  const provider = new GeminiProvider({ fetchImpl: mockFetch })
  await assert.rejects(
    async () => {
      await provider.sendMessage(
        [{ role: 'user', parts: [{ text: 'Auth test' }] }],
        [],
        { apiKey: 'bad-key' }
      )
    },
    (err) => {
      assert.ok(err.message.includes('Invalid Google Gemini API key'))
      return true
    }
  )

  assert.strictEqual(fetchAttempts, 1, 'Auth errors must not be retried')
})

await runTest('5.2 Non-retryable model not found (404) throws without retry', async () => {
  let fetchAttempts = 0
  const mockFetch = async () => {
    fetchAttempts++
    return new Response('{"error": {"message": "models/unknown-model is not found"}}', {
      status: 404,
      statusText: 'Not Found'
    })
  }

  const provider = new GeminiProvider({ fetchImpl: mockFetch })
  await assert.rejects(
    async () => {
      await provider.sendMessage(
        [{ role: 'user', parts: [{ text: 'Model test' }] }],
        [],
        { apiKey: 'test-key', modelName: 'unknown-model' }
      )
    },
    (err) => {
      assert.ok(err.message.includes('was not found or has been deprecated'))
      return true
    }
  )

  assert.strictEqual(fetchAttempts, 1)
})

await runTest('5.3 Retryable rate limit (429) retries and respects Retry-After header', async () => {
  let fetchAttempts = 0
  const retryCalls = []

  const mockFetch = async () => {
    fetchAttempts++
    if (fetchAttempts === 1) {
      return new Response('{"error": {"message": "Resource exhausted"}}', {
        status: 429,
        statusText: 'Too Many Requests',
        headers: { 'Retry-After': '1' } // 1 second
      })
    }
    return new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'Recovered after 429' }] } }]
      }),
      { status: 200 }
    )
  }

  const provider = new GeminiProvider({ fetchImpl: mockFetch })
  const res = await provider.sendMessage(
    [{ role: 'user', parts: [{ text: 'Rate limit test' }] }],
    [],
    {
      apiKey: 'test-key',
      onRetry: (attempt, maxRetries, delayMs, reason) => {
        retryCalls.push({ attempt, maxRetries, delayMs, reason })
      }
    }
  )

  assert.strictEqual(fetchAttempts, 2)
  assert.strictEqual(res.text, 'Recovered after 429')
  assert.strictEqual(retryCalls.length, 1)
  assert.strictEqual(retryCalls[0].attempt, 1)
  assert.strictEqual(retryCalls[0].delayMs, 1000, 'Expected delay to respect Retry-After: 1s')
})

await runTest('5.4 Retryable server error (503) succeeds on second attempt', async () => {
  let fetchAttempts = 0
  const mockFetch = async () => {
    fetchAttempts++
    if (fetchAttempts === 1) {
      return new Response('{"error": {"message": "Service unavailable"}}', {
        status: 503,
        statusText: 'Service Unavailable'
      })
    }
    return new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'Success on retry' }] } }]
      }),
      { status: 200 }
    )
  }

  const provider = new GeminiProvider({ fetchImpl: mockFetch })
  const res = await provider.sendMessage(
    [{ role: 'user', parts: [{ text: 'Server error test' }] }],
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
    return new Response('{"error": {"message": "High demand, overloaded"}}', {
      status: 503,
      statusText: 'Service Unavailable'
    })
  }

  const provider = new GeminiProvider({ fetchImpl: mockFetch })
  await assert.rejects(
    async () => {
      await provider.sendMessage(
        [{ role: 'user', parts: [{ text: 'Exhaust retries' }] }],
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
console.log(`GEMINI PROVIDER TEST RESULTS: ${passed} passed, ${failed} failed`)
console.log(`=================================================================\n`)

if (failed > 0) {
  process.exit(1)
}
