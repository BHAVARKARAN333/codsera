// scratch/test_agent_cancellation_fixes.mjs
// Phase 2 — Task 4: Regression Test Suite for Agent Cancellation & Lifecycle Fixes
// Tests:
// 1. User cancellation cleans up active plan: running step -> failed, pending steps -> skipped, completed -> completed
// 2. Unhandled tool exceptions clean up plan before propagating error
// 3. Cancellation vs approval rejection ordering preserved
// 4. Intended behavior of stop() before run()
// 5. Run isolation across superseded runs preventing state or history pollution

import assert from 'node:assert'
import esbuild from 'esbuild'

console.log('--- Phase 2 Task 4: Agent Cancellation & Lifecycle Fixes Regression Suite ---')

// 1. Transpile modules with esbuild
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

let stopCommandCalls = 0
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
      stopCommandCalls++
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
        await options.onExecute(args, context, executionHistory.length)
      }

      if (options.shouldThrow) {
        throw new Error(options.errorMessage || `Tool ${name} threw an unhandled error`)
      }

      if (options.shouldRequestApproval && context.requestApproval) {
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

      return {
        success: true,
        output: options.output || `Mock output from ${name}`
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
    console.log(`  [PASS] Fix Test ${totalTests}: ${name} (${dt}ms)`)
    passedTests++
  } catch (err) {
    const dt = (performance.now() - t0).toFixed(1)
    console.error(`  [FAIL] Fix Test ${totalTests}: ${name} (${dt}ms)`)
    console.error(`         Error: ${err.message}`)
    if (err.stack) {
      const relevant = err.stack.split('\n').slice(1, 4).join('\n')
      console.error(`         ${relevant}`)
    }
    failedTests++
  }
}

console.log('\n--- Running Regression Tests for Verified Task 4 Fixes ---')

// ----------------------------------------------------------------------------
// Test 1: Active step marked failed, pending steps skipped, completed preserved on cancel
// ----------------------------------------------------------------------------
await runTest('Cancellation cleans up plan: running -> failed, pending -> skipped, completed preserved', async () => {
  const orchRef = { current: null }

  // Step 1 completes normally
  const readTool = createMockTool('read_file', {
    output: '{"path":"src/app.ts","content":"code"}'
  })

  // Step 2 triggers stop while running
  const editTool = createMockTool('edit_file', {
    onExecute: () => {
      orchRef.current.stop()
    },
    output: 'edited'
  })

  const cmdTool = createMockTool('run_command', { output: '{"success":true,"exitCode":0}' })

  const provider = createMockProvider([
    { functionCalls: [{ name: 'read_file', args: { path: 'src/app.ts' } }] },
    { functionCalls: [{ name: 'edit_file', args: { path: 'src/app.ts', newContent: 'v2' } }] },
    { functionCalls: [{ name: 'run_command', args: { command: 'npm test' } }] }
  ])

  const orch = new AgentOrchestrator(provider)
  orchRef.current = orch
  orch.registerTool(readTool)
  orch.registerTool(editTool)
  orch.registerTool(cmdTool)

  let errorCaught = null
  try {
    await orch.run('Inspect src/app.ts and edit src/app.ts and run tests', {
      apiKey: 'k',
      workspaceRoot: '/mock',
      requestApproval: async () => true
    })
  } catch (err) {
    errorCaught = err
  }

  assert.ok(errorCaught)
  assert.strictEqual(errorCaught.message, 'Request was stopped by user.')

  const plan = orch.getAgentPlanner().getActivePlan()
  assert.ok(plan, 'Plan must exist')
  assert.strictEqual(plan.status, 'aborted', 'Plan status must be aborted')
  assert.strictEqual(plan.failureReason, 'Request was stopped by user.')

  // Step 1: read_file was completed before cancellation
  const step1 = plan.steps[0]
  assert.strictEqual(step1.status, 'completed', 'Step 1 completed work must be preserved')

  // Step 2: edit_file was running when cancel happened -> must be failed with cancel reason
  const step2 = plan.steps[1]
  assert.strictEqual(step2.status, 'failed', 'Step 2 running step must be marked failed')
  assert.strictEqual(step2.error, 'Request was stopped by user.')

  // Subsequent steps must be marked skipped, NOT completed
  const remainingSteps = plan.steps.slice(2)
  for (const s of remainingSteps) {
    assert.strictEqual(s.status, 'skipped', `Step ${s.id} must be marked skipped`)
  }

  // Verify formatFinalSummary reflects incomplete / aborted
  const summary = orch.getAgentPlanner().formatFinalSummary(plan)
  assert.ok(summary.includes('Status**: Incomplete / Aborted'))
  assert.ok(summary.includes('Request was stopped by user.'))
})

// ----------------------------------------------------------------------------
// Test 2: Unhandled tool exceptions trigger plan cleanup before propagating
// ----------------------------------------------------------------------------
await runTest('Unhandled tool exceptions clean up plan before error is propagated', async () => {
  const readTool = createMockTool('read_file', {
    shouldThrow: true,
    errorMessage: 'EACCES: permission denied, open /mock/src/app.ts'
  })

  const provider = createMockProvider([
    { functionCalls: [{ name: 'read_file', args: { path: 'src/app.ts' } }] }
  ])

  const orch = new AgentOrchestrator(provider)
  orch.registerTool(readTool)

  let errorCaught = null
  try {
    await orch.run('Inspect src/app.ts and edit src/app.ts and run tests', {
      apiKey: 'k',
      workspaceRoot: '/mock'
    })
  } catch (err) {
    errorCaught = err
  }

  // Error must be propagated to caller
  assert.ok(errorCaught)
  assert.ok(errorCaught.message.includes('EACCES: permission denied'))

  // Plan must be cleaned up, NOT left in executing
  const plan = orch.getAgentPlanner().getActivePlan()
  assert.ok(plan)
  assert.strictEqual(plan.status, 'aborted', 'Plan must be aborted on unhandled tool throw')
  assert.ok(plan.failureReason?.includes('EACCES: permission denied'))

  const step1 = plan.steps[0]
  assert.strictEqual(step1.status, 'failed', 'Crashing step must be marked failed')
  assert.ok(step1.error?.includes('EACCES: permission denied'))

  const step2 = plan.steps[1]
  assert.strictEqual(step2.status, 'skipped', 'Subsequent steps must be marked skipped')
})

// ----------------------------------------------------------------------------
// Test 3: Cancellation vs approval rejection ordering
// ----------------------------------------------------------------------------
await runTest('Cancellation during approval rejection preserves plan rejection reason and propagates cancel', async () => {
  const orchRef = { current: null }

  const tool = createMockTool('edit_file', {
    shouldRequestApproval: true,
    rejectionOutput: 'User rejected modifying src/app.ts'
  })

  const provider = createMockProvider([
    { functionCalls: [{ name: 'edit_file', args: { path: 'src/app.ts' } }] }
  ])

  const orch = new AgentOrchestrator(provider)
  orchRef.current = orch
  orch.registerTool(tool)

  let errorCaught = null
  try {
    await orch.run('Inspect src/app.ts and edit src/app.ts', {
      apiKey: 'k',
      workspaceRoot: '/mock',
      requestApproval: async () => {
        // Stop is clicked while approval modal is active
        orchRef.current.stop()
        return false // Rejection
      }
    })
  } catch (err) {
    errorCaught = err
  }

  // Cancellation error must be thrown
  assert.ok(errorCaught)
  assert.strictEqual(errorCaught.message, 'Request was stopped by user.')

  // Plan must be aborted with rejection reason preserved
  const plan = orch.getAgentPlanner().getActivePlan()
  assert.ok(plan)
  assert.strictEqual(plan.status, 'aborted')
  assert.ok(
    plan.failureReason?.includes('User rejected modifying src/app.ts') ||
      plan.failureReason?.includes('User rejected approval')
  )
})

// ----------------------------------------------------------------------------
// Test 4: Documented behavior of stop() before run()
// ----------------------------------------------------------------------------
await runTest('stop() before run() executes idle cleanup and run() starts fresh', async () => {
  const initialStopCalls = stopCommandCalls
  const orch = new AgentOrchestrator(createMockProvider([{ text: 'Fresh run ok' }]))

  // Stop called while idle
  orch.stop()
  assert.strictEqual(stopCommandCalls, initialStopCalls + 1, 'Invokes stopCommand for process safety')

  // Run called afterwards must start cleanly without false cancellation
  const result = await orch.run('Fresh query', { apiKey: 'k', workspaceRoot: null })
  assert.strictEqual(result, 'Fresh run ok')
})

// ----------------------------------------------------------------------------
// Test 5: Run isolation across superseded runs
// ----------------------------------------------------------------------------
await runTest('Run isolation: Old superseded run cannot corrupt newer run state or history', async () => {
  let run1Resolve
  const run1ProviderPromise = new Promise((res) => { run1Resolve = res })

  const provider = {
    sendMessage: async (history) => {
      const text = history[history.length - 1]?.parts[0]?.text
      if (text === 'Slow run 1') {
        return await run1ProviderPromise
      } else {
        return { text: 'Fast run 2 completed' }
      }
    }
  }

  const orch = new AgentOrchestrator(provider)

  // Start Slow Run 1
  let run1Error = null
  const run1Promise = orch.run('Slow run 1', { apiKey: 'k', workspaceRoot: null }).catch((err) => {
    run1Error = err
  })

  // Start Fast Run 2
  const run2Result = await orch.run('Fast run 2', { apiKey: 'k', workspaceRoot: null })
  assert.strictEqual(run2Result, 'Fast run 2 completed')

  const run2Plan = orch.getAgentPlanner().getActivePlan()

  // Now resolve Run 1 late
  run1Resolve({ functionCalls: [{ name: 'read_file', args: { path: 'src/app.ts' } }] })
  await run1Promise

  assert.ok(run1Error)
  assert.strictEqual(run1Error.message, 'Request was stopped by user.')

  // Run 1 MUST NOT have modified Run 2's plan
  if (run2Plan) {
    assert.strictEqual(run2Plan.status !== 'aborted', true, 'Run 2 plan must not be aborted by Run 1 unwinding')
  }

  // History must not have Run 1's function call injected
  const history = orch['history']
  const functionCalls = history.filter((m) => m.role === 'function')
  assert.strictEqual(functionCalls.length, 0, 'No function calls from superseded Run 1 in history')
})

console.log('\n============================================================')
console.log('Phase 2 Task 4 Regression Test Summary')
console.log('============================================================')
console.log(`Total Fix Tests:  ${totalTests}`)
console.log(`Passed Fix Tests: ${passedTests}`)
console.log(`Failed Fix Tests: ${failedTests}`)

if (failedTests > 0) {
  process.exit(1)
} else {
  console.log('All Task 4 verified fix regression tests passed!')
}
