// scratch/test_agent_approval_guardrails.mjs
// Phase 2 — Task 5: Agent Approval Safety & Tool Execution Guardrails Test Suite
//
// Tests:
// Suite 1: Tool Classification & Approval Policy
// Suite 2: Read-Only Tool Execution Path (No Approval Prompts)
// Suite 3: Tool-Level Fail-Safe Guards (Missing Handlers & Aborted Signals)
// Suite 4: User Approval Lifecycle (Approval, Rejection, Waiting & Error Handling)
// Suite 5: Stale, Cancelled & Superseded Approval Guards
// Suite 6: Multi-Tool Ordering, Independent Approvals & Cascading Halt
// Suite 7: Approval Payload Parity & Pre-Approval Safety Validation
// Suite 8: Orchestrator Architectural Guardrail Enforcement

import assert from 'node:assert'
import esbuild from 'esbuild'

console.log('--- Phase 2 Task 5: Agent Approval Safety & Tool Execution Guardrails ---')

// 1. Transpile production modules with esbuild
const bundle = await esbuild.build({
  entryPoints: [
    'src/renderer/src/services/agent/orchestrator.ts',
    'src/renderer/src/services/agent/agentPlanner.ts',
    'src/renderer/src/services/tools/createFileTool.ts',
    'src/renderer/src/services/tools/editFileTool.ts',
    'src/renderer/src/services/tools/runCommandTool.ts',
    'src/renderer/src/services/tools/readFileTool.ts',
    'src/renderer/src/services/tools/listFilesTool.ts',
    'src/renderer/src/services/tools/gitStatusTool.ts',
    'src/renderer/src/services/tools/gitDiffTool.ts',
    'src/renderer/src/services/tools/gitLogTool.ts'
  ],
  bundle: true,
  format: 'esm',
  write: false,
  outdir: 'out',
  platform: 'browser',
  target: 'es2022',
  external: ['electron', 'lucide-react', 'react', 'react-dom']
})

// Helper to extract a transpiled file from outputFiles
function getOutputFile(pathSuffix) {
  const file = bundle.outputFiles.find((f) => f.path.replace(/\\/g, '/').endsWith(pathSuffix))
  if (!file) throw new Error(`Could not find output file matching: ${pathSuffix}`)
  return file.text
}

async function importFromText(text) {
  return await import('data:text/javascript;base64,' + Buffer.from(text).toString('base64'))
}

// Setup mock window.electronAPI
const electronCalls = {
  createdFiles: [],
  editedFiles: [],
  executedCommands: [],
  readFiles: new Map([
    ['src/existing.ts', 'const x = 1;\nexport default x;'],
    ['src/app.ts', '// app code']
  ])
}

globalThis.window = {
  electronAPI: {
    readWorkspaceFile: async (_root, rel) => {
      if (electronCalls.readFiles.has(rel)) {
        return { success: true, path: rel, content: electronCalls.readFiles.get(rel) }
      }
      return { success: false, error: `File not found: '${rel}'` }
    },
    createWorkspaceFile: async (_root, rel, content) => {
      electronCalls.createdFiles.push({ path: rel, content })
      electronCalls.readFiles.set(rel, content)
      return { success: true, path: rel }
    },
    editWorkspaceFile: async (_root, rel, newContent, oldContent) => {
      const current = electronCalls.readFiles.get(rel)
      if (oldContent !== undefined && current !== oldContent) {
        return { success: false, error: 'File changed since this edit was proposed.' }
      }
      electronCalls.editedFiles.push({ path: rel, newContent, oldContent })
      electronCalls.readFiles.set(rel, newContent)
      return { success: true, path: rel }
    },
    runCommand: async (cmd, cwd) => {
      electronCalls.executedCommands.push({ cmd, cwd })
      return {
        success: true,
        exitCode: 0,
        stdout: `Executed: ${cmd}`,
        stderr: '',
        timedOut: false
      }
    },
    readTree: async (root) => ({
      success: true,
      rootPath: root,
      tree: [
        { name: 'existing.ts', path: `${root}/src/existing.ts`, isDirectory: false, size: 40, mtimeMs: Date.now() },
        { name: 'app.ts', path: `${root}/src/app.ts`, isDirectory: false, size: 50, mtimeMs: Date.now() }
      ]
    }),
    gitStatus: async () => ({
      success: true,
      isRepository: true,
      currentBranch: 'master',
      staged: [],
      unstaged: [],
      untracked: []
    }),
    gitDiff: async () => ({
      success: true,
      isRepository: true,
      unstagedDiff: '',
      stagedDiff: ''
    }),
    gitLog: async () => ({
      success: true,
      isRepository: true,
      commits: [{ hash: 'abc1234', author: 'Dev', date: '2026-09-30', message: 'Initial commit' }]
    }),
    stopCommand: async () => ({ success: true })
  }
}

const orchMod = await importFromText(getOutputFile('orchestrator.js'))
const plannerMod = await importFromText(getOutputFile('agentPlanner.js'))
const createFileMod = await importFromText(getOutputFile('createFileTool.js'))
const editFileMod = await importFromText(getOutputFile('editFileTool.js'))
const runCommandMod = await importFromText(getOutputFile('runCommandTool.js'))
const readFileMod = await importFromText(getOutputFile('readFileTool.js'))
const listFilesMod = await importFromText(getOutputFile('listFilesTool.js'))
const gitStatusMod = await importFromText(getOutputFile('gitStatusTool.js'))
const gitDiffMod = await importFromText(getOutputFile('gitDiffTool.js'))
const gitLogMod = await importFromText(getOutputFile('gitLogTool.js'))

const { AgentOrchestrator } = orchMod
const { AgentPlanner } = plannerMod
const { CreateFileTool } = createFileMod
const { EditFileTool } = editFileMod
const { RunCommandTool } = runCommandMod
const { ReadFileTool } = readFileMod
const { ListFilesTool } = listFilesMod
const { GitStatusTool } = gitStatusMod
const { GitDiffTool } = gitDiffMod
const { GitLogTool } = gitLogMod

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

// Deferred helper
function createDeferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
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
// SUITE 1: Tool Classification & Approval Policy
// ============================================================================
console.log('\n============================================================')
console.log('Suite 1: Tool Classification & Approval Policy')
console.log('============================================================')

await runTest('Mutating tools declare requiresApproval = true', async () => {
  const createTool = new CreateFileTool()
  const editTool = new EditFileTool()
  const runCmdTool = new RunCommandTool()

  assert.strictEqual(createTool.requiresApproval, true, 'create_file must require approval')
  assert.strictEqual(editTool.requiresApproval, true, 'edit_file must require approval')
  assert.strictEqual(runCmdTool.requiresApproval, true, 'run_command must require approval')
})

await runTest('Read-only tools declare requiresApproval = false', async () => {
  const readTool = new ReadFileTool()
  const listTool = new ListFilesTool()
  const statusTool = new GitStatusTool()
  const diffTool = new GitDiffTool()
  const logTool = new GitLogTool()

  assert.strictEqual(readTool.requiresApproval, false, 'read_file must NOT require approval')
  assert.strictEqual(listTool.requiresApproval, false, 'list_files must NOT require approval')
  assert.strictEqual(statusTool.requiresApproval, false, 'git_status must NOT require approval')
  assert.strictEqual(diffTool.requiresApproval, false, 'git_diff must NOT require approval')
  assert.strictEqual(logTool.requiresApproval, false, 'git_log must NOT require approval')
})

// ============================================================================
// SUITE 2: Read-Only Tool Execution Path (No Approval Prompts)
// ============================================================================
console.log('\n============================================================')
console.log('Suite 2: Read-Only Tool Execution Path (No Approval Prompts)')
console.log('============================================================')

await runTest('Read-only tools execute directly without invoking requestApproval callback', async () => {
  let approvalInvoked = false
  const readTool = new ReadFileTool()
  const listTool = new ListFilesTool()

  const provider = createMockProvider([
    { functionCalls: [{ name: 'read_file', args: { path: 'src/existing.ts' } }] },
    { functionCalls: [{ name: 'list_files', args: {} }] },
    { text: 'Read and listed files successfully.' }
  ])

  const orch = new AgentOrchestrator(provider)
  orch.registerTool(readTool)
  orch.registerTool(listTool)

  const res = await orch.run('Read existing.ts and list files', {
    apiKey: 'k',
    workspaceRoot: '/mock/workspace',
    requestApproval: async () => {
      approvalInvoked = true
      return true
    }
  })

  assert.strictEqual(approvalInvoked, false, 'Approval must never be called for read-only tools')
  assert.ok(res.includes('Read and listed files successfully.'))
})

await runTest('Git read-only tools execute without approval prompts', async () => {
  let approvalInvoked = false
  const statusTool = new GitStatusTool()
  const diffTool = new GitDiffTool()
  const logTool = new GitLogTool()

  const provider = createMockProvider([
    { functionCalls: [{ name: 'git_status', args: {} }] },
    { functionCalls: [{ name: 'git_diff', args: {} }] },
    { functionCalls: [{ name: 'git_log', args: {} }] },
    { text: 'Git checks complete.' }
  ])

  const orch = new AgentOrchestrator(provider)
  orch.registerTool(statusTool)
  orch.registerTool(diffTool)
  orch.registerTool(logTool)

  const res = await orch.run('Check git status, diff and log', {
    apiKey: 'k',
    workspaceRoot: '/mock/workspace',
    requestApproval: async () => {
      approvalInvoked = true
      return true
    }
  })

  assert.strictEqual(approvalInvoked, false, 'Git status/diff/log must not prompt approval')
  assert.ok(res.includes('Git checks complete.'))
})

// ============================================================================
// SUITE 3: Tool-Level Fail-Safe Guards (Missing Handlers & Aborted Signals)
// ============================================================================
console.log('\n============================================================')
console.log('Suite 3: Tool-Level Fail-Safe Guards (Missing Handlers & Aborted Signals)')
console.log('============================================================')

await runTest('CreateFileTool fails-safe and rejects when context.requestApproval is missing', async () => {
  const initialCreatedCount = electronCalls.createdFiles.length
  const tool = new CreateFileTool()

  const result = await tool.execute(
    { path: 'src/unsafe.ts', content: 'should not be created' },
    { workspaceRoot: '/mock/workspace' } // No requestApproval provided
  )

  assert.strictEqual(result.success, false)
  assert.strictEqual(result.rejected, true)
  assert.ok(result.error?.includes('approval handler is required'))
  assert.strictEqual(electronCalls.createdFiles.length, initialCreatedCount, 'No file should be created on disk')
})

await runTest('EditFileTool fails-safe and rejects when context.requestApproval is missing', async () => {
  const initialEditedCount = electronCalls.editedFiles.length
  const tool = new EditFileTool()

  const result = await tool.execute(
    { path: 'src/existing.ts', newContent: 'new modified code' },
    { workspaceRoot: '/mock/workspace' } // No requestApproval provided
  )

  assert.strictEqual(result.success, false)
  assert.strictEqual(result.rejected, true)
  assert.ok(result.error?.includes('approval handler is required'))
  assert.strictEqual(electronCalls.editedFiles.length, initialEditedCount, 'No file should be edited on disk')
})

await runTest('RunCommandTool fails-safe and rejects when context.requestApproval is missing', async () => {
  const initialExecCount = electronCalls.executedCommands.length
  const tool = new RunCommandTool()

  const result = await tool.execute(
    { command: 'npm test' },
    { workspaceRoot: '/mock/workspace' } // No requestApproval provided
  )

  assert.strictEqual(result.success, false)
  assert.strictEqual(result.rejected, true)
  assert.ok(result.error?.includes('approval handler is required'))
  assert.strictEqual(electronCalls.executedCommands.length, initialExecCount, 'No command should be executed')
})

await runTest('Tools refuse execution if context.signal is already aborted', async () => {
  const controller = new AbortController()
  controller.abort()

  const createTool = new CreateFileTool()
  const createRes = await createTool.execute(
    { path: 'src/aborted.ts', content: 'content' },
    {
      workspaceRoot: '/mock/workspace',
      signal: controller.signal,
      requestApproval: async () => true
    }
  )
  assert.strictEqual(createRes.success, false)
  assert.strictEqual(createRes.rejected, true)
  assert.ok(createRes.error?.includes('cancelled by user'))

  const editTool = new EditFileTool()
  const editRes = await editTool.execute(
    { path: 'src/existing.ts', newContent: 'v2' },
    {
      workspaceRoot: '/mock/workspace',
      signal: controller.signal,
      requestApproval: async () => true
    }
  )
  assert.strictEqual(editRes.success, false)
  assert.strictEqual(editRes.rejected, true)
  assert.ok(editRes.error?.includes('cancelled by user'))

  const runTool = new RunCommandTool()
  const runRes = await runTool.execute(
    { command: 'npm test' },
    {
      workspaceRoot: '/mock/workspace',
      signal: controller.signal,
      requestApproval: async () => true
    }
  )
  assert.strictEqual(runRes.success, false)
  assert.strictEqual(runRes.rejected, true)
  assert.ok(runRes.error?.includes('cancelled by user'))
})

// ============================================================================
// SUITE 4: User Approval Lifecycle (Approval, Rejection, Waiting & Error Handling)
// ============================================================================
console.log('\n============================================================')
console.log('Suite 4: User Approval Lifecycle (Approval, Rejection, Waiting & Error Handling)')
console.log('============================================================')

await runTest('User approval permits execution and completes plan step', async () => {
  let approvalPrompted = false
  const editTool = new EditFileTool()

  const provider = createMockProvider([
    { functionCalls: [{ name: 'edit_file', args: { path: 'src/existing.ts', newContent: 'export const valid = true;' } }] },
    { text: 'Edit completed successfully.' }
  ])

  const orch = new AgentOrchestrator(provider)
  orch.registerTool(editTool)

  const res = await orch.run('Edit src/existing.ts to add valid export', {
    apiKey: 'k',
    workspaceRoot: '/mock/workspace',
    requestApproval: async (req) => {
      approvalPrompted = true
      assert.strictEqual(req.toolName, 'edit_file')
      assert.strictEqual(req.path, 'src/existing.ts')
      return true // User approves
    }
  })

  assert.strictEqual(approvalPrompted, true)
  assert.ok(res.includes('Edit completed successfully.'))
})

await runTest('Plan step transitions to waiting_for_approval and back to running on approval', async () => {
  const stepTransitions = []
  const editTool = new EditFileTool()
  const orchRef = { current: null }

  const provider = createMockProvider([
    { functionCalls: [{ name: 'edit_file', args: { path: 'src/existing.ts', newContent: 'new code' } }] },
    { text: 'Done.' }
  ])

  const orch = new AgentOrchestrator(provider)
  orchRef.current = orch
  orch.registerTool(editTool)

  await orch.run('Edit src/existing.ts and verify', {
    apiKey: 'k',
    workspaceRoot: '/mock/workspace',
    requestApproval: async () => {
      const plan = orchRef.current.getAgentPlanner().getActivePlan()
      const step = plan.steps.find((s) => s.toolName === 'edit_file')
      stepTransitions.push(step?.status) // should be waiting_for_approval
      return true
    }
  })

  assert.deepStrictEqual(stepTransitions, ['waiting_for_approval'])
})

await runTest('User rejection halts execution, aborts plan, and records rejection reason', async () => {
  const editTool = new EditFileTool()

  const provider = createMockProvider([
    { functionCalls: [{ name: 'edit_file', args: { path: 'src/existing.ts', newContent: 'unwanted change' } }] },
    { text: 'Should never run.' }
  ])

  const orch = new AgentOrchestrator(provider)
  orch.registerTool(editTool)

  const res = await orch.run('Edit src/existing.ts and run tests with unwanted change', {
    apiKey: 'k',
    workspaceRoot: '/mock/workspace',
    requestApproval: async () => false // User rejects
  })

  assert.ok(res.includes('rejected'))
  const plan = orch.getAgentPlanner().getActivePlan()
  assert.ok(plan, 'Plan must exist for multi-step prompt')
  assert.strictEqual(plan.status, 'aborted')
  assert.ok(plan.failureReason?.includes('rejected'))
})

await runTest('Approval callback throwing error safely rejects without crashing loop', async () => {
  const editTool = new EditFileTool()

  const provider = createMockProvider([
    { functionCalls: [{ name: 'edit_file', args: { path: 'src/existing.ts', newContent: 'will error in modal' } }] }
  ])

  const orch = new AgentOrchestrator(provider)
  orch.registerTool(editTool)

  const res = await orch.run('Edit src/existing.ts and test throwing in approval', {
    apiKey: 'k',
    workspaceRoot: '/mock/workspace',
    requestApproval: async () => {
      throw new Error('IPC connection to approval modal failed')
    }
  })

  assert.ok(res.includes('rejected'))
  const plan = orch.getAgentPlanner().getActivePlan()
  assert.ok(plan, 'Plan must exist for multi-step prompt')
  assert.strictEqual(plan.status, 'aborted')
})

await runTest('Missing requestApproval in orchestrator options safely halts mutating tools', async () => {
  const editTool = new EditFileTool()

  const provider = createMockProvider([
    { functionCalls: [{ name: 'edit_file', args: { path: 'src/existing.ts', newContent: 'no handler provided' } }] }
  ])

  const orch = new AgentOrchestrator(provider)
  orch.registerTool(editTool)

  const res = await orch.run('Edit src/existing.ts and verify without handler', {
    apiKey: 'k',
    workspaceRoot: '/mock/workspace'
    // requestApproval omitted
  })

  assert.ok(res.includes('rejected') || res.includes('Approval required'))
  const plan = orch.getAgentPlanner().getActivePlan()
  assert.ok(plan, 'Plan must exist for multi-step prompt')
  assert.strictEqual(plan.status, 'aborted')
})

// ============================================================================
// SUITE 5: Stale, Cancelled & Superseded Approval Guards
// ============================================================================
console.log('\n============================================================')
console.log('Suite 5: Stale, Cancelled & Superseded Approval Guards')
console.log('============================================================')

await runTest('Approval resolving true after orchestrator.stop() does NOT authorize execution', async () => {
  const orchRef = { current: null }
  const deferredApproval = createDeferred()
  let executionAttempted = false

  const tool = {
    name: 'custom_mutator',
    description: 'Custom mutator tool',
    parameters: { type: 'object', properties: {} },
    requiresApproval: true,
    execute: async (_args, context) => {
      const isApproved = await context.requestApproval({
        toolName: 'custom_mutator',
        path: '/mock/path'
      })
      if (isApproved) {
        executionAttempted = true
        return { success: true, output: 'Mutated!' }
      }
      return { success: false, rejected: true, output: 'Rejected' }
    }
  }

  const provider = createMockProvider([
    { functionCalls: [{ name: 'custom_mutator', args: {} }] }
  ])

  const orch = new AgentOrchestrator(provider)
  orchRef.current = orch
  orch.registerTool(tool)

  const runPromise = orch.run('Run mutator and cancel while modal open', {
    apiKey: 'k',
    workspaceRoot: '/mock',
    requestApproval: async () => await deferredApproval.promise
  })

  // Give loop a tick to reach approval
  await new Promise((r) => setTimeout(r, 5))

  // User hits stop button
  orch.stop()

  // Sometime later, approval modal somehow resolves true (e.g. late click or bug)
  deferredApproval.resolve(true)

  try {
    await runPromise
  } catch (err) {
    assert.strictEqual(err.message, 'Request was stopped by user.')
  }

  assert.strictEqual(executionAttempted, false, 'Mutating operation must NEVER execute after stop')
})

await runTest('Stale approval from superseded run does NOT authorize execution or mutate newer run', async () => {
  const orchRef = { current: null }
  const run1Approval = createDeferred()
  let run1Mutated = false

  const tool = {
    name: 'custom_tool',
    description: 'Custom tool',
    parameters: { type: 'object', properties: {} },
    requiresApproval: true,
    execute: async (_args, context) => {
      const ok = await context.requestApproval({ toolName: 'custom_tool', path: '/mock' })
      if (ok) run1Mutated = true
      return ok ? { success: true, output: 'ok' } : { success: false, rejected: true, output: 'no' }
    }
  }

  const provider = createMockProvider([
    { functionCalls: [{ name: 'custom_tool', args: {} }] },
    { text: 'Run 2 finished' }
  ])

  const orch = new AgentOrchestrator(provider)
  orchRef.current = orch
  orch.registerTool(tool)

  // Start Run 1
  const run1Promise = orch.run('Run 1', {
    apiKey: 'k',
    workspaceRoot: '/mock',
    requestApproval: async () => await run1Approval.promise
  })

  await new Promise((r) => setTimeout(r, 5))

  // User aborts and starts Run 2
  orch.stop()

  const run2Promise = orch.run('Run 2 with immediate response', {
    apiKey: 'k',
    workspaceRoot: '/mock',
    requestApproval: async () => true
  })

  // Now resolve Run 1's pending approval to true
  run1Approval.resolve(true)

  try { await run1Promise } catch {}
  const res2 = await run2Promise

  assert.strictEqual(run1Mutated, false, 'Stale approval must not authorize tool in superseded run')
  assert.ok(res2.includes('Run 2 finished'))
})

// ============================================================================
// SUITE 6: Multi-Tool Ordering, Independent Approvals & Cascading Halt
// ============================================================================
console.log('\n============================================================')
console.log('Suite 6: Multi-Tool Ordering, Independent Approvals & Cascading Halt')
console.log('============================================================')

await runTest('Multiple approval-required tools in one response require independent approval per tool', async () => {
  const approvalsRequested = []

  const createTool = new CreateFileTool()
  const editTool = new EditFileTool()

  const provider = createMockProvider([
    {
      functionCalls: [
        { name: 'create_file', args: { path: 'src/new1.ts', content: 'const a = 1;' } },
        { name: 'edit_file', args: { path: 'src/existing.ts', newContent: 'const a = 2;' } }
      ]
    },
    { text: 'Both files handled.' }
  ])

  const orch = new AgentOrchestrator(provider)
  orch.registerTool(createTool)
  orch.registerTool(editTool)

  const res = await orch.run('Create new1.ts and edit existing.ts', {
    apiKey: 'k',
    workspaceRoot: '/mock/workspace',
    requestApproval: async (req) => {
      approvalsRequested.push(req.toolName)
      return true
    }
  })

  assert.deepStrictEqual(approvalsRequested, ['create_file', 'edit_file'], 'Every approval-required tool must get its own approval')
  assert.ok(res.includes('Both files handled.'))
})

await runTest('Rejection on first mutating tool stops execution and prevents subsequent mutating tool', async () => {
  const executedTools = []
  const editTool1 = new EditFileTool()
  const runCmdTool = new RunCommandTool()

  const provider = createMockProvider([
    {
      functionCalls: [
        { name: 'edit_file', args: { path: 'src/existing.ts', newContent: 'bad content' } },
        { name: 'run_command', args: { command: 'npm test' } }
      ]
    },
    { text: 'Should not run' }
  ])

  const orch = new AgentOrchestrator(provider)
  orch.registerTool(editTool1)
  orch.registerTool(runCmdTool)

  const res = await orch.run('Edit existing.ts and run tests', {
    apiKey: 'k',
    workspaceRoot: '/mock/workspace',
    requestApproval: async (req) => {
      executedTools.push(req.toolName)
      if (req.toolName === 'edit_file') return false // Reject edit
      return true
    }
  })

  assert.deepStrictEqual(executedTools, ['edit_file'], 'run_command must never be prompted or run after edit rejection')
  assert.ok(res.includes('rejected'))
  const plan = orch.getAgentPlanner().getActivePlan()
  assert.strictEqual(plan.status, 'aborted')
})

await runTest('Cancellation during tool 1 prevents tool 2 from executing', async () => {
  const orchRef = { current: null }
  const executed = []

  const tool1 = {
    name: 'tool_one',
    description: 'First tool',
    parameters: { type: 'object', properties: {} },
    requiresApproval: true,
    execute: async (_args, context) => {
      executed.push('tool_one')
      orchRef.current.stop()
      return { success: true, output: 'done 1' }
    }
  }

  const tool2 = {
    name: 'tool_two',
    description: 'Second tool',
    parameters: { type: 'object', properties: {} },
    requiresApproval: true,
    execute: async () => {
      executed.push('tool_two')
      return { success: true, output: 'done 2' }
    }
  }

  const provider = createMockProvider([
    { functionCalls: [{ name: 'tool_one', args: {} }, { name: 'tool_two', args: {} }] }
  ])

  const orch = new AgentOrchestrator(provider)
  orchRef.current = orch
  orch.registerTool(tool1)
  orch.registerTool(tool2)

  let err = null
  try {
    await orch.run('Run tool 1 and tool 2 with stop', {
      apiKey: 'k',
      workspaceRoot: '/mock',
      requestApproval: async () => true
    })
  } catch (e) {
    err = e
  }

  assert.strictEqual(err?.message, 'Request was stopped by user.')
  assert.deepStrictEqual(executed, ['tool_one'], 'tool_two must never execute')
})

// ============================================================================
// SUITE 7: Approval Payload Parity & Pre-Approval Safety Validation
// ============================================================================
console.log('\n============================================================')
console.log('Suite 7: Approval Payload Parity & Pre-Approval Safety Validation')
console.log('============================================================')

await runTest('CreateFileTool passes exact relative path and content to approval', async () => {
  let approvedPayload = null
  const tool = new CreateFileTool()

  await tool.execute(
    { path: 'src/components/NewCard.tsx', content: 'export const NewCard = () => <div/>;' },
    {
      workspaceRoot: '/mock/workspace',
      requestApproval: async (req) => {
        approvedPayload = req
        return true
      }
    }
  )

  assert.strictEqual(approvedPayload.toolName, 'create_file')
  assert.strictEqual(approvedPayload.path, 'src/components/NewCard.tsx')
  assert.strictEqual(approvedPayload.content, 'export const NewCard = () => <div/>;')
})

await runTest('EditFileTool passes exact oldContent, newContent, and diff preview to approval', async () => {
  electronCalls.readFiles.set('src/existing.ts', 'const x = 1;\nexport default x;')
  let approvedPayload = null
  const tool = new EditFileTool()

  await tool.execute(
    { path: 'src/existing.ts', newContent: 'const x = 99;\nexport default x;' },
    {
      workspaceRoot: '/mock/workspace',
      requestApproval: async (req) => {
        approvedPayload = req
        return true
      }
    }
  )

  assert.strictEqual(approvedPayload.toolName, 'edit_file')
  assert.strictEqual(approvedPayload.path, 'src/existing.ts')
  assert.strictEqual(approvedPayload.oldContent, 'const x = 1;\nexport default x;')
  assert.strictEqual(approvedPayload.newContent, 'const x = 99;\nexport default x;')
})

await runTest('RunCommandTool flags isDangerous for destructive patterns in approval', async () => {
  const recordedFlags = []
  const tool = new RunCommandTool()

  const commands = [
    { cmd: 'npm test', dangerous: false },
    { cmd: 'rm -rf node_modules', dangerous: true },
    { cmd: 'git status', dangerous: false },
    { cmd: 'git clean -fdx', dangerous: true },
    { cmd: 'git reset --hard HEAD', dangerous: true },
    { cmd: 'format C:', dangerous: true }
  ]

  for (const { cmd, dangerous } of commands) {
    await tool.execute(
      { command: cmd },
      {
        workspaceRoot: '/mock/workspace',
        requestApproval: async (req) => {
          recordedFlags.push({ cmd: req.command, isDangerous: req.isDangerous })
          return true
        }
      }
    )
  }

  for (let i = 0; i < commands.length; i++) {
    assert.strictEqual(
      recordedFlags[i].isDangerous,
      commands[i].dangerous,
      `Dangerous flag mismatch for: "${commands[i].cmd}"`
    )
  }
})

await runTest('RunCommandTool performs safety check BEFORE user approval modal is invoked', async () => {
  let approvalPrompted = false
  const tool = new RunCommandTool()

  // Command that attempts directory traversal outside workspace
  const res = await tool.execute(
    { command: 'cd ../../ && rm -rf secret' },
    {
      workspaceRoot: '/mock/workspace',
      requestApproval: async () => {
        approvalPrompted = true
        return true
      }
    }
  )

  assert.strictEqual(approvalPrompted, false, 'Unsafe escaping command must NEVER prompt user for approval')
  assert.strictEqual(res.success, false)
  assert.ok(res.error?.includes('working directory must remain inside'))
})

// ============================================================================
// SUITE 8: Orchestrator Architectural Guardrail Enforcement
// ============================================================================
console.log('\n============================================================')
console.log('Suite 8: Orchestrator Architectural Guardrail Enforcement')
console.log('============================================================')

await runTest('Orchestrator blocks tools declaring requiresApproval: true if approval was bypassed', async () => {
  // A buggy or rogue tool that declares requiresApproval: true but fails to call context.requestApproval
  const rogueTool = {
    name: 'rogue_destructive_tool',
    description: 'Rogue tool that forgets approval',
    parameters: { type: 'object', properties: {} },
    requiresApproval: true,
    execute: async () => {
      // Intentionally DOES NOT call context.requestApproval!
      return { success: true, output: 'I bypassed approval!' }
    }
  }

  const provider = createMockProvider([
    { functionCalls: [{ name: 'rogue_destructive_tool', args: {} }] }
  ])

  const orch = new AgentOrchestrator(provider)
  orch.registerTool(rogueTool)

  const res = await orch.run('Run rogue tool and test outcome', {
    apiKey: 'k',
    workspaceRoot: '/mock',
    requestApproval: async () => true
  })

  // The orchestrator must intercept the unapproved success and convert it to a security violation rejection
  assert.ok(res.includes('Security violation'), 'Orchestrator must detect approval bypass')
  assert.ok(res.includes('requires explicit approval but executed without obtaining approval'))

  const plan = orch.getAgentPlanner().getActivePlan()
  assert.ok(plan, 'Plan must exist for multi-step prompt')
  assert.strictEqual(plan.status, 'aborted')
})

console.log('\n============================================================')
console.log('Phase 2 Task 5 Test Execution Summary')
console.log('============================================================')
console.log(`Total Tests Run:  ${totalTests}`)
console.log(`Passed Tests:     ${passedTests}`)
console.log(`Failed Tests:     ${failedTests}`)

if (failedTests === 0) {
  console.log('\nAll Approval Safety & Guardrail tests passed with 100% success rate!')
} else {
  console.error(`\n${failedTests} test(s) failed. Review errors above.`)
  process.exit(1)
}
