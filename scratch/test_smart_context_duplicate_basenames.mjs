// scratch/test_smart_context_duplicate_basenames.mjs
// Phase 1 Task 3: Duplicate Filenames and Path Disambiguation Test Suite
// Verifies ambiguous basename handling, explicit path selection, deterministic ranking,
// single-file isolation, and missing explicit path fallback prevention across duplicate basenames.

import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import esbuild from 'esbuild'

// =========================================================================
// 1. Temporary Workspace Management & Safe Teardown
// =========================================================================

const tempWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-ide-smartcontext-duplicates-'))
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

// Write base workspace anchor files
fs.writeFileSync(
  path.join(tempWorkspaceDir, 'package.json'),
  JSON.stringify(
    {
      name: 'duplicate-basenames-test-workspace',
      version: '1.0.0',
      dependencies: {
        typescript: '^5.5.0'
      }
    },
    null,
    2
  ),
  'utf8'
)

fs.writeFileSync(
  path.join(tempWorkspaceDir, 'tsconfig.json'),
  JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        paths: {
          '@/*': ['./src/*'],
          '@shared/*': ['./src/shared/*']
        }
      }
    },
    null,
    2
  ),
  'utf8'
)

// =========================================================================
// 2. Transpile & Load Production SmartContextEngine
// =========================================================================

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
const base64Bundle = Buffer.from(bundledCode).toString('base64')

// Global mock state for window.electronAPI
let currentTree = []
let currentFileMap = new Map()

globalThis.window = {
  electronAPI: {
    readTree: async (root) => {
      return {
        success: true,
        rootPath: root,
        tree: currentTree
      }
    },
    readWorkspaceFile: async (_root, relPath) => {
      const norm = relPath.replace(/\\/g, '/').replace(/^\/+/, '')
      if (currentFileMap.has(norm)) {
        return { success: true, content: currentFileMap.get(norm) }
      }
      return { success: false, error: `File not found: ${relPath}` }
    },
    saveWorkspaceIndex: async () => ({ success: true })
  }
}

const mod = await import('data:text/javascript;base64,' + base64Bundle)
const { SmartContextEngine } = mod

// =========================================================================
// 3. Setup Duplicate Basenames Fixture
// =========================================================================

// Synthetic files with duplicate basenames in multiple tiers
const duplicateFiles = [
  // Manifest files
  {
    path: 'package.json',
    content: fs.readFileSync(path.join(tempWorkspaceDir, 'package.json'), 'utf8')
  },
  {
    path: 'tsconfig.json',
    content: fs.readFileSync(path.join(tempWorkspaceDir, 'tsconfig.json'), 'utf8')
  },

  // Group 1: 5 duplicate `types.ts` files
  {
    path: 'src/renderer/types.ts',
    content: `import { SharedUser } from '@shared/types';\nexport interface RendererConfig {\n  theme: string;\n  user: SharedUser;\n}`
  },
  {
    path: 'src/main/types.ts',
    content: `export interface MainProcessConfig {\n  windowWidth: number;\n  windowHeight: number;\n  isDev: boolean;\n}`
  },
  {
    path: 'src/shared/types.ts',
    content: `export interface SharedUser {\n  id: string;\n  name: string;\n  email: string;\n}\nexport type IPCResponse<T> = { success: boolean; data?: T; error?: string };`
  },
  {
    path: 'packages/core/types.ts',
    content: `export interface CoreEnginePlugin {\n  name: string;\n  version: string;\n  initialize(): Promise<void>;\n}`
  },
  {
    path: 'tests/types.ts',
    content: `export interface MockTestContext {\n  testSuiteId: string;\n  passed: boolean;\n}`
  },

  // Group 2: 4 duplicate `index.ts` files
  {
    path: 'src/renderer/index.ts',
    content: `import { RendererConfig } from './types';\nexport function startRenderer(cfg: RendererConfig) { console.log('Renderer started'); }`
  },
  {
    path: 'src/main/index.ts',
    content: `import { MainProcessConfig } from './types';\nexport function startMain(cfg: MainProcessConfig) { console.log('Main process started'); }`
  },
  {
    path: 'src/preload/index.ts',
    content: `export const preloadBridge = { version: '1.0.0' };`
  },
  {
    path: 'packages/core/index.ts',
    content: `export * from './types';`
  },

  // Group 3: 3 duplicate `utils.ts` files
  {
    path: 'src/renderer/utils.ts',
    content: `export function formatDomId(id: string) { return 'dom_' + id; }`
  },
  {
    path: 'src/main/utils.ts',
    content: `export function sanitizeFilePath(p: string) { return p.replace(/\\\\/g, '/'); }`
  },
  {
    path: 'packages/core/utils.ts',
    content: `export function deepClone<T>(obj: T): T { return JSON.parse(JSON.stringify(obj)); }`
  },

  // Group 4: 2 duplicate `constants.ts` files
  {
    path: 'src/renderer/constants.ts',
    content: `export const UI_MAX_TABS = 10;\nexport const DEFAULT_THEME = 'dark';`
  },
  {
    path: 'src/shared/constants.ts',
    content: `export const DEFAULT_TIMEOUT_MS = 5000;\nexport const PROTOCOL_VERSION = 'v2';`
  },

  // Importer file that depends on src/renderer/types.ts to test dependency graph isolation
  {
    path: 'src/renderer/App.tsx',
    content: `import React from 'react';\nimport { RendererConfig } from './types';\nexport function App(props: { config: RendererConfig }) { return <div>App</div>; }`
  }
]

for (const f of duplicateFiles) {
  currentFileMap.set(f.path, f.content)
}

function buildNestedTree(fileList, rootDir) {
  const root = { children: new Map() }
  for (const f of fileList) {
    const parts = f.path.split('/')
    let curr = root
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]
      if (!curr.children.has(part)) {
        curr.children.set(part, {
          name: part,
          path: rootDir + '/' + parts.slice(0, i + 1).join('/'),
          isDirectory: true,
          children: new Map()
        })
      }
      curr = curr.children.get(part)
    }
    const leaf = parts[parts.length - 1]
    curr.children.set(leaf, {
      name: leaf,
      path: rootDir + '/' + f.path,
      isDirectory: false,
      size: f.content.length,
      mtimeMs: Date.now()
    })
  }
  function toArray(node) {
    const res = []
    for (const [, entry] of node.children) {
      if (entry.isDirectory) {
        res.push({
          name: entry.name,
          path: entry.path,
          isDirectory: true,
          children: toArray(entry)
        })
      } else {
        res.push(entry)
      }
    }
    return res
  }
  return toArray(root)
}

currentTree = buildNestedTree(duplicateFiles, normalizedWorkspaceRoot)
const allWorkspacePaths = duplicateFiles.map((f) => f.path)

console.log('===========================================================================')
console.log('PHASE 1 TASK 3: DUPLICATE FILENAMES & PATH DISAMBIGUATION TEST SUITE')
console.log('===========================================================================')
console.log(`Workspace: ${normalizedWorkspaceRoot}`)
console.log(`Duplicate Basename Groups in Test Workspace:`)
console.log(`  - "types.ts":     src/renderer/types.ts, src/main/types.ts, src/shared/types.ts, packages/core/types.ts, tests/types.ts (5 files)`)
console.log(`  - "index.ts":     src/renderer/index.ts, src/main/index.ts, src/preload/index.ts, packages/core/index.ts (4 files)`)
console.log(`  - "utils.ts":     src/renderer/utils.ts, src/main/utils.ts, packages/core/utils.ts (3 files)`)
console.log(`  - "constants.ts": src/renderer/constants.ts, src/shared/constants.ts (2 files)\n`)

const engine = new SmartContextEngine({ debug: false })

const testResults = []

// =========================================================================
// SCENARIO 1: User asks for an explicit relative path
// =========================================================================
console.log('[Scenario 1] Explicit relative path selection:')

const explicitPathPrompts = [
  {
    target: 'src/renderer/types.ts',
    prompt: 'Explain only the file src/renderer/types.ts'
  },
  {
    target: 'src/main/types.ts',
    prompt: 'Read only src/main/types.ts'
  },
  {
    target: 'src/shared/types.ts',
    prompt: 'Inspect only: src/shared/types.ts'
  },
  {
    target: 'packages/core/types.ts',
    prompt: 'Explain only the file packages/core/types.ts'
  },
  {
    target: 'tests/types.ts',
    prompt: 'Focus only on the file tests/types.ts'
  }
]

for (const exp of explicitPathPrompts) {
  const res = await engine.resolveContext(exp.prompt, normalizedWorkspaceRoot)
  const diag = engine.getLastDiagnostics()

  console.log(`  Prompt: "${exp.prompt}"`)
  console.log(`    Selected (${res.selectedFiles.length}): ${res.selectedFiles.map((f) => f.path).join(', ')}`)
  console.log(`    Read (${res.readFiles.length}): ${res.readFiles.map((f) => f.path).join(', ')}`)

  assert.strictEqual(res.required, true, 'Explicit path must require context')
  assert.strictEqual(res.selectedFiles.length, 1, `Must select strictly 1 file for ${exp.target}`)
  assert.strictEqual(res.selectedFiles[0].path, exp.target, `Selected path must be exactly ${exp.target}`)
  assert.strictEqual(res.readFiles.length, 1, `Must read strictly 1 file for ${exp.target}`)
  assert.strictEqual(res.readFiles[0].path, exp.target, `Read file must be exactly ${exp.target}`)
  assert.strictEqual(diag.formattedContextFileList.length, 1)
  assert.strictEqual(diag.formattedContextFileList[0], exp.target)
  assert.strictEqual(
    res.dependencyGraphs?.length || 0,
    0,
    'Explicit path must not enrich dependencies'
  )
}
console.log('✓ PASS: All 5 explicit relative paths isolated to exact target with zero sibling leakage.\n')
testResults.push({ scenario: '1. Explicit relative path selection', status: 'PASS' })

// =========================================================================
// SCENARIO 2: User asks for an ambiguous naked basename in multiple folders
// =========================================================================
console.log('[Scenario 2] Ambiguous naked basename resolution:')

const ambiguousPrompts = [
  {
    name: 'types.ts',
    prompt: 'Explain only the file types.ts'
  },
  {
    name: 'index.ts',
    prompt: 'Read only index.ts'
  },
  {
    name: 'utils.ts',
    prompt: 'Inspect only utils.ts'
  },
  {
    name: 'constants.ts',
    prompt: 'Focus only on the file constants.ts'
  }
]

const ambiguityObservations = []

for (const amb of ambiguousPrompts) {
  const ranked = engine.rankCandidateFiles(amb.prompt, allWorkspacePaths)
  const res = await engine.resolveContext(amb.prompt, normalizedWorkspaceRoot)

  console.log(`  Prompt: "${amb.prompt}"`)
  console.log(`    Ranked candidates matching "${amb.name}":`)
  for (const r of ranked.filter((c) => c.path.endsWith('/' + amb.name))) {
    console.log(`      * ${r.path} -> Score: ${r.score} (Reason: ${r.matchReason})`)
  }
  console.log(`    Selected (${res.selectedFiles.length}): ${res.selectedFiles.map((f) => f.path).join(', ')}`)
  console.log(`    Read (${res.readFiles.length}): ${res.readFiles.map((f) => f.path).join(', ')}`)

  assert.strictEqual(res.selectedFiles.length, 1, 'Single-file exclusivity must collapse to 1 file')
  assert.strictEqual(res.readFiles.length, 1, 'Must read exactly 1 file')
  assert(
    res.selectedFiles[0].path.endsWith('/' + amb.name),
    `Selected file must end with /${amb.name}`
  )

  ambiguityObservations.push({
    prompt: amb.prompt,
    basename: amb.name,
    resolvedPath: res.selectedFiles[0].path,
    candidateCount: ranked.filter((c) => c.path.endsWith('/' + amb.name)).length,
    scores: ranked
      .filter((c) => c.path.endsWith('/' + amb.name))
      .map((c) => `${c.path}: ${c.score}`)
  })
}
console.log('✓ PASS: Ambiguous basename queries safely collapse to exactly 1 candidate with no crashes.\n')
testResults.push({ scenario: '2. Ambiguous naked basename resolution', status: 'PASS' })

// =========================================================================
// SCENARIO 3: User provides additional directory or module context
// =========================================================================
console.log('[Scenario 3] Path disambiguation with directory/module context:')

const contextualPrompts = [
  {
    description: 'Renderer context for types.ts',
    prompt: 'Explain the renderer types in types.ts',
    expectedTop: 'src/renderer/types.ts',
    mustBeat: ['src/main/types.ts', 'src/shared/types.ts', 'packages/core/types.ts', 'tests/types.ts']
  },
  {
    description: 'Main process context for types.ts',
    prompt: 'Explain the main process configuration in types.ts',
    expectedTop: 'src/main/types.ts',
    mustBeat: ['src/renderer/types.ts', 'packages/core/types.ts', 'tests/types.ts']
  },
  {
    description: 'Shared module context for types.ts',
    prompt: 'How do the shared types work in types.ts?',
    expectedTop: 'src/shared/types.ts',
    mustBeat: ['src/renderer/types.ts', 'src/main/types.ts', 'tests/types.ts']
  },
  {
    description: 'Core package context for types.ts',
    prompt: 'What core plugin types are defined in packages core types.ts?',
    expectedTop: 'packages/core/types.ts',
    mustBeat: ['src/renderer/types.ts', 'src/main/types.ts', 'tests/types.ts']
  },
  {
    description: 'Preload context for index.ts',
    prompt: 'Explain the preload bridge setup in index.ts',
    expectedTop: 'src/preload/index.ts',
    mustBeat: ['src/renderer/index.ts', 'src/main/index.ts', 'packages/core/index.ts']
  },
  {
    description: 'Main process context for index.ts',
    prompt: 'Explain the main process lifecycle in src main index.ts',
    expectedTop: 'src/main/index.ts',
    mustBeat: ['src/renderer/index.ts', 'src/preload/index.ts']
  },
  {
    description: 'Renderer context for utils.ts',
    prompt: 'How does formatDomId utility work in renderer utils.ts?',
    expectedTop: 'src/renderer/utils.ts',
    mustBeat: ['src/main/utils.ts', 'packages/core/utils.ts']
  },
  {
    description: 'Shared context for constants.ts',
    prompt: 'What are the shared protocol constants in constants.ts?',
    expectedTop: 'src/shared/constants.ts',
    mustBeat: ['src/renderer/constants.ts']
  }
]

for (const ctx of contextualPrompts) {
  const ranked = engine.rankCandidateFiles(ctx.prompt, allWorkspacePaths)
  const topCandidate = ranked[0]

  console.log(`  [${ctx.description}] Prompt: "${ctx.prompt}"`)
  console.log(`    Rank #1: ${topCandidate?.path} (Score: ${topCandidate?.score}, Reason: ${topCandidate?.matchReason})`)

  assert(topCandidate, `Must return at least 1 candidate for "${ctx.prompt}"`)
  assert.strictEqual(
    topCandidate.path,
    ctx.expectedTop,
    `Contextual prompt "${ctx.prompt}" must rank ${ctx.expectedTop} as #1, got ${topCandidate.path}`
  )

  const topScore = topCandidate.score
  for (const other of ctx.mustBeat) {
    const otherCandidate = ranked.find((c) => c.path === other)
    const otherScore = otherCandidate ? otherCandidate.score : 0
    assert(
      topScore > otherScore,
      `Expected ${ctx.expectedTop} (score ${topScore}) to outrank ${other} (score ${otherScore})`
    )
  }
}
console.log('✓ PASS: All contextual prompts correctly disambiguate duplicate basenames using directory/token cues.\n')
testResults.push({ scenario: '3. Disambiguation with directory/module context', status: 'PASS' })

// =========================================================================
// SCENARIO 4: Equal relevance tie-breaking determinism across repeated runs
// =========================================================================
console.log('[Scenario 4] Equal relevance determinism across repeated runs:')

// A neutral prompt with zero directory keywords that matches multiple duplicate basenames equally
const neutralPrompts = [
  'Explain types and interfaces',
  'What functions are in utils.ts?',
  'Show the constants file'
]

for (const np of neutralPrompts) {
  console.log(`  Evaluating neutral prompt: "${np}"`)
  const runA = engine.rankCandidateFiles(np, allWorkspacePaths)
  const runB = engine.rankCandidateFiles(np, allWorkspacePaths)
  const runC = engine.rankCandidateFiles(np, allWorkspacePaths)

  assert.strictEqual(runA.length, runB.length, 'Candidate lengths must match')
  assert.strictEqual(runB.length, runC.length, 'Candidate lengths must match')

  for (let i = 0; i < runA.length; i++) {
    assert.strictEqual(
      runA[i].path,
      runB[i].path,
      `Index ${i} path mismatch between runA (${runA[i].path}) and runB (${runB[i].path})`
    )
    assert.strictEqual(
      runB[i].path,
      runC[i].path,
      `Index ${i} path mismatch between runB (${runB[i].path}) and runC (${runC[i].path})`
    )
    assert.strictEqual(runA[i].score, runB[i].score, `Index ${i} score mismatch`)
    assert.strictEqual(runB[i].score, runC[i].score, `Index ${i} score mismatch`)
  }

  console.log(`    ✓ Deterministic ranking verified across 3 runs (${runA.length} candidates, top: ${runA[0]?.path})`)
}
console.log('✓ PASS: Repeated runs with equal-relevance basenames produce 100% deterministic ordering.\n')
testResults.push({ scenario: '4. Equal relevance determinism', status: 'PASS' })

// =========================================================================
// SCENARIO 5: Explicit single-file request must not enrich dependencies or read other files
// =========================================================================
console.log('[Scenario 5] Explicit single-file request with cross-file dependencies:')

// src/renderer/types.ts imports from @shared/types (src/shared/types.ts)
// and is imported by src/renderer/App.tsx
const singleFileWithDepsPrompt = 'Explain only the file src/renderer/types.ts'
const singleDepRes = await engine.resolveContext(singleFileWithDepsPrompt, normalizedWorkspaceRoot)

console.log(`  Prompt: "${singleFileWithDepsPrompt}"`)
console.log(`    Selected (${singleDepRes.selectedFiles.length}): ${singleDepRes.selectedFiles.map((f) => f.path).join(', ')}`)
console.log(`    Read (${singleDepRes.readFiles.length}): ${singleDepRes.readFiles.map((f) => f.path).join(', ')}`)
console.log(`    Dependency graphs count: ${singleDepRes.dependencyGraphs?.length || 0}`)
console.log(`    Formatted context includes secondary "--- File: src/shared/types.ts ---": ${singleDepRes.formattedContext.includes('--- File: src/shared/types.ts ---')}`)
console.log(`    Formatted context includes secondary "--- File: src/renderer/App.tsx ---": ${singleDepRes.formattedContext.includes('--- File: src/renderer/App.tsx ---')}`)

assert.strictEqual(singleDepRes.selectedFiles.length, 1)
assert.strictEqual(singleDepRes.selectedFiles[0].path, 'src/renderer/types.ts')
assert.strictEqual(singleDepRes.readFiles.length, 1)
assert.strictEqual(singleDepRes.readFiles[0].path, 'src/renderer/types.ts')
assert.strictEqual(
  singleDepRes.dependencyGraphs?.length || 0,
  0,
  'Explicit single-file must NOT generate dependency graphs'
)
assert.strictEqual(
  singleDepRes.dependencyGraph,
  null,
  'Explicit single-file primary dependency graph must be null'
)
assert(
  singleDepRes.formattedContext.includes('src/renderer/types.ts'),
  'Context must contain target file header'
)
assert(
  !singleDepRes.formattedContext.includes('--- File: src/shared/types.ts ---'),
  'Context must NOT read or format src/shared/types.ts'
)
assert(
  !singleDepRes.formattedContext.includes('--- File: src/renderer/App.tsx ---'),
  'Context must NOT read or format src/renderer/App.tsx'
)
assert(
  !singleDepRes.formattedContext.includes('[Dependency Graph & Impact Analysis]'),
  'Context must NOT append dependency graph analysis section'
)
console.log('✓ PASS: Explicit single-file request strictly isolates target file and suppresses dependency enrichment.\n')
testResults.push({ scenario: '5. Single-file dependency enrichment suppression', status: 'PASS' })

// =========================================================================
// SCENARIO 6: Missing explicit paths must NOT fall back to another file with same basename
// =========================================================================
console.log('[Scenario 6] Missing explicit path no-fallback behavior with duplicate basenames:')

const missingDuplicatePrompts = [
  {
    target: 'packages/missing_pkg/types.ts',
    prompt: 'Explain only the file packages/missing_pkg/types.ts'
  },
  {
    target: 'src/nonexistent/types.ts',
    prompt: 'Read only src/nonexistent/types.ts'
  },
  {
    target: 'src/missing/index.ts',
    prompt: 'Inspect only: src/missing/index.ts'
  },
  {
    target: 'src/missing/utils.ts',
    prompt: 'Focus only on the file src/missing/utils.ts'
  },
  {
    target: 'src/core/constants.ts',
    prompt: 'Explain only the file src/core/constants.ts'
  }
]

for (const mdp of missingDuplicatePrompts) {
  const res = await engine.resolveContext(mdp.prompt, normalizedWorkspaceRoot)
  const diag = engine.getLastDiagnostics()

  console.log(`  Prompt: "${mdp.prompt}"`)
  console.log(`    Selected (${res.selectedFiles.length}): ${res.selectedFiles.map((f) => f.path).join(', ')}`)
  console.log(`    Read (${res.readFiles.length}): ${res.readFiles.map((f) => f.path).join(', ')}`)
  console.log(`    Formatted Context: "${res.formattedContext.trim()}"`)

  assert.strictEqual(
    res.selectedFiles.length,
    0,
    `Missing explicit path ${mdp.target} must have 0 selected files, but selected: ${res.selectedFiles.map((f) => f.path).join(', ')}`
  )
  assert.strictEqual(
    res.readFiles.length,
    0,
    `Missing explicit path ${mdp.target} must have 0 read files, but read: ${res.readFiles.map((f) => f.path).join(', ')}`
  )
  assert.strictEqual(
    diag.formattedContextFileList.length,
    0,
    `Diagnostics formattedContextFileList must be empty for missing path ${mdp.target}`
  )
  assert(
    res.formattedContext.includes('was not found in workspace'),
    `Formatted context must inform user the file was not found: "${res.formattedContext}"`
  )
  assert(
    !res.formattedContext.includes('--- File:'),
    'Must not format contents of any fallback file'
  )
}
console.log('✓ PASS: Missing explicit paths NEVER fall back to another file with the same basename.\n')
testResults.push({ scenario: '6. Missing explicit path fallback prevention', status: 'PASS' })

// =========================================================================
// SUMMARY REPORT
// =========================================================================

console.log('===========================================================================')
console.log('AMBIGUOUS BASENAME RESOLUTION DETAILS (SCENARIO 2 OBSERVATIONS)')
console.log('===========================================================================')
console.table(
  ambiguityObservations.map((o) => ({
    'Prompt': o.prompt,
    'Basename': o.basename,
    'Resolved File': o.resolvedPath,
    'Candidate Matches': o.candidateCount,
    'Candidate Scores': o.scores.join(' | ')
  }))
)

console.log('\n===========================================================================')
console.log('TEST SUITE SUMMARY')
console.log('===========================================================================')
console.table(testResults)

cleanupWorkspace()

console.log('\n===========================================================================')
console.log('ALL PHASE 1 TASK 3 DUPLICATE BASENAME TESTS PASSED! ✓')
console.log('===========================================================================')
