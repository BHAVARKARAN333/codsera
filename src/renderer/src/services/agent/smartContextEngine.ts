import { FileEntry } from '../../../../shared/types'
import { ContextCache, ContextCacheStats } from './contextCache'
import { ContextBudgetManager, DroppedContextFile } from './contextBudgetManager'
import { ContextDeduplicator } from './contextDeduplicator'
import {
  DependencyAnalyzer,
  DependencyGraphNode,
  SymbolReference
} from './dependencyAnalyzer'
import { CodebaseIndex, ProjectSummary } from './codebaseIndex'

export interface RankedCandidate {
  path: string
  score: number
  matchReason: string
  isExplicit?: boolean
}

export interface SmartContextFile {
  path: string
  content: string
  truncated: boolean
  charCount: number
  score: number
  isExplicit: boolean
}

export interface SmartContextResult {
  required: boolean
  reason?: string
  selectedFiles: RankedCandidate[]
  readFiles: SmartContextFile[]
  droppedFiles: DroppedContextFile[]
  formattedContext: string
  cacheStats?: ContextCacheStats
  dependencyGraph?: DependencyGraphNode | null
  symbolReferences?: SymbolReference[]
  projectSummary?: ProjectSummary | null
}

export interface SmartContextEngineConfig {
  maxCandidates?: number
  maxAutoReadFiles?: number
  maxDependencyCandidates?: number
  maxFileChars?: number
  maxTotalContextChars?: number
  minScoreThreshold?: number
  debug?: boolean
}

const BINARY_AND_ASSET_EXTS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'ico',
  'webp',
  'svg',
  'mp4',
  'mp3',
  'pdf',
  'zip',
  'tar',
  'gz',
  'exe',
  'dll',
  'dylib',
  'so',
  'bin',
  'woff',
  'woff2',
  'ttf',
  'eot',
  'map',
  'wasm'
])

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'out',
  '.vscode',
  '.idea',
  '.cache',
  'coverage',
  '.parcel-cache'
])

const COMMON_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'has',
  'he',
  'in',
  'is',
  'it',
  'its',
  'of',
  'on',
  'that',
  'the',
  'to',
  'was',
  'were',
  'will',
  'with',
  'what',
  'how',
  'where',
  'which',
  'who',
  'why',
  'can',
  'could',
  'does',
  'do',
  'this',
  'our',
  'my',
  'me',
  'please',
  'tell',
  'explain',
  'show',
  'find'
])

export class SmartContextEngine {
  private config: Required<SmartContextEngineConfig>
  private cache: ContextCache
  private budgetManager: ContextBudgetManager
  private deduplicator: ContextDeduplicator
  private dependencyAnalyzer: DependencyAnalyzer
  private codebaseIndex: CodebaseIndex
  private currentWorkspaceRoot: string | null = null

  constructor(config?: SmartContextEngineConfig) {
    const maxCandidates = config?.maxCandidates ?? 15
    const maxAutoReadFiles = config?.maxAutoReadFiles ?? 3
    const maxDependencyCandidates = config?.maxDependencyCandidates ?? 5
    const maxFileChars = config?.maxFileChars ?? 12000
    const maxTotalContextChars = config?.maxTotalContextChars ?? 30000
    const minScoreThreshold = config?.minScoreThreshold ?? 40
    const debug = config?.debug ?? false

    this.config = {
      maxCandidates,
      maxAutoReadFiles,
      maxDependencyCandidates,
      maxFileChars,
      maxTotalContextChars,
      minScoreThreshold,
      debug
    }

    this.cache = new ContextCache(debug)
    this.budgetManager = new ContextBudgetManager({
      maxBudget: maxTotalContextChars,
      maxFileChars,
      minScoreThreshold
    })
    this.deduplicator = new ContextDeduplicator(debug)
    this.dependencyAnalyzer = new DependencyAnalyzer({
      maxDependencyCandidates,
      debug
    })
    this.codebaseIndex = new CodebaseIndex(this.dependencyAnalyzer, debug)
  }

  setDebug(enabled: boolean): void {
    this.config.debug = enabled
    this.cache.setDebug(enabled)
    this.budgetManager.setDebug(enabled)
    this.deduplicator.setDebug(enabled)
    this.dependencyAnalyzer.setDebug(enabled)
    this.codebaseIndex.setDebug(enabled)
  }

  getCache(): ContextCache {
    return this.cache
  }

  getBudgetManager(): ContextBudgetManager {
    return this.budgetManager
  }

  getDeduplicator(): ContextDeduplicator {
    return this.deduplicator
  }

  getDependencyAnalyzer(): DependencyAnalyzer {
    return this.dependencyAnalyzer
  }

  getCodebaseIndex(): CodebaseIndex {
    return this.codebaseIndex
  }

  /**
   * Clears in-memory file read cache, deduplication state, dependency analysis graph, and codebase index.
   */
  clearCache(): void {
    this.cache.clear()
    this.deduplicator.reset()
    this.dependencyAnalyzer.clearCache()
    this.codebaseIndex.clear()
  }

  /**
   * Handles workspace switch (clears cache if workspace changed).
   */
  onWorkspaceChange(newWorkspaceRoot: string | null): void {
    if (this.currentWorkspaceRoot !== newWorkspaceRoot) {
      if (this.config.debug) {
        console.debug(
          `[SmartContextEngine] Workspace changed from "${this.currentWorkspaceRoot}" to "${newWorkspaceRoot}". Clearing cache.`
        )
      }
      this.currentWorkspaceRoot = newWorkspaceRoot
      this.clearCache()
    }
  }

  /**
   * Invalidates a specific file in the cache, deduplicator, dependency analyzer, and codebase index.
   */
  invalidateFile(relativePath: string): void {
    this.cache.invalidate(relativePath)
    this.deduplicator.invalidateFile(relativePath)
    this.dependencyAnalyzer.invalidateFile(relativePath)
    this.codebaseIndex.invalidateFile(relativePath)
  }

  /**
   * Determines if project context is actually needed for a given user prompt.
   */
  isProjectContextRequired(
    prompt: string,
    workspaceRoot: string | null
  ): { required: boolean; reason: string } {
    if (!workspaceRoot) {
      return { required: false, reason: 'No workspace folder is currently open.' }
    }

    const trimmed = prompt.trim()
    if (!trimmed) {
      return { required: false, reason: 'Empty prompt.' }
    }

    const lower = trimmed.toLowerCase()

    // 1. General greetings and conversational one-liners
    const greetingRegex =
      /^(hi|hello|hey|greetings|good morning|good evening|good afternoon|who are you|what can you do|help)\b[!.?]*$/i
    if (greetingRegex.test(trimmed)) {
      return { required: false, reason: 'Conversational greeting does not require project context.' }
    }

    // 2. Explicit file path or file extension mentioned in prompt
    const fileMentionRegex = /([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]{1,8})/
    if (fileMentionRegex.test(trimmed)) {
      return { required: true, reason: 'Prompt explicitly mentions a file path or filename.' }
    }

    // 3. Project-specific action and question phrases
    const projectIndicators = [
      'this project',
      'the project',
      'our project',
      'this codebase',
      'the codebase',
      'our codebase',
      'this app',
      'the app',
      'our app',
      'in this repo',
      'in the repo',
      'project architecture',
      'file save',
      'file saving',
      'terminal command',
      'command execution',
      'git status',
      'git diff',
      'git log',
      'how does the project',
      'where is',
      'where are',
      'find where',
      'fix this problem',
      'fix the bug',
      'run test',
      'run tests',
      'run command',
      'edit file',
      'create file'
    ]

    for (const indicator of projectIndicators) {
      if (lower.includes(indicator)) {
        return { required: true, reason: `Prompt contains project indicator: "${indicator}".` }
      }
    }

    // 4. Pure general programming questions without project scope
    const generalConceptQuestions = [
      /^(what is|what are|explain|describe|define)\s+(python|javascript|typescript|rust|c\+\+|java|go|recursion|binary search|quicksort|rest api|graphql|sql|nosql|docker|kubernetes|oauth|jwt|http|https|css|html|polymorphism|encapsulation|inheritance|solid principles|git|react|vue|angular)\b[?.]*$/i,
      /^(how does|how do)\s+(recursion|binary search|quicksort|https|http|garbage collection|event loop|async\/await|dns|tcp|udp)\s+(work|function)\b[?.]*$/i,
      /^(write|show|give me)\s+an?\s+(example of|sample of|simple)\s+(recursion|binary search|quicksort|fibonacci|hello world)\b/i
    ]

    for (const pattern of generalConceptQuestions) {
      if (pattern.test(trimmed)) {
        return { required: false, reason: 'General programming or conceptual question.' }
      }
    }

    // 5. Default heuristic for queries asking about code implementations
    const implementationWords = [
      'implement',
      'architecture',
      'component',
      'function',
      'module',
      'service',
      'bug',
      'error',
      'save',
      'terminal',
      'editor',
      'settings'
    ]
    const hasImplementationWord = implementationWords.some((w) => lower.includes(w))

    if (hasImplementationWord) {
      return { required: true, reason: 'Prompt references implementation details or IDE features.' }
    }

    return { required: false, reason: 'No project-specific context identified.' }
  }

  /**
   * Recursively flattens directory tree into normalized relative paths.
   */
  extractRelativePaths(
    entries: FileEntry[],
    rootPath: string,
    maxDepth = 6,
    currentDepth = 0
  ): string[] {
    if (currentDepth > maxDepth || !entries) return []
    const paths: string[] = []

    const normalizedRoot = rootPath.replace(/\\/g, '/').replace(/\/+$/, '')

    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name)) continue

      const normalizedEntryPath = entry.path.replace(/\\/g, '/')
      let relPath = normalizedEntryPath.startsWith(normalizedRoot)
        ? normalizedEntryPath.slice(normalizedRoot.length).replace(/^\/+/, '')
        : normalizedEntryPath.replace(/^\/+/, '')

      if (entry.isDirectory) {
        if (entry.children && entry.children.length > 0) {
          paths.push(...this.extractRelativePaths(entry.children, rootPath, maxDepth, currentDepth + 1))
        }
      } else {
        const ext = entry.name.split('.').pop()?.toLowerCase() || ''
        if (!BINARY_AND_ASSET_EXTS.has(ext)) {
          paths.push(relPath)
        }
      }
    }

    return paths
  }

  /**
   * Tokenizes a text into meaningful lowercase words (splitting camelCase, kebab-case, snake_case).
   */
  tokenize(text: string): string[] {
    const splitCamel = text.replace(/([a-z])([A-Z])/g, '$1 $2')
    const words = splitCamel.toLowerCase().split(/[^a-z0-9_.-]+/)
    const cleanTokens: string[] = []

    for (const w of words) {
      const stripped = w.replace(/^[._-]+|[._-]+$/g, '')
      if (stripped.length >= 2 && !COMMON_STOP_WORDS.has(stripped)) {
        cleanTokens.push(stripped)
      }
    }

    return cleanTokens
  }

  /**
   * Ranks candidate files against the user's prompt using multi-signal scoring.
   */
  rankCandidateFiles(prompt: string, filePaths: string[]): RankedCandidate[] {
    const promptLower = prompt.toLowerCase()
    const promptTokens = this.tokenize(prompt)
    const promptTokenSet = new Set(promptTokens)

    const explicitFileMentions = prompt.match(/[a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]{1,8}/g) || []
    const normalizedMentions = explicitFileMentions.map((m) =>
      m.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase()
    )

    const candidates: RankedCandidate[] = []

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
      const reasons: string[] = []

      // 1. Exact path or basename mention in prompt
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

      // 2. Token overlap
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
      if (matchingTokens > 0) {
        reasons.push(`${matchingTokens} matching token(s)`)
      }

      // 3. Domain Intent Heuristics
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

      const depth = segments.length
      score = Math.max(0, score - depth * 2)

      if (score > 0) {
        candidates.push({
          path: normalizedPath,
          score,
          matchReason: reasons.join(', ') || 'Keyword relevance',
          isExplicit
        })
      }
    }

    candidates.sort((a, b) => b.score - a.score)
    return candidates.slice(0, this.config.maxCandidates)
  }

  /**
   * Resolves smart project context:
   * 1. Checks intent and workspace change.
   * 2. Ranks candidate files.
   * 3. Reads files using ContextCache with content hashing and smart refresh.
   * 4. Allocates budget using ContextBudgetManager.
   * 5. Deduplicates active context via ContextDeduplicator.
   */
  async resolveContext(
    prompt: string,
    workspaceRoot: string | null
  ): Promise<SmartContextResult> {
    this.onWorkspaceChange(workspaceRoot)

    const intent = this.isProjectContextRequired(prompt, workspaceRoot)
    if (!intent.required || !workspaceRoot) {
      return {
        required: false,
        reason: intent.reason,
        selectedFiles: [],
        readFiles: [],
        droppedFiles: [],
        formattedContext: '',
        cacheStats: this.cache.getStats()
      }
    }

    try {
      if (!window?.electronAPI) {
        return {
          required: false,
          reason: 'Electron API unavailable',
          selectedFiles: [],
          readFiles: [],
          droppedFiles: [],
          formattedContext: '',
          cacheStats: this.cache.getStats()
        }
      }

      // Fetch directory tree
      const treeRes = await window.electronAPI.readTree(workspaceRoot)
      const treeEntries = treeRes.success && treeRes.tree ? treeRes.tree : []
      const filePaths = this.extractRelativePaths(treeEntries, workspaceRoot)

      if (filePaths.length === 0) {
        return {
          required: true,
          reason: 'No source files found in workspace.',
          selectedFiles: [],
          readFiles: [],
          droppedFiles: [],
          formattedContext: '[Project Context]: Workspace contains no readable source files.',
          cacheStats: this.cache.getStats()
        }
      }

      // Rank candidate files
      const rankedCandidates = this.rankCandidateFiles(prompt, filePaths)

      // Filter top files that meet the minimum relevance threshold (or are explicitly requested)
      const filesToRead = rankedCandidates
        .filter((c) => c.score >= this.config.minScoreThreshold || c.isExplicit || c.score >= 500)
        .slice(0, this.config.maxAutoReadFiles)

      // Fetch file contents (via cache with smart refresh)
      const rawCandidatesToAllocate = []

      for (const candidate of filesToRead) {
        let content: string | null = null
        const cachedEntry = this.cache.get(candidate.path)

        if (cachedEntry) {
          content = cachedEntry.content
        } else {
          // Read from disk
          const readRes = await window.electronAPI.readWorkspaceFile(workspaceRoot, candidate.path)
          if (readRes.success && typeof readRes.content === 'string') {
            content = readRes.content
            this.cache.set(candidate.path, content)
          } else {
            if (this.config.debug) {
              console.debug(`[SmartContextEngine] Failed to read candidate: ${candidate.path}`)
            }
          }
        }

        if (content !== null) {
          rawCandidatesToAllocate.push({
            path: candidate.path,
            content,
            score: candidate.score,
            isExplicit: candidate.isExplicit
          })
        }
      }

      // Allocate via ContextBudgetManager
      const allocation = this.budgetManager.allocate(rawCandidatesToAllocate)

      // Mark allocated files into ContextDeduplicator
      const readFiles: SmartContextFile[] = []
      for (const allocated of allocation.allocatedFiles) {
        this.deduplicator.markFileInContext(allocated.path, allocated.content)
        readFiles.push({
          path: allocated.path,
          content: allocated.content,
          truncated: allocated.truncated,
          charCount: allocated.charCount,
          score: allocated.score,
          isExplicit: allocated.isExplicit
        })
      }

      // Codebase Indexing (Phase 5)
      for (const rf of readFiles) {
        this.codebaseIndex.indexFile(rf.path, rf.content, filePaths)
      }

      // Dependency Analysis & Change Impact Preview (Phase 3 & 5)
      let dependencyGraph: DependencyGraphNode | null = null
      let symbolReferences: SymbolReference[] = []
      let projectSummary: ProjectSummary | null = null

      const promptLower = prompt.toLowerCase()
      const isStructureOrTechQuery =
        promptLower.includes('summary of this project') ||
        promptLower.includes('project structure') ||
        promptLower.includes('technologies does this project') ||
        promptLower.includes('technologies') ||
        promptLower.includes('architecture') ||
        promptLower.includes('entry points')

      if (readFiles.length > 0) {
        const primary = readFiles[0]
        const ext = primary.path.split('.').pop()?.toLowerCase() || ''

        if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(ext)) {
          const filesWithContent = readFiles.map((rf) => ({
            path: rf.path,
            content: rf.content
          }))

          dependencyGraph = this.dependencyAnalyzer.buildGraphNode(
            primary.path,
            primary.content,
            filesWithContent,
            filePaths
          )

          // If prompt contains potential function or symbol identifier
          const symbolTokens = this.tokenize(prompt).filter((t) => t.length >= 3)
          for (const sym of symbolTokens) {
            const refs = this.dependencyAnalyzer.findSymbolReferences(sym, filesWithContent)
            if (refs.length > 0) {
              symbolReferences.push(...refs)
            }
          }
        }
      }

      if (isStructureOrTechQuery) {
        projectSummary = this.codebaseIndex.getProjectSummary()
      }

      // Format clean internal context
      let formattedContext = ''
      if (readFiles.length > 0 || projectSummary) {
        const summaryLines = readFiles.map(
          (f) => `- ${f.path} (Score: ${f.score}${f.isExplicit ? ', Explicitly Requested' : ''})`
        )
        const fileContentsBlocks = readFiles.map(
          (rf) => `--- File: ${rf.path}${rf.truncated ? ' (Truncated)' : ''} ---\n${rf.content}`
        )

        formattedContext = `[Smart Project Context Engine - Relevant Workspace Files]:\n${summaryLines.join('\n')}\n\n${fileContentsBlocks.join('\n\n')}`

        if (dependencyGraph) {
          const deps = dependencyGraph.directDependencies.length > 0
            ? dependencyGraph.directDependencies.join(', ')
            : 'None identified'
          const importers = dependencyGraph.directImporters.length > 0
            ? dependencyGraph.directImporters.join(', ')
            : 'None directly detected'
          const tests = dependencyGraph.likelyTests.length > 0
            ? dependencyGraph.likelyTests.join(', ')
            : 'None inferred'
          const indirect = dependencyGraph.indirectImporters.length > 0
            ? dependencyGraph.indirectImporters.join(', ')
            : 'None inferred'
          const affected = dependencyGraph.potentiallyAffected.length > 0
            ? dependencyGraph.potentiallyAffected.join(', ')
            : 'None identified'

          formattedContext += `\n\n[Dependency Graph & Impact Analysis]:\n- Primary Target: ${dependencyGraph.path}\n- Direct Dependencies [Directly Detected]: ${deps}\n- Direct Importers [Directly Detected]: ${importers}\n- Related Test Files [Inferred from naming conventions]: ${tests}\n- Potential Indirect Impact [Inferred downstream consumers]: ${indirect}\n- Combined Affected Files: ${affected}\n- Note: package.json is excluded from code change impact unless package metadata itself is modified.`
        }

        if (symbolReferences.length > 0) {
          const refLines = symbolReferences
            .slice(0, 5)
            .map((r) => `- ${r.file}:${r.line} -> \`${r.snippet}\``)
          formattedContext += `\n\n[Symbol References]:\n${refLines.join('\n')}`
        }

        if (projectSummary) {
          const techStr = projectSummary.detectedTechnologies.length > 0
            ? projectSummary.detectedTechnologies.join(', ')
            : 'None detected from configuration files'
          const entryStr = projectSummary.detectedEntryPoints.length > 0
            ? projectSummary.detectedEntryPoints.map((e) => `${e.path} (${e.confidence}: ${e.reason})`).join(', ')
            : 'None detected'
          const configStr = projectSummary.configFiles.length > 0
            ? projectSummary.configFiles.join(', ')
            : 'None detected'
          const runtimeStr = projectSummary.runtimePlatform || 'Node.js Application'
          const testEnvStr = projectSummary.testEnvironment || 'None Detected'

          formattedContext += `\n\n[Codebase Index & Project Understanding]:\n- Workspace Files: ${filePaths.length} total (${projectSummary.sourceFilesCount} indexed source, ${projectSummary.testFilesCount} tests, ${projectSummary.configFilesCount} config)\n- Main Directories: ${projectSummary.mainDirectories.join(', ') || 'root'}\n- Runtime Platform [Confirmed]: ${runtimeStr}\n- Test Environment [Test Runner]: ${testEnvStr}\n- Detected Technologies (Evidence-backed): ${techStr}\n- Detected Entry Points: ${entryStr}\n- Configuration Files: ${configStr}`
        }
      }

      return {
        required: true,
        reason: intent.reason,
        selectedFiles: rankedCandidates,
        readFiles,
        droppedFiles: allocation.droppedFiles,
        formattedContext,
        cacheStats: this.cache.getStats(),
        dependencyGraph,
        symbolReferences,
        projectSummary
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        required: true,
        reason: `Context engine error: ${message}`,
        selectedFiles: [],
        readFiles: [],
        droppedFiles: [],
        formattedContext: '',
        cacheStats: this.cache.getStats()
      }
    }
  }
}
