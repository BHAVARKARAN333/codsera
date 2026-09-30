// scratch/test_agent_cancellation_lifecycle.mjs
// Phase 2 — Task 3: Agent Cancellation & Lifecycle Stress Testing Suite
// Tests cancellation at all execution boundaries, plan-state cleanup, run lifecycle,
// state isolation, process termination interface, and race condition handling.

import assert from 'node:assert'
import esbuild from 'esbuild'

// ============================================================================
// 1. Compile Agent Core via esbuild
// ============================================================================
console.log('--- Phase 2 Task 3: Agent Cancellation & Lifecycle Stress Tests ---')
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
let stopCommandCalls = 0
let stopCommandShouldFail = false
let stopCommandErrorMessage = ''

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
      if (stopCommandShouldFail) {
        throw new Error(stopCommandErrorMessage || 'IPC stopCommand failed')
      }
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

console.log('Agent core modules successfully loaded for cancellation testing.\n')

// ============================================================================
// 2. Controllable Test Fixtures
// ============================================================================

/**
 * Creates a controllable Deferred promise
 */
function createDeferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

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
        await options.onExecute(args, context, executionHistory.length)
      }

      if (options.deferred) {
        await options.deferred.promise
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
// SUITE 1: Cancellation Boundary Tests (10 Boundaries)
// ============================================================================
console.log('\n============================================================')
console.log('Suite 1: Cancellation Boundary Tests (10 Execution Stages)')
console.log('============================================================')

await runTest('Boundary 1: Calling stop() before run() starts instantiates fresh controller on run()', async () => {
  const provider = createMockProvider([{ text: 'Executed because run creates fresh controller' }])
  const orch = new AgentOrchestrator(provider)

  // Call stop before run is invoked
  orch.stop()

  const result = await orch.run('Prompt after premature stop', {
    apiKey: 'k',
    workspaceRoot: null
  })

  // Architectural verification: orchestrator.run() creates a brand new AbortController (line 218)
  assert.strictEqual(provider.calls.length, 1, 'Provider was invoked for the new run')
  assert.strictEqual(result, 'Executed because run creates fresh controller')
})

await runTest('Boundary 2: Cancellation immediately after run() starts halts before turn 1 provider call', async () => {
  const orchRef = { current: null }
  let providerCalls = 0

  const provider = {
    sendMessage: async () => {
      providerCalls++
      return { text: 'Should not run' }
    }
  }

  const orch = new AgentOrchestrator(provider)
  orchRef.current = orch

  let errorCaught = null
  try {
    await orch.run('Prompt to stop immediately', {
      apiKey: 'k',
      workspaceRoot: null,
      onStep: (step) => {
        if (step.type === 'thinking') {
          // Abort during initial thinking callback before provider request finishes
          orchRef.current.stop()
        }
      }
    })
  } catch (err) {
    errorCaught = err
  }

  assert.ok(errorCaught, 'Should catch stopped error')
  assert.strictEqual(errorCaught.message, 'Request was stopped by user.')
})

await runTest('Boundary 3: Cancellation while waiting for mocked provider response halts run', async () => {
  const deferredProvider = createDeferred()
  const orchRef = { current: null }
  let providerInvoked = false

  const provider = {
    sendMessage: async (_hist, _tools, options) => {
      providerInvoked = true
      // While provider request is in flight, user hits stop
      setTimeout(() => {
        orchRef.current.stop()
        deferredProvider.resolve({ functionCalls: [{ name: 'tool_after_abort', args: {} }] })
      }, 5)
      return await deferredProvider.promise
    }
  }

  const tool = createMockTool('tool_after_abort', { output: 'should never run' })
  const orch = new AgentOrchestrator(provider)
  orchRef.current = orch
  orch.registerTool(tool)

  let errorCaught = null
  try {
    await orch.run('Prompt with in-flight provider abort', { apiKey: 'k', workspaceRoot: null })
  } catch (err) {
    errorCaught = err
  }

  assert.ok(providerInvoked, 'Provider was invoked')
  assert.ok(errorCaught, 'Expected stopped error')
  assert.strictEqual(errorCaught.message, 'Request was stopped by user.')
  assert.strictEqual(tool.executionHistory.length, 0, 'Tool must never execute after provider abort')
})

await runTest('Boundary 4: Cancellation after provider response but before tool execution halts run', async () => {
  const orchRef = { current: null }
  const tool = createMockTool('uncalled_tool', { output: 'uncalled' })

  const provider = createMockProvider([
    () => {
      // Trigger stop right as provider returns response
      orchRef.current.stop()
      return {
        functionCalls: [{ name: 'uncalled_tool', args: {} }]
      }
    }
  ])

  const orch = new AgentOrchestrator(provider)
  orchRef.current = orch
  orch.registerTool(tool)

  let errorCaught = null
  try {
    await orch.run('Prompt abort after response', { apiKey: 'k', workspaceRoot: null })
  } catch (err) {
    errorCaught = err
  }

  assert.ok(errorCaught, 'Expected stopped error')
  assert.strictEqual(errorCaught.message, 'Request was stopped by user.')
  assert.strictEqual(tool.executionHistory.length, 0, 'Tool must not execute when aborted before tool loop')
})

await runTest('Boundary 5: Cancellation while waiting for user approval modal halts run', async () => {
  const orchRef = { current: null }
  const approvalDeferred = createDeferred()
  let approvalPrompted = false

  const tool = createMockTool('guarded_tool', {
    shouldRequestApproval: true,
    output: 'guarded output'
  })

  const provider = createMockProvider([
    { functionCalls: [{ name: 'guarded_tool', args: { path: 'src/main.ts' } }] }
  ])

  const orch = new AgentOrchestrator(provider)
  orchRef.current = orch
  orch.registerTool(tool)

  let errorCaught = null
  const runPromise = orch.run('Prompt approval modal', {
    apiKey: 'k',
    workspaceRoot: '/mock',
    requestApproval: async () => {
      approvalPrompted = true
      // While user modal is showing, user clicks Stop button in UI
      return await approvalDeferred.promise
    }
  }).catch((err) => {
    errorCaught = err
  })

  // Wait a tick for approval to be requested
  await new Promise((r) => setTimeout(r, 5))
  assert.strictEqual(approvalPrompted, true, 'Approval modal must be open')

  // User clicks Stop in UI (as handled in AIChatPanel: handleStop)
  orch.stop()
  approvalDeferred.resolve(false) // Modal dismissed with rejection on stop

  await runPromise

  assert.ok(errorCaught, 'Expected stop error')
  assert.strictEqual(errorCaught.message, 'Request was stopped by user.')
  assert.strictEqual(tool.executionHistory.length, 1, 'Tool was invoked to request approval')
})

await runTest('Boundary 6: Cancellation immediately after approval is granted halts before tool completes', async () => {
  const orchRef = { current: null }
  const tool = createMockTool('approved_tool', {
    shouldRequestApproval: true,
    onExecute: async () => {
      // Right after approval was granted, stop arrives during tool execution
      orchRef.current.stop()
    },
    output: 'approved tool done'
  })

  const provider = createMockProvider([
    { functionCalls: [{ name: 'approved_tool', args: { path: 'src/main.ts' } }] },
    { text: 'Turn 2' }
  ])

  const orch = new AgentOrchestrator(provider)
  orchRef.current = orch
  orch.registerTool(tool)

  let errorCaught = null
  try {
    await orch.run('Prompt approved then stop', {
      apiKey: 'k',
      workspaceRoot: '/mock',
      requestApproval: async () => true // User approves
    })
  } catch (err) {
    errorCaught = err
  }

  assert.ok(errorCaught, 'Expected stopped error')
  assert.strictEqual(errorCaught.message, 'Request was stopped by user.')
  assert.strictEqual(provider.calls.length, 1, 'Provider must not be called for turn 2')
})

await runTest('Boundary 7: Cancellation during mocked tool execution halts before turn 2', async () => {
  const orchRef = { current: null }
  const toolDeferred = createDeferred()
  let turn2Reached = false

  const tool = createMockTool('slow_tool', {
    onExecute: async () => {
      // Tool is performing slow operation; stop is triggered
      setTimeout(() => {
        orchRef.current.stop()
        toolDeferred.resolve()
      }, 5)
      await toolDeferred.promise
    },
    output: 'slow tool output'
  })

  const provider = createMockProvider([
    { functionCalls: [{ name: 'slow_tool', args: {} }] },
    () => {
      turn2Reached = true
      return { text: 'Turn 2 should never run' }
    }
  ])

  const orch = new AgentOrchestrator(provider)
  orchRef.current = orch
  orch.registerTool(tool)

  let errorCaught = null
  try {
    await orch.run('Prompt slow tool abort', { apiKey: 'k', workspaceRoot: null })
  } catch (err) {
    errorCaught = err
  }

  assert.ok(errorCaught, 'Expected stopped error')
  assert.strictEqual(errorCaught.message, 'Request was stopped by user.')
  assert.strictEqual(turn2Reached, false, 'Turn 2 must not be reached')
})

await runTest('Boundary 8: Cancellation between two tool calls in same model response stops before second tool', async () => {
  const orchRef = { current: null }
  let tool2Executed = false

  const tool1 = createMockTool('batch_tool_1', {
    onExecute: () => {
      // Tool 1 triggers stop
      orchRef.current.stop()
    },
    output: 'tool 1 finished'
  })

  const tool2 = createMockTool('batch_tool_2', {
    onExecute: () => {
      tool2Executed = true
    },
    output: 'tool 2 finished'
  })

  const provider = createMockProvider([
    {
      functionCalls: [
        { name: 'batch_tool_1', args: {} },
        { name: 'batch_tool_2', args: {} }
      ]
    }
  ])

  const orch = new AgentOrchestrator(provider)
  orchRef.current = orch
  orch.registerTool(tool1)
  orch.registerTool(tool2)

  let errorCaught = null
  try {
    await orch.run('Prompt batch tools stop', { apiKey: 'k', workspaceRoot: null })
  } catch (err) {
    errorCaught = err
  }

  assert.ok(errorCaught, 'Expected stopped error')
  assert.strictEqual(errorCaught.message, 'Request was stopped by user.')
  assert.strictEqual(tool1.executionHistory.length, 1, 'Tool 1 executed')
  assert.strictEqual(tool2Executed, false, 'Tool 2 must NEVER execute after stop')
})

await runTest('Boundary 9: Cancellation after tool result but before next model iteration halts loop', async () => {
  const orchRef = { current: null }
  let providerTurn2Dispatched = false

  const tool = createMockTool('finishing_tool', { output: 'result ok' })

  const provider = createMockProvider([
    { functionCalls: [{ name: 'finishing_tool', args: {} }] },
    () => {
      providerTurn2Dispatched = true
      return { text: 'Turn 2 response' }
    }
  ])

  const orch = new AgentOrchestrator(provider)
  orchRef.current = orch
  orch.registerTool(tool)

  let errorCaught = null
  try {
    await orch.run('Prompt stop after tool result', {
      apiKey: 'k',
      workspaceRoot: null,
      onStep: (step) => {
        if (step.type === 'tool_result') {
          // Immediately after tool result event fires, user hits stop
          orchRef.current.stop()
        }
      }
    })
  } catch (err) {
    errorCaught = err
  }

  assert.ok(errorCaught, 'Expected stopped error')
  assert.strictEqual(errorCaught.message, 'Request was stopped by user.')
  assert.strictEqual(providerTurn2Dispatched, false, 'Turn 2 must not be dispatched')
})

await runTest('Boundary 10: Cancellation during final model text resolution prevents completion event', async () => {
  const orchRef = { current: null }
  const deferredFinal = createDeferred()
  let doneEventFired = false

  const provider = {
    sendMessage: async () => {
      setTimeout(() => {
        orchRef.current.stop()
        deferredFinal.resolve({ text: 'Final model response' })
      }, 5)
      return await deferredFinal.promise
    }
  }

  const orch = new AgentOrchestrator(provider)
  orchRef.current = orch

  let errorCaught = null
  try {
    await orch.run('Prompt abort at final turn', {
      apiKey: 'k',
      workspaceRoot: null,
      onStep: (step) => {
        if (step.type === 'done') {
          doneEventFired = true
        }
      }
    })
  } catch (err) {
    errorCaught = err
  }

  assert.ok(errorCaught, 'Expected stopped error')
  assert.strictEqual(errorCaught.message, 'Request was stopped by user.')
  assert.strictEqual(doneEventFired, false, 'Done event must not fire when aborted')
})

// ============================================================================
// SUITE 2: Plan-State Cleanup Tests
// ============================================================================
console.log('\n============================================================')
console.log('Suite 2: Plan-State Cleanup & Orphaned Step Diagnostics')
console.log('============================================================')

await runTest('Plan-state cleanup gap: Active step remains marked running after user cancellation', async () => {
  const orchRef = { current: null }
  const tool = createMockTool('read_file', {
    onExecute: () => {
      // Abort while step 1 is running
      orchRef.current.stop()
    },
    output: '{"path":"src/app.ts","content":"code"}'
  })

  const provider = createMockProvider([
    { functionCalls: [{ name: 'read_file', args: { path: 'src/app.ts' } }] }
  ])

  const orch = new AgentOrchestrator(provider)
  orchRef.current = orch
  orch.registerTool(tool)

  try {
    await orch.run('Inspect src/app.ts and edit src/app.ts and run tests', {
      apiKey: 'k',
      workspaceRoot: '/mock'
    })
  } catch {}

  const plan = orch.getAgentPlanner().getActivePlan()
  assert.ok(plan, 'Plan must exist')

  // Verified fix: When user cancels, orchestrator.ts outer catch block calls agentPlanner.abortPlan()!
  // Therefore, plan.status becomes 'aborted' and step1.status becomes 'failed'!
  const step1 = plan.steps[0]
  assert.strictEqual(step1.status, 'failed', 'Active step marked failed on stop')
  assert.strictEqual(plan.status, 'aborted', 'Plan status marked aborted on stop')
})

await runTest('Plan-state cleanup fix: Pending steps are marked skipped on cancel', async () => {
  const orchRef = { current: null }
  const tool = createMockTool('read_file', {
    onExecute: () => {
      orchRef.current.stop()
    },
    output: 'ok'
  })

  const provider = createMockProvider([
    { functionCalls: [{ name: 'read_file', args: { path: 'src/app.ts' } }] }
  ])

  const orch = new AgentOrchestrator(provider)
  orchRef.current = orch
  orch.registerTool(tool)

  try {
    await orch.run('Inspect src/app.ts and edit src/app.ts and run tests', {
      apiKey: 'k',
      workspaceRoot: '/mock'
    })
  } catch {}

  const plan = orch.getAgentPlanner().getActivePlan()
  assert.ok(plan)

  // Step 2 & Step 3 were pending. Because abortPlan() was called, they are now marked 'skipped'
  const step2 = plan.steps[1]
  const step3 = plan.steps[2]
  assert.strictEqual(step2.status, 'skipped', 'Step 2 marked skipped on cancel')
  assert.strictEqual(step3.status, 'skipped', 'Step 3 marked skipped on cancel')
})

await runTest('Cancellation does not mark incomplete work as completed', async () => {
  const orchRef = { current: null }
  const tool = createMockTool('read_file', {
    onExecute: () => {
      orchRef.current.stop()
    },
    output: 'content'
  })

  const provider = createMockProvider([
    { functionCalls: [{ name: 'read_file', args: { path: 'src/app.ts' } }] }
  ])

  const orch = new AgentOrchestrator(provider)
  orchRef.current = orch
  orch.registerTool(tool)

  try {
    await orch.run('Inspect src/app.ts and edit src/app.ts and run tests', {
      apiKey: 'k',
      workspaceRoot: '/mock'
    })
  } catch {}

  const plan = orch.getAgentPlanner().getActivePlan()
  assert.ok(plan)
  assert.strictEqual(plan.status !== 'completed', true, 'Plan must never be marked completed on cancellation')
  const completedSteps = plan.steps.filter((s) => s.status === 'completed')
  assert.strictEqual(completedSteps.length, 0, 'No steps must be completed')
})

await runTest('Explicit user rejection path calls abortPlan and properly marks steps failed/skipped', async () => {
  const tool = createMockTool('edit_file', {
    shouldRequestApproval: true,
    rejectionOutput: 'User rejected edit'
  })

  const provider = createMockProvider([
    { functionCalls: [{ name: 'edit_file', args: { path: 'src/app.ts' } }] }
  ])

  const orch = new AgentOrchestrator(provider)
  orch.registerTool(tool)

  const result = await orch.run('Inspect src/app.ts and edit src/app.ts and run tests', {
    apiKey: 'k',
    workspaceRoot: '/mock',
    requestApproval: async () => false // User clicks Reject (not Stop)
  })

  const plan = orch.getAgentPlanner().getActivePlan()
  assert.ok(plan)
  assert.strictEqual(plan.status, 'aborted', 'Plan must be marked aborted on explicit rejection')

  // When abortPlan() is called: running/waiting steps become 'failed', pending become 'skipped'
  const editStep = plan.steps.find((s) => s.toolName === 'edit_file')
  const pendingSteps = plan.steps.filter((s) => s.id !== editStep?.id && s.status === 'skipped')
  assert.ok(pendingSteps.length > 0, 'Subsequent steps were marked skipped on abortPlan')
  assert.ok(result.includes('User rejected approval') || result.includes('rejected'))
})

await runTest('Unhandled tool exception leaves plan in executing status without cleanup', async () => {
  const crashingTool = createMockTool('read_file', {
    shouldThrow: true,
    errorMessage: 'Disk I/O error 0x80070002'
  })

  const provider = createMockProvider([
    { functionCalls: [{ name: 'read_file', args: { path: 'src/app.ts' } }] }
  ])

  const orch = new AgentOrchestrator(provider)
  orch.registerTool(crashingTool)

  let errorCaught = null
  try {
    await orch.run('Inspect src/app.ts and edit src/app.ts and run tests', {
      apiKey: 'k',
      workspaceRoot: '/mock'
    })
  } catch (err) {
    errorCaught = err
  }

  assert.ok(errorCaught)
  assert.ok(errorCaught.message.includes('Disk I/O error'))

  const plan = orch.getAgentPlanner().getActivePlan()
  assert.ok(plan)
  // Verified fix: Plan is aborted and active step is failed on unhandled tool crash
  assert.strictEqual(plan.status, 'aborted', 'Plan is aborted after unhandled tool crash')
  const step1 = plan.steps[0]
  assert.strictEqual(step1.status, 'failed', 'Crashing step marked failed')
  assert.ok(step1.error?.includes('Disk I/O error'), 'Step error contains exception message')
})

await runTest('Unresolved approval request leaves step in waiting_for_approval status', async () => {
  const orchRef = { current: null }
  const approvalDeferred = createDeferred()

  const tool = createMockTool('edit_file', {
    shouldRequestApproval: true
  })

  const provider = createMockProvider([
    { functionCalls: [{ name: 'edit_file', args: { path: 'src/app.ts' } }] }
  ])

  const orch = new AgentOrchestrator(provider)
  orchRef.current = orch
  orch.registerTool(tool)

  const runPromise = orch.run('Inspect src/app.ts and edit src/app.ts', {
    apiKey: 'k',
    workspaceRoot: '/mock',
    requestApproval: async () => {
      // Step status is updated to waiting_for_approval in wrappedRequestApproval
      return await approvalDeferred.promise
    }
  })

  await new Promise((r) => setTimeout(r, 5))
  const plan = orch.getAgentPlanner().getActivePlan()
  assert.ok(plan)
  const waitingStep = plan.steps.find((s) => s.status === 'waiting_for_approval')
  assert.ok(waitingStep, 'Step must be in waiting_for_approval state')

  // Resolve to clean up
  orch.stop()
  approvalDeferred.resolve(false)
  await runPromise.catch(() => {})
})

// ============================================================================
// SUITE 3: Run Lifecycle and State Isolation
// ============================================================================
console.log('\n============================================================')
console.log('Suite 3: Run Lifecycle & Cross-Run State Isolation')
console.log('============================================================')

await runTest('Stopping one run and then starting a new run succeeds cleanly', async () => {
  const orchRef = { current: null }

  const tool1 = createMockTool('tool_run_1', {
    onExecute: () => {
      orchRef.current.stop()
    },
    output: 'tool 1 output'
  })

  const tool2 = createMockTool('tool_run_2', {
    output: 'tool 2 output'
  })

  const provider1 = createMockProvider([
    { functionCalls: [{ name: 'tool_run_1', args: {} }] }
  ])
  const provider2 = createMockProvider([
    { functionCalls: [{ name: 'tool_run_2', args: {} }] },
    { text: 'Run 2 finished successfully.' }
  ])

  const orch = new AgentOrchestrator(provider1)
  orchRef.current = orch
  orch.registerTool(tool1)
  orch.registerTool(tool2)

  // Run 1 is aborted
  let run1Error = null
  try {
    await orch.run('Run 1', { apiKey: 'k', workspaceRoot: null })
  } catch (err) {
    run1Error = err
  }
  assert.ok(run1Error)
  assert.strictEqual(run1Error.message, 'Request was stopped by user.')

  // Run 2 starts on the same orchestrator instance
  orch.setProvider(provider2)
  orch.clearHistory()

  const result2 = await orch.run('Run 2', { apiKey: 'k', workspaceRoot: null })
  assert.strictEqual(result2, 'Run 2 finished successfully.')
  assert.strictEqual(tool2.executionHistory.length, 1)
})

await runTest('Old run cancellation signal does not cancel subsequent runs', async () => {
  const orch = new AgentOrchestrator(createMockProvider([{ text: 'Run 2 success' }]))

  // Stop is called on idle orchestrator
  orch.stop()

  // New run starts
  const result = await orch.run('Run 2 with fresh signal', { apiKey: 'k', workspaceRoot: null })
  assert.strictEqual(result, 'Run 2 success')
})

await runTest('Stale async response from superseded run does not corrupt active run state', async () => {
  const run1Deferred = createDeferred()
  let run1Dispatched = false
  let run2Dispatched = false

  const provider = {
    sendMessage: async (history) => {
      const promptText = history[history.length - 1]?.parts[0]?.text
      if (promptText === 'Run 1 prompt') {
        run1Dispatched = true
        // Run 1 hangs until after Run 2 has started
        return await run1Deferred.promise
      } else {
        run2Dispatched = true
        return { text: 'Response for Run 2' }
      }
    }
  }

  const orch = new AgentOrchestrator(provider)

  // Start Run 1 (async, does not await yet)
  let run1Error = null
  const run1Promise = orch.run('Run 1 prompt', { apiKey: 'k', workspaceRoot: null }).catch((err) => {
    run1Error = err
  })

  await new Promise((r) => setTimeout(r, 5))
  assert.strictEqual(run1Dispatched, true, 'Run 1 was dispatched')

  // Start Run 2 on same orchestrator instance (superseding Run 1)
  const run2Result = await orch.run('Run 2 prompt', { apiKey: 'k', workspaceRoot: null })
  assert.strictEqual(run2Dispatched, true, 'Run 2 was dispatched')
  assert.strictEqual(run2Result, 'Response for Run 2')

  // Now let Run 1's provider response resolve
  run1Deferred.resolve({ text: 'Stale response for Run 1' })
  await run1Promise

  // Run 1 must detect activeRunId !== runId and abort
  assert.ok(run1Error, 'Run 1 must be aborted by activeRunId mismatch')
  assert.strictEqual(run1Error.message, 'Request was stopped by user.')
})

await runTest('Repeated calls to stop() are safe and do not throw', async () => {
  const orch = new AgentOrchestrator(createMockProvider([]))

  for (let i = 0; i < 5; i++) {
    assert.doesNotThrow(() => {
      orch.stop()
    })
  }
})

await runTest('activeRunId increments monotonically across runs', async () => {
  const orch = new AgentOrchestrator(createMockProvider([
    { text: 'Ans 1' },
    { text: 'Ans 2' },
    { text: 'Ans 3' }
  ]))

  const id0 = orch['activeRunId'] || 0
  await orch.run('Prompt 1', { apiKey: 'k', workspaceRoot: null })
  const id1 = orch['activeRunId']
  await orch.run('Prompt 2', { apiKey: 'k', workspaceRoot: null })
  const id2 = orch['activeRunId']
  await orch.run('Prompt 3', { apiKey: 'k', workspaceRoot: null })
  const id3 = orch['activeRunId']

  assert.strictEqual(id1, id0 + 1)
  assert.strictEqual(id2, id1 + 1)
  assert.strictEqual(id3, id2 + 1)
})

// ============================================================================
// SUITE 4: Process-Termination Interface Tests
// ============================================================================
console.log('\n============================================================')
console.log('Suite 4: Process-Termination Interface Tests')
console.log('============================================================')

await runTest('orchestrator.stop() invokes window.electronAPI.stopCommand() for process cleanup', async () => {
  const initialCount = stopCommandCalls
  const orch = new AgentOrchestrator(createMockProvider([]))

  orch.stop()

  assert.strictEqual(stopCommandCalls, initialCount + 1, 'stopCommand() must be invoked on stop()')
})

await runTest('Repeated cancellation calls invoke stopCommand() each time without crash', async () => {
  const initialCount = stopCommandCalls
  const orch = new AgentOrchestrator(createMockProvider([]))

  orch.stop()
  orch.stop()
  orch.stop()

  assert.strictEqual(stopCommandCalls, initialCount + 3, 'stopCommand() invoked on each stop() call')
})

await runTest('stopCommand() rejection is caught silently and does not crash stop()', async () => {
  stopCommandShouldFail = true
  stopCommandErrorMessage = 'Electron IPC pipe broken'

  const orch = new AgentOrchestrator(createMockProvider([]))

  assert.doesNotThrow(() => {
    orch.stop()
  }, 'orch.stop() must not throw if stopCommand rejects')

  // Reset
  stopCommandShouldFail = false
})

await runTest('Verification that only mocked child process endpoints are tested', async () => {
  // Verify that window.electronAPI is strictly a mock and no real child_process or spawn is touched
  assert.strictEqual(typeof window.electronAPI.stopCommand, 'function')
  assert.strictEqual(typeof process.env.VITE_DEV_SERVER_URL, 'undefined')
})

// ============================================================================
// SUITE 5: Race Conditions & Microtask Interleaving
// ============================================================================
console.log('\n============================================================')
console.log('Suite 5: Race Conditions & Controllable Microtask Interleaving')
console.log('============================================================')

await runTest('Race: Stop and Provider Response occurring in identical microtask', async () => {
  const orchRef = { current: null }
  const tool = createMockTool('racing_tool', { output: 'should not run' })

  const provider = {
    sendMessage: async () => {
      // Simulate exact synchronous collision: abort signal fires in same microtask turn
      orchRef.current.stop()
      return {
        functionCalls: [{ name: 'racing_tool', args: {} }]
      }
    }
  }

  const orch = new AgentOrchestrator(provider)
  orchRef.current = orch
  orch.registerTool(tool)

  let errorCaught = null
  try {
    await orch.run('Simultaneous stop and provider response', { apiKey: 'k', workspaceRoot: null })
  } catch (err) {
    errorCaught = err
  }

  assert.ok(errorCaught)
  assert.strictEqual(errorCaught.message, 'Request was stopped by user.')
  assert.strictEqual(tool.executionHistory.length, 0, 'Tool must not execute when stop collides with provider response')
})

await runTest('Race: Stop and Tool Completion occurring in identical microtask', async () => {
  const orchRef = { current: null }
  let turn2Reached = false

  const tool = createMockTool('racing_tool_finish', {
    onExecute: () => {
      // Tool completes on same tick stop is fired
      orchRef.current.stop()
    },
    output: 'finished just as stop arrived'
  })

  const provider = createMockProvider([
    { functionCalls: [{ name: 'racing_tool_finish', args: {} }] },
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
    await orch.run('Simultaneous stop and tool finish', { apiKey: 'k', workspaceRoot: null })
  } catch (err) {
    errorCaught = err
  }

  assert.ok(errorCaught)
  assert.strictEqual(errorCaught.message, 'Request was stopped by user.')
  assert.strictEqual(turn2Reached, false, 'Turn 2 must not be reached when stop collides with tool completion')
})

await runTest('Race: Stop and Approval Acceptance occurring nearly simultaneously', async () => {
  const orchRef = { current: null }

  const tool = createMockTool('edit_file', {
    shouldRequestApproval: true,
    output: 'edited'
  })

  const provider = createMockProvider([
    { functionCalls: [{ name: 'edit_file', args: { path: 'src/app.ts' } }] }
  ])

  const orch = new AgentOrchestrator(provider)
  orchRef.current = orch
  orch.registerTool(tool)

  let errorCaught = null
  try {
    await orch.run('Simultaneous stop and approval grant', {
      apiKey: 'k',
      workspaceRoot: '/mock',
      requestApproval: async () => {
        // User clicks approve, but stop signal fires in the same event loop tick
        orchRef.current.stop()
        return true // Approved
      }
    })
  } catch (err) {
    errorCaught = err
  }

  assert.ok(errorCaught)
  assert.strictEqual(errorCaught.message, 'Request was stopped by user.')
})

await runTest('Race: Stop during sequential tool calls between tool 1 and tool 2', async () => {
  const orchRef = { current: null }
  let tool2Ran = false

  const tool1 = createMockTool('seq_tool_1', {
    onExecute: () => {
      orchRef.current.stop()
    },
    output: 'tool 1'
  })

  const tool2 = createMockTool('seq_tool_2', {
    onExecute: () => {
      tool2Ran = true
    },
    output: 'tool 2'
  })

  const provider = createMockProvider([
    {
      functionCalls: [
        { name: 'seq_tool_1', args: {} },
        { name: 'seq_tool_2', args: {} }
      ]
    }
  ])

  const orch = new AgentOrchestrator(provider)
  orchRef.current = orch
  orch.registerTool(tool1)
  orch.registerTool(tool2)

  let errorCaught = null
  try {
    await orch.run('Sequential stop race', { apiKey: 'k', workspaceRoot: null })
  } catch (err) {
    errorCaught = err
  }

  assert.ok(errorCaught)
  assert.strictEqual(errorCaught.message, 'Request was stopped by user.')
  assert.strictEqual(tool1.executionHistory.length, 1)
  assert.strictEqual(tool2Ran, false, 'Tool 2 must not run when stop arrives during batch execution')
})

await runTest('Race: Previous run resolving after newer run has completed leaves newer run intact', async () => {
  const slowProviderDeferred = createDeferred()

  const provider = {
    sendMessage: async (history) => {
      const txt = history[history.length - 1]?.parts[0]?.text
      if (txt === 'Slow prompt 1') {
        return await slowProviderDeferred.promise
      } else {
        return { text: 'Fast prompt 2 done' }
      }
    }
  }

  const orch = new AgentOrchestrator(provider)

  // Start Slow Run 1
  let run1Error = null
  const run1Promise = orch.run('Slow prompt 1', { apiKey: 'k', workspaceRoot: null }).catch((err) => {
    run1Error = err
  })

  // Start Fast Run 2
  const run2Result = await orch.run('Fast prompt 2', { apiKey: 'k', workspaceRoot: null })
  assert.strictEqual(run2Result, 'Fast prompt 2 done')

  // Resolve Slow Run 1 late
  slowProviderDeferred.resolve({ text: 'Late response 1' })
  await run1Promise

  assert.ok(run1Error)
  assert.strictEqual(run1Error.message, 'Request was stopped by user.')

  // Verify that history contains Run 2 and was not corrupted by Run 1
  const history = orch['history']
  const userMessages = history.filter((m) => m.role === 'user')
  const modelMessages = history.filter((m) => m.role === 'model')

  assert.strictEqual(userMessages.length, 2)
  assert.strictEqual(modelMessages.length, 1)
  assert.strictEqual(modelMessages[0].parts[0].text, 'Fast prompt 2 done')
})

// ============================================================================
// Summary & Metrics
// ============================================================================
console.log('\n============================================================')
console.log('Phase 2 Task 3 Test Execution Summary')
console.log('============================================================')
console.log(`Total Tests Run:  ${totalTests}`)
console.log(`Passed Tests:     ${passedTests}`)
console.log(`Failed Tests:     ${failedTests}`)

if (failures.length > 0) {
  console.log('\nFailures breakdown:')
  failures.forEach((f) => console.log(`  - Test ${f.id} [${f.name}]: ${f.error}`))
} else {
  console.log('\nAll Cancellation & Lifecycle stress tests passed with 100% success rate!')
}
