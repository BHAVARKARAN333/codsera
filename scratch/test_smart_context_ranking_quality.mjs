// scratch/test_smart_context_ranking_quality.mjs
// Phase 1 Task 7: SmartContext Candidate Ranking Quality & Disambiguation Stress Test
// Verifies candidate ranking quality for ambiguous, broad, partially specified,
// and architecture-related prompts, including exact relative paths, unique basenames,
// duplicate basenames across folders, directory context disambiguation, architecture entry points,
// code-flow prompts, general knowledge exclusion, threshold filtering, camelCase tokenization,
// and ranking determinism.

import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import esbuild from 'esbuild'

// =========================================================================
// 1. Temporary Workspace Management & Safe Teardown
// =========================================================================

const tempWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-ide-ranking-quality-'))
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
  JSON.stringify({ name: 'ranking-quality-workspace', version: '1.0.0' }, null, 2),
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

const engineMod = await import(
  'data:text/javascript;base64,' + Buffer.from(engineBundle.outputFiles[0].text).toString('base64')
)
const { SmartContextEngine } = engineMod

// =========================================================================
// 3. Mock Disk Files & Electron API Setup
// =========================================================================

const mockDiskFiles = new Map()

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
    saveWorkspaceIndex: async () => ({ success: true })
  }
}

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
function recordTest(name, passed, details = '', diagnosticData = null) {
  testResults.push({ name, passed, details, diagnosticData })
  const icon = passed ? '✅ PASS' : '❌ FAIL'
  console.log(`${icon}: ${name}${details ? `\n   ${details}` : ''}`)
}

console.log('='.repeat(80))
console.log('Phase 1 Task 7: SmartContext Candidate Ranking Quality Stress Test')
console.log('='.repeat(80))
console.log(`Temporary Workspace: ${normalizedWorkspaceRoot}\n`)

// =========================================================================
// Scenario 1: Exact relative file path in the prompt selects the exact requested file
// =========================================================================
console.log('--- Scenario 1: Exact Relative File Path Selection ---')
try {
  setWorkspaceFiles({
    'src/renderer/src/components/ChatView.tsx': 'export function ChatView() { return <div>Chat</div>; }',
    'src/renderer/src/components/Sidebar.tsx': 'export function Sidebar() { return <div>Sidebar</div>; }',
    'src/renderer/src/App.tsx': 'export function App() { return <ChatView />; }',
    'src/main/index.ts': 'export function initMain() {}'
  })

  const engine = new SmartContextEngine()
  const result = await engine.resolveContext(
    'Explain src/renderer/src/components/ChatView.tsx and its responsibilities',
    normalizedWorkspaceRoot
  )

  assert.strictEqual(result.required, true, 'SmartContext should be required')
  assert.ok(result.selectedFiles.length >= 1, 'Should find candidate files')
  const topCandidate = result.selectedFiles[0]
  assert.strictEqual(
    topCandidate.path,
    'src/renderer/src/components/ChatView.tsx',
    'Exact relative path must be ranked #1'
  )
  assert.strictEqual(topCandidate.isExplicit, true, 'Must be marked isExplicit=true')
  assert.ok(
    topCandidate.score >= 1800,
    `Exact relative path score should be high (score: ${topCandidate.score})`
  )
  assert.ok(
    topCandidate.matchReason.includes('Exact path match') ||
      topCandidate.matchReason.includes('Full path appears in prompt'),
    `Match reason must denote path match: ${topCandidate.matchReason}`
  )

  recordTest(
    'Scenario 1: Exact relative file path selects target file',
    true,
    `Top candidate: ${topCandidate.path} (score: ${topCandidate.score}, reason: "${topCandidate.matchReason}")`,
    { topCandidate }
  )
} catch (err) {
  recordTest('Scenario 1: Exact relative file path selects target file', false, err.message)
}

// =========================================================================
// Scenario 2: A unique basename selects the correct file
// =========================================================================
console.log('\n--- Scenario 2: Unique Basename Selection ---')
try {
  setWorkspaceFiles({
    'src/services/uniqueProcessor.ts': 'export class UniqueProcessor { process() { return true; } }',
    'src/utils/helpers.ts': 'export function helper() {}',
    'src/components/Header.tsx': 'export function Header() {}',
    'src/index.ts': 'export function bootstrap() {}'
  })

  const engine = new SmartContextEngine()
  const result = await engine.resolveContext(
    'Explain the logic and processing steps in uniqueProcessor.ts',
    normalizedWorkspaceRoot
  )

  assert.strictEqual(result.required, true, 'Context should be required')
  assert.ok(result.selectedFiles.length >= 1, 'Should find candidate')
  const topCandidate = result.selectedFiles[0]
  assert.strictEqual(
    topCandidate.path,
    'src/services/uniqueProcessor.ts',
    'uniqueProcessor.ts must be ranked #1'
  )
  assert.strictEqual(topCandidate.isExplicit, true, 'Candidate must have isExplicit=true')
  assert.ok(
    topCandidate.matchReason.includes('Exact file name match') ||
      topCandidate.matchReason.includes('appears in prompt'),
    `Match reason should reflect filename match: ${topCandidate.matchReason}`
  )
  assert.ok(
    topCandidate.score >= 700,
    `Basename match score should be >= 700 (actual: ${topCandidate.score})`
  )

  // Unrelated files should have lower or zero score
  const helperCandidate = result.selectedFiles.find((f) => f.path === 'src/utils/helpers.ts')
  assert.ok(!helperCandidate, 'Unrelated helpers.ts should have 0 score and be excluded from candidates')

  recordTest(
    'Scenario 2: Unique basename selects the correct file',
    true,
    `Top candidate: ${topCandidate.path} (score: ${topCandidate.score}, reason: "${topCandidate.matchReason}")`,
    { topCandidate }
  )
} catch (err) {
  recordTest('Scenario 2: Unique basename selects the correct file', false, err.message)
}

// =========================================================================
// Scenario 3: Duplicate basenames across folders are handled predictably
// =========================================================================
console.log('\n--- Scenario 3: Duplicate Basenames Across Folders ---')
try {
  setWorkspaceFiles({
    'src/renderer/types.ts': 'export interface RendererState { status: string; }',
    'src/main/types.ts': 'export interface MainConfig { port: number; }',
    'src/shared/types.ts': 'export interface CommonDTO { id: string; }'
  })

  const engine = new SmartContextEngine()
  const result = await engine.resolveContext(
    'What types and interfaces are declared in types.ts?',
    normalizedWorkspaceRoot
  )

  assert.strictEqual(result.required, true, 'Context should be required')
  assert.strictEqual(result.selectedFiles.length, 3, 'All 3 duplicate files should be selected')

  // All 3 files share the exact same depth (3) and basename match points
  const scores = result.selectedFiles.map((f) => f.score)
  assert.strictEqual(scores[0], scores[1], 'Duplicate basenames with equal depth have equal score')
  assert.strictEqual(scores[1], scores[2], 'Duplicate basenames with equal depth have equal score')

  // Predictable sorting: JavaScript's stable sort preserves index traversal order
  const order1 = result.selectedFiles.map((f) => f.path)
  const result2 = await engine.resolveContext(
    'What types and interfaces are declared in types.ts?',
    normalizedWorkspaceRoot
  )
  const order2 = result2.selectedFiles.map((f) => f.path)

  assert.deepStrictEqual(
    order1,
    order2,
    'Duplicate basenames must resolve in stable, deterministic order across runs'
  )

  recordTest(
    'Scenario 3: Duplicate basenames across folders handled predictably',
    true,
    `Order: [${order1.join(', ')}] with equal scores [${scores.join(', ')}]`,
    { order: order1, scores }
  )
} catch (err) {
  recordTest('Scenario 3: Duplicate basenames across folders handled predictably', false, err.message)
}

// =========================================================================
// Scenario 4: Directory or module context disambiguates files with the same basename
// =========================================================================
console.log('\n--- Scenario 4: Directory/Module Context Disambiguation ---')
try {
  setWorkspaceFiles({
    'src/renderer/types.ts': 'export interface RendererState { status: string; }',
    'src/main/types.ts': 'export interface MainConfig { port: number; }',
    'src/shared/types.ts': 'export interface CommonDTO { id: string; }'
  })

  const engine = new SmartContextEngine()

  // 4A: User mentions 'renderer' directory context
  const resRenderer = await engine.resolveContext(
    'Explain the types.ts file in renderer',
    normalizedWorkspaceRoot
  )
  assert.strictEqual(
    resRenderer.selectedFiles[0].path,
    'src/renderer/types.ts',
    'Renderer types.ts must be ranked #1 when renderer context is provided'
  )
  assert.ok(
    resRenderer.selectedFiles[0].score > resRenderer.selectedFiles[1].score,
    `Top score (${resRenderer.selectedFiles[0].score}) must exceed second score (${resRenderer.selectedFiles[1].score})`
  )
  assert.ok(
    resRenderer.selectedFiles[0].matchReason.includes('matching token') ||
      resRenderer.selectedFiles[0].matchReason.includes('appears in prompt'),
    'Reason must indicate directory token overlap'
  )

  // 4B: User mentions 'main' directory context
  const resMain = await engine.resolveContext('Explain the types.ts file in main', normalizedWorkspaceRoot)
  assert.strictEqual(
    resMain.selectedFiles[0].path,
    'src/main/types.ts',
    'Main types.ts must be ranked #1 when main context is provided'
  )
  assert.ok(
    resMain.selectedFiles[0].score > resMain.selectedFiles[1].score,
    `Top score (${resMain.selectedFiles[0].score}) must exceed second score (${resMain.selectedFiles[1].score})`
  )

  // 4C: User mentions 'shared' directory context
  const resShared = await engine.resolveContext(
    'Explain the types.ts file in shared',
    normalizedWorkspaceRoot
  )
  assert.strictEqual(
    resShared.selectedFiles[0].path,
    'src/shared/types.ts',
    'Shared types.ts must be ranked #1 when shared context is provided'
  )
  assert.ok(
    resShared.selectedFiles[0].score > resShared.selectedFiles[1].score,
    `Top score (${resShared.selectedFiles[0].score}) must exceed second score (${resShared.selectedFiles[1].score})`
  )

  recordTest(
    'Scenario 4: Directory or module context disambiguates duplicate basenames',
    true,
    `Renderer disambiguated (score ${resRenderer.selectedFiles[0].score} > ${resRenderer.selectedFiles[1].score}); Main disambiguated (score ${resMain.selectedFiles[0].score} > ${resMain.selectedFiles[1].score}); Shared disambiguated (score ${resShared.selectedFiles[0].score} > ${resShared.selectedFiles[1].score})`
  )
} catch (err) {
  recordTest(
    'Scenario 4: Directory or module context disambiguates duplicate basenames',
    false,
    err.message
  )
}

// =========================================================================
// Scenario 5: Broad prompts such as "Explain the project architecture" select relevant architecture files
// =========================================================================
console.log('\n--- Scenario 5: Broad Architecture Prompts ---')
try {
  setWorkspaceFiles({
    'package.json': JSON.stringify({ name: 'ai-ide-demo', main: 'src/main/index.ts' }),
    'src/main/index.ts': 'export function startApp() { console.log("Starting main"); }',
    'src/renderer/src/App.tsx': 'export function App() { return <div>IDE Root</div>; }',
    'src/preload/index.ts': 'export const api = {};',
    'tsconfig.json': JSON.stringify({ compilerOptions: {} }),
    'src/utils/mathHelper.ts': 'export function add(a: number, b: number) { return a + b; }',
    'src/utils/formatDate.ts': 'export function formatDate(d: Date) { return d.toISOString(); }'
  })

  const engine = new SmartContextEngine()
  const result = await engine.resolveContext(
    'Explain the project architecture and structure',
    normalizedWorkspaceRoot
  )

  assert.strictEqual(result.required, true, 'Architecture prompt must require context')
  assert.ok(result.selectedFiles.length >= 3, 'Must select architectural files')

  const selectedPaths = result.selectedFiles.map((f) => f.path)
  assert.ok(selectedPaths.includes('package.json'), 'Must include package.json')
  assert.ok(selectedPaths.includes('src/main/index.ts'), 'Must include src/main/index.ts')
  assert.ok(selectedPaths.includes('src/renderer/src/App.tsx'), 'Must include App.tsx')

  // Check that architectural files received the entry point bonus
  for (const f of result.selectedFiles.slice(0, 3)) {
    assert.ok(
      f.matchReason.includes('Key architectural entry point') || f.matchReason.includes('configuration'),
      `Architectural file ${f.path} must have architecture/config reason: "${f.matchReason}"`
    )
  }

  // Unrelated utilities must be excluded
  assert.ok(!selectedPaths.includes('src/utils/mathHelper.ts'), 'mathHelper.ts must not be selected')
  assert.ok(!selectedPaths.includes('src/utils/formatDate.ts'), 'formatDate.ts must not be selected')

  recordTest(
    'Scenario 5: Broad prompts select relevant architecture files',
    true,
    `Selected: [${selectedPaths.join(', ')}]. Utilities mathHelper and formatDate cleanly excluded.`,
    { selectedPaths }
  )
} catch (err) {
  recordTest('Scenario 5: Broad prompts select relevant architecture files', false, err.message)
}

// =========================================================================
// Scenario 6: Code-flow prompts select files relevant to the described flow
// =========================================================================
console.log('\n--- Scenario 6: Code-Flow Prompts ---')
try {
  setWorkspaceFiles({
    'src/renderer/src/components/AIChatPanel.tsx': 'export function AIChatPanel() { /* chat view */ }',
    'src/renderer/src/services/agent/orchestrator.ts':
      'export class AgentOrchestrator { /* orchestrator */ }',
    'src/renderer/src/services/ai/geminiProvider.ts':
      'export class GeminiProvider { /* provider implementation */ }',
    'src/renderer/src/services/agent/smartContextEngine.ts':
      'export class SmartContextEngine { /* engine */ }',
    'src/utils/stringUtils.ts': 'export function capitalize(s: string) { return s; }',
    'src/main/updater.ts': 'export function checkForUpdates() {}'
  })

  const engine = new SmartContextEngine()
  const prompt =
    'Trace how requests flow from AIChatPanel through orchestrator to geminiProvider'
  const result = await engine.resolveContext(prompt, normalizedWorkspaceRoot)

  assert.strictEqual(result.required, true, 'Code flow query must require context')
  assert.ok(result.selectedFiles.length >= 3, 'Must select participating flow files')

  const top3Paths = result.selectedFiles.slice(0, 3).map((f) => f.path)
  assert.ok(
    top3Paths.includes('src/renderer/src/components/AIChatPanel.tsx'),
    'AIChatPanel must be in top candidates'
  )
  assert.ok(
    top3Paths.includes('src/renderer/src/services/agent/orchestrator.ts'),
    'orchestrator.ts must be in top candidates'
  )
  assert.ok(
    top3Paths.includes('src/renderer/src/services/ai/geminiProvider.ts'),
    'geminiProvider.ts must be in top candidates'
  )

  // Verify high scores and AI flow domain matching
  const orchestratorCand = result.selectedFiles.find(
    (f) => f.path === 'src/renderer/src/services/agent/orchestrator.ts'
  )
  assert.ok(
    orchestratorCand.matchReason.includes('Matches AI / chat orchestrator / provider domain'),
    'Orchestrator must match AI domain intent'
  )

  // Non-flow files must NOT be in top 3
  assert.ok(!top3Paths.includes('src/utils/stringUtils.ts'), 'stringUtils must not be in top flow files')
  assert.ok(!top3Paths.includes('src/main/updater.ts'), 'updater must not be in top flow files')

  recordTest(
    'Scenario 6: Code-flow prompts select files relevant to the described flow',
    true,
    `Top flow files: [${top3Paths.join(', ')}]. Non-flow utilities excluded from top ranking.`,
    { top3Paths }
  )
} catch (err) {
  recordTest(
    'Scenario 6: Code-flow prompts select files relevant to the described flow',
    false,
    err.message
  )
}

// =========================================================================
// Scenario 7: General knowledge questions avoid unnecessary workspace context
// =========================================================================
console.log('\n--- Scenario 7: General Knowledge Questions Avoid Context ---')
try {
  setWorkspaceFiles({
    'src/renderer/App.tsx': 'export function App() {}',
    'src/main/index.ts': 'export function main() {}'
  })

  const generalQuestions = [
    'What is Python?',
    'What is Python? Explain in two simple sentences.',
    'How does quicksort work?',
    'Explain recursion with an example.',
    'What is Docker?',
    'How does https work?',
    'Hi, how are you?'
  ]

  const engine = new SmartContextEngine()
  for (const q of generalQuestions) {
    const res = await engine.resolveContext(q, normalizedWorkspaceRoot)
    assert.strictEqual(
      res.required,
      false,
      `Prompt "${q}" must return required=false (reason: ${res.reason})`
    )
    assert.strictEqual(res.selectedFiles.length, 0, `Prompt "${q}" must select 0 files`)
    assert.strictEqual(res.readFiles.length, 0, `Prompt "${q}" must read 0 files`)
    assert.strictEqual(res.formattedContext, '', `Prompt "${q}" must produce empty formatted context`)
  }

  recordTest(
    'Scenario 7: General knowledge questions avoid unnecessary context',
    true,
    `All ${generalQuestions.length} conceptual and greeting prompts returned required=false with 0 files read.`
  )
} catch (err) {
  recordTest('Scenario 7: General knowledge questions avoid unnecessary context', false, err.message)
}

// =========================================================================
// Scenario 8: Ambiguous prompts with multiple equally relevant files produce stable, explainable results
// =========================================================================
console.log('\n--- Scenario 8: Ambiguous Prompts with Equal Relevance ---')
try {
  setWorkspaceFiles({
    'src/services/clientService.ts': 'export class ClientService { execute() { return "client"; } }',
    'src/services/serverService.ts': 'export class ServerService { execute() { return "server"; } }',
    'src/utils/logger.ts': 'export function log(msg: string) {}'
  })

  const engine = new SmartContextEngine()
  const prompt = 'Compare the service architecture between clientService and serverService'

  const run1 = await engine.resolveContext(prompt, normalizedWorkspaceRoot)
  const run2 = await engine.resolveContext(prompt, normalizedWorkspaceRoot)
  const run3 = await engine.resolveContext(prompt, normalizedWorkspaceRoot)

  assert.strictEqual(run1.required, true, 'Context should be required')
  assert.strictEqual(run1.selectedFiles.length, 2, 'Both services should be selected')

  const cand1 = run1.selectedFiles[0]
  const cand2 = run1.selectedFiles[1]

  // Verify equal scores and explainability
  assert.strictEqual(
    cand1.score,
    cand2.score,
    `Both services should have equal scores (cand1: ${cand1.score}, cand2: ${cand2.score})`
  )
  assert.ok(
    cand1.matchReason.length > 0 && cand2.matchReason.length > 0,
    'Both candidates must have explainable match reasons'
  )

  // Verify determinism across repeated executions
  const paths1 = run1.selectedFiles.map((f) => f.path)
  const paths2 = run2.selectedFiles.map((f) => f.path)
  const paths3 = run3.selectedFiles.map((f) => f.path)

  assert.deepStrictEqual(paths1, paths2, 'Run 1 and Run 2 must have identical order')
  assert.deepStrictEqual(paths2, paths3, 'Run 2 and Run 3 must have identical order')

  recordTest(
    'Scenario 8: Ambiguous prompts with equal relevance produce stable, explainable results',
    true,
    `Stable ordering across 3 runs: [${paths1.join(', ')}] with equal score ${cand1.score}`,
    { cand1, cand2 }
  )
} catch (err) {
  recordTest(
    'Scenario 8: Ambiguous prompts with equal relevance produce stable, explainable results',
    false,
    err.message
  )
}

// =========================================================================
// Scenario 9: Low-relevance candidates below configured score threshold are excluded
// =========================================================================
console.log('\n--- Scenario 9: Exclusion of Low-Relevance Candidates (< minScoreThreshold) ---')
try {
  // Candidate A: highly relevant (scores ~250+)
  // Candidate B: marginal token match with score < 40 (minScoreThreshold)
  // Candidate C: zero score
  setWorkspaceFiles({
    'src/services/commandValidator.ts': 'export class CommandValidator { validate() { return true; } }',
    'src/tab/view.ts': 'export function view() { return "tab"; }', // Matches path token "tab" (single directory token = 25 - depth pts, < 40)
    'src/unrelated/logger.ts': 'export function log() {}' // Score 0
  })

  const engine = new SmartContextEngine()
  // Prompt references command validation and has incidental mention of 'tab'
  const result = await engine.resolveContext(
    'How does commandValidator validate terminal commands in the tab?',
    normalizedWorkspaceRoot
  )

  assert.strictEqual(result.required, true, 'Context should be required')

  // In candidate ranking, commandValidator should be high scoring
  const validatorCand = result.selectedFiles.find((f) => f.path === 'src/services/commandValidator.ts')
  assert.ok(validatorCand, 'commandValidator must be selected')
  assert.ok(validatorCand.score >= 40, `commandValidator score must be >= 40 (${validatorCand.score})`)

  // In readFiles, files with score < 40 must be filtered out by minScoreThreshold:
  // filesToRead = rankedCandidates.filter(c => c.score >= this.config.minScoreThreshold || c.isExplicit || c.score >= 500)
  const tabRead = result.readFiles.find((f) => f.path === 'src/tab/view.ts')
  assert.ok(
    !tabRead,
    'src/tab/view.ts with score < 40 must NOT be included in readFiles'
  )

  // Zero-score file src/unrelated/logger.ts should not even appear in selectedFiles
  const loggerSelected = result.selectedFiles.find((f) => f.path === 'src/unrelated/logger.ts')
  assert.ok(!loggerSelected, 'Zero-score logger.ts must be completely excluded from selectedFiles')

  recordTest(
    'Scenario 9: Low-relevance candidates below score threshold excluded from reading',
    true,
    `commandValidator (score ${validatorCand.score}) read; marginal tab view (< 40) excluded from readFiles; zero-score logger excluded.`,
    { validatorScore: validatorCand.score }
  )
} catch (err) {
  recordTest(
    'Scenario 9: Low-relevance candidates below score threshold excluded from reading',
    false,
    err.message
  )
}

// =========================================================================
// Scenario 10: Relevant files are not excluded just because unrelated candidates have higher scores
// =========================================================================
console.log('\n--- Scenario 10: Multi-Topic Relevant Candidates Retention ---')
try {
  setWorkspaceFiles({
    'src/terminal/terminalView.ts': 'export class TerminalView { render() {} }',
    'src/editor/monacoEditor.ts': 'export class MonacoEditor { save() {} }',
    'src/unrelated/randomUtility.ts': 'export function util() {}'
  })

  const engine = new SmartContextEngine()
  // Prompt explicitly asks about both terminalView and editor
  const result = await engine.resolveContext(
    'How does the editor interact with terminalView?',
    normalizedWorkspaceRoot
  )

  assert.strictEqual(result.required, true, 'Context should be required')
  assert.strictEqual(result.selectedFiles.length, 2, 'Both relevant files should be selected')
  assert.strictEqual(result.readFiles.length, 2, 'Both relevant files should be read')

  const terminalCand = result.selectedFiles.find((f) => f.path === 'src/terminal/terminalView.ts')
  const editorCand = result.selectedFiles.find((f) => f.path === 'src/editor/monacoEditor.ts')

  assert.ok(terminalCand, 'terminalView must be present')
  assert.ok(editorCand, 'monacoEditor must be present')
  assert.ok(
    terminalCand.score > editorCand.score,
    `terminalView score (${terminalCand.score}) is higher than editor (${editorCand.score})`
  )

  // Confirm monacoEditor was NOT dropped despite having lower score
  const readPaths = result.readFiles.map((f) => f.path)
  assert.ok(readPaths.includes('src/editor/monacoEditor.ts'), 'monacoEditor must be included in readFiles')
  assert.ok(
    readPaths.includes('src/terminal/terminalView.ts'),
    'terminalView must be included in readFiles'
  )

  recordTest(
    'Scenario 10: Relevant files not excluded just because another candidate has higher score',
    true,
    `Both terminalView (score ${terminalCand.score}) and monacoEditor (score ${editorCand.score}) retained and read.`,
    { terminalScore: terminalCand.score, editorScore: editorCand.score }
  )
} catch (err) {
  recordTest(
    'Scenario 10: Relevant files not excluded just because another candidate has higher score',
    false,
    err.message
  )
}

// =========================================================================
// Scenario 11: CamelCase names, partial filenames, and common abbreviations are matched as intended
// =========================================================================
console.log('\n--- Scenario 11: CamelCase, Partial Filename, & Token Splitting ---')
try {
  setWorkspaceFiles({
    'src/components/AIChatPanel.tsx': 'export function AIChatPanel() {}',
    'src/services/commandValidator.ts': 'export class CommandValidator {}',
    'src/services/smartContextEngine.ts': 'export class SmartContextEngine {}',
    'src/utils/fileExplorer.ts': 'export function fileExplorer() {}'
  })

  const engine = new SmartContextEngine()

  // 11A: CamelCase tokens: "AIChatPanel" -> "ai", "chat", "panel"
  const tokensAI = engine.tokenize('AIChatPanel')
  assert.deepStrictEqual(
    tokensAI,
    ['ai', 'chat', 'panel'],
    'AIChatPanel must split into [ai, chat, panel]'
  )
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

  // 11B: Query with lowercase words "ai chat panel component" matches AIChatPanel.tsx
  const resAI = await engine.resolveContext(
    'How does the ai chat panel component render?',
    normalizedWorkspaceRoot
  )
  assert.ok(resAI.selectedFiles.length >= 1, 'Should find candidates for AI chat panel')
  assert.strictEqual(
    resAI.selectedFiles[0].path,
    'src/components/AIChatPanel.tsx',
    'AIChatPanel must be ranked #1 for query "ai chat panel component"'
  )
  assert.ok(
    resAI.selectedFiles[0].matchReason.includes('matching token'),
    'Match reason must denote token overlap'
  )

  // 11C: Partial filename: "Validate terminal command" matches commandValidator.ts
  const resCmd = await engine.resolveContext(
    'Validate the terminal command before execution',
    normalizedWorkspaceRoot
  )
  assert.ok(resCmd.selectedFiles.length >= 1, 'Should find candidates for commandValidator')
  assert.strictEqual(
    resCmd.selectedFiles[0].path,
    'src/services/commandValidator.ts',
    'commandValidator must be ranked #1 for query "Validate the terminal command"'
  )

  // 11D: LowerCamelCase: "smartContextEngine" -> "smart", "context", "engine"
  const tokensSmart = engine.tokenize('smartContextEngine')
  assert.deepStrictEqual(
    tokensSmart,
    ['smart', 'context', 'engine'],
    'smartContextEngine must split into [smart, context, engine]'
  )

  // 11E: Multi-term partial query: "How does smart context work in this project?" matches smartContextEngine.ts
  const resSmart = await engine.resolveContext(
    'How does smart context work in this project?',
    normalizedWorkspaceRoot
  )
  assert.strictEqual(
    resSmart.selectedFiles[0].path,
    'src/services/smartContextEngine.ts',
    'smartContextEngine must be ranked #1 for query "How does smart context work in this project?"'
  )

  // 11F: CamelCase basename query: "Explain the fileExplorer component" matches fileExplorer.ts
  const resExp = await engine.resolveContext(
    'Explain the fileExplorer component',
    normalizedWorkspaceRoot
  )
  assert.strictEqual(
    resExp.selectedFiles[0].path,
    'src/utils/fileExplorer.ts',
    'fileExplorer must be ranked #1 for query "Explain the fileExplorer component"'
  )

  // 11G: Trailing token matching:
  // When a query only mentions the trailing word of a camelCase name without extension (e.g. "explorer"):
  const trailingOnlyQuery = 'Where is the explorer tree rendered?'
  const resTrailing = await engine.resolveContext(trailingOnlyQuery, normalizedWorkspaceRoot)
  const trailingMatched = resTrailing.selectedFiles.some((f) => f.path === 'src/utils/fileExplorer.ts')
  assert.strictEqual(
    trailingMatched,
    true,
    'fileExplorer.ts must match query mentioning trailing token explorer'
  )

  console.log(`   [Verification] AIChatPanel matched by "ai chat panel": true`)
  console.log(`   [Verification] commandValidator matched by "Validate command": true`)
  console.log(`   [Verification] smartContextEngine matched by "smart context": true`)
  console.log(`   [Verification] fileExplorer matched by "fileExplorer": true`)
  console.log(`   [Verification] Trailing token without extension ("explorer" vs "fileExplorer.ts") matched: true`)

  recordTest(
    'Scenario 11: CamelCase names, partial filenames, and abbreviations matched correctly',
    true,
    'AIChatPanel, commandValidator, smartContext, and fileExplorer verified; trailing token matching confirmed.',
    { trailingMatched }
  )
} catch (err) {
  recordTest(
    'Scenario 11: CamelCase names, partial filenames, and abbreviations matched correctly',
    false,
    err.message
  )
}

// =========================================================================
// Scenario 12: Repeated identical prompts produce consistent ranking and selected files
// =========================================================================
console.log('\n--- Scenario 12: Determinism Across Repeated Runs ---')
try {
  setWorkspaceFiles({
    'src/orchestrator.ts': 'export class Orchestrator {}',
    'src/smartContext.ts': 'export class SmartContext {}',
    'src/agentPlanner.ts': 'export class Planner {}',
    'src/chatView.tsx': 'export function ChatView() {}',
    'src/contextCache.ts': 'export class Cache {}',
    'src/contextDeduplicator.ts': 'export class Dedup {}',
    'src/contextBudgetManager.ts': 'export class Budget {}',
    'src/dependencyAnalyzer.ts': 'export class Analyzer {}',
    'src/codebaseIndex.ts': 'export class Indexer {}',
    'src/tools/readFileTool.ts': 'export class ReadFileTool {}'
  })

  const engine = new SmartContextEngine()
  const prompt =
    'Trace how the orchestrator creates a plan and utilizes smartContext to analyze dependencies'

  const iterations = 5
  const runSnapshots = []

  for (let i = 0; i < iterations; i++) {
    engine.clearCache()
    const res = await engine.resolveContext(prompt, normalizedWorkspaceRoot)
    runSnapshots.push({
      selectedPaths: res.selectedFiles.map((f) => f.path),
      selectedScores: res.selectedFiles.map((f) => f.score),
      selectedReasons: res.selectedFiles.map((f) => f.matchReason),
      readPaths: res.readFiles.map((f) => f.path)
    })
  }

  const baseline = runSnapshots[0]
  for (let i = 1; i < runSnapshots.length; i++) {
    const current = runSnapshots[i]
    assert.deepStrictEqual(
      current.selectedPaths,
      baseline.selectedPaths,
      `Run ${i} selectedPaths differs from baseline`
    )
    assert.deepStrictEqual(
      current.selectedScores,
      baseline.selectedScores,
      `Run ${i} selectedScores differs from baseline`
    )
    assert.deepStrictEqual(
      current.selectedReasons,
      baseline.selectedReasons,
      `Run ${i} selectedReasons differs from baseline`
    )
    assert.deepStrictEqual(
      current.readPaths,
      baseline.readPaths,
      `Run ${i} readPaths differs from baseline`
    )
  }

  recordTest(
    'Scenario 12: Repeated identical prompts produce 100% consistent ranking and selection',
    true,
    `5 repeated runs identical across all ${baseline.selectedPaths.length} candidates and ${baseline.readPaths.length} read files.`,
    { selectedPaths: baseline.selectedPaths, readPaths: baseline.readPaths }
  )
} catch (err) {
  recordTest(
    'Scenario 12: Repeated identical prompts produce 100% consistent ranking and selection',
    false,
    err.message
  )
}

// =========================================================================
// Final Summary & Reporting
// =========================================================================
console.log('\n' + '='.repeat(80))
console.log('Test Summary: SmartContext Candidate Ranking Quality Stress Test')
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
