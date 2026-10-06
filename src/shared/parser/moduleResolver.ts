/**
 * Safe Module Resolver (Phase 11.6)
 *
 * Resolves local import specifiers against known workspace files deterministically.
 * Guarantees workspace boundary containment and prevents directory traversal.
 */

export interface ResolutionResult {
  resolved: boolean
  resolvedPath: string | null
  external: boolean
}

export interface ModuleResolverConfig {
  knownFiles?: Set<string> | string[]
  pathAliases?: Record<string, string[]>
  workspaceRoot?: string
}

const COMMON_EXTENSIONS = [
  '',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.d.ts',
  '.py',
  '.java',
  '.c',
  '.h',
  '.cpp',
  '.hpp',
  '.cs',
  '.go',
  '.rs',
  '.json',
  '.css'
]

const INDEX_CANDIDATES = [
  '/index.ts',
  '/index.tsx',
  '/index.js',
  '/index.jsx',
  '/__init__.py',
  '/mod.rs'
]

export class ModuleResolver {
  private knownFiles: Set<string> = new Set()
  private knownFilesLower: Map<string, string> = new Map() // lowercase -> original
  private pathAliases: Record<string, string[]> = {
    '@/*': ['src/*'],
    '@shared/*': ['src/shared/*'],
    '@renderer/*': ['src/renderer/src/*']
  }

  constructor(config?: ModuleResolverConfig) {
    if (config?.knownFiles) {
      this.setKnownFiles(config.knownFiles)
    }
    if (config?.pathAliases) {
      this.pathAliases = { ...this.pathAliases, ...config.pathAliases }
    }
  }

  /**
   * Updates the set of known workspace-relative files for resolution.
   */
  setKnownFiles(files: Set<string> | string[]): void {
    this.knownFiles.clear()
    this.knownFilesLower.clear()

    for (const f of files) {
      const normalized = normalizeWorkspacePath(f)
      if (normalized) {
        this.knownFiles.add(normalized)
        this.knownFilesLower.set(normalized.toLowerCase(), normalized)
      }
    }
  }

  /**
   * Resolves an import/include specifier originating from `fromFilePath`.
   */
  resolve(specifier: string, fromFilePath: string): ResolutionResult {
    const trimmed = specifier.trim()
    if (!trimmed) {
      return { resolved: false, resolvedPath: null, external: false }
    }

    const normSource = normalizeWorkspacePath(fromFilePath)
    if (!normSource) {
      return { resolved: false, resolvedPath: null, external: false }
    }

    const sourceDir = getParentDirectory(normSource)

    // 1. Check Path Aliases (e.g. @shared/* -> src/shared/*)
    const aliasResolved = this.resolvePathAlias(trimmed)
    if (aliasResolved !== null) {
      const match = this.matchKnownCandidate(aliasResolved)
      if (match) {
        return { resolved: true, resolvedPath: match, external: false }
      }
      // If an alias was matched but target wasn't found in known files:
      return { resolved: false, resolvedPath: null, external: false }
    }

    // 2. Relative Imports (./ or ../)
    if (trimmed.startsWith('./') || trimmed.startsWith('../')) {
      const candidateRaw = sourceDir ? `${sourceDir}/${trimmed}` : trimmed
      const normalizedCandidate = normalizeWorkspacePath(candidateRaw)

      // Traversal attempt escaping workspace
      if (!normalizedCandidate) {
        return { resolved: false, resolvedPath: null, external: false }
      }

      const match = this.matchKnownCandidate(normalizedCandidate)
      if (match) {
        return { resolved: true, resolvedPath: match, external: false }
      }

      // Local relative file not found in known files
      return { resolved: false, resolvedPath: null, external: false }
    }

    // 3. Python relative imports (e.g. from .utils import x, from ..parent import y)
    if (trimmed.startsWith('.')) {
      let leadingDots = 0
      while (trimmed[leadingDots] === '.') {
        leadingDots++
      }
      const remainder = trimmed.slice(leadingDots)
      // Dot count: 1 dot = current dir, 2 dots = parent dir, etc.
      let currentDir = sourceDir
      for (let i = 1; i < leadingDots; i++) {
        currentDir = getParentDirectory(currentDir)
      }
      const candidatePath = remainder
        ? currentDir
          ? `${currentDir}/${remainder.replace(/\./g, '/')}`
          : remainder.replace(/\./g, '/')
        : currentDir

      const normalizedCandidate = normalizeWorkspacePath(candidatePath)
      if (normalizedCandidate) {
        const match = this.matchKnownCandidate(normalizedCandidate)
        if (match) {
          return { resolved: true, resolvedPath: match, external: false }
        }
      }
      return { resolved: false, resolvedPath: null, external: false }
    }

    // 4. Check if exact specifier is directly a known workspace file
    const directMatch = this.matchKnownCandidate(trimmed)
    if (directMatch) {
      return { resolved: true, resolvedPath: directMatch, external: false }
    }

    // 5. Check if local relative to source directory (e.g. C/C++ #include "header.h" without ./)
    if (sourceDir) {
      const localCandidate = normalizeWorkspacePath(`${sourceDir}/${trimmed}`)
      if (localCandidate) {
        const match = this.matchKnownCandidate(localCandidate)
        if (match) {
          return { resolved: true, resolvedPath: match, external: false }
        }
      }
    }

    // 6. External / Unresolved module (e.g. 'react', 'fs', '<iostream>', 'System', 'fmt')
    return {
      resolved: false,
      resolvedPath: null,
      external: true
    }
  }

  /**
   * Matches candidate path against known workspace files, testing extensions and index files.
   */
  private matchKnownCandidate(candidate: string): string | null {
    // A. Direct extension candidates
    for (const ext of COMMON_EXTENSIONS) {
      const testPath = ext ? `${candidate}${ext}` : candidate
      if (this.knownFiles.has(testPath)) {
        return testPath
      }
      const lower = testPath.toLowerCase()
      if (this.knownFilesLower.has(lower)) {
        return this.knownFilesLower.get(lower)!
      }
    }

    // B. Directory index candidates
    for (const idx of INDEX_CANDIDATES) {
      const testPath = `${candidate}${idx}`
      if (this.knownFiles.has(testPath)) {
        return testPath
      }
      const lower = testPath.toLowerCase()
      if (this.knownFilesLower.has(lower)) {
        return this.knownFilesLower.get(lower)!
      }
    }

    return null
  }

  /**
   * Attempts to match and resolve a path alias (e.g. @shared/* -> src/shared/*).
   */
  private resolvePathAlias(specifier: string): string | null {
    for (const [pattern, targets] of Object.entries(this.pathAliases)) {
      if (pattern.endsWith('/*')) {
        const prefix = pattern.slice(0, -2)
        if (specifier === prefix || specifier.startsWith(`${prefix}/`)) {
          const remainder = specifier.slice(prefix.length).replace(/^\/+/, '')
          for (const target of targets) {
            const targetBase = target.replace(/\*$/, '').replace(/\/+$/, '')
            const candidate = remainder ? `${targetBase}/${remainder}` : targetBase
            return normalizeWorkspacePath(candidate)
          }
        }
      } else if (specifier === pattern && targets.length > 0) {
        return normalizeWorkspacePath(targets[0])
      }
    }
    return null
  }
}

/**
 * Normalizes a workspace-relative path safely:
 * - Forward slashes only
 * - Strips leading slashes / Windows drive prefixes
 * - Resolves '.' and '..' segments safely
 * - Returns null if the path attempts to escape the workspace boundary (starts with '..')
 */
export function normalizeWorkspacePath(rawPath: string | null | undefined): string | null {
  if (!rawPath || typeof rawPath !== 'string') return null
  let p = rawPath.trim().replace(/\\/g, '/')

  // Remove drive letters if present (e.g. C:/workspace/foo -> foo)
  p = p.replace(/^[a-zA-Z]:[/\\]?/, '')

  // Remove leading slashes
  p = p.replace(/^\/+/, '')

  const segments = p.split('/').filter(Boolean)
  const stack: string[] = []

  for (const seg of segments) {
    if (seg === '.') continue
    if (seg === '..') {
      if (stack.length === 0) {
        // Traversal escaping root: strictly forbidden
        return null
      }
      stack.pop()
    } else {
      stack.push(seg)
    }
  }

  return stack.join('/')
}

/**
 * Returns parent directory of a normalized workspace-relative file path.
 */
export function getParentDirectory(normalizedPath: string): string {
  const lastSlash = normalizedPath.lastIndexOf('/')
  if (lastSlash === -1) {
    return ''
  }
  return normalizedPath.slice(0, lastSlash)
}
