// scratch/test_explicit_single_file_context.mjs
// Test suite for SmartContextEngine explicit single-file context selection and isolation

import assert from 'node:assert'

// Simulated file tree matching AI IDE workspace
const mockWorkspaceFiles = [
  'package.json',
  'tsconfig.json',
  'electron.vite.config.ts',
  'src/main/index.ts',
  'src/preload/index.ts',
  'src/shared/types.ts',
  'src/shared/commandValidator.ts',
  'src/renderer/src/App.tsx',
  'src/renderer/src/main.tsx',
  'src/renderer/src/components/EditorPane.tsx',
  'src/renderer/src/components/FileExplorer.tsx',
  'src/renderer/src/components/AIChatPanel.tsx',
  'src/renderer/src/components/Terminal.tsx',
  'src/renderer/src/components/DiffPreview.tsx',
  'src/renderer/src/components/MarkdownMessage.tsx',
  'src/renderer/src/services/agent/orchestrator.ts',
  'src/renderer/src/services/agent/smartContextEngine.ts',
  'src/renderer/src/services/agent/codebaseIndex.ts',
  'src/renderer/src/services/agent/dependencyAnalyzer.ts',
  'src/renderer/src/services/ai/geminiProvider.ts',
  'src/renderer/src/services/ai/openRouterProvider.ts'
]

const mockFileContents = {
  'src/renderer/src/App.tsx': `import React, { useState } from 'react'
import EditorPane from './components/EditorPane'
import FileExplorer from './components/FileExplorer'
import AIChatPanel from './components/AIChatPanel'

export default function App() {
  return <div>App Content</div>
}`,
  'src/renderer/src/main.tsx': `import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'

ReactDOM.createRoot(document.getElementById('root')!).render(<App />)`,
  'src/renderer/src/components/EditorPane.tsx': `import React from 'react'
export default function EditorPane() {
  return <div>Editor</div>
}`,
  'package.json': `{
  "name": "ai-ide",
  "version": "0.1.0",
  "dependencies": { "react": "^18.3.1" }
}`,
  'src/renderer/src/services/agent/codebaseIndex.ts': `export class CodebaseIndex {
  getProjectSummary() { return { test: true } }
}`,
  'src/renderer/src/services/agent/smartContextEngine.ts': `export class SmartContextEngine {
  resolveContext() { return null }
}`
}

const COMMON_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'in',
  'is', 'it', 'its', 'of', 'on', 'that', 'the', 'to', 'with', 'what', 'how',
  'where', 'which', 'who', 'why', 'can', 'could', 'does', 'do', 'this', 'our',
  'my', 'me', 'please', 'tell', 'explain', 'show', 'find'
])

class MockCache {
  constructor() {
    this.map = new Map()
    this.hits = 0
    this.misses = 0
  }
  get(path) {
    if (this.map.has(path)) {
      this.hits++
      return { path, content: this.map.get(path) }
    }
    this.misses++
    return null
  }
  set(path, content) {
    this.map.set(path, content)
  }
  getStats() {
    return { hits: this.hits, misses: this.misses, size: this.map.size }
  }
  clear() {
    this.map.clear()
  }
}

class MockDependencyAnalyzer {
  buildGraphNode(targetPath, content) {
    if (targetPath.includes('App.tsx')) {
      return {
        path: targetPath,
        directDependencies: ['src/renderer/src/components/EditorPane.tsx'],
        directImporters: ['src/renderer/src/main.tsx'],
        likelyTests: [],
        indirectImporters: [],
        potentiallyAffected: ['src/renderer/src/main.tsx']
      }
    }
    return {
      path: targetPath,
      directDependencies: [],
      directImporters: [],
      likelyTests: [],
      indirectImporters: [],
      potentiallyAffected: []
    }
  }
  findSymbolReferences(symbol, files) {
    return [
      {
        file: 'src/renderer/src/main.tsx',
        line: 5,
        snippet: `import App from './App'`
      }
    ]
  }
}

// Full test engine matching smartContextEngine.ts logic exactly
class SmartContextEngineTestHarness {
  constructor() {
    this.cache = new MockCache()
    this.dependencyAnalyzer = new MockDependencyAnalyzer()
    this.lastResult = null
    this.lastDiagnosticSnapshot = null
    this.config = {
      maxCandidates: 15,
      maxAutoReadFiles: 3,
      minScoreThreshold: 40
    }
  }

  tokenize(text) {
    const splitCamel = text.replace(/([a-z])([A-Z])/g, '$1 $2')
    const words = splitCamel.toLowerCase().split(/[^a-z0-9_.-]+/)
    const cleanTokens = []
    for (const w of words) {
      const stripped = w.replace(/^[._-]+|[._-]+$/g, '')
      if (stripped.length >= 2 && !COMMON_STOP_WORDS.has(stripped)) {
        cleanTokens.push(stripped)
      }
    }
    return cleanTokens
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
    if (trimmed.toLowerCase().includes('project')) {
      return { required: true, reason: 'Prompt references project.' }
    }
    return { required: false, reason: 'No project context required.' }
  }

  rankCandidateFiles(prompt, filePaths) {
    const promptLower = prompt.toLowerCase()
    const promptTokens = this.tokenize(prompt)
    const promptTokenSet = new Set(promptTokens)

    const explicitFileMentions = prompt.match(/[a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]{1,8}/g) || []
    const normalizedMentions = explicitFileMentions.map((m) =>
      m.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase()
    )

    const candidates = []

    const isSaveIntent = /\b(save|saving|editor|monaco|dirty|tab)\b/i.test(prompt)
    const isTerminalIntent =
      /\b(terminal|command|run_command|exec|shell|process|spawn|powershell|cmd)\b/i.test(prompt)
    const isGitIntent = /\b(git|status|diff|branch|commit|log)\b/i.test(prompt)
    const isArchIntent =
      /\b(architecture|overview|structure|entry point|components|how is the project structured)\b/i.test(
        prompt
      )
    const isConfigIntent =
      /\b(config|dependency|dependencies|package|build|vite|tsconfig|typescript)\b/i.test(prompt)
    const isTestIntent = /\b(test|tests|spec|verify|verification)\b/i.test(prompt)

    for (const relPath of filePaths) {
      const normalizedPath = relPath.replace(/\\/g, '/')
      const pathLower = normalizedPath.toLowerCase()
      const segments = pathLower.split('/')
      const fileName = segments[segments.length - 1]
      const fileTokens = this.tokenize(fileName)
      const pathTokens = this.tokenize(normalizedPath)

      let score = 0
      let isExplicit = false
      const reasons = []

      for (const mention of normalizedMentions) {
        if (pathLower === mention || pathLower.endsWith(`/${mention}`)) {
          score += 1000
          isExplicit = true
          reasons.push(`Exact path match ("${mention}")`)
          break
        } else if (fileName === mention || fileName.startsWith(mention.split('.')[0])) {
          score += 500
          isExplicit = true
          reasons.push(`Exact file name match ("${mention}")`)
          break
        }
      }

      if (promptLower.includes(pathLower)) {
        score += 800
        isExplicit = true
        reasons.push('Full path appears in prompt')
      } else if (promptLower.includes(fileName)) {
        score += 300
        reasons.push(`File name "${fileName}" appears in prompt`)
      }

      let matchingTokens = 0
      for (const token of fileTokens) {
        if (promptTokenSet.has(token)) {
          matchingTokens++
          score += 60
        }
      }
      for (const token of pathTokens) {
        if (!fileTokens.includes(token) && promptTokenSet.has(token)) {
          matchingTokens++
          score += 25
        }
      }
      if (matchingTokens > 0) reasons.push(`${matchingTokens} matching token(s)`)

      if (isSaveIntent) {
        if (
          pathLower.includes('editor') ||
          pathLower.includes('save') ||
          pathLower.includes('app.tsx') ||
          pathLower.includes('fileexplorer')
        ) {
          score += 120
          reasons.push('Matches file saving / editor domain')
        }
      }

      if (isTerminalIntent) {
        if (
          pathLower.includes('terminal') ||
          pathLower.includes('runcommand') ||
          pathLower.includes('commandvalidator') ||
          pathLower.includes('command')
        ) {
          score += 150
          reasons.push('Matches terminal / command execution domain')
        }
      }

      if (isGitIntent) {
        if (
          pathLower.includes('git') ||
          pathLower.includes('gitstatus') ||
          pathLower.includes('gitdiff') ||
          pathLower.includes('gitlog')
        ) {
          score += 150
          reasons.push('Matches Git domain')
        }
      }

      if (isArchIntent) {
        const isEntryPoint =
          fileName === 'package.json' ||
          pathLower === 'src/main/index.ts' ||
          pathLower === 'src/renderer/src/app.tsx' ||
          pathLower === 'src/renderer/src/main.tsx' ||
          pathLower === 'src/preload/index.ts' ||
          fileName === 'tsconfig.json'

        if (isEntryPoint) {
          score += 100
          reasons.push('Key architectural entry point')
        }
      }

      if (isConfigIntent) {
        if (
          fileName === 'package.json' ||
          fileName.includes('config') ||
          fileName.includes('tsconfig')
        ) {
          score += 120
          reasons.push('Project configuration file')
        }
      }

      if (isTestIntent) {
        if (
          pathLower.includes('test') ||
          pathLower.includes('spec') ||
          pathLower.includes('mock')
        ) {
          score += 100
          reasons.push('Test / verification file')
        }
      }

      // Also rank key entry points / root App when investigating code bugs
      if (promptLower.includes('bug') || promptLower.includes('fix')) {
        if (pathLower === 'src/renderer/src/main.tsx' || fileName === 'package.json') {
          score += 80
          reasons.push('Core application entry point')
        }
      }

      const depth = segments.length
      score = Math.max(0, score - depth * 2)

      if (score > 0) {
        candidates.push({
          path: normalizedPath,
          score,
          matchReason: reasons.join(', ') || 'Relevance',
          isExplicit
        })
      }
    }

    candidates.sort((a, b) => b.score - a.score)
    return candidates.slice(0, this.config.maxCandidates)
  }

  detectExplicitSingleFileRequest(prompt, rankedCandidates, filePaths = []) {
    if (!prompt) {
      return { isExplicitSingleFile: false, targetMention: null, candidate: null }
    }

    const trimmed = prompt.trim()

    // 1. Must contain an exclusivity / restriction keyword
    const hasRestriction = /\b(only|just|solely|exclusively)\b/i.test(trimmed)
    if (!hasRestriction) {
      return { isExplicitSingleFile: false, targetMention: null, candidate: null }
    }

    // 2. Reject multi-file explicit phrasing (e.g. "only the files", "only these files", "both files", "multiple files")
    if (
      /\b(?:only|just|solely|exclusively)\s+(?:the\s+|these\s+|those\s+)?files\b/i.test(trimmed) ||
      /\b(?:both|multiple)\s+files\b/i.test(trimmed) ||
      /\b(?:only|just)\s+(?:both|multiple)\b/i.test(trimmed)
    ) {
      return { isExplicitSingleFile: false, targetMention: null, candidate: null }
    }

    // 3. Extract target file candidate from explicit single-file intent patterns
    let targetMention = null

    // Pattern A: Action + restriction + [the] [file] [:] <path>
    const actionFirstMatch = trimmed.match(
      /\b(?:explain|read|inspect|show|load|open|check|analyze|review|view|fetch|get|examine|audit)\s+(?:only|just|solely|exclusively)(?:\s+the)?(?:\s+file)?(?:\s*:)?\s*[`'"<]?([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]{1,8})[`'">]?/i
    )
    if (actionFirstMatch) {
      targetMention = actionFirstMatch[1]
    }

    // Pattern B: Restriction + action + [the] [file] [:] <path>
    if (!targetMention) {
      const restrictionFirstMatch = trimmed.match(
        /\b(?:only|just|solely|exclusively)\s+(?:explain|read|inspect|show|load|open|check|analyze|review|view|fetch|get|examine|audit)(?:\s+the)?(?:\s+file)?(?:\s*:)?\s*[`'"<]?([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]{1,8})[`'">]?/i
      )
      if (restrictionFirstMatch) {
        targetMention = restrictionFirstMatch[1]
      }
    }

    // Pattern C: Focus/concentrate + restriction + on/in + [the] [file] [:] <path>
    if (!targetMention) {
      const focusMatch = trimmed.match(
        /\b(?:focus|concentrate)\s+(?:only|just|solely|exclusively)\s+(?:on|in)(?:\s+the)?(?:\s+file)?(?:\s*:)?\s*[`'"<]?([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]{1,8})[`'">]?/i
      )
      if (focusMatch) {
        targetMention = focusMatch[1]
      }
    }

    // Pattern D: Restriction + [the/this] file [:] <path>
    if (!targetMention) {
      const filePatternMatch = trimmed.match(
        /\b(?:only|just|solely|exclusively)\s+(?:the|this)?\s*file(?:\s*:)?\s*[`'"<]?([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]{1,8})[`'">]?/i
      )
      if (filePatternMatch) {
        targetMention = filePatternMatch[1]
      }
    }

    // Pattern E: Direct "only <path>" / "just <path>"
    if (!targetMention) {
      const directMatch = trimmed.match(
        /(?:^|\b)(?:only|just|solely|exclusively)\s+[`'"<]?([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]{1,8})[`'">]?(?:\s|$|[?,.:!])/i
      )
      if (directMatch) {
        targetMention = directMatch[1]
      }
    }

    // Pattern F: Single file mention with trailing/parenthetical single-file indicator
    if (!targetMention) {
      if (
        /\b(?:only\s+this\s+file|single\s+file\s+only|only\s+one\s+file|just\s+this\s+file)\b/i.test(
          trimmed
        )
      ) {
        const fileMentions = trimmed.match(/[a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]{1,8}/g) || []
        if (fileMentions.length === 1) {
          targetMention = fileMentions[0]
        }
      }
    }

    if (!targetMention) {
      return { isExplicitSingleFile: false, targetMention: null, candidate: null }
    }

    // Reject if target mention is immediately followed by conjunction with another file
    const targetIdx = trimmed.toLowerCase().indexOf(targetMention.toLowerCase())
    if (targetIdx !== -1) {
      const afterTarget = trimmed.slice(targetIdx + targetMention.length)
      if (
        /^[`'">)\]\s]*(?:and|,|or)\s*[`'"<]?[a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]{1,8}/i.test(
          afterTarget
        )
      ) {
        return { isExplicitSingleFile: false, targetMention: null, candidate: null }
      }
    }

    const cleanMention = targetMention
      .replace(/^[`'"<(\[]+|[`'">)\].,;:]+$/g, '')
      .replace(/\\/g, '/')
      .replace(/^\.?\/+/, '')
      .toLowerCase()

    let match = rankedCandidates.find((c) => {
      const candLower = c.path.replace(/\\/g, '/').toLowerCase()
      return candLower === cleanMention
    })

    if (!match) {
      match = rankedCandidates.find((c) => {
        const candLower = c.path.replace(/\\/g, '/').toLowerCase()
        return candLower.endsWith(`/${cleanMention}`)
      })
    }

    if (!match) {
      match = rankedCandidates.find((c) => {
        const candFileName = c.path.split(/[/\\]/).pop()?.toLowerCase() || ''
        return candFileName === cleanMention
      })
    }

    if (!match && filePaths.length > 0) {
      const foundPath =
        filePaths.find((p) => p.replace(/\\/g, '/').toLowerCase() === cleanMention) ||
        filePaths.find((p) => p.replace(/\\/g, '/').toLowerCase().endsWith(`/${cleanMention}`)) ||
        filePaths.find(
          (p) => (p.split(/[/\\]/).pop()?.toLowerCase() || '') === cleanMention
        )

      if (foundPath) {
        match = {
          path: foundPath.replace(/\\/g, '/'),
          score: 1000,
          matchReason: `Explicit single-file target ("${cleanMention}")`,
          isExplicit: true
        }
      }
    }

    const resolvedCandidate = match ? { ...match, isExplicit: true } : null

    return {
      isExplicitSingleFile: true,
      targetMention: cleanMention,
      candidate: resolvedCandidate
    }
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
        cacheStats: this.cache.getStats(),
        dependencyGraph: null,
        dependencyGraphs: [],
        symbolReferences: [],
        projectSummary: null
      }
      this.recordLastResult(prompt, res)
      return res
    }

    const filePaths = mockWorkspaceFiles
    const rankedCandidates = this.rankCandidateFiles(prompt, filePaths)

    const singleFileDetection = this.detectExplicitSingleFileRequest(
      prompt,
      rankedCandidates,
      filePaths
    )
    const isExplicitSingleFile = singleFileDetection.isExplicitSingleFile

    let candidatesToSelect
    let filesToRead

    if (isExplicitSingleFile) {
      if (singleFileDetection.candidate) {
        candidatesToSelect = [singleFileDetection.candidate]
        filesToRead = [singleFileDetection.candidate]
      } else {
        candidatesToSelect = []
        filesToRead = []
      }
    } else {
      candidatesToSelect = rankedCandidates
      filesToRead = rankedCandidates
        .filter((c) => c.score >= this.config.minScoreThreshold || c.isExplicit || c.score >= 500)
        .slice(0, this.config.maxAutoReadFiles)
    }

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
        content = mockFileContents[candidate.path] || `// Content of ${candidate.path}`
        source = 'disk'
        this.cache.set(candidate.path, content)
      }

      fileSourceMap.set(candidate.path, source)
      rawCandidatesToAllocate.push({
        path: candidate.path,
        content,
        score: candidate.score,
        isExplicit: candidate.isExplicit
      })
    }

    const readFiles = rawCandidatesToAllocate.map((c) => ({
      path: c.path,
      content: c.content,
      truncated: false,
      charCount: c.content.length,
      score: c.score,
      isExplicit: c.isExplicit,
      source: fileSourceMap.get(c.path) || 'disk'
    }))

    let dependencyGraph = null
    const dependencyGraphs = []
    const symbolReferences = []
    let projectSummary = null

    const promptLower = prompt.toLowerCase()
    const isStructureOrTechQuery =
      !isExplicitSingleFile &&
      (promptLower.includes('summary of this project') ||
        promptLower.includes('project structure') ||
        promptLower.includes('technologies'))

    if (readFiles.length > 0 && !isExplicitSingleFile) {
      for (const rf of readFiles) {
        const node = this.dependencyAnalyzer.buildGraphNode(rf.path, rf.content)
        if (node) dependencyGraphs.push(node)
      }
      dependencyGraph = dependencyGraphs[0] || null
      symbolReferences.push(
        ...this.dependencyAnalyzer.findSymbolReferences('App', readFiles)
      )
    }

    if (isStructureOrTechQuery) {
      projectSummary = { name: 'ai-ide', sourceFilesCount: filePaths.length }
    }

    let formattedContext = ''
    if (readFiles.length > 0 || projectSummary) {
      const summaryLines = readFiles.map(
        (f) => `- ${f.path} (Score: ${f.score}${f.isExplicit ? ', Explicitly Requested' : ''})`
      )
      const fileContentsBlocks = readFiles.map(
        (rf) => `--- File: ${rf.path}${rf.truncated ? ' (Truncated)' : ''} ---\n${rf.content}`
      )

      formattedContext = `[Smart Project Context Engine - Relevant Workspace Files]:\n${summaryLines.join('\n')}\n\n${fileContentsBlocks.join('\n\n')}`

      if (dependencyGraphs.length > 0) {
        formattedContext += `\n\n[Dependency Graph & Impact Analysis]:\n- Primary Target: ${dependencyGraphs[0].path}`
      }
      if (symbolReferences.length > 0) {
        formattedContext += `\n\n[Symbol References]:\n- ${symbolReferences[0].file}`
      }
      if (projectSummary) {
        formattedContext += `\n\n[Codebase Index & Project Understanding]:\n- Workspace Files: ${filePaths.length}`
      }
    } else if (isExplicitSingleFile && singleFileDetection.targetMention) {
      formattedContext = `[Project Context]: Explicitly requested file "${singleFileDetection.targetMention}" was not found in workspace.`
    }

    const res = {
      required: true,
      reason:
        isExplicitSingleFile && singleFileDetection.candidate
          ? `Explicit single-file request for ${singleFileDetection.candidate.path}.`
          : intent.reason,
      selectedFiles: candidatesToSelect,
      readFiles,
      droppedFiles: [],
      formattedContext,
      cacheStats: this.cache.getStats(),
      dependencyGraph,
      dependencyGraphs,
      symbolReferences,
      projectSummary
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
}

// ---------------------------------------------------------------------
// TEST SUITE EXECUTION
// ---------------------------------------------------------------------
console.log('===========================================================')
console.log('TEST SUITE: EXPLICIT SINGLE-FILE CONTEXT SELECTION')
console.log('===========================================================')

async function runTests() {
  const engine = new SmartContextEngineTestHarness()
  const workspaceRoot = 'C:/Users/bhava/Desktop/Ai Ide'

  // TEST 1: "Explain only the file src/renderer/src/App.tsx"
  console.log('\n[Test 1] "Explain only the file src/renderer/src/App.tsx"')
  {
    const res = await engine.resolveContext('Explain only the file src/renderer/src/App.tsx', workspaceRoot)
    const diag = engine.getLastDiagnostics()

    assert.strictEqual(res.required, true, 'Context should be required')
    assert.strictEqual(res.selectedFiles.length, 1, 'selectedFiles must contain ONLY the single file')
    assert.strictEqual(res.selectedFiles[0].path, 'src/renderer/src/App.tsx')
    assert.strictEqual(res.selectedFiles[0].isExplicit, true)

    assert.strictEqual(res.readFiles.length, 1, 'readFiles must contain ONLY the single file')
    assert.strictEqual(res.readFiles[0].path, 'src/renderer/src/App.tsx')

    // Diagnostics checks
    assert.strictEqual(diag.selectedFiles.length, 1, 'diag.selectedFiles must contain exactly 1 file')
    assert.strictEqual(diag.readFiles.length, 1, 'diag.readFiles must contain exactly 1 file')
    assert.deepStrictEqual(diag.formattedContextFileList, ['src/renderer/src/App.tsx'], 'formattedContextFileList must contain only App.tsx')

    // Enrichment exclusion checks
    assert.strictEqual(res.dependencyGraph, null, 'dependencyGraph must be excluded/null')
    assert.strictEqual(res.dependencyGraphs.length, 0, 'dependencyGraphs must be empty')
    assert.strictEqual(res.symbolReferences.length, 0, 'symbolReferences must be empty')
    assert.strictEqual(res.projectSummary, null, 'projectSummary must be null')

    assert.ok(res.formattedContext.includes('--- File: src/renderer/src/App.tsx ---'), 'Context has App.tsx')
    assert.ok(!res.formattedContext.includes('[Dependency Graph & Impact Analysis]'), 'Context must NOT have dependency graph')
    assert.ok(!res.formattedContext.includes('[Symbol References]'), 'Context must NOT have symbol references')
    assert.ok(!res.formattedContext.includes('main.tsx'), 'Context must NOT include other files')

    console.log('✓ PASS: Exactly 1 file selected, read, and formatted; dependency enrichment excluded.')
  }

  // TEST 1B: Exact user prompt with backticks and trailing negative instructions:
  // "Explain only the file `src/renderer/src/services/agent/smartContextEngine.ts`. Do not inspect, read, or use any other project file. Do not modify any files."
  console.log('\n[Test 1B] Exact user prompt with backticks and negative instructions')
  {
    const prompt = 'Explain only the file `src/renderer/src/services/agent/smartContextEngine.ts`. Do not inspect, read, or use any other project file. Do not modify any files.'
    const res = await engine.resolveContext(prompt, workspaceRoot)
    const diag = engine.getLastDiagnostics()

    assert.strictEqual(res.required, true, 'Context should be required')
    assert.strictEqual(res.selectedFiles.length, 1, 'selectedFiles must be exactly 1')
    assert.strictEqual(res.selectedFiles[0].path, 'src/renderer/src/services/agent/smartContextEngine.ts')
    assert.strictEqual(res.readFiles.length, 1, 'readFiles must be exactly 1')
    assert.strictEqual(res.readFiles[0].path, 'src/renderer/src/services/agent/smartContextEngine.ts')

    // Diagnostics checks
    assert.strictEqual(diag.selectedFiles.length, 1, 'diag.selectedFiles must be exactly 1')
    assert.strictEqual(diag.readFiles.length, 1, 'diag.readFiles must be exactly 1')
    assert.deepStrictEqual(
      diag.formattedContextFileList,
      ['src/renderer/src/services/agent/smartContextEngine.ts'],
      'formattedContextFileList must contain only smartContextEngine.ts'
    )

    // Enrichment exclusion
    assert.strictEqual(res.dependencyGraph, null)
    assert.strictEqual(res.dependencyGraphs.length, 0)
    assert.strictEqual(res.symbolReferences.length, 0)
    assert.strictEqual(res.projectSummary, null)

    assert.ok(res.formattedContext.includes('--- File: src/renderer/src/services/agent/smartContextEngine.ts ---'))
    assert.ok(!res.formattedContext.includes('[Dependency Graph & Impact Analysis]'))
    assert.ok(!res.formattedContext.includes('App.tsx'))
    assert.ok(!res.formattedContext.includes('orchestrator.ts'))

    console.log('✓ PASS: Exact user prompt isolates smartContextEngine.ts to exactly 1 candidate, 1 read file, and 1 formatted file.')
  }

  // TEST 2: "Read only package.json"
  console.log('\n[Test 2] "Read only package.json"')
  {
    const res = await engine.resolveContext('Read only package.json', workspaceRoot)
    const diag = engine.getLastDiagnostics()

    assert.strictEqual(res.selectedFiles.length, 1)
    assert.strictEqual(res.selectedFiles[0].path, 'package.json')
    assert.strictEqual(res.readFiles.length, 1)
    assert.strictEqual(res.readFiles[0].path, 'package.json')
    assert.deepStrictEqual(diag.formattedContextFileList, ['package.json'])
    assert.ok(!res.formattedContext.includes('[Dependency Graph & Impact Analysis]'))
    assert.ok(res.formattedContext.includes('--- File: package.json ---'))

    console.log('✓ PASS: "Read only package.json" isolates package.json with zero extra files.')
  }

  // TEST 3: Various explicit single-file phrasings
  console.log('\n[Test 3] Varied explicit single-file phrasings')
  {
    const testPhrases = [
      { prompt: 'Inspect only src/renderer/src/components/EditorPane.tsx', expected: 'src/renderer/src/components/EditorPane.tsx' },
      { prompt: 'Only read src/renderer/src/App.tsx', expected: 'src/renderer/src/App.tsx' },
      { prompt: 'Only the file src/renderer/src/App.tsx', expected: 'src/renderer/src/App.tsx' },
      { prompt: 'Focus only on src/renderer/src/App.tsx', expected: 'src/renderer/src/App.tsx' },
      { prompt: 'Explain only App.tsx', expected: 'src/renderer/src/App.tsx' },
      { prompt: 'Read only <src/renderer/src/App.tsx>', expected: 'src/renderer/src/App.tsx' },
      { prompt: 'Read only `src/renderer/src/App.tsx`', expected: 'src/renderer/src/App.tsx' },
      { prompt: 'Read only "src/renderer/src/App.tsx"', expected: 'src/renderer/src/App.tsx' },
      { prompt: "Read only 'src/renderer/src/App.tsx'", expected: 'src/renderer/src/App.tsx' },
      { prompt: 'Explain src/renderer/src/App.tsx (only this file)', expected: 'src/renderer/src/App.tsx' },
      { prompt: 'only src/renderer/src/App.tsx', expected: 'src/renderer/src/App.tsx' },
      { prompt: 'just package.json', expected: 'package.json' }
    ]

    for (const { prompt, expected } of testPhrases) {
      const res = await engine.resolveContext(prompt, workspaceRoot)
      const diag = engine.getLastDiagnostics()
      assert.strictEqual(res.selectedFiles.length, 1, `Failed for prompt: "${prompt}"`)
      assert.strictEqual(res.selectedFiles[0].path, expected, `Path mismatch for prompt: "${prompt}"`)
      assert.strictEqual(res.readFiles.length, 1, `readFiles length mismatch for prompt: "${prompt}"`)
      assert.deepStrictEqual(diag.formattedContextFileList, [expected])
      assert.strictEqual(res.dependencyGraphs.length, 0)
    }

    console.log(`✓ PASS: All ${testPhrases.length} explicit single-file phrasings correctly isolated.`)
  }

  // TEST 4: Multi-file queries with "only" or "and" are NOT single-file
  console.log('\n[Test 4] Multi-file queries with "only" preserve multi-file behavior')
  {
    const multiPrompt = 'Explain only the files src/renderer/src/App.tsx and package.json'
    const res = await engine.resolveContext(multiPrompt, workspaceRoot)
    const diag = engine.getLastDiagnostics()

    assert.ok(res.selectedFiles.length > 1, 'Must not be collapsed to a single file')
    assert.ok(diag.formattedContextFileList.length > 1, 'Multiple files read in context')
    assert.ok(res.formattedContext.includes('[Dependency Graph & Impact Analysis]'), 'Dependency enrichment preserved for multi-file')

    console.log('✓ PASS: Multi-file query properly excluded from single-file collapse.')
  }

  // TEST 5: Normal project questions retain multi-file ranking & dependency enrichment
  console.log('\n[Test 5] Normal project questions retain existing multi-file & enrichment behavior')
  {
    const normalPrompt = 'How does indexing work in codebaseIndex.ts?'
    const res = await engine.resolveContext(normalPrompt, workspaceRoot)
    const diag = engine.getLastDiagnostics()

    assert.ok(res.selectedFiles.length > 1, 'Normal query has multiple candidate files')
    assert.ok(res.readFiles.length > 1, 'Normal query auto-reads multiple files within budget')
    assert.ok(diag.formattedContextFileList.length > 1, 'Multiple files in formatted context list')
    assert.ok(res.dependencyGraph !== null, 'Dependency graph generated')
    assert.ok(res.dependencyGraphs.length > 0, 'Dependency graphs generated')
    assert.ok(res.formattedContext.includes('[Dependency Graph & Impact Analysis]'), 'Formatted context has dependency analysis')

    console.log('✓ PASS: Normal project question preserves full multi-file ranking and dependency enrichment.')
  }

  // TEST 6: Normal bug-fixing query retains multi-file behavior
  console.log('\n[Test 6] Normal bug-fixing query "Fix bug in App.tsx"')
  {
    const bugPrompt = 'Fix bug in App.tsx'
    const res = await engine.resolveContext(bugPrompt, workspaceRoot)
    const diag = engine.getLastDiagnostics()

    assert.ok(res.selectedFiles.length > 1, 'Candidate files include related files')
    assert.ok(res.readFiles.length > 1, 'Multiple files read for bug investigation')
    assert.ok(res.formattedContext.includes('[Dependency Graph & Impact Analysis]'))

    console.log('✓ PASS: Bug query maintains multi-file ranking and dependency graph.')
  }

  // TEST 7: Project structure query includes project summary
  console.log('\n[Test 7] Project structure query "What is the summary of this project?"')
  {
    const summaryPrompt = 'What is the summary of this project?'
    const res = await engine.resolveContext(summaryPrompt, workspaceRoot)

    assert.ok(res.projectSummary !== null, 'projectSummary should be present')
    assert.ok(res.formattedContext.includes('[Codebase Index & Project Understanding]'), 'Index block present')

    console.log('✓ PASS: Project structure query retains project summary.')
  }

  // TEST 8: Explicit single file that does NOT exist in workspace
  console.log('\n[Test 8] Explicit single file not found in workspace')
  {
    const missingPrompt = 'Explain only the file src/does_not_exist.ts'
    const res = await engine.resolveContext(missingPrompt, workspaceRoot)
    const diag = engine.getLastDiagnostics()

    assert.strictEqual(res.selectedFiles.length, 0, 'No files selected')
    assert.strictEqual(res.readFiles.length, 0, 'No files read')
    assert.deepStrictEqual(diag.formattedContextFileList, [], 'Formatted context file list is empty')
    assert.ok(res.formattedContext.includes('was not found in workspace'), 'Formatted context explains missing file')
    assert.ok(!res.formattedContext.includes('App.tsx'), 'Must not fall back to other files')

    console.log('✓ PASS: Missing explicit single-file does not leak other workspace files.')
  }

  // TEST 9: Provenance check (disk vs cache) for explicit single-file
  console.log('\n[Test 9] Provenance tracking (disk vs cache) for explicit single-file')
  {
    engine.cache.clear()

    // 1st run: disk
    const res1 = await engine.resolveContext('Read only src/renderer/src/App.tsx', workspaceRoot)
    assert.strictEqual(res1.readFiles[0].source, 'disk', 'First read should be from disk')
    const diag1 = engine.getLastDiagnostics()
    assert.strictEqual(diag1.readFiles[0].source, 'disk')

    // 2nd run: cache
    const res2 = await engine.resolveContext('Read only src/renderer/src/App.tsx', workspaceRoot)
    assert.strictEqual(res2.readFiles[0].source, 'cache', 'Second read should be from cache')
    const diag2 = engine.getLastDiagnostics()
    assert.strictEqual(diag2.readFiles[0].source, 'cache')

    console.log('✓ PASS: Per-file provenance (disk/cache) accurate for single-file request.')
  }

  console.log('\n===========================================================')
  console.log('ALL EXPLICIT SINGLE-FILE CONTEXT TESTS PASSED! ✓')
  console.log('===========================================================')
}

runTests().catch((err) => {
  console.error('\n❌ TEST FAILURE:', err)
  process.exit(1)
})
