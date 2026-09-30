// scratch/test_provider_normalization.mjs
// Phase 3 — Task 2: Provider Normalization & Shared Adapter Utilities Test Suite
//
// Tests:
// 1. OpenAI-compatible message serialization (messages, tools, role mapping, ID preservation, multi-tool pairing)
// 2. Tool-call parsing & robust tool response serialization (malformed JSON, non-object payloads, circular protection)
// 3. Shared error classification (distinguishes user cancellation from genuine timeouts, never retries user cancellation)
// 4. Retry delay calculation (RFC 7231 Retry-After parsing, bounds clamping, fallback linear & exponential backoff)

import assert from 'node:assert'
import esbuild from 'esbuild'

console.log('=================================================================')
console.log('PHASE 3 — TASK 2: PROVIDER NORMALIZATION & SHARED UTILITIES SUITE')
console.log('=================================================================\n')

// 1. Transpile production providerUtils module with esbuild
const bundle = await esbuild.build({
  entryPoints: ['src/renderer/src/services/ai/providerUtils.ts'],
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'browser',
  target: 'es2022'
})

const {
  serializeOpenAIMessages,
  serializeOpenAITools,
  serializeToolResponse,
  parseOpenAIToolCalls,
  parseRetryAfterHeader,
  calculateRetryDelay,
  classifyProviderError,
  isRetryableProviderError
} = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'))

let passed = 0
let failed = 0

function runTest(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failed++
    console.error(`  ✗ ${name}`)
    console.error(`    ${err instanceof Error ? err.stack || err.message : String(err)}`)
  }
}

// -----------------------------------------------------------------
// Group 1: OpenAI-Compatible Message Serialization
// -----------------------------------------------------------------
console.log('\n--- Group 1: OpenAI-Compatible Message Serialization ---')

runTest('1.1 Prepends systemInstruction as role: "system"', () => {
  const result = serializeOpenAIMessages(
    [{ role: 'user', parts: [{ text: 'Hello' }] }],
    'You are a helpful coding assistant.'
  )
  assert.strictEqual(result.length, 2)
  assert.strictEqual(result[0].role, 'system')
  assert.strictEqual(result[0].content, 'You are a helpful coding assistant.')
  assert.strictEqual(result[1].role, 'user')
  assert.strictEqual(result[1].content, 'Hello')
})

runTest('1.2 Ignores empty or whitespace-only systemInstruction', () => {
  const result = serializeOpenAIMessages(
    [{ role: 'user', parts: [{ text: 'Hi' }] }],
    '   '
  )
  assert.strictEqual(result.length, 1)
  assert.strictEqual(result[0].role, 'user')
})

runTest('1.3 Serializes user messages with multiple text parts correctly', () => {
  const result = serializeOpenAIMessages([
    {
      role: 'user',
      parts: [{ text: 'First line.' }, { text: 'Second line.' }]
    }
  ])
  assert.strictEqual(result.length, 1)
  assert.strictEqual(result[0].role, 'user')
  assert.strictEqual(result[0].content, 'First line.\nSecond line.')
})

runTest('1.4 Serializes model message with text only', () => {
  const result = serializeOpenAIMessages([
    { role: 'model', parts: [{ text: 'Assistant answer' }] }
  ])
  assert.strictEqual(result.length, 1)
  assert.strictEqual(result[0].role, 'assistant')
  assert.strictEqual(result[0].content, 'Assistant answer')
  assert.strictEqual(result[0].tool_calls, undefined)
})

runTest('1.5 Serializes model message with tool_calls only', () => {
  const result = serializeOpenAIMessages([
    {
      role: 'model',
      parts: [
        {
          functionCall: {
            name: 'list_files',
            args: { maxDepth: 2 }
          },
          tool_call_id: 'call_custom_1'
        }
      ]
    }
  ])
  assert.strictEqual(result.length, 1)
  assert.strictEqual(result[0].role, 'assistant')
  assert.strictEqual(result[0].content, null)
  assert.ok(Array.isArray(result[0].tool_calls))
  assert.strictEqual(result[0].tool_calls.length, 1)
  assert.strictEqual(result[0].tool_calls[0].id, 'call_custom_1')
  assert.strictEqual(result[0].tool_calls[0].type, 'function')
  assert.strictEqual(result[0].tool_calls[0].function.name, 'list_files')
  assert.strictEqual(result[0].tool_calls[0].function.arguments, JSON.stringify({ maxDepth: 2 }))
})

runTest('1.6 Serializes model message with both text and tool_calls', () => {
  const result = serializeOpenAIMessages([
    {
      role: 'model',
      parts: [
        { text: 'Let me inspect the workspace files.' },
        {
          functionCall: {
            name: 'list_files',
            args: {}
          }
        }
      ]
    }
  ])
  assert.strictEqual(result.length, 1)
  assert.strictEqual(result[0].role, 'assistant')
  assert.strictEqual(result[0].content, 'Let me inspect the workspace files.')
  assert.strictEqual(result[0].tool_calls?.length, 1)
  assert.strictEqual(result[0].tool_calls[0].function.name, 'list_files')
})

runTest('1.7 Correctly pairs multiple tool calls with distinct function responses', () => {
  const messages = [
    { role: 'user', parts: [{ text: 'Read both files' }] },
    {
      role: 'model',
      parts: [
        {
          functionCall: { name: 'read_file', args: { path: 'a.txt' } },
          tool_call_id: 'call_read_a'
        },
        {
          functionCall: { name: 'read_file', args: { path: 'b.txt' } },
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
            response: { name: 'read_file', content: { text: 'content of A' } }
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
            response: { name: 'read_file', content: { text: 'content of B' } }
          }
        }
      ]
    }
  ]

  const result = serializeOpenAIMessages(messages)
  assert.strictEqual(result.length, 4)
  assert.strictEqual(result[1].role, 'assistant')
  assert.strictEqual(result[1].tool_calls?.length, 2)
  assert.strictEqual(result[1].tool_calls[0].id, 'call_read_a')
  assert.strictEqual(result[1].tool_calls[1].id, 'call_read_b')

  assert.strictEqual(result[2].role, 'tool')
  assert.strictEqual(result[2].tool_call_id, 'call_read_a')
  assert.strictEqual(result[2].name, 'read_file')
  assert.ok(result[2].content?.includes('content of A'))

  assert.strictEqual(result[3].role, 'tool')
  assert.strictEqual(result[3].tool_call_id, 'call_read_b')
  assert.strictEqual(result[3].name, 'read_file')
  assert.ok(result[3].content?.includes('content of B'))
})

runTest('1.8 Fallback resolution matches unconsumed tool call IDs from assistant turn', () => {
  // Simulates case where functionResponse part omitted tool_call_id
  const messages = [
    {
      role: 'model',
      parts: [
        {
          functionCall: { name: 'list_files', args: {} }
          // tool_call_id omitted on model part
        },
        {
          functionCall: { name: 'read_file', args: { path: 'x.ts' } }
        }
      ]
    },
    {
      role: 'function',
      parts: [
        {
          // tool_call_id omitted on function response part
          functionResponse: {
            name: 'list_files',
            response: { name: 'list_files', content: { files: ['x.ts'] } }
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
            response: { name: 'read_file', content: { text: 'code' } }
          }
        }
      ]
    }
  ]

  const result = serializeOpenAIMessages(messages)
  assert.strictEqual(result.length, 3)
  const assistantCalls = result[0].tool_calls
  assert.strictEqual(assistantCalls.length, 2)

  // Verify function responses adopted matching IDs rather than generic hardcoded collisions
  assert.strictEqual(result[1].tool_call_id, assistantCalls[0].id)
  assert.strictEqual(result[2].tool_call_id, assistantCalls[1].id)
  assert.notStrictEqual(result[1].tool_call_id, result[2].tool_call_id)
})

runTest('1.9 serializeOpenAITools maps FunctionDeclaration schemas accurately', () => {
  const tools = [
    {
      name: 'edit_file',
      description: 'Edits an existing file',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' }
        },
        required: ['path']
      }
    }
  ]

  const serialized = serializeOpenAITools(tools)
  assert.ok(Array.isArray(serialized))
  assert.strictEqual(serialized.length, 1)
  assert.strictEqual(serialized[0].type, 'function')
  assert.strictEqual(serialized[0].function.name, 'edit_file')
  assert.strictEqual(serialized[0].function.description, 'Edits an existing file')
  assert.strictEqual(serialized[0].function.parameters?.type, 'object')
})

runTest('1.10 serializeOpenAITools returns undefined for empty or missing tools', () => {
  assert.strictEqual(serializeOpenAITools([]), undefined)
  assert.strictEqual(serializeOpenAITools(undefined), undefined)
})

// -----------------------------------------------------------------
// Group 2: Tool-Call Parsing & Robust Tool-Response Serialization
// -----------------------------------------------------------------
console.log('\n--- Group 2: Tool-Call Parsing & Robust Tool-Response Serialization ---')

runTest('2.1 parseOpenAIToolCalls parses valid JSON string arguments', () => {
  const raw = [
    {
      id: 'call_123',
      type: 'function',
      function: {
        name: 'read_file',
        arguments: '{"path": "src/index.ts", "line": 42}'
      }
    }
  ]

  const { functionCalls, rawModelParts } = parseOpenAIToolCalls(raw)
  assert.strictEqual(functionCalls.length, 1)
  assert.strictEqual(functionCalls[0].name, 'read_file')
  assert.deepStrictEqual(functionCalls[0].args, { path: 'src/index.ts', line: 42 })

  assert.strictEqual(rawModelParts.length, 1)
  assert.strictEqual(rawModelParts[0].id, 'call_123')
  assert.strictEqual(rawModelParts[0].tool_call_id, 'call_123')
  assert.deepStrictEqual(rawModelParts[0].functionCall?.args, { path: 'src/index.ts', line: 42 })
})

runTest('2.2 parseOpenAIToolCalls handles pre-parsed object arguments', () => {
  const raw = [
    {
      id: 'call_456',
      type: 'function',
      function: {
        name: 'list_files',
        arguments: { maxDepth: 3 }
      }
    }
  ]

  const { functionCalls } = parseOpenAIToolCalls(raw)
  assert.strictEqual(functionCalls.length, 1)
  assert.deepStrictEqual(functionCalls[0].args, { maxDepth: 3 })
})

runTest('2.3 parseOpenAIToolCalls safely falls back on malformed or empty JSON without throwing', () => {
  const raw = [
    {
      id: 'call_bad_1',
      function: {
        name: 'broken_tool',
        arguments: '{"path": broken json string...'
      }
    },
    {
      id: 'call_bad_2',
      function: {
        name: 'empty_args',
        arguments: ''
      }
    }
  ]

  const { functionCalls } = parseOpenAIToolCalls(raw)
  assert.strictEqual(functionCalls.length, 2)
  assert.strictEqual(functionCalls[0].name, 'broken_tool')
  assert.deepStrictEqual(functionCalls[0].args, {})
  assert.strictEqual(functionCalls[1].name, 'empty_args')
  assert.deepStrictEqual(functionCalls[1].args, {})
})

runTest('2.4 parseOpenAIToolCalls handles array or primitive arguments cleanly', () => {
  const raw = [
    {
      id: 'call_arr',
      function: {
        name: 'array_arg',
        arguments: '[1, 2, 3]'
      }
    },
    {
      id: 'call_prim',
      function: {
        name: 'num_arg',
        arguments: '123'
      }
    }
  ]

  const { functionCalls } = parseOpenAIToolCalls(raw)
  assert.strictEqual(functionCalls.length, 2)
  assert.deepStrictEqual(functionCalls[0].args, { items: [1, 2, 3] })
  assert.deepStrictEqual(functionCalls[1].args, { value: 123 })
})

runTest('2.5 parseOpenAIToolCalls handles empty, null, or non-array inputs gracefully', () => {
  assert.deepStrictEqual(parseOpenAIToolCalls(null), { functionCalls: [], rawModelParts: [] })
  assert.deepStrictEqual(parseOpenAIToolCalls(undefined), { functionCalls: [], rawModelParts: [] })
  assert.deepStrictEqual(parseOpenAIToolCalls({}), { functionCalls: [], rawModelParts: [] })
  assert.deepStrictEqual(parseOpenAIToolCalls([]), { functionCalls: [], rawModelParts: [] })
})

runTest('2.6 serializeToolResponse serializes orchestrator wrapped format with object content', () => {
  const input = {
    name: 'read_file',
    content: {
      success: true,
      text: 'line 1\nline 2'
    }
  }
  const result = serializeToolResponse(input)
  const parsed = JSON.parse(result)
  assert.strictEqual(parsed.success, true)
  assert.strictEqual(parsed.text, 'line 1\nline 2')
})

runTest('2.7 serializeToolResponse returns string content directly without double quoting', () => {
  const input = {
    name: 'run_command',
    content: 'Process finished with exit code 0'
  }
  const result = serializeToolResponse(input)
  assert.strictEqual(result, 'Process finished with exit code 0')
})

runTest('2.8 serializeToolResponse handles bare objects without "content" key', () => {
  const input = {
    success: true,
    created: 'file.txt',
    bytes: 256
  }
  const result = serializeToolResponse(input)
  const parsed = JSON.parse(result)
  assert.strictEqual(parsed.success, true)
  assert.strictEqual(parsed.bytes, 256)
})

runTest('2.9 serializeToolResponse handles raw primitives, null, and undefined safely', () => {
  assert.strictEqual(serializeToolResponse(null), '{}')
  assert.strictEqual(serializeToolResponse(undefined), '{}')
  assert.strictEqual(serializeToolResponse('raw string value'), 'raw string value')
  assert.strictEqual(serializeToolResponse(12345), '12345')
  assert.strictEqual(serializeToolResponse(true), 'true')
  // Must never return the literal string "undefined"
  assert.notStrictEqual(serializeToolResponse(undefined), 'undefined')
})

runTest('2.10 serializeToolResponse catches circular structures without throwing', () => {
  const circular = { name: 'loop' }
  circular.self = circular
  const result = serializeToolResponse(circular)
  assert.ok(typeof result === 'string')
  assert.ok(result.length > 0)
})

// -----------------------------------------------------------------
// Group 3: Shared Provider Error Classification
// -----------------------------------------------------------------
console.log('\n--- Group 3: Shared Provider Error Classification ---')

runTest('3.1 Classifies user cancellation via signal.aborted as non-retryable', () => {
  const controller = new AbortController()
  controller.abort()

  const err = new Error('The operation was aborted.')
  const classification = classifyProviderError(err, { signal: controller.signal })

  assert.strictEqual(classification.isUserCancellation, true)
  assert.strictEqual(classification.isTimeout, false)
  assert.strictEqual(classification.isRetryable, false, 'User cancellation must NEVER be retryable!')
  assert.strictEqual(classification.reason, 'user_cancellation')
  assert.strictEqual(classification.userFriendlyMessage, 'Request was stopped by user.')
  assert.strictEqual(isRetryableProviderError(err, { signal: controller.signal }), false)
})

runTest('3.2 Classifies AbortError without timeout keywords as user cancellation', () => {
  const abortErr = new Error('The user stopped the request')
  abortErr.name = 'AbortError'

  const classification = classifyProviderError(abortErr)
  assert.strictEqual(classification.isUserCancellation, true)
  assert.strictEqual(classification.isTimeout, false)
  assert.strictEqual(classification.isRetryable, false)
  assert.strictEqual(classification.reason, 'user_cancellation')
})

runTest('3.3 Differentiates request timeout from user cancellation when flagged as timeout', () => {
  const timeoutErr = new Error('The operation was aborted.')
  timeoutErr.name = 'AbortError'

  const classification = classifyProviderError(timeoutErr, {
    isTimeout: true,
    providerName: 'OpenRouter'
  })

  assert.strictEqual(classification.isUserCancellation, false)
  assert.strictEqual(classification.isTimeout, true)
  assert.strictEqual(classification.isRetryable, true)
  assert.strictEqual(classification.reason, 'timeout')
  assert.ok(classification.userFriendlyMessage.includes('Request timed out'))
  assert.ok(classification.userFriendlyMessage.includes('OpenRouter'))
})

runTest('3.4 Identifies HTTP 408 and 504 status codes as retryable timeouts', () => {
  const c408 = classifyProviderError(new Error('Gateway timeout'), { status: 408 })
  assert.strictEqual(c408.isTimeout, true)
  assert.strictEqual(c408.isRetryable, true)

  const c504 = classifyProviderError(new Error('Gateway timeout'), { status: 504 })
  assert.strictEqual(c504.isTimeout, true)
  assert.strictEqual(c504.isRetryable, true)
})

runTest('3.5 Identifies HTTP 429 and resource_exhausted as retryable rate limits', () => {
  const c429 = classifyProviderError(new Error('Too Many Requests'), {
    status: 429,
    retryAfterHeader: '10',
    providerName: 'Gemini'
  })
  assert.strictEqual(c429.isRateLimit, true)
  assert.strictEqual(c429.isRetryable, true)
  assert.strictEqual(c429.retryAfterMs, 10000)
  assert.ok(c429.userFriendlyMessage.includes('rate limit reached'))
  assert.ok(c429.userFriendlyMessage.includes('Gemini'))
})

runTest('3.6 Identifies 401/403 and api key errors as non-retryable auth failures', () => {
  const authErr = classifyProviderError(new Error('Unauthorized: Invalid API key'), {
    status: 401,
    providerName: 'NVIDIA NIM'
  })
  assert.strictEqual(authErr.isAuthError, true)
  assert.strictEqual(authErr.isRetryable, false, 'Auth errors must not be retried')
  assert.ok(authErr.userFriendlyMessage.includes('Invalid NVIDIA NIM API key'))
})

runTest('3.7 Identifies 404/410 model errors as non-retryable model not found', () => {
  const notFound = classifyProviderError(new Error('Model not found'), {
    status: 404,
    modelName: 'gpt-retired'
  })
  assert.strictEqual(notFound.isNotFound, true)
  assert.strictEqual(notFound.isRetryable, false)
  assert.ok(notFound.userFriendlyMessage.includes("'gpt-retired'"))
})

runTest('3.8 Identifies tool calling rejection as non-retryable configuration failure', () => {
  const toolErr = classifyProviderError(new Error('Model does not support tools or function calling'), {
    status: 400,
    modelName: 'meta/llama-3-8b'
  })
  assert.strictEqual(toolErr.isToolCallingUnsupported, true)
  assert.strictEqual(toolErr.isRetryable, false)
  assert.ok(toolErr.userFriendlyMessage.includes('does not support tool calling'))
})

runTest('3.9 Identifies 500/502/503 and network overloads as retryable server errors', () => {
  const s500 = classifyProviderError(new Error('Internal server error'), { status: 500 })
  assert.strictEqual(s500.isRetryable, true)
  assert.strictEqual(s500.reason, 'server_error')

  const s503 = classifyProviderError(new Error('Service Unavailable: overloaded'), { status: 503 })
  assert.strictEqual(s503.isRetryable, true)
})

runTest('3.10 Handles raw IPC error objects with status and errorDetails fields', () => {
  const ipcError = {
    status: 429,
    error: 'rate_limited',
    errorDetails: 'Too many requests for free tier'
  }
  const classified = classifyProviderError(ipcError, { providerName: 'OpenCode' })
  assert.strictEqual(classified.isRateLimit, true)
  assert.strictEqual(classified.isRetryable, true)
  assert.strictEqual(classified.status, 429)
})

// -----------------------------------------------------------------
// Group 4: Retry Delay Calculation & Retry-After Header Parsing
// -----------------------------------------------------------------
console.log('\n--- Group 4: Retry Delay Calculation & Retry-After Header Parsing ---')

runTest('4.1 parseRetryAfterHeader parses integer delta-seconds strings', () => {
  assert.strictEqual(parseRetryAfterHeader('30'), 30000)
  assert.strictEqual(parseRetryAfterHeader('0'), 0)
  assert.strictEqual(parseRetryAfterHeader('120'), 120000)
})

runTest('4.2 parseRetryAfterHeader parses numeric inputs', () => {
  assert.strictEqual(parseRetryAfterHeader(15), 15000)
  assert.strictEqual(parseRetryAfterHeader(2.5), 2500)
})

runTest('4.3 parseRetryAfterHeader parses RFC 1123 HTTP date formats', () => {
  // 10 seconds in the future
  const futureDate = new Date(Date.now() + 10000).toUTCString()
  const delay = parseRetryAfterHeader(futureDate)
  assert.ok(typeof delay === 'number')
  assert.ok(delay >= 8000 && delay <= 12000, `Expected ~10000ms delay, got ${delay}`)
})

runTest('4.4 parseRetryAfterHeader returns null for invalid or negative values', () => {
  assert.strictEqual(parseRetryAfterHeader(''), null)
  assert.strictEqual(parseRetryAfterHeader(null), null)
  assert.strictEqual(parseRetryAfterHeader(undefined), null)
  assert.strictEqual(parseRetryAfterHeader('-10'), null)
  assert.strictEqual(parseRetryAfterHeader(-5), null)
  assert.strictEqual(parseRetryAfterHeader('invalid-string'), null)
  assert.strictEqual(parseRetryAfterHeader(NaN), null)
})

runTest('4.5 calculateRetryDelay respects valid Retry-After header', () => {
  const delay = calculateRetryDelay(0, '5', { minDelayMs: 500, maxDelayMs: 30000 })
  assert.strictEqual(delay, 5000)
})

runTest('4.6 calculateRetryDelay clamps excessive Retry-After to maxDelayMs', () => {
  // 99999 seconds would be > 27 hours; must clamp to maxDelayMs
  const delay = calculateRetryDelay(0, '99999', { maxDelayMs: 30000 })
  assert.strictEqual(delay, 30000)
})

runTest('4.7 calculateRetryDelay clamps zero or sub-minimum Retry-After to minDelayMs', () => {
  const delay = calculateRetryDelay(0, '0', { minDelayMs: 1000 })
  assert.strictEqual(delay, 1000)
})

runTest('4.8 calculateRetryDelay uses linear backoff fallback when header is missing', () => {
  // attempt 0 -> (0 + 1) * 1000 = 1000ms
  assert.strictEqual(calculateRetryDelay(0, null, { baseDelayMs: 1000 }), 1000)
  // attempt 1 -> (1 + 1) * 1000 = 2000ms
  assert.strictEqual(calculateRetryDelay(1, null, { baseDelayMs: 1000 }), 2000)
  // attempt 2 -> (2 + 1) * 1000 = 3000ms
  assert.strictEqual(calculateRetryDelay(2, null, { baseDelayMs: 1000 }), 3000)
})

runTest('4.9 calculateRetryDelay supports exponential backoff when configured', () => {
  const opts = { backoffType: 'exponential', baseDelayMs: 1000, maxDelayMs: 30000 }
  // 1000 * 2^0 = 1000ms
  assert.strictEqual(calculateRetryDelay(0, null, opts), 1000)
  // 1000 * 2^1 = 2000ms
  assert.strictEqual(calculateRetryDelay(1, null, opts), 2000)
  // 1000 * 2^2 = 4000ms
  assert.strictEqual(calculateRetryDelay(2, null, opts), 4000)
  // 1000 * 2^3 = 8000ms
  assert.strictEqual(calculateRetryDelay(3, null, opts), 8000)
})

runTest('4.10 calculateRetryDelay clamps high attempt exponential backoff to maxDelayMs', () => {
  const opts = { backoffType: 'exponential', baseDelayMs: 1000, maxDelayMs: 15000 }
  // 1000 * 2^5 = 32000ms -> clamped to 15000ms
  assert.strictEqual(calculateRetryDelay(5, null, opts), 15000)
})

console.log(`\n=================================================================`)
console.log(`PROVIDER NORMALIZATION TEST RESULTS: ${passed} passed, ${failed} failed`)
console.log(`=================================================================\n`)

if (failed > 0) {
  process.exit(1)
}
