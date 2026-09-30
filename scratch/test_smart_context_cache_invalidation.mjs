// scratch/test_smart_context_cache_invalidation.mjs
// Phase 1 Task 5: ContextCache & ContextDeduplicator Invalidation Stress Test
// Verifies cache hits, file edits, renames, deletions, watcher events, editor saves,
// content & tool-result deduplication, concurrent edit/read, and provenance diagnostics.

import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import esbuild from 'esbuild'

// =========================================================================
// 1. Temporary Workspace Management & Safe Teardown
// =========================================================================

const tempWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-ide-smartcontext-invalidation-'))
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
  JSON.stringify({ name: 'cache-invalidation-test-workspace', version: '1.0.0' }, null, 2),
  'utf8'
)

// =========================================================================
// 2. Transpile & Load Production SmartContextEngine
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

const smartContextEngineCode = engineBundle.outputFiles[0].text
const mod = await import('data:text/javascript;base64,' + Buffer.from(smartContextEngineCode).toString('base64'))
const { SmartContextEngine } = mod

// =========================================================================
// 3. Mock Disk Files & Electron API Setup
// =========================================================================

const mockDiskFiles = new Map()
let readDelayMs = 0

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
      if (readDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, readDelayMs))
      }
      const norm = relPath.replace(/\\/g, '/').replace(/^\/+/, '')
      if (mockDiskFiles.has(norm)) {
        return { success: true, content: mockDiskFiles.get(norm) }
      }
      return { success: false, error: `File not found: ${relPath}` }
    },
    saveWorkspaceIndex: async () => ({ success: true })
  }
}

// Initial fixture files
mockDiskFiles.set('package.json', JSON.stringify({ name: 'cache-test' }))
mockDiskFiles.set('src/services/authService.ts', 'export class AuthService { login() { return "v1-auth"; } }')
mockDiskFiles.set('src/services/userService.ts', 'export class UserService { getUser() { return "v1-user"; } }')
mockDiskFiles.set('src/components/Header.tsx', 'export function Header() { return "v1-header"; }')
mockDiskFiles.set('src/utils/formatters.ts', 'export function formatDate() { return "v1-date"; }')

console.log('===========================================================================')
console.log('PHASE 1 TASK 5: CACHE INVALIDATION & CONTEXT DEDUPLICATION STRESS SUITE')
console.log('===========================================================================')
console.log(`Workspace: ${normalizedWorkspaceRoot}\n`)

const testResults = []
const engine = new SmartContextEngine({ watcherBatchDebounceMs: 20, debug: false })

// =========================================================================
// SCENARIO 1: Cache Hit - Unchanged file repeatedly read
// =========================================================================
console.log('[Scenario 1] Cache hit verification:')

// Turn 1: Cold read
const res1Turn1 = await engine.resolveContext('Explain only the file src/services/authService.ts', normalizedWorkspaceRoot)
const diag1Turn1 = engine.getLastDiagnostics()
const cacheStats1 = engine.getCache().getStats()

console.log(`  Turn 1 (Cold): source=${diag1Turn1.readFiles[0]?.source} | hits=${cacheStats1.hits}, misses=${cacheStats1.misses}`)
assert.strictEqual(diag1Turn1.readFiles[0]?.source, 'disk', 'Turn 1 must be from disk')
assert(res1Turn1.formattedContext.includes('v1-auth'))

// Turn 2: Warm read (unchanged file)
const res1Turn2 = await engine.resolveContext('Explain only the file src/services/authService.ts', normalizedWorkspaceRoot)
const diag1Turn2 = engine.getLastDiagnostics()
const cacheStats2 = engine.getCache().getStats()

console.log(`  Turn 2 (Warm): source=${diag1Turn2.readFiles[0]?.source} | hits=${cacheStats2.hits}, misses=${cacheStats2.misses}`)
assert.strictEqual(diag1Turn2.readFiles[0]?.source, 'cache', 'Turn 2 must be from cache')
assert(res1Turn2.formattedContext.includes('v1-auth'))
assert(cacheStats2.hits > cacheStats1.hits, 'Cache hits must increase on repeated read')

console.log('✓ PASS: Cold read accurately hits disk; repeated read accurately hits cache with source="cache".\n')
testResults.push({ scenario: '1. Cache hit on unchanged file', status: 'PASS' })

// =========================================================================
// SCENARIO 2: File Edit - Invalidation on content modification
// =========================================================================
console.log('[Scenario 2] File edit invalidation:')

// Modify file on disk and invalidate
mockDiskFiles.set('src/services/authService.ts', 'export class AuthService { login() { return "v2-auth-MODIFIED"; } }')
engine.invalidateFile('src/services/authService.ts')

assert.strictEqual(engine.getCache().has('src/services/authService.ts'), false, 'Cache entry must be deleted after invalidateFile')

const res2 = await engine.resolveContext('Explain only the file src/services/authService.ts', normalizedWorkspaceRoot)
const diag2 = engine.getLastDiagnostics()

console.log(`  After edit: source=${diag2.readFiles[0]?.source}`)
console.log(`  Formatted Context includes "v2-auth-MODIFIED": ${res2.formattedContext.includes('v2-auth-MODIFIED')}`)
console.log(`  Formatted Context includes old "v1-auth": ${res2.formattedContext.includes('v1-auth')}`)

assert.strictEqual(diag2.readFiles[0]?.source, 'disk', 'Modified file must be re-read from disk')
assert(res2.formattedContext.includes('v2-auth-MODIFIED'), 'Context must contain modified v2 content')
assert(!res2.formattedContext.includes('v1-auth'), 'Context must NOT contain stale v1 content')

console.log('✓ PASS: Invalidated file re-reads from disk and excludes stale content.\n')
testResults.push({ scenario: '2. File edit invalidation', status: 'PASS' })

// =========================================================================
// SCENARIO 3: File Rename - Old path invalidated & new path resolves
// =========================================================================
console.log('[Scenario 3] File rename invalidation:')

// Rename src/utils/formatters.ts -> src/utils/dateHelpers.ts
const renamedContent = 'export function formatEpoch() { return "v1-epoch"; }'
mockDiskFiles.delete('src/utils/formatters.ts')
mockDiskFiles.set('src/utils/dateHelpers.ts', renamedContent)

// Simulate watcher unlink old path + add new path
await engine.handleFileEvent({
  workspaceRoot: normalizedWorkspaceRoot,
  relativePath: 'src/utils/formatters.ts',
  eventType: 'unlink'
}, 5)

await engine.handleFileEvent({
  workspaceRoot: normalizedWorkspaceRoot,
  relativePath: 'src/utils/dateHelpers.ts',
  eventType: 'add'
}, 5)

// Wait for debounced watcher batch to process
await new Promise((r) => setTimeout(r, 30))

// 3A: Old path must be missing with zero fallback
const res3Old = await engine.resolveContext('Explain only the file src/utils/formatters.ts', normalizedWorkspaceRoot)
console.log(`  Query old path: selected=${res3Old.selectedFiles.length}, read=${res3Old.readFiles.length}`)
assert.strictEqual(res3Old.selectedFiles.length, 0)
assert.strictEqual(res3Old.readFiles.length, 0)
assert(res3Old.formattedContext.includes('was not found in workspace'))

// 3B: New path must resolve correctly with new content
const res3New = await engine.resolveContext('Explain only the file src/utils/dateHelpers.ts', normalizedWorkspaceRoot)
console.log(`  Query new path: selected=${res3New.selectedFiles.length}, read=${res3New.readFiles.length}`)
assert.strictEqual(res3New.selectedFiles.length, 1)
assert.strictEqual(res3New.readFiles[0].path, 'src/utils/dateHelpers.ts')
assert(res3New.formattedContext.includes('v1-epoch'))

console.log('✓ PASS: Renamed old path is cleanly removed with no fallback; new path resolves with correct content.\n')
testResults.push({ scenario: '3. File rename invalidation', status: 'PASS' })

// =========================================================================
// SCENARIO 4: File Deletion - Unlinked file excluded from context
// =========================================================================
console.log('[Scenario 4] File deletion invalidation:')

// First ensure src/services/userService.ts is cached
await engine.resolveContext('Explain only the file src/services/userService.ts', normalizedWorkspaceRoot)
assert.strictEqual(engine.getCache().has('src/services/userService.ts'), true)

// Delete file from disk & emit unlink watcher event
mockDiskFiles.delete('src/services/userService.ts')
await engine.handleFileEvent({
  workspaceRoot: normalizedWorkspaceRoot,
  relativePath: 'src/services/userService.ts',
  eventType: 'unlink'
}, 5)

await new Promise((r) => setTimeout(r, 30))

assert.strictEqual(engine.getCache().has('src/services/userService.ts'), false, 'Deleted file must be removed from cache')

const res4 = await engine.resolveContext('Explain only the file src/services/userService.ts', normalizedWorkspaceRoot)
console.log(`  Query deleted file: selected=${res4.selectedFiles.length}, read=${res4.readFiles.length}`)
console.log(`  Formatted Context: "${res4.formattedContext}"`)

assert.strictEqual(res4.selectedFiles.length, 0)
assert.strictEqual(res4.readFiles.length, 0)
assert(res4.formattedContext.includes('was not found in workspace'))
assert(!res4.formattedContext.includes('v1-user'))

console.log('✓ PASS: Deleted file is completely evicted from cache and cannot enter subsequent context.\n')
testResults.push({ scenario: '4. File deletion invalidation', status: 'PASS' })

// =========================================================================
// SCENARIO 5: Watcher Invalidation - Debounced batch updates
// =========================================================================
console.log('[Scenario 5] Watcher debounced batch invalidation:')

const watcherContent = 'export function Header() { return "v2-header-WATCHER"; }'
mockDiskFiles.set('src/components/Header.tsx', watcherContent)

await engine.handleFileEvent({
  workspaceRoot: normalizedWorkspaceRoot,
  relativePath: 'src/components/Header.tsx',
  eventType: 'change'
}, 10)

// Wait for batch to process
await new Promise((r) => setTimeout(r, 30))

// Cache should now have updated watcher content
const cachedHeader = engine.getCache().get('src/components/Header.tsx')
console.log(`  Watcher updated cache content: "${cachedHeader?.content}"`)
assert(cachedHeader?.content.includes('v2-header-WATCHER'), 'Cache must hold updated watcher content')

const res5 = await engine.resolveContext('Explain only the file src/components/Header.tsx', normalizedWorkspaceRoot)
assert(res5.formattedContext.includes('v2-header-WATCHER'))
console.log('✓ PASS: Filesystem watcher event successfully updates cache and index via debounced batch.\n')
testResults.push({ scenario: '5. Watcher invalidation & batch update', status: 'PASS' })

// =========================================================================
// SCENARIO 6: Editor Save Flow - Immediate in-memory update & invalidation
// =========================================================================
console.log('[Scenario 6] Editor save flow (handleFileSave):')

const editorSavedContent = 'export function Header() { return "v3-header-EDITOR-SAVE"; }'
mockDiskFiles.set('src/components/Header.tsx', editorSavedContent)

// Trigger direct editor save
engine.handleFileSave('src/components/Header.tsx', editorSavedContent)

// Cache should immediately reflect editor content without waiting for watcher debounce
const immediateCached = engine.getCache().get('src/components/Header.tsx')
console.log(`  Immediate cache content after handleFileSave: "${immediateCached?.content}"`)
assert.strictEqual(immediateCached?.content, editorSavedContent)

const res6 = await engine.resolveContext('Explain only the file src/components/Header.tsx', normalizedWorkspaceRoot)
assert(res6.formattedContext.includes('v3-header-EDITOR-SAVE'))
console.log('✓ PASS: Editor save flow updates cache immediately, eliminating any stale context window.\n')
testResults.push({ scenario: '6. Editor save flow immediate update', status: 'PASS' })

// =========================================================================
// SCENARIO 7: Content Deduplication - Hash-based duplicate detection
// =========================================================================
console.log('[Scenario 7] Content deduplication (ContextDeduplicator):')

const deduplicator = engine.getDeduplicator()
deduplicator.reset()

const testFilePath = 'src/components/Header.tsx'
const testContent = editorSavedContent

assert.strictEqual(deduplicator.isFileInContext(testFilePath), false)
assert.strictEqual(deduplicator.isFileInContext(testFilePath, testContent), false)

// Mark into context
deduplicator.markFileInContext(testFilePath, testContent)

console.log(`  isFileInContext('${testFilePath}'): ${deduplicator.isFileInContext(testFilePath)}`)
console.log(`  isFileInContext with identical content: ${deduplicator.isFileInContext(testFilePath, testContent)}`)

assert.strictEqual(deduplicator.isFileInContext(testFilePath), true)
assert.strictEqual(deduplicator.isFileInContext(testFilePath, testContent), true)
assert.deepStrictEqual(deduplicator.getActiveFiles(), ['src/components/header.tsx'])

console.log('✓ PASS: Identical file content is accurately recognized as already active in context.\n')
testResults.push({ scenario: '7. Content deduplication hash detection', status: 'PASS' })

// =========================================================================
// SCENARIO 8: Changed Content - Not suppressed as duplicate
// =========================================================================
console.log('[Scenario 8] Changed content not suppressed as duplicate:')

const alteredContent = 'export function Header() { return "v4-header-CHANGED"; }'

// Same path, but new content hash
const isSuppressed = deduplicator.isFileInContext(testFilePath, alteredContent)
console.log(`  isFileInContext with altered content: ${isSuppressed}`)
assert.strictEqual(isSuppressed, false, 'Altered content must NOT be detected as duplicate')

// Invalidate file in deduplicator
deduplicator.invalidateFile(testFilePath)
assert.strictEqual(deduplicator.isFileInContext(testFilePath), false)
console.log('✓ PASS: Changed content correctly bypasses deduplication suppression.\n')
testResults.push({ scenario: '8. Changed content deduplication bypass', status: 'PASS' })

// =========================================================================
// SCENARIO 9: Tool-Result Deduplication (isToolResultDuplicate / markToolResult)
// =========================================================================
console.log('[Scenario 9] Tool-result deduplication:')

deduplicator.reset()

const toolName = 'runCommand'
const argsKey = '{"command":"git status"}'
const toolOutput = 'On branch master\nnothing to commit, working tree clean'

// 9A: Not duplicate initially
assert.strictEqual(deduplicator.isToolResultDuplicate(toolName, argsKey, toolOutput), false)

// 9B: Mark result
deduplicator.markToolResult(toolName, argsKey, toolOutput)
console.log(`  Marked tool result: ${toolName} with args: ${argsKey}`)

// 9C: Exact duplicate detected
const isDupe = deduplicator.isToolResultDuplicate(toolName, argsKey, toolOutput)
console.log(`  Identical tool result isToolResultDuplicate: ${isDupe}`)
assert.strictEqual(isDupe, true)

// 9D: Same tool, different args -> not duplicate
const differentArgsDupe = deduplicator.isToolResultDuplicate(toolName, '{"command":"git diff"}', toolOutput)
console.log(`  Different args isToolResultDuplicate: ${differentArgsDupe}`)
assert.strictEqual(differentArgsDupe, false)

// 9E: Same tool, same args, different output -> not duplicate
const changedOutputDupe = deduplicator.isToolResultDuplicate(toolName, argsKey, 'Changes not staged for commit:\n modified: a.ts')
console.log(`  Changed output isToolResultDuplicate: ${changedOutputDupe}`)
assert.strictEqual(changedOutputDupe, false)

// 9F: Different tool, same args and output -> not duplicate
const differentToolDupe = deduplicator.isToolResultDuplicate('otherTool', argsKey, toolOutput)
assert.strictEqual(differentToolDupe, false)

console.log('✓ PASS: Tool-result deduplication accurately tracks toolName, argsKey, and outputHash.\n')
testResults.push({ scenario: '9. Tool-result deduplication', status: 'PASS' })

// =========================================================================
// SCENARIO 10: Concurrent Edit/Read Race Condition Investigation
// =========================================================================
console.log('[Scenario 10] Concurrent edit/read race condition investigation:')

// Setup: clear cache for a specific file to force a disk read
const racePath = 'src/components/Header.tsx'
engine.getCache().invalidate(racePath)

// Configure readWorkspaceFile to simulate a 40ms asynchronous filesystem delay
readDelayMs = 40
mockDiskFiles.set(racePath, 'export const Header = "CONTENT-FROM-SLOW-DISK";')

// Initiate resolveContext (which begins async readWorkspaceFile)
const resolvePromise = engine.resolveContext(`Explain only the file ${racePath}`, normalizedWorkspaceRoot)

// While the async disk read is in flight (at 10ms), an editor save occurs with newer content
await new Promise((r) => setTimeout(r, 10))
const inFlightEditorContent = 'export const Header = "CONTENT-FROM-FAST-EDITOR-SAVE";'
engine.handleFileSave(racePath, inFlightEditorContent)
console.log(`  [At 10ms in-flight] Editor save injected newer content into cache`)

// Await the completion of the in-flight resolveContext
const raceResult = await resolvePromise
readDelayMs = 0

// Check what content made it into the resolved context and cache
const finalCached = engine.getCache().get(racePath)
console.log(`  Resolved Context Header content: "${raceResult.readFiles[0]?.content}"`)
console.log(`  Final Cache content:             "${finalCached?.content}"`)

let raceConditionObserved = false
let raceObservationDetails = ''

if (raceResult.readFiles[0]?.content === 'export const Header = "CONTENT-FROM-SLOW-DISK";') {
  raceConditionObserved = true
  raceObservationDetails = 'In-flight readWorkspaceFile completed after handleFileSave and overwrote the resolved context with slower disk content.'
} else if (finalCached?.content === 'export const Header = "CONTENT-FROM-SLOW-DISK";') {
  raceConditionObserved = true
  raceObservationDetails = 'In-flight readWorkspaceFile completed after handleFileSave and overwrote the cache with older disk content.'
} else {
  raceObservationDetails = 'Context correctly received in-flight editor save content without overwrite.'
}

console.log(`  Race condition evaluation: ${raceConditionObserved ? '⚠ POTENTIAL RACE DETECTED' : 'CLEAN ISOLATION'}`)
console.log(`  Details: ${raceObservationDetails}`)

assert.strictEqual(raceConditionObserved, false, 'Race condition must NOT occur: in-flight editor save must not be overwritten')
assert.strictEqual(finalCached?.content, inFlightEditorContent, 'Cache must retain newer editor save')
assert.strictEqual(raceResult.readFiles[0]?.content, inFlightEditorContent, 'Resolved context must use newer editor save')

testResults.push({
  scenario: '10. Concurrent edit/read race condition',
  status: 'PASS',
  details: raceObservationDetails
})

// =========================================================================
// SCENARIO 11: Repeated Invalidation Stress - Burst edits and watcher events
// =========================================================================
console.log('\n[Scenario 11] Repeated burst invalidation stress:')

const burstFile = 'src/services/authService.ts'

for (let i = 0; i < 15; i++) {
  const content = `export class AuthService { iteration() { return ${i}; } }`
  mockDiskFiles.set(burstFile, content)
  engine.handleFileSave(burstFile, content)
  await engine.handleFileEvent({
    workspaceRoot: normalizedWorkspaceRoot,
    relativePath: burstFile,
    eventType: 'change'
  }, 5)
}

// Wait for all watcher batches to settle
await new Promise((r) => setTimeout(r, 50))

const burstRes = await engine.resolveContext(`Explain only the file ${burstFile}`, normalizedWorkspaceRoot)
console.log(`  Final burst content: "${burstRes.readFiles[0]?.content}"`)
assert.strictEqual(burstRes.readFiles[0]?.content, 'export class AuthService { iteration() { return 14; } }')
assert.strictEqual(engine.getPendingEventBatchCount(), 0)

console.log('✓ PASS: 15 consecutive rapid burst edits settled cleanly without crashing or deadlock.\n')
testResults.push({ scenario: '11. Repeated burst invalidation stress', status: 'PASS' })

// =========================================================================
// SCENARIO 12: Diagnostics Provenance Accuracy
// =========================================================================
console.log('[Scenario 12] Diagnostics provenance tracking accuracy:')

// Read 1: Cold read
engine.getCache().invalidate(burstFile)
await engine.resolveContext(`Explain only the file ${burstFile}`, normalizedWorkspaceRoot)
const diagCold = engine.getLastDiagnostics()
assert.strictEqual(diagCold.readFiles[0]?.source, 'disk', 'Cold read must report source="disk"')

// Read 2: Warm read
await engine.resolveContext(`Explain only the file ${burstFile}`, normalizedWorkspaceRoot)
const diagWarm = engine.getLastDiagnostics()
assert.strictEqual(diagWarm.readFiles[0]?.source, 'cache', 'Warm read must report source="cache"')

console.log(`  Cold read diagnostics source: ${diagCold.readFiles[0]?.source}`)
console.log(`  Warm read diagnostics source: ${diagWarm.readFiles[0]?.source}`)
assert.strictEqual(diagCold.readFiles[0]?.path, burstFile)
assert.strictEqual(diagWarm.readFiles[0]?.path, burstFile)
assert.strictEqual(diagWarm.formattedContextFileList.length, 1)

console.log('✓ PASS: Diagnostics accurately reflect disk vs cache provenance.\n')
testResults.push({ scenario: '12. Diagnostics provenance accuracy', status: 'PASS' })

// =========================================================================
// SUMMARY REPORT
// =========================================================================

console.log('===========================================================================')
console.log('PHASE 1 TASK 5 TEST SUMMARY')
console.log('===========================================================================')
console.table(testResults)

cleanupWorkspace()

console.log('\n===========================================================================')
console.log('ALL PHASE 1 TASK 5 CACHE INVALIDATION TESTS COMPLETED! ✓')
console.log('===========================================================================')
