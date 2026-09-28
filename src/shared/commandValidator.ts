/**
 * Command Safety Validator
 * Prevents workspace escape, path traversal, and unauthorized directory changes.
 * Self-contained pure implementation compatible with both Node (Electron Main) and Browser (Renderer).
 */

export interface CommandSafetyResult {
  safe: boolean
  error?: string
}

/**
 * Normalizes path with resolved `.` and `..` segments across Windows and POSIX
 */
export function normalizePathSegments(fullPath: string): string {
  if (!fullPath) return ''
  const trimmed = fullPath.trim()
  const isWindowsDrive = /^[a-zA-Z]:/.test(trimmed)
  let drivePrefix = ''
  let rest = trimmed

  if (isWindowsDrive) {
    drivePrefix = trimmed.slice(0, 2).toUpperCase()
    rest = trimmed.slice(2)
  }

  const isAbsolute = rest.startsWith('/') || rest.startsWith('\\')
  const rawSegments = rest.split(/[/\\]+/).filter(Boolean)
  const resolvedSegments: string[] = []

  for (const seg of rawSegments) {
    if (seg === '.') continue
    if (seg === '..') {
      if (resolvedSegments.length > 0 && resolvedSegments[resolvedSegments.length - 1] !== '..') {
        resolvedSegments.pop()
      } else if (!isAbsolute) {
        resolvedSegments.push('..')
      }
    } else {
      resolvedSegments.push(seg)
    }
  }

  const combined = (isAbsolute ? '/' : '') + resolvedSegments.join('/')
  return drivePrefix ? drivePrefix + combined : combined
}

/**
 * Checks if target destination is outside the specified workspace root
 */
export function isPathOutsideWorkspace(workspaceRoot: string, targetPath: string): boolean {
  if (!workspaceRoot || !targetPath) return true

  const normWs = normalizePathSegments(workspaceRoot).toLowerCase().replace(/\/+$/, '')

  let fullTargetPath = targetPath.trim()
  // Remove surrounding quotes
  fullTargetPath = fullTargetPath.replace(/^["']|["']$/g, '')

  let resolvedTarget: string
  if (/^[a-zA-Z]:[/\\]/.test(fullTargetPath) || fullTargetPath.startsWith('/') || fullTargetPath.startsWith('\\')) {
    // Absolute path
    resolvedTarget = normalizePathSegments(fullTargetPath)
  } else {
    // Relative path from workspace
    resolvedTarget = normalizePathSegments(workspaceRoot.replace(/\\/g, '/') + '/' + fullTargetPath.replace(/\\/g, '/'))
  }

  const normTarget = resolvedTarget.toLowerCase().replace(/\/+$/, '')

  if (normTarget === normWs) {
    return false // Exactly the workspace root
  }

  if (normTarget.startsWith(normWs + '/')) {
    return false // Inside workspace subfolder
  }

  return true // Outside workspace
}

const CD_COMMAND_REGEX =
  /(?:^|[;&|\n\r]|\b(?:powershell|pwsh|cmd|bash|sh)\b[^\n\r]*?(?:-c|-Command|\/c|\/k)\s+["']?)\s*(?:cd|chdir|pushd|Set-Location|sl)\b(?:\s+(?:-Path\s+|-LiteralPath\s+|\/d\s+)?([^\s;&|\r\n"']+)|(?:\s+(?:-Path\s+|-LiteralPath\s+|\/d\s+)?["']([^"']+)["']))?/gi

/**
 * Validates whether a command attempts to escape the current workspace root.
 */
export function validateCommandSafety(
  command: string,
  workspaceRoot: string | null | undefined
): CommandSafetyResult {
  if (!workspaceRoot || typeof workspaceRoot !== 'string' || !workspaceRoot.trim()) {
    return {
      safe: false,
      error: 'No workspace folder is currently open. Please open a workspace first.'
    }
  }

  if (!command || typeof command !== 'string' || !command.trim()) {
    return {
      safe: false,
      error: 'Missing or empty command.'
    }
  }

  const cleanCmd = command.trim()

  // 1. Check nested commands inside powershell -Command "..." or cmd /c "..."
  const subshellMatches = Array.from(
    cleanCmd.matchAll(
      /(?:powershell|pwsh|cmd|bash|sh)(?:\.exe)?\s+(?:-Command|-c|\/c|\/k)\s+["']([^"']+)["']/gi
    )
  )
  for (const match of subshellMatches) {
    const innerCmd = match[1]
    if (innerCmd) {
      const innerCheck = validateCommandSafety(innerCmd, workspaceRoot)
      if (!innerCheck.safe) {
        return innerCheck
      }
    }
  }

  // 2. Scan for directory-changing commands (cd, chdir, pushd, Set-Location, sl)
  const cdMatches = Array.from(cleanCmd.matchAll(CD_COMMAND_REGEX))
  for (const match of cdMatches) {
    const targetRaw = match[1] || match[2]

    // If cd / Set-Location has no argument, shells target $HOME or user profile (outside workspace)
    if (!targetRaw || !targetRaw.trim()) {
      return {
        safe: false,
        error: 'Command rejected: working directory must remain inside the current workspace.'
      }
    }

    const cleanTarget = targetRaw.trim().replace(/^['"]|['"]$/g, '')

    // Check for home / user profile tokens
    if (
      cleanTarget === '~' ||
      cleanTarget.startsWith('~/') ||
      cleanTarget.startsWith('~\\') ||
      cleanTarget.toLowerCase().includes('%userprofile%') ||
      cleanTarget.toLowerCase().includes('$home') ||
      cleanTarget.toLowerCase().includes('$env:userprofile')
    ) {
      return {
        safe: false,
        error: 'Command rejected: working directory must remain inside the current workspace.'
      }
    }

    if (isPathOutsideWorkspace(workspaceRoot, cleanTarget)) {
      return {
        safe: false,
        error: 'Command rejected: working directory must remain inside the current workspace.'
      }
    }
  }

  // 3. Check for specific dangerous command patterns attempting directory escape
  const escapePatterns = [
    /\b(cd|chdir|pushd|Set-Location|sl)\s+["']?\.\./i,
    /\b(cd|chdir|pushd|Set-Location|sl)\s+[\/\\]/i,
    /\b(cd|chdir|pushd|Set-Location|sl)\s+[a-zA-Z]:/i,
    /\b(cd|chdir|pushd|Set-Location|sl)\s+(?:-Path\s+|-LiteralPath\s+|\/d\s+)?["']?\.\./i,
    /\bpowershell[^\n\r]*?(?:Set-Location|cd|chdir|sl|pushd)\s+["']?\.\./i,
    /\bcmd[^\n\r]*?\/c[^\n\r]*?(?:cd|chdir|pushd)\s+["']?\.\./i
  ]

  for (const pattern of escapePatterns) {
    if (pattern.test(cleanCmd)) {
      return {
        safe: false,
        error: 'Command rejected: working directory must remain inside the current workspace.'
      }
    }
  }

  return { safe: true }
}
