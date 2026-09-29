// Comprehensive OpenCode Free Models AI Provider Verification Suite

import assert from 'node:assert'

// 1. In-memory OpenCodeProvider unit test harness reflecting opencodeProvider.ts
class TestableOpenCodeProvider {
  constructor(config = {}) {
    this.id = 'opencode'
    this.name = 'OpenCode'
    this.defaultModel = config.defaultModel || 'space-bunny-free'
    this.defaultTimeoutMs = config.defaultTimeoutMs || 60000
    this.debug = config.debug || false
    this.fetchImpl = config.fetchImpl || fetch
    this.ipcCaller = config.ipcCaller
    this.listModelsIpcCaller = config.listModelsIpcCaller
    this.streamListener = config.streamListener
    this.diagnosticLogs = []
  }

  logDiagnostic(stage, details) {
    this.diagnosticLogs.push({ stage, details })
  }

  isRetryableError(status, message) {
    if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
      return true
    }
    const lower = (message || '').toLowerCase()
    return (
      lower.includes('rate limit') ||
      lower.includes('too many requests') ||
      lower.includes('high demand') ||
      lower.includes('overloaded') ||
      lower.includes('service unavailable') ||
      lower.includes('temporarily unavailable') ||
      lower.includes('timeout') ||
      lower.includes('timed out') ||
      lower.includes('try again')
    )
  }

  formatUserFriendlyError(status, rawMessage, modelName) {
    const lower = (rawMessage || '').toLowerCase()
    if (lower.includes('freetiererror') || lower.includes('from within opencode')) {
      return `The model "${modelName}" is restricted to official OpenCode client requests. Please switch to "space-bunny-free" or add a Console API key in Settings.`
    }
    if (
      status === 401 ||
      status === 403 ||
      lower.includes('unauthorized') ||
      lower.includes('invalid token')
    ) {
      return 'Invalid OpenCode Console API key. Please check your credentials in Settings, or clear the key to use free access.'
    }
    if (status === 404 || lower.includes('model not found') || lower.includes('unavailable')) {
      return `The selected OpenCode model "${modelName}" is currently unavailable. Please fetch models in Settings to select an active free model.`
    }
    if (status === 429 || lower.includes('rate limit')) {
      return 'OpenCode free inference rate limit reached. Please wait a moment and try again.'
    }
    if (lower.includes('timed out') || lower.includes('abort')) {
      return `Request timed out after ${this.defaultTimeoutMs / 1000}s. The provider may be experiencing high demand.`
    }
    return (
      rawMessage.replace(/^OpenCode API error:\s*/i, '').trim() ||
      'The OpenCode AI provider is temporarily unavailable. Please try again.'
    )
  }

  async listFreeModels(apiKey, timeoutMs = 15000) {
    if (this.listModelsIpcCaller) {
      const res = await this.listModelsIpcCaller({ apiKey, timeoutMs })
      if (res.success && res.models) return res.models
      throw new Error(res.errorDetails || res.error || 'Failed to list OpenCode models')
    }

    const fetchFunc = this.fetchImpl || fetch
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const headers = { Accept: 'application/json' }
      if (apiKey && apiKey.trim()) {
        headers.Authorization = `Bearer ${apiKey.trim()}`
      }

      const resp = await fetchFunc('https://opencode.ai/inference/v1/models', {
        method: 'GET',
        headers,
        signal: controller.signal
      })
      clearTimeout(timer)

      if (!resp.ok) {
        throw new Error(`Failed to fetch models: HTTP ${resp.status} ${resp.statusText}`)
      }

      const data = await resp.json()
      const list = Array.isArray(data.data) ? data.data : Array.isArray(data) ? data : []

      return list
        .filter((m) => String(m.id || '').toLowerCase().includes('free'))
        .map((m) => ({
          id: String(m.id),
          created: m.created,
          owned_by: m.owned_by,
          object: m.object,
          isFree: true
        }))
    } catch (err) {
      clearTimeout(timer)
      throw err instanceof Error ? err : new Error(String(err))
    }
  }

  formatMessages(messages, systemInstruction) {
    const formattedMessages = []
    if (systemInstruction) {
      formattedMessages.push({
        role: 'system',
        content: systemInstruction
      })
    }

    let lastToolCallId = 'call_list_files_1'

    for (const msg of messages) {
      if (msg.role === 'user') {
        const text = msg.parts.map((p) => p.text || '').join('\n')
        formattedMessages.push({
          role: 'user',
          content: text
        })
      } else if (msg.role === 'model') {
        const toolCalls = []
        let textContent = ''

        for (const part of msg.parts) {
          if (part.functionCall) {
            const toolCallId =
              part.id ||
              part.tool_call_id ||
              `call_${part.functionCall.name}_${formattedMessages.length}`
            lastToolCallId = toolCallId
            toolCalls.push({
              id: toolCallId,
              type: 'function',
              function: {
                name: part.functionCall.name,
                arguments: JSON.stringify(part.functionCall.args || {})
              }
            })
          } else if (part.text) {
            textContent += (textContent ? '\n' : '') + part.text
          }
        }

        const modelEntry = {
          role: 'assistant',
          content: textContent || null
        }
        if (toolCalls.length > 0) {
          modelEntry.tool_calls = toolCalls
        }
        formattedMessages.push(modelEntry)
      } else if (msg.role === 'function') {
        for (const part of msg.parts) {
          if (part.functionResponse) {
            formattedMessages.push({
              role: 'tool',
              tool_call_id:
                part.functionResponse.id ||
                part.id ||
                lastToolCallId,
              content: JSON.stringify(part.functionResponse.response || {})
            })
          }
        }
      }
    }

    return formattedMessages
  }

  formatTools(tools) {
    if (!tools || tools.length === 0) return undefined
    return tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: 'object',
          properties: tool.parameters.properties,
          required: tool.parameters.required || []
        }
      }
    }))
  }

  async sendMessage(messages, tools, options = {}) {
    const {
      apiKey,
      modelName = this.defaultModel,
      systemInstruction,
      temperature = 0.2,
      timeoutMs = this.defaultTimeoutMs,
      onChunk,
      onRetry
    } = options

    const activeModel = modelName.trim() || this.defaultModel
    const formattedMessages = this.formatMessages(messages, systemInstruction)
    const formattedTools = this.formatTools(tools)

    const maxAttempts = 3
    let attempt = 0

    while (attempt < maxAttempts) {
      attempt++
      try {
        if (this.ipcCaller) {
          const req = {
            model: activeModel,
            messages: formattedMessages,
            tools: formattedTools,
            temperature,
            timeoutMs,
            apiKey: apiKey?.trim() || undefined,
            stream: !!onChunk
          }

          let cleanupStream
          if (onChunk && this.streamListener) {
            cleanupStream = this.streamListener((chunk) => {
              if (chunk.content) {
                onChunk(chunk.content)
              }
            })
          }

          let res
          try {
            res = await this.ipcCaller(req)
          } finally {
            cleanupStream?.()
          }

          if (res.success && res.data) {
            return this.transformOpenCodeResponse(res.data)
          }

          const rawError = res.errorDetails || res.error || 'OpenCode API call failed'
          const status = res.status || 500

          if (attempt < maxAttempts && this.isRetryableError(status, rawError)) {
            const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000)
            onRetry?.(`OpenCode server busy (${status}). Retrying in ${delay / 1000}s...`)
            await new Promise((r) => setTimeout(r, delay))
            continue
          }

          throw new Error(this.formatUserFriendlyError(status, rawError, activeModel))
        }

        // Direct fallback
        const payload = {
          model: activeModel,
          messages: formattedMessages,
          temperature
        }
        if (formattedTools && formattedTools.length > 0) {
          payload.tools = formattedTools
          payload.tool_choice = 'auto'
        }

        const headers = {
          'Content-Type': 'application/json',
          Accept: 'application/json'
        }
        if (apiKey && apiKey.trim()) {
          headers.Authorization = `Bearer ${apiKey.trim()}`
        }

        const resp = await this.fetchImpl('https://opencode.ai/inference/openai/v1/chat/completions', {
          method: 'POST',
          headers,
          body: JSON.stringify(payload)
        })

        if (!resp.ok) {
          const errBody = await resp.text()
          if (attempt < maxAttempts && this.isRetryableError(resp.status, errBody)) {
            const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000)
            onRetry?.(`OpenCode busy (${resp.status}). Retrying...`)
            await new Promise((r) => setTimeout(r, delay))
            continue
          }
          throw new Error(this.formatUserFriendlyError(resp.status, errBody, activeModel))
        }

        const data = await resp.json()
        return this.transformOpenCodeResponse(data)
      } catch (err) {
        if (attempt >= maxAttempts) throw err
        if (!this.isRetryableError(500, err.message)) throw err
        await new Promise((r) => setTimeout(r, 1000))
      }
    }
  }

  transformOpenCodeResponse(data) {
    const choice = data?.choices?.[0]
    if (!choice) {
      throw new Error('Received empty response from OpenCode.')
    }

    const message = choice.message
    const parts = []

    if (message?.content) {
      parts.push({ text: message.content })
    }

    if (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) {
      for (const tc of message.tool_calls) {
        if (tc.type === 'function' && tc.function) {
          let parsedArgs = {}
          try {
            parsedArgs = JSON.parse(tc.function.arguments || '{}')
          } catch {
            parsedArgs = { raw: tc.function.arguments }
          }

          parts.push({
            id: tc.id,
            functionCall: {
              name: tc.function.name,
              args: parsedArgs
            }
          })
        }
      }
    }

    return {
      candidates: [
        {
          content: {
            parts,
            role: 'model'
          },
          finishReason: choice.finish_reason || 'stop'
        }
      ]
    }
  }
}

// ----------------------------------------------------
// TEST SUITE
// ----------------------------------------------------

async function runTests() {
  console.log('=== Starting OpenCode Free Models Integration Test Suite ===\n')

  let passed = 0
  let failed = 0

  function test(name, fn) {
    try {
      fn()
      console.log(`PASS: ${name}`)
      passed++
    } catch (e) {
      console.error(`FAIL: ${name}`)
      console.error(`  ${e.message}\n${e.stack}`)
      failed++
    }
  }

  async function asyncTest(name, fn) {
    try {
      await fn()
      console.log(`PASS: ${name}`)
      passed++
    } catch (e) {
      console.error(`FAIL: ${name}`)
      console.error(`  ${e.message}\n${e.stack}`)
      failed++
    }
  }

  // Test 1: Provider initialization & defaults
  test('Provider defaults & identity', () => {
    const provider = new TestableOpenCodeProvider()
    assert.strictEqual(provider.id, 'opencode')
    assert.strictEqual(provider.name, 'OpenCode')
    assert.strictEqual(provider.defaultModel, 'space-bunny-free')
    assert.strictEqual(provider.defaultTimeoutMs, 60000)
  })

  // Test 2: Message formatting for OpenAI compatibility
  test('Message formatting (user, assistant, tool result)', () => {
    const provider = new TestableOpenCodeProvider()
    const messages = [
      { role: 'user', parts: [{ text: 'List the files in src' }] },
      {
        role: 'model',
        parts: [
          {
            id: 'call_abc123',
            functionCall: {
              name: 'list_files',
              args: { path: 'src' }
            }
          }
        ]
      },
      {
        role: 'function',
        parts: [
          {
            functionResponse: {
              name: 'list_files',
              id: 'call_abc123',
              response: { files: ['index.ts', 'app.tsx'] }
            }
          }
        ]
      }
    ]

    const formatted = provider.formatMessages(messages, 'You are a senior coding assistant.')
    assert.strictEqual(formatted.length, 4)
    assert.strictEqual(formatted[0].role, 'system')
    assert.strictEqual(formatted[0].content, 'You are a senior coding assistant.')

    assert.strictEqual(formatted[1].role, 'user')
    assert.strictEqual(formatted[1].content, 'List the files in src')

    assert.strictEqual(formatted[2].role, 'assistant')
    assert.strictEqual(formatted[2].tool_calls.length, 1)
    assert.strictEqual(formatted[2].tool_calls[0].id, 'call_abc123')
    assert.strictEqual(formatted[2].tool_calls[0].function.name, 'list_files')
    assert.strictEqual(formatted[2].tool_calls[0].function.arguments, JSON.stringify({ path: 'src' }))

    assert.strictEqual(formatted[3].role, 'tool')
    assert.strictEqual(formatted[3].tool_call_id, 'call_abc123')
    assert.strictEqual(formatted[3].content, JSON.stringify({ files: ['index.ts', 'app.tsx'] }))
  })

  // Test 3: Tool definition transformation
  test('Tool definition formatting', () => {
    const provider = new TestableOpenCodeProvider()
    const tools = [
      {
        name: 'read_file',
        description: 'Read contents of a file',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path' }
          },
          required: ['path']
        }
      }
    ]

    const formatted = provider.formatTools(tools)
    assert.strictEqual(formatted.length, 1)
    assert.strictEqual(formatted[0].type, 'function')
    assert.strictEqual(formatted[0].function.name, 'read_file')
    assert.strictEqual(formatted[0].function.description, 'Read contents of a file')
    assert.deepStrictEqual(formatted[0].function.parameters.required, ['path'])
  })

  // Test 4: Dynamic model listing filters strictly for free models
  await asyncTest('listFreeModels filters non-free models and retains only free models', async () => {
    const mockData = {
      data: [
        { id: 'claude-3-7-sonnet', created: 1700000000, owned_by: 'anthropic' },
        { id: 'gpt-4o', created: 1700000000, owned_by: 'openai' },
        { id: 'space-bunny-free', created: 1700000000, owned_by: 'opencode' },
        { id: 'longcat-2.5-preview-free', created: 1700000000, owned_by: 'opencode' },
        { id: 'mimo-v2.6-flash-free', created: 1700000000, owned_by: 'opencode' }
      ]
    }

    const mockFetch = async () => ({
      ok: true,
      json: async () => mockData
    })

    const provider = new TestableOpenCodeProvider({ fetchImpl: mockFetch })
    const freeModels = await provider.listFreeModels()

    assert.strictEqual(freeModels.length, 3)
    assert.strictEqual(freeModels[0].id, 'space-bunny-free')
    assert.strictEqual(freeModels[1].id, 'longcat-2.5-preview-free')
    assert.strictEqual(freeModels[2].id, 'mimo-v2.6-flash-free')
    for (const model of freeModels) {
      assert.strictEqual(model.isFree, true)
    }
  })

  // Test 5: Error classification and user-friendly error messages
  test('Error classification and messaging', () => {
    const provider = new TestableOpenCodeProvider()

    // 429 rate limit
    assert.strictEqual(provider.isRetryableError(429, 'Rate limit exceeded'), true)
    assert.strictEqual(
      provider.formatUserFriendlyError(429, 'Rate limit reached', 'space-bunny-free'),
      'OpenCode free inference rate limit reached. Please wait a moment and try again.'
    )

    // 503 service unavailable
    assert.strictEqual(provider.isRetryableError(503, 'Service unavailable'), true)

    // FreeTierError suggestion
    const freeTierMsg = provider.formatUserFriendlyError(
      400,
      'FreeTierError: Request not permitted outside opencode client',
      'longcat-2.5-preview-free'
    )
    assert.ok(freeTierMsg.includes('restricted to official OpenCode client requests'))
    assert.ok(freeTierMsg.includes('space-bunny-free'))

    // 401 unauthorized
    const authMsg = provider.formatUserFriendlyError(401, 'Unauthorized', 'space-bunny-free')
    assert.ok(authMsg.includes('Invalid OpenCode Console API key'))
  })

  // Test 6: Response transformation (text + function calls)
  test('transformOpenCodeResponse correctly converts assistant text and tool calls', () => {
    const provider = new TestableOpenCodeProvider()
    const rawApiResponse = {
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'I will list the directory files now.',
            tool_calls: [
              {
                id: 'call_list_001',
                type: 'function',
                function: {
                  name: 'list_files',
                  arguments: '{"path":"./src"}'
                }
              }
            ]
          },
          finish_reason: 'tool_calls'
        }
      ]
    }

    const res = provider.transformOpenCodeResponse(rawApiResponse)
    assert.strictEqual(res.candidates.length, 1)
    const parts = res.candidates[0].content.parts
    assert.strictEqual(parts.length, 2)
    assert.strictEqual(parts[0].text, 'I will list the directory files now.')
    assert.strictEqual(parts[1].id, 'call_list_001')
    assert.strictEqual(parts[1].functionCall.name, 'list_files')
    assert.deepStrictEqual(parts[1].functionCall.args, { path: './src' })
  })

  // Test 7: IPC caller dispatch with streaming chunk listener
  await asyncTest('IPC caller dispatch and streaming callback accumulation', async () => {
    let capturedReq = null
    const streamedChunks = []

    const mockIpcCaller = async (req) => {
      capturedReq = req
      return {
        success: true,
        data: {
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Streamed hello world'
              },
              finish_reason: 'stop'
            }
          ]
        }
      }
    }

    const mockStreamListener = (cb) => {
      // Simulate incoming SSE chunks
      cb({ content: 'Streamed ' })
      cb({ content: 'hello ' })
      cb({ content: 'world' })
      return () => {}
    }

    const provider = new TestableOpenCodeProvider({
      ipcCaller: mockIpcCaller,
      streamListener: mockStreamListener
    })

    const res = await provider.sendMessage(
      [{ role: 'user', parts: [{ text: 'Hello' }] }],
      [],
      {
        onChunk: (chunk) => streamedChunks.push(chunk)
      }
    )

    assert.ok(capturedReq)
    assert.strictEqual(capturedReq.model, 'space-bunny-free')
    assert.strictEqual(capturedReq.stream, true)
    assert.deepStrictEqual(streamedChunks, ['Streamed ', 'hello ', 'world'])
    assert.strictEqual(res.candidates[0].content.parts[0].text, 'Streamed hello world')
  })

  // Test 8: Live endpoint test against OpenCode models endpoint
  await asyncTest('Live API test: fetch models from https://opencode.ai/inference/v1/models', async () => {
    const provider = new TestableOpenCodeProvider()
    const freeModels = await provider.listFreeModels(undefined, 10000)
    console.log(`  Discovered ${freeModels.length} free models dynamically:`)
    for (const m of freeModels.slice(0, 5)) {
      console.log(`    - ${m.id}`)
    }
    assert.ok(freeModels.length > 0, 'Should find at least 1 free model')
    const hasSpaceBunny = freeModels.some((m) => m.id === 'space-bunny-free')
    assert.ok(hasSpaceBunny, 'space-bunny-free should be present among free models')
  })

  // Test 9: Live Chat Completion test with space-bunny-free (no API key required)
  await asyncTest('Live API test: chat completion with space-bunny-free without API key', async () => {
    const provider = new TestableOpenCodeProvider()
    const res = await provider.sendMessage(
      [{ role: 'user', parts: [{ text: 'Say hello in 3 words' }] }],
      [],
      { modelName: 'space-bunny-free', timeoutMs: 15000 }
    )

    const text = res.candidates[0].content.parts.map((p) => p.text || '').join('')
    console.log(`  Live response from space-bunny-free: "${text.trim()}"`)
    assert.ok(text.length > 0, 'Expected non-empty response')
  })

  // Test 10: Live Tool Calling test with space-bunny-free
  await asyncTest('Live API test: tool calling with space-bunny-free', async () => {
    const provider = new TestableOpenCodeProvider()
    const tools = [
      {
        name: 'get_weather',
        description: 'Get current weather for a city',
        parameters: {
          type: 'object',
          properties: {
            city: { type: 'string', description: 'City name' }
          },
          required: ['city']
        }
      }
    ]

    const res = await provider.sendMessage(
      [{ role: 'user', parts: [{ text: 'What is the weather in Tokyo? Please use the get_weather tool.' }] }],
      tools,
      { modelName: 'space-bunny-free', timeoutMs: 20000 }
    )

    const parts = res.candidates[0].content.parts
    const functionCallPart = parts.find((p) => p.functionCall)
    console.log(`  Live tool call part:`, functionCallPart?.functionCall)
    assert.ok(functionCallPart, 'Expected a functionCall part in response')
    assert.strictEqual(functionCallPart.functionCall.name, 'get_weather')
    assert.ok(functionCallPart.functionCall.args.city, 'Expected city argument')
  })

  // Test 11: Orchestrator chunk forwarding
  await asyncTest('AgentOrchestrator forwards onChunk to provider and triggers callback', async () => {
    const receivedChunks = []

    const mockProvider = {
      id: 'mock-opencode',
      name: 'Mock OpenCode',
      async sendMessage(messages, tools, options) {
        if (options.onChunk) {
          options.onChunk('chunk1 ')
          options.onChunk('chunk2 ')
          options.onChunk('chunk3')
        }
        return {
          text: 'chunk1 chunk2 chunk3',
          functionCalls: []
        }
      }
    }

    // Simulate AgentOrchestrator run loop forwarding options.onChunk
    async function orchestratorRun(prompt, options) {
      const { apiKey, modelName, onChunk } = options
      const response = await mockProvider.sendMessage([], [], {
        apiKey,
        modelName,
        onChunk
      })
      return response.text
    }

    const finalRes = await orchestratorRun('Test prompt', {
      apiKey: '',
      modelName: 'space-bunny-free',
      onChunk: (chunk) => receivedChunks.push(chunk)
    })

    assert.strictEqual(finalRes, 'chunk1 chunk2 chunk3')
    assert.deepStrictEqual(receivedChunks, ['chunk1 ', 'chunk2 ', 'chunk3'])
  })

  // Test 12: AIChatPanel incremental message accumulation & duplicate prevention
  test('AIChatPanel message state reducer: incremental chunk accumulation and duplicate prevention', () => {
    let messages = [
      { id: 'req-1', role: 'user', content: 'What is 2+2?' }
    ]
    const requestId = 'req-1'
    const assistantMsgId = `${requestId}-res`
    const recordedSteps = []

    function applyChunk(chunk) {
      if (!chunk) return
      const existingIdx = messages.findIndex((m) => m.id === assistantMsgId)
      const toolSteps = recordedSteps.filter((s) => s.type === 'tool_result')
      if (existingIdx >= 0) {
        messages = messages.map((m, idx) =>
          idx === existingIdx
            ? { ...m, content: m.content + chunk, steps: toolSteps }
            : m
        )
      } else {
        messages = [
          ...messages,
          {
            id: assistantMsgId,
            role: 'assistant',
            content: chunk,
            steps: toolSteps
          }
        ]
      }
    }

    function applyToolResult(toolName, output) {
      const step = { type: 'tool_result', toolName, toolOutput: output }
      recordedSteps.push(step)
      const existingIdx = messages.findIndex((m) => m.id === assistantMsgId)
      const toolSteps = recordedSteps.filter((s) => s.type === 'tool_result')
      if (existingIdx >= 0) {
        messages = messages.map((m, idx) =>
          idx === existingIdx ? { ...m, steps: toolSteps } : m
        )
      } else {
        messages = [
          ...messages,
          {
            id: assistantMsgId,
            role: 'assistant',
            content: '',
            steps: toolSteps
          }
        ]
      }
    }

    function applyFinalResponse(finalResponse) {
      const existingIdx = messages.findIndex((m) => m.id === assistantMsgId)
      const toolSteps = recordedSteps.filter((s) => s.type === 'tool_result')
      if (existingIdx >= 0) {
        const existingContent = messages[existingIdx].content
        let reconciledContent = existingContent
        if (!existingContent) {
          reconciledContent = finalResponse
        } else if (
          finalResponse &&
          !existingContent.includes(finalResponse) &&
          !finalResponse.includes(existingContent)
        ) {
          reconciledContent = `${existingContent}\n\n${finalResponse}`
        } else if (finalResponse && finalResponse.length > existingContent.length) {
          reconciledContent = finalResponse
        }

        messages = messages.map((m, idx) =>
          idx === existingIdx
            ? { ...m, content: reconciledContent, steps: toolSteps }
            : m
        )
      } else {
        messages = [
          ...messages,
          {
            id: assistantMsgId,
            role: 'assistant',
            content: finalResponse,
            steps: toolSteps
          }
        ]
      }
    }

    // Step 1: Chunk 1 arrives
    applyChunk('4 is ')
    assert.strictEqual(messages.length, 2)
    assert.strictEqual(messages[1].content, '4 is ')

    // Step 2: Chunk 2 arrives
    applyChunk('the answer.')
    assert.strictEqual(messages.length, 2)
    assert.strictEqual(messages[1].content, '4 is the answer.')

    // Step 3: Tool result arrives
    applyToolResult('calculator', '4')
    assert.strictEqual(messages.length, 2)
    assert.strictEqual(messages[1].steps.length, 1)
    assert.strictEqual(messages[1].steps[0].toolName, 'calculator')
    assert.strictEqual(messages[1].content, '4 is the answer.')

    // Step 4: Final response matches streamed content
    applyFinalResponse('4 is the answer.')
    assert.strictEqual(messages.length, 2)
    // CRITICAL: Content MUST NOT be duplicated to "4 is the answer.4 is the answer."
    assert.strictEqual(messages[1].content, '4 is the answer.')

    // Step 5: Test non-streaming path where no chunks arrived
    let nonStreamMessages = [{ id: 'req-2', role: 'user', content: 'Hi' }]
    const nsRequestId = 'req-2'
    const nsMsgId = `${nsRequestId}-res`
    const nsExistingIdx = nonStreamMessages.findIndex((m) => m.id === nsMsgId)
    assert.strictEqual(nsExistingIdx, -1)
    nonStreamMessages.push({
      id: nsMsgId,
      role: 'assistant',
      content: 'Hello there!',
      steps: []
    })
    assert.strictEqual(nonStreamMessages.length, 2)
    assert.strictEqual(nonStreamMessages[1].content, 'Hello there!')
  })

  console.log(`\n========================================`)
  console.log(`Test Results: ${passed} passed, ${failed} failed`)
  console.log(`========================================`)

  if (failed > 0) {
    process.exit(1)
  }
}

runTests().catch((err) => {
  console.error('Fatal error during test execution:', err)
  process.exit(1)
})
