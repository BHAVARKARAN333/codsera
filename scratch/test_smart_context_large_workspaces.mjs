// scratch/test_smart_context_large_workspaces.mjs
// Phase 1 Task 2: Large-Workspace Stress Testing for SmartContextEngine
// Measures scalability, ranking latency, resolution duration, memory footprint,
// and determinism across 1,000, 5,000, 10,000, and 25,000 synthetic workspace files.

import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import esbuild from 'esbuild'

// =========================================================================
// 1. Temporary Workspace Management & Safe Teardown
// =========================================================================

const tempWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-ide-smartcontext-stress-'))
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

// Write base workspace anchor files to temp directory
fs.writeFileSync(
  path.join(tempWorkspaceDir, 'package.json'),
  JSON.stringify(
    {
      name: 'large-scale-workspace',
      version: '1.0.0',
      dependencies: {
        react: '^18.3.1',
        'react-dom': '^18.3.1',
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
          '@modules/*': ['./src/modules/*']
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
// 3. Synthetic Workspace Generator
// =========================================================================

function generateSyntheticWorkspace(targetFileCount) {
  const fileMap = new Map()
  const fileEntriesList = []

  // Anchor files with realistic content
  const anchors = [
    {
      relPath: 'package.json',
      content: fs.readFileSync(path.join(tempWorkspaceDir, 'package.json'), 'utf8')
    },
    {
      relPath: 'tsconfig.json',
      content: fs.readFileSync(path.join(tempWorkspaceDir, 'tsconfig.json'), 'utf8')
    },
    {
      relPath: 'src/renderer/src/App.tsx',
      content: `import React from 'react';\nimport { AIChatPanel } from './components/AIChatPanel';\nexport function App() { return <AIChatPanel />; }`
    },
    {
      relPath: 'src/renderer/src/components/AIChatPanel.tsx',
      content: `import React, { useState } from 'react';\nimport { Orchestrator } from '../services/agent/orchestrator';\nexport function AIChatPanel() { const orch = new Orchestrator(); return <div>Chat UI</div>; }`
    },
    {
      relPath: 'src/renderer/src/services/agent/orchestrator.ts',
      content: `import { SmartContextEngine } from './smartContextEngine';\nexport class Orchestrator { constructor() { this.engine = new SmartContextEngine(); } async handleUserMessage(prompt: string) { return this.engine.resolveContext(prompt, 'workspace'); } }`
    },
    {
      relPath: 'src/renderer/src/services/agent/smartContextEngine.ts',
      content: `export class SmartContextEngine { resolveContext(prompt: string) { return { required: true }; } }`
    },
    {
      relPath: 'src/modules/auth/authController.ts',
      content: `import { AuthService } from './authService';\nimport { AuthMiddleware } from './authMiddleware';\nexport class AuthController { constructor(private authService: AuthService) {} login(req, res) { return this.authService.authenticate(req.body); } }`
    },
    {
      relPath: 'src/modules/auth/authService.ts',
      content: `import { UserModel } from '../users/userModel';\nexport class AuthService { authenticate(creds: any) { return { success: true, token: 'jwt-123' }; } }`
    },
    {
      relPath: 'src/modules/auth/authMiddleware.ts',
      content: `export function authMiddleware(req, res, next) { const auth = req.headers['authorization']; if (auth) next(); }`
    },
    {
      relPath: 'src/modules/users/userModel.ts',
      content: `export interface User { id: string; username: string; role: string; }`
    },
    {
      relPath: 'src/modules/users/userService.ts',
      content: `import { User } from './userModel';\nexport class UserService { getUser(id: string): User { return { id, username: 'test', role: 'admin' }; } }`
    },
    {
      relPath: 'src/services/terminal/runCommand.ts',
      content: `export async function runCommand(cmd: string) { return { exitCode: 0, stdout: 'ok' }; }`
    },
    {
      // Oversized file (25,000 characters) to test budget manager truncation limits
      relPath: 'src/modules/data/hugeDataStore.ts',
      content: `export const HUGE_DATA_STORE = {\n` + '  key_val: "val",\n'.repeat(1300) + '};\n'
    }
  ]

  for (const a of anchors) {
    fileMap.set(a.relPath, a.content)
    fileEntriesList.push({
      path: a.relPath,
      size: a.content.length,
      mtimeMs: Date.now()
    })
  }

  const domains = ['analytics', 'billing', 'core', 'dashboard', 'editor', 'feed', 'gateway', 'history', 'infra']
  const subfolders = ['components', 'services', 'utils', 'models', 'controllers', 'hooks', 'views']
  const totalPackages = Math.max(10, Math.floor(targetFileCount / 300))

  for (let i = fileEntriesList.length; i < targetFileCount; i++) {
    const pkgId = i % totalPackages
    const domain = domains[Math.floor(i / totalPackages) % domains.length]
    const subfolder = subfolders[Math.floor(i / (totalPackages * domains.length)) % subfolders.length]
    const featureId = Math.floor(i / (totalPackages * 7))
    const relPath = `packages/pkg_${pkgId}/src/${domain}/${subfolder}/feature_${featureId}_${subfolder.slice(0, -1)}_${i}.ts`

    let content
    if (i % 25 === 0) {
      content = `import { AuthService } from '@/modules/auth/authService';\nexport function helper_${i}() { return new AuthService(); }`
    } else if (i % 15 === 0) {
      content = `export interface Schema_${i} { id: number; timestamp: number; active: boolean; }`
    } else {
      content = `export class Class_${i} { execute() { return ${i} * 2; } }\nexport const CONST_${i} = ${i};`
    }

    fileMap.set(relPath, content)
    fileEntriesList.push({
      path: relPath,
      size: content.length,
      mtimeMs: Date.now()
    })
  }

  // Build hierarchical FileEntry[] tree
  const rootNode = { children: new Map() }
  for (const item of fileEntriesList) {
    const segments = item.path.split('/')
    let current = rootNode
    for (let s = 0; s < segments.length - 1; s++) {
      const seg = segments[s]
      if (!current.children.has(seg)) {
        current.children.set(seg, {
          name: seg,
          path: normalizedWorkspaceRoot + '/' + segments.slice(0, s + 1).join('/'),
          isDirectory: true,
          children: new Map()
        })
      }
      current = current.children.get(seg)
    }
    const leaf = segments[segments.length - 1]
    current.children.set(leaf, {
      name: leaf,
      path: normalizedWorkspaceRoot + '/' + item.path,
      isDirectory: false,
      size: item.size,
      mtimeMs: item.mtimeMs
    })
  }

  function convertNodeToArray(node) {
    const arr = []
    for (const [, entry] of node.children) {
      if (entry.isDirectory) {
        arr.push({
          name: entry.name,
          path: entry.path,
          isDirectory: true,
          children: convertNodeToArray(entry)
        })
      } else {
        arr.push({
          name: entry.name,
          path: entry.path,
          isDirectory: false,
          size: entry.size,
          mtimeMs: entry.mtimeMs
        })
      }
    }
    return arr
  }

  const tree = convertNodeToArray(rootNode)
  return { fileMap, tree, filePaths: Array.from(fileMap.keys()) }
}

// =========================================================================
// 4. Statistical & Memory Measurement Helpers
// =========================================================================

function computeStats(timingsMs) {
  const sorted = [...timingsMs].sort((a, b) => a - b)
  const count = sorted.length
  const sum = sorted.reduce((acc, t) => acc + t, 0)
  const avg = sum / count
  const median =
    count % 2 === 0
      ? (sorted[count / 2 - 1] + sorted[count / 2]) / 2
      : sorted[Math.floor(count / 2)]
  const p95 = sorted[Math.min(count - 1, Math.floor(count * 0.95))]
  const min = sorted[0]
  const max = sorted[count - 1]

  return {
    count,
    avgMs: Number(avg.toFixed(2)),
    medianMs: Number(median.toFixed(2)),
    p95Ms: Number(p95.toFixed(2)),
    minMs: Number(min.toFixed(2)),
    maxMs: Number(max.toFixed(2))
  }
}

function sampleMemory() {
  if (typeof process !== 'undefined' && process.memoryUsage) {
    const mem = process.memoryUsage()
    return {
      heapUsedMb: Number((mem.heapUsed / (1024 * 1024)).toFixed(2)),
      heapTotalMb: Number((mem.heapTotal / (1024 * 1024)).toFixed(2)),
      rssMb: Number((mem.rss / (1024 * 1024)).toFixed(2))
    }
  }
  return { heapUsedMb: 0, heapTotalMb: 0, rssMb: 0 }
}

// =========================================================================
// 5. Stress Testing Suite Execution
// =========================================================================

console.log('===========================================================================')
console.log('PHASE 1 TASK 2: SMART CONTEXT LARGE-WORKSPACE STRESS BENCHMARK')
console.log('===========================================================================')
console.log(`Node Environment: Node ${process.version} (${process.arch})`)
console.log(`Temporary Test Workspace: ${normalizedWorkspaceRoot}`)
console.log('Tested Scales: 1,000 | 5,000 | 10,000 | 25,000 files\n')

const SCALES = [1000, 5000, 10000, 25000]
const resultsByScale = []

const PROMPTS = {
  explicitSingle: 'Explain only the file src/modules/auth/authService.ts',
  codeFlow: 'Explain how user authentication flows through the auth controller and auth service',
  terminalTool: 'How does runCommand tool execute in terminal?',
  missingSingle: 'Explain only src/modules/missing/nonExistentService.ts',
  generalConcept: 'What is Python? Explain in two simple sentences.'
}

const baselineMemory = sampleMemory()

for (const scale of SCALES) {
  console.log(`---------------------------------------------------------------------------`)
  console.log(`[Scale: ${scale.toLocaleString()} Files] Generating synthetic workspace...`)
  const genStart = performance.now()
  const { fileMap, tree, filePaths } = generateSyntheticWorkspace(scale)
  const genDuration = performance.now() - genStart

  currentFileMap = fileMap
  currentTree = tree

  const memAfterGen = sampleMemory()
  console.log(
    `  Generated ${filePaths.length.toLocaleString()} files (${(genDuration).toFixed(1)} ms) | Heap: ${memAfterGen.heapUsedMb} MB (RSS: ${memAfterGen.rssMb} MB)`
  )

  const engine = new SmartContextEngine({ debug: false })

  // -----------------------------------------------------------------------
  // Benchmark 1: Candidate File Ranking (rankCandidateFiles)
  // -----------------------------------------------------------------------
  const rankingTimings = {
    explicitSingle: [],
    codeFlow: [],
    terminalTool: [],
    generalConcept: []
  }

  const RANKING_ITERATIONS = 5

  for (let i = 0; i < RANKING_ITERATIONS; i++) {
    // Explicit single prompt
    const t0 = performance.now()
    engine.rankCandidateFiles(PROMPTS.explicitSingle, filePaths)
    rankingTimings.explicitSingle.push(performance.now() - t0)

    // Code flow prompt
    const t1 = performance.now()
    engine.rankCandidateFiles(PROMPTS.codeFlow, filePaths)
    rankingTimings.codeFlow.push(performance.now() - t1)

    // Terminal prompt
    const t2 = performance.now()
    engine.rankCandidateFiles(PROMPTS.terminalTool, filePaths)
    rankingTimings.terminalTool.push(performance.now() - t2)

    // General prompt
    const t3 = performance.now()
    engine.rankCandidateFiles(PROMPTS.generalConcept, filePaths)
    rankingTimings.generalConcept.push(performance.now() - t3)
  }

  const singleStats = computeStats(rankingTimings.explicitSingle)
  const flowStats = computeStats(rankingTimings.codeFlow)
  const termStats = computeStats(rankingTimings.terminalTool)
  const genStats = computeStats(rankingTimings.generalConcept)

  const compositeAvgRankingMs = Number(
    ((singleStats.avgMs + flowStats.avgMs + termStats.avgMs + genStats.avgMs) / 4).toFixed(2)
  )
  const usPerFile = Number(((compositeAvgRankingMs * 1000) / scale).toFixed(2))

  console.log(`  Candidate File Ranking Duration (${RANKING_ITERATIONS} runs/query):`)
  console.log(`    - Single-file prompt:  Avg ${singleStats.avgMs} ms | Med ${singleStats.medianMs} ms | p95 ${singleStats.p95Ms} ms`)
  console.log(`    - Code-flow prompt:    Avg ${flowStats.avgMs} ms | Med ${flowStats.medianMs} ms | p95 ${flowStats.p95Ms} ms`)
  console.log(`    - Terminal prompt:     Avg ${termStats.avgMs} ms | Med ${termStats.medianMs} ms | p95 ${termStats.p95Ms} ms`)
  console.log(`    - General concept:     Avg ${genStats.avgMs} ms | Med ${genStats.medianMs} ms | p95 ${genStats.p95Ms} ms`)
  console.log(`    - Composite Average:   ${compositeAvgRankingMs} ms (${usPerFile} µs per file)`)

  // -----------------------------------------------------------------------
  // Benchmark 2: End-to-End SmartContext Resolution (resolveContext)
  // -----------------------------------------------------------------------
  // Cold resolution (first call on workspace)
  const tCold0 = performance.now()
  const coldResult = await engine.resolveContext(PROMPTS.codeFlow, normalizedWorkspaceRoot)
  const coldDurationMs = Number((performance.now() - tCold0).toFixed(2))

  // Warm resolution (second call with cached entries)
  const tWarm0 = performance.now()
  const warmResult = await engine.resolveContext(PROMPTS.codeFlow, normalizedWorkspaceRoot)
  const warmDurationMs = Number((performance.now() - tWarm0).toFixed(2))

  console.log(`  SmartContext Resolution Duration (code-flow query):`)
  console.log(`    - Cold resolution (disk read + tree traversal): ${coldDurationMs} ms`)
  console.log(`    - Warm resolution (cache hits):                 ${warmDurationMs} ms`)

  // -----------------------------------------------------------------------
  // Verification 3: Correctness, Isolation, and Truncation at Scale
  // -----------------------------------------------------------------------
  // Check 3A: Explicit single-file isolation at scale
  const singleFileRes = await engine.resolveContext(PROMPTS.explicitSingle, normalizedWorkspaceRoot)
  assert.strictEqual(singleFileRes.required, true)
  assert.strictEqual(
    singleFileRes.selectedFiles.length,
    1,
    `Explicit single-file must select exactly 1 file at ${scale} scale`
  )
  assert.strictEqual(
    singleFileRes.selectedFiles[0].path,
    'src/modules/auth/authService.ts'
  )
  assert.strictEqual(
    singleFileRes.readFiles.length,
    1,
    `Explicit single-file must read exactly 1 file at ${scale} scale`
  )
  assert.strictEqual(
    singleFileRes.readFiles[0].path,
    'src/modules/auth/authService.ts'
  )
  assert.strictEqual(
    singleFileRes.dependencyGraphs?.length || 0,
    0,
    `Explicit single-file must NOT enrich dependency graphs at ${scale} scale`
  )

  // Check 3B: Missing explicit single-file has zero fallback at scale
  const missingFileRes = await engine.resolveContext(PROMPTS.missingSingle, normalizedWorkspaceRoot)
  assert.strictEqual(missingFileRes.required, true)
  assert.strictEqual(missingFileRes.selectedFiles.length, 0, 'Missing file must select 0 files')
  assert.strictEqual(missingFileRes.readFiles.length, 0, 'Missing file must read 0 files')
  assert(
    missingFileRes.formattedContext.includes('was not found in workspace'),
    'Context must indicate requested file was not found'
  )

  // Check 3C: General conceptual query requires false and reads 0 files
  const generalRes = await engine.resolveContext(PROMPTS.generalConcept, normalizedWorkspaceRoot)
  assert.strictEqual(generalRes.required, false, 'General concept query must not require context')
  assert.strictEqual(generalRes.selectedFiles.length, 0)
  assert.strictEqual(generalRes.readFiles.length, 0)

  // Check 3D: Budget truncation for oversized file (hugeDataStore.ts = 25,000 chars)
  const hugePrompt = 'Explain only the file src/modules/data/hugeDataStore.ts'
  const hugeRes = await engine.resolveContext(hugePrompt, normalizedWorkspaceRoot)
  assert.strictEqual(hugeRes.readFiles.length, 1)
  assert.strictEqual(hugeRes.readFiles[0].truncated, true, 'Oversized file must be truncated')
  assert(
    hugeRes.readFiles[0].charCount <= 12100,
    `Truncated file chars (${hugeRes.readFiles[0].charCount}) must be bounded by ~12,000 maxFileChars limit`
  )
  assert(
    hugeRes.readFiles[0].content.includes('[... Truncated remainder of file ...]'),
    'Content must include clean truncation notice'
  )

  // -----------------------------------------------------------------------
  // Verification 4: Determinism Across Repeated Runs
  // -----------------------------------------------------------------------
  const run1 = engine.rankCandidateFiles(PROMPTS.codeFlow, filePaths)
  const run2 = engine.rankCandidateFiles(PROMPTS.codeFlow, filePaths)
  const run3 = engine.rankCandidateFiles(PROMPTS.codeFlow, filePaths)

  assert.strictEqual(run1.length, run2.length, 'Candidate count must match across runs')
  assert.strictEqual(run2.length, run3.length, 'Candidate count must match across runs')
  for (let c = 0; c < run1.length; c++) {
    assert.strictEqual(run1[c].path, run2[c].path, `Candidate ${c} path must match run1 vs run2`)
    assert.strictEqual(run2[c].path, run3[c].path, `Candidate ${c} path must match run2 vs run3`)
    assert.strictEqual(run1[c].score, run2[c].score, `Candidate ${c} score must match run1 vs run2`)
    assert.strictEqual(run2[c].score, run3[c].score, `Candidate ${c} score must match run2 vs run3`)
  }
  console.log('    ✓ Correctness, single-file isolation, no-fallback, budget truncation, and determinism verified.')

  const memEnd = sampleMemory()
  resultsByScale.push({
    scale,
    compositeAvgRankingMs,
    usPerFile,
    coldDurationMs,
    warmDurationMs,
    singleAvgMs: singleStats.avgMs,
    flowAvgMs: flowStats.avgMs,
    heapUsedMb: memEnd.heapUsedMb,
    rssMb: memEnd.rssMb
  })
}

// =========================================================================
// 6. Scalability, Linearity, and Growth Ratio Analysis
// =========================================================================

console.log('\n===========================================================================')
console.log('SCALABILITY, LINEARITY, AND GROWTH ANALYSIS')
console.log('===========================================================================')

const base1k = resultsByScale[0]
console.log(`\nBaseline (1,000 files): ${base1k.compositeAvgRankingMs} ms composite ranking (${base1k.usPerFile} µs/file)`)

console.log('\nScale Growth Ratios vs 1,000 Files:')
for (let i = 1; i < resultsByScale.length; i++) {
  const item = resultsByScale[i]
  const scaleMultiplier = item.scale / base1k.scale
  const timeMultiplier = Number((item.compositeAvgRankingMs / base1k.compositeAvgRankingMs).toFixed(2))
  const linearityRatio = Number((timeMultiplier / scaleMultiplier).toFixed(2))
  const isLinear = linearityRatio <= 1.35

  console.log(
    `  ${item.scale.toLocaleString()} Files: ${item.compositeAvgRankingMs} ms | ${scaleMultiplier}x files -> ${timeMultiplier}x latency (Linearity factor: ${linearityRatio}x | ${isLinear ? 'O(N) LINEAR ✓' : 'SUPERLINEAR ⚠'})`
  )
}

console.log('\nSummary Performance Table:')
console.table(
  resultsByScale.map((r) => ({
    'Scale (Files)': r.scale.toLocaleString(),
    'Ranking Avg (ms)': r.compositeAvgRankingMs,
    'Rate (µs/file)': r.usPerFile,
    'Cold Resolve (ms)': r.coldDurationMs,
    'Warm Resolve (ms)': r.warmDurationMs,
    'Heap (MB)': r.heapUsedMb,
    'RSS (MB)': r.rssMb
  }))
)

cleanupWorkspace()

console.log('\n===========================================================================')
console.log('PHASE 1 TASK 2 LARGE-WORKSPACE STRESS TEST PASSED SUCCESSFULLY! ✓')
console.log('===========================================================================')
