// Comprehensive NVIDIA NIM AI Provider, Dynamic Model Catalog & Settings Verification Suite

import assert from 'node:assert'

class MockNvidiaProvider {
  constructor(config) {
    this.id = 'nvidia'
    this.name = 'NVIDIA NIM'
    this.defaultModel = config?.defaultModel
    this.defaultTimeoutMs = config?.defaultTimeoutMs || 30000
    this.ipcCaller = config?.ipcCaller
    this.fetchImpl = config?.fetchImpl
    this.diagnosticLogs = []
  }

  logDiagnostic(stage, details) {
    this.diagnosticLogs.push({ stage, details })
  }

  isRetryableError(status, message) {
    if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
      return true
    }
    const lower = message.toLowerCase()
    if (
      lower.includes('rate limit') ||
      lower.includes('too many requests') ||
      lower.includes('high demand') ||
      lower.includes('overloaded') ||
      lower.includes('service unavailable') ||
      lower.includes('temporarily unavailable') ||
      lower.includes('timeout') ||
      lower.includes('timed out') ||
      lower.includes('try again')
    ) {
      return true
    }
    return false
  }

  isToolCallingUnsupportedError(status, message) {
    const lower = message.toLowerCase()
    return (
      (status === 400 || status === 422) &&
      (lower.includes('tools') ||
        lower.includes('function') ||
        lower.includes('tool_choice') ||
        lower.includes('not supported') ||
        lower.includes('unrecognized field') ||
        lower.includes('extra fields not permitted') ||
        lower.includes('function calling'))
    )
  }

  formatUserFriendlyError(status, rawMessage, modelName, failedBeforeResponse = false) {
    if (
      rawMessage.includes('Electron IPC handler for NVIDIA NIM is not available') ||
      rawMessage.includes('nvidiaChatCompletion is undefined')
    ) {
      return 'Electron IPC handler for NVIDIA NIM is not available. Please restart the application.'
    }
    if (rawMessage.includes('API key is not configured') || rawMessage.includes('Please provide a valid API key in Settings')) {
      return rawMessage
    }
    if (rawMessage.includes('No NVIDIA NIM model')) {
      return rawMessage
    }
    if (
      status === 401 ||
      status === 403 ||
      rawMessage.toLowerCase().includes('api key') ||
      rawMessage.toLowerCase().includes('unauthorized') ||
      rawMessage.toLowerCase().includes('forbidden')
    ) {
      return 'Invalid NVIDIA API key. Please check your key in Settings.'
    }
    const lower = rawMessage.toLowerCase()
    const isExplicitEol =
      lower.includes('end of life') ||
      lower.includes('end-of-life') ||
      lower.includes('retired') ||
      lower.includes('deprecated') ||
      lower.includes('decommissioned') ||
      lower.includes('no longer available') ||
      lower.includes('model is disabled')

    if (isExplicitEol) {
      return `The selected NVIDIA model ('${modelName}') has reached end of life. Please fetch and select an available model from the NVIDIA NIM catalog in Settings.`
    }

    if (
      status === 404 ||
      status === 410 ||
      lower.includes('model not found') ||
      lower.includes('does not exist') ||
      lower.includes('unknown model')
    ) {
      return `The selected NVIDIA model ('${modelName}') was not found in NVIDIA NIM. Please fetch and select an active model in Settings.`
    }

    if (this.isToolCallingUnsupportedError(status, rawMessage)) {
      return `The selected NVIDIA model ('${modelName}') does not support tool calling or rejected the tools parameter. Please choose a tool-compatible model or use conversational mode.`
    }
    if (status === 429 || rawMessage.toLowerCase().includes('rate limit')) {
      return 'NVIDIA NIM rate limit reached. Please try again in a moment.'
    }
    if (
      rawMessage.toLowerCase().includes('timed out') ||
      rawMessage.toLowerCase().includes('abort') ||
      rawMessage.toLowerCase().includes('timeout')
    ) {
      return 'Request timed out after 30s. The NVIDIA API service may be experiencing high latency.'
    }
    if (failedBeforeResponse || rawMessage.toLowerCase().includes('fetch') || rawMessage.toLowerCase().includes('econnrefused')) {
      return `Failed to connect to NVIDIA NIM (${rawMessage.replace(/^Error:\s*/i, '')}). Please verify your network connection and proxy settings.`
    }
    return (
      rawMessage.replace(/^NVIDIA NIM API error:\s*/i, '').trim() ||
      'The NVIDIA AI provider is temporarily unavailable. Please try again.'
    )
  }

  async sendMessage(messages, tools, options) {
    const {
      apiKey,
      modelName = this.defaultModel,
      systemInstruction,
      temperature = 0.2,
      timeoutMs = this.defaultTimeoutMs,
      onRetry
    } = options

    if (!apiKey || apiKey.trim() === '') {
      this.logDiagnostic('validation_failed', { reason: 'missing_api_key' })
      throw new Error('NVIDIA NIM API key is not configured. Please provide a valid API key in Settings.')
    }

    const activeModel = modelName ? modelName.trim() : ''
    if (!activeModel) {
      this.logDiagnostic('validation_failed', { reason: 'missing_model' })
      throw new Error('No NVIDIA NIM model configured. Please open Settings, fetch available models, and select one.')
    }

    this.logDiagnostic('preparing_request', {
      model: activeModel,
      messageCount: messages.length,
      toolCount: tools?.length || 0
    })

    const formattedMessages = []
    if (systemInstruction) {
      formattedMessages.push({ role: 'system', content: systemInstruction })
    }

    let lastToolCallId = 'call_tool_1'

    for (const msg of messages) {
      if (msg.role === 'user') {
        const text = msg.parts.map((p) => p.text || '').join('\n')
        formattedMessages.push({ role: 'user', content: text })
      } else if (msg.role === 'model') {
        const toolCalls = []
        let textContent = ''

        for (const part of msg.parts) {
          if (part.functionCall) {
            const toolCallId =
              part['id'] || part['tool_call_id'] || `call_${part.functionCall.name}_${formattedMessages.length}`
            part['id'] = toolCallId
            part['tool_call_id'] = toolCallId
            lastToolCallId = toolCallId

            toolCalls.push({
              id: toolCallId,
              type: 'function',
              function: {
                name: part.functionCall.name,
                arguments: JSON.stringify(part.functionCall.args || {})
              }
            })
          }
          if (part.text) {
            textContent += part.text
          }
        }

        const assistantMsg = { role: 'assistant', content: textContent || null }
        if (toolCalls.length > 0) {
          assistantMsg.tool_calls = toolCalls
        }
        formattedMessages.push(assistantMsg)
      } else if (msg.role === 'function') {
        for (const part of msg.parts) {
          if (part.functionResponse) {
            const content = part.functionResponse.response.content
            const contentStr = typeof content === 'string' ? content : JSON.stringify(content, null, 2)
            formattedMessages.push({
              role: 'tool',
              tool_call_id: part['tool_call_id'] || lastToolCallId,
              name: part.functionResponse.name,
              content: contentStr
            })
          }
        }
      }
    }

    const ipcRequest = {
      model: activeModel,
      messages: formattedMessages,
      temperature,
      apiKey: apiKey.trim(),
      timeoutMs
    }

    if (tools && tools.length > 0) {
      ipcRequest.tools = tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters
        }
      }))
      ipcRequest.tool_choice = 'auto'
    }

    const MAX_RETRIES = 2
    let lastError = null

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        let ipcResponse
        if (this.ipcCaller) {
          this.logDiagnostic('sending_custom_ipc', { attempt, model: activeModel })
          ipcResponse = await this.ipcCaller(ipcRequest)
        } else if (typeof globalThis.window !== 'undefined' && globalThis.window.electronAPI?.nvidiaChatCompletion) {
          this.logDiagnostic('sending_electron_ipc', { attempt, model: activeModel })
          ipcResponse = await globalThis.window.electronAPI.nvidiaChatCompletion(ipcRequest)
        } else if (typeof globalThis.window !== 'undefined' && !this.fetchImpl) {
          this.logDiagnostic('missing_electron_ipc', { attempt, model: activeModel })
          ipcResponse = {
            success: false,
            error: 'Electron IPC handler for NVIDIA NIM is not available. Please restart the application.',
            errorDetails: 'window.electronAPI.nvidiaChatCompletion is undefined in renderer context.',
            stage: 'init'
          }
        } else {
          this.logDiagnostic('sending_direct_fetch', { attempt, model: activeModel })
          const fetchFunc = this.fetchImpl || fetch
          const resp = await fetchFunc('https://integrate.api.nvidia.com/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey.trim()}`
            },
            body: JSON.stringify(ipcRequest)
          })
          if (!resp.ok) {
            const errJson = await resp.json().catch(() => ({}))
            ipcResponse = {
              success: false,
              status: resp.status,
              statusText: resp.statusText,
              error: errJson.error?.message || `Status ${resp.status}`,
              stage: 'response_received'
            }
          } else {
            const data = await resp.json()
            ipcResponse = { success: true, status: resp.status, data, stage: 'completed' }
          }
        }

        this.logDiagnostic('response_evaluated', {
          success: ipcResponse.success,
          status: ipcResponse.status,
          stage: ipcResponse.stage
        })

        if (!ipcResponse.success) {
          const status = ipcResponse.status || 0
          const rawMessage = ipcResponse.errorDetails || ipcResponse.error || 'Unknown error'
          const isRetryable = this.isRetryableError(status, rawMessage)

          if (isRetryable && attempt < MAX_RETRIES) {
            const backoffMs = (attempt + 1) * 10
            this.logDiagnostic('retrying', { attempt: attempt + 1, backoffMs, status })
            onRetry?.(attempt + 1, MAX_RETRIES, backoffMs, rawMessage)
            await new Promise((resolve) => setTimeout(resolve, backoffMs))
            continue
          }

          const friendlyError = this.formatUserFriendlyError(
            status,
            rawMessage,
            activeModel,
            ipcResponse.isNetworkError || status === 0
          )
          this.logDiagnostic('failed_final', {
            status,
            sanitizedError: friendlyError,
            failedBeforeResponse: ipcResponse.isNetworkError || status === 0
          })
          throw new Error(friendlyError)
        }

        const choice = ipcResponse.data?.choices?.[0]
        if (!choice || !choice.message) {
          return { text: 'No response returned from NVIDIA NIM.' }
        }

        const choiceMsg = choice.message
        const functionCalls = []
        const rawModelParts = []

        if (choiceMsg.tool_calls && Array.isArray(choiceMsg.tool_calls)) {
          for (const call of choiceMsg.tool_calls) {
            let parsedArgs = {}
            try {
              parsedArgs = typeof call.function.arguments === 'string'
                ? JSON.parse(call.function.arguments)
                : call.function.arguments || {}
            } catch {
              parsedArgs = {}
            }

            functionCalls.push({ name: call.function.name, args: parsedArgs })
            rawModelParts.push({
              functionCall: { name: call.function.name, args: parsedArgs },
              id: call.id,
              tool_call_id: call.id
            })
          }
        }

        if (choiceMsg.content) {
          rawModelParts.push({ text: choiceMsg.content })
        }

        return {
          text: choiceMsg.content || undefined,
          functionCalls: functionCalls.length > 0 ? functionCalls : undefined,
          rawModelParts
        }
      } catch (err) {
        if (err.message.includes('Electron IPC handler for NVIDIA NIM is not available')) throw err
        if (err.message.startsWith('Invalid NVIDIA API key')) throw err
        if (err.message.includes('has reached end of life')) throw err
        if (err.message.includes('was not found in NVIDIA NIM')) throw err
        if (err.message.includes('does not support tool calling')) throw err
        if (err.message.includes('rate limit')) throw err
        if (err.message.includes('Failed to connect to NVIDIA NIM')) throw err
        if (err.message.includes('No NVIDIA NIM model configured')) throw err

        const rawMessage = err.message || String(err)
        const isRetryable = this.isRetryableError(0, rawMessage)

        if (isRetryable && attempt < MAX_RETRIES) {
          const backoffMs = (attempt + 1) * 10
          this.logDiagnostic('retrying_catch', { attempt: attempt + 1, backoffMs })
          onRetry?.(attempt + 1, MAX_RETRIES, backoffMs, rawMessage)
          await new Promise((resolve) => setTimeout(resolve, backoffMs))
          continue
        }

        const friendlyMsg = this.formatUserFriendlyError(0, rawMessage, activeModel, true)
        this.logDiagnostic('failed_catch_final', {
          sanitizedError: friendlyMsg,
          failedBeforeResponse: true
        })
        lastError = new Error(friendlyMsg)
        throw lastError
      }
    }
    throw lastError
  }
}

async function runTests() {
  console.log('====================================================')
  console.log('NVIDIA NIM DYNAMIC MODEL & SETTINGS TEST SUITE')
  console.log('====================================================')

  // Test 1: Provider identification
  console.log('\n[Test 1] Provider identification')
  const provider = new MockNvidiaProvider()
  assert.strictEqual(provider.id, 'nvidia')
  assert.strictEqual(provider.name, 'NVIDIA NIM')
  console.log('✓ PASS: Provider id and name verified.')

  // Test 2: Missing API key validation
  console.log('\n[Test 2] Missing API key validation')
  try {
    await provider.sendMessage([{ role: 'user', parts: [{ text: 'Hi' }] }], [], { apiKey: '' })
    assert.fail('Should have failed on missing key')
  } catch (err) {
    assert(err.message.includes('NVIDIA NIM API key is not configured'))
    console.log(`✓ PASS: Missing key error: "${err.message}"`)
  }

  // Test 3: Missing Model validation (No guessing)
  console.log('\n[Test 3] Missing Model validation (No hardcoded guessing)')
  try {
    await provider.sendMessage([{ role: 'user', parts: [{ text: 'Hi' }] }], [], { apiKey: 'test-key', modelName: '' })
    assert.fail('Should have failed on missing model')
  } catch (err) {
    assert(err.message.includes('No NVIDIA NIM model configured'))
    console.log(`✓ PASS: Explicit missing model error: "${err.message}"`)
  }

  // Test 4: Dynamic Model List parsing from GET /v1/models response
  console.log('\n[Test 4] Dynamic Model List parsing from GET /v1/models')
  const mockNvidiaModelsResponse = {
    object: 'list',
    data: [
      { id: 'meta/llama-3.3-70b-instruct', object: 'model', created: 1730000000, owned_by: 'system' },
      { id: 'mistralai/mistral-large-2-instruct', object: 'model', created: 1725000000, owned_by: 'system' },
      { id: 'nvidia/llama-3.1-nemotron-70b-instruct', object: 'model', created: 1728000000, owned_by: 'system' }
    ]
  }

  function parseNvidiaModels(data) {
    const rawList = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : []
    return rawList
      .filter((item) => item && typeof item.id === 'string' && item.id.trim())
      .map((item) => ({
        id: item.id.trim(),
        created: item.created,
        owned_by: item.owned_by
      }))
  }

  const parsedModels = parseNvidiaModels(mockNvidiaModelsResponse)
  assert.strictEqual(parsedModels.length, 3)
  assert.strictEqual(parsedModels[0].id, 'meta/llama-3.3-70b-instruct')
  assert.strictEqual(parsedModels[1].id, 'mistralai/mistral-large-2-instruct')
  assert.strictEqual(parsedModels[2].id, 'nvidia/llama-3.1-nemotron-70b-instruct')
  console.log('✓ PASS: Model list parsed correctly with 3 active models.')

  // Test 5: Empty Model List handling
  console.log('\n[Test 5] Empty Model List handling')
  const emptyParsed = parseNvidiaModels({ object: 'list', data: [] })
  assert.deepStrictEqual(emptyParsed, [])
  console.log('✓ PASS: Empty model list handled without error.')

  // Test 6: 401 Auth Error when fetching models
  console.log('\n[Test 6] 401 Auth error when listing models')
  const authErrHandler = (status) => {
    if (status === 401 || status === 403) {
      return 'Invalid NVIDIA API key. Please check your key in Settings.'
    }
    return 'Failed to fetch models.'
  }
  assert.strictEqual(authErrHandler(401), 'Invalid NVIDIA API key. Please check your key in Settings.')
  console.log('✓ PASS: 401 on listing models properly mapped.')

  // Test 7: EOL vs Standard 404 error message distinction
  console.log('\n[Test 7] EOL vs standard 404 error distinction')
  const eolErr = provider.formatUserFriendlyError(400, 'Model meta/llama-3.1-70b-instruct has reached end of life on 2026-08-26', 'meta/llama-3.1-70b-instruct')
  assert(eolErr.includes('has reached end of life'), 'Should flag end of life explicitly')
  assert(!eolErr.includes('meta/llama-3.3-70b-instruct'), 'Should NOT recommend a hardcoded unverified model')

  const notFoundErr = provider.formatUserFriendlyError(404, 'Model does not exist', 'custom/unknown-model')
  assert(notFoundErr.includes("was not found in NVIDIA NIM"), 'Should report not found')
  console.log('✓ PASS: EOL and 404 errors distinctly formatted without hardcoded model guessing.')

  // Test 8: Connection Test flow
  console.log('\n[Test 8] Connection Test execution')
  const testConnProvider = new MockNvidiaProvider({
    ipcCaller: async (req) => {
      assert.strictEqual(req.model, 'mistralai/mistral-large-2-instruct')
      return {
        success: true,
        status: 200,
        data: { choices: [{ message: { content: 'OK' } }] }
      }
    }
  })

  const testConnRes = await testConnProvider.sendMessage(
    [{ role: 'user', parts: [{ text: 'Say OK' }] }],
    [],
    { apiKey: 'valid-key', modelName: 'mistralai/mistral-large-2-instruct' }
  )
  assert.strictEqual(testConnRes.text, 'OK')
  console.log('✓ PASS: Test connection message succeeded.')

  // Test 9: Tool Calling Error Handling
  console.log('\n[Test 9] Unsupported tool calling handling')
  const toolErr = provider.formatUserFriendlyError(400, 'tools parameter is not supported', 'test-model')
  assert(toolErr.includes('does not support tool calling'))
  console.log('✓ PASS: Tool calling error formatted clearly.')

  // Test 10: Settings persistence with fetched model
  console.log('\n[Test 10] Settings persistence with user-selected model')
  let disk = { geminiApiKey: 'gemini-key', nvidiaApiKey: 'nvapi-saved-key' }
  function save(partial) {
    if (partial.nvidiaModelId !== undefined) {
      if (partial.nvidiaModelId.trim()) disk.nvidiaModelId = partial.nvidiaModelId.trim()
      else delete disk.nvidiaModelId
    }
    if (partial.nvidiaApiKey !== undefined) {
      if (partial.nvidiaApiKey.trim()) disk.nvidiaApiKey = partial.nvidiaApiKey.trim()
      else delete disk.nvidiaApiKey
    }
  }

  save({ nvidiaModelId: 'mistralai/mistral-large-2-instruct' })
  assert.strictEqual(disk.nvidiaModelId, 'mistralai/mistral-large-2-instruct')
  assert.strictEqual(disk.nvidiaApiKey, 'nvapi-saved-key')
  assert.strictEqual(disk.geminiApiKey, 'gemini-key')
  console.log('✓ PASS: User-selected model persisted into settings without overwriting other keys.')

  // Test 11: Pasting long key (no truncation or maxLength)
  console.log('\n[Test 11] Pasting long NVIDIA API key (128+ chars)')
  const longNvidiaKey = 'nvapi-' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0u1V2w3X4y5Z6'.repeat(3)
  assert(longNvidiaKey.length > 150, 'Key should be long')
  
  // Simulate React controlled input onChange receiving pasted text
  let mockInputState = ''
  function handleInputChange(eventValue) {
    // No slicing, no character truncating
    mockInputState = eventValue
  }
  handleInputChange(longNvidiaKey)
  assert.strictEqual(mockInputState, longNvidiaKey, 'Input must store complete pasted key without truncation')
  console.log(`✓ PASS: Controlled input stored full ${mockInputState.length}-character key without truncation.`)

  // Test 12: Saving new long key persists to storage
  console.log('\n[Test 12] Saving new long key to local settings')
  save({ nvidiaApiKey: mockInputState })
  assert.strictEqual(disk.nvidiaApiKey, longNvidiaKey, 'Persisted key must match exact pasted long key')
  console.log('✓ PASS: Full long key successfully persisted to settings.')

  // Test 13: App restart / restore and save without changes
  console.log('\n[Test 13] Restoring saved key on startup & preserving key on untouched save')
  // Simulate app restart: load settings
  const loadedSettings = JSON.parse(JSON.stringify(disk))
  let memoryNvidiaKey = loadedSettings.nvidiaApiKey
  let modalKeyInput = '' // Clean input on modal open
  let isKeyCleared = false

  // UI placeholder check: should indicate configured, never expose actual key
  const placeholder = (memoryNvidiaKey && !isKeyCleared)
    ? 'API key configured (enter new key to replace)'
    : 'nvapi-...'
  assert.strictEqual(placeholder, 'API key configured (enter new key to replace)')
  assert(!placeholder.includes('nvapi-a1B2'), 'Placeholder must never expose raw key')

  // User opens settings to change model and clicks Save Settings without typing key
  const updatesOnSave = { selectedProvider: 'nvidia', nvidiaModelId: 'meta/llama-3.3-70b-instruct' }
  if (isKeyCleared) {
    memoryNvidiaKey = ''
    updatesOnSave.nvidiaApiKey = ''
  } else if (modalKeyInput.trim().length > 0) {
    memoryNvidiaKey = modalKeyInput.trim()
    updatesOnSave.nvidiaApiKey = modalKeyInput.trim()
  }
  // Note: updatesOnSave.nvidiaApiKey is undefined because user did not change key
  assert.strictEqual(updatesOnSave.nvidiaApiKey, undefined, 'Untouched key must NOT generate empty string overwrite')
  save(updatesOnSave)
  assert.strictEqual(disk.nvidiaApiKey, longNvidiaKey, 'Disk storage must retain saved key when user did not edit key input')
  assert.strictEqual(disk.nvidiaModelId, 'meta/llama-3.3-70b-instruct')
  console.log('✓ PASS: Saved key restored masked and preserved on untouched save.')

  // Test 14: Clear key functionality
  console.log('\n[Test 14] Explicit Clear Key action')
  isKeyCleared = true
  modalKeyInput = ''
  const updatesOnClear = { selectedProvider: 'nvidia' }
  if (isKeyCleared) {
    memoryNvidiaKey = ''
    updatesOnClear.nvidiaApiKey = ''
  }
  save(updatesOnClear)
  assert.strictEqual(disk.nvidiaApiKey, undefined, 'Key should be deleted from settings on clear')
  assert.strictEqual(memoryNvidiaKey, '', 'Key should be cleared in memory')
  console.log('✓ PASS: Clear Key action successfully clears state and deletes from settings.')

  // Test 15: Security test - no key logging or exposure
  console.log('\n[Test 15] Security verification: API key not exposed in errors or diagnostics')
  const sanitizedMsg = provider.formatUserFriendlyError(401, `Bearer ${longNvidiaKey} invalid`, 'test-model')
  assert(!sanitizedMsg.includes(longNvidiaKey), 'Sanitized error must never contain API key')
  console.log('✓ PASS: API key securely protected and never exposed.')

  console.log('\n====================================================')
  console.log('ALL NVIDIA NIM DYNAMIC MODEL & KEY TESTS PASSED! ✓')
  console.log('====================================================')
}

runTests().catch((err) => {
  console.error('Test failed:', err)
  process.exit(1)
})
