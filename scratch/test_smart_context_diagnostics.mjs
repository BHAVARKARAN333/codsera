// scratch/test_smart_context_diagnostics.mjs
// Test suite for SmartContextEngine runtime diagnostics and cache/disk provenance tracking

import assert from 'node:assert'

// Test harness mirroring SmartContextEngine diagnostic logic
class MockContextCache {
  constructor() {
    this.cache = new Map()
    this.hits = 0
    this.misses = 0
  }
  get(path) {
    if (this.cache.has(path)) {
      this.hits++
      return { path, content: this.cache.get(path) }
    }
    this.misses++
    return null
  }
  set(path, content) {
    this.cache.set(path, content)
  }
  clear() {
    this.cache.clear()
  }
  getStats() {
    return { hits: this.hits, misses: this.misses, size: this.cache.size }
  }
}

class TestableSmartContextEngine {
  constructor() {
    this.cache = new MockContextCache()
    this.lastResult = null
    this.lastDiagnosticSnapshot = null
    this.mockDiskFiles = new Map()
    this.mockTree = []
  }

  setMockFiles(fileMap) {
    this.mockDiskFiles = new Map(Object.entries(fileMap))
    this.mockTree = Array.from(this.mockDiskFiles.keys()).map((p) => ({
      name: p.split('/').pop(),
      path: p,
      isDirectory: false
    }))
  }

  isProjectContextRequired(prompt, workspaceRoot) {
    if (!workspaceRoot) return { required: false, reason: 'No workspace folder is currently open.' }
    const trimmed = prompt.trim()
    if (!trimmed) return { required: false, reason: 'Empty prompt.' }
    if (/^(hi|hello|hey)\b/i.test(trimmed)) {
      return { required: false, reason: 'Conversational greeting does not require project context.' }
    }
    if (/([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]{1,8})/.test(trimmed)) {
      return { required: true, reason: 'Prompt explicitly mentions a file path or filename.' }
    }
    if (trimmed.toLowerCase().includes('this project')) {
      return { required: true, reason: 'Prompt contains project indicator: "this project".' }
    }
    return { required: false, reason: 'No project-specific context identified.' }
  }

  rankCandidateFiles(prompt, filePaths) {
    const promptLower = prompt.toLowerCase()
    const candidates = []
    for (const p of filePaths) {
      const lower = p.toLowerCase()
      const fileName = p.split('/').pop()?.toLowerCase() || ''
      let score = 0
      let isExplicit = false
      let reason = ''
      if (promptLower.includes(fileName)) {
        score = 500
        isExplicit = true
        reason = `Exact file name match ("${fileName}")`
      } else if (promptLower.includes('project') && p.includes('smartContext')) {
        score = 120
        reason = 'Context service match'
      }
      if (score > 0) {
        candidates.push({ path: p, score, matchReason: reason, isExplicit })
      }
    }
    return candidates.sort((a, b) => b.score - a.score)
  }

  async resolveContext(prompt, workspaceRoot) {
    const intent = this.isProjectContextRequired(prompt, workspaceRoot)
    if (!intent.required || !workspaceRoot) {
      const res = {
        required: false,
        reason: intent.reason,
        selectedFiles: [],
        readFiles: [],
        droppedFiles: [],
        formattedContext: '',
        cacheStats: this.cache.getStats()
      }
      this.recordLastResult(prompt, res)
      return res
    }

    const filePaths = Array.from(this.mockDiskFiles.keys())
    if (filePaths.length === 0) {
      const res = {
        required: true,
        reason: 'No source files found in workspace.',
        selectedFiles: [],
        readFiles: [],
        droppedFiles: [],
        formattedContext: '[Project Context]: Workspace contains no readable source files.',
        cacheStats: this.cache.getStats()
      }
      this.recordLastResult(prompt, res)
      return res
    }

    const rankedCandidates = this.rankCandidateFiles(prompt, filePaths)
    const filesToRead = rankedCandidates.slice(0, 3)

    const rawCandidatesToAllocate = []
    const fileSourceMap = new Map()

    for (const candidate of filesToRead) {
      let content = null
      let source = 'disk'
      const cached = this.cache.get(candidate.path)
      if (cached) {
        content = cached.content
        source = 'cache'
      } else {
        const diskContent = this.mockDiskFiles.get(candidate.path)
        if (diskContent !== undefined) {
          content = diskContent
          source = 'disk'
          this.cache.set(candidate.path, content)
        }
      }

      if (content !== null) {
        fileSourceMap.set(candidate.path, source)
        rawCandidatesToAllocate.push({
          path: candidate.path,
          content,
          score: candidate.score,
          isExplicit: candidate.isExplicit
        })
      }
    }

    const readFiles = rawCandidatesToAllocate.map((c) => ({
      path: c.path,
      content: c.content,
      truncated: false,
      charCount: c.content.length,
      score: c.score,
      isExplicit: !!c.isExplicit,
      source: fileSourceMap.get(c.path) || 'disk'
    }))

    const formattedContext = readFiles.length > 0
      ? `[Files]:\n${readFiles.map((f) => `- ${f.path}`).join('\n')}`
      : ''

    const res = {
      required: true,
      reason: intent.reason,
      selectedFiles: rankedCandidates,
      readFiles,
      droppedFiles: [],
      formattedContext,
      cacheStats: this.cache.getStats()
    }
    this.recordLastResult(prompt, res)
    return res
  }

  recordLastResult(prompt, result) {
    this.lastResult = result
    this.lastDiagnosticSnapshot = {
      timestamp: Date.now(),
      prompt,
      required: result.required,
      reason: result.reason || '',
      selectedFiles: result.selectedFiles.map((s) => ({
        path: s.path,
        score: s.score,
        matchReason: s.matchReason,
        isExplicit: s.isExplicit
      })),
      readFiles: result.readFiles.map((f) => ({
        path: f.path,
        score: f.score,
        charCount: f.charCount,
        truncated: f.truncated,
        isExplicit: f.isExplicit,
        source: f.source || 'disk'
      })),
      droppedFiles: result.droppedFiles.map((d) => ({
        path: d.path,
        score: d.score,
        reason: d.reason
      })),
      formattedContextFileList: result.readFiles.map((f) => f.path)
    }
  }

  getLastResult() {
    return this.lastResult
  }

  getLastDiagnostics() {
    return this.lastDiagnosticSnapshot
  }

  clearCache() {
    this.cache.clear()
    this.lastResult = null
    this.lastDiagnosticSnapshot = null
  }
}

async function runTestSuite() {
  console.log('===========================================================')
  console.log('TEST SUITE: SMART CONTEXT ENGINE DIAGNOSTICS & PROVENANCE')
  console.log('===========================================================')

  const engine = new TestableSmartContextEngine()
  const workspaceRoot = 'C:/Users/bhava/Desktop/Ai Ide'

  engine.setMockFiles({
    'src/renderer/src/App.tsx': 'export const App = () => <div>App</div>;',
    'src/renderer/src/components/AIChatPanel.tsx': 'export const AIChatPanel = () => <div>Chat</div>;',
    'src/renderer/src/services/agent/smartContextEngine.ts': 'export class SmartContextEngine {}'
  })

  // TEST 1: Cold disk read provenance tracking
  console.log('\n[Test 1] First prompt with cold disk read')
  const prompt1 = 'Inspect App.tsx and explain its purpose'
  const res1 = await engine.resolveContext(prompt1, workspaceRoot)
  const diag1 = engine.getLastDiagnostics()

  assert.strictEqual(res1.required, true, 'Intent required should be true')
  assert.strictEqual(diag1.required, true, 'Diagnostic required should be true')
  assert.strictEqual(diag1.prompt, prompt1, 'Diagnostic prompt must match current request')
  assert.strictEqual(diag1.readFiles.length, 1, 'Should have read 1 file')
  assert.strictEqual(diag1.readFiles[0].path, 'src/renderer/src/App.tsx', 'Should be App.tsx')
  assert.strictEqual(diag1.readFiles[0].source, 'disk', 'First read must have provenance "disk"')
  assert.deepStrictEqual(diag1.formattedContextFileList, ['src/renderer/src/App.tsx'], 'Formatted context file list matches')
  console.log('✓ PASS: Cold read accurately marked with provenance "disk".')

  // TEST 2: Warm cache hit provenance tracking
  console.log('\n[Test 2] Second prompt with warm cache hit')
  const prompt2 = 'Please check App.tsx again'
  const res2 = await engine.resolveContext(prompt2, workspaceRoot)
  const diag2 = engine.getLastDiagnostics()

  assert.strictEqual(res2.required, true, 'Intent required should be true')
  assert.strictEqual(diag2.prompt, prompt2, 'Diagnostic prompt updated to second prompt')
  assert.strictEqual(diag2.readFiles.length, 1, 'Should have read 1 file')
  assert.strictEqual(diag2.readFiles[0].path, 'src/renderer/src/App.tsx', 'Should be App.tsx')
  assert.strictEqual(diag2.readFiles[0].source, 'cache', 'Second read must have provenance "cache"')
  console.log('✓ PASS: Repeated read accurately marked with provenance "cache".')

  // TEST 3: Conversational query with empty / non-project context
  console.log('\n[Test 3] Non-project query with empty context')
  const prompt3 = 'hello there'
  const res3 = await engine.resolveContext(prompt3, workspaceRoot)
  const diag3 = engine.getLastDiagnostics()

  assert.strictEqual(res3.required, false, 'Non-project intent required is false')
  assert.strictEqual(diag3.required, false, 'Diagnostic required is false')
  assert.strictEqual(diag3.reason, 'Conversational greeting does not require project context.')
  assert.strictEqual(diag3.selectedFiles.length, 0, 'No candidate files selected')
  assert.strictEqual(diag3.readFiles.length, 0, 'No files read')
  assert.strictEqual(diag3.formattedContextFileList.length, 0, 'Formatted context file list is empty')
  console.log('✓ PASS: Non-project context properly updates diagnostics without reading files.')

  // TEST 4: Repeated requests do not retain stale data
  console.log('\n[Test 4] Repeated requests replace diagnostic snapshot completely')
  const prompt4 = 'Check AIChatPanel.tsx'
  await engine.resolveContext(prompt4, workspaceRoot)
  const diag4 = engine.getLastDiagnostics()

  assert.strictEqual(diag4.prompt, prompt4, 'Snapshot reflects latest prompt')
  assert.strictEqual(diag4.readFiles[0].path, 'src/renderer/src/components/AIChatPanel.tsx')
  assert(!diag4.readFiles.some((f) => f.path === 'src/renderer/src/App.tsx'), 'Old App.tsx from previous request is NOT present')
  console.log('✓ PASS: Previous request files do not leak into next request diagnostics.')

  // TEST 5: Security & sensitive data exclusion
  console.log('\n[Test 5] Security verification: no file contents or credentials in diagnostic snapshot')
  assert.strictEqual(diag4.content, undefined, 'Snapshot root has no content property')
  assert.strictEqual(diag4.apiKey, undefined, 'Snapshot root has no apiKey property')
  for (const f of diag4.readFiles) {
    assert.strictEqual(f.content, undefined, 'readFiles entries have no content property')
  }
  console.log('✓ PASS: File contents and credentials completely excluded from diagnostic output.')

  // TEST 6: clearCache() cleans diagnostic state
  console.log('\n[Test 6] clearCache resets diagnostic state')
  engine.clearCache()
  assert.strictEqual(engine.getLastResult(), null, 'lastResult is null after clearCache')
  assert.strictEqual(engine.getLastDiagnostics(), null, 'lastDiagnostics is null after clearCache')
  console.log('✓ PASS: clearCache successfully cleans in-memory diagnostic state.')

  console.log('\n===========================================================')
  console.log('ALL SMART CONTEXT DIAGNOSTICS TESTS PASSED! ✓')
  console.log('===========================================================')
}

runTestSuite().catch((err) => {
  console.error('Test suite failed:', err)
  process.exit(1)
})
