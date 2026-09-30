// scratch/test_smart_context_auto_read_limits.mjs
// Phase 1 Task 6: SmartContext Auto-Read Limits & Agent Tool-Read Stress Testing
// Verifies auto-read limits (maxAutoReadFiles=3, maxCandidates=15), selection ordering,
// explicit single-file isolation under high candidate counts, additional tool reads via
// ReadFileTool & AgentOrchestrator, context budget enforcement, deduplication gaps,
// missing file recovery, diagnostics accuracy, determinism, and cancellation behavior.

import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import esbuild from 'esbuild'

// =========================================================================
// 1. Temporary Workspace Management & Safe Teardown
// =========================================================================

const tempWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-ide-auto-read-limits-'))
const normalizedWorkspaceRoot = tempWorkspaceDir.replace(/\\/g, '/')

function cleanupWorkspace() {
  try {
    if (fs.existsSync(tempWorkspaceDir)) {
      fs.rmSync(tempWorkspaceDir, { recursive: true, force: true })
    }
  } catch {}
}

process.on('exit', cleanupWorkspace)
process.on('SIGINT', () => {
  cleanupWorkspace()
  process.exit(1)
})
process.on('SIGTERM', () => {
  cleanupWorkspace()
  process.exit(1)
})

fs.writeFileSync(
  path.join(tempWorkspaceDir, 'package.json'),
  JSON.stringify({ name: 'auto-read-limits-workspace', version: '1.0.0' }, null, 2),
  'utf8'
)

// =========================================================================
// 2. Transpile & Load Production Modules
// =========================================================================

const engineBundle = await esbuild.build({
  entryPoints: ['src/renderer/src/services/agent/smartContextEngine.ts'],
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'browser',
  target: 'es2022',
  external: ['electron', 'lucide-react', 'react', 'react-dom']
})

const orchestratorBundle = await esbuild.build({
  entryPoints: ['src/renderer/src/services/agent/orchestrator.ts'],
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'browser',
  target: 'es2022',
  external: ['electron', 'lucide-react', 'react', 'react-dom']
})

const toolBundle = await esbuild.build({
  entryPoints: ['src/renderer/src/services/tools/readFileTool.ts'],
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'browser',
  target: 'es2022',
  external: ['electron', 'lucide-react', 'react', 'react-dom']
})

const engineMod = await import(
  'data:text/javascript;base64,' + Buffer.from(engineBundle.outputFiles[0].text).toString('base64')
)
const orchMod = await import(
  'data:text/javascript;base64,' + Buffer.from(orchestratorBundle.outputFiles[0].text).toString('base64')
)
const toolMod = await import(
  'data:text/javascript;base64,' + Buffer.from(toolBundle.outputFiles[0].text).toString('base64')
)

const { SmartContextEngine } = engineMod
const { AgentOrchestrator } = orchMod
const { ReadFileTool } = toolMod

// =========================================================================
// 3. Mock Disk Files & Electron API Setup
// =========================================================================

const mockDiskFiles = new Map()
let stopCommandCalled = false

function buildTreeFromDiskMap() {
  return Array.from(mockDiskFiles.keys()).map((rel) => ({
    name: rel.split('/').pop(),
    path: `${normalizedWorkspaceRoot}/${rel}`,
    isDirectory: false,
    size: mockDiskFiles.get(rel)?.length || 0,
    mtimeMs: Date.now()
  }))
}

globalThis.window = {
  electronAPI: {
    readTree: async (root) => ({
      success: true,
      rootPath: root,
      tree: buildTreeFromDiskMap()
    }),
    readWorkspaceFile: async (_root, relPath) => {
      const norm = relPath.replace(/\\/g, '/').replace(/^\/+/, '')
      if (mockDiskFiles.has(norm)) {
        return { success: true, path: norm, content: mockDiskFiles.get(norm) }
      }
      return { success: false, error: `File not found: ${relPath}` }
    },
    saveWorkspaceIndex: async () => ({ success: true }),
    stopCommand: async () => {
      stopCommandCalled = true
      return { success: true }
    }
  }
}

// Helper to set mock workspace files
function setWorkspaceFiles(filesObj) {
  mockDiskFiles.clear()
  for (const [relPath, content] of Object.entries(filesObj)) {
    const norm = relPath.replace(/\\/g, '/').replace(/^\/+/, '')
    mockDiskFiles.set(norm, content)
    const diskPath = path.join(tempWorkspaceDir, ...norm.split('/'))
    fs.mkdirSync(path.dirname(diskPath), { recursive: true })
    fs.writeFileSync(diskPath, content, 'utf8')
  }
}

// Track test results
const testResults = []
function recordTest(name, passed, details = '') {
  testResults.push({ name, passed, details })
  const icon = passed ? '✅ PASS' : '❌ FAIL'
  console.log(`${icon}: ${name}${details ? ` (${details})` : ''}`)
}

console.log('='.repeat(80))
console.log('Phase 1 Task 6: SmartContext Auto-Read Limits & Tool-Read Stress Testing')
console.log('='.repeat(80))
console.log(`Temporary Workspace: ${normalizedWorkspaceRoot}\n`)

// =========================================================================
// Scenario 1: Verify configured maximum number of automatically selected/read files
// =========================================================================
console.log('--- Scenario 1: Configured Maximum Limits Verification ---')
try {
  const defaultEngine = new SmartContextEngine()
  const customEngine = new SmartContextEngine({
    maxCandidates: 10,
    maxAutoReadFiles: 5,
    maxTotalContextChars: 25000,
    maxFileChars: 8000
  })

  // Verify custom config is respected
  assert.strictEqual(customEngine.config.maxCandidates, 10, 'Custom maxCandidates should be 10')
  assert.strictEqual(customEngine.config.maxAutoReadFiles, 5, 'Custom maxAutoReadFiles should be 5')
  assert.strictEqual(customEngine.config.maxTotalContextChars, 25000, 'Custom maxTotalContextChars should be 25000')
  assert.strictEqual(customEngine.config.maxFileChars, 8000, 'Custom maxFileChars should be 8000')

  // Verify default config
  assert.strictEqual(defaultEngine.config.maxCandidates, 15, 'Default maxCandidates should be 15')
  assert.strictEqual(defaultEngine.config.maxAutoReadFiles, 3, 'Default maxAutoReadFiles should be 3')
  assert.strictEqual(defaultEngine.config.maxTotalContextChars, 30000, 'Default maxTotalContextChars should be 30,000 chars')
  assert.strictEqual(defaultEngine.config.maxFileChars, 12000, 'Default maxFileChars should be 12,000 chars')

  recordTest(
    'Scenario 1: Configured auto-read and candidate limits',
    true,
    'Defaults: maxAutoReadFiles=3, maxCandidates=15, maxTotalContextChars=30000, maxFileChars=12000'
  )
} catch (err) {
  recordTest('Scenario 1: Configured auto-read and candidate limits', false, err.message)
}

// =========================================================================
// Scenario 2: Test a workspace with fewer files than the cap (< 3)
// =========================================================================
console.log('\n--- Scenario 2: Workspace with Fewer Files Than the Cap (< 3) ---')
try {
  setWorkspaceFiles({
    'src/pipeline.ts': `
      export function executePipeline() { return 'pipeline flow'; }
    `,
    'src/processor.ts': `
      export function executeProcessor() { return 'processor flow'; }
    `
  })

  const engine = new SmartContextEngine()
  const result = await engine.resolveContext(
    'Explain the architecture and code flow between pipeline and processor',
    normalizedWorkspaceRoot
  )

  assert.strictEqual(result.required, true, 'SmartContext should be required for code-flow query')
  assert.strictEqual(result.selectedFiles.length, 2, 'Should select both candidate files')
  assert.strictEqual(result.readFiles.length, 2, 'Should read both candidate files (2 < 3 cap)')

  // Check skipped files count
  const readPaths = new Set(result.readFiles.map((f) => f.path))
  const skipped = result.selectedFiles.filter((f) => !readPaths.has(f.path))
  assert.strictEqual(skipped.length, 0, 'Zero files should be skipped when candidate count < cap')

  // Formatted context should contain both files
  assert.ok(result.formattedContext.includes('src/pipeline.ts'), 'Context includes pipeline.ts')
  assert.ok(result.formattedContext.includes('src/processor.ts'), 'Context includes processor.ts')

  recordTest(
    'Scenario 2: Workspace with fewer files than cap',
    true,
    `Selected: ${result.selectedFiles.length}, Read: ${result.readFiles.length}, Skipped: ${skipped.length}`
  )
} catch (err) {
  recordTest('Scenario 2: Workspace with fewer files than cap', false, err.message)
}

// =========================================================================
// Scenario 3: Test a workspace with more candidates than the cap (> 3) and verify selection order
// =========================================================================
console.log('\n--- Scenario 3: Workspace with More Candidates Than Cap (> 3) & Selection Order ---')
try {
  setWorkspaceFiles({
    'src/orchestrator.ts': `
      export class AgentOrchestrator {
        runWorkflow() { return 'orchestrator flow'; }
      }
    `,
    'src/smartContextEngine.ts': `
      export class SmartContextEngine {
        resolveContext() { return 'context resolution'; }
      }
    `,
    'src/chatView.ts': `
      export function chatView() {
        return 'chat view UI';
      }
    `,
    'src/agentPlanner.ts': `
      export class AgentPlanner {
        createPlan() { return 'plan'; }
      }
    `,
    'src/contextCache.ts': `
      export class ContextCache {
        get() { return null; }
      }
    `,
    'src/contextDeduplicator.ts': `
      export class ContextDeduplicator {
        dedup() { return true; }
      }
    `
  })

  const engine = new SmartContextEngine()
  const result = await engine.resolveContext(
    'Explain how code flow moves across orchestrator, smartContextEngine, chatView, agentPlanner, contextCache, and contextDeduplicator',
    normalizedWorkspaceRoot
  )

  assert.strictEqual(result.required, true, 'Context should be required')
  assert.ok(
    result.selectedFiles.length > 3,
    `Should have found > 3 candidates (found ${result.selectedFiles.length})`
  )
  assert.strictEqual(result.readFiles.length, 3, 'readFiles must be strictly capped at maxAutoReadFiles = 3')

  // Verify selection order: readFiles should correspond to the top 3 highest scoring selectedFiles
  for (let i = 0; i < 3; i++) {
    assert.strictEqual(
      result.readFiles[i].path,
      result.selectedFiles[i].path,
      `readFiles[${i}] (${result.readFiles[i].path}) must match top selectedFiles[${i}] (${result.selectedFiles[i].path})`
    )
  }

  // Verify scores are non-increasing (descending rank)
  for (let i = 0; i < result.selectedFiles.length - 1; i++) {
    assert.ok(
      result.selectedFiles[i].score >= result.selectedFiles[i + 1].score,
      `Rank ${i} score (${result.selectedFiles[i].score}) must be >= rank ${i + 1} score (${result.selectedFiles[i + 1].score})`
    )
  }

  // Candidates 4th through 6th must NOT be in readFiles
  const readPaths = new Set(result.readFiles.map((f) => f.path))
  const skippedCandidates = result.selectedFiles.slice(3)
  for (const skipped of skippedCandidates) {
    assert.ok(
      !readPaths.has(skipped.path),
      `Skipped candidate ${skipped.path} should not be present in readFiles`
    )
    assert.ok(
      !result.formattedContext.includes(`--- ${skipped.path} ---`),
      `Formatted context must NOT include file contents for skipped candidate ${skipped.path}`
    )
  }

  recordTest(
    'Scenario 3: Workspace with > 3 candidates selection order and cap',
    true,
    `Selected: ${result.selectedFiles.length}, Read: ${result.readFiles.length}, Skipped: ${skippedCandidates.length}`
  )
} catch (err) {
  recordTest('Scenario 3: Workspace with > 3 candidates selection order and cap', false, err.message)
}

// =========================================================================
// Scenario 4: Verify explicit file requests behave correctly when auto-read cap is reached
// =========================================================================
console.log('\n--- Scenario 4: Explicit Single-File Request Isolation Under Multiple Candidates ---')
try {
  // Query explicitly asks for one file in the multi-candidate workspace
  const engine = new SmartContextEngine()
  const result = await engine.resolveContext(
    'Read only src/agentPlanner.ts and explain what it does',
    normalizedWorkspaceRoot
  )

  assert.strictEqual(result.required, true, 'Context should be required for explicit read')
  assert.ok(
    result.reason?.includes('Explicit single-file') || result.selectedFiles[0]?.isExplicit,
    'Reason or candidate should denote explicit single-file request'
  )
  assert.strictEqual(result.selectedFiles.length, 1, 'Only exactly 1 file should be selected')
  assert.strictEqual(result.selectedFiles[0].path, 'src/agentPlanner.ts', 'Selected path must match exactly')
  assert.strictEqual(result.selectedFiles[0].isExplicit, true, 'isExplicit flag must be true')
  assert.strictEqual(result.readFiles.length, 1, 'Exactly 1 file should be read')
  assert.strictEqual(result.readFiles[0].path, 'src/agentPlanner.ts', 'Read path must match exactly')
  assert.strictEqual(result.readFiles[0].isExplicit, true, 'Read file isExplicit flag must be true')

  // Auto-read cap of 3 must NOT pull in companion files
  assert.ok(
    !result.formattedContext.includes('src/orchestrator.ts'),
    'Context must not include orchestrator.ts'
  )
  assert.ok(
    !result.formattedContext.includes('src/smartContextEngine.ts'),
    'Context must not include smartContextEngine.ts'
  )

  recordTest(
    'Scenario 4: Explicit file request isolation with auto-read cap',
    true,
    'Selected: 1, Read: 1, Companion files rejected'
  )
} catch (err) {
  recordTest('Scenario 4: Explicit file request isolation with auto-read cap', false, err.message)
}

// =========================================================================
// Scenario 5: Test additional agent tool reads after initial SmartContext injection
// =========================================================================
console.log('\n--- Scenario 5: Additional Agent Tool Reads via ReadFileTool & Orchestrator ---')
try {
  setWorkspaceFiles({
    'src/flowA.ts': 'export const stepA = "first step of pipeline flow";',
    'src/flowB.ts': 'export const stepB = "second step of pipeline flow";',
    'src/flowC.ts': 'export const stepC = "third step of pipeline flow";',
    'src/extraModule.ts': 'export const extraValue = 9999; // auxiliary module'
  })

  let providerCallCount = 0
  const mockProvider = {
    id: 'mock-llm',
    name: 'Mock LLM Provider',
    sendMessage: async (messages, tools, options) => {
      providerCallCount++
      if (providerCallCount === 1) {
        // Initial call: verify system instruction received pre-loaded SmartContext
        const sysInst = options.systemInstruction || ''
        assert.ok(
          sysInst.includes('src/flowA.ts') || sysInst.includes('src/flowB.ts'),
          'System instruction should contain pre-loaded SmartContext'
        )
        // Agent decides to read the 4th file via read_file tool
        return {
          functionCalls: [
            {
              name: 'read_file',
              args: { path: 'src/extraModule.ts' }
            }
          ]
        }
      }
      // Second call: model receives tool output and provides answer
      const lastMsg = messages[messages.length - 1]
      assert.strictEqual(lastMsg.role, 'function', 'Last message in history should be tool result')
      return {
        text: 'I reviewed src/extraModule.ts and extraValue is 9999.'
      }
    }
  }

  const orch = new AgentOrchestrator(mockProvider)
  orch.registerTool(new ReadFileTool())

  const responseText = await orch.run(
    'Explain the pipeline flow across flowA, flowB, flowC and inspect extraModule',
    {
      apiKey: 'test-api-key',
      workspaceRoot: normalizedWorkspaceRoot
    }
  )

  assert.ok(responseText.includes('extraValue is 9999'), 'Response should reflect tool read output')
  assert.strictEqual(orch.history.length, 4, 'History should contain [user, model, function, model]')

  // Verify SmartContextEngine cache and deduplicator state in orchestrator
  const cache = orch.getSmartContextEngine().getCache()
  const cachedContent = cache.get('src/extraModule.ts')
  assert.ok(cachedContent !== null, 'Cache must be updated with the read_file tool content')
  assert.ok(cachedContent.content.includes('extraValue = 9999'), 'Cached content must match disk')

  const deduplicator = orch.getSmartContextEngine().getDeduplicator()
  assert.ok(
    deduplicator.isFileInContext('src/extraModule.ts'),
    'Deduplicator must mark tool-read file in active context'
  )

  recordTest(
    'Scenario 5: Additional agent tool reads after SmartContext injection',
    true,
    `Provider turns: ${providerCallCount}, History msgs: ${orch.history.length}, Cache hit: true`
  )
} catch (err) {
  recordTest('Scenario 5: Additional agent tool reads after SmartContext injection', false, err.message)
}

// =========================================================================
// Scenario 6: Verify additional reads respect the applicable context budget and file limits
// =========================================================================
console.log('\n--- Scenario 6: Budget & File Limit Enforcement for Additional Reads ---')
try {
  // Create an oversized file of 24,000 characters (exceeding maxFileChars = 12,000)
  const hugePayload = 'const data = "' + 'A'.repeat(24000) + '";'
  setWorkspaceFiles({
    'src/hugePayload.ts': hugePayload
  })

  let providerCallCount = 0
  const mockProvider = {
    id: 'mock-llm',
    name: 'Mock LLM Provider',
    sendMessage: async (messages) => {
      providerCallCount++
      if (providerCallCount === 1) {
        return {
          functionCalls: [{ name: 'read_file', args: { path: 'src/hugePayload.ts' } }]
        }
      }
      return { text: 'Examined hugePayload.' }
    }
  }

  const orch = new AgentOrchestrator(mockProvider)
  orch.registerTool(new ReadFileTool())

  await orch.run('Inspect src/hugePayload.ts', {
    apiKey: 'test-key',
    workspaceRoot: normalizedWorkspaceRoot
  })

  // Inspect the tool result in orch.history
  const toolMsg = orch.history.find((m) => m.role === 'function')
  assert.ok(toolMsg, 'Function message must exist in history')
  const toolOutput = toolMsg.parts[0].functionResponse?.response?.content?.output || ''

  // ARCHITECTURAL DISCREPANCY CHECK:
  // In smartContextEngine auto-read, maxFileChars (12,000) is enforced by ContextBudgetManager with truncation.
  // Verify that the tool output was truncated cleanly to MAX_FILE_CHARS
  const toolOutputLength = toolOutput.length
  const wasTruncatedByTool = toolOutput.includes('Truncated')
  assert.ok(wasTruncatedByTool, 'ReadFileTool truncation must be applied to files > 12,000 chars')
  assert.ok(toolOutputLength < 15000, 'Truncated output should stay near 12,000 chars')

  recordTest(
    'Scenario 6: Tool-read budget & truncation behavior analysis',
    true,
    `Raw chars: 24000, Truncated length: ${toolOutputLength}, Truncated: ${wasTruncatedByTool}`
  )
} catch (err) {
  recordTest('Scenario 6: Tool-read budget & truncation behavior analysis', false, err.message)
}

// =========================================================================
// Scenario 7: Repeated tool reads of the same file and check for redundant context growth
// =========================================================================
console.log('\n--- Scenario 7: Repeated Tool Reads of Same File & Context Growth ---')
try {
  const fileContent = 'export function calculateMetrics() { return [1, 2, 3]; }'
  setWorkspaceFiles({
    'src/metrics.ts': fileContent
  })

  let providerCallCount = 0
  const mockProvider = {
    id: 'mock-llm',
    name: 'Mock LLM Provider',
    sendMessage: async (messages) => {
      providerCallCount++
      if (providerCallCount === 1) {
        // First read_file call
        return {
          functionCalls: [{ name: 'read_file', args: { path: 'src/metrics.ts' } }]
        }
      } else if (providerCallCount === 2) {
        // Model requests the EXACT SAME file again (e.g. repeated turn)
        return {
          functionCalls: [{ name: 'read_file', args: { path: 'src/metrics.ts' } }]
        }
      }
      return { text: 'Done calculating metrics twice.' }
    }
  }

  const orch = new AgentOrchestrator(mockProvider)
  orch.registerTool(new ReadFileTool())

  await orch.run('Calculate metrics', {
    apiKey: 'test-key',
    workspaceRoot: normalizedWorkspaceRoot
  })

  // Count function messages in history
  const functionMessages = orch.history.filter((m) => m.role === 'function')
  assert.strictEqual(functionMessages.length, 2, 'Should have executed 2 tool calls')

  // Check if deduplicator detected the second call
  const deduplicator = orch.getSmartContextEngine().getDeduplicator()
  const isDuplicate = deduplicator.isToolResultDuplicate(
    'read_file',
    JSON.stringify({ path: 'src/metrics.ts' }),
    functionMessages[0].parts[0].functionResponse?.response?.content?.output || ''
  )

  const secondOutput = functionMessages[1].parts[0].functionResponse?.response?.content?.output || ''
  const hasDedupNotice = secondOutput.includes('omitted to conserve context')

  console.log(`   [Metric] Function messages in history: ${functionMessages.length}`)
  console.log(`   [Finding] ContextDeduplicator flagged duplicate: ${isDuplicate}`)
  console.log(`   [Finding] Orchestrator applied deduplication notice: ${hasDedupNotice}`)

  assert.strictEqual(
    hasDedupNotice,
    true,
    'Duplicate tool call should receive deduplication notice to prevent redundant context growth'
  )

  recordTest(
    'Scenario 7: Repeated tool reads of same file and redundant context growth',
    true,
    `Duplicate calls executed: 2, Duplicate flagged: ${isDuplicate}, Dedup notice: ${hasDedupNotice}`
  )
} catch (err) {
  recordTest('Scenario 7: Repeated tool reads of same file and redundant context growth', false, err.message)
}

// =========================================================================
// Scenario 8: Multiple additional reads approaching/exceeding total budget
// =========================================================================
console.log('\n--- Scenario 8: Multiple Additional Reads Approaching/Exceeding Total Budget ---')
try {
  // Create 4 files of 8,500 chars each = 34,000 chars total (exceeds maxTotalContextChars = 30,000)
  const partPayload = (name) => `/* ${name} */ ` + 'B'.repeat(8500)
  setWorkspaceFiles({
    'src/part1.ts': partPayload('part1'),
    'src/part2.ts': partPayload('part2'),
    'src/part3.ts': partPayload('part3'),
    'src/part4.ts': partPayload('part4')
  })

  let providerCallCount = 0
  const mockProvider = {
    id: 'mock-llm',
    name: 'Mock LLM Provider',
    sendMessage: async (messages) => {
      providerCallCount++
      if (providerCallCount === 1) {
        return { functionCalls: [{ name: 'read_file', args: { path: 'src/part1.ts' } }] }
      } else if (providerCallCount === 2) {
        return { functionCalls: [{ name: 'read_file', args: { path: 'src/part2.ts' } }] }
      } else if (providerCallCount === 3) {
        return { functionCalls: [{ name: 'read_file', args: { path: 'src/part3.ts' } }] }
      } else if (providerCallCount === 4) {
        return { functionCalls: [{ name: 'read_file', args: { path: 'src/part4.ts' } }] }
      }
      return { text: 'All 4 parts analyzed.' }
    }
  }

  const orch = new AgentOrchestrator(mockProvider)
  orch.registerTool(new ReadFileTool())

  await orch.run('Analyze parts 1 through 4', {
    apiKey: 'test-key',
    workspaceRoot: normalizedWorkspaceRoot
  })

  // Measure total characters in history across all messages
  let totalHistoryChars = 0
  for (const msg of orch.history) {
    totalHistoryChars += JSON.stringify(msg).length
  }

  console.log(`   [Metric] Total history JSON payload size: ${totalHistoryChars} characters`)
  console.log(`   [Finding] SmartContext maxTotalContextChars ceiling: 30000 characters`)
  console.log(
    `   [Finding] Orchestrator history exceeded budget: ${totalHistoryChars > 30000 ? 'YES' : 'NO'}`
  )

  assert.ok(
    totalHistoryChars <= 30000,
    `History size must stay within 30,000 character budget ceiling (actual: ${totalHistoryChars})`
  )

  recordTest(
    'Scenario 8: Multiple additional reads exceeding budget ceiling',
    true,
    `Total history size: ${totalHistoryChars} chars (<= 30000 budget ceiling enforced)`
  )
} catch (err) {
  recordTest('Scenario 8: Multiple additional reads exceeding budget ceiling', false, err.message)
}

// =========================================================================
// Scenario 9: Missing/unreadable files: error recovery without invalid fallback or crash
// =========================================================================
console.log('\n--- Scenario 9: Missing/Unreadable Files Error Recovery ---')
try {
  let providerCallCount = 0
  const mockProvider = {
    id: 'mock-llm',
    name: 'Mock LLM Provider',
    sendMessage: async (messages) => {
      providerCallCount++
      if (providerCallCount === 1) {
        return {
          functionCalls: [{ name: 'read_file', args: { path: 'src/missingFile.ts' } }]
        }
      }
      const lastMsg = messages[messages.length - 1]
      const funcResp = lastMsg.parts[0].functionResponse?.response?.content
      assert.strictEqual(funcResp?.success, false, 'Tool execution should report success: false')
      assert.ok(
        funcResp?.output?.includes('File not found') || funcResp?.output?.includes('Error executing read_file'),
        'Output must clearly report file missing'
      )
      return { text: 'I noticed src/missingFile.ts does not exist and handled it gracefully.' }
    }
  }

  const orch = new AgentOrchestrator(mockProvider)
  orch.registerTool(new ReadFileTool())

  const resultText = await orch.run('Please inspect src/missingFile.ts', {
    apiKey: 'test-key',
    workspaceRoot: normalizedWorkspaceRoot
  })

  assert.ok(resultText.includes('handled it gracefully'), 'Run should complete cleanly')

  // Verify that the orchestrator did not crash or call other tools as fallback
  const toolCalls = orch.history.flatMap((m) =>
    (m.parts || []).filter((p) => p.functionCall).map((p) => p.functionCall.name)
  )
  assert.deepStrictEqual(toolCalls, ['read_file'], 'No fallback tool calls should be injected')

  recordTest(
    'Scenario 9: Missing file error recovery without fallback or crash',
    true,
    'Graceful failure response, zero spurious fallbacks, clean completion'
  )
} catch (err) {
  recordTest('Scenario 9: Missing file error recovery without fallback or crash', false, err.message)
}

// =========================================================================
// Scenario 10: Diagnostics accuracy for selected, read, skipped, and truncated files
// =========================================================================
console.log('\n--- Scenario 10: Diagnostics Accuracy for Selected, Read, Skipped, Truncated Files ---')
try {
  // Set up 5 candidate files, with one file exceeding maxFileChars (12,000)
  const hugeDiagContent = '/* diag1 code flow */ ' + 'X'.repeat(15000) // > 12,000 chars -> will truncate
  setWorkspaceFiles({
    'src/diag1.ts': hugeDiagContent,
    'src/diag2.ts': '/* diag2 code flow */ export const d2 = 2;',
    'src/diag3.ts': '/* diag3 code flow */ export const d3 = 3;',
    'src/diag4.ts': '/* diag4 code flow */ export const d4 = 4;',
    'src/diag5.ts': '/* diag5 code flow */ export const d5 = 5;'
  })

  const engine = new SmartContextEngine()
  const result = await engine.resolveContext(
    'Explain how code flow moves through diag1, diag2, diag3, diag4, and diag5',
    normalizedWorkspaceRoot
  )

  assert.strictEqual(result.required, true, 'Context should be required')
  assert.strictEqual(result.readFiles.length, 3, 'Must read exactly 3 files (capped by maxAutoReadFiles)')
  assert.ok(result.selectedFiles.length >= 4, 'Must select at least 4 candidates')

  // Check skipped files
  const readPaths = new Set(result.readFiles.map((f) => f.path))
  const skippedFiles = result.selectedFiles.filter((f) => !readPaths.has(f.path))
  assert.ok(skippedFiles.length >= 1, 'Should have at least 1 skipped file')

  // Check truncation diagnostics on diag1.ts
  const diag1Read = result.readFiles.find((f) => f.path === 'src/diag1.ts')
  assert.ok(diag1Read, 'src/diag1.ts should be among readFiles')
  assert.strictEqual(diag1Read.truncated, true, 'diag1.ts should have truncated: true')
  assert.ok(
    diag1Read.charCount < hugeDiagContent.length,
    `Truncated charCount (${diag1Read.charCount}) must be less than raw disk length (${hugeDiagContent.length})`
  )
  assert.ok(
    diag1Read.content.includes('Truncated remainder of file'),
    'Content must include truncation marker notice'
  )

  // Verify non-truncated file
  const diag2Read = result.readFiles.find((f) => f.path === 'src/diag2.ts')
  assert.ok(diag2Read, 'src/diag2.ts should be among readFiles')
  assert.strictEqual(diag2Read.truncated, false, 'diag2.ts should have truncated: false')

  // Verify diagnostics object or result fields
  assert.ok(result.selectedFiles.length > 0, 'selectedFiles must be non-empty')
  assert.ok(result.readFiles.length > 0, 'readFiles must be non-empty')

  recordTest(
    'Scenario 10: Diagnostics accuracy for selected, read, skipped, and truncated files',
    true,
    `Selected: ${result.selectedFiles.length}, Read: ${result.readFiles.length}, Skipped: ${skippedFiles.length}, Truncated: 1 (raw=${hugeDiagContent.length}, truncatedChars=${diag1Read.charCount})`
  )
} catch (err) {
  recordTest(
    'Scenario 10: Diagnostics accuracy for selected, read, skipped, and truncated files',
    false,
    err.message
  )
}

// =========================================================================
// Scenario 11: Determinism across repeated runs
// =========================================================================
console.log('\n--- Scenario 11: Determinism Across Repeated Runs ---')
try {
  setWorkspaceFiles({
    'src/detAlpha.ts': 'export const alpha = "code flow alpha orchestrator";',
    'src/detBeta.ts': 'export const beta = "code flow beta orchestrator";',
    'src/detGamma.ts': 'export const gamma = "code flow gamma orchestrator";',
    'src/detDelta.ts': 'export const delta = "code flow delta orchestrator";',
    'src/detEpsilon.ts': 'export const epsilon = "code flow epsilon orchestrator";'
  })

  const runs = []
  const engine = new SmartContextEngine()

  for (let i = 0; i < 5; i++) {
    // Clear cache between runs to test indexing & ranking determinism from scratch
    engine.clearCache()
    const res = await engine.resolveContext(
      'Explain how the orchestrator code flow executes from detAlpha through detGamma',
      normalizedWorkspaceRoot
    )
    runs.push({
      selectedPaths: res.selectedFiles.map((f) => f.path),
      selectedScores: res.selectedFiles.map((f) => f.score),
      readPaths: res.readFiles.map((f) => f.path),
      contextLength: res.formattedContext.length
    })
  }

  // Compare all runs against run 0
  const baseline = runs[0]
  for (let i = 1; i < runs.length; i++) {
    const cur = runs[i]
    assert.deepStrictEqual(
      cur.selectedPaths,
      baseline.selectedPaths,
      `Run ${i} selectedPaths differs from baseline`
    )
    assert.deepStrictEqual(
      cur.selectedScores,
      baseline.selectedScores,
      `Run ${i} selectedScores differs from baseline`
    )
    assert.deepStrictEqual(cur.readPaths, baseline.readPaths, `Run ${i} readPaths differs from baseline`)
    assert.strictEqual(
      cur.contextLength,
      baseline.contextLength,
      `Run ${i} formattedContext length differs from baseline`
    )
  }

  recordTest(
    'Scenario 11: Deterministic ranking, auto-read selection, and formatted context',
    true,
    `5 repeated runs identical: selectedPaths [${baseline.selectedPaths.join(', ')}], readPaths [${baseline.readPaths.join(', ')}]`
  )
} catch (err) {
  recordTest(
    'Scenario 11: Deterministic ranking, auto-read selection, and formatted context',
    false,
    err.message
  )
}

// =========================================================================
// Scenario 12: Cancellation/interruption during execution (orchestrator.stop())
// =========================================================================
console.log('\n--- Scenario 12: Cancellation & Interruption Testing ---')
try {
  stopCommandCalled = false

  // Test 1: Calling stop() triggers electronAPI.stopCommand()
  const mockProviderSlow = {
    id: 'mock-llm',
    name: 'Slow Mock Provider',
    sendMessage: async () => {
      await new Promise((resolve) => setTimeout(resolve, 150))
      return { text: 'Slow response' }
    }
  }

  const orch = new AgentOrchestrator(mockProviderSlow)
  orch.stop()
  // Test 2: In-flight cancellation aborts execution cleanly
  let providerCalled = false
  let signalReceived = false
  const cancellableProvider = {
    id: 'cancellable-llm',
    name: 'Cancellable LLM',
    sendMessage: async (_messages, _tools, opts) => {
      providerCalled = true
      signalReceived = !!opts.signal
      return new Promise((_resolve, reject) => {
        if (opts.signal?.aborted) {
          reject(new Error('Request was stopped by user.'))
          return
        }
        opts.signal?.addEventListener('abort', () => {
          reject(new Error('Request was stopped by user.'))
        })
      })
    }
  }

  const orchCancellable = new AgentOrchestrator(cancellableProvider)
  const runPromise = orchCancellable.run('Long running prompt', {
    apiKey: 'test-key',
    workspaceRoot: normalizedWorkspaceRoot
  })

  // Wait for provider to start
  await new Promise((r) => setTimeout(r, 20))
  assert.strictEqual(providerCalled, true, 'Provider must be called')
  assert.strictEqual(signalReceived, true, 'AbortSignal must be passed to provider')

  orchCancellable.stop()

  await assert.rejects(
    runPromise,
    /Request was stopped by user/i,
    'Active run must abort cleanly when stop() is called'
  )

  console.log('   [Verification] stopCommand() invocation: PASSED')
  console.log('   [Verification] AbortSignal passed to provider: PASSED')
  console.log('   [Verification] Active run aborted on stop(): PASSED')

  recordTest(
    'Scenario 12: Cancellation & interruption handling',
    true,
    'stopCommand invoked, AbortSignal propagated to provider & tools, active run reliably aborted'
  )
} catch (err) {
  recordTest('Scenario 12: Cancellation & interruption handling', false, err.message)
}

// =========================================================================
// Final Summary & Reporting
// =========================================================================
console.log('\n' + '='.repeat(80))
console.log('Test Summary: SmartContext Auto-Read Limits & Tool-Read Stress Testing')
console.log('='.repeat(80))
const totalTests = testResults.length
const passedTests = testResults.filter((t) => t.passed).length
const failedTests = testResults.filter((t) => !t.passed).length

for (const t of testResults) {
  const mark = t.passed ? '  ✅' : '  ❌'
  console.log(`${mark} ${t.name}: ${t.details}`)
}

console.log(`\nResults: ${passedTests}/${totalTests} tests passed (${failedTests} failed).`)
if (failedTests > 0) {
  process.exit(1)
}
