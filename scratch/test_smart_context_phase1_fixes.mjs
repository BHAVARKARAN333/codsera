// scratch/test_smart_context_phase1_fixes.mjs
// Phase 1 Task 8: Comprehensive Regression Test Suite for Verified Issues
// Tests:
// 1. AgentOrchestrator cancellation lifecycle & AbortSignal propagation
// 2. Tool-result deduplication with concise notice
// 3. ReadFileTool per-file budget truncation (12,000 chars) & Orchestrator history budget ceiling (30,000 chars)
// 4. Concurrent ContextCache read/save race condition protection
// 5. SmartContextEngine deterministic tie-breaking & configuration export

import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import esbuild from 'esbuild'

// 1. Temporary workspace setup
const tempWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-ide-phase1-fixes-'))
const normalizedWorkspaceRoot = tempWorkspaceDir.replace(/\\/g, '/')

function cleanup() {
  try {
    if (fs.existsSync(tempWorkspaceDir)) {
      fs.rmSync(tempWorkspaceDir, { recursive: true, force: true })
    }
  } catch {}
}
process.on('exit', cleanup)
process.on('SIGINT', () => { cleanup(); process.exit(1) })
process.on('SIGTERM', () => { cleanup(); process.exit(1) })

fs.writeFileSync(
  path.join(tempWorkspaceDir, 'package.json'),
  JSON.stringify({ name: 'phase1-fixes-test', version: '1.0.0' }, null, 2),
  'utf8'
)

// 2. Transpile modules with esbuild
const engineBundle = await esbuild.build({
  entryPoints: ['src/renderer/src/services/agent/smartContextEngine.ts'],
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'browser',
  target: 'es2022',
  external: ['electron', 'lucide-react', 'react', 'react-dom']
})

const orchBundle = await esbuild.build({
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
  'data:text/javascript;base64,' + Buffer.from(orchBundle.outputFiles[0].text).toString('base64')
)
const toolMod = await import(
  'data:text/javascript;base64,' + Buffer.from(toolBundle.outputFiles[0].text).toString('base64')
)

const { SmartContextEngine } = engineMod
const { AgentOrchestrator } = orchMod
const { ReadFileTool } = toolMod

// 3. Mock Electron API setup
const mockDiskFiles = new Map()
let stopCommandCalls = 0
let readDelayMs = 0

function buildTree() {
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
      tree: buildTree()
    }),
    readWorkspaceFile: async (_root, relPath) => {
      if (readDelayMs > 0) {
        await new Promise((r) => setTimeout(r, readDelayMs))
      }
      const norm = relPath.replace(/\\/g, '/').replace(/^\/+/, '')
      if (mockDiskFiles.has(norm)) {
        return { success: true, path: norm, content: mockDiskFiles.get(norm) }
      }
      return { success: false, error: `File not found: ${relPath}` }
    },
    saveWorkspaceIndex: async () => ({ success: true }),
    stopCommand: async () => {
      stopCommandCalls++
      return { success: true }
    }
  }
}

console.log('===========================================================================')
console.log('PHASE 1 TASK 8: VERIFIED FIXES & REGRESSION TEST SUITE')
console.log('===========================================================================')
console.log(`Workspace: ${normalizedWorkspaceRoot}\n`)

let totalPassed = 0
let totalFailed = 0

async function test(name, fn) {
  try {
    await fn()
    console.log(`✅ PASS: ${name}`)
    totalPassed++
  } catch (err) {
    console.error(`❌ FAIL: ${name}`)
    console.error(`   ${err.message}`)
    totalFailed++
  }
}

// -------------------------------------------------------------------------
// FIX 1: Agent Cancellation Lifecycle & AbortSignal Propagation
// -------------------------------------------------------------------------

await test('Fix 1A: Calling stop() propagates AbortSignal to provider and aborts in-flight request', async () => {
  let signalReceived = false
  let signalWasAborted = false

  const slowProvider = {
    id: 'slow-provider',
    name: 'Slow Provider',
    sendMessage: async (_messages, _tools, opts) => {
      signalReceived = !!opts.signal
      return new Promise((_resolve, reject) => {
        if (opts.signal?.aborted) {
          signalWasAborted = true
          reject(new Error('Request was stopped by user.'))
          return
        }
        opts.signal?.addEventListener('abort', () => {
          signalWasAborted = true
          reject(new Error('Request was stopped by user.'))
        })
      })
    }
  }

  const orch = new AgentOrchestrator(slowProvider)
  const runPromise = orch.run('Test cancellation during provider call', {
    apiKey: 'key',
    workspaceRoot: normalizedWorkspaceRoot
  })

  await new Promise((r) => setTimeout(r, 20))
  assert.strictEqual(signalReceived, true, 'AbortSignal must be passed to provider')

  orch.stop()

  await assert.rejects(runPromise, /Request was stopped by user/i)
  assert.strictEqual(signalWasAborted, true, 'AbortSignal should transition to aborted')
  assert.strictEqual(stopCommandCalls > 0, true, 'stopCommand IPC must be invoked')
})

await test('Fix 1B: AbortSignal is passed to tool context and stops tool execution', async () => {
  let toolSignalReceived = false
  let toolAborted = false

  const mockTool = {
    name: 'slow_tool',
    description: 'Slow mock tool',
    parameters: { type: 'object', properties: {} },
    execute: async (_args, ctx) => {
      toolSignalReceived = !!ctx.signal
      return new Promise((resolve) => {
        if (ctx.signal?.aborted) {
          toolAborted = true
          resolve({ success: false, output: '', error: 'Tool execution was aborted by user.' })
          return
        }
        ctx.signal?.addEventListener('abort', () => {
          toolAborted = true
          resolve({ success: false, output: '', error: 'Tool execution was aborted by user.' })
        })
      })
    }
  }

  let turn = 0
  const toolCallingProvider = {
    id: 'tool-caller',
    name: 'Tool Caller',
    sendMessage: async () => {
      turn++
      if (turn === 1) {
        return { functionCalls: [{ name: 'slow_tool', args: {} }] }
      }
      return { text: 'Done' }
    }
  }

  const orch = new AgentOrchestrator(toolCallingProvider)
  orch.registerTool(mockTool)

  const runPromise = orch.run('Call slow tool', {
    apiKey: 'key',
    workspaceRoot: normalizedWorkspaceRoot
  })

  await new Promise((r) => setTimeout(r, 30))
  assert.strictEqual(toolSignalReceived, true, 'ToolContext must receive signal')

  orch.stop()

  await assert.rejects(runPromise, /Request was stopped by user/i)
  assert.strictEqual(toolAborted, true, 'Tool must detect abort signal')
})

await test('Fix 1C: Consecutive runs do not suffer from stale run cross-talk', async () => {
  let run1Done = false
  let run2Done = false

  const provider = {
    id: 'multi-run',
    name: 'Multi Run Provider',
    sendMessage: async (msg, _tools, opts) => {
      const isRun1 = msg[msg.length - 1]?.parts[0]?.text?.includes('run1')
      if (isRun1) {
        return new Promise((resolve, reject) => {
          if (opts?.signal?.aborted) {
            reject(new Error('Request was stopped by user.'))
            return
          }
          opts?.signal?.addEventListener('abort', () => {
            reject(new Error('Request was stopped by user.'))
          })
          setTimeout(() => {
            run1Done = true
            resolve({ text: 'Run 1 response' })
          }, 60)
        })
      } else {
        await new Promise((r) => setTimeout(r, 10))
        run2Done = true
        return { text: 'Run 2 response' }
      }
    }
  }

  const orch = new AgentOrchestrator(provider)

  // Start run 1 (slow)
  const p1 = orch.run('run1 prompt', { apiKey: 'key', workspaceRoot: normalizedWorkspaceRoot })

  // Quickly stop and start run 2
  await new Promise((r) => setTimeout(r, 15))
  orch.stop()
  const p2 = orch.run('run2 prompt', { apiKey: 'key', workspaceRoot: normalizedWorkspaceRoot })

  await assert.rejects(p1, /Request was stopped by user/i)
  const res2 = await p2
  assert.strictEqual(res2, 'Run 2 response')
  assert.strictEqual(run2Done, true)
})

// -------------------------------------------------------------------------
// FIX 2: Tool-Result Deduplication
// -------------------------------------------------------------------------

await test('Fix 2: Duplicate tool call receives concise notice; modified call executes normally', async () => {
  mockDiskFiles.set('src/testData.ts', 'export const value = 42;')
  mockDiskFiles.set('package.json', JSON.stringify({ name: 'phase1-fixes-test' }))

  let providerCalls = 0
  const repeatingProvider = {
    id: 'repeater',
    name: 'Repeater',
    sendMessage: async () => {
      providerCalls++
      if (providerCalls === 1) {
        return { functionCalls: [{ name: 'read_file', args: { path: 'src/testData.ts' } }] }
      } else if (providerCalls === 2) {
        // Request exact same file again
        return { functionCalls: [{ name: 'read_file', args: { path: 'src/testData.ts' } }] }
      } else if (providerCalls === 3) {
        // Request different file
        return { functionCalls: [{ name: 'read_file', args: { path: 'package.json' } }] }
      }
      return { text: 'All operations finished.' }
    }
  }

  const orch = new AgentOrchestrator(repeatingProvider)
  orch.registerTool(new ReadFileTool())

  await orch.run('Read files test', { apiKey: 'key', workspaceRoot: normalizedWorkspaceRoot })

  const funcMessages = orch.history.filter((m) => m.role === 'function')
  assert.strictEqual(funcMessages.length, 3, 'Should have 3 function responses')

  const out1 = funcMessages[0].parts[0].functionResponse?.response?.content?.output || ''
  const out2 = funcMessages[1].parts[0].functionResponse?.response?.content?.output || ''
  const out3 = funcMessages[2].parts[0].functionResponse?.response?.content?.output || ''

  assert.ok(out1.includes('value = 42'), 'First call contains actual file content')
  assert.ok(
    out2.includes('omitted to conserve context'),
    'Second identical call is replaced with deduplication notice'
  )
  assert.ok(!out2.includes('value = 42'), 'Second identical call excludes duplicated content')
  assert.ok(out3.includes('phase1-fixes-test'), 'Third call with different path contains file content')
})

// -------------------------------------------------------------------------
// FIX 3: Budget Enforcement on Read-File & History Ceiling
// -------------------------------------------------------------------------

await test('Fix 3A: ReadFileTool truncates file exceeding MAX_FILE_CHARS (12,000)', async () => {
  const largeContent = 'export const BIG = "' + 'Z'.repeat(25000) + '";'
  mockDiskFiles.set('src/largeFile.ts', largeContent)

  const tool = new ReadFileTool()
  const result = await tool.execute({ path: 'src/largeFile.ts' }, { workspaceRoot: normalizedWorkspaceRoot })

  assert.strictEqual(result.success, true)
  const parsed = JSON.parse(result.output)
  assert.strictEqual(parsed.truncated, true)
  assert.strictEqual(parsed.rawChars, largeContent.length)
  assert.ok(parsed.content.includes('Truncated remainder of file'))
  assert.ok(parsed.content.length <= 12100, `Truncated content length ${parsed.content.length} must be near 12,000`)
})

await test('Fix 3B: ReadFileTool preserves untruncated content for files <= 12,000 chars', async () => {
  const normalContent = 'export const EXACT = "' + 'Y'.repeat(500) + '";'
  mockDiskFiles.set('src/normalFile.ts', normalContent)

  const tool = new ReadFileTool()
  const result = await tool.execute({ path: 'src/normalFile.ts' }, { workspaceRoot: normalizedWorkspaceRoot })

  assert.strictEqual(result.success, true)
  const parsed = JSON.parse(result.output)
  assert.strictEqual(parsed.truncated, false)
  assert.strictEqual(parsed.content, normalContent)
})

await test('Fix 3C: AgentOrchestrator history stays within maxTotalContextChars (30,000) ceiling', async () => {
  const chunk = (id) => `/* Chunk ${id} */ ` + 'X'.repeat(8000)
  mockDiskFiles.set('src/c1.ts', chunk(1))
  mockDiskFiles.set('src/c2.ts', chunk(2))
  mockDiskFiles.set('src/c3.ts', chunk(3))
  mockDiskFiles.set('src/c4.ts', chunk(4))

  let turn = 0
  const heavyProvider = {
    id: 'heavy-provider',
    name: 'Heavy Provider',
    sendMessage: async () => {
      turn++
      if (turn <= 4) {
        return { functionCalls: [{ name: 'read_file', args: { path: `src/c${turn}.ts` } }] }
      }
      return { text: 'Done heavy read.' }
    }
  }

  const orch = new AgentOrchestrator(heavyProvider)
  orch.registerTool(new ReadFileTool())

  await orch.run('Read 4 heavy chunks', { apiKey: 'key', workspaceRoot: normalizedWorkspaceRoot })

  let totalHistoryChars = 0
  for (const msg of orch.history) {
    totalHistoryChars += JSON.stringify(msg).length
  }

  assert.ok(
    totalHistoryChars <= 30000,
    `Total history characters ${totalHistoryChars} must stay within 30,000 budget ceiling`
  )
})

// -------------------------------------------------------------------------
// FIX 4: Concurrent Cache Read/Save Race Condition Protection
// -------------------------------------------------------------------------

await test('Fix 4: Monotonic cache versioning prevents slow disk read from overwriting in-flight editor save', async () => {
  const engine = new SmartContextEngine({ watcherBatchDebounceMs: 20 })
  const raceFile = 'src/raceComponent.tsx'
  mockDiskFiles.set(raceFile, 'export const V1 = "FROM_SLOW_DISK";')

  engine.getCache().invalidate(raceFile)
  readDelayMs = 40

  const resolvePromise = engine.resolveContext(`Explain only the file ${raceFile}`, normalizedWorkspaceRoot)

  // During in-flight disk read, editor save occurs with newer content
  await new Promise((r) => setTimeout(r, 10))
  const editorContent = 'export const V2 = "FROM_FRESH_EDITOR_SAVE";'
  engine.handleFileSave(raceFile, editorContent)

  const res = await resolvePromise
  readDelayMs = 0

  const cached = engine.getCache().get(raceFile)

  assert.strictEqual(cached?.content, editorContent, 'Cache must retain newer editor save')
  assert.strictEqual(res.readFiles[0]?.content, editorContent, 'Resolved context must use newer editor save')
  assert.strictEqual(res.readFiles[0]?.source, 'cache', 'Source must be cache')
})

// -------------------------------------------------------------------------
// FIX 5: Deterministic Tie-Breaking & Configuration Export
// -------------------------------------------------------------------------

await test('Fix 5A: SmartContextEngine exports getConfig() and public config', async () => {
  const engine = new SmartContextEngine({ maxCandidates: 12, maxAutoReadFiles: 4 })
  const config = engine.getConfig()

  assert.strictEqual(config.maxCandidates, 12)
  assert.strictEqual(config.maxAutoReadFiles, 4)
  assert.strictEqual(config.maxFileChars, 12000)
  assert.strictEqual(config.maxTotalContextChars, 30000)
  assert.strictEqual(engine.config.maxCandidates, 12)
})

await test('Fix 5B: Secondary alphabetical tie-breaker produces deterministic candidate ordering on tied scores', async () => {
  const engine = new SmartContextEngine()
  const paths = [
    'src/shared/types.ts',
    'src/renderer/types.ts',
    'packages/core/types.ts',
    'src/main/types.ts'
  ]

  const ranked = engine.rankCandidateFiles('types.ts', paths)
  const rankedPaths = ranked.map((r) => r.path)

  // All 4 have equal basename score (1354), alphabetical tie-breaker should sort them:
  // packages/core/types.ts < src/main/types.ts < src/renderer/types.ts < src/shared/types.ts
  assert.deepStrictEqual(rankedPaths, [
    'packages/core/types.ts',
    'src/main/types.ts',
    'src/renderer/types.ts',
    'src/shared/types.ts'
  ])
})

// -------------------------------------------------------------------------
// FIX 6: Filename Tokenization & Trailing Token Matching
// -------------------------------------------------------------------------

await test('Fix 6A: Filename tokenization splits camelCase basenames and strips file extensions', async () => {
  const engine = new SmartContextEngine()

  // 1. With extensions
  assert.deepStrictEqual(
    engine.tokenize('AIChatPanel.tsx'),
    ['ai', 'chat', 'panel'],
    'AIChatPanel.tsx must split into [ai, chat, panel]'
  )
  assert.deepStrictEqual(
    engine.tokenize('commandValidator.ts'),
    ['command', 'validator'],
    'commandValidator.ts must split into [command, validator]'
  )
  assert.deepStrictEqual(
    engine.tokenize('fileExplorer.ts'),
    ['file', 'explorer'],
    'fileExplorer.ts must split into [file, explorer]'
  )

  // 2. Without extensions
  assert.deepStrictEqual(
    engine.tokenize('AIChatPanel'),
    ['ai', 'chat', 'panel'],
    'AIChatPanel must split into [ai, chat, panel]'
  )
  assert.deepStrictEqual(
    engine.tokenize('commandValidator'),
    ['command', 'validator'],
    'commandValidator must split into [command, validator]'
  )
  assert.deepStrictEqual(
    engine.tokenize('fileExplorer'),
    ['file', 'explorer'],
    'fileExplorer must split into [file, explorer]'
  )
})

await test('Fix 6B: Prompts with trailing tokens (e.g. explorer) match target file with deterministic ranking', async () => {
  const engine = new SmartContextEngine()
  const paths = [
    'src/renderer/src/components/fileExplorer.ts',
    'src/renderer/src/components/AIChatPanel.tsx',
    'src/main/commandValidator.ts',
    'src/shared/types.ts'
  ]

  const prompt = 'Where is the explorer tree rendered?'
  const ranked1 = engine.rankCandidateFiles(prompt, paths)
  const ranked2 = engine.rankCandidateFiles(prompt, paths)

  assert.strictEqual(ranked1[0].path, 'src/renderer/src/components/fileExplorer.ts')
  assert.ok(ranked1[0].score >= 40, 'fileExplorer.ts must receive token overlap score')
  assert.ok(ranked1[0].matchReason.includes('matching token'), 'matchReason must denote token overlap')

  // Determinism check
  assert.deepStrictEqual(
    ranked1.map((r) => ({ path: r.path, score: r.score })),
    ranked2.map((r) => ({ path: r.path, score: r.score })),
    'Ranking must be identical across repeated runs'
  )
})

// -------------------------------------------------------------------------
// Summary
// -------------------------------------------------------------------------

console.log('\n===========================================================================')
console.log(`PHASE 1 TASK 10 REGRESSION RESULTS: ${totalPassed} passed, ${totalFailed} failed`)
console.log('===========================================================================')

if (totalFailed > 0) {
  process.exit(1)
}
