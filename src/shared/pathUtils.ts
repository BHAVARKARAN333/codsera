/**
 * Path Utilities for Editor & Workspace Tab Management
 * Pure TypeScript implementation compatible with both Node and Browser environments.
 */

/**
 * Normalizes a file or directory path into a canonical form:
 * 1. Resolves relative paths against workspaceRoot (if provided).
 * 2. Standardizes all backslashes '\' to forward slashes '/'.
 * 3. Collapses multiple consecutive slashes (e.g. '//' -> '/').
 * 4. Resolves '.' and '..' segments.
 * 5. Capitalizes Windows drive letters (e.g. 'c:/' -> 'C:/').
 * 6. Strips trailing slashes (except root 'C:/' or '/').
 */
export function normalizeFilePath(
  rawPath: string | null | undefined,
  workspaceRoot?: string | null
): string {
  if (!rawPath || typeof rawPath !== 'string') return ''
  let trimmed = rawPath.trim()
  if (!trimmed) return ''

  // Standardize backslashes to forward slashes first
  trimmed = trimmed.replace(/\\/g, '/')

  // Detect whether path is absolute
  const isWindowsDrive = /^[a-zA-Z]:/.test(trimmed)
  const isAbsolute = trimmed.startsWith('/') || isWindowsDrive

  // If relative and workspaceRoot is provided, resolve against workspaceRoot
  if (!isAbsolute && workspaceRoot && typeof workspaceRoot === 'string' && workspaceRoot.trim()) {
    const cleanRoot = workspaceRoot.trim().replace(/\\/g, '/').replace(/\/+$/, '')
    trimmed = `${cleanRoot}/${trimmed}`
  }

  // Detect drive letter
  const hasDrive = /^[a-zA-Z]:/.test(trimmed)
  let drivePrefix = ''
  let rest = trimmed

  if (hasDrive) {
    drivePrefix = trimmed.slice(0, 2).toUpperCase()
    rest = trimmed.slice(2)
  }

  const isRestAbsolute = rest.startsWith('/')
  const rawSegments = rest.split(/\/+/).filter(Boolean)
  const resolvedSegments: string[] = []

  for (const seg of rawSegments) {
    if (seg === '.') continue
    if (seg === '..') {
      if (resolvedSegments.length > 0 && resolvedSegments[resolvedSegments.length - 1] !== '..') {
        resolvedSegments.pop()
      } else if (!isRestAbsolute && !hasDrive) {
        resolvedSegments.push('..')
      }
    } else {
      resolvedSegments.push(seg)
    }
  }

  const combined = (isRestAbsolute || hasDrive ? '/' : '') + resolvedSegments.join('/')
  const full = drivePrefix ? drivePrefix + combined : combined

  // Ensure root drive e.g. "C:/" doesn't become "C:"
  if (/^[a-zA-Z]:$/.test(full)) {
    return full + '/'
  }

  return full
}

/**
 * Checks whether two file paths refer to the same exact canonical file location.
 * Takes into account:
 * - Backslashes vs forward slashes
 * - Multiple consecutive slashes
 * - '.' and '..' path resolution
 * - Case-insensitivity for Windows drives/paths
 * - Relative vs absolute paths (resolved against workspaceRoot)
 */
export function arePathsEqual(
  pathA: string | null | undefined,
  pathB: string | null | undefined,
  workspaceRoot?: string | null
): boolean {
  if (pathA === pathB && pathA !== null && pathA !== undefined && pathA !== '') {
    return true
  }
  if (!pathA || !pathB) return false

  const normA = normalizeFilePath(pathA, workspaceRoot)
  const normB = normalizeFilePath(pathB, workspaceRoot)

  if (!normA || !normB) return false
  if (normA === normB) return true

  // Case-insensitive comparison for Windows paths or drive paths
  const hasDriveA = /^[a-zA-Z]:\//.test(normA)
  const hasDriveB = /^[a-zA-Z]:\//.test(normB)

  if (hasDriveA || hasDriveB) {
    return normA.toLowerCase() === normB.toLowerCase()
  }

  // Cross-platform case-insensitive comparison
  return normA.toLowerCase() === normB.toLowerCase()
}
