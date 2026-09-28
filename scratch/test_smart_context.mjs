// Smart Project Context Engine Unit & Integration Verification Suite

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
  'src/renderer/src/services/ai/geminiProvider.ts',
  'src/renderer/src/services/ai/openRouterProvider.ts',
  'src/renderer/src/services/tools/listFilesTool.ts',
  'src/renderer/src/services/tools/readFileTool.ts',
  'src/renderer/src/services/tools/createFileTool.ts',
  'src/renderer/src/services/tools/editFileTool.ts',
  'src/renderer/src/services/tools/runCommandTool.ts',
  'src/renderer/src/services/tools/gitStatusTool.ts',
  'src/renderer/src/services/tools/gitDiffTool.ts',
  'src/renderer/src/services/tools/gitLogTool.ts',
  'src/utils/math.ts',
  'src/utils/math.test.ts',
  'assets/icon.png',
  'node_modules/package/index.js'
]

// Mock SmartContextEngine logic in ESM
const BINARY_AND_ASSET_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'ico', 'webp', 'svg', 'mp4', 'mp3', 'pdf', 'zip', 'tar', 'gz', 'exe', 'dll', 'bin'])
const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'out', '.vscode', '.idea', '.cache'])
const COMMON_STOP_WORDS = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'in', 'is', 'it', 'its', 'of', 'on', 'that', 'the', 'to', 'with', 'what', 'how', 'where', 'which', 'who', 'why', 'can', 'could', 'does', 'do', 'this', 'our', 'my', 'me', 'please', 'tell', 'explain', 'show', 'find'])

class SmartContextEngine {
  constructor(config = {}) {
    this.config = {
      maxCandidates: config.maxCandidates ?? 15,
      maxAutoReadFiles: config.maxAutoReadFiles ?? 3,
      maxFileChars: config.maxFileChars ?? 12000,
      maxTotalContextChars: config.maxTotalContextChars ?? 30000,
      minScoreThreshold: config.minScoreThreshold ?? 40
    }
    this.fileCache = new Map()
    this.readCallCount = 0
  }

  clearCache() {
    this.fileCache.clear()
  }

  invalidateFile(relativePath) {
    const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase()
    for (const key of this.fileCache.keys()) {
      if (key.toLowerCase() === normalized) {
        this.fileCache.delete(key)
      }
    }
  }

  isProjectContextRequired(prompt, workspaceRoot) {
    if (!workspaceRoot) return { required: false, reason: 'No workspace open' }
    const trimmed = prompt.trim()
    if (!trimmed) return { required: false, reason: 'Empty prompt' }

    const greetingRegex = /^(hi|hello|hey|greetings|good morning|who are you|what can you do|help)\b[!.?]*$/i
    if (greetingRegex.test(trimmed)) return { required: false, reason: 'Greeting' }

    const fileMentionRegex = /([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]{1,8})/
    if (fileMentionRegex.test(trimmed)) return { required: true, reason: 'Explicit file mentioned' }

    const projectIndicators = [
      'this project', 'the project', 'our project', 'this codebase', 'the codebase',
      'project architecture', 'file save', 'file saving', 'terminal command',
      'command execution', 'git status', 'git diff', 'git log', 'how does the project',
      'where is', 'where are', 'find where', 'fix this problem', 'fix the bug'
    ]
    const lower = trimmed.toLowerCase()
    for (const ind of projectIndicators) {
      if (lower.includes(ind)) return { required: true, reason: `Indicator: ${ind}` }
    }

    const generalConceptQuestions = [
      /^(what is|what are|explain|describe|define)\s+(python|javascript|typescript|rust|c\+\+|java|go|recursion|binary search|quicksort|rest api|graphql|sql|nosql|docker|kubernetes|oauth|jwt|http|https|css|html|polymorphism|encapsulation|inheritance|solid principles|git|react|vue|angular)\b[?.]*$/i,
      /^(how does|how do)\s+(recursion|binary search|quicksort|https|http|garbage collection|event loop|async\/await|dns|tcp|udp)\s+(work|function)\b[?.]*$/i
    ]
    for (const pattern of generalConceptQuestions) {
      if (pattern.test(trimmed)) return { required: false, reason: 'General concept' }
    }

    const implementationWords = ['implement', 'architecture', 'component', 'function', 'module', 'service', 'bug', 'error', 'save', 'terminal', 'editor', 'settings']
    if (implementationWords.some(w => lower.includes(w))) {
      return { required: true, reason: 'Implementation query' }
    }

    return { required: false, reason: 'General default' }
  }

  tokenize(text) {
    const splitCamel = text.replace(/([a-z])([A-Z])/g, '$1 $2')
    const words = splitCamel.toLowerCase().split(/[^a-z0-9_.-]+/)
    return words.map(w => w.replace(/^[._-]+|[._-]+$/g, '')).filter(w => w.length >= 2 && !COMMON_STOP_WORDS.has(w))
  }

  rankCandidateFiles(prompt, filePaths) {
    const promptLower = prompt.toLowerCase()
    const promptTokens = this.tokenize(prompt)
    const promptTokenSet = new Set(promptTokens)

    const explicitFileMentions = prompt.match(/[a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]{1,8}/g) || []
    const normalizedMentions = explicitFileMentions.map(m => m.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase())

    const isSaveIntent = /\b(save|saving|editor|monaco|dirty|tab)\b/i.test(prompt)
    const isTerminalIntent = /\b(terminal|command|run_command|exec|shell|process|spawn|powershell|cmd)\b/i.test(prompt)
    const isGitIntent = /\b(git|status|diff|branch|commit|log)\b/i.test(prompt)
    const isArchIntent = /\b(architecture|overview|structure|entry point|components|how is the project structured)\b/i.test(prompt)
    const isConfigIntent = /\b(config|dependency|dependencies|package|build|vite|tsconfig|typescript)\b/i.test(prompt)

    const candidates = []

    for (const relPath of filePaths) {
      const normalizedPath = relPath.replace(/\\/g, '/')
      const pathLower = normalizedPath.toLowerCase()
      const segments = pathLower.split('/')
      const fileName = segments[segments.length - 1]
      const fileTokens = this.tokenize(fileName)
      const pathTokens = this.tokenize(normalizedPath)

      let score = 0
      const reasons = []

      for (const mention of normalizedMentions) {
        if (pathLower === mention || pathLower.endsWith(`/${mention}`)) {
          score += 1000
          reasons.push(`Exact path match`)
          break
        } else if (fileName === mention || fileName.startsWith(mention.split('.')[0])) {
          score += 500
          reasons.push(`Exact file name match`)
          break
        }
      }

      if (promptLower.includes(pathLower)) {
        score += 800
        reasons.push('Full path in prompt')
      } else if (promptLower.includes(fileName)) {
        score += 300
        reasons.push('File name in prompt')
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

      if (isSaveIntent && (pathLower.includes('editor') || pathLower.includes('save') || pathLower.includes('app.tsx') || pathLower.includes('fileexplorer'))) {
        score += 120
        reasons.push('Matches save/editor domain')
      }
      if (isTerminalIntent && (pathLower.includes('terminal') || pathLower.includes('runcommand') || pathLower.includes('commandvalidator') || pathLower.includes('command'))) {
        score += 150
        reasons.push('Matches terminal domain')
      }
      if (isGitIntent && (pathLower.includes('git') || pathLower.includes('gitstatus') || pathLower.includes('gitdiff') || pathLower.includes('gitlog'))) {
        score += 150
        reasons.push('Matches Git domain')
      }
      if (isArchIntent && (fileName === 'package.json' || pathLower === 'src/main/index.ts' || pathLower === 'src/renderer/src/app.tsx' || pathLower === 'src/preload/index.ts')) {
        score += 100
        reasons.push('Architectural entry point')
      }
      if (isConfigIntent && (fileName === 'package.json' || fileName.includes('config') || fileName.includes('tsconfig'))) {
        score += 120
        reasons.push('Config file')
      }

      const depth = segments.length
      score = Math.max(0, score - depth * 2)

      if (score > 0) {
        candidates.push({ path: normalizedPath, score, matchReason: reasons.join(', ') })
      }
    }

    candidates.sort((a, b) => b.score - a.score)
    return candidates.slice(0, this.config.maxCandidates)
  }

  async mockResolve(prompt, workspaceRoot, fileReader) {
    const intent = this.isProjectContextRequired(prompt, workspaceRoot)
    if (!intent.required || !workspaceRoot) {
      return { required: false, selectedFiles: [], readFiles: [], formattedContext: '' }
    }

    const filteredPaths = mockWorkspaceFiles.filter(p => {
      const ext = p.split('.').pop()?.toLowerCase() || ''
      if (BINARY_AND_ASSET_EXTS.has(ext)) return false
      if (p.startsWith('node_modules/') || p.startsWith('.git/')) return false
      return true
    })

    const candidates = this.rankCandidateFiles(prompt, filteredPaths)
    const filesToRead = candidates.filter(c => c.score >= this.config.minScoreThreshold || c.score >= 500).slice(0, this.config.maxAutoReadFiles)

    const readFiles = []
    let totalCharsRead = 0

    for (const f of filesToRead) {
      if (totalCharsRead >= this.config.maxTotalContextChars) break
      let content = null
      const cacheKey = f.path.toLowerCase()
      if (this.fileCache.has(cacheKey)) {
        content = this.fileCache.get(cacheKey).content
      } else {
        this.readCallCount++
        content = fileReader(f.path)
        this.fileCache.set(cacheKey, { content, timestamp: Date.now() })
      }

      if (content !== null) {
        let truncated = false
        const maxAllowed = Math.min(this.config.maxFileChars, this.config.maxTotalContextChars - totalCharsRead)
        if (content.length > maxAllowed) {
          content = content.slice(0, maxAllowed) + '\n\n[... Truncated remainder of file ...]'
          truncated = true
        }
        readFiles.push({ path: f.path, content, truncated, charCount: content.length })
        totalCharsRead += content.length
      }
    }

    let formattedContext = ''
    if (readFiles.length > 0) {
      const summaryLines = filesToRead.map(f => `- ${f.path} (Score: ${f.score}, Match: ${f.matchReason})`)
      const fileContentsBlocks = readFiles.map(rf => `--- File: ${rf.path}${rf.truncated ? ' (Truncated)' : ''} ---\n${rf.content}`)
      formattedContext = `[Smart Project Context Engine - Relevant Workspace Files]:\n${summaryLines.join('\n')}\n\n${fileContentsBlocks.join('\n\n')}`
    }

    return { required: true, selectedFiles: candidates, readFiles, formattedContext }
  }
}

async function runTests() {
  console.log('--- Starting Smart Context Engine Test Suite ---')
  const engine = new SmartContextEngine()
  const dummyFileReader = (path) => `// Content of ${path}\nexport const test = 123;`

  // Test 1: General question "What is Python?" -> 0 project context tools
  console.log('\n[Test 1] Query: "What is Python?"')
  const res1 = await engine.mockResolve('What is Python?', 'C:/Users/test/workspace', dummyFileReader)
  assert.strictEqual(res1.required, false, 'Should NOT require project context')
  assert.strictEqual(res1.readFiles.length, 0, 'Should have 0 read files')
  console.log('✓ PASS: 0 project-context files/tools triggered.')

  // Test 1b: General recursion
  console.log('\n[Test 1b] Query: "Explain recursion."')
  const res1b = await engine.mockResolve('Explain recursion.', 'C:/Users/test/workspace', dummyFileReader)
  assert.strictEqual(res1b.required, false)
  assert.strictEqual(res1b.readFiles.length, 0)
  console.log('✓ PASS: "Explain recursion." requires 0 project context.')

  // Test 2: Specific file "Explain src/utils/math.ts"
  console.log('\n[Test 2] Query: "Explain src/utils/math.ts"')
  const res2 = await engine.mockResolve('Explain src/utils/math.ts', 'C:/Users/test/workspace', dummyFileReader)
  assert.strictEqual(res2.required, true, 'Should require project context')
  assert.strictEqual(res2.readFiles[0].path, 'src/utils/math.ts', 'Should prioritize src/utils/math.ts')
  assert(res2.selectedFiles[0].score >= 1000, 'Score should be >= 1000 for exact path match')
  console.log(`✓ PASS: Identified ${res2.readFiles[0].path} with score ${res2.selectedFiles[0].score}.`)

  // Test 3: "How does the project handle file saving?"
  console.log('\n[Test 3] Query: "How does the project handle file saving?"')
  const res3 = await engine.mockResolve('How does the project handle file saving?', 'C:/Users/test/workspace', dummyFileReader)
  assert.strictEqual(res3.required, true)
  const savePaths = res3.readFiles.map(f => f.path)
  assert(savePaths.some(p => p.includes('EditorPane.tsx') || p.includes('FileExplorer.tsx') || p.includes('App.tsx')), 'Should identify save/editor related files')
  console.log(`✓ PASS: Identified relevant save files: ${savePaths.join(', ')}`)

  // Test 4: "Where is the terminal command execution implemented?"
  console.log('\n[Test 4] Query: "Where is the terminal command execution implemented?"')
  const res4 = await engine.mockResolve('Where is the terminal command execution implemented?', 'C:/Users/test/workspace', dummyFileReader)
  assert.strictEqual(res4.required, true)
  const termPaths = res4.readFiles.map(f => f.path)
  assert(termPaths.some(p => p.includes('Terminal.tsx') || p.includes('runCommandTool.ts') || p.includes('commandValidator.ts')), 'Should identify terminal execution files')
  console.log(`✓ PASS: Identified relevant terminal files: ${termPaths.join(', ')}`)

  // Test 5: "Explain the project architecture."
  console.log('\n[Test 5] Query: "Explain the project architecture."')
  const res5 = await engine.mockResolve('Explain the project architecture.', 'C:/Users/test/workspace', dummyFileReader)
  assert.strictEqual(res5.required, true)
  const archPaths = res5.readFiles.map(f => f.path)
  assert(archPaths.length <= 3, 'Should bound read files to maxAutoReadFiles (<= 3)')
  assert(archPaths.some(p => p.includes('package.json') || p.includes('src/main/index.ts') || p.includes('App.tsx')), 'Should pick key entry points')
  console.log(`✓ PASS: Selected architecture entry points: ${archPaths.join(', ')} (bounded to ${archPaths.length} files)`)

  // Test 6: Deduplication & Cache test
  console.log('\n[Test 6] Caching test: Asking same question twice')
  const initialReadCalls = engine.readCallCount
  const res6a = await engine.mockResolve('Explain src/utils/math.ts', 'C:/Users/test/workspace', dummyFileReader)
  const callsAfterFirst = engine.readCallCount
  const res6b = await engine.mockResolve('Explain src/utils/math.ts', 'C:/Users/test/workspace', dummyFileReader)
  const callsAfterSecond = engine.readCallCount
  assert.strictEqual(callsAfterFirst, callsAfterSecond, 'Second read must be served from cache without extra disk reads')
  console.log(`✓ PASS: File content cached cleanly. Disk reads before: ${callsAfterFirst}, after second call: ${callsAfterSecond}.`)

  // Test 6b: Cache invalidation on edit
  console.log('\n[Test 6b] Cache invalidation on edit')
  engine.invalidateFile('src/utils/math.ts')
  assert(!engine.fileCache.has('src/utils/math.ts'), 'Cache entry must be invalidated')
  await engine.mockResolve('Explain src/utils/math.ts', 'C:/Users/test/workspace', dummyFileReader)
  assert.strictEqual(engine.readCallCount, callsAfterSecond + 1, 'File re-read freshly after invalidation')
  console.log('✓ PASS: Invalidation and fresh re-read verified.')

  // Test 7: Binary files and ignored directories
  console.log('\n[Test 7] Binary & asset filtering')
  const res7 = await engine.mockResolve('Show icon.png and node_modules', 'C:/Users/test/workspace', dummyFileReader)
  const selectedPaths = res7.selectedFiles.map(f => f.path)
  assert(!selectedPaths.includes('assets/icon.png'), 'Binary files must not be selected')
  assert(!selectedPaths.some(p => p.startsWith('node_modules/')), 'node_modules must not be selected')
  console.log('✓ PASS: Binary and ignored directory files properly excluded.')

  console.log('\n========================================')
  console.log('ALL SMART CONTEXT ENGINE TESTS PASSED! ✓')
  console.log('========================================')
}

runTests().catch(err => {
  console.error('Test failed:', err)
  process.exit(1)
})
