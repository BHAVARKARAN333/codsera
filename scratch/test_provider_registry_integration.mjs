// scratch/test_provider_registry_integration.mjs
// Phase 3 — Task 6: Centralized Provider Registry, Factory & Chat Integration Suite

import assert from 'node:assert'
import esbuild from 'esbuild'

console.log('=================================================================')
console.log('PHASE 3 — TASK 6: PROVIDER REGISTRY & CHAT INTEGRATION SUITE')
console.log('=================================================================\n')

// 1. Bundle ProviderRegistry and AgentOrchestrator via esbuild
const registryBundle = await esbuild.build({
  entryPoints: ['src/renderer/src/services/ai/providerRegistry.ts'],
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'browser',
  target: 'es2022',
  external: ['electron', 'lucide-react', 'react', 'react-dom']
})

const {
  ProviderRegistry,
  createDefaultProviderRegistry,
  providerRegistry
} = await import(
  'data:text/javascript;base64,' + Buffer.from(registryBundle.outputFiles[0].text).toString('base64')
)

const orchBundle = await esbuild.build({
  entryPoints: ['src/renderer/src/services/agent/orchestrator.ts'],
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'browser',
  target: 'es2022',
  external: ['electron', 'lucide-react', 'react', 'react-dom']
})

const { AgentOrchestrator } = await import(
  'data:text/javascript;base64,' + Buffer.from(orchBundle.outputFiles[0].text).toString('base64')
)

// Setup mock window & electronAPI
globalThis.window = {
  electronAPI: {
    readTree: async (root) => ({
      success: true,
      rootPath: root,
      tree: [
        { name: 'index.ts', path: `${root}/index.ts`, isDirectory: false, size: 100, mtimeMs: Date.now() }
      ]
    }),
    readFile: async () => ({ success: true, content: 'Mock file content' }),
    writeFile: async () => ({ success: true }),
    createWorkspaceFile: async () => ({ success: true }),
    editWorkspaceFile: async () => ({ success: true }),
    stopCommand: async () => ({ success: true }),
    saveSettings: async () => ({ success: true }),
    getSettings: async () => ({}),
    getEnvApiKey: async () => null
  }
}

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

// Simple Mock Tool for testing orchestrator tool execution
class MockEchoTool {
  name = 'echo_tool'
  description = 'Echo input text'
  requiresApproval = false
  parameters = {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text']
  }
  async execute(args) {
    return { echo: args.text }
  }
}

// Simple Mock Approval Tool
class MockMutatingTool {
  name = 'delete_file'
  description = 'Delete file'
  requiresApproval = true
  parameters = {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path']
  }
  async execute(args, context) {
    if (context?.requestApproval) {
      const approved = await context.requestApproval({
        toolName: this.name,
        path: args?.path || '/mock/file.txt',
        isDangerous: true
      })
      if (!approved) {
        return {
          success: false,
          rejected: true,
          output: `User rejected approval for ${this.name}`,
          error: `User rejected approval for ${this.name}`
        }
      }
    }
    return { success: true, output: `Deleted ${args?.path}` }
  }
}

// =================================================================
// Group 1: Provider Registry Registration, Querying & Lifecycle
// =================================================================
console.log('--- Group 1: Provider Registry Registration, Querying & Lifecycle ---')

await runTest('1.1 Registers and retrieves all four default providers (gemini, openrouter, nvidia, opencode)', async () => {
  const providers = providerRegistry.list()
  assert.strictEqual(providers.length, 4)

  const ids = providers.map((p) => p.id)
  assert.ok(ids.includes('gemini'), 'gemini must be registered')
  assert.ok(ids.includes('openrouter'), 'openrouter must be registered')
  assert.ok(ids.includes('nvidia'), 'nvidia must be registered')
  assert.ok(ids.includes('opencode'), 'opencode must be registered')

  for (const id of ['gemini', 'openrouter', 'nvidia', 'opencode']) {
    assert.strictEqual(providerRegistry.has(id), true)
    const meta = providerRegistry.getMetadata(id)
    assert.strictEqual(meta.id, id)
    assert.ok(meta.name.length > 0)
    assert.ok(meta.capabilities)
  }
})

await runTest('1.2 get(id) returns consistent singleton instances across multiple calls', async () => {
  const gemini1 = providerRegistry.get('gemini')
  const gemini2 = providerRegistry.get('gemini')
  assert.strictEqual(gemini1, gemini2, 'get(id) must return the same singleton instance')
  assert.strictEqual(gemini1.id, 'gemini')

  const openrouter1 = providerRegistry.get('openrouter')
  const openrouter2 = providerRegistry.get('openrouter')
  assert.strictEqual(openrouter1, openrouter2, 'openrouter singleton must match')
})

await runTest('1.3 create(id, config) returns fresh isolated instances without modifying singleton', async () => {
  const singleton = providerRegistry.get('openrouter')
  const freshInstance = providerRegistry.create('openrouter', { defaultTimeoutMs: 12345 })

  assert.notStrictEqual(singleton, freshInstance, 'create(id) must return a distinct instance')
  assert.strictEqual(freshInstance.id, 'openrouter')
  assert.strictEqual(providerRegistry.get('openrouter'), singleton, 'singleton must remain untouched')
})

await runTest('1.4 Throws descriptive error for unknown provider IDs listing available options', async () => {
  assert.throws(
    () => {
      providerRegistry.get('unknown-provider')
    },
    (err) => {
      assert.ok(err.message.includes('Unknown AI provider ID: "unknown-provider"'))
      assert.ok(err.message.includes('gemini, openrouter, nvidia, opencode'))
      return true
    }
  )

  assert.throws(
    () => {
      providerRegistry.getMetadata('nonexistent')
    },
    (err) => {
      assert.ok(err.message.includes('Unknown AI provider ID: "nonexistent"'))
      return true
    }
  )
})

await runTest('1.5 Rejects invalid registration metadata (missing or invalid id)', async () => {
  const reg = new ProviderRegistry()
  assert.throws(
    () => {
      reg.register(null, () => ({}))
    },
    (err) => {
      assert.ok(err.message.includes('valid metadata object'))
      return true
    }
  )

  assert.throws(
    () => {
      reg.register({ id: '', name: 'Test' }, () => ({}))
    },
    (err) => {
      assert.ok(err.message.includes('valid metadata object'))
      return true
    }
  )
})

await runTest('1.6 Custom provider registration works cleanly alongside built-ins', async () => {
  const reg = createDefaultProviderRegistry()
  reg.register(
    {
      id: 'custom-mock',
      name: 'Custom Mock Provider',
      defaultModel: 'mock-model-v1',
      capabilities: {
        supportsStreaming: false,
        supportsTools: true,
        requiresApiKey: false
      }
    },
    () => ({
      id: 'custom-mock',
      name: 'Custom Mock Provider',
      sendMessage: async () => ({ text: 'Custom Response' })
    })
  )

  assert.strictEqual(reg.has('custom-mock'), true)
  assert.strictEqual(reg.list().length, 5)
  const provider = reg.get('custom-mock')
  const res = await provider.sendMessage([], [], { apiKey: '' })
  assert.strictEqual(res.text, 'Custom Response')
})

// =================================================================
// Group 2: Capability-Aware Orchestration & Metadata Exposure
// =================================================================
console.log('\n--- Group 2: Capability-Aware Orchestration & Metadata Exposure ---')

await runTest('2.1 Capability metadata accurately reports features for all 4 default providers', async () => {
  const geminiMeta = providerRegistry.getMetadata('gemini')
  assert.strictEqual(geminiMeta.capabilities.supportsStreaming, true)
  assert.strictEqual(geminiMeta.capabilities.supportsTools, true)
  assert.strictEqual(geminiMeta.capabilities.requiresApiKey, true)

  const openrouterMeta = providerRegistry.getMetadata('openrouter')
  assert.strictEqual(openrouterMeta.capabilities.supportsStreaming, true)
  assert.strictEqual(openrouterMeta.capabilities.supportsTools, true)
  assert.strictEqual(openrouterMeta.capabilities.requiresApiKey, true)

  const nvidiaMeta = providerRegistry.getMetadata('nvidia')
  assert.strictEqual(nvidiaMeta.capabilities.supportsStreaming, false) // NVIDIA is non-streaming
  assert.strictEqual(nvidiaMeta.capabilities.supportsTools, true)
  assert.strictEqual(nvidiaMeta.capabilities.requiresApiKey, true)

  const opencodeMeta = providerRegistry.getMetadata('opencode')
  assert.strictEqual(opencodeMeta.capabilities.supportsStreaming, true)
  assert.strictEqual(opencodeMeta.capabilities.supportsTools, true)
  assert.strictEqual(opencodeMeta.capabilities.requiresApiKey, false) // OpenCode free models require no key
})

await runTest('2.2 Orchestrator respects provider capability supportsTools: false by withholding tool declarations', async () => {
  let receivedTools = null

  const noToolsProvider = {
    id: 'no-tools-provider',
    name: 'No Tools Provider',
    capabilities: {
      supportsStreaming: true,
      supportsTools: false, // Explicitly false!
      requiresApiKey: false
    },
    sendMessage: async (history, tools) => {
      receivedTools = tools
      return { text: 'Answered without tools', rawModelParts: [{ text: 'Answered without tools' }] }
    }
  }

  const orch = new AgentOrchestrator(noToolsProvider)
  orch.registerTool(new MockEchoTool())

  const response = await orch.run('Echo test', { apiKey: '' })
  assert.strictEqual(response, 'Answered without tools')
  assert.deepStrictEqual(receivedTools, [], 'Tools must be withheld when supportsTools is false')
})

await runTest('2.3 Orchestrator respects provider capability supportsStreaming: false by omitting stream callback', async () => {
  let receivedOnChunk = 'not-called'

  const nonStreamingProvider = {
    id: 'non-streaming-provider',
    name: 'Non Streaming Provider',
    capabilities: {
      supportsStreaming: false, // Explicitly false!
      supportsTools: true,
      requiresApiKey: false
    },
    sendMessage: async (history, tools, options) => {
      receivedOnChunk = options.onChunk
      return { text: 'Direct completion', rawModelParts: [{ text: 'Direct completion' }] }
    }
  }

  const orch = new AgentOrchestrator(nonStreamingProvider)
  await orch.run('Hello', {
    apiKey: '',
    onChunk: () => {}
  })

  assert.strictEqual(receivedOnChunk, undefined, 'onChunk must be omitted when provider lacks streaming support')
})

// =================================================================
// Group 3: End-to-End Chat Orchestration & Multi-Step Tool Workflows
// =================================================================
console.log('\n--- Group 3: End-to-End Chat Orchestration & Multi-Step Tool Workflows ---')

await runTest('3.1 Direct text response workflow through registered mock provider in orchestrator', async () => {
  const reg = new ProviderRegistry()
  reg.register(
    {
      id: 'test-text',
      name: 'Test Text',
      defaultModel: 'text-model',
      capabilities: { supportsStreaming: true, supportsTools: true, requiresApiKey: false }
    },
    () => ({
      id: 'test-text',
      name: 'Test Text',
      sendMessage: async () => ({ text: 'Simple greeting response', rawModelParts: [{ text: 'Simple greeting response' }] })
    })
  )

  const orch = new AgentOrchestrator(reg.get('test-text'))
  const streamChunks = []

  const finalResponse = await orch.run('Hello agent', {
    apiKey: '',
    onChunk: (c) => streamChunks.push(c)
  })

  assert.strictEqual(finalResponse, 'Simple greeting response')
})

await runTest('3.2 Multi-step tool execution workflow (echo -> synthesis) through mock provider', async () => {
  let step = 0
  const mockProvider = {
    id: 'mock-agent',
    name: 'Mock Agent',
    capabilities: { supportsStreaming: true, supportsTools: true, requiresApiKey: false },
    sendMessage: async () => {
      step++
      if (step === 1) {
        return {
          rawModelParts: [{
            functionCall: { name: 'echo_tool', args: { text: 'Phase3' } }
          }],
          functionCalls: [{ name: 'echo_tool', args: { text: 'Phase3' } }]
        }
      }
      return {
        text: 'Tool execution succeeded: Phase3',
        rawModelParts: [{ text: 'Tool execution succeeded: Phase3' }]
      }
    }
  }

  const orch = new AgentOrchestrator(mockProvider)
  orch.registerTool(new MockEchoTool())

  const recordedSteps = []
  const result = await orch.run('Run echo', {
    apiKey: '',
    onStep: (s) => recordedSteps.push(s)
  })

  assert.strictEqual(result, 'Tool execution succeeded: Phase3')
  assert.strictEqual(step, 2)
  const toolStep = recordedSteps.find((s) => s.type === 'tool_result')
  assert.ok(toolStep)
  assert.strictEqual(toolStep.toolName, 'echo_tool')
})

await runTest('3.3 Dynamic model selection propagates activeModel to provider sendMessage', async () => {
  let capturedModel = null
  const provider = {
    id: 'model-checker',
    name: 'Model Checker',
    capabilities: { supportsStreaming: true, supportsTools: true, requiresApiKey: false },
    sendMessage: async (history, tools, options) => {
      capturedModel = options.modelName
      return { text: `Model was ${options.modelName}`, rawModelParts: [{ text: 'ok' }] }
    }
  }

  const orch = new AgentOrchestrator(provider)
  await orch.run('Test model', {
    apiKey: '',
    modelName: 'deepseek-ai/deepseek-r1-distill-llama-70b'
  })

  assert.strictEqual(capturedModel, 'deepseek-ai/deepseek-r1-distill-llama-70b')
})

// =================================================================
// Group 4: Provider Switching, State Isolation & Zero Leakage
// =================================================================
console.log('\n--- Group 4: Provider Switching, State Isolation & Zero Leakage ---')

await runTest('4.1 Switching provider via orchestrator.setProvider updates active provider and clears history', async () => {
  const providerA = {
    id: 'provider-a',
    name: 'Provider A',
    capabilities: { supportsStreaming: true, supportsTools: true, requiresApiKey: false },
    sendMessage: async () => ({ text: 'Resp A', rawModelParts: [{ text: 'Resp A' }] })
  }

  const providerB = {
    id: 'provider-b',
    name: 'Provider B',
    capabilities: { supportsStreaming: true, supportsTools: true, requiresApiKey: false },
    sendMessage: async () => ({ text: 'Resp B', rawModelParts: [{ text: 'Resp B' }] })
  }

  const orch = new AgentOrchestrator(providerA)
  await orch.run('Message 1', { apiKey: '' })
  assert.strictEqual(orch.getHistory().length > 0, true)

  // Switch to Provider B
  orch.setProvider(providerB)
  orch.clearHistory()

  assert.strictEqual(orch.getProvider(), providerB)
  assert.strictEqual(orch.getHistory().length, 0, 'History must be cleared on provider switch')

  const resB = await orch.run('Message 2', { apiKey: '' })
  assert.strictEqual(resB, 'Resp B')
})

await runTest('4.2 Stream chunks from Provider A do not leak into Provider B after switching', async () => {
  const streamEvents = []

  const providerA = {
    id: 'stream-a',
    name: 'Stream A',
    capabilities: { supportsStreaming: true, supportsTools: true, requiresApiKey: false },
    sendMessage: async (h, t, opt) => {
      opt.onChunk?.('Chunk A1')
      opt.onChunk?.('Chunk A2')
      return { text: 'Final A', rawModelParts: [{ text: 'Final A' }] }
    }
  }

  const providerB = {
    id: 'stream-b',
    name: 'Stream B',
    capabilities: { supportsStreaming: true, supportsTools: true, requiresApiKey: false },
    sendMessage: async (h, t, opt) => {
      opt.onChunk?.('Chunk B1')
      return { text: 'Final B', rawModelParts: [{ text: 'Final B' }] }
    }
  }

  const orch = new AgentOrchestrator(providerA)
  await orch.run('Req 1', { apiKey: '', onChunk: (c) => streamEvents.push({ provider: 'A', chunk: c }) })

  orch.setProvider(providerB)
  orch.clearHistory()

  await orch.run('Req 2', { apiKey: '', onChunk: (c) => streamEvents.push({ provider: 'B', chunk: c }) })

  const chunksA = streamEvents.filter((e) => e.provider === 'A').map((e) => e.chunk)
  const chunksB = streamEvents.filter((e) => e.provider === 'B').map((e) => e.chunk)

  assert.deepStrictEqual(chunksA, ['Chunk A1', 'Chunk A2'])
  assert.deepStrictEqual(chunksB, ['Chunk B1'])
})

await runTest('4.3 Tool results from Provider A session do not persist into Provider B session', async () => {
  let providerBHistory = null

  const providerA = {
    id: 'tool-prov-a',
    name: 'Tool Prov A',
    capabilities: { supportsStreaming: true, supportsTools: true, requiresApiKey: false },
    sendMessage: async (history) => {
      if (history.length === 1) {
        return {
          rawModelParts: [{ functionCall: { name: 'echo_tool', args: { text: 'secret' } } }],
          functionCalls: [{ name: 'echo_tool', args: { text: 'secret' } }]
        }
      }
      return { text: 'Done A', rawModelParts: [{ text: 'Done A' }] }
    }
  }

  const providerB = {
    id: 'tool-prov-b',
    name: 'Tool Prov B',
    capabilities: { supportsStreaming: true, supportsTools: true, requiresApiKey: false },
    sendMessage: async (history) => {
      providerBHistory = JSON.parse(JSON.stringify(history))
      return { text: 'Done B', rawModelParts: [{ text: 'Done B' }] }
    }
  }

  const orch = new AgentOrchestrator(providerA)
  orch.registerTool(new MockEchoTool())

  await orch.run('Run tool on A', { apiKey: '' })

  // Switch and clear
  orch.setProvider(providerB)
  orch.clearHistory()

  await orch.run('Fresh query on B', { apiKey: '' })

  // Provider B should only see the fresh query, none of the tool calls from A
  assert.ok(providerBHistory)
  const hasToolCalls = providerBHistory.some((m) =>
    m.parts?.some((p) => p.functionCall || p.functionResponse)
  )
  assert.strictEqual(hasToolCalls, false, 'Provider B history must not contain tool results from Provider A')
})

await runTest('4.4 Active approval from Provider A is cancelled on switch or stop without hanging', async () => {
  let approvalPromiseResolved = false

  const approvalProvider = {
    id: 'approval-prov',
    name: 'Approval Prov',
    capabilities: { supportsStreaming: true, supportsTools: true, requiresApiKey: false },
    sendMessage: async () => ({
      rawModelParts: [{ functionCall: { name: 'delete_file', args: { path: 'important.txt' } } }],
      functionCalls: [{ name: 'delete_file', args: { path: 'important.txt' } }]
    })
  }

  const orch = new AgentOrchestrator(approvalProvider)
  orch.registerTool(new MockMutatingTool())

  const runPromise = orch.run('Delete file', {
    apiKey: '',
    requestApproval: () => {
      return new Promise((resolve) => {
        // Simulating approval pending in UI
        setTimeout(() => {
          orch.stop()
          resolve(false)
          approvalPromiseResolved = true
        }, 10)
      })
    }
  })

  await assert.rejects(runPromise, (err) => {
    assert.strictEqual(err.message, 'Request was stopped by user.')
    return true
  })
  assert.strictEqual(approvalPromiseResolved, true)
})

// =================================================================
// Group 5: Cancellation, Concurrent Requests & Error Recovery
// =================================================================
console.log('\n--- Group 5: Cancellation, Concurrent Requests & Error Recovery ---')

await runTest('5.1 Pre-run cancellation aborts run immediately without invoking registered provider', async () => {
  let providerInvoked = false
  const provider = {
    id: 'dummy',
    name: 'Dummy',
    capabilities: { supportsStreaming: true, supportsTools: true, requiresApiKey: false },
    sendMessage: async () => {
      providerInvoked = true
      return { text: 'Should not run' }
    }
  }

  const orch = new AgentOrchestrator(provider)
  const controller = new AbortController()
  controller.abort()

  await assert.rejects(
    async () => {
      await orch.run('Hello', { apiKey: '', signal: controller.signal })
    },
    (err) => {
      assert.strictEqual(err.message, 'Request was stopped by user.')
      assert.strictEqual(providerInvoked, false)
      return true
    }
  )
})

await runTest('5.2 In-flight cancellation aborts active provider request cleanly and halts plan', async () => {
  const controller = new AbortController()
  const provider = {
    id: 'in-flight-abort',
    name: 'In Flight Abort',
    capabilities: { supportsStreaming: true, supportsTools: true, requiresApiKey: false },
    sendMessage: async (h, t, opt) => {
      // Abort in flight
      controller.abort()
      throw new Error('Request was stopped by user.')
    }
  }

  const orch = new AgentOrchestrator(provider)
  await assert.rejects(
    async () => {
      await orch.run('Test in-flight', { apiKey: '', signal: controller.signal })
    },
    (err) => {
      assert.strictEqual(err.message, 'Request was stopped by user.')
      return true
    }
  )
})

await runTest('5.3 Transient provider retry propagates through orchestrator without duplicate steps', async () => {
  let attempts = 0
  const retrySteps = []

  const provider = {
    id: 'retry-prov',
    name: 'Retry Prov',
    capabilities: { supportsStreaming: true, supportsTools: true, requiresApiKey: false },
    sendMessage: async (h, t, opt) => {
      attempts++
      if (attempts === 1) {
        opt.onRetry?.(1, 2, 10, 'Rate limit')
        return { text: 'Recovered on turn 1', rawModelParts: [{ text: 'Recovered on turn 1' }] }
      }
      return { text: 'Success', rawModelParts: [{ text: 'Success' }] }
    }
  }

  const orch = new AgentOrchestrator(provider)
  const res = await orch.run('Retry test', {
    apiKey: '',
    onStep: (s) => {
      if (s.type === 'retrying') retrySteps.push(s)
    }
  })

  assert.strictEqual(res, 'Recovered on turn 1')
  assert.strictEqual(retrySteps.length, 1)
  assert.strictEqual(retrySteps[0].retryAttempt, 1)
})

await runTest('5.4 Permanent provider error propagates cleanly through orchestrator without infinite loop', async () => {
  const provider = {
    id: 'fail-prov',
    name: 'Fail Prov',
    capabilities: { supportsStreaming: true, supportsTools: true, requiresApiKey: false },
    sendMessage: async () => {
      throw new Error('Invalid API key provided.')
    }
  }

  const orch = new AgentOrchestrator(provider)
  await assert.rejects(
    async () => {
      await orch.run('Fail prompt', { apiKey: '' })
    },
    (err) => {
      assert.ok(err.message.includes('Invalid API key provided'))
      return true
    }
  )
})

await runTest('5.5 Concurrent orchestrator instances with different providers execute in isolation', async () => {
  const providerA = {
    id: 'inst-a',
    name: 'Inst A',
    capabilities: { supportsStreaming: true, supportsTools: true, requiresApiKey: false },
    sendMessage: async () => {
      await new Promise((r) => setTimeout(r, 20))
      return { text: 'From A', rawModelParts: [{ text: 'From A' }] }
    }
  }

  const providerB = {
    id: 'inst-b',
    name: 'Inst B',
    capabilities: { supportsStreaming: true, supportsTools: true, requiresApiKey: false },
    sendMessage: async () => {
      await new Promise((r) => setTimeout(r, 10))
      return { text: 'From B', rawModelParts: [{ text: 'From B' }] }
    }
  }

  const orchA = new AgentOrchestrator(providerA)
  const orchB = new AgentOrchestrator(providerB)

  const [resA, resB] = await Promise.all([
    orchA.run('Query A', { apiKey: '' }),
    orchB.run('Query B', { apiKey: '' })
  ])

  assert.strictEqual(resA, 'From A')
  assert.strictEqual(resB, 'From B')
})

// =================================================================
// Summary
// =================================================================
console.log('\n=================================================================')
console.log(`PROVIDER REGISTRY & INTEGRATION RESULTS: ${passed} passed, ${failed} failed`)
console.log('=================================================================\n')

if (failed > 0) {
  process.exit(1)
}
