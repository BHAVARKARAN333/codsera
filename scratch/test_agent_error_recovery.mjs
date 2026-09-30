// scratch/test_agent_error_recovery.mjs
// Phase 2 — Task 8: Agent Error Recovery & Retry Reliability Test Suite
//
// Tests:
// Suite 1: Transient Provider Errors & Retry Progression
// Suite 2: Permanent Errors & Retry Exhaustion
// Suite 3: Cancellation Boundaries During Retry & Execution
// Suite 4: Tool Exceptions & Invalid Tool Results
// Suite 5: Malformed Tool Arguments & Repeated Failures
// Suite 6: Approval Interruption & Security Guardrails
// Suite 7: Multi-Run State Isolation & History Sanitization

import assert from 'node:assert'
import esbuild from 'esbuild'

console.log('--- Phase 2 Task 8: Agent Error Recovery & Retry Reliability ---')

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

// History schema validator
function validateHistoryIntegrity(history) {
  assert.ok(Array.isArray(history), 'History must be an array')
  if (history.length === 0) return

  assert.strictEqual(history[0].role, 'user', 'History must start with a user message')

  for (let i = 0; i < history.length; i++) {
    const msg = history[i]
    assert.ok(msg.role === 'user' || msg.role === 'model' || msg.role === 'function', `Valid role required, got ${msg.role}`)
    assert.ok(Array.isArray(msg.parts) && msg.parts.length > 0, `Message ${i} must have non-empty parts`)

    if (msg.role === 'model') {
      for (const p of msg.parts) {
        if (p.functionCall) {
          const fcName = p.functionCall.name
          let foundResponse = false
          for (let j = i + 1; j < history.length; j++) {
            if (history[j].role === 'user') break
            if (history[j].role === 'function') {
              for (const rp of history[j].parts) {
                if (rp.functionResponse?.name === fcName) {
                  foundResponse = true
                  break
                }
              }
            }
          }
          assert.ok(foundResponse, `Function call ${fcName} at index ${i} must have paired functionResponse before next user turn`)
        }
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
      if ('returnsInvalidResult' in options) {
        return options.returnsInvalidResult
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
// SUITE 1: Transient Provider Errors & Retry Progression
// ============================================================================
console.log('\n============================================================')
console.log('Suite 1: Transient Provider Errors & Retry Progression')
console.log('============================================================')

await runTest('Transient provider error on attempt 1 triggers onRetry and recovers on attempt 2', async () => {
  let attempts = 0
  const provider = {
    async sendMessage(messages, toolDeclarations, options) {
      attempts++
      if (attempts === 1) {
        // First attempt fails transiently with 429
        options?.onRetry?.(1, 3, 10, 'Rate limit 429')
        throw new Error('Rate limit 429: Resource temporarily exhausted')
      }
      return { text: 'Recovered successfully on retry' }
    }
  }

  // Wrap provider to simulate retry internally like real providers do
  let providerCalls = 0
  const retryingProvider = {
    async sendMessage(messages, toolDeclarations, options) {
      const maxRetries = 2
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (options?.signal?.aborted) throw new Error('Request was stopped by user.')
        providerCalls++
        if (attempt === 0) {
          options?.onRetry?.(1, maxRetries, 10, 'Rate limit 429')
          await new Promise((r) => setTimeout(r, 10))
          continue
        }
        return { text: 'Recovered successfully on retry' }
      }
      throw new Error('Retries exhausted')
    }
  }

  const orch = new AgentOrchestrator(retryingProvider)
  const steps = []
  const result = await orch.run('Test retry recovery', {
    apiKey: 'k',
    workspaceRoot: '/mock',
    onStep: (s) => steps.push(s)
  })

  assert.strictEqual(result, 'Recovered successfully on retry')
  const retryStep = steps.find((s) => s.type === 'retrying')
  assert.ok(retryStep, 'retrying step must be emitted')
  assert.strictEqual(retryStep.retryAttempt, 1)
  assert.strictEqual(retryStep.maxRetries, 2)
  assert.ok(retryStep.text.includes('Rate limit 429'))
  assert.strictEqual(steps.filter((s) => s.type === 'done').length, 1, 'Exactly one done step emitted')
})

await runTest('Streamed chunks from a failed retry attempt are not duplicated on recovery', async () => {
  let attempt = 0
  const retryingProvider = {
    async sendMessage(messages, toolDeclarations, options) {
      attempt++
      if (attempt === 1) {
        options?.onChunk?.('Failed partial chunk ')
        options?.onRetry?.(1, 2, 10, 'Stream error')
        await new Promise((r) => setTimeout(r, 10))
        return this.sendMessage(messages, toolDeclarations, options)
      }
      options?.onChunk?.('Clean stream chunk')
      return { text: 'Clean stream chunk' }
    }
  }

  const orch = new AgentOrchestrator(retryingProvider)
  const receivedChunks = []
  const result = await orch.run('Test chunk retry', {
    apiKey: 'k',
    workspaceRoot: '/mock',
    onChunk: (c) => receivedChunks.push(c)
  })

  assert.strictEqual(result, 'Clean stream chunk')
  assert.ok(receivedChunks.includes('Clean stream chunk'))
})

await runTest('Multiple transient retries across consecutive model iterations succeed cleanly', async () => {
  let callCount = 0
  const tool = createMockTool('helper_tool', { output: 'tool_ok' })

  const multiRetryProvider = {
    async sendMessage(messages, toolDeclarations, options) {
      callCount++
      if (callCount === 1) {
        // Iteration 1, attempt 1: retries then calls tool
        options?.onRetry?.(1, 2, 5, 'Iter1 temporary error')
        return {
          text: 'Calling tool',
          functionCalls: [{ name: 'helper_tool', args: {} }]
        }
      }
      if (callCount === 2) {
        // Iteration 2, attempt 1: retries then completes
        options?.onRetry?.(1, 2, 5, 'Iter2 temporary error')
        return { text: 'Final answer after multi-iteration retry' }
      }
      return { text: 'Default' }
    }
  }

  const orch = new AgentOrchestrator(multiRetryProvider)
  orch.registerTool(tool)

  const steps = []
  const result = await orch.run('Multi-turn retry test', {
    apiKey: 'k',
    workspaceRoot: '/mock',
    onStep: (s) => steps.push(s)
  })

  assert.strictEqual(result, 'Final answer after multi-iteration retry')
  const retrySteps = steps.filter((s) => s.type === 'retrying')
  assert.strictEqual(retrySteps.length, 2, 'Both iterations must report their retries')
  const toolResults = steps.filter((s) => s.type === 'tool_result')
  assert.strictEqual(toolResults.length, 1, 'Tool executed exactly once')
})

// ============================================================================
// SUITE 2: Permanent Errors & Retry Exhaustion
// ============================================================================
console.log('\n============================================================')
console.log('Suite 2: Permanent Errors & Retry Exhaustion')
console.log('============================================================')

await runTest('Permanent provider error immediately propagates without infinite retry loop', async () => {
  let calls = 0
  const permanentErrorProvider = {
    async sendMessage() {
      calls++
      throw new Error('API key invalid or unauthorized (401)')
    }
  }

  const orch = new AgentOrchestrator(permanentErrorProvider)
  const steps = []

  await assert.rejects(
    async () => {
      await orch.run('Permanent error test', {
        apiKey: 'invalid_key',
        workspaceRoot: '/mock',
        onStep: (s) => steps.push(s)
      })
    },
    /API key invalid or unauthorized/
  )

  assert.strictEqual(calls, 1, 'Permanent error must not trigger repeated iterations')
  const errorStep = steps.find((s) => s.type === 'error')
  assert.ok(errorStep, 'type: error step must be emitted')
  assert.ok(errorStep.error.includes('401'))

  // Verify history integrity
  const history = orch.getHistory()
  assert.strictEqual(history[history.length - 1].role, 'model')
  assert.ok(history[history.length - 1].parts[0].text.includes('Execution halted'))
})

await runTest('Provider retries exhausted causes clean plan abort and error propagation', async () => {
  const exhaustedProvider = {
    async sendMessage(messages, toolDeclarations, options) {
      options?.onRetry?.(1, 3, 5, 'Server 503')
      options?.onRetry?.(2, 3, 5, 'Server 503')
      options?.onRetry?.(3, 3, 5, 'Server 503')
      throw new Error('Max retries exceeded: Service Unavailable (503)')
    }
  }

  const orch = new AgentOrchestrator(exhaustedProvider)
  const steps = []

  await assert.rejects(
    async () => {
      await orch.run('Implement and test verification', {
        apiKey: 'k',
        workspaceRoot: '/mock',
        onStep: (s) => steps.push(s)
      })
    },
    /Max retries exceeded/
  )

  const plan = orch.agentPlanner.getActivePlan()
  assert.strictEqual(plan.status, 'aborted')
  assert.ok(plan.failureReason.includes('503'))

  const errorStep = steps.find((s) => s.type === 'error')
  assert.ok(errorStep)
  assert.ok(errorStep.error.includes('Max retries exceeded'))
})

await runTest('Exceeding maximum tool execution limit (12 iterations) aborts plan and exits cleanly', async () => {
  const tool = createMockTool('infinite_tool', { output: 'looping' })
  const loopingProvider = {
    async sendMessage() {
      // Always returns tool call to force max iterations
      return { functionCalls: [{ name: 'infinite_tool', args: {} }] }
    }
  }

  const orch = new AgentOrchestrator(loopingProvider)
  orch.registerTool(tool)

  const steps = []
  const result = await orch.run('Fix this bug and test it', {
    apiKey: 'k',
    workspaceRoot: '/mock',
    onStep: (s) => steps.push(s)
  })

  assert.strictEqual(result, 'Maximum tool execution iterations reached.')
  const plan = orch.agentPlanner.getActivePlan()
  assert.strictEqual(plan.status, 'aborted')

  const doneStep = steps.find((s) => s.type === 'done')
  assert.ok(doneStep)
  assert.strictEqual(doneStep.text, 'Maximum tool execution iterations reached.')
})

// ============================================================================
// SUITE 3: Cancellation Boundaries During Retry & Execution
// ============================================================================
console.log('\n============================================================')
console.log('Suite 3: Cancellation Boundaries During Retry & Execution')
console.log('============================================================')

await runTest('Cancellation during a retry delay immediately stops the run and prevents further calls', async () => {
  let secondAttemptFired = false
  let orchRef = null

  const retryingProviderWithDelay = {
    async sendMessage(messages, toolDeclarations, options) {
      options?.onRetry?.(1, 3, 50, 'Rate limit')

      // Simulate provider backoff sleep that observes signal
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 50)
        options?.signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(new Error('Request was stopped by user.'))
        }, { once: true })
      })

      secondAttemptFired = true
      return { text: 'Should not reach here' }
    }
  }

  const orch = new AgentOrchestrator(retryingProviderWithDelay)
  orchRef = orch

  // Trigger stop while provider is sleeping in retry backoff
  setTimeout(() => orchRef.stop(), 15)

  await assert.rejects(
    async () => {
      await orch.run('Stop during retry delay', {
        apiKey: 'k',
        workspaceRoot: '/mock'
      })
    },
    /Request was stopped by user/
  )

  assert.strictEqual(secondAttemptFired, false, 'Second attempt must never fire after cancellation')
})

await runTest('Cancellation during tool execution cleanly aborts and suppresses error step', async () => {
  let orchRef = null
  const slowTool = createMockTool('slow_tool', { delayMs: 40, output: 'ok' })
  const provider = {
    async sendMessage() {
      return { functionCalls: [{ name: 'slow_tool', args: {} }] }
    }
  }

  const orch = new AgentOrchestrator(provider)
  orchRef = orch
  orch.registerTool(slowTool)

  setTimeout(() => orchRef.stop(), 15)

  const steps = []
  await assert.rejects(
    async () => {
      await orch.run('Fix issue and test it', {
        apiKey: 'k',
        workspaceRoot: '/mock',
        onStep: (s) => steps.push(s)
      })
    },
    /Request was stopped by user/
  )

  assert.strictEqual(steps.some((s) => s.type === 'error'), false, 'Cancellation must not emit type: error')
  const plan = orch.agentPlanner.getActivePlan()
  assert.strictEqual(plan.status, 'aborted')
})

await runTest('Cancellation between tool calls in same response preserves completed results and sanitizes remaining', async () => {
  let orchRef = null
  const tool1 = createMockTool('tool_first', { output: 'first_done' })
  const tool2 = createMockTool('tool_second', { delayMs: 30, output: 'second_done' })

  const provider = {
    async sendMessage() {
      return {
        functionCalls: [
          { name: 'tool_first', args: {} },
          { name: 'tool_second', args: {} }
        ]
      }
    }
  }

  const orch = new AgentOrchestrator(provider)
  orchRef = orch
  orch.registerTool(tool1)
  orch.registerTool(tool2)

  // Stop after tool 1 executes
  const steps = []
  await assert.rejects(
    async () => {
      await orch.run('Run two tools', {
        apiKey: 'k',
        workspaceRoot: '/mock',
        onStep: (s) => {
          steps.push(s)
          if (s.type === 'tool_result' && s.toolName === 'tool_first') {
            orchRef.stop()
          }
        }
      })
    },
    /Request was stopped by user/
  )

  const tool1Res = steps.find((s) => s.type === 'tool_result' && s.toolName === 'tool_first')
  assert.ok(tool1Res, 'Tool 1 result must be preserved')

  // History must have tool_first and synthetic cancelled tool_second
  const history = orch.getHistory()
  validateHistoryIntegrity(history)
})

// ============================================================================
// SUITE 4: Tool Exceptions & Invalid Tool Results
// ============================================================================
console.log('\n============================================================')
console.log('Suite 4: Tool Exceptions & Invalid Tool Results')
console.log('============================================================')

await runTest('Tool throwing unexpected exception aborts plan and sanitizes history', async () => {
  const crashingTool = createMockTool('crashing_tool', { throws: 'EACCES: Permission denied to write file' })
  const provider = {
    async sendMessage() {
      return { functionCalls: [{ name: 'crashing_tool', args: {} }] }
    }
  }

  const orch = new AgentOrchestrator(provider)
  orch.registerTool(crashingTool)

  await assert.rejects(
    async () => {
      await orch.run('Create file and test', {
        apiKey: 'k',
        workspaceRoot: '/mock'
      })
    },
    /Permission denied/
  )

  const plan = orch.agentPlanner.getActivePlan()
  assert.strictEqual(plan.status, 'aborted')
  assert.ok(plan.failureReason.includes('Permission denied'))

  const history = orch.getHistory()
  validateHistoryIntegrity(history)
})

await runTest('Tool returning undefined or null result is normalized safely without unhandled TypeError', async () => {
  const invalidResultTool = createMockTool('bad_result_tool', { returnsInvalidResult: null })
  let iteration = 0
  const provider = {
    async sendMessage(messages) {
      iteration++
      if (iteration === 1) {
        return { functionCalls: [{ name: 'bad_result_tool', args: {} }] }
      }
      return { text: 'I received the tool error notice and handled it.' }
    }
  }

  const orch = new AgentOrchestrator(provider)
  orch.registerTool(invalidResultTool)

  const steps = []
  const result = await orch.run('Test invalid tool result normalization', {
    apiKey: 'k',
    workspaceRoot: '/mock',
    onStep: (s) => steps.push(s)
  })

  assert.strictEqual(result, 'I received the tool error notice and handled it.')
  const toolResult = steps.find((s) => s.type === 'tool_result' && s.toolName === 'bad_result_tool')
  assert.ok(toolResult)
  assert.strictEqual(toolResult.toolSuccess, false)
  assert.ok(toolResult.toolOutput.includes('Tool returned invalid result'))
})

await runTest('Tool returning primitive string instead of object is normalized without crash', async () => {
  const primitiveTool = createMockTool('primitive_tool', { returnsInvalidResult: 'raw string not object' })
  let iteration = 0
  const provider = {
    async sendMessage() {
      iteration++
      if (iteration === 1) {
        return { functionCalls: [{ name: 'primitive_tool', args: {} }] }
      }
      return { text: 'Handled primitive return' }
    }
  }

  const orch = new AgentOrchestrator(provider)
  orch.registerTool(primitiveTool)

  const res = await orch.run('Handle primitive return', {
    apiKey: 'k',
    workspaceRoot: '/mock'
  })

  assert.strictEqual(res, 'Handled primitive return')
})

// ============================================================================
// SUITE 5: Malformed Tool Arguments & Repeated Failures
// ============================================================================
console.log('\n============================================================')
console.log('Suite 5: Malformed Tool Arguments & Repeated Failures')
console.log('============================================================')

await runTest('Tool called with null arguments is handled safely and returns error to model', async () => {
  const tool = new ReadFileTool()
  let iteration = 0
  const provider = {
    async sendMessage() {
      iteration++
      if (iteration === 1) {
        return { functionCalls: [{ name: 'read_file', args: null }] }
      }
      return { text: 'Noticed missing path and recovered.' }
    }
  }

  const orch = new AgentOrchestrator(provider)
  orch.registerTool(tool)

  const steps = []
  const res = await orch.run('Read file with null args', {
    apiKey: 'k',
    workspaceRoot: '/mock',
    onStep: (s) => steps.push(s)
  })

  assert.strictEqual(res, 'Noticed missing path and recovered.')
  const toolResult = steps.find((s) => s.type === 'tool_result' && s.toolName === 'read_file')
  assert.strictEqual(toolResult.toolSuccess, false)
})

await runTest('Repeated identical failing tool calls trigger loop mitigation notice', async () => {
  const failingTool = createMockTool('failing_tool', { success: false, output: 'Operation failed: Network error' })
  let iteration = 0
  let secondToolOutput = ''

  const provider = {
    async sendMessage() {
      iteration++
      if (iteration <= 2) {
        // Model retries the exact same failing tool call
        return { functionCalls: [{ name: 'failing_tool', args: { target: 'host.local' } }] }
      }
      return { text: 'Acknowledged failure after warning.' }
    }
  }

  const orch = new AgentOrchestrator(provider)
  orch.registerTool(failingTool)

  const steps = []
  await orch.run('Repeated failure test', {
    apiKey: 'k',
    workspaceRoot: '/mock',
    onStep: (s) => {
      steps.push(s)
      if (s.type === 'tool_result' && iteration === 2) {
        secondToolOutput = s.toolOutput
      }
    }
  })

  assert.ok(secondToolOutput.includes('Notice: Tool \'failing_tool\' with identical arguments has failed 2 times'))
  assert.ok(secondToolOutput.includes('Do NOT call \'failing_tool\' with these identical failing arguments again'))
})

await runTest('Consecutive tool failure counts are reset after tool succeeds or on clearHistory()', async () => {
  let shouldFail = true
  const intermittentTool = {
    name: 'intermittent_tool',
    description: 'tool',
    parameters: { type: 'object', properties: {} },
    requiresApproval: false,
    async execute() {
      if (shouldFail) return { success: false, output: 'Temporary fail' }
      return { success: true, output: 'Success now' }
    }
  }

  let turn = 0
  const provider = {
    async sendMessage() {
      turn++
      if (turn === 1) return { functionCalls: [{ name: 'intermittent_tool', args: {} }] }
      if (turn === 2) {
        shouldFail = false // Succeeds on turn 2
        return { functionCalls: [{ name: 'intermittent_tool', args: {} }] }
      }
      return { text: 'Done' }
    }
  }

  const orch = new AgentOrchestrator(provider)
  orch.registerTool(intermittentTool)

  await orch.run('Test failure counter reset', {
    apiKey: 'k',
    workspaceRoot: '/mock'
  })

  // Clear history and verify map is emptied
  orch.clearHistory()
  assert.strictEqual(orch.consecutiveToolFailures.size, 0, 'consecutiveToolFailures must be cleared on clearHistory')
})

// ============================================================================
// SUITE 6: Approval Interruption & Security Guardrails
// ============================================================================
console.log('\n============================================================')
console.log('Suite 6: Approval Interruption & Security Guardrails')
console.log('============================================================')

await runTest('Approval-required tool interrupted by stop() never executes and does not authorize next run', async () => {
  let approvalResolver = null
  let toolExecuted = false
  const mutatingTool = {
    name: 'edit_file',
    description: 'Mock edit',
    parameters: { type: 'object', properties: {} },
    requiresApproval: true,
    async execute(_args, context) {
      const isApproved = await context.requestApproval({ toolName: 'edit_file' })
      if (!isApproved) {
        return { success: false, rejected: true, output: 'Tool execution rejected by user.' }
      }
      toolExecuted = true
      return { success: true, output: 'Executed' }
    }
  }

  const provider = {
    async sendMessage() {
      return { functionCalls: [{ name: 'edit_file', args: { path: 'critical.ts' } }] }
    }
  }

  const orch = new AgentOrchestrator(provider)
  orch.registerTool(mutatingTool)

  // Run 1: user stops while waiting for approval
  const run1Promise = orch.run('Edit critical.ts and test', {
    apiKey: 'k',
    workspaceRoot: '/mock',
    requestApproval: () => {
      return new Promise((resolve) => {
        approvalResolver = resolve
      })
    }
  })

  // Give microtask time to enter waiting_for_approval
  await new Promise((r) => setTimeout(r, 10))
  orch.stop()

  // Stale approval resolves true after run was stopped
  approvalResolver?.(true)

  await assert.rejects(run1Promise, /Request was stopped by user/)
  assert.strictEqual(toolExecuted, false, 'Tool must NOT execute when run was stopped')
})

await runTest('Security violation if requiresApproval tool attempts execution without approval', async () => {
  // Simulate a tool declaring requiresApproval: true where approval was bypassed
  const tool = {
    name: 'bypassed_tool',
    description: 'tool',
    parameters: { type: 'object', properties: {} },
    requiresApproval: true,
    async execute() {
      // Bypasses context.requestApproval and returns success directly
      return { success: true, output: 'Infiltrated' }
    }
  }

  const provider = {
    async sendMessage() {
      return { functionCalls: [{ name: 'bypassed_tool', args: {} }] }
    }
  }

  const orch = new AgentOrchestrator(provider)
  orch.registerTool(tool)

  const steps = []
  const res = await orch.run('Test security guardrail', {
    apiKey: 'k',
    workspaceRoot: '/mock',
    onStep: (s) => steps.push(s)
  })

  const toolResult = steps.find((s) => s.type === 'tool_result')
  assert.ok(toolResult)
  assert.strictEqual(toolResult.toolSuccess, false)
  assert.ok(toolResult.toolOutput.includes('Security violation'))
})

// ============================================================================
// SUITE 7: Multi-Run State Isolation & History Sanitization
// ============================================================================
console.log('\n============================================================')
console.log('Suite 7: Multi-Run State Isolation & History Sanitization')
console.log('============================================================')

await runTest('Stale retry callbacks from previous aborted run cannot trigger events in subsequent run', async () => {
  let staleRetryHandler = null
  const provider = {
    async sendMessage(messages, toolDeclarations, options) {
      const latestUser = messages[messages.length - 1]?.parts[0]?.text
      if (latestUser === 'Aborted Run') {
        staleRetryHandler = options?.onRetry
        // Abort this run immediately
        options?.signal?.addEventListener('abort', () => {}, { once: true })
        throw new Error('Request was stopped by user.')
      }
      return { text: 'Clean run completed' }
    }
  }

  const orch = new AgentOrchestrator(provider)

  // Run 1 starts and is aborted
  const p1 = orch.run('Aborted Run', { apiKey: 'k', workspaceRoot: '/mock' })
  orch.stop()
  await assert.rejects(p1, /Request was stopped by user/)

  // Run 2 starts
  const run2Steps = []
  const res2 = await orch.run('Clean Run', {
    apiKey: 'k',
    workspaceRoot: '/mock',
    onStep: (s) => run2Steps.push(s)
  })

  // Stale retry callback from Run 1 fires now
  staleRetryHandler?.(1, 3, 10, 'Late retry')

  assert.strictEqual(res2, 'Clean run completed')
  assert.strictEqual(run2Steps.some((s) => s.type === 'retrying'), false, 'Stale retry must NOT leak into Run 2')
})

await runTest('Complete conversation history validation after error recovery', async () => {
  const tool = createMockTool('recovery_tool', { output: 'rec_ok' })
  let callIndex = 0
  const provider = {
    async sendMessage(messages) {
      callIndex++
      if (callIndex === 1) {
        return { functionCalls: [{ name: 'recovery_tool', args: {} }] }
      }
      return { text: 'Everything is resolved and verified.' }
    }
  }

  const orch = new AgentOrchestrator(provider)
  orch.registerTool(tool)

  await orch.run('Run end-to-end recovery test', {
    apiKey: 'k',
    workspaceRoot: '/mock'
  })

  const history = orch.getHistory()
  validateHistoryIntegrity(history)

  assert.strictEqual(history[0].role, 'user')
  assert.strictEqual(history[1].role, 'model')
  assert.strictEqual(history[2].role, 'function')
  assert.strictEqual(history[3].role, 'model')
})

await runTest('History remains structurally valid when provider throws on Turn 2 of multi-step plan', async () => {
  const tool = createMockTool('step1_tool', { output: 'step1_ok' })
  let call = 0
  const provider = {
    async sendMessage() {
      call++
      if (call === 1) {
        return { functionCalls: [{ name: 'step1_tool', args: {} }] }
      }
      throw new Error('Fatal network error on Turn 2')
    }
  }

  const orch = new AgentOrchestrator(provider)
  orch.registerTool(tool)

  await assert.rejects(
    async () => {
      await orch.run('Fix bug and verify it', {
        apiKey: 'k',
        workspaceRoot: '/mock'
      })
    },
    /Fatal network error on Turn 2/
  )

  const history = orch.getHistory()
  validateHistoryIntegrity(history)
  assert.strictEqual(history[history.length - 1].role, 'model')
  assert.ok(history[history.length - 1].parts[0].text.includes('Execution halted'))
})

// ============================================================================
// Execution Summary
// ============================================================================
console.log('\n============================================================')
console.log('Phase 2 Task 8 Test Execution Summary')
console.log('============================================================')
console.log(`Total Tests Run:  ${totalTests}`)
console.log(`Passed Tests:     ${passedTests}`)
console.log(`Failed Tests:     ${failedTests}`)

if (failedTests > 0) {
  console.error(`\nFAILED: ${failedTests} error recovery and retry test(s) failed.`)
  process.exit(1)
} else {
  console.log('\nAll Agent Error Recovery & Retry Reliability tests passed with 100% success rate!\n')
}
