// scratch/test_agent_context_history.mjs
// Phase 2 — Task 6: Agent Context Budget & History Reliability Test Suite
//
// Tests:
// Suite 1: History Growth, Multi-Turn Continuity & Message Structure
// Suite 2: Tool Call & Result Pairing Integrity
// Suite 3: Context Budget Ceiling & Large Input Truncation
// Suite 4: Multi-Round History Pruning & Boundary Preservation
// Suite 5: Recent Context Protection (Pruning Preserves Latest Turn)
// Suite 6: History Reset & Clean State Isolation
// Suite 7: Failure & Cancellation Recovery (Orphaned Call Prevention)

import assert from 'node:assert'
import esbuild from 'esbuild'

console.log('--- Phase 2 Task 6: Agent Context Budget & History Reliability ---')

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

// Mock Provider helper
function createMockProvider(responseQueue = []) {
  const calls = []
  let queueIndex = 0

  return {
    calls,
    setResponses: (newResponses) => {
      responseQueue.length = 0
      responseQueue.push(...newResponses)
      queueIndex = 0
    },
    sendMessage: async (history, tools, options) => {
      calls.push({
        historySnapshot: JSON.parse(JSON.stringify(history)),
        toolsSnapshot: tools ? JSON.parse(JSON.stringify(tools)) : [],
        options
      })

      if (options.signal?.aborted) {
        throw new Error('Request was stopped by user.')
      }

      if (queueIndex >= responseQueue.length) {
        return { text: 'Done.' }
      }

      const nextItem = responseQueue[queueIndex++]
      if (typeof nextItem === 'function') {
        return await nextItem(history, tools, options, calls.length)
      }
      return nextItem
    }
  }
}

function createMockTool(name, options = {}) {
  const executionHistory = []
  return {
    name,
    description: options.description || `Mock tool ${name}`,
    parameters: options.parameters || { type: 'object', properties: {} },
    requiresApproval: options.requiresApproval ?? false,
    executionHistory,
    execute: async (args, context) => {
      executionHistory.push({ args, context, timestamp: Date.now() })
      if (options.onExecute) await options.onExecute(args, context, executionHistory.length)
      if (options.shouldThrow) throw new Error(options.errorMessage || `Tool ${name} threw error`)
      if (options.requiresApproval && context.requestApproval) {
        const approved = await context.requestApproval({ toolName: name, path: '/mock' })
        if (!approved) return { success: false, rejected: true, output: 'Rejected', error: 'Rejected' }
      }
      return { success: true, output: options.output || `Output from ${name}` }
    }
  }
}

// Helper to validate complete message pairing & structure according to LLM specifications
function validateHistoryIntegrity(history) {
  assert.ok(Array.isArray(history), 'History must be an array')
  if (history.length === 0) return

  // 1. History must start with user turn
  assert.strictEqual(history[0].role, 'user', 'Conversation history must always begin with a user turn')

  // 2. No consecutive user messages without a model or function in between
  for (let i = 0; i < history.length - 1; i++) {
    const current = history[i]
    const next = history[i + 1]
    if (current.role === 'user') {
      assert.notStrictEqual(next.role, 'user', `Consecutive user turns found at index ${i} and ${i + 1}`)
    }
  }

  // 3. Every model turn with functionCalls must have all tool_call_ids answered by subsequent function turns
  for (let i = 0; i < history.length; i++) {
    const msg = history[i]
    if (msg.role === 'model') {
      const toolCallIds = []
      for (const part of msg.parts) {
        if (part.functionCall) {
          const raw = part
          const id = raw.id || raw.tool_call_id || part.functionCall.name
          toolCallIds.push(id)
        }
      }

      if (toolCallIds.length > 0) {
        // Collect following function responses up to next model turn
        const answeredIds = []
        let j = i + 1
        while (j < history.length && history[j].role === 'function') {
          for (const part of history[j].parts) {
            const raw = part
            const id = raw.tool_call_id || part.functionResponse?.name
            if (id) answeredIds.push(id)
          }
          j++
        }

        for (const expectedId of toolCallIds) {
          assert.ok(
            answeredIds.includes(expectedId),
            `Tool call ID '${expectedId}' in model message at index ${i} lacks matching function response`
          )
        }
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
// SUITE 1: History Growth, Multi-Turn Continuity & Message Structure
// ============================================================================
console.log('\n============================================================')
console.log('Suite 1: History Growth, Multi-Turn Continuity & Message Structure')
console.log('============================================================')

await runTest('getHistory() returns an immutable snapshot of internal conversation history', async () => {
  const provider = createMockProvider([{ text: 'Response 1' }])
  const orch = new AgentOrchestrator(provider)

  await orch.run('First prompt', { apiKey: 'k', workspaceRoot: '/mock' })
  const snapshot1 = orch.getHistory()
  assert.strictEqual(snapshot1.length, 2)
  assert.strictEqual(snapshot1[0].role, 'user')
  assert.strictEqual(snapshot1[1].role, 'model')

  // Modifying snapshot does not affect internal history
  snapshot1.push({ role: 'user', parts: [{ text: 'tampered' }] })
  assert.strictEqual(orch.getHistory().length, 2, 'Internal history must not be mutated by snapshot edit')
})

await runTest('History grows continuously across 5 conversational turns with proper alternating roles', async () => {
  const provider = createMockProvider([
    { text: 'Answer 1' },
    { text: 'Answer 2' },
    { text: 'Answer 3' },
    { text: 'Answer 4' },
    { text: 'Answer 5' }
  ])
  const orch = new AgentOrchestrator(provider)

  for (let i = 1; i <= 5; i++) {
    const res = await orch.run(`Prompt ${i}`, { apiKey: 'k', workspaceRoot: '/mock' })
    assert.strictEqual(res, `Answer ${i}`)
  }

  const history = orch.getHistory()
  assert.strictEqual(history.length, 10, '5 turns should yield exactly 10 alternating messages')
  validateHistoryIntegrity(history)
})

// ============================================================================
// SUITE 2: Tool Call & Result Pairing Integrity
// ============================================================================
console.log('\n============================================================')
console.log('Suite 2: Tool Call & Result Pairing Integrity')
console.log('============================================================')

await runTest('Sequential multi-step tool calls are strictly paired with tool_call_id', async () => {
  const readTool = createMockTool('read_file', { output: 'code content' })
  const provider = createMockProvider([
    { functionCalls: [{ name: 'read_file', args: { path: 'a.ts' } }] },
    { functionCalls: [{ name: 'read_file', args: { path: 'b.ts' } }] },
    { text: 'Read both files.' }
  ])

  const orch = new AgentOrchestrator(provider)
  orch.registerTool(readTool)

  await orch.run('Read a.ts and b.ts', { apiKey: 'k', workspaceRoot: '/mock' })
  const history = orch.getHistory()

  validateHistoryIntegrity(history)
  // Verify structure: user -> model (call a) -> function (res a) -> model (call b) -> function (res b) -> model (final)
  assert.strictEqual(history.length, 6)
  assert.strictEqual(history[0].role, 'user')
  assert.strictEqual(history[1].role, 'model')
  assert.strictEqual(history[2].role, 'function')
  assert.strictEqual(history[3].role, 'model')
  assert.strictEqual(history[4].role, 'function')
  assert.strictEqual(history[5].role, 'model')

  // Verify tool_call_id pairing
  const call1Id = history[1].parts[0].id || history[1].parts[0].tool_call_id
  const resp1Id = history[2].parts[0].tool_call_id
  assert.strictEqual(call1Id, resp1Id, 'First tool call and response must share identical ID')

  const call2Id = history[3].parts[0].id || history[3].parts[0].tool_call_id
  const resp2Id = history[4].parts[0].tool_call_id
  assert.strictEqual(call2Id, resp2Id, 'Second tool call and response must share identical ID')
})

await runTest('Multiple simultaneous tool calls in one model turn each get paired function responses', async () => {
  const toolA = createMockTool('tool_a', { output: 'result a' })
  const toolB = createMockTool('tool_b', { output: 'result b' })

  const provider = createMockProvider([
    {
      functionCalls: [
        { name: 'tool_a', args: { x: 1 } },
        { name: 'tool_b', args: { y: 2 } }
      ]
    },
    { text: 'Completed both.' }
  ])

  const orch = new AgentOrchestrator(provider)
  orch.registerTool(toolA)
  orch.registerTool(toolB)

  await orch.run('Run tool a and tool b', { apiKey: 'k', workspaceRoot: '/mock' })
  const history = orch.getHistory()

  validateHistoryIntegrity(history)
  // History: user -> model (2 calls) -> function (res a) -> function (res b) -> model (done)
  assert.strictEqual(history.length, 5)
  assert.strictEqual(history[1].parts.length, 2, 'Model message must contain 2 tool calls')
  assert.strictEqual(history[2].role, 'function')
  assert.strictEqual(history[3].role, 'function')
})

// ============================================================================
// SUITE 3: Context Budget Ceiling & Large Input Truncation
// ============================================================================
console.log('\n============================================================')
console.log('Suite 3: Context Budget Ceiling & Large Input Truncation')
console.log('============================================================')

await runTest('Single massive user prompt exceeding budget is capped cleanly with truncation notice', async () => {
  // SmartContext maxTotalContextChars default is 30,000 chars.
  // Submit a 50,000 char prompt:
  const massivePrompt = 'A'.repeat(50000)
  const provider = createMockProvider([{ text: 'Acknowledged.' }])
  const orch = new AgentOrchestrator(provider)

  await orch.run(massivePrompt, { apiKey: 'k', workspaceRoot: '/mock' })
  const history = orch.getHistory()

  assert.strictEqual(history[0].role, 'user')
  const userText = history[0].parts[0].text
  assert.ok(userText.length < 35000, `User prompt must be capped under budget ceiling, got ${userText.length}`)
  assert.ok(userText.includes('[... User prompt truncated to fit context budget ...]'))
  validateHistoryIntegrity(history)
})

await runTest('Exceedingly large tool output is truncated to fit remaining context budget', async () => {
  const bigOutput = 'X'.repeat(35000)
  const tool = createMockTool('big_tool', { output: bigOutput })

  const provider = createMockProvider([
    { functionCalls: [{ name: 'big_tool', args: {} }] },
    { text: 'Handled big output.' }
  ])

  const orch = new AgentOrchestrator(provider)
  orch.registerTool(tool)

  await orch.run('Call big tool', { apiKey: 'k', workspaceRoot: '/mock' })
  const history = orch.getHistory()

  validateHistoryIntegrity(history)
  const fnMsg = history.find((m) => m.role === 'function')
  assert.ok(fnMsg, 'Function message must exist')
  const savedOutput = fnMsg.parts[0].functionResponse.response.content.output
  assert.ok(savedOutput.length < 30000, `Tool output must be truncated, got ${savedOutput.length}`)
  assert.ok(savedOutput.includes('[... Output truncated to stay within total context budget ...]'))
})

// ============================================================================
// SUITE 4: Multi-Round History Pruning & Boundary Preservation
// ============================================================================
console.log('\n============================================================')
console.log('Suite 4: Multi-Round History Pruning & Boundary Preservation')
console.log('============================================================')

await runTest('When cumulative history exceeds maxBudget, oldest completed rounds are pruned from the front', async () => {
  // Create an orchestrator with a SmartContextEngine configured for a smaller budget of 5000 chars
  const engine = new SmartContextEngine({ maxTotalContextChars: 5000 })
  const tool = createMockTool('info_tool', { output: 'Some content '.repeat(150) }) // ~2000 chars per call

  const provider = createMockProvider([
    // Round 1
    { functionCalls: [{ name: 'info_tool', args: { r: 1 } }] },
    { text: 'Answer for round 1' },
    // Round 2
    { functionCalls: [{ name: 'info_tool', args: { r: 2 } }] },
    { text: 'Answer for round 2' },
    // Round 3
    { functionCalls: [{ name: 'info_tool', args: { r: 3 } }] },
    { text: 'Answer for round 3' },
    // Round 4
    { functionCalls: [{ name: 'info_tool', args: { r: 4 } }] },
    { text: 'Answer for round 4' }
  ])

  const orch = new AgentOrchestrator(provider)
  orch.smartContextEngine = engine
  orch.registerTool(tool)

  await orch.run('Prompt for round 1', { apiKey: 'k', workspaceRoot: '/mock' })
  await orch.run('Prompt for round 2', { apiKey: 'k', workspaceRoot: '/mock' })
  await orch.run('Prompt for round 3', { apiKey: 'k', workspaceRoot: '/mock' })
  await orch.run('Prompt for round 4', { apiKey: 'k', workspaceRoot: '/mock' })

  const history = orch.getHistory()
  validateHistoryIntegrity(history)

  // Verify that history still starts with a user message
  assert.strictEqual(history[0].role, 'user')
  // Verify that oldest prompt (Round 1) was pruned away to stay under 5000 budget
  const allUserTexts = history.filter((m) => m.role === 'user').map((m) => m.parts[0].text)
  assert.ok(!allUserTexts.includes('Prompt for round 1'), 'Oldest round 1 must have been pruned')
  // Verify that latest round (Round 4) is present
  assert.ok(allUserTexts.includes('Prompt for round 4'), 'Latest round 4 must be retained')
})

await runTest('History pruning preserves intact function call and response blocks', async () => {
  const engine = new SmartContextEngine({ maxTotalContextChars: 6000 })
  const tool = createMockTool('chunk_tool', { output: 'Chunk of data '.repeat(60) })

  const provider = createMockProvider([
    // Round 1 (multi-step)
    { functionCalls: [{ name: 'chunk_tool', args: { step: 1 } }] },
    { functionCalls: [{ name: 'chunk_tool', args: { step: 2 } }] },
    { text: 'Finished Round 1' },
    // Round 2
    { functionCalls: [{ name: 'chunk_tool', args: { step: 3 } }] },
    { text: 'Finished Round 2' },
    // Round 3
    { text: 'Finished Round 3' }
  ])

  const orch = new AgentOrchestrator(provider)
  orch.smartContextEngine = engine
  orch.registerTool(tool)

  await orch.run('Round 1 multi-step', { apiKey: 'k', workspaceRoot: '/mock' })
  await orch.run('Round 2 multi-step', { apiKey: 'k', workspaceRoot: '/mock' })
  await orch.run('Round 3 direct', { apiKey: 'k', workspaceRoot: '/mock' })

  const history = orch.getHistory()
  validateHistoryIntegrity(history)
})

// ============================================================================
// SUITE 5: Recent Context Protection (Pruning Preserves Latest Turn)
// ============================================================================
console.log('\n============================================================')
console.log('Suite 5: Recent Context Protection (Pruning Preserves Latest Turn)')
console.log('============================================================')

await runTest('Active/latest user prompt and its tool outputs are never pruned away', async () => {
  const engine = new SmartContextEngine({ maxTotalContextChars: 4000 })
  const tool = createMockTool('work_tool', { output: 'Work output '.repeat(50) })

  const provider = createMockProvider([
    // Round 1
    { functionCalls: [{ name: 'work_tool', args: { id: 1 } }] },
    { text: 'Done round 1' },
    // Round 2: Latest critical instruction
    { functionCalls: [{ name: 'work_tool', args: { id: 2 } }] },
    { text: 'Completed critical latest task' }
  ])

  const orch = new AgentOrchestrator(provider)
  orch.smartContextEngine = engine
  orch.registerTool(tool)

  await orch.run('Ancient instruction round 1', { apiKey: 'k', workspaceRoot: '/mock' })
  await orch.run('CRITICAL LATEST INSTRUCTION', { apiKey: 'k', workspaceRoot: '/mock' })

  const history = orch.getHistory()
  validateHistoryIntegrity(history)

  const userMessages = history.filter((m) => m.role === 'user').map((m) => m.parts[0].text)
  assert.ok(userMessages.includes('CRITICAL LATEST INSTRUCTION'), 'Latest instruction must be kept')

  const lastModelMsg = history[history.length - 1]
  assert.strictEqual(lastModelMsg.role, 'model')
  assert.strictEqual(lastModelMsg.parts[0].text, 'Completed critical latest task')
})

// ============================================================================
// SUITE 6: History Reset & Clean State Isolation
// ============================================================================
console.log('\n============================================================')
console.log('Suite 6: History Reset & Clean State Isolation')
console.log('============================================================')

await runTest('clearHistory() empties history and prevents leakage into subsequent runs', async () => {
  const provider = createMockProvider([
    { text: 'First run secret response' },
    { text: 'Second clean run response' }
  ])
  const orch = new AgentOrchestrator(provider)

  await orch.run('Confidential prompt 1', { apiKey: 'k', workspaceRoot: '/mock' })
  assert.strictEqual(orch.getHistory().length, 2)

  // Clear history
  orch.clearHistory()
  assert.strictEqual(orch.getHistory().length, 0, 'History must be empty after clearHistory()')

  // Run second independent session
  await orch.run('Independent prompt 2', { apiKey: 'k', workspaceRoot: '/mock' })
  const history = orch.getHistory()

  assert.strictEqual(history.length, 2)
  assert.strictEqual(history[0].parts[0].text, 'Independent prompt 2')
  assert.strictEqual(history[1].parts[0].text, 'Second clean run response')

  // Verify provider was sent only prompt 2 on second call
  const secondCallHistory = provider.calls[1].historySnapshot
  assert.strictEqual(secondCallHistory.length, 1)
  assert.strictEqual(secondCallHistory[0].parts[0].text, 'Independent prompt 2')
})

// ============================================================================
// SUITE 7: Failure & Cancellation Recovery (Orphaned Call Prevention)
// ============================================================================
console.log('\n============================================================')
console.log('Suite 7: Failure & Cancellation Recovery (Orphaned Call Prevention)')
console.log('============================================================')

await runTest('Cancellation at Turn 1 closes history with model stop notice, preserving alternating turns', async () => {
  const orchRef = { current: null }
  const provider = {
    calls: [],
    sendMessage: async (history, tools, options) => {
      // Abort while provider is waiting
      orchRef.current.stop()
      throw new Error('Request was stopped by user.')
    }
  }

  const orch = new AgentOrchestrator(provider)
  orchRef.current = orch

  try {
    await orch.run('Aborted prompt', { apiKey: 'k', workspaceRoot: '/mock' })
  } catch (err) {
    assert.strictEqual(err.message, 'Request was stopped by user.')
  }

  const history = orch.getHistory()
  validateHistoryIntegrity(history)

  // Must have: user -> model ('Request was stopped by user.')
  assert.strictEqual(history.length, 2)
  assert.strictEqual(history[0].role, 'user')
  assert.strictEqual(history[1].role, 'model')
  assert.ok(history[1].parts[0].text.includes('stopped by user'))
})

await runTest('Cancellation during tool execution pairs missing tool calls and closes turn cleanly', async () => {
  const orchRef = { current: null }
  let tool1Ran = false
  let tool2Ran = false

  const tool1 = createMockTool('tool_1', {
    onExecute: () => {
      tool1Ran = true
      // User aborts after tool 1 executes
      orchRef.current.stop()
    },
    output: 'tool 1 result'
  })

  const tool2 = createMockTool('tool_2', {
    onExecute: () => {
      tool2Ran = true
    },
    output: 'tool 2 result'
  })

  // Model returns 2 tool calls in the same turn
  const provider = createMockProvider([
    {
      functionCalls: [
        { name: 'tool_1', args: {} },
        { name: 'tool_2', args: {} }
      ]
    }
  ])

  const orch = new AgentOrchestrator(provider)
  orchRef.current = orch
  orch.registerTool(tool1)
  orch.registerTool(tool2)

  try {
    await orch.run('Run both tools with stop', { apiKey: 'k', workspaceRoot: '/mock' })
  } catch (err) {
    assert.strictEqual(err.message, 'Request was stopped by user.')
  }

  assert.strictEqual(tool1Ran, true, 'Tool 1 ran')
  assert.strictEqual(tool2Ran, false, 'Tool 2 must not run after stop')

  const history = orch.getHistory()
  // Entire history must be completely valid!
  validateHistoryIntegrity(history)

  // Verify that tool_2 got a synthetic cancelled function response
  const fnMessages = history.filter((m) => m.role === 'function')
  assert.strictEqual(fnMessages.length, 2, 'Both tool_1 and tool_2 must have function responses')

  const tool2FnMsg = fnMessages[1]
  assert.strictEqual(tool2FnMsg.parts[0].functionResponse.response.content.status, 'cancelled')
  assert.ok(tool2FnMsg.parts[0].functionResponse.response.content.output.includes('stopped by user'))

  // Verify history ends with model message
  assert.strictEqual(history[history.length - 1].role, 'model')
})

await runTest('Subsequent run succeeds seamlessly after a cancelled run without provider 400 error', async () => {
  const orchRef = { current: null }
  const tool = createMockTool('fragile_tool', {
    onExecute: () => {
      orchRef.current.stop()
    }
  })

  const provider = createMockProvider([
    // Run 1: will be cancelled
    { functionCalls: [{ name: 'fragile_tool', args: {} }] },
    // Run 2: normal completion
    { text: 'Second run completed flawlessly.' }
  ])

  const orch = new AgentOrchestrator(provider)
  orchRef.current = orch
  orch.registerTool(tool)

  try {
    await orch.run('Run 1 to cancel', { apiKey: 'k', workspaceRoot: '/mock' })
  } catch {}

  // Run 2: immediately follows Run 1
  const res2 = await orch.run('Run 2 after cancellation', { apiKey: 'k', workspaceRoot: '/mock' })
  assert.strictEqual(res2, 'Second run completed flawlessly.')

  const history = orch.getHistory()
  validateHistoryIntegrity(history)

  // Verify provider was sent a completely valid history on Run 2
  const run2History = provider.calls[1].historySnapshot
  validateHistoryIntegrity(run2History)
})

await runTest('Unhandled tool exception pairs missing tool calls and closes turn cleanly', async () => {
  const crashingTool = createMockTool('crashing_tool', {
    shouldThrow: true,
    errorMessage: 'Disk I/O error on block 42'
  })

  const provider = createMockProvider([
    { functionCalls: [{ name: 'crashing_tool', args: {} }] },
    { text: 'Recovered.' }
  ])

  const orch = new AgentOrchestrator(provider)
  orch.registerTool(crashingTool)

  try {
    await orch.run('Run crashing tool', { apiKey: 'k', workspaceRoot: '/mock' })
  } catch (err) {
    assert.ok(err.message.includes('Disk I/O error'))
  }

  const history = orch.getHistory()
  validateHistoryIntegrity(history)

  // Next run works cleanly
  const res = await orch.run('Subsequent prompt after crash', { apiKey: 'k', workspaceRoot: '/mock' })
  assert.strictEqual(res, 'Recovered.')
  validateHistoryIntegrity(orch.getHistory())
})

console.log('\n============================================================')
console.log('Phase 2 Task 6 Test Execution Summary')
console.log('============================================================')
console.log(`Total Tests Run:  ${totalTests}`)
console.log(`Passed Tests:     ${passedTests}`)
console.log(`Failed Tests:     ${failedTests}`)

if (failedTests === 0) {
  console.log('\nAll Context Budget & History Reliability tests passed with 100% success rate!')
} else {
  console.error(`\n${failedTests} test(s) failed. Review errors above.`)
  process.exit(1)
}
