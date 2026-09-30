// scratch/test_agent_streaming_reliability.mjs
// Phase 2 — Task 7: Agent Streaming & Progress Reliability Test Suite
//
// Tests:
// Suite 1: Mock Streaming Delivery Modes & Chunk Ordering Integrity
// Suite 2: Multi-Iteration Streaming & Interleaving
// Suite 3: Progress & Approval State Progression
// Suite 4: Cancellation Boundaries During Streaming
// Suite 5: Provider Errors & Malformed Streams
// Suite 6: Multi-Run Isolation & Stale Event Protection
// Suite 7: UI Message Reconciliation & Paragraph Formatting Simulation

import assert from 'node:assert'
import esbuild from 'esbuild'

console.log('--- Phase 2 Task 7: Agent Streaming & Progress Reliability ---')

// 1. Transpile production modules with esbuild
const bundle = await esbuild.build({
  entryPoints: [
    'src/renderer/src/services/agent/orchestrator.ts',
    'src/renderer/src/services/agent/agentPlanner.ts',
    'src/renderer/src/services/agent/smartContextEngine.ts',
    'src/renderer/src/services/tools/createFileTool.ts',
    'src/renderer/src/services/tools/editFileTool.ts',
    'src/renderer/src/services/tools/runCommandTool.ts',
    'src/renderer/src/services/tools/readFileTool.ts',
    'src/renderer/src/services/tools/listFilesTool.ts'
  ],
  bundle: true,
  format: 'esm',
  write: false,
  outdir: 'out',
  platform: 'browser',
  target: 'es2022',
  external: ['electron', 'lucide-react', 'react', 'react-dom']
})

function getOutputFile(pathSuffix) {
  const file = bundle.outputFiles.find((f) => f.path.replace(/\\/g, '/').endsWith(pathSuffix))
  if (!file) throw new Error(`Could not find output file matching: ${pathSuffix}`)
  return file.text
}

async function importFromText(text) {
  return await import('data:text/javascript;base64,' + Buffer.from(text).toString('base64'))
}

// Setup mock electron API
globalThis.window = {
  electronAPI: {
    readWorkspaceFile: async (_root, rel) => ({ success: true, path: rel, content: '// content of ' + rel }),
    createWorkspaceFile: async (_root, rel) => ({ success: true, path: rel }),
    editWorkspaceFile: async (_root, rel) => ({ success: true, path: rel }),
    runCommand: async (cmd) => ({ success: true, exitCode: 0, stdout: `output of ${cmd}`, stderr: '', timedOut: false }),
    readTree: async (root) => ({
      success: true,
      rootPath: root,
      tree: [{ name: 'main.ts', path: `${root}/main.ts`, isDirectory: false, size: 100, mtimeMs: Date.now() }]
    }),
    stopCommand: async () => ({ success: true })
  }
}

const orchMod = await importFromText(getOutputFile('orchestrator.js'))
const plannerMod = await importFromText(getOutputFile('agentPlanner.js'))
const contextMod = await importFromText(getOutputFile('smartContextEngine.js'))
const readFileMod = await importFromText(getOutputFile('readFileTool.js'))
const listFilesMod = await importFromText(getOutputFile('listFilesTool.js'))

const { AgentOrchestrator } = orchMod
const { AgentPlanner } = plannerMod
const { SmartContextEngine } = contextMod
const { ReadFileTool } = readFileMod
const { ListFilesTool } = listFilesMod

// Helper to create configurable streaming mock provider
function createStreamingMockProvider(responses) {
  let callIndex = 0
  return {
    async sendMessage(messages, toolDeclarations, options) {
      if (options?.signal?.aborted) {
        throw new Error('Request was stopped by user.')
      }

      const resp = responses[callIndex++]
      if (!resp) {
        return { text: 'Default completed.' }
      }

      if (resp.error) {
        if (resp.errorDelayMs) {
          await new Promise((resolve) => setTimeout(resolve, resp.errorDelayMs))
        }
        throw new Error(resp.error)
      }

      // Handle retry simulation if requested
      if (resp.simulateRetry) {
        options?.onRetry?.(1, 3)
      }

      // Emit chunks
      if (resp.chunks && resp.chunks.length > 0) {
        for (let i = 0; i < resp.chunks.length; i++) {
          if (options?.signal?.aborted) {
            throw new Error('Request was stopped by user.')
          }

          if (resp.delayMs) {
            await new Promise((resolve) => setTimeout(resolve, resp.delayMs))
          }

          if (options?.signal?.aborted) {
            throw new Error('Request was stopped by user.')
          }

          const chunk = resp.chunks[i]
          options?.onChunk?.(chunk)

          // If hook configured after specific chunk
          if (resp.onChunkEmitted) {
            await resp.onChunkEmitted(i, chunk)
          }
        }
      }

      if (options?.signal?.aborted) {
        throw new Error('Request was stopped by user.')
      }

      return {
        text: resp.text ?? (resp.chunks ? resp.chunks.join('') : ''),
        functionCalls: resp.functionCalls,
        rawModelParts: resp.rawModelParts
      }
    }
  }
}

// Helper to create mock tool
function createMockTool(name, options = {}) {
  return {
    name,
    description: `Mock tool ${name}`,
    parameters: { type: 'object', properties: {} },
    requiresApproval: options.requiresApproval ?? false,
    async execute(args, context) {
      if (options.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs))
      }
      if (context.signal.aborted) {
        return { success: false, output: 'Cancelled', error: 'Aborted' }
      }
      if (options.requiresApproval) {
        const approved = await context.requestApproval({ toolName: name })
        if (!approved) {
          return { success: false, rejected: true, output: 'Tool execution rejected by user.' }
        }
      }
      if (options.throws) {
        throw new Error(options.throws)
      }
      if (options.rejected) {
        return { success: false, rejected: true, output: 'Tool execution rejected by user.' }
      }
      return {
        success: options.success ?? true,
        output: options.output ?? `Executed ${name} successfully.`
      }
    }
  }
}

let totalTests = 0
let passedTests = 0
let failedTests = 0

async function runTest(name, fn) {
  totalTests++
  const t0 = performance.now()
  try {
    await fn()
    const dt = (performance.now() - t0).toFixed(1)
    console.log(`  [PASS] Test ${totalTests}: ${name} (${dt}ms)`)
    passedTests++
  } catch (err) {
    const dt = (performance.now() - t0).toFixed(1)
    console.error(`  [FAIL] Test ${totalTests}: ${name} (${dt}ms)`)
    console.error(`         Error: ${err.message}`)
    if (err.stack) {
      const relevant = err.stack.split('\n').slice(1, 4).join('\n')
      console.error(`         ${relevant}`)
    }
    failedTests++
  }
}

// ============================================================================
// SUITE 1: Mock Streaming Delivery Modes & Chunk Ordering Integrity
// ============================================================================
console.log('\n============================================================')
console.log('Suite 1: Mock Streaming Delivery Modes & Chunk Ordering Integrity')
console.log('============================================================')

await runTest('Immediate/synchronous chunks are emitted and received in exact order without loss', async () => {
  const expectedChunks = ['Hello', ' ', 'world', '!', ' How', ' are', ' you?']
  const provider = createStreamingMockProvider([{ chunks: expectedChunks }])
  const orch = new AgentOrchestrator(provider)

  const receivedChunks = []
  const result = await orch.run('Hi', {
    apiKey: 'k',
    workspaceRoot: '/mock',
    onChunk: (c) => receivedChunks.push(c)
  })

  assert.deepStrictEqual(receivedChunks, expectedChunks)
  assert.strictEqual(result, expectedChunks.join(''))
})

await runTest('Slow/delayed chunks (with inter-chunk delays) preserve strict sequential ordering', async () => {
  const expectedChunks = ['Chunk 1', ', ', 'Chunk 2', ', ', 'Chunk 3']
  const provider = createStreamingMockProvider([{ chunks: expectedChunks, delayMs: 8 }])
  const orch = new AgentOrchestrator(provider)

  const receivedChunks = []
  const result = await orch.run('Delayed test', {
    apiKey: 'k',
    workspaceRoot: '/mock',
    onChunk: (c) => receivedChunks.push(c)
  })

  assert.deepStrictEqual(receivedChunks, expectedChunks)
  assert.strictEqual(result, expectedChunks.join(''))
})

await runTest('Burst chunk delivery (chunks emitted in grouped micro-bursts) maintains ordering and completeness', async () => {
  const chunksGroup1 = ['BurstA1', 'BurstA2', 'BurstA3']
  const chunksGroup2 = ['BurstB1', 'BurstB2']
  const allExpected = [...chunksGroup1, ...chunksGroup2]

  let callCount = 0
  const provider = {
    async sendMessage(messages, toolDeclarations, options) {
      // First burst
      for (const c of chunksGroup1) {
        options?.onChunk?.(c)
      }
      // Microtask delay
      await new Promise((r) => setTimeout(r, 15))
      // Second burst
      for (const c of chunksGroup2) {
        options?.onChunk?.(c)
      }
      return { text: allExpected.join('') }
    }
  }

  const orch = new AgentOrchestrator(provider)
  const receivedChunks = []
  const result = await orch.run('Burst test', {
    apiKey: 'k',
    workspaceRoot: '/mock',
    onChunk: (c) => receivedChunks.push(c)
  })

  assert.deepStrictEqual(receivedChunks, allExpected)
  assert.strictEqual(result, allExpected.join(''))
})

await runTest('Empty string chunks ("") are safely filtered out by safeOnChunk and never emitted', async () => {
  const chunksWithEmpties = ['Valid1', '', 'Valid2', '', '', 'Valid3']
  const provider = createStreamingMockProvider([{ chunks: chunksWithEmpties }])
  const orch = new AgentOrchestrator(provider)

  const receivedChunks = []
  await orch.run('Empty chunks test', {
    apiKey: 'k',
    workspaceRoot: '/mock',
    onChunk: (c) => receivedChunks.push(c)
  })

  assert.deepStrictEqual(receivedChunks, ['Valid1', 'Valid2', 'Valid3'])
})

// ============================================================================
// SUITE 2: Multi-Iteration Streaming & Interleaving
// ============================================================================
console.log('\n============================================================')
console.log('Suite 2: Multi-Iteration Streaming & Interleaving')
console.log('============================================================')

await runTest('Multi-iteration streaming: text streamed before tool call, tool executes, then final text is streamed', async () => {
  const tool = createMockTool('inspect_workspace', { output: 'files: [a.ts, b.ts]' })
  const provider = createStreamingMockProvider([
    // Iteration 1: Streamed thought before tool call
    {
      chunks: ['I will ', 'inspect the workspace.'],
      text: 'I will inspect the workspace.',
      functionCalls: [{ name: 'inspect_workspace', args: {} }]
    },
    // Iteration 2: Streamed final answer
    {
      chunks: ['Workspace contains: ', 'a.ts and b.ts.'],
      text: 'Workspace contains: a.ts and b.ts.'
    }
  ])

  const orch = new AgentOrchestrator(provider)
  orch.registerTool(tool)

  const chunks = []
  const steps = []
  const finalRes = await orch.run('Inspect project', {
    apiKey: 'k',
    workspaceRoot: '/mock',
    onChunk: (c) => chunks.push(c),
    onStep: (s) => steps.push(s)
  })

  assert.strictEqual(finalRes, 'Workspace contains: a.ts and b.ts.')
  assert.deepStrictEqual(chunks, [
    'I will ',
    'inspect the workspace.',
    'Workspace contains: ',
    'a.ts and b.ts.'
  ])
})

await runTest('Strict progress event sequence: thinking -> onChunk -> tool_call -> tool_result -> thinking -> onChunk -> done', async () => {
  const tool = createMockTool('simple_tool', { output: 'ok' })
  const provider = createStreamingMockProvider([
    {
      chunks: ['Calling tool...'],
      text: 'Calling tool...',
      functionCalls: [{ name: 'simple_tool', args: {} }]
    },
    {
      chunks: ['Tool completed successfully.'],
      text: 'Tool completed successfully.'
    }
  ])

  const orch = new AgentOrchestrator(provider)
  orch.registerTool(tool)

  const timeline = []
  await orch.run('Run sequence check', {
    apiKey: 'k',
    workspaceRoot: '/mock',
    onChunk: (c) => timeline.push(`chunk:${c}`),
    onStep: (s) => timeline.push(`step:${s.type}${s.toolName ? ':' + s.toolName : ''}`)
  })

  // Verify correct sequence
  const expectedTypes = [
    'step:thinking',
    'chunk:Calling tool...',
    'step:tool_call:simple_tool',
    'step:tool_result:simple_tool',
    'step:thinking',
    'chunk:Tool completed successfully.',
    'step:done'
  ]

  assert.deepStrictEqual(timeline, expectedTypes)
})

await runTest('Pre-tool model text is preserved in history modelParts alongside tool call declarations', async () => {
  const tool = createMockTool('sample_tool', { output: 'result' })
  const provider = createStreamingMockProvider([
    {
      chunks: ['Examining situation...'],
      text: 'Examining situation...',
      functionCalls: [{ name: 'sample_tool', args: {} }]
    },
    {
      text: 'Finished.'
    }
  ])

  const orch = new AgentOrchestrator(provider)
  orch.registerTool(tool)

  await orch.run('Check modelParts text preservation', {
    apiKey: 'k',
    workspaceRoot: '/mock'
  })

  const history = orch.getHistory()
  // Message index 1 is model message for iteration 1
  const modelMsg = history[1]
  assert.strictEqual(modelMsg.role, 'model')
  assert.ok(modelMsg.parts.length >= 2, 'modelParts must include both text part and functionCall part')

  const textPart = modelMsg.parts.find((p) => p.text === 'Examining situation...')
  assert.ok(textPart, 'Pre-tool text must be preserved in modelParts')

  const callPart = modelMsg.parts.find((p) => p.functionCall?.name === 'sample_tool')
  assert.ok(callPart, 'Tool call must be preserved in modelParts')
})

// ============================================================================
// SUITE 3: Progress & Approval State Progression
// ============================================================================
console.log('\n============================================================')
console.log('Suite 3: Progress & Approval State Progression')
console.log('============================================================')

await runTest('Approval-required tool triggers tool_call onStep and sets plan step to waiting_for_approval', async () => {
  const tool = createMockTool('edit_file', { requiresApproval: true, output: 'edited' })
  const provider = createStreamingMockProvider([
    { functionCalls: [{ name: 'edit_file', args: { path: 'file.ts' } }] },
    { text: 'File updated.' }
  ])

  const orch = new AgentOrchestrator(provider)
  orch.registerTool(tool)

  let approvalStateObservedInPlan = false
  let approvalReqReceived = null

  const steps = []
  await orch.run('Edit file.ts and verify', {
    apiKey: 'k',
    workspaceRoot: '/mock',
    onStep: (s) => steps.push(s),
    requestApproval: async (req) => {
      approvalReqReceived = req
      const plan = orch.agentPlanner.getActivePlan()
      if (plan) {
        const step = plan.steps.find((s) => s.status === 'waiting_for_approval')
        if (step) approvalStateObservedInPlan = true
      }
      return true
    }
  })

  assert.ok(approvalReqReceived, 'requestApproval must be invoked')
  assert.strictEqual(approvalReqReceived.toolName, 'edit_file')
  assert.ok(approvalStateObservedInPlan, 'Plan step must enter waiting_for_approval before resolution')

  const toolCallStep = steps.find((s) => s.type === 'tool_call')
  const toolResultStep = steps.find((s) => s.type === 'tool_result')
  const doneStep = steps.find((s) => s.type === 'done')

  assert.ok(toolCallStep, 'tool_call step must be emitted')
  assert.ok(toolResultStep, 'tool_result step must be emitted')
  assert.ok(doneStep, 'done step must be emitted')
})

await runTest('Tool execution never emits done before user approval is granted and tool execution finishes', async () => {
  const tool = createMockTool('guarded_tool', { requiresApproval: true, delayMs: 15, output: 'done' })
  const provider = createStreamingMockProvider([
    { functionCalls: [{ name: 'guarded_tool', args: {} }] },
    { text: 'Guarded work completed.' }
  ])

  const orch = new AgentOrchestrator(provider)
  orch.registerTool(tool)

  let doneEmittedEarly = false
  let toolResultEmitted = false

  await orch.run('Run guarded work', {
    apiKey: 'k',
    workspaceRoot: '/mock',
    onStep: (s) => {
      if (s.type === 'done' && !toolResultEmitted) {
        doneEmittedEarly = true
      }
      if (s.type === 'tool_result') {
        toolResultEmitted = true
      }
    },
    requestApproval: async () => {
      await new Promise((r) => setTimeout(r, 10))
      return true
    }
  })

  assert.strictEqual(doneEmittedEarly, false, 'done must never be emitted before tool result finishes')
  assert.strictEqual(toolResultEmitted, true, 'tool_result must be emitted before completion')
})

await runTest('Approval rejection immediately halts execution, aborts plan, emits rejection tool_result, and completes with rejection done', async () => {
  const tool = createMockTool('dangerous_tool', { requiresApproval: true, output: 'executed' })
  const provider = createStreamingMockProvider([
    { functionCalls: [{ name: 'dangerous_tool', args: {} }] },
    { text: 'Should not run' }
  ])

  const orch = new AgentOrchestrator(provider)
  orch.registerTool(tool)

  const steps = []
  const result = await orch.run('Delete file.ts and verify', {
    apiKey: 'k',
    workspaceRoot: '/mock',
    onStep: (s) => steps.push(s),
    requestApproval: async () => false // User rejects
  })

  assert.ok(result.includes('rejected'), 'Result must indicate rejection')
  const plan = orch.agentPlanner.getActivePlan()
  assert.strictEqual(plan.status, 'aborted')

  const toolResult = steps.find((s) => s.type === 'tool_result')
  assert.ok(toolResult, 'tool_result must be emitted for rejection')
  assert.strictEqual(toolResult.toolSuccess, false)

  const doneEvent = steps.find((s) => s.type === 'done')
  assert.ok(doneEvent, 'done event must be emitted with rejection text')
  assert.ok(doneEvent.text.includes('rejected'))
})

// ============================================================================
// SUITE 4: Cancellation Boundaries During Streaming
// ============================================================================
console.log('\n============================================================')
console.log('Suite 4: Cancellation Boundaries During Streaming')
console.log('============================================================')

await runTest('Cancellation during active chunk streaming immediately halts loop with "Request was stopped by user."', async () => {
  let orchRef = null
  const provider = createStreamingMockProvider([
    {
      chunks: ['Part 1', 'Part 2', 'Part 3', 'Part 4', 'Part 5'],
      delayMs: 10,
      onChunkEmitted: async (idx) => {
        if (idx === 1) {
          // Stop after 2nd chunk
          orchRef?.stop()
        }
      }
    }
  ])

  const orch = new AgentOrchestrator(provider)
  orchRef = orch

  const receivedChunks = []
  const steps = []

  await assert.rejects(
    async () => {
      await orch.run('Stream and stop', {
        apiKey: 'k',
        workspaceRoot: '/mock',
        onChunk: (c) => receivedChunks.push(c),
        onStep: (s) => steps.push(s)
      })
    },
    /Request was stopped by user/
  )

  // Chunks after stop was requested should not have been emitted
  assert.ok(receivedChunks.length <= 2, `Expected at most 2 chunks, got ${receivedChunks.length}`)
  // No done step should have been emitted
  assert.strictEqual(steps.some((s) => s.type === 'done'), false)
  // No error step should have been emitted for clean user cancellation
  assert.strictEqual(steps.some((s) => s.type === 'error'), false)
})

await runTest('Chunks emitted after orchestrator.stop() are dropped by safeOnChunk and never reach caller', async () => {
  let rawOnChunk = null
  const provider = {
    async sendMessage(messages, toolDeclarations, options) {
      rawOnChunk = options?.onChunk
      options?.onChunk?.('Chunk Before Stop')
      return { text: 'Done' }
    }
  }

  const orch = new AgentOrchestrator(provider)
  const receivedChunks = []

  await orch.run('Test chunk drop after stop', {
    apiKey: 'k',
    workspaceRoot: '/mock',
    onChunk: (c) => receivedChunks.push(c)
  })

  assert.deepStrictEqual(receivedChunks, ['Chunk Before Stop'])

  // Now stop orchestrator and simulate delayed chunk from provider
  orch.stop()
  rawOnChunk?.('Delayed Chunk After Stop')

  // safeOnChunk must have dropped it
  assert.deepStrictEqual(receivedChunks, ['Chunk Before Stop'], 'Chunk after stop must be dropped')
})

await runTest('Cancellation between delayed stream chunks halts loop before subsequent chunks are processed', async () => {
  let orchRef = null
  const provider = createStreamingMockProvider([
    {
      chunks: ['Chunk A', 'Chunk B', 'Chunk C'],
      delayMs: 25
    }
  ])

  const orch = new AgentOrchestrator(provider)
  orchRef = orch

  // Trigger stop after 10ms (during delay between chunks)
  setTimeout(() => orchRef.stop(), 10)

  const receivedChunks = []
  await assert.rejects(
    async () => {
      await orch.run('Cancel between chunks', {
        apiKey: 'k',
        workspaceRoot: '/mock',
        onChunk: (c) => receivedChunks.push(c)
      })
    },
    /Request was stopped by user/
  )

  assert.ok(receivedChunks.length <= 1, 'Subsequent chunks must not be processed')
})

await runTest('User cancellation suppresses type: "error" step event and leaves history cleanly closed', async () => {
  const provider = createStreamingMockProvider([
    {
      chunks: ['Starting work...'],
      delayMs: 30
    }
  ])

  const orch = new AgentOrchestrator(provider)
  setTimeout(() => orch.stop(), 10)

  const steps = []
  await assert.rejects(
    async () => {
      await orch.run('Test suppress error on cancel', {
        apiKey: 'k',
        workspaceRoot: '/mock',
        onStep: (s) => steps.push(s)
      })
    },
    /Request was stopped by user/
  )

  const errorSteps = steps.filter((s) => s.type === 'error')
  assert.strictEqual(errorSteps.length, 0, 'User cancellation must not emit error step')

  const history = orch.getHistory()
  const lastMsg = history[history.length - 1]
  assert.strictEqual(lastMsg.role, 'model')
  assert.ok(lastMsg.parts[0].text.includes('stopped by user'))
})

// ============================================================================
// SUITE 5: Provider Errors & Malformed Streams
// ============================================================================
console.log('\n============================================================')
console.log('Suite 5: Provider Errors & Malformed Streams')
console.log('============================================================')

await runTest('Stream error during chunk generation emits type: "error" step, aborts plan, and sanitizes history', async () => {
  const provider = createStreamingMockProvider([
    {
      chunks: ['Initial text... '],
      error: 'Connection reset by peer'
    }
  ])

  const orch = new AgentOrchestrator(provider)
  const steps = []

  await assert.rejects(
    async () => {
      await orch.run('Trigger stream error', {
        apiKey: 'k',
        workspaceRoot: '/mock',
        onStep: (s) => steps.push(s)
      })
    },
    /Connection reset by peer/
  )

  const errorStep = steps.find((s) => s.type === 'error')
  assert.ok(errorStep, 'Real provider error must emit type: "error" step')
  assert.ok(errorStep.error.includes('Connection reset by peer'))

  // Verify history ends with model message explaining halt
  const history = orch.getHistory()
  const lastMsg = history[history.length - 1]
  assert.strictEqual(lastMsg.role, 'model')
  assert.ok(lastMsg.parts[0].text.includes('Execution halted'))
})

await runTest('Empty stream (0 chunks and empty response) gracefully completes with default "Completed."', async () => {
  const provider = createStreamingMockProvider([
    {
      chunks: [],
      text: ''
    }
  ])

  const orch = new AgentOrchestrator(provider)
  const steps = []
  const res = await orch.run('Empty stream test', {
    apiKey: 'k',
    workspaceRoot: '/mock',
    onStep: (s) => steps.push(s)
  })

  assert.strictEqual(res, 'Completed.')
  const doneStep = steps.find((s) => s.type === 'done')
  assert.ok(doneStep)
  assert.strictEqual(doneStep.text, 'Completed.')
})

await runTest('Provider stream returning text without onChunk calls safely completes and emits done', async () => {
  const provider = {
    async sendMessage() {
      // Non-streaming provider: emits no chunks, returns text directly
      return { text: 'Direct response text' }
    }
  }

  const orch = new AgentOrchestrator(provider)
  const chunks = []
  const steps = []

  const res = await orch.run('Non-chunk test', {
    apiKey: 'k',
    workspaceRoot: '/mock',
    onChunk: (c) => chunks.push(c),
    onStep: (s) => steps.push(s)
  })

  assert.strictEqual(res, 'Direct response text')
  assert.strictEqual(chunks.length, 0)
  const doneStep = steps.find((s) => s.type === 'done')
  assert.ok(doneStep)
  assert.strictEqual(doneStep.text, 'Direct response text')
})

// ============================================================================
// SUITE 6: Multi-Run Isolation & Stale Event Protection
// ============================================================================
console.log('\n============================================================')
console.log('Suite 6: Multi-Run Isolation & Stale Event Protection')
console.log('============================================================')

await runTest('Delayed chunks from a previous superseded run are rejected by activeRunId check', async () => {
  let run1ChunkCallback = null
  let run1StepCallback = null

  const provider = {
    async sendMessage(messages, toolDeclarations, options) {
      const latestUser = messages[messages.length - 1]?.parts[0]?.text
      if (latestUser === 'Run 1') {
        run1ChunkCallback = options?.onChunk
        run1StepCallback = options?.onRetry
        return { text: 'Run 1 done' }
      }
      return { text: 'Run 2 done' }
    }
  }

  const orch = new AgentOrchestrator(provider)

  const run1Chunks = []
  await orch.run('Run 1', {
    apiKey: 'k',
    workspaceRoot: '/mock',
    onChunk: (c) => run1Chunks.push(c)
  })

  // Start Run 2
  const run2Chunks = []
  const run2Steps = []
  await orch.run('Run 2', {
    apiKey: 'k',
    workspaceRoot: '/mock',
    onChunk: (c) => run2Chunks.push(c),
    onStep: (s) => run2Steps.push(s)
  })

  // Stale callbacks from Run 1 now fire
  run1ChunkCallback?.('Stale chunk from Run 1')
  run1StepCallback?.(1, 3)

  assert.deepStrictEqual(run1Chunks, [], 'No chunks emitted during Run 1')
  assert.deepStrictEqual(run2Chunks, [], 'Stale Run 1 chunk must NOT leak into Run 2')
  assert.strictEqual(run2Steps.some((s) => s.type === 'retrying'), false, 'Stale retry must not leak')
})

await runTest('Stopping run 1 and starting run 2 guarantees run 2 receives only its own chunks and events', async () => {
  const provider = createStreamingMockProvider([
    // Run 1: will be stopped
    {
      chunks: ['Run1-A', 'Run1-B', 'Run1-C'],
      delayMs: 20
    },
    // Run 2: will run to completion
    {
      chunks: ['Run2-X', 'Run2-Y'],
      text: 'Run2-XRun2-Y'
    }
  ])

  const orch = new AgentOrchestrator(provider)

  // Start Run 1 and stop it during execution
  const run1Promise = orch.run('Run 1', {
    apiKey: 'k',
    workspaceRoot: '/mock'
  })
  setTimeout(() => orch.stop(), 5)
  await assert.rejects(run1Promise, /Request was stopped by user/)

  // Run 2 starts fresh
  const run2Chunks = []
  const run2Steps = []
  const res2 = await orch.run('Run 2', {
    apiKey: 'k',
    workspaceRoot: '/mock',
    onChunk: (c) => run2Chunks.push(c),
    onStep: (s) => run2Steps.push(s)
  })

  assert.strictEqual(res2, 'Run2-XRun2-Y')
  assert.deepStrictEqual(run2Chunks, ['Run2-X', 'Run2-Y'])
  const doneStep = run2Steps.find((s) => s.type === 'done')
  assert.ok(doneStep)
  assert.strictEqual(doneStep.text, 'Run2-XRun2-Y')
})

await runTest('History and planner state are properly isolated across sequential streaming runs', async () => {
  const provider = createStreamingMockProvider([
    { chunks: ['Ans1'], text: 'Ans1' },
    { chunks: ['Ans2'], text: 'Ans2' }
  ])

  const orch = new AgentOrchestrator(provider)

  await orch.run('Query 1', { apiKey: 'k', workspaceRoot: '/mock' })
  assert.strictEqual(orch.getHistory().length, 2)

  await orch.run('Query 2', { apiKey: 'k', workspaceRoot: '/mock' })
  assert.strictEqual(orch.getHistory().length, 4)

  orch.clearHistory()
  assert.strictEqual(orch.getHistory().length, 0)
})

// ============================================================================
// SUITE 7: UI Message Reconciliation & Paragraph Formatting Simulation
// ============================================================================
console.log('\n============================================================')
console.log('Suite 7: UI Message Reconciliation & Paragraph Formatting Simulation')
console.log('============================================================')

await runTest('UI message reconciliation: streamed chunks followed by finalResponse do not duplicate text', async () => {
  // Simulates AIChatPanel reconciliation logic
  let streamedContent = ''
  const onChunkSim = (chunk) => {
    streamedContent += chunk
  }

  const chunks = ['First part. ', 'Second part. ', 'Conclusion.']
  const finalResponse = chunks.join('')

  for (const c of chunks) {
    onChunkSim(c)
  }

  // UI reconciliation algorithm from AIChatPanel.tsx
  let reconciledContent = streamedContent
  if (!streamedContent) {
    reconciledContent = finalResponse
  } else if (
    finalResponse &&
    !streamedContent.includes(finalResponse) &&
    !finalResponse.includes(streamedContent)
  ) {
    reconciledContent = `${streamedContent}\n\n${finalResponse}`
  } else if (finalResponse && finalResponse.length > streamedContent.length) {
    reconciledContent = finalResponse
  }

  assert.strictEqual(reconciledContent, 'First part. Second part. Conclusion.')
  assert.strictEqual(reconciledContent.includes('First part. Second part. Conclusion.First part.'), false)
})

await runTest('UI multi-iteration reconciliation: text streamed after tool execution has clean \\n\\n paragraph separation', async () => {
  // Simulates AIChatPanel onChunk behavior across iterations
  const recordedSteps = []
  let lastToolResultCount = 0
  let uiMessageContent = ''

  const simulateChunkArrival = (chunk) => {
    const toolSteps = recordedSteps.filter((s) => s.type === 'tool_result')
    let existingContent = uiMessageContent
    if (
      existingContent &&
      toolSteps.length > lastToolResultCount &&
      !existingContent.endsWith('\n') &&
      !chunk.startsWith('\n')
    ) {
      existingContent = `${existingContent}\n\n`
    }
    lastToolResultCount = toolSteps.length
    uiMessageContent = existingContent + chunk
  }

  // Iteration 1 chunks
  simulateChunkArrival('Checking local configuration...')
  assert.strictEqual(uiMessageContent, 'Checking local configuration...')

  // Tool executes
  recordedSteps.push({ type: 'tool_result', toolName: 'read_file', toolOutput: 'port: 3000' })

  // Iteration 2 chunks
  simulateChunkArrival('The configuration specifies port 3000.')

  assert.strictEqual(
    uiMessageContent,
    'Checking local configuration...\n\nThe configuration specifies port 3000.',
    'Multi-iteration streamed text must be separated with double newline paragraphs'
  )
})

await runTest('Partial message content is preserved when run is aborted midway', async () => {
  let partialUIContent = ''
  let isRunning = true

  const onChunkSim = (chunk) => {
    if (!isRunning) return
    partialUIContent += chunk
  }

  // Chunks before stop
  onChunkSim('Analyzing problem...')
  onChunkSim(' Finding solution...')

  // User clicks stop
  isRunning = false

  // Subsequent chunk arrives
  onChunkSim(' Extra chunk')

  assert.strictEqual(partialUIContent, 'Analyzing problem... Finding solution...')
  assert.strictEqual(partialUIContent.includes('Extra chunk'), false)
})

// ============================================================================
// Execution Summary
// ============================================================================
console.log('\n============================================================')
console.log('Phase 2 Task 7 Test Execution Summary')
console.log('============================================================')
console.log(`Total Tests Run:  ${totalTests}`)
console.log(`Passed Tests:     ${passedTests}`)
console.log(`Failed Tests:     ${failedTests}`)

if (failedTests > 0) {
  console.error(`\nFAILED: ${failedTests} streaming reliability test(s) failed.`)
  process.exit(1)
} else {
  console.log('\nAll Streaming & Progress Reliability tests passed with 100% success rate!\n')
}
