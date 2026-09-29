// scratch/test_production_smart_context_engine.mjs
// Transpiles and tests the ACTUAL production SmartContextEngine TypeScript file using esbuild

import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import esbuild from 'esbuild'

const workspaceRoot = 'C:/Users/bhava/Desktop/Ai Ide'

// 1. Build in-memory bundle of the production smartContextEngine.ts
const bundleResult = await esbuild.build({
  entryPoints: ['src/renderer/src/services/agent/smartContextEngine.ts'],
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'browser',
  target: 'es2022',
  external: ['electron', 'lucide-react', 'react', 'react-dom']
})

const bundledCode = bundleResult.outputFiles[0].text
const tempBundlePath = path.resolve('scratch', '_temp_production_smart_context_engine.mjs')
fs.writeFileSync(tempBundlePath, bundledCode, 'utf8')

// 2. Mock environment and Electron API
const mockDiskFiles = new Map([
  [
    'src/renderer/src/services/agent/smartContextEngine.ts',
    fs.readFileSync('src/renderer/src/services/agent/smartContextEngine.ts', 'utf8')
  ],
  [
    'src/renderer/src/services/agent/codebaseIndex.ts',
    fs.readFileSync('src/renderer/src/services/agent/codebaseIndex.ts', 'utf8')
  ],
  [
    'src/renderer/src/services/agent/orchestrator.ts',
    fs.readFileSync('src/renderer/src/services/agent/orchestrator.ts', 'utf8')
  ],
  [
    'src/renderer/src/services/ai/opencodeProvider.ts',
    fs.readFileSync('src/renderer/src/services/ai/opencodeProvider.ts', 'utf8')
  ],
  [
    'src/renderer/src/services/ai/openRouterProvider.ts',
    fs.readFileSync('src/renderer/src/services/ai/openRouterProvider.ts', 'utf8')
  ],
  [
    'src/renderer/src/services/ai/geminiProvider.ts',
    fs.readFileSync('src/renderer/src/services/ai/geminiProvider.ts', 'utf8')
  ],
  [
    'src/renderer/src/components/AIChatPanel.tsx',
    fs.readFileSync('src/renderer/src/components/AIChatPanel.tsx', 'utf8')
  ],
  [
    'src/renderer/src/App.tsx',
    fs.readFileSync('src/renderer/src/App.tsx', 'utf8')
  ],
  [
    'package.json',
    fs.readFileSync('package.json', 'utf8')
  ]
])

function buildTree(paths) {
  return paths.map((p) => ({
    name: p.split('/').pop(),
    path: path.join(workspaceRoot, p),
    isDirectory: false
  }))
}

globalThis.window = {
  electronAPI: {
    readTree: async () => ({
      success: true,
      tree: buildTree(Array.from(mockDiskFiles.keys()))
    }),
    readWorkspaceFile: async (_root, relPath) => {
      const norm = relPath.replace(/\\/g, '/')
      if (mockDiskFiles.has(norm)) {
        return { success: true, content: mockDiskFiles.get(norm) }
      }
      return { success: false, error: 'File not found' }
    }
  }
}

// 3. Import the compiled production module
const { SmartContextEngine } = await import('./_temp_production_smart_context_engine.mjs')

console.log('===========================================================')
console.log('TESTING REAL PRODUCTION SMART CONTEXT ENGINE CLASS')
console.log('===========================================================')

const engine = new SmartContextEngine()

// TEST 1: The exact user prompt for single file isolation
console.log('\n[Test 1] Explicit single-file isolation on production SmartContextEngine:')
const exactPrompt = 'Explain only the file `src/renderer/src/services/agent/smartContextEngine.ts`. Do not inspect, read, or use any other project file. Do not modify any files.'
console.log(`Prompt: "${exactPrompt}"`)

const res1 = await engine.resolveContext(exactPrompt, workspaceRoot)
const diag1 = engine.getLastDiagnostics()

assert.strictEqual(diag1.required, true, 'required should be true')
assert.strictEqual(diag1.selectedFiles.length, 1, 'selectedFiles count must be exactly 1')
assert.strictEqual(diag1.selectedFiles[0].path, 'src/renderer/src/services/agent/smartContextEngine.ts')
assert.strictEqual(diag1.readFiles.length, 1, 'readFiles count must be exactly 1')
assert.strictEqual(diag1.readFiles[0].path, 'src/renderer/src/services/agent/smartContextEngine.ts')
assert.deepStrictEqual(diag1.formattedContextFileList, ['src/renderer/src/services/agent/smartContextEngine.ts'])

assert.strictEqual(res1.selectedFiles.length, 1)
assert.strictEqual(res1.readFiles.length, 1)
assert.strictEqual(res1.dependencyGraph, null)
assert.strictEqual(res1.dependencyGraphs.length, 0)
assert.strictEqual(res1.symbolReferences.length, 0)
assert.strictEqual(res1.projectSummary, null)

assert.ok(res1.formattedContext.includes('--- File: src/renderer/src/services/agent/smartContextEngine.ts'))
assert.ok(!res1.formattedContext.includes('--- File: src/renderer/src/services/agent/orchestrator.ts ---'))
assert.ok(!res1.formattedContext.includes('--- File: src/renderer/src/App.tsx ---'))
assert.ok(!res1.formattedContext.includes('[Dependency Graph & Impact Analysis]'))
assert.ok(!res1.formattedContext.includes('[Symbol References]'))

console.log('✓ PASS: Production SmartContextEngine selects and reads strictly 1 file for explicit single-file request!')

// TEST 2: Missing explicit single file does not trigger fallback reads
console.log('\n[Test 2] Missing explicit single file on production SmartContextEngine:')
const missingPrompt = 'Explain only the file `src/nonexistent/fakeFile.ts`. Do not inspect, read, or use any other project file. Do not modify any files.'
const res2 = await engine.resolveContext(missingPrompt, workspaceRoot)
const diag2 = engine.getLastDiagnostics()

assert.strictEqual(diag2.selectedFiles.length, 0, 'Missing file must select 0 files')
assert.strictEqual(diag2.readFiles.length, 0, 'Missing file must read 0 files')
assert.strictEqual(diag2.formattedContextFileList.length, 0, 'Missing file formattedContextFileList must be empty')
assert.ok(res2.formattedContext.includes('was not found in workspace'))
assert.ok(!res2.formattedContext.includes('smartContextEngine.ts'), 'Must not fall back to other files')

console.log('✓ PASS: Missing explicit single-file yields 0 selected files, 0 read files, and 0 fallback reads!')

// TEST 3: Normal multi-file request retains multi-file selection & enrichment
console.log('\n[Test 3] Normal query on production SmartContextEngine:')
const normalPrompt = 'Explain the architecture, dependencies, and configuration around codebaseIndex.ts'
const res3 = await engine.resolveContext(normalPrompt, workspaceRoot)
const diag3 = engine.getLastDiagnostics()

assert.ok(diag3.selectedFiles.length > 1, 'Normal query must select multiple candidates')
assert.ok(diag3.readFiles.length > 1, 'Normal query must read multiple candidates')
assert.ok(diag3.formattedContextFileList.length > 1)
assert.ok(res3.formattedContext.includes('[Dependency Graph & Impact Analysis]'))

console.log('✓ PASS: Normal queries retain multi-file selection and dependency enrichment!')

// TEST 4: The exact failing AI request flow prompt
console.log('\n[Test 4] Exact failing AI request flow prompt on production SmartContextEngine:')
const flowPrompt = 'Explain how the AI request flows from the chat UI through the orchestrator to the OpenCode provider. Identify the relevant files.'
console.log(`Prompt: "${flowPrompt}"`)
const res4 = await engine.resolveContext(flowPrompt, workspaceRoot)
const diag4 = engine.getLastDiagnostics()

console.log('- required:', diag4.required)
console.log('- reason:', diag4.reason)
console.log('- selectedFiles:', diag4.selectedFiles.map(f => `${f.path} (score: ${f.score})`))
console.log('- readFiles:', diag4.readFiles.map(f => `${f.path} (source: ${f.source})`))
console.log('- formattedContextFileList:', diag4.formattedContextFileList)

assert.strictEqual(diag4.required, true, 'Request flow prompt must require project context')
assert.ok(diag4.selectedFiles.length >= 3, 'Must select multiple relevant candidates')
assert.ok(diag4.readFiles.length >= 3, 'Must read multiple relevant candidates')
assert.ok(diag4.formattedContextFileList.some(p => p.includes('orchestrator')), 'Must include orchestrator.ts in context')
assert.ok(diag4.formattedContextFileList.some(p => p.includes('AIChatPanel')), 'Must include AIChatPanel.tsx in context')
assert.ok(diag4.formattedContextFileList.some(p => p.includes('opencodeProvider')), 'Must include opencodeProvider.ts in context')

console.log('✓ PASS: Exact AI request flow prompt resolves required=true and pre-injects orchestrator, AIChatPanel, and opencodeProvider!')

// TEST 5: Similar architecture/code-flow prompts
console.log('\n[Test 5] Similar architecture and code-flow prompts:')
const codeFlowPrompts = [
  'How does data flow from the editor to the language server?',
  'Trace the request flow from chat UI through orchestrator to provider',
  'Explain how the orchestrator coordinates tool calls and streaming responses',
  'Which files are relevant to provider switching and settings persistence?',
  'Which files are relevant to authentication?',
  'Identify the relevant files for codebase indexing and file watching',
  'How does the indexer process file change events?',
  'Show the code flow between orchestrator and smartContextEngine',
  'How do AI requests flow through the system?',
  'Trace the execution flow of runCommand tool'
]

for (const p of codeFlowPrompts) {
  const intent = engine.isProjectContextRequired(p, workspaceRoot)
  console.log(`  "${p.slice(0, 48)}...": required=${intent.required} (${intent.reason})`)
  assert.strictEqual(intent.required, true, `Prompt "${p}" must require project context`)
}
console.log('✓ PASS: All 10 architecture and code-flow prompts correctly require project context!')

// TEST 6: General questions MUST NOT require project context
console.log('\n[Test 6] General knowledge questions without project context:')
const generalPrompts = [
  'What is Python?',
  'What is Python? Explain in two simple sentences.',
  'Explain recursion with an example.',
  'How does quicksort work?',
  'What is Docker?',
  'What is a binary search tree?',
  'How does https work?',
  'Write a simple hello world in Rust',
  'Tell me a joke',
  'Hi, how are you?'
]

for (const p of generalPrompts) {
  const intent = engine.isProjectContextRequired(p, workspaceRoot)
  console.log(`  "${p}": required=${intent.required} (${intent.reason})`)
  assert.strictEqual(intent.required, false, `General prompt "${p}" must NOT require project context`)
  const fullRes = await engine.resolveContext(p, workspaceRoot)
  const fullDiag = engine.getLastDiagnostics()
  assert.strictEqual(fullDiag.required, false)
  assert.strictEqual(fullDiag.selectedFiles.length, 0)
  assert.strictEqual(fullDiag.readFiles.length, 0)
  assert.strictEqual(fullDiag.formattedContextFileList.length, 0)
}
console.log('✓ PASS: All 10 general questions correctly return required=false with 0 files selected/read!')

// Clean up temp bundle
try {
  fs.unlinkSync(tempBundlePath)
} catch {}

console.log('\n===========================================================')
console.log('ALL PRODUCTION SMART CONTEXT ENGINE TESTS PASSED! ✓')
console.log('===========================================================')
