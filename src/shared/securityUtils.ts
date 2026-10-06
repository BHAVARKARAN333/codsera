/**
 * Security Utilities - Phase 5 Task 1
 * Core security helper functions for Electron main process, preload, and IPC validation.
 * Pure implementation compatible with both Node.js and Browser environments.
 */

/**
 * Checks if a value is a valid non-empty string without null bytes (\0).
 * Enforces a maximum length boundary to prevent memory denial-of-service.
 */
export function isSafeString(val: unknown, maxLength = 65536): val is string {
  return (
    typeof val === 'string' &&
    val.trim().length > 0 &&
    val.length <= maxLength &&
    !val.includes('\0')
  )
}

/**
 * Checks if a path string is safe from null byte injection, control characters, and excessive length.
 */
export function isSafePath(filePath: unknown, maxLength = 4096): filePath is string {
  if (!isSafeString(filePath, maxLength)) return false
  // Reject null bytes and ascii control characters (0x00 to 0x1F)
  return !/[\x00-\x1F]/.test(filePath)
}

/**
 * Safely parses and validates external URLs for shell.openExternal.
 * Only HTTP and HTTPS protocols with non-empty hostnames are permitted.
 * File, javascript, data, vbscript, and custom schemes are strictly rejected.
 */
export function isSafeExternalUrl(urlStr: unknown): boolean {
  if (typeof urlStr !== 'string' || !urlStr.trim()) return false
  const trimmed = urlStr.trim()
  // Reject malformed triple-slash URLs (e.g. http:///path)
  if (/^https?:\/\/\//i.test(trimmed)) return false
  try {
    const parsed = new URL(trimmed)
    const hasValidProtocol = parsed.protocol === 'https:' || parsed.protocol === 'http:'
    const hasValidHost = typeof parsed.hostname === 'string' && parsed.hostname.length > 0
    return hasValidProtocol && hasValidHost
  } catch {
    return false
  }
}

/**
 * Clamps a numeric timeout value between min and max bounds safely.
 */
export function clampTimeout(
  timeoutMs: unknown,
  defaultVal = 60000,
  minVal = 1000,
  maxVal = 600000
): number {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs)) {
    return defaultVal
  }
  return Math.max(minVal, Math.min(Math.floor(timeoutMs), maxVal))
}

/**
 * Generates the Content-Security-Policy directive string.
 */
export function buildCspDirectives(isDev: boolean): string {
  const connectSources = [
    "'self'",
    'https://generativelanguage.googleapis.com',
    'https://openrouter.ai',
    'https://opencode.ai'
  ]
  if (isDev) {
    connectSources.push('ws:', 'http:')
  }

  const scriptSources = isDev ? ["'self'", "'unsafe-eval'", "'unsafe-inline'"] : ["'self'"]

  return [
    "default-src 'self'",
    `script-src ${scriptSources.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: https: blob:",
    `connect-src ${connectSources.join(' ')}`,
    "worker-src 'self' blob:",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'"
  ].join('; ')
}

/**
 * Validates a Git branch name format against security and reference naming rules.
 * Prevents option injection (e.g. leading hyphen), control characters, and invalid git ref characters.
 */
export function isValidBranchName(branchName: unknown): { valid: boolean; error?: string } {
  if (typeof branchName !== 'string' || !branchName.trim()) {
    return { valid: false, error: 'Branch name cannot be empty.' }
  }
  const trimmed = branchName.trim()
  if (trimmed.length > 250) {
    return { valid: false, error: 'Branch name exceeds maximum length of 250 characters.' }
  }
  if (trimmed.startsWith('-')) {
    return { valid: false, error: 'Branch name cannot start with a hyphen (-).' }
  }
  if (trimmed.startsWith('/') || trimmed.endsWith('/')) {
    return { valid: false, error: 'Branch name cannot start or end with a slash (/).' }
  }
  if (trimmed.endsWith('.lock')) {
    return { valid: false, error: 'Branch name cannot end with .lock.' }
  }
  if (trimmed.includes('..')) {
    return { valid: false, error: 'Branch name cannot contain consecutive dots (..).' }
  }
  if (trimmed.includes('@{')) {
    return { valid: false, error: 'Branch name cannot contain "@{".' }
  }
  if (trimmed === '@') {
    return { valid: false, error: 'Branch name cannot be "@".' }
  }
  if (/[\s~^:?*\[\\#]/.test(trimmed)) {
    return {
      valid: false,
      error: 'Branch name contains invalid characters (spaces, ~, ^, :, ?, *, [, \\, #).'
    }
  }
  if (/[\x00-\x1F\x7F]/.test(trimmed)) {
    return { valid: false, error: 'Branch name cannot contain ASCII control characters.' }
  }
  return { valid: true }
}

/**
 * Sanitizes and formats Git error messages for safe, user-friendly presentation.
 * Strips internal system paths, masks username directories, and normalizes common Git error scenarios.
 */
export function formatGitErrorMessage(rawError: unknown, workspaceRoot?: string | null): string {
  if (!rawError) return 'An unknown Git error occurred.'
  let msg = typeof rawError === 'string' ? rawError : (rawError instanceof Error ? rawError.message : String(rawError))
  msg = msg.trim()

  const lower = msg.toLowerCase()

  // 1. Git missing / not installed
  if (
    lower.includes('git is not installed') ||
    lower.includes('enoent') ||
    lower.includes('spawn git enoent') ||
    lower.includes('git: command not found') ||
    lower.includes("'git' is not recognized")
  ) {
    return 'Git is not installed or not found on system PATH. Please install Git to enable source control.'
  }

  // 2. Author identity / configuration missing
  if (
    lower.includes('author identity') ||
    lower.includes('committer identity') ||
    lower.includes('empty ident name') ||
    lower.includes('tell me who you are') ||
    (lower.includes('user.name') && lower.includes('user.email'))
  ) {
    return 'Git author identity is not configured. Please configure user.name and user.email:\ngit config --global user.name "Your Name"\ngit config --global user.email "you@example.com"'
  }

  // 3. Git lock file contention (.git/index.lock)
  if (lower.includes('index.lock') || (lower.includes('unable to create') && lower.includes('file exists'))) {
    return 'A Git index lock file (.git/index.lock) exists. Another Git operation may be in progress, or a previous operation was interrupted. Please wait a moment or remove the lock file if no Git process is active.'
  }

  // 4. Overwritten by checkout / merge collision
  if (lower.includes('would be overwritten by checkout') || lower.includes('would be overwritten by merge')) {
    return 'Cannot switch branch: local uncommitted changes would be overwritten. Please save, commit, or discard your changes first.'
  }

  // 5. Branch already exists
  if (lower.includes('already exists')) {
    const match = msg.match(/branch ['"]?([^'"]+)['"]? already exists/i) || msg.match(/fatal: A branch named ['"]?([^'"]+)['"]? already exists/i)
    if (match && match[1]) {
      return `A branch named '${match[1]}' already exists.`
    }
    return 'A branch with this name already exists.'
  }

  // 6. Not a git repository
  if (lower.includes('not a git repository') || lower.includes('not in a git directory')) {
    return 'The current workspace is not a Git repository.'
  }

  // 7. Path sanitization: Replace workspace root with relative prefix './'
  if (workspaceRoot) {
    const normRoot = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '')
    const regex1 = new RegExp(normRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
    msg = msg.replace(regex1, '.')
    const winRoot = normRoot.replace(/\//g, '\\')
    const regex2 = new RegExp(winRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
    msg = msg.replace(regex2, '.')
  }

  // 8. Mask user profile paths: e.g. C:\Users\<username>\ or /home/<username>/
  msg = msg.replace(/[a-zA-Z]:\\Users\\[^\\]+\\/gi, '~\\')
  msg = msg.replace(/\/home\/[^\/]+\//gi, '~/')
  msg = msg.replace(/\/Users\/[^\/]+\//gi, '~/')

  // 9. Remove redundant prefixes like "fatal: " or "error: "
  msg = msg.replace(/^fatal:\s*/i, '').replace(/^error:\s*/i, '').trim()

  return msg || 'An error occurred during the Git operation.'
}


