// scratch/test_agent_e2e_workflow.mjs
// Phase 2 — Task 9: End-to-End Agent Workflow Reliability Test Suite
//
// Tests:
// Suite 1: Baseline Workflows (Single-Turn & Multi-Step Reading)
// Suite 2: Approval Flow & Safe Execution of Mutating Tools
// Suite 3: Tool Failure Recovery & Adaptive Planning
// Suite 4: Cancellation Boundaries Across All Workflow Stages
// Suite 5: Sequential & Multi-Run Continuity & State Isolation
// Suite 6: UI Reconciliation, Streaming & Lifecycle Cleanup

import assert from 'node:assert'
import esbuild from 'esbuild'

console.log('--- Phase 2 Task 9: End-to-End Agent Workflow Reliability ---')

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

// Track child process commands and stopCommand invocations
let stopCommandCallCount = 0
let executedCommands = []
let workspaceFiles = {
  'src/index.ts': '// Entrypoint\nconsole.log("hello world");\n',
  'src/utils.ts': '// Utilities\nexport function add(a: number, b: number) { return a + b; }\n',
  'package.json': '{\n  "name": "mock-app",\n  "version": "1.0.0"\n}\n'
}

// Setup mock window.electronAPI
globalThis.window = {
  electronAPI: {
    readWorkspaceFile: async (_root, rel) => {
      if (workspaceFiles[rel]) {
        return { success: true, path: rel, content: workspaceFiles[rel] }
      }
      return { success: false, path: rel, error: `File not found: ${rel}` }
    },
    createWorkspaceFile: async (_root, rel, content) => {
      workspaceFiles[rel] = content || ''
      return { success: true, path: rel }
    },
    editWorkspaceFile: async (_root, rel, content) => {
      workspaceFiles[rel] = content
      return { success: true, path: rel }
    },
    runCommand: async (cmd) => {
      executedCommands.push(cmd)
      if (cmd.includes('fail-command')) {
        return { success: false, exitCode: 1, stdout: '', stderr: 'Command failed with exitCode 1', timedOut: false }
      }
      return { success: true, exitCode: 0, stdout: `Executed: ${cmd}`, stderr: '', timedOut: false }
    },
    readTree: async (root) => ({
      success: true,
      rootPath: root,
      tree: [
        { name: 'src', path: `${root}/src`, isDirectory: true, size: 0, mtimeMs: Date.now() },
        { name: 'index.ts', path: `${root}/src/index.ts`, isDirectory: false, size: 50, mtimeMs: Date.now() },
        { name: 'utils.ts', path: `${root}/src/utils.ts`, isDirectory: false, size: 60, mtimeMs: Date.now() },
        { name: 'package.json', path: `${root}/package.json`, isDirectory: false, size: 40, mtimeMs: Date.now() }
      ]
    }),
    listFiles: async (root, _options) => ({
      success: true,
      rootPath: root,
      files: ['src/index.ts', 'src/utils.ts', 'package.json'],
      treeString: '├── src\n│   ├── index.ts\n│   └── utils.ts\n└── package.json'
    }),
    stopCommand: async () => {
      stopCommandCallCount++
      return { success: true }
    }
  }
}

const orchMod = await importFromText(getOutputFile('orchestrator.js'))
const plannerMod = await importFromText(getOutputFile('agentPlanner.js'))
const contextMod = await importFromText(getOutputFile('smartContextEngine.js'))
const readFileMod = await importFromText(getOutputFile('readFileTool.js'))
const listFilesMod = await importFromText(getOutputFile('listFilesTool.js'))
const createFileMod = await importFromText(getOutputFile('createFileTool.js'))
const editFileMod = await importFromText(getOutputFile('editFileTool.js'))
const runCommandMod = await importFromText(getOutputFile('runCommandTool.js'))

const { AgentOrchestrator } = orchMod
const { AgentPlanner } = plannerMod
const { SmartContextEngine } = contextMod
const { ReadFileTool } = readFileMod
const { ListFilesTool } = listFilesMod
const { CreateFileTool } = createFileMod
const { EditFileTool } = editFileMod
const { RunCommandTool } = runCommandMod

// Helper function to register all standard IDE tools on an orchestrator instance
function registerAllStandardTools(orch) {
  orch.registerTool(new ListFilesTool())
  orch.registerTool(new ReadFileTool())
  orch.registerTool(new CreateFileTool())
  orch.registerTool(new EditFileTool())
  orch.registerTool(new RunCommandTool())
}

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

// Test runner helper
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
    console.error(`         Failure: ${err.message}`)
    failedTests++
  }
}

// ============================================================================
// SUITE 1: Baseline Workflows (Single-Turn & Multi-Step Reading)
// ============================================================================
console.log('\n============================================================')
console.log('Suite 1: Baseline Workflows (Single-Turn & Multi-Step Reading)')
console.log('============================================================')

await runTest('Simple prompt answered directly without tool calls or unnecessary plan', async () => {
  let capturedSystemInstruction = ''
  const provider = {
    async sendMessage(_history, _tools, options) {
      capturedSystemInstruction = options.systemInstruction
      options.onChunk?.('React is a popular JavaScript library for building user interfaces.')
      return { text: 'React is a popular JavaScript library for building user interfaces.' }
    }
  }

  const orch = new AgentOrchestrator(provider)
  registerAllStandardTools(orch)

  const steps = []
  const chunks = []
  const result = await orch.run('What is React?', {
    apiKey: 'mock-key',
    workspaceRoot: '/mock/workspace',
    onChunk: (c) => chunks.push(c),
    onStep: (s) => steps.push(s)
  })

  assert.strictEqual(result, 'React is a popular JavaScript library for building user interfaces.')
  assert.strictEqual(chunks.join(''), result)
  assert.strictEqual(orch.agentPlanner.getActivePlan(), null, 'Conceptual prompt should NOT generate a multi-step plan')
  assert.ok(capturedSystemInstruction.includes('Do NOT call any filesystem, terminal, or Git tools'), 'Should instruct model to answer directly')

  const history = orch.getHistory()
  assert.strictEqual(history.length, 2)
  assert.strictEqual(history[0].role, 'user')
  assert.strictEqual(history[1].role, 'model')
  validateHistoryIntegrity(history)
})

await runTest('SmartContext preloads target file and provides context without redundant reads', async () => {
  let modelReceivedPrompt = false
  let systemInstructionReceived = ''

  const provider = {
    async sendMessage(_history, _tools, options) {
      systemInstructionReceived = options.systemInstruction
      modelReceivedPrompt = true
      return { text: 'The entrypoint console logs hello world.' }
    }
  }

  const orch = new AgentOrchestrator(provider)
  registerAllStandardTools(orch)

  // Prime the context engine
  await orch.smartContextEngine.initializeWorkspaceIndex('/mock/workspace')

  const result = await orch.run('Explain what src/index.ts does', {
    apiKey: 'mock-key',
    workspaceRoot: '/mock/workspace'
  })

  assert.ok(modelReceivedPrompt)
  assert.strictEqual(result, 'The entrypoint console logs hello world.')
  assert.ok(systemInstructionReceived.includes('src/index.ts'), 'Preloaded context should contain target file')
  assert.ok(systemInstructionReceived.includes('hello world'), 'Preloaded context should contain file content')

  const history = orch.getHistory()
  validateHistoryIntegrity(history)
})

await runTest('Multi-step task: inspect file via read_file and list_files, then synthesize response', async () => {
  let iteration = 0
  const provider = {
    async sendMessage() {
      iteration++
      if (iteration === 1) {
        return {
          functionCalls: [{ name: 'read_file', args: { path: 'src/utils.ts' } }]
        }
      } else if (iteration === 2) {
        return {
          functionCalls: [{ name: 'list_files', args: { relativePath: 'src' } }]
        }
      }
      return { text: 'Inspection complete: src/utils.ts exports add(a, b) and src contains index.ts and utils.ts.' }
    }
  }

  const orch = new AgentOrchestrator(provider)
  registerAllStandardTools(orch)

  const steps = []
  const result = await orch.run('Implement and test verification for utils', {
    apiKey: 'mock-key',
    workspaceRoot: '/mock/workspace',
    onStep: (s) => steps.push(s)
  })

  assert.strictEqual(result, 'Inspection complete: src/utils.ts exports add(a, b) and src contains index.ts and utils.ts.')
  assert.strictEqual(iteration, 3, 'Expected exactly 3 model iterations')

  const plan = orch.agentPlanner.getActivePlan()
  assert.ok(plan, 'Multi-step task should have an active plan')
  assert.strictEqual(plan.status, 'completed')

  const toolCalls = steps.filter((s) => s.type === 'tool_call')
  const toolResults = steps.filter((s) => s.type === 'tool_result')
  assert.strictEqual(toolCalls.length, 2)
  assert.strictEqual(toolResults.length, 2)
  assert.strictEqual(toolCalls[0].toolName, 'read_file')
  assert.strictEqual(toolCalls[1].toolName, 'list_files')
  assert.strictEqual(toolResults[0].toolSuccess, true)
  assert.strictEqual(toolResults[1].toolSuccess, true)

  const history = orch.getHistory()
  validateHistoryIntegrity(history)
})

// ============================================================================
// SUITE 2: Approval Flow & Safe Execution of Mutating Tools
// ============================================================================
console.log('\n============================================================')
console.log('Suite 2: Approval Flow & Safe Execution of Mutating Tools')
console.log('============================================================')

await runTest('Mutating tool (edit_file) prompts for approval, executes on grant, and tracks modification', async () => {
  let approvalPrompted = false
  let receivedApprovalReq = null
  let iteration = 0

  const provider = {
    async sendMessage() {
      iteration++
      if (iteration === 1) {
        return {
          functionCalls: [
            {
              name: 'edit_file',
              args: { path: 'src/utils.ts', newContent: '// Updated utils\nexport function multiply(a, b) { return a * b; }\n' }
            }
          ]
        }
      }
      return { text: 'Updated src/utils.ts with multiply function.' }
    }
  }

  const orch = new AgentOrchestrator(provider)
  registerAllStandardTools(orch)

  let fileEditedPath = null
  const result = await orch.run('Refactor and verify utils.ts to add multiply', {
    apiKey: 'mock-key',
    workspaceRoot: '/mock/workspace',
    requestApproval: async (req) => {
      approvalPrompted = true
      receivedApprovalReq = req
      return true // Grant approval
    },
    onFileEdited: (p) => {
      fileEditedPath = p
    }
  })

  assert.ok(approvalPrompted, 'Approval should have been prompted')
  assert.strictEqual(receivedApprovalReq.toolName, 'edit_file')
  assert.strictEqual(fileEditedPath, 'src/utils.ts')
  assert.strictEqual(result, 'Updated src/utils.ts with multiply function.')

  const plan = orch.agentPlanner.getActivePlan()
  assert.ok(plan.filesModified.includes('src/utils.ts'), 'Modified file should be tracked in plan')

  const history = orch.getHistory()
  validateHistoryIntegrity(history)
})

await runTest('Mutating tool (run_command) rejected by user halts execution and aborts plan', async () => {
  let approvalPrompted = false
  let iteration = 0

  const provider = {
    async sendMessage() {
      iteration++
      if (iteration === 1) {
        return {
          functionCalls: [{ name: 'run_command', args: { command: 'npm test' } }]
        }
      }
      return { text: 'Should not reach this point' }
    }
  }

  const orch = new AgentOrchestrator(provider)
  registerAllStandardTools(orch)

  const steps = []
  const result = await orch.run('Run tests with command npm test and verify', {
    apiKey: 'mock-key',
    workspaceRoot: '/mock/workspace',
    requestApproval: async () => {
      approvalPrompted = true
      return false // User clicks Reject
    },
    onStep: (s) => steps.push(s)
  })

  assert.ok(approvalPrompted, 'Approval should have been requested')
  assert.ok(result.includes('rejected'), 'Result should state rejection')
  assert.strictEqual(iteration, 1, 'Loop should halt immediately on rejection without further turns')

  const plan = orch.agentPlanner.getActivePlan()
  assert.strictEqual(plan.status, 'aborted')
  assert.ok(plan.failureReason.includes('rejected'))

  const history = orch.getHistory()
  validateHistoryIntegrity(history)
})

await runTest('Dangerous command flagged isDangerous in approval payload before execution', async () => {
  let capturedApprovalReq = null
  const provider = {
    async sendMessage() {
      return {
        functionCalls: [{ name: 'run_command', args: { command: 'rm -rf node_modules' } }]
      }
    }
  }

  const orch = new AgentOrchestrator(provider)
  registerAllStandardTools(orch)

  await orch.run('Clean node_modules with rm -rf', {
    apiKey: 'mock-key',
    workspaceRoot: '/mock/workspace',
    requestApproval: async (req) => {
      capturedApprovalReq = req
      return false // Reject dangerous command
    }
  })

  assert.ok(capturedApprovalReq)
  assert.strictEqual(capturedApprovalReq.isDangerous, true, 'Destructive command must have isDangerous: true')
})

await runTest('Architectural guardrail blocks mutating tool attempting execution without approval', async () => {
  // Mock rogue tool that declares requiresApproval: true but fails to call context.requestApproval
  const rogueTool = {
    name: 'rogue_mutator',
    description: 'Rogue tool',
    parameters: { type: 'object', properties: {} },
    requiresApproval: true,
    async execute() {
      return { success: true, output: 'Rogue modification performed' }
    }
  }

  const provider = {
    async sendMessage() {
      return {
        functionCalls: [{ name: 'rogue_mutator', args: {} }]
      }
    }
  }

  const orch = new AgentOrchestrator(provider)
  orch.registerTool(rogueTool)

  const steps = []
  await orch.run('Run rogue mutator', {
    apiKey: 'mock-key',
    workspaceRoot: '/mock/workspace',
    onStep: (s) => steps.push(s)
  })

  const toolResult = steps.find((s) => s.type === 'tool_result' && s.toolName === 'rogue_mutator')
  assert.ok(toolResult)
  assert.strictEqual(toolResult.toolSuccess, false)
  assert.ok(toolResult.toolOutput.includes('Security violation'))
})

// ============================================================================
// SUITE 3: Tool Failure Recovery & Adaptive Planning
// ============================================================================
console.log('\n============================================================')
console.log('Suite 3: Tool Failure Recovery & Adaptive Planning')
console.log('============================================================')

await runTest('Tool failure on Turn 1 allows model to inspect error and recover on Turn 2', async () => {
  let iteration = 0
  const provider = {
    async sendMessage(history) {
      iteration++
      if (iteration === 1) {
        return {
          functionCalls: [{ name: 'read_file', args: { path: 'nonexistent.ts' } }]
        }
      } else if (iteration === 2) {
        // Model inspects error in history and switches to reading src/index.ts
        const lastFunctionMsg = history[history.length - 1]
        assert.strictEqual(lastFunctionMsg.role, 'function')
        const toolOutput = lastFunctionMsg.parts[0].functionResponse.response.content.output
        assert.ok(toolOutput.includes('File not found') || toolOutput.includes('nonexistent.ts'))

        return {
          functionCalls: [{ name: 'read_file', args: { path: 'src/index.ts' } }]
        }
      }
      return { text: 'Recovered: nonexistent.ts was missing, but src/index.ts was found.' }
    }
  }

  const orch = new AgentOrchestrator(provider)
  registerAllStandardTools(orch)

  const steps = []
  const result = await orch.run('Inspect missing file and recover', {
    apiKey: 'mock-key',
    workspaceRoot: '/mock/workspace',
    onStep: (s) => steps.push(s)
  })

  assert.strictEqual(result, 'Recovered: nonexistent.ts was missing, but src/index.ts was found.')
  assert.strictEqual(iteration, 3)

  const toolResults = steps.filter((s) => s.type === 'tool_result')
  assert.strictEqual(toolResults.length, 2)
  assert.strictEqual(toolResults[0].toolSuccess, false, 'First tool should have failed')
  assert.strictEqual(toolResults[1].toolSuccess, true, 'Second tool should have succeeded')

  const history = orch.getHistory()
  validateHistoryIntegrity(history)
})

await runTest('Repeated identical failing tool calls append mitigation notice to prevent infinite loop', async () => {
  let iteration = 0
  let receivedNoticeInHistory = false

  const provider = {
    async sendMessage(history) {
      iteration++
      if (iteration <= 2) {
        // Model stubbornly retries identical failing command
        return {
          functionCalls: [{ name: 'run_command', args: { command: 'npm run fail-command' } }]
        }
      }
      // Inspect history for mitigation notice
      const lastFuncMsg = history[history.length - 1]
      const output = lastFuncMsg.parts[0].functionResponse.response.content.output
      if (output.includes('identical failing arguments')) {
        receivedNoticeInHistory = true
      }
      return { text: 'Noticed loop mitigation notice and terminated gracefully.' }
    }
  }

  const orch = new AgentOrchestrator(provider)
  registerAllStandardTools(orch)

  const result = await orch.run('Try to run failing command', {
    apiKey: 'mock-key',
    workspaceRoot: '/mock/workspace',
    requestApproval: async () => true
  })

  assert.ok(receivedNoticeInHistory, 'History should contain loop mitigation notice')
  assert.strictEqual(result, 'Noticed loop mitigation notice and terminated gracefully.')
})

// ============================================================================
// SUITE 4: Cancellation Boundaries Across All Workflow Stages
// ============================================================================
console.log('\n============================================================')
console.log('Suite 4: Cancellation Boundaries Across All Workflow Stages')
console.log('============================================================')

await runTest('Cancellation during planning or before Turn 1 provider call immediately aborts', async () => {
  let providerCalled = false
  const provider = {
    async sendMessage() {
      providerCalled = true
      return { text: 'Done' }
    }
  }

  const orch = new AgentOrchestrator(provider)
  registerAllStandardTools(orch)

  const runPromise = orch.run('Refactor and verify src/utils.ts to add multiply', {
    apiKey: 'mock-key',
    workspaceRoot: '/mock/workspace',
    onStep: (step) => {
      if (step.type === 'thinking') {
        orch.stop()
      }
    }
  })

  await assert.rejects(runPromise, /Request was stopped by user/)
  assert.strictEqual(providerCalled, false, 'Provider should never be called when stopped')

  const plan = orch.agentPlanner.getActivePlan()
  assert.ok(plan, 'Plan should be created before Turn 1 thinking')
  assert.strictEqual(plan.status, 'aborted')
})

await runTest('Cancellation during streaming halts loop immediately and suppresses error event', async () => {
  const provider = {
    async sendMessage(_history, _tools, options) {
      options.onChunk?.('Starting stream chunk 1...')
      await new Promise((r) => setTimeout(r, 10))
      options.onChunk?.('Starting stream chunk 2...')
      await new Promise((r) => setTimeout(r, 10))
      return { text: 'Done.' }
    }
  }

  const orch = new AgentOrchestrator(provider)
  const steps = []

  const runPromise = orch.run('Stream test', {
    apiKey: 'mock-key',
    workspaceRoot: '/mock/workspace',
    onStep: (s) => steps.push(s)
  })

  await new Promise((r) => setTimeout(r, 5))
  orch.stop()

  await assert.rejects(runPromise, /Request was stopped by user/)
  const hasErrorStep = steps.some((s) => s.type === 'error')
  assert.strictEqual(hasErrorStep, false, 'User cancellation must NOT emit an error step event')

  const history = orch.getHistory()
  validateHistoryIntegrity(history)
})

await runTest('Cancellation during approval request modal halts run and sanitizes history', async () => {
  let approvalResolver = null
  const provider = {
    async sendMessage() {
      return {
        functionCalls: [{ name: 'create_file', args: { path: 'test.ts', content: 'content' } }]
      }
    }
  }

  const orch = new AgentOrchestrator(provider)
  registerAllStandardTools(orch)

  const runPromise = orch.run('Create test.ts and test', {
    apiKey: 'mock-key',
    workspaceRoot: '/mock/workspace',
    requestApproval: () => {
      return new Promise((resolve) => {
        approvalResolver = resolve
      })
    }
  })

  await new Promise((r) => setTimeout(r, 5))
  orch.stop()
  approvalResolver?.(true)

  await assert.rejects(runPromise, /Request was stopped by user/)
  assert.strictEqual(workspaceFiles['test.ts'], undefined, 'Cancelled file creation must not execute')

  const plan = orch.agentPlanner.getActivePlan()
  assert.strictEqual(plan.status, 'aborted')

  const history = orch.getHistory()
  validateHistoryIntegrity(history)
})

await runTest('Cancellation during active tool execution halts cleanly before subsequent turns', async () => {
  const slowTool = {
    name: 'slow_tool',
    description: 'Slow operation',
    parameters: { type: 'object', properties: {} },
    requiresApproval: false,
    async execute(_args, context) {
      await new Promise((r) => setTimeout(r, 40))
      if (context.signal.aborted) {
        return { success: false, output: 'Cancelled' }
      }
      return { success: true, output: 'Slow operation done' }
    }
  }

  let iteration = 0
  const provider = {
    async sendMessage() {
      iteration++
      return { functionCalls: [{ name: 'slow_tool', args: {} }] }
    }
  }

  const orch = new AgentOrchestrator(provider)
  orch.registerTool(slowTool)

  const runPromise = orch.run('Run slow operation', {
    apiKey: 'mock-key',
    workspaceRoot: '/mock/workspace'
  })

  await new Promise((r) => setTimeout(r, 10))
  orch.stop()

  await assert.rejects(runPromise, /Request was stopped by user/)
  assert.strictEqual(iteration, 1, 'Only 1 turn should have been dispatched')

  const history = orch.getHistory()
  validateHistoryIntegrity(history)
})

// ============================================================================
// SUITE 5: Sequential & Multi-Run Continuity & State Isolation
// ============================================================================
console.log('\n============================================================')
console.log('Suite 5: Sequential & Multi-Run Continuity & State Isolation')
console.log('============================================================')

await runTest('Failed run followed by fresh successful run completes cleanly without 400 or state bleed', async () => {
  let callCount = 0
  const provider = {
    async sendMessage() {
      callCount++
      if (callCount === 1) {
        throw new Error('Connection refused: Remote provider down')
      }
      return { text: 'Run 2 recovered successfully.' }
    }
  }

  const orch = new AgentOrchestrator(provider)

  // Run 1: Fails
  await assert.rejects(
    orch.run('Failing request', { apiKey: 'mock-key', workspaceRoot: '/mock/workspace' }),
    /Connection refused/
  )

  const historyAfterFail = orch.getHistory()
  validateHistoryIntegrity(historyAfterFail)

  // Run 2: Fresh run
  const res2 = await orch.run('Second attempt request', {
    apiKey: 'mock-key',
    workspaceRoot: '/mock/workspace'
  })

  assert.strictEqual(res2, 'Run 2 recovered successfully.')
  const historyAfterSuccess = orch.getHistory()
  validateHistoryIntegrity(historyAfterSuccess)
})

await runTest('Rapidly repeated user submissions: Run 1 cancelled/superseded, Run 2 isolates state', async () => {
  let run1Chunks = []
  let run2Chunks = []

  const provider = {
    async sendMessage(_hist, _tools, options) {
      if (options.modelName === 'run1') {
        for (let i = 0; i < 5; i++) {
          if (options.signal.aborted) break
          options.onChunk?.(`r1_${i} `)
          await new Promise((r) => setTimeout(r, 10))
        }
        return { text: 'r1 done' }
      } else {
        options.onChunk?.('r2 immediate chunk')
        return { text: 'r2 done' }
      }
    }
  }

  const orch = new AgentOrchestrator(provider)

  // Start Run 1
  const run1Promise = orch.run('Prompt 1', {
    apiKey: 'mock-key',
    modelName: 'run1',
    workspaceRoot: '/mock/workspace',
    onChunk: (c) => run1Chunks.push(c)
  })

  // Rapidly stop Run 1 and start Run 2
  await new Promise((r) => setTimeout(r, 5))
  orch.stop()

  const run2Promise = orch.run('Prompt 2', {
    apiKey: 'mock-key',
    modelName: 'run2',
    workspaceRoot: '/mock/workspace',
    onChunk: (c) => run2Chunks.push(c)
  })

  await assert.rejects(run1Promise, /Request was stopped by user/)
  const res2 = await run2Promise

  assert.strictEqual(res2, 'r2 done')
  assert.ok(run2Chunks.includes('r2 immediate chunk'))
  assert.strictEqual(run2Chunks.some((c) => c.includes('r1_')), false, 'Run 2 chunks must NOT be contaminated by Run 1')
})

await runTest('Continuous conversation across 3 turns maintains memory and valid history schema', async () => {
  let turn = 0
  const provider = {
    async sendMessage(history) {
      turn++
      if (turn === 1) {
        return { text: 'My name is Alice.' }
      } else if (turn === 2) {
        const foundAlice = history.some((m) => m.parts.some((p) => p.text?.includes('Alice')))
        assert.ok(foundAlice, 'Turn 2 must remember Alice from history')
        return { text: 'I am 30 years old.' }
      } else {
        const found30 = history.some((m) => m.parts.some((p) => p.text?.includes('30')))
        assert.ok(found30, 'Turn 3 must remember 30 from history')
        return { text: 'You are Alice, 30 years old.' }
      }
    }
  }

  const orch = new AgentOrchestrator(provider)

  await orch.run('What is your name?', { apiKey: 'k', workspaceRoot: '/mock/workspace' })
  await orch.run('How old are you?', { apiKey: 'k', workspaceRoot: '/mock/workspace' })
  const finalSummary = await orch.run('Who are you?', { apiKey: 'k', workspaceRoot: '/mock/workspace' })

  assert.strictEqual(finalSummary, 'You are Alice, 30 years old.')
  const history = orch.getHistory()
  assert.strictEqual(history.length, 6, 'Expected 3 user + 3 model turns')
  validateHistoryIntegrity(history)
})

// ============================================================================
// SUITE 6: UI Reconciliation, Streaming & Lifecycle Cleanup
// ============================================================================
console.log('\n============================================================')
console.log('Suite 6: UI Reconciliation, Streaming & Lifecycle Cleanup')
console.log('============================================================')

await runTest('UI simulated message reconciliation: chunks followed by finalResponse do not duplicate text', async () => {
  const provider = {
    async sendMessage(_history, _tools, options) {
      options.onChunk?.('Hello ')
      options.onChunk?.('world!')
      return { text: 'Hello world!' }
    }
  }

  const orch = new AgentOrchestrator(provider)
  let streamed = ''
  const finalRes = await orch.run('Greet', {
    apiKey: 'k',
    workspaceRoot: '/mock/workspace',
    onChunk: (c) => {
      streamed += c
    }
  })

  // Simulate AIChatPanel reconciliation logic
  let reconciled = streamed
  if (!reconciled) {
    reconciled = finalRes
  } else if (finalRes && !reconciled.includes(finalRes) && !finalRes.includes(reconciled)) {
    reconciled = `${reconciled}\n\n${finalRes}`
  } else if (finalRes && finalRes.length > reconciled.length) {
    reconciled = finalRes
  }

  assert.strictEqual(reconciled, 'Hello world!')
})

await runTest('UI simulated retry rollback: uncommitted streamed text is rolled back on retry', async () => {
  const provider = {
    async sendMessage(_history, _tools, options) {
      for (let attempt = 0; attempt <= 1; attempt++) {
        if (attempt === 0) {
          options.onChunk?.('Temporary flawed partial output...')
          options.onRetry?.(1, 1, 5, 'Network glitch')
          await new Promise((r) => setTimeout(r, 5))
          continue
        }
        options.onChunk?.('Clean restored output after retry.')
        return { text: 'Clean restored output after retry.' }
      }
    }
  }

  // Simulate AIChatPanel state
  let uiContent = ''
  let committedLength = 0

  const onChunk = (chunk) => {
    uiContent += chunk
  }

  const onStep = (event) => {
    if (event.type === 'retrying') {
      uiContent = uiContent.slice(0, committedLength)
    } else if (event.type === 'tool_result') {
      committedLength = uiContent.length
    }
  }

  const orch = new AgentOrchestrator(provider)
  const res = await orch.run('Run retry test', {
    apiKey: 'k',
    workspaceRoot: '/mock/workspace',
    onChunk,
    onStep
  })

  assert.strictEqual(res, 'Clean restored output after retry.')
  assert.strictEqual(uiContent, 'Clean restored output after retry.')
})

await runTest('Unmount and stop cleanup halts active controller and executes stopCommand', async () => {
  const initialStopCalls = stopCommandCallCount

  const orch = new AgentOrchestrator({ sendMessage: async () => ({ text: 'ok' }) })
  orch.stop()

  assert.strictEqual(stopCommandCallCount, initialStopCalls + 1, 'stop() must call window.electronAPI.stopCommand()')
  assert.strictEqual(orch.abortController, null)
})

await runTest('Complete history integrity verification across all executed multi-turn workflows', async () => {
  const provider = {
    async sendMessage() {
      return { text: 'Final verification.' }
    }
  }

  const orch = new AgentOrchestrator(provider)
  await orch.run('Verification test prompt', { apiKey: 'k', workspaceRoot: '/mock/workspace' })

  const history = orch.getHistory()
  validateHistoryIntegrity(history)
  assert.strictEqual(history[history.length - 1].role, 'model')
})

// ============================================================================
// Execution Summary
// ============================================================================
console.log('\n============================================================')
console.log('Phase 2 Task 9 Test Execution Summary')
console.log('============================================================')
console.log(`Total Tests Run:  ${totalTests}`)
console.log(`Passed Tests:     ${passedTests}`)
console.log(`Failed Tests:     ${failedTests}`)

if (failedTests > 0) {
  console.error(`\nFAILED: ${failedTests} end-to-end test(s) failed.`)
  process.exit(1)
} else {
  console.log('\nAll End-to-End Agent Workflow Reliability tests passed with 100% success rate!\n')
}
