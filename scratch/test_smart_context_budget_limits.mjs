// scratch/test_smart_context_budget_limits.mjs
// Phase 1 Task 4: ContextBudgetManager & Truncation Boundaries Stress Testing
// Verifies file-size limits, total context budget saturation, boundary conditions (<=100 chars, exact limits),
// score threshold filtering, dropped-file diagnostics, prompt formatting integrity, and determinism.

import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import esbuild from 'esbuild'

// =========================================================================
// 1. Temporary Workspace Management & Safe Teardown
// =========================================================================

const tempWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-ide-smartcontext-budget-'))
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
  JSON.stringify({ name: 'budget-test-workspace', version: '1.0.0' }, null, 2),
  'utf8'
)

// =========================================================================
// 2. Transpile & Load Production Modules
// =========================================================================

const budgetBundle = await esbuild.build({
  entryPoints: ['src/renderer/src/services/agent/contextBudgetManager.ts'],
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'browser',
  target: 'es2022'
})

const engineBundle = await esbuild.build({
  entryPoints: ['src/renderer/src/services/agent/smartContextEngine.ts'],
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'browser',
  target: 'es2022',
  external: ['electron', 'lucide-react', 'react', 'react-dom']
})

const budgetManagerCode = budgetBundle.outputFiles[0].text
const smartContextEngineCode = engineBundle.outputFiles[0].text

const modBudget = await import('data:text/javascript;base64,' + Buffer.from(budgetManagerCode).toString('base64'))
const { ContextBudgetManager } = modBudget

// Setup global mock for SmartContextEngine tests
let currentTree = []
let currentFileMap = new Map()

globalThis.window = {
  electronAPI: {
    readTree: async (root) => ({
      success: true,
      rootPath: root,
      tree: currentTree
    }),
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

const modEngine = await import('data:text/javascript;base64,' + Buffer.from(smartContextEngineCode).toString('base64'))
const { SmartContextEngine } = modEngine

// =========================================================================
// 3. Inspect Actual Configured Limits from Production Implementation
// =========================================================================

const defaultBudgetManager = new ContextBudgetManager()
const actualMaxBudget = defaultBudgetManager.getMaxBudget()
const actualMaxFileChars = defaultBudgetManager.getMaxFileChars()

console.log('===========================================================================')
console.log('PHASE 1 TASK 4: CONTEXT BUDGET MANAGER & TRUNCATION STRESS SUITE')
console.log('===========================================================================')
console.log(`Configured Production Limits:`)
console.log(`  - maxBudget (Total Context Budget):  ${actualMaxBudget.toLocaleString()} characters`)
console.log(`  - maxFileChars (Per-File Limit):     ${actualMaxFileChars.toLocaleString()} characters`)
console.log(`  - minScoreThreshold (Score Floor):   40 points`)
console.log(`  - Exhaustion Threshold Margin:       <= 100 remaining characters\n`)

const testSummary = []

// =========================================================================
// TEST CASE 1: Single file larger than maxFileChars (12,000 characters)
// =========================================================================
console.log('[Test 1] Single file exceeding maxFileChars:')

const oversizedContent = 'const data = {\n' + '  item: "test_value_entry",\n'.repeat(800) + '};\n'
assert(oversizedContent.length > actualMaxFileChars, 'Test content must exceed maxFileChars')

const res1 = defaultBudgetManager.allocate([
  {
    path: 'src/services/largeService.ts',
    content: oversizedContent,
    score: 150
  }
])

console.log(`  Input file length:     ${oversizedContent.length.toLocaleString()} chars`)
console.log(`  Allocated files count: ${res1.allocatedFiles.length}`)
console.log(`  Allocated char count:  ${res1.allocatedFiles[0].charCount.toLocaleString()} chars`)
console.log(`  Truncated flag:        ${res1.allocatedFiles[0].truncated}`)
console.log(`  Remaining budget:      ${res1.remainingBudget.toLocaleString()} chars`)

assert.strictEqual(res1.allocatedFiles.length, 1)
assert.strictEqual(res1.allocatedFiles[0].truncated, true, 'File must be flagged as truncated')
assert(
  res1.allocatedFiles[0].content.includes('\n\n[... Truncated remainder of file ...]'),
  'Must append truncation marker'
)
// 12000 chars slice + 39 chars marker = 12039 chars
assert.strictEqual(res1.allocatedFiles[0].charCount, actualMaxFileChars + 39)
assert.strictEqual(res1.droppedFiles.length, 0)
assert.strictEqual(res1.totalCharsUsed, actualMaxFileChars + 39)
console.log('✓ PASS: Single oversized file truncated cleanly to maxFileChars + marker with truncated=true.\n')
testSummary.push({ test: '1. Single file exceeding maxFileChars', status: 'PASS' })

// =========================================================================
// TEST CASE 2: Multiple files that together exceed maxBudget (30,000 characters)
// =========================================================================
console.log('[Test 2] Multiple files exceeding total maxBudget:')

// 4 files: 10,000 chars each = 40,000 total attempted (exceeds 30,000 limit)
const candidateFiles = [
  { path: 'src/fileA.ts', content: 'A'.repeat(10000), score: 200 },
  { path: 'src/fileB.ts', content: 'B'.repeat(10000), score: 180 },
  { path: 'src/fileC.ts', content: 'C'.repeat(10000), score: 160 },
  { path: 'src/fileD.ts', content: 'D'.repeat(10000), score: 140 }
]

const res2 = defaultBudgetManager.allocate(candidateFiles)

console.log(`  Total attempted:       40,000 chars across 4 files`)
console.log(`  Allocated files:       ${res2.allocatedFiles.map((f) => `${f.path} (${f.charCount} chars)`).join(', ')}`)
console.log(`  Dropped files:         ${res2.droppedFiles.map((d) => `${d.path} [${d.reason}]`).join(', ')}`)
console.log(`  Total chars used:      ${res2.totalCharsUsed.toLocaleString()} / ${res2.maxBudget.toLocaleString()}`)
console.log(`  Remaining budget:      ${res2.remainingBudget}`)

assert.strictEqual(res2.allocatedFiles.length, 3, 'Top 3 files should be allocated')
assert.strictEqual(res2.droppedFiles.length, 1, '4th file must be dropped')
assert.strictEqual(res2.droppedFiles[0].path, 'src/fileD.ts')
assert(
  res2.droppedFiles[0].reason.includes('Context budget exhausted (30000/30000 chars used)'),
  `Reason must cite budget exhaustion: ${res2.droppedFiles[0].reason}`
)
assert.strictEqual(res2.remainingBudget, 0)
console.log('✓ PASS: Multiple files saturating budget allocate top candidates and drop remainder with reason.\n')
testSummary.push({ test: '2. Multiple files exceeding maxBudget', status: 'PASS' })

// =========================================================================
// TEST CASE 3: A file that fits exactly at the per-file limit (12,000 chars)
// =========================================================================
console.log('[Test 3] File fitting exactly at per-file limit (boundary check):')

const exactLimitContent = 'E'.repeat(actualMaxFileChars)
const oneOverLimitContent = 'O'.repeat(actualMaxFileChars + 1)
const oneUnderLimitContent = 'U'.repeat(actualMaxFileChars - 1)

// Isolated single-file boundary checks (where total budget is not saturated)
const resExact = defaultBudgetManager.allocate([{ path: 'src/exact.ts', content: exactLimitContent, score: 100 }])
const resOneOver = defaultBudgetManager.allocate([{ path: 'src/oneOver.ts', content: oneOverLimitContent, score: 100 }])
const resOneUnder = defaultBudgetManager.allocate([{ path: 'src/oneUnder.ts', content: oneUnderLimitContent, score: 100 }])

console.log(`  Isolated src/exact.ts (12,000 chars):    truncated=${resExact.allocatedFiles[0].truncated}, charCount=${resExact.allocatedFiles[0].charCount}`)
console.log(`  Isolated src/oneOver.ts (12,001 chars):  truncated=${resOneOver.allocatedFiles[0].truncated}, charCount=${resOneOver.allocatedFiles[0].charCount}`)
console.log(`  Isolated src/oneUnder.ts (11,999 chars): truncated=${resOneUnder.allocatedFiles[0].truncated}, charCount=${resOneUnder.allocatedFiles[0].charCount}`)

assert.strictEqual(resExact.allocatedFiles[0].truncated, false, 'Exact 12,000 chars must NOT be truncated')
assert.strictEqual(resExact.allocatedFiles[0].charCount, actualMaxFileChars)
assert(!resExact.allocatedFiles[0].content.includes('[... Truncated'), 'Exact limit must not contain notice')

assert.strictEqual(resOneOver.allocatedFiles[0].truncated, true, '12,001 chars MUST be truncated')
assert.strictEqual(resOneOver.allocatedFiles[0].charCount, actualMaxFileChars + 39)
assert(resOneOver.allocatedFiles[0].content.includes('[... Truncated remainder of file ...]'))

assert.strictEqual(resOneUnder.allocatedFiles[0].truncated, false, '11,999 chars must NOT be truncated')
assert.strictEqual(resOneUnder.allocatedFiles[0].charCount, actualMaxFileChars - 1)

// Cumulative boundary check: File 1 (12k) + File 2 (12k) leaves 5,961 chars, truncating File 3 (11,999 chars) to remaining budget
const resCumulative = defaultBudgetManager.allocate([
  { path: 'src/exact.ts', content: exactLimitContent, score: 100 },
  { path: 'src/oneOver.ts', content: oneOverLimitContent, score: 90 },
  { path: 'src/oneUnder.ts', content: oneUnderLimitContent, score: 80 }
])
console.log(`  Cumulative third file truncated by remaining total budget:`)
console.log(`    src/oneUnder.ts: truncated=${resCumulative.allocatedFiles[2].truncated}, charCount=${resCumulative.allocatedFiles[2].charCount} (truncated to remaining 5,961 + 39 marker)`)
assert.strictEqual(resCumulative.allocatedFiles[2].truncated, true)
assert.strictEqual(resCumulative.allocatedFiles[2].charCount, 5961 + 39)
console.log('✓ PASS: Strict boundary correctness: 12,000 exact not truncated; 12,001 truncated.\n')
testSummary.push({ test: '3. Exact per-file limit boundary', status: 'PASS' })

// =========================================================================
// TEST CASE 4: File exceeding remaining budget & <= 100 char boundary
// =========================================================================
console.log('[Test 4] Remaining budget exhaustion and <= 100 char threshold:')

// Scenario 4A: Remaining budget = 500 chars, candidate file is 800 chars (exceeds remaining budget by small amount)
const mgr4A = new ContextBudgetManager({ maxBudget: 2000, maxFileChars: 2000 })
const res4A = mgr4A.allocate([
  { path: 'src/first.ts', content: 'F'.repeat(1500), score: 100 }, // remaining after this: 500
  { path: 'src/second.ts', content: 'S'.repeat(800), score: 90 }  // exceeds 500 -> truncated to 500 + marker
])

console.log(`  [4A] Remaining 500 chars with 800 char candidate:`)
console.log(`    second.ts: truncated=${res4A.allocatedFiles[1].truncated}, charCount=${res4A.allocatedFiles[1].charCount}`)
assert.strictEqual(res4A.allocatedFiles[1].truncated, true)
assert.strictEqual(res4A.allocatedFiles[1].charCount, 500 + 39)
assert(res4A.allocatedFiles[1].content.startsWith('S'.repeat(500)))

// Scenario 4B: Remaining budget <= 100 chars (e.g. exactly 100 chars, 99 chars, 0 chars)
const mgr4B = new ContextBudgetManager({ maxBudget: 1000, maxFileChars: 1000 })
const res4B = mgr4B.allocate([
  { path: 'src/fill900.ts', content: 'X'.repeat(900), score: 100 }, // remaining: exactly 100
  { path: 'src/candidate100.ts', content: 'C'.repeat(50), score: 90 }  // remaining <= 100 -> dropped
])

console.log(`  [4B] Remaining exactly 100 chars:`)
console.log(`    candidate100.ts: dropped=${res4B.droppedFiles.length === 1}, reason="${res4B.droppedFiles[0]?.reason}"`)
assert.strictEqual(res4B.allocatedFiles.length, 1)
assert.strictEqual(res4B.droppedFiles.length, 1)
assert.strictEqual(res4B.droppedFiles[0].path, 'src/candidate100.ts')
assert(res4B.droppedFiles[0].reason.includes('Context budget exhausted (900/1000 chars used)'))

// Scenario 4C: Remaining budget = 101 chars (boundary just above 100 chars)
const mgr4C = new ContextBudgetManager({ maxBudget: 1000, maxFileChars: 1000 })
const res4C = mgr4C.allocate([
  { path: 'src/fill899.ts', content: 'X'.repeat(899), score: 100 }, // remaining: exactly 101
  { path: 'src/candidate101.ts', content: 'C'.repeat(200), score: 90 } // remaining 101 > 100 -> allocated (truncated to 101+39)
])

console.log(`  [4C] Remaining exactly 101 chars:`)
console.log(`    candidate101.ts: allocated=${res4C.allocatedFiles.length === 2}, truncated=${res4C.allocatedFiles[1]?.truncated}, charCount=${res4C.allocatedFiles[1]?.charCount}`)
assert.strictEqual(res4C.allocatedFiles.length, 2)
assert.strictEqual(res4C.allocatedFiles[1].truncated, true)
assert.strictEqual(res4C.allocatedFiles[1].charCount, 101 + 39)
assert.strictEqual(res4C.droppedFiles.length, 0)
console.log('✓ PASS: Remaining budget threshold (<= 100 drops, 101 allocates partial with truncation).\n')
testSummary.push({ test: '4. Remaining budget exhaustion & <= 100 threshold', status: 'PASS' })

// =========================================================================
// TEST CASE 5: Candidate files with varying scores & minScoreThreshold (40)
// =========================================================================
console.log('[Test 5] Candidate files with varying scores and score threshold (40):')

const candidateScores = [
  { path: 'src/highScore.ts', content: 'export const high = 1;', score: 120, isExplicit: false },
  { path: 'src/exactThreshold.ts', content: 'export const threshold = 40;', score: 40, isExplicit: false },
  { path: 'src/belowThreshold.ts', content: 'export const low = 39;', score: 39, isExplicit: false },
  { path: 'src/veryLowScore.ts', content: 'export const zero = 0;', score: 0, isExplicit: false },
  { path: 'src/explicitZeroScore.ts', content: 'export const expZero = 0;', score: 0, isExplicit: true }
]

const res5 = defaultBudgetManager.allocate(candidateScores)

console.log(`  Allocated: ${res5.allocatedFiles.map((f) => `${f.path} (score: ${f.score}, explicit: ${f.isExplicit})`).join(', ')}`)
console.log(`  Dropped:   ${res5.droppedFiles.map((d) => `${d.path} [score: ${d.score}, reason: "${d.reason}"]`).join(', ')}`)

// Verified expectations:
// - highScore (120): allocated
// - exactThreshold (40): allocated (40 is not < 40)
// - explicitZeroScore (0, explicit): allocated (isExplicit overrides minScoreThreshold)
// - belowThreshold (39): dropped due to threshold
// - veryLowScore (0): dropped due to threshold
assert.strictEqual(res5.allocatedFiles.length, 3)
assert.strictEqual(res5.droppedFiles.length, 2)

const droppedPaths = res5.droppedFiles.map((d) => d.path)
assert(droppedPaths.includes('src/belowThreshold.ts'))
assert(droppedPaths.includes('src/veryLowScore.ts'))

const reason39 = res5.droppedFiles.find((d) => d.path === 'src/belowThreshold.ts')?.reason
assert(reason39?.includes('Relevance score 39 below minimum threshold (40)'))

const reason0 = res5.droppedFiles.find((d) => d.path === 'src/veryLowScore.ts')?.reason
assert(reason0?.includes('Relevance score 0 below minimum threshold (40)'))

console.log('✓ PASS: minScoreThreshold (40) enforced for non-explicit files; explicit files bypass threshold.\n')
testSummary.push({ test: '5. Score threshold & explicit bypass', status: 'PASS' })

// =========================================================================
// TEST CASE 6: Selection, Truncation, and Ordering Verification
// =========================================================================
console.log('[Test 6] Priority ordering: explicit files first, then score descending:')

const mixedOrderCandidates = [
  { path: 'src/score50.ts', content: 'A', score: 50, isExplicit: false },
  { path: 'src/score90.ts', content: 'B', score: 90, isExplicit: false },
  { path: 'src/explicitScore10.ts', content: 'C', score: 10, isExplicit: true },
  { path: 'src/score70.ts', content: 'D', score: 70, isExplicit: false },
  { path: 'src/explicitScore80.ts', content: 'E', score: 80, isExplicit: true }
]

const res6 = defaultBudgetManager.allocate(mixedOrderCandidates)
const allocatedPathsOrder = res6.allocatedFiles.map((f) => f.path)

console.log(`  Allocated Order: ${allocatedPathsOrder.join(' -> ')}`)
// Expected ordering:
// 1. explicitScore80 (explicit, score 80)
// 2. explicitScore10 (explicit, score 10)
// 3. score90 (non-explicit, score 90)
// 4. score70 (non-explicit, score 70)
// 5. score50 (non-explicit, score 50)
assert.deepStrictEqual(allocatedPathsOrder, [
  'src/explicitScore80.ts',
  'src/explicitScore10.ts',
  'src/score90.ts',
  'src/score70.ts',
  'src/score50.ts'
])
console.log('✓ PASS: Strict priority sorting verified: explicit files first (by score), then non-explicit by score.\n')
testSummary.push({ test: '6. Priority ordering (explicit first, then score)', status: 'PASS' })

// =========================================================================
// TEST CASE 7: Dropped-Files Diagnostics Accuracy
// =========================================================================
console.log('[Test 7] Dropped-files diagnostics accuracy:')

// Scenario 7A: Budget has room (remaining > 100), low-score candidate is dropped with threshold reason
const candidatesThreshold = [
  { path: 'src/good.ts', content: 'G'.repeat(5000), score: 100 },
  { path: 'src/lowScore.ts', content: 'L'.repeat(100), score: 20 }
]
const res7A = defaultBudgetManager.allocate(candidatesThreshold)
console.log(`  [7A] Low-score drop (budget not exhausted):`)
console.log(`    - ${res7A.droppedFiles[0]?.path}: "${res7A.droppedFiles[0]?.reason}"`)
assert.strictEqual(res7A.droppedFiles.length, 1)
assert.strictEqual(res7A.droppedFiles[0].path, 'src/lowScore.ts')
assert.strictEqual(res7A.droppedFiles[0].reason, 'Relevance score 20 below minimum threshold (40)')

// Scenario 7B: Budget exhausted (remaining <= 100), candidate is dropped with budget exhaustion reason
const candidatesExhausted = [
  { path: 'src/big1.ts', content: 'A'.repeat(12000), score: 100 },
  { path: 'src/big2.ts', content: 'B'.repeat(12000), score: 95 },
  { path: 'src/big3.ts', content: 'C'.repeat(5950), score: 90 }, // total: 29,950, remaining: 50 <= 100
  { path: 'src/exhausted.ts', content: 'E'.repeat(100), score: 85 }
]
const res7B = defaultBudgetManager.allocate(candidatesExhausted)
console.log(`  [7B] Budget exhaustion drop:`)
console.log(`    - ${res7B.droppedFiles[0]?.path}: "${res7B.droppedFiles[0]?.reason}"`)
assert.strictEqual(res7B.droppedFiles.length, 1)
assert.strictEqual(res7B.droppedFiles[0].path, 'src/exhausted.ts')
assert(res7B.droppedFiles[0].reason.includes('Context budget exhausted (29950/30000 chars used)'))

// Scenario 7C: Precedence verification - exhaustion check precedes threshold check
// When budget is already exhausted by higher-scoring files, a candidate with score < 40
// is dropped with "Context budget exhausted" because the remaining <= 100 check occurs before score check
const candidatesPrecedence = [
  ...candidatesExhausted,
  { path: 'src/lowScoreAfterExhausted.ts', content: 'L', score: 15 }
]
const res7C = defaultBudgetManager.allocate(candidatesPrecedence)
console.log(`  [7C] Precedence check (exhaustion check precedes threshold check):`)
console.log(`    - ${res7C.droppedFiles[1]?.path}: "${res7C.droppedFiles[1]?.reason}"`)
assert.strictEqual(res7C.droppedFiles.length, 2)
assert(res7C.droppedFiles[1].reason.includes('Context budget exhausted'))
console.log('✓ PASS: droppedFiles accurately captures paths, scores, explicit flags, and distinct reasons.\n')
testSummary.push({ test: '7. Dropped-files diagnostics accuracy', status: 'PASS' })

// =========================================================================
// TEST CASE 8: readFiles Truncation Flags & Character Counts in Diagnostics
// =========================================================================
console.log('[Test 8] Diagnostics snapshot verification in SmartContextEngine:')

// Setup mock workspace files for end-to-end engine check
currentFileMap.clear()
const file1Content = 'export function normalFn() { return 42; }'
const file2Content = 'export const HUGE_DATA = [\n' + '  { id: 1, name: "item" },\n'.repeat(600) + '];' // ~15,000 chars

currentFileMap.set('src/normal.ts', file1Content)
currentFileMap.set('src/huge.ts', file2Content)
currentTree = [
  { name: 'normal.ts', path: `${normalizedWorkspaceRoot}/src/normal.ts`, isDirectory: false, size: file1Content.length, mtimeMs: Date.now() },
  { name: 'huge.ts', path: `${normalizedWorkspaceRoot}/src/huge.ts`, isDirectory: false, size: file2Content.length, mtimeMs: Date.now() }
]

const testEngine = new SmartContextEngine({ maxFileChars: 12000, maxTotalContextChars: 30000, debug: false })
const result8 = await testEngine.resolveContext('Explain the code in src/normal.ts and src/huge.ts', normalizedWorkspaceRoot)
const diag8 = testEngine.getLastDiagnostics()

console.log(`  Engine readFiles count: ${result8.readFiles.length}`)
for (const rf of result8.readFiles) {
  console.log(`    - ${rf.path}: charCount=${rf.charCount}, truncated=${rf.truncated}, source=${rf.source}`)
}

assert.strictEqual(result8.readFiles.length, 2)
const rfNormal = result8.readFiles.find((f) => f.path.includes('normal.ts'))
const rfHuge = result8.readFiles.find((f) => f.path.includes('huge.ts'))

assert(rfNormal)
assert.strictEqual(rfNormal.truncated, false)
assert.strictEqual(rfNormal.charCount, file1Content.length)

assert(rfHuge)
assert.strictEqual(rfHuge.truncated, true)
assert.strictEqual(rfHuge.charCount, 12000 + 39)

// Verify diagnostic snapshot matches
assert.strictEqual(diag8.readFiles.length, 2)
assert.strictEqual(diag8.readFiles.find((f) => f.path.includes('huge.ts'))?.truncated, true)
assert.strictEqual(diag8.readFiles.find((f) => f.path.includes('huge.ts'))?.charCount, 12000 + 39)
assert.strictEqual(diag8.readFiles.find((f) => f.path.includes('normal.ts'))?.truncated, false)
console.log('✓ PASS: readFiles and diagnostics snapshot report exact character counts and truncated flags.\n')
testSummary.push({ test: '8. readFiles diagnostics & truncated flags', status: 'PASS' })

// =========================================================================
// TEST CASE 9: Truncation Notices & Downstream Prompt Formatting Integrity
// =========================================================================
console.log('[Test 9] Downstream prompt format integrity with truncated file:')

const formatted = result8.formattedContext
console.log('  Formatted Context Snippet (Header & Delimiters):')
const lines = formatted.split('\n')
for (let i = 0; i < Math.min(10, lines.length); i++) {
  console.log(`    | ${lines[i]}`)
}

// Prompt format invariants:
// 1. Must start with "[Smart Project Context Engine - Relevant Workspace Files]:"
assert(formatted.startsWith('[Smart Project Context Engine - Relevant Workspace Files]:'))

// 2. Summary lines list files
assert(formatted.includes('- src/huge.ts (Score:'))
assert(formatted.includes('- src/normal.ts (Score:'))

// 3. Delimiter for truncated file includes " (Truncated)"
assert(formatted.includes('--- File: src/huge.ts (Truncated) ---'))

// 4. Delimiter for non-truncated file does NOT include " (Truncated)"
assert(formatted.includes('--- File: src/normal.ts ---'))
assert(!formatted.includes('--- File: src/normal.ts (Truncated) ---'))

// 5. Clean truncation notice at end of truncated file content block
assert(formatted.includes('[... Truncated remainder of file ...]'))

// 6. Multi-file separation intact (no merged or broken blocks)
const fileBlockHeaders = formatted.match(/--- File: [^\n]+ ---/g) || []
assert.strictEqual(fileBlockHeaders.length, 2, 'Must have exactly 2 distinct file block headers')
assert(fileBlockHeaders.includes('--- File: src/huge.ts (Truncated) ---'), 'Must include truncated header for huge.ts')
assert(fileBlockHeaders.includes('--- File: src/normal.ts ---'), 'Must include normal header for normal.ts')
console.log('✓ PASS: Prompt formatting preserves valid Markdown/plain delimiters and clear (Truncated) headers.\n')
testSummary.push({ test: '9. Prompt format integrity & clear notice', status: 'PASS' })

// =========================================================================
// TEST CASE 10: Determinism Across Repeated Runs
// =========================================================================
console.log('[Test 10] Determinism across repeated budget allocation runs:')

const testCandidates = [
  { path: 'src/modA.ts', content: 'A'.repeat(8000), score: 95 },
  { path: 'src/modB.ts', content: 'B'.repeat(15000), score: 90 }, // truncated to 12000
  { path: 'src/modC.ts', content: 'C'.repeat(12000), score: 85 }, // remaining is 10000 -> truncated to 10000
  { path: 'src/modD.ts', content: 'D'.repeat(2000), score: 80 },  // budget exhausted -> dropped
  { path: 'src/modE.ts', content: 'E'.repeat(100), score: 25 }    // low score -> dropped
]

const run1 = defaultBudgetManager.allocate(testCandidates)
const run2 = defaultBudgetManager.allocate(testCandidates)
const run3 = defaultBudgetManager.allocate(testCandidates)

assert.strictEqual(run1.allocatedFiles.length, run2.allocatedFiles.length)
assert.strictEqual(run2.allocatedFiles.length, run3.allocatedFiles.length)
assert.strictEqual(run1.droppedFiles.length, run2.droppedFiles.length)
assert.strictEqual(run2.droppedFiles.length, run3.droppedFiles.length)
assert.strictEqual(run1.totalCharsUsed, run2.totalCharsUsed)
assert.strictEqual(run2.totalCharsUsed, run3.totalCharsUsed)

for (let i = 0; i < run1.allocatedFiles.length; i++) {
  assert.strictEqual(run1.allocatedFiles[i].path, run2.allocatedFiles[i].path)
  assert.strictEqual(run2.allocatedFiles[i].path, run3.allocatedFiles[i].path)
  assert.strictEqual(run1.allocatedFiles[i].charCount, run2.allocatedFiles[i].charCount)
  assert.strictEqual(run2.allocatedFiles[i].charCount, run3.allocatedFiles[i].charCount)
  assert.strictEqual(run1.allocatedFiles[i].truncated, run2.allocatedFiles[i].truncated)
  assert.strictEqual(run2.allocatedFiles[i].truncated, run3.allocatedFiles[i].truncated)
}

for (let j = 0; j < run1.droppedFiles.length; j++) {
  assert.strictEqual(run1.droppedFiles[j].path, run2.droppedFiles[j].path)
  assert.strictEqual(run2.droppedFiles[j].path, run3.droppedFiles[j].path)
  assert.strictEqual(run1.droppedFiles[j].reason, run2.droppedFiles[j].reason)
  assert.strictEqual(run2.droppedFiles[j].reason, run3.droppedFiles[j].reason)
}

console.log(`  Runs 1, 2, and 3 allocated identical ${run1.allocatedFiles.length} files and dropped ${run1.droppedFiles.length} files.`)
console.log('✓ PASS: Context budget manager allocation is 100% deterministic.\n')
testSummary.push({ test: '10. Determinism across repeated runs', status: 'PASS' })

// =========================================================================
// SUMMARY REPORT
// =========================================================================

console.log('===========================================================================')
console.log('CONTEXT BUDGET & TRUNCATION TEST SUMMARY')
console.log('===========================================================================')
console.table(testSummary)

cleanupWorkspace()

console.log('\n===========================================================================')
console.log('ALL PHASE 1 TASK 4 BUDGET & TRUNCATION TESTS PASSED! ✓')
console.log('===========================================================================')
