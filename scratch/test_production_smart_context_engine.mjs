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

// TEST 1: The exact user prompt that previously failed in live testing:
console.log('\n[Test 1] Exact user prompt on production SmartContextEngine:')
const exactPrompt = 'Explain only the file `src/renderer/src/services/agent/smartContextEngine.ts`. Do not inspect, read, or use any other project file. Do not modify any files.'
console.log(`Prompt: "${exactPrompt}"`)

const res1 = await engine.resolveContext(exactPrompt, workspaceRoot)
const diag1 = engine.getLastDiagnostics()

console.log('\nDiagnostics returned by production engine:')
console.log('- required:', diag1.required)
console.log('- selectedFiles count:', diag1.selectedFiles.length, diag1.selectedFiles.map(f => f.path))
console.log('- readFiles count:', diag1.readFiles.length, diag1.readFiles.map(f => f.path))
console.log('- formattedContextFileList:', diag1.formattedContextFileList)
console.log('- dependencyGraph:', res1.dependencyGraph)
console.log('- dependencyGraphs count:', res1.dependencyGraphs?.length)
console.log('- symbolReferences count:', res1.symbolReferences?.length)
console.log('- projectSummary:', res1.projectSummary)

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

console.log('✓ PASS: Production SmartContextEngine selects and reads strictly 1 file for the exact prompt!')

// TEST 2: Missing explicit single file does not trigger fallback reads
console.log('\n[Test 2] Missing explicit single file on production SmartContextEngine:')
const missingPrompt = 'Explain only the file `src/nonexistent/fakeFile.ts`. Do not inspect, read, or use any other project file. Do not modify any files.'
const res2 = await engine.resolveContext(missingPrompt, workspaceRoot)
const diag2 = engine.getLastDiagnostics()

console.log('- selectedFiles count:', diag2.selectedFiles.length)
console.log('- readFiles count:', diag2.readFiles.length)
console.log('- formattedContextFileList:', diag2.formattedContextFileList)
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

console.log('- selectedFiles count:', diag3.selectedFiles.length)
console.log('- readFiles count:', diag3.readFiles.length)
console.log('- formattedContextFileList count:', diag3.formattedContextFileList.length)
assert.ok(diag3.selectedFiles.length > 1, 'Normal query must select multiple candidates')
assert.ok(diag3.readFiles.length > 1, 'Normal query must read multiple candidates')
assert.ok(diag3.formattedContextFileList.length > 1)
assert.ok(res3.formattedContext.includes('[Dependency Graph & Impact Analysis]'))

console.log('✓ PASS: Normal queries retain multi-file selection and dependency enrichment!')

// Clean up temp bundle
try {
  fs.unlinkSync(tempBundlePath)
} catch {}

console.log('\n===========================================================')
console.log('ALL PRODUCTION SMART CONTEXT ENGINE TESTS PASSED! ✓')
console.log('===========================================================')
