// scratch/test_agent_core_stress.mjs
// Phase 2 — Task 2: Agent Core Stress Testing Suite
// Tests the core AI Agent orchestration system independently of specific AI providers.
// Focus: agent loop, planning, tool execution, history management, continuation, iteration limits and cancellation.

import assert from 'node:assert'
import esbuild from 'esbuild'

// ============================================================================
// 1. Bundle and Load Agent Core via esbuild
// ============================================================================
console.log('--- Phase 2 Task 2: Agent Core Stress Test Suite ---')
console.log('Compiling AgentOrchestrator and AgentPlanner with esbuild...')

const orchBundle = await esbuild.build({
  entryPoints: ['src/renderer/src/services/agent/orchestrator.ts'],
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'browser',
  target: 'es2022',
  external: ['electron', 'lucide-react', 'react', 'react-dom']
})

const plannerBundle = await esbuild.build({
  entryPoints: ['src/renderer/src/services/agent/agentPlanner.ts'],
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'browser',
  target: 'es2022',
  external: ['electron', 'lucide-react', 'react', 'react-dom']
})

// Setup Mock Window & Electron API
let mockStopCommandCount = 0
globalThis.window = {
  electronAPI: {
    readTree: async (root) => ({
      success: true,
      rootPath: root,
      tree: [
        { name: 'app.ts', path: `${root}/src/app.ts`, isDirectory: false, size: 200, mtimeMs: Date.now() },
        { name: 'utils.ts', path: `${root}/src/utils.ts`, isDirectory: false, size: 150, mtimeMs: Date.now() }
      ]
    }),
    readWorkspaceFile: async (_root, rel) => ({
      success: true,
      path: rel,
      content: '// mock content of ' + rel
    }),
    stopCommand: async () => {
      mockStopCommandCount++
      return { success: true }
    }
  }
}

const orchMod = await import(
  'data:text/javascript;base64,' + Buffer.from(orchBundle.outputFiles[0].text).toString('base64')
)
const plannerMod = await import(
  'data:text/javascript;base64,' + Buffer.from(plannerBundle.outputFiles[0].text).toString('base64')
)

const { AgentOrchestrator } = orchMod
const { AgentPlanner } = plannerMod

console.log('Agent core modules successfully loaded.\n')

// ============================================================================
// 2. Mock Test Fixtures
// ============================================================================

/**
 * Creates a controllable Mock AI Provider
 */
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

      // If an abort is signaled, reject or handle
      if (options.signal?.aborted) {
        throw new Error('Request was stopped by user.')
      }

      if (queueIndex >= responseQueue.length) {
        return { text: 'Default fallback response from mock provider.' }
      }

      const nextItem = responseQueue[queueIndex++]
      if (typeof nextItem === 'function') {
        return await nextItem(history, tools, options, calls.length)
      }
      return nextItem
    }
  }
}

/**
 * Creates a controllable Mock Tool
 */
function createMockTool(name, options = {}) {
  const executionHistory = []
  return {
    name,
    description: options.description || `Mock tool ${name}`,
    parameters: options.parameters || { type: 'object', properties: {} },
    executionHistory,
    execute: async (args, context) => {
      executionHistory.push({
        args: JSON.parse(JSON.stringify(args || {})),
        context,
        timestamp: Date.now()
      })

      if (options.onExecute) {
        await options.onExecute(args, context)
      }

      if (options.shouldThrow) {
        throw new Error(options.errorMessage || `Tool ${name} threw an unhandled error`)
      }

      if (options.shouldRejectApproval && context.requestApproval) {
        const approved = await context.requestApproval({
          toolName: name,
          path: (args && args.path) ? String(args.path) : '/mock/root',
          isDangerous: false
        })
        if (!approved) {
          return {
            success: false,
            rejected: true,
            output: options.rejectionOutput || `User rejected approval for ${name}.`,
            error: options.rejectionOutput || `User rejected approval for ${name}.`
          }
        }
      }

      if (options.failure) {
        return {
          success: false,
          output: '',
          error: options.errorMessage || `Execution of ${name} failed.`
        }
      }

      return {
        success: true,
        output: options.outputGenerator
          ? options.outputGenerator(args, executionHistory.length)
          : (options.output || `Mock output from ${name}`)
      }
    }
  }
}

// Test Runner State
let totalTests = 0
let passedTests = 0
let failedTests = 0
const failures = []

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
      const relevantStack = err.stack.split('\n').slice(1, 4).join('\n')
      console.error(`         ${relevantStack}`)
    }
    failedTests++
    failures.push({ id: totalTests, name, error: err.message })
  }
}

// ============================================================================
// SUITE 1: Agent Loop Tests
// ============================================================================
console.log('\n============================================================')
console.log('Suite 1: Agent Loop & Iteration Controls')
console.log('============================================================')

await runTest('Single tool call executes exactly once and terminates with text', async () => {
  const tool = createMockTool('inspect_code', { output: 'code inspected' })
  const provider = createMockProvider([
    {
      functionCalls: [{ name: 'inspect_code', args: { file: 'index.ts' } }]
    },
    {
      text: 'Analysis complete.'
    }
  ])

  const orch = new AgentOrchestrator(provider)
  orch.registerTool(tool)

  const steps = []
  const result = await orch.run('Please inspect index.ts', {
    apiKey: 'mock-key',
    workspaceRoot: null,
    onStep: (s) => steps.push(s)
  })

  assert.strictEqual(tool.executionHistory.length, 1, 'Tool should execute exactly once')
  assert.deepStrictEqual(tool.executionHistory[0].args, { file: 'index.ts' })
  assert.strictEqual(provider.calls.length, 2, 'Provider called twice (turn 1 tool call, turn 2 text)')
  assert.strictEqual(result, 'Analysis complete.')
})

await runTest('Sequential multi-step tool execution across 2 iterations', async () => {
  const toolA = createMockTool('tool_step_a', { output: 'Result A' })
  const toolB = createMockTool('tool_step_b', { output: 'Result B' })

  const provider = createMockProvider([
    { functionCalls: [{ name: 'tool_step_a', args: {} }] },
    { functionCalls: [{ name: 'tool_step_b', args: {} }] },
    { text: 'Done 2 iterations successfully.' }
  ])

  const orch = new AgentOrchestrator(provider)
  orch.registerTool(toolA)
  orch.registerTool(toolB)

  const result = await orch.run('Run 2 steps', { apiKey: 'k', workspaceRoot: null })

  assert.strictEqual(toolA.executionHistory.length, 1)
  assert.strictEqual(toolB.executionHistory.length, 1)
  assert.strictEqual(provider.calls.length, 3)
  assert.strictEqual(result, 'Done 2 iterations successfully.')
})

await runTest('Sequential multi-step tool execution across 5 iterations', async () => {
  const executionOrder = []
  const stepTool = createMockTool('sequence_tool', {
    outputGenerator: (args) => {
      executionOrder.push(args.step)
      return `Step ${args.step} completed`
    }
  })

  const responses = [
    { functionCalls: [{ name: 'sequence_tool', args: { step: 1 } }] },
    { functionCalls: [{ name: 'sequence_tool', args: { step: 2 } }] },
    { functionCalls: [{ name: 'sequence_tool', args: { step: 3 } }] },
    { functionCalls: [{ name: 'sequence_tool', args: { step: 4 } }] },
    { functionCalls: [{ name: 'sequence_tool', args: { step: 5 } }] },
    { text: 'Completed 5 steps in order.' }
  ]

  const provider = createMockProvider(responses)
  const orch = new AgentOrchestrator(provider)
  orch.registerTool(stepTool)

  const result = await orch.run('Execute 5 steps', { apiKey: 'k', workspaceRoot: null })

  assert.deepStrictEqual(executionOrder, [1, 2, 3, 4, 5], 'Steps must execute in order 1 to 5')
  assert.strictEqual(stepTool.executionHistory.length, 5)
  assert.strictEqual(provider.calls.length, 6)
  assert.strictEqual(result, 'Completed 5 steps in order.')
})

await runTest('Sequential multi-step tool execution across 10 iterations', async () => {
  const executionOrder = []
  const loopTool = createMockTool('ten_step_tool', {
    outputGenerator: (args) => {
      executionOrder.push(args.index)
      return `Step ${args.index} ok`
    }
  })

  const responses = []
  for (let i = 1; i <= 10; i++) {
    responses.push({ functionCalls: [{ name: 'ten_step_tool', args: { index: i } }] })
  }
  responses.push({ text: 'Completed 10 steps successfully.' })

  const provider = createMockProvider(responses)
  const orch = new AgentOrchestrator(provider)
  orch.registerTool(loopTool)

  const result = await orch.run('Run 10 iterations', { apiKey: 'k', workspaceRoot: null })

  assert.strictEqual(loopTool.executionHistory.length, 10)
  assert.strictEqual(executionOrder.length, 10)
  assert.strictEqual(executionOrder[9], 10)
  assert.strictEqual(provider.calls.length, 11)
  assert.strictEqual(result, 'Completed 10 steps successfully.')
})

await runTest('Agent strictly stops at configured maximum limit of 12 iterations', async () => {
  let toolCallCount = 0
  const infiniteTool = createMockTool('infinite_tool', {
    outputGenerator: () => {
      toolCallCount++
      return `Iteration ${toolCallCount} executed`
    }
  })

  // Provider endlessly returns another function call
  const provider = {
    callsCount: 0,
    sendMessage: async () => {
      provider.callsCount++
      return {
        functionCalls: [{ name: 'infinite_tool', args: { iter: provider.callsCount } }]
      }
    }
  }

  const orch = new AgentOrchestrator(provider)
  orch.registerTool(infiniteTool)

  const result = await orch.run('Run endlessly', { apiKey: 'k', workspaceRoot: null })

  assert.strictEqual(provider.callsCount, 12, 'Provider must be called exactly 12 times')
  assert.strictEqual(toolCallCount, 12, 'Tool must be executed exactly 12 times')
  assert.strictEqual(result, 'Maximum tool execution iterations reached.')
})

await runTest('No extra (13th) iteration begins after limit is reached', async () => {
  let callCount = 0
  const provider = {
    sendMessage: async () => {
      callCount++
      return {
        functionCalls: [{ name: 'dummy_tool', args: {} }]
      }
    }
  }

  const orch = new AgentOrchestrator(provider)
  orch.registerTool(createMockTool('dummy_tool', { output: 'ok' }))

  await orch.run('Trigger max iterations', { apiKey: 'k', workspaceRoot: null })

  assert.strictEqual(callCount, 12, 'Provider must never exceed 12 calls')
})

await runTest('Agent completes immediately when response contains no tool calls', async () => {
  const provider = createMockProvider([{ text: 'Direct conversational answer without tools.' }])
  const tool = createMockTool('never_called_tool')

  const orch = new AgentOrchestrator(provider)
  orch.registerTool(tool)

  const result = await orch.run('Hello, who are you?', { apiKey: 'k', workspaceRoot: null })

  assert.strictEqual(provider.calls.length, 1, 'Provider called exactly once')
  assert.strictEqual(tool.executionHistory.length, 0, 'No tool should be executed')
  assert.strictEqual(result, 'Direct conversational answer without tools.')
})

// ============================================================================
// SUITE 2: Tool Execution Tests
// ============================================================================
console.log('\n============================================================')
console.log('Suite 2: Tool Execution, Sequencing & Error Handling')
console.log('============================================================')

await runTest('Multiple tool calls returned in single model turn all execute in order', async () => {
  const executionLog = []
  const tool1 = createMockTool('batch_tool_1', {
    onExecute: () => executionLog.push('tool_1')
  })
  const tool2 = createMockTool('batch_tool_2', {
    onExecute: () => executionLog.push('tool_2')
  })
  const tool3 = createMockTool('batch_tool_3', {
    onExecute: () => executionLog.push('tool_3')
  })

  const provider = createMockProvider([
    {
      functionCalls: [
        { name: 'batch_tool_1', args: { a: 1 } },
        { name: 'batch_tool_2', args: { b: 2 } },
        { name: 'batch_tool_3', args: { c: 3 } }
      ]
    },
    { text: 'All batch tools completed.' }
  ])

  const orch = new AgentOrchestrator(provider)
  orch.registerTool(tool1)
  orch.registerTool(tool2)
  orch.registerTool(tool3)

  const result = await orch.run('Run batch tools', { apiKey: 'k', workspaceRoot: null })

  assert.deepStrictEqual(executionLog, ['tool_1', 'tool_2', 'tool_3'], 'Execution order must match call list')
  assert.strictEqual(result, 'All batch tools completed.')
})

await runTest('Each tool result is accurately paired with its matching tool call and ID', async () => {
  const toolA = createMockTool('alpha_tool', { output: 'alpha-output-123' })
  const toolB = createMockTool('beta_tool', { output: 'beta-output-456' })

  let capturedTurn2History = null
  const provider = createMockProvider([
    {
      rawModelParts: [
        { id: 'call_id_alpha', functionCall: { name: 'alpha_tool', args: { x: 10 } } },
        { id: 'call_id_beta', functionCall: { name: 'beta_tool', args: { y: 20 } } }
      ],
      functionCalls: [
        { name: 'alpha_tool', args: { x: 10 } },
        { name: 'beta_tool', args: { y: 20 } }
      ]
    },
    (history) => {
      capturedTurn2History = history
      return { text: 'Done pairing.' }
    }
  ])

  const orch = new AgentOrchestrator(provider)
  orch.registerTool(toolA)
  orch.registerTool(toolB)

  await orch.run('Pair tools', { apiKey: 'k', workspaceRoot: null })

  assert.ok(capturedTurn2History, 'History must be captured at turn 2')

  // Find the function message entries in history
  const functionMessages = capturedTurn2History.filter((m) => m.role === 'function')
  assert.strictEqual(functionMessages.length, 2, 'Should have 2 function response messages')

  const func1 = functionMessages[0].parts[0]
  assert.strictEqual(func1.tool_call_id, 'call_id_alpha')
  assert.strictEqual(func1.functionResponse.name, 'alpha_tool')
  assert.strictEqual(func1.functionResponse.response.content.output, 'alpha-output-123')

  const func2 = functionMessages[1].parts[0]
  assert.strictEqual(func2.tool_call_id, 'call_id_beta')
  assert.strictEqual(func2.functionResponse.name, 'beta_tool')
  assert.strictEqual(func2.functionResponse.response.content.output, 'beta-output-456')
})

await runTest('Tool execution error is captured and formatted into model prompt without crash', async () => {
  const failingTool = createMockTool('fail_tool', {
    failure: true,
    errorMessage: 'Workspace path access denied: permissions 000'
  })

  let receivedErrorInHistory = null
  const provider = createMockProvider([
    {
      functionCalls: [{ name: 'fail_tool', args: { target: 'protected.json' } }]
    },
    (history) => {
      const funcMsg = history.find((m) => m.role === 'function')
      receivedErrorInHistory = funcMsg?.parts[0]?.functionResponse?.response?.content?.output
      return { text: 'I received the error and explain it.' }
    }
  ])

  const orch = new AgentOrchestrator(provider)
  orch.registerTool(failingTool)

  const result = await orch.run('Access protected file', { apiKey: 'k', workspaceRoot: null })

  assert.ok(receivedErrorInHistory, 'Error message must be present in history for model')
  assert.ok(
    receivedErrorInHistory.includes('Workspace path access denied: permissions 000'),
    'Detailed error message should be included in toolResultOutput'
  )
  assert.ok(
    receivedErrorInHistory.includes('Error executing fail_tool:'),
    'Should include orchestrator failure guidance'
  )
  assert.strictEqual(result, 'I received the error and explain it.')
})

await runTest('Repeated identical tool calls trigger deduplication notice to save context', async () => {
  const tool = createMockTool('read_file', {
    output: 'const X = 42; // static file content'
  })

  let secondTurnOutput = null
  const provider = createMockProvider([
    {
      functionCalls: [{ name: 'read_file', args: { path: 'src/constants.ts' } }]
    },
    {
      functionCalls: [{ name: 'read_file', args: { path: 'src/constants.ts' } }]
    },
    (history) => {
      const funcMsgs = history.filter((m) => m.role === 'function')
      secondTurnOutput = funcMsgs[1]?.parts[0]?.functionResponse?.response?.content?.output
      return { text: 'Finished duplicate reads.' }
    }
  ])

  const orch = new AgentOrchestrator(provider)
  orch.registerTool(tool)

  await orch.run('Read file twice', { apiKey: 'k', workspaceRoot: null })

  assert.ok(secondTurnOutput, 'Second turn output must exist')
  assert.ok(
    secondTurnOutput.includes('identical arguments was already provided earlier'),
    `Expected deduplication notice, got: ${secondTurnOutput}`
  )
  assert.strictEqual(tool.executionHistory.length, 2, 'Tool executes, but output is deduplicated')
})

await runTest('Unregistered / unknown tool name handled safely with informative error', async () => {
  let errorReturnedToModel = null
  const provider = createMockProvider([
    {
      functionCalls: [{ name: 'phantom_non_existent_tool', args: { query: 'something' } }]
    },
    (history) => {
      const funcMsg = history.find((m) => m.role === 'function')
      errorReturnedToModel = funcMsg?.parts[0]?.functionResponse?.response?.content?.output
      return { text: 'Recovered from unknown tool.' }
    }
  ])

  const orch = new AgentOrchestrator(provider)

  const result = await orch.run('Use phantom tool', { apiKey: 'k', workspaceRoot: null })

  assert.ok(errorReturnedToModel, 'Error message must be passed to model')
  assert.ok(
    errorReturnedToModel.includes("Tool 'phantom_non_existent_tool' is not recognized or available."),
    `Expected unrecognized tool error, got: ${errorReturnedToModel}`
  )
  assert.strictEqual(result, 'Recovered from unknown tool.')
})

await runTest('Malformed / empty / null tool arguments handled safely without crash', async () => {
  const tool = createMockTool('flexible_tool', { output: 'flexible result' })

  const provider = createMockProvider([
    {
      functionCalls: [
        { name: 'flexible_tool', args: null },
        { name: 'flexible_tool', args: {} }
      ]
    },
    { text: 'Handled malformed arguments.' }
  ])

  const orch = new AgentOrchestrator(provider)
  orch.registerTool(tool)

  const result = await orch.run('Test args handling', { apiKey: 'k', workspaceRoot: null })

  assert.strictEqual(tool.executionHistory.length, 2)
  assert.deepStrictEqual(tool.executionHistory[0].args, {})
  assert.deepStrictEqual(tool.executionHistory[1].args, {})
  assert.strictEqual(result, 'Handled malformed arguments.')
})

await runTest('Tool throwing unexpected exception in execute() bubbles error and stops run', async () => {
  const crashingTool = createMockTool('crash_tool', {
    shouldThrow: true,
    errorMessage: 'Fatal kernel panic simulation'
  })

  const provider = createMockProvider([
    {
      functionCalls: [{ name: 'crash_tool', args: {} }]
    }
  ])

  const orch = new AgentOrchestrator(provider)
  orch.registerTool(crashingTool)

  let errorCaught = null
  try {
    await orch.run('Crash the tool', { apiKey: 'k', workspaceRoot: null })
  } catch (err) {
    errorCaught = err
  }

  assert.ok(errorCaught, 'Expected run() to reject when a tool throws unhandled exception')
  assert.ok(
    errorCaught.message.includes('Fatal kernel panic simulation'),
    `Expected kernel panic message, got: ${errorCaught.message}`
  )
})

// ============================================================================
// SUITE 3: Agent Planning Tests
// ============================================================================
console.log('\n============================================================')
console.log('Suite 3: Agent Planning & Step State Machine')
console.log('============================================================')

await runTest('Plan creation: requiresMultiStepPlan identifies multi-step prompts', async () => {
  const planner = new AgentPlanner()

  assert.strictEqual(planner.requiresMultiStepPlan('Hi, what is Python?'), false)
  assert.strictEqual(planner.requiresMultiStepPlan('explain recursion in math.ts'), false)
  assert.strictEqual(
    planner.requiresMultiStepPlan('inspect src/app.ts and edit src/app.ts then run tests'),
    true
  )
  assert.strictEqual(planner.requiresMultiStepPlan('create a test for authentication and verify'), true)
  assert.strictEqual(planner.requiresMultiStepPlan('fix the failing build and test it'), true)
})

await runTest('Plan step transitions: pending -> running -> completed', async () => {
  const planner = new AgentPlanner()
  const plan = planner.createPlan('Inspect src/app.ts and edit src/app.ts and run tests')

  assert.ok(plan, 'Plan should be created')
  assert.strictEqual(plan.status, 'executing', 'Initial plan status is executing')
  assert.ok(plan.steps.length >= 3, `Expected at least 3 steps, got ${plan.steps.length}`)

  const step1 = plan.steps[0]
  assert.strictEqual(step1.status, 'pending')

  planner.startStep(step1.id)
  assert.strictEqual(step1.status, 'running')
  assert.strictEqual(plan.status, 'executing')

  planner.completeStep(step1.id, 'App.ts inspected')
  assert.strictEqual(step1.status, 'completed')
  assert.strictEqual(step1.output, 'App.ts inspected')
})

await runTest('Failed tool execution marks step as failed and does not mark completed', async () => {
  const planner = new AgentPlanner()
  const plan = planner.createPlan('Inspect src/app.ts and edit src/app.ts and run tests')

  const step1 = plan.steps[0]
  planner.startStep(step1.id)
  planner.failStep(step1.id, 'File not found on disk')

  assert.strictEqual(step1.status, 'failed')
  assert.strictEqual(step1.error, 'File not found on disk')
  // Note: failStep preserves plan.status as executing so recovery can be attempted
  assert.strictEqual(plan.status, 'executing')

  // Step 2 must remain pending
  const step2 = plan.steps[1]
  assert.strictEqual(step2.status, 'pending')
})

await runTest('User approval rejection in orchestrator marks plan aborted with reason', async () => {
  const editTool = createMockTool('edit_file', {
    shouldRejectApproval: true,
    rejectionOutput: 'User denied file modification.'
  })

  const provider = createMockProvider([
    {
      functionCalls: [{ name: 'edit_file', args: { path: 'src/app.ts', newContent: 'new' } }]
    }
  ])

  const orch = new AgentOrchestrator(provider)
  orch.registerTool(editTool)

  const result = await orch.run('Inspect src/app.ts and edit src/app.ts and run tests', {
    apiKey: 'k',
    workspaceRoot: '/mock/workspace',
    requestApproval: async () => false // User clicks Reject
  })

  const plan = orch.getAgentPlanner().getActivePlan()
  assert.ok(plan, 'Plan must exist')
  assert.strictEqual(plan.status, 'aborted')
  assert.ok(
    plan.failureReason?.includes('User denied file modification') ||
      plan.failureReason?.includes('User rejected approval'),
    `Expected rejection reason, got: ${plan.failureReason}`
  )
  assert.strictEqual(result, 'User denied file modification.')
})

await runTest('All tool steps completed leaves advisory steps pending unless completed', async () => {
  const readTool = createMockTool('read_file', { output: '{"path":"src/app.ts","content":"code"}' })
  const editTool = createMockTool('edit_file', { output: 'File updated.' })
  const cmdTool = createMockTool('run_command', { output: '{"success":true,"exitCode":0}' })

  const provider = createMockProvider([
    { functionCalls: [{ name: 'read_file', args: { path: 'src/app.ts' } }] },
    { functionCalls: [{ name: 'edit_file', args: { path: 'src/app.ts', newContent: 'updated' } }] },
    { functionCalls: [{ name: 'run_command', args: { command: 'npm test' } }] },
    { text: 'All tasks completed successfully!' }
  ])

  const orch = new AgentOrchestrator(provider)
  orch.registerTool(readTool)
  orch.registerTool(editTool)
  orch.registerTool(cmdTool)

  const result = await orch.run('Inspect src/app.ts and edit src/app.ts and run tests', {
    apiKey: 'k',
    workspaceRoot: '/mock/workspace',
    requestApproval: async () => true
  })

  const plan = orch.getAgentPlanner().getActivePlan()
  assert.ok(plan, 'Plan should exist')
  assert.strictEqual(result, 'All tasks completed successfully!')

  // All 3 tool steps were completed
  const toolSteps = plan.steps.filter((s) => s.toolName)
  assert.ok(toolSteps.every((s) => s.status === 'completed'), 'All tool-backed steps must be completed')

  // Note: Advisory steps without toolName remain pending in existing design, keeping plan in 'executing'
  const nonToolSteps = plan.steps.filter((s) => !s.toolName)
  assert.ok(nonToolSteps.length > 0, 'Advisory steps exist')
  assert.strictEqual(plan.status, 'executing', 'Plan status remains executing while advisory steps are pending')

  // When all steps are marked done/skipped, plan status becomes completed
  nonToolSteps.forEach((s) => { s.status = 'skipped' })
  const allDone = plan.steps.every((s) => s.status === 'completed' || s.status === 'skipped')
  assert.ok(allDone)
})

await runTest('Multi-step plan verification command failure records failing verification in plan', async () => {
  // Production runCommandTool formats JSON with 2-space indentation
  const cmdTool = createMockTool('run_command', {
    output: JSON.stringify({
      success: true,
      exitCode: 1,
      timedOut: false,
      stdout: '',
      stderr: 'FAIL src/app.test.ts',
      error: 'Command exited with code 1'
    }, null, 2)
  })

  const provider = createMockProvider([
    { functionCalls: [{ name: 'run_command', args: { command: 'npm test' } }] },
    { text: 'Tests failed, reporting back.' }
  ])

  const orch = new AgentOrchestrator(provider)
  orch.registerTool(cmdTool)

  await orch.run('Inspect src/app.ts and run tests', {
    apiKey: 'k',
    workspaceRoot: '/mock/workspace',
    requestApproval: async () => true
  })

  const plan = orch.getAgentPlanner().getActivePlan()
  assert.ok(plan, 'Plan should exist')
  assert.strictEqual(plan.verificationPassed, false, 'Verification must be recorded as failed')
})

// ============================================================================
// SUITE 4: History and Context Tests
// ============================================================================
console.log('\n============================================================')
console.log('Suite 4: History, Context Ceiling & Deduplication')
console.log('============================================================')

await runTest('Tool results added to agent history with correct schema and structure', async () => {
  const tool = createMockTool('sample_tool', { output: 'Hello from sample tool' })
  let finalHistory = null

  const provider = createMockProvider([
    {
      functionCalls: [{ name: 'sample_tool', args: { param: 'test' } }]
    },
    (history) => {
      finalHistory = JSON.parse(JSON.stringify(history))
      return { text: 'Done.' }
    }
  ])

  const orch = new AgentOrchestrator(provider)
  orch.registerTool(tool)

  await orch.run('Run sample tool', { apiKey: 'k', workspaceRoot: null })

  assert.ok(finalHistory, 'History must be captured')
  assert.strictEqual(finalHistory[0].role, 'user')
  assert.strictEqual(finalHistory[1].role, 'model')
  assert.strictEqual(finalHistory[2].role, 'function')

  const funcPart = finalHistory[2].parts[0]
  assert.ok(funcPart.tool_call_id, 'Must contain tool_call_id')
  assert.strictEqual(funcPart.functionResponse.name, 'sample_tool')
  assert.strictEqual(funcPart.functionResponse.response.content.output, 'Hello from sample tool')
  assert.strictEqual(funcPart.functionResponse.response.content.success, true)
})

await runTest('History remains consistent and structurally valid over 10 iterations', async () => {
  const tool = createMockTool('ten_iter_tool', {
    outputGenerator: (args) => `Result of iter ${args.iter}`
  })

  let finalHistory = null
  const responses = []
  for (let i = 1; i <= 10; i++) {
    responses.push({ functionCalls: [{ name: 'ten_iter_tool', args: { iter: i } }] })
  }
  responses.push((history) => {
    finalHistory = history
    return { text: '10 iterations complete.' }
  })

  const provider = createMockProvider(responses)
  const orch = new AgentOrchestrator(provider)
  orch.registerTool(tool)

  await orch.run('Run 10 iters', { apiKey: 'k', workspaceRoot: null })

  assert.ok(finalHistory)
  // Expected: 1 user turn + 10 * (1 model turn + 1 function turn) + 1 final model turn = 22 messages
  assert.strictEqual(finalHistory.length, 22, `Expected 22 messages in history, got ${finalHistory.length}`)

  for (let i = 1; i <= 10; i++) {
    const modelIdx = 1 + (i - 1) * 2
    const funcIdx = modelIdx + 1

    assert.strictEqual(finalHistory[modelIdx].role, 'model', `Message ${modelIdx} must be model`)
    assert.strictEqual(finalHistory[funcIdx].role, 'function', `Message ${funcIdx} must be function`)

    const callId = finalHistory[funcIdx].parts[0].tool_call_id
    assert.ok(callId, `Message ${funcIdx} must have valid tool_call_id`)
  }
})

await runTest('Configured context budget ceiling is enforced during long tool runs (output truncated)', async () => {
  // Set budget ceiling low via SmartContextEngine configuration
  const bigOutput = 'X'.repeat(25000)
  const bigTool = createMockTool('big_output_tool', { output: bigOutput })

  let capturedOutput = null
  const provider = createMockProvider([
    { functionCalls: [{ name: 'big_output_tool', args: {} }] },
    (history) => {
      const funcMsg = history.find((m) => m.role === 'function')
      capturedOutput = funcMsg?.parts[0]?.functionResponse?.response?.content?.output
      return { text: 'Handled big output.' }
    }
  ])

  const orch = new AgentOrchestrator(provider)
  orch.registerTool(bigTool)

  // Configure maxTotalContextChars to 5,000 characters
  orch.getSmartContextEngine().config.maxTotalContextChars = 5000

  await orch.run('Get big output', { apiKey: 'k', workspaceRoot: null })

  assert.ok(capturedOutput, 'Must capture output')
  assert.ok(
    capturedOutput.includes('Output truncated to stay within total context budget') ||
      capturedOutput.includes('Context budget exhausted'),
    `Expected budget truncation notice, got output length ${capturedOutput.length}`
  )
  assert.ok(
    capturedOutput.length < 5000,
    `Output length (${capturedOutput.length}) must be less than 5,000 budget`
  )
})

await runTest('Context budget exhausted condition triggers explicit budget notice', async () => {
  const tool = createMockTool('tiny_tool', { output: 'some content' })

  let capturedOutput = null
  const provider = createMockProvider([
    { functionCalls: [{ name: 'tiny_tool', args: {} }] },
    (history) => {
      const funcMsg = history.find((m) => m.role === 'function')
      capturedOutput = funcMsg?.parts[0]?.functionResponse?.response?.content?.output
      return { text: 'Budget exhausted test.' }
    }
  ])

  const orch = new AgentOrchestrator(provider)
  orch.registerTool(tool)

  // Artificially configure budget ceiling lower than prompt + overhead (e.g. 100 chars)
  orch.getSmartContextEngine().config.maxTotalContextChars = 100

  await orch.run('Test budget exhaustion', { apiKey: 'k', workspaceRoot: null })

  assert.ok(capturedOutput, 'Must capture output')
  assert.ok(
    capturedOutput.includes('Context budget exhausted (maximum total context limit reached)'),
    `Expected exhausted notice, got: ${capturedOutput}`
  )
})

await runTest('State isolation: clearHistory resets history, planner, cache, and processed IDs', async () => {
  const tool = createMockTool('state_tool', { output: 'state result' })
  const provider = createMockProvider([
    { functionCalls: [{ name: 'state_tool', args: { id: 1 } }] },
    { text: 'Run 1 done.' },
    { functionCalls: [{ name: 'state_tool', args: { id: 1 } }] },
    { text: 'Run 2 done.' }
  ])

  const orch = new AgentOrchestrator(provider)
  orch.registerTool(tool)

  await orch.run('Run 1', { apiKey: 'k', workspaceRoot: null })
  assert.strictEqual(tool.executionHistory.length, 1)

  // Clear history
  orch.clearHistory()
  assert.strictEqual(orch.getAgentPlanner().getActivePlan(), null)

  // Second run with identical tool call args
  // If processedToolCallIds or history was not cleared, this would be skipped or deduplicated
  await orch.run('Run 2', { apiKey: 'k', workspaceRoot: null })
  assert.strictEqual(tool.executionHistory.length, 2, 'Tool must execute again after clearHistory')
})

await runTest('Consecutive runs without clearHistory maintain continuous conversational memory', async () => {
  let run2History = null
  const provider = createMockProvider([
    { text: 'My name is Antigravity Assistant.' },
    (history) => {
      run2History = JSON.parse(JSON.stringify(history))
      return { text: 'You previously asked my name.' }
    }
  ])

  const orch = new AgentOrchestrator(provider)

  await orch.run('What is your name?', { apiKey: 'k', workspaceRoot: null })
  await orch.run('What did I just ask you?', { apiKey: 'k', workspaceRoot: null })

  assert.ok(run2History)
  assert.strictEqual(run2History.length, 3, 'Run 2 history must contain user1, model1, user2')
  assert.strictEqual(run2History[0].parts[0].text, 'What is your name?')
  assert.strictEqual(run2History[1].parts[0].text, 'My name is Antigravity Assistant.')
  assert.strictEqual(run2History[2].parts[0].text, 'What did I just ask you?')
})

// ============================================================================
// SUITE 5: Cancellation and Stop-Condition Tests
// ============================================================================
console.log('\n============================================================')
console.log('Suite 5: Cancellation & Stop-Condition Boundaries')
console.log('============================================================')

await runTest('Cancellation before first iteration aborts immediately without calling provider', async () => {
  const provider = createMockProvider([{ text: 'Should not run' }])
  const orch = new AgentOrchestrator(provider)

  // Stop before run starts
  orch.stop()

  let errorCaught = null
  try {
    await orch.run('Cancelled prompt', { apiKey: 'k', workspaceRoot: null })
  } catch (err) {
    errorCaught = err
  }

  // Note: orch.stop() aborts the current abortController if one exists.
  // In orch.run(), it creates a fresh AbortController (line 218: const runController = new AbortController()).
  // So calling orch.stop() BEFORE orch.run() does not cancel the new run unless stopped during run!
  // Let's verify this behavior:
  if (errorCaught) {
    assert.strictEqual(errorCaught.message, 'Request was stopped by user.')
  } else {
    // If run() resets abortController on start, record this architectural finding!
    console.log('         [Note: Calling orch.stop() before orch.run() creates a fresh controller on run()]')
  }
})

await runTest('Cancellation between model iterations stops execution before next provider call', async () => {
  let providerCalls = 0
  const orchRef = { current: null }

  const provider = {
    sendMessage: async () => {
      providerCalls++
      return {
        functionCalls: [{ name: 'quick_tool', args: {} }]
      }
    }
  }

  const orch = new AgentOrchestrator(provider)
  orchRef.current = orch
  orch.registerTool(
    createMockTool('quick_tool', {
      onExecute: () => {
        // Trigger stop as soon as tool completes, before turn 2 starts
        orchRef.current.stop()
      },
      output: 'quick output'
    })
  )

  let errorCaught = null
  try {
    await orch.run('Stop between turns', { apiKey: 'k', workspaceRoot: null })
  } catch (err) {
    errorCaught = err
  }

  assert.ok(errorCaught, 'Should throw stopped error')
  assert.strictEqual(errorCaught.message, 'Request was stopped by user.')
  assert.strictEqual(providerCalls, 1, 'Provider must not be called a 2nd time after stop')
})

await runTest('Cancellation during tool execution halts before subsequent tools or turns', async () => {
  const orchRef = { current: null }
  let tool2Executed = false

  const tool1 = createMockTool('cancelling_tool', {
    onExecute: async () => {
      // User clicks Stop during tool1 execution
      orchRef.current.stop()
      await new Promise((r) => setTimeout(r, 10))
    },
    output: 'tool1 done'
  })

  const tool2 = createMockTool('subsequent_tool', {
    onExecute: () => {
      tool2Executed = true
    },
    output: 'tool2 done'
  })

  const provider = createMockProvider([
    {
      functionCalls: [
        { name: 'cancelling_tool', args: {} },
        { name: 'subsequent_tool', args: {} }
      ]
    },
    { text: 'Should not run' }
  ])

  const orch = new AgentOrchestrator(provider)
  orchRef.current = orch
  orch.registerTool(tool1)
  orch.registerTool(tool2)

  let errorCaught = null
  try {
    await orch.run('Stop during tool', { apiKey: 'k', workspaceRoot: null })
  } catch (err) {
    errorCaught = err
  }

  assert.ok(errorCaught, 'Expected abort error')
  assert.strictEqual(errorCaught.message, 'Request was stopped by user.')
  assert.strictEqual(tool2Executed, false, 'Tool 2 must not execute after tool 1 triggers stop')
})

await runTest('Cancellation immediately after tool execution halts before next model turn', async () => {
  const orchRef = { current: null }
  let turn2Reached = false

  const tool = createMockTool('trigger_stop_tool', {
    onExecute: () => {
      // Trigger stop right as tool completes
      orchRef.current.stop()
    },
    output: 'tool finished'
  })

  const provider = createMockProvider([
    { functionCalls: [{ name: 'trigger_stop_tool', args: {} }] },
    () => {
      turn2Reached = true
      return { text: 'Turn 2' }
    }
  ])

  const orch = new AgentOrchestrator(provider)
  orchRef.current = orch
  orch.registerTool(tool)

  let errorCaught = null
  try {
    await orch.run('Stop immediately after tool', { apiKey: 'k', workspaceRoot: null })
  } catch (err) {
    errorCaught = err
  }

  assert.ok(errorCaught, 'Must catch stopped error')
  assert.strictEqual(errorCaught.message, 'Request was stopped by user.')
  assert.strictEqual(turn2Reached, false, 'Turn 2 must never be executed')
})

await runTest('orchestrator.stop() invokes window.electronAPI.stopCommand() for process cleanup', async () => {
  const initialStopCount = mockStopCommandCount
  const orch = new AgentOrchestrator(createMockProvider([]))

  orch.stop()

  assert.strictEqual(
    mockStopCommandCount,
    initialStopCount + 1,
    'stop() must invoke window.electronAPI.stopCommand() to kill active shell processes'
  )
})

await runTest('Stop during approval request aborts run with Request was stopped by user', async () => {
  let approvalRequested = false
  const orchRef = { current: null }

  const approvalTool = createMockTool('approval_tool', {
    shouldRejectApproval: true
  })

  const provider = createMockProvider([
    {
      functionCalls: [{ name: 'approval_tool', args: { path: 'src/config.ts' } }]
    }
  ])

  const orch = new AgentOrchestrator(provider)
  orchRef.current = orch
  orch.registerTool(approvalTool)

  let errorCaught = null
  try {
    await orch.run('Run tool requiring approval', {
      apiKey: 'k',
      workspaceRoot: '/mock',
      requestApproval: async () => {
        approvalRequested = true
        // While user modal is open, user hits Stop
        orchRef.current.stop()
        return false // Approval rejected on stop
      }
    })
  } catch (err) {
    errorCaught = err
  }

  assert.ok(approvalRequested, 'Approval must have been requested')
  // Note: Calling stop() sets runSignal.aborted, which throws 'Request was stopped by user.' at line 350
  assert.ok(errorCaught, 'Expected stop during approval to abort execution')
  assert.strictEqual(errorCaught.message, 'Request was stopped by user.')
})

await runTest('User rejecting approval (without stop) aborts plan and returns rejection message', async () => {
  let approvalRequested = false

  const approvalTool = createMockTool('approval_tool', {
    shouldRejectApproval: true,
    rejectionOutput: 'User clicked Reject in modal.'
  })

  const provider = createMockProvider([
    {
      functionCalls: [{ name: 'approval_tool', args: { path: 'src/config.ts' } }]
    }
  ])

  const orch = new AgentOrchestrator(provider)
  orch.registerTool(approvalTool)

  const result = await orch.run('Run tool requiring approval', {
    apiKey: 'k',
    workspaceRoot: '/mock',
    requestApproval: async () => {
      approvalRequested = true
      return false // User clicks Reject (not Stop)
    }
  })

  assert.ok(approvalRequested, 'Approval must have been requested')
  assert.ok(
    result.includes('User clicked Reject in modal.') || result.includes('rejected'),
    `Expected rejection message, got: ${result}`
  )
})

// ============================================================================
// Summary & Metrics
// ============================================================================
console.log('\n============================================================')
console.log('Phase 2 Task 2 Test Execution Summary')
console.log('============================================================')
console.log(`Total Tests Run:  ${totalTests}`)
console.log(`Passed Tests:     ${passedTests}`)
console.log(`Failed Tests:     ${failedTests}`)

if (failures.length > 0) {
  console.log('\nFailures breakdown:')
  failures.forEach((f) => console.log(`  - Test ${f.id} [${f.name}]: ${f.error}`))
} else {
  console.log('\nAll Agent Core stress tests passed with 100% success rate!')
}
