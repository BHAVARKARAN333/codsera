import { describe, it, expect } from 'vitest'
import {
  isSafeString,
  isSafePath,
  isSafeExternalUrl,
  clampTimeout,
  buildCspDirectives,
  isValidBranchName,
  formatGitErrorMessage
} from '@shared/securityUtils'

describe('securityUtils Unit Tests', () => {
  describe('isSafeString', () => {
    it('accepts valid non-empty strings within limits', () => {
      expect(isSafeString('hello world')).toBe(true)
      expect(isSafeString('a')).toBe(true)
      expect(isSafeString('  valid content  ')).toBe(true)
    })

    it('rejects empty or whitespace-only strings', () => {
      expect(isSafeString('')).toBe(false)
      expect(isSafeString('   ')).toBe(false)
      expect(isSafeString('\t\n ')).toBe(false)
    })

    it('rejects non-string values', () => {
      expect(isSafeString(null)).toBe(false)
      expect(isSafeString(undefined)).toBe(false)
      expect(isSafeString(123)).toBe(false)
      expect(isSafeString({})).toBe(false)
      expect(isSafeString([])).toBe(false)
      expect(isSafeString(true)).toBe(false)
    })

    it('rejects null byte injection', () => {
      expect(isSafeString('hello\0world')).toBe(false)
      expect(isSafeString('\0start')).toBe(false)
      expect(isSafeString('end\0')).toBe(false)
    })

    it('rejects oversized strings exceeding maximum length ceiling', () => {
      const atMax = 'a'.repeat(65536)
      expect(isSafeString(atMax)).toBe(true)

      const overMax = 'a'.repeat(65537)
      expect(isSafeString(overMax)).toBe(false)
    })

    it('respects custom maxLength parameter', () => {
      expect(isSafeString('short', 10)).toBe(true)
      expect(isSafeString('longer-than-ten', 10)).toBe(false)
    })
  })

  describe('isSafePath', () => {
    it('accepts valid normal paths (POSIX and Windows)', () => {
      expect(isSafePath('src/main/index.ts')).toBe(true)
      expect(isSafePath('C:\\Users\\test\\project\\file.txt')).toBe(true)
      expect(isSafePath('/home/user/workspace/app.js')).toBe(true)
      expect(isSafePath('./relative/path/to/module')).toBe(true)
    })

    it('rejects null byte injection in paths', () => {
      expect(isSafePath('src/main/\0secret.txt')).toBe(false)
      expect(isSafePath('\0/etc/passwd')).toBe(false)
    })

    it('rejects ASCII control characters (0x00 to 0x1F)', () => {
      expect(isSafePath('src/main/\nindex.ts')).toBe(false)
      expect(isSafePath('src/main/\rindex.ts')).toBe(false)
      expect(isSafePath('src/main/\tindex.ts')).toBe(false)
      expect(isSafePath('path/with/\x08backspace')).toBe(false)
      expect(isSafePath('path/\x1Bescape')).toBe(false)
    })

    it('rejects oversized paths exceeding path ceiling', () => {
      const atMax = 'a'.repeat(4096)
      expect(isSafePath(atMax)).toBe(true)

      const overMax = 'a'.repeat(4097)
      expect(isSafePath(overMax)).toBe(false)
    })

    it('rejects empty or non-string paths', () => {
      expect(isSafePath('')).toBe(false)
      expect(isSafePath('   ')).toBe(false)
      expect(isSafePath(null)).toBe(false)
      expect(isSafePath(undefined)).toBe(false)
      expect(isSafePath(12345)).toBe(false)
    })
  })

  describe('isSafeExternalUrl', () => {
    it('accepts valid HTTPS and HTTP URLs with hostnames', () => {
      expect(isSafeExternalUrl('https://example.com')).toBe(true)
      expect(isSafeExternalUrl('https://github.com/org/repo')).toBe(true)
      expect(isSafeExternalUrl('http://localhost:3000/api')).toBe(true)
      expect(isSafeExternalUrl('https://sub.domain.org/path?q=test#hash')).toBe(true)
    })

    it('rejects file:// URLs', () => {
      expect(isSafeExternalUrl('file:///C:/Windows/System32/cmd.exe')).toBe(false)
      expect(isSafeExternalUrl('file:///etc/passwd')).toBe(false)
    })

    it('rejects dangerous script schemes', () => {
      expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false)
      expect(isSafeExternalUrl('data:text/html,<script>alert(1)</script>')).toBe(false)
      expect(isSafeExternalUrl('vbscript:msgbox(1)')).toBe(false)
    })

    it('rejects custom application schemes', () => {
      expect(isSafeExternalUrl('vscode://file/path')).toBe(false)
      expect(isSafeExternalUrl('git://github.com/repo')).toBe(false)
      expect(isSafeExternalUrl('calc:test')).toBe(false)
    })

    it('rejects URLs missing valid hostnames or malformed syntax', () => {
      expect(isSafeExternalUrl('http:///path')).toBe(false)
      expect(isSafeExternalUrl('https:///path/to/page')).toBe(false)
      expect(isSafeExternalUrl('http://')).toBe(false)
      expect(isSafeExternalUrl('not-a-url')).toBe(false)
      expect(isSafeExternalUrl('')).toBe(false)
      expect(isSafeExternalUrl('   ')).toBe(false)
      expect(isSafeExternalUrl(null)).toBe(false)
      expect(isSafeExternalUrl(undefined)).toBe(false)
    })
  })

  describe('clampTimeout', () => {
    it('preserves valid timeout values within bounds', () => {
      expect(clampTimeout(5000)).toBe(5000)
      expect(clampTimeout(60000)).toBe(60000)
      expect(clampTimeout(300000)).toBe(300000)
    })

    it('floors floating point values', () => {
      expect(clampTimeout(5000.75)).toBe(5000)
      expect(clampTimeout(1000.2)).toBe(1000)
    })

    it('clamps values below minimum to minVal', () => {
      expect(clampTimeout(500)).toBe(1000)
      expect(clampTimeout(-100)).toBe(1000)
      expect(clampTimeout(0)).toBe(1000)
    })

    it('clamps values above maximum to maxVal', () => {
      expect(clampTimeout(700000)).toBe(600000)
      expect(clampTimeout(1000000)).toBe(600000)
    })

    it('falls back to defaultVal for non-numeric or invalid inputs', () => {
      expect(clampTimeout(null)).toBe(60000)
      expect(clampTimeout(undefined)).toBe(60000)
      expect(clampTimeout('5000')).toBe(60000)
      expect(clampTimeout(NaN)).toBe(60000)
      expect(clampTimeout(Infinity)).toBe(60000)
      expect(clampTimeout(-Infinity)).toBe(60000)
    })

    it('respects custom minVal, maxVal, and defaultVal', () => {
      expect(clampTimeout(50, 500, 100, 1000)).toBe(100)
      expect(clampTimeout(2000, 500, 100, 1000)).toBe(1000)
      expect(clampTimeout('invalid', 500, 100, 1000)).toBe(500)
    })
  })

  describe('buildCspDirectives', () => {
    it('generates strict production CSP without dev exceptions', () => {
      const prodCsp = buildCspDirectives(false)

      expect(prodCsp).toContain("default-src 'self'")
      expect(prodCsp).toContain("script-src 'self'")
      expect(prodCsp).not.toContain("'unsafe-eval'")
      expect(prodCsp).not.toContain('ws:')
      expect(prodCsp).not.toContain('http:')
      expect(prodCsp).toContain('https://generativelanguage.googleapis.com')
      expect(prodCsp).toContain('https://openrouter.ai')
      expect(prodCsp).toContain('https://opencode.ai')
      expect(prodCsp).toContain("frame-src 'none'")
      expect(prodCsp).toContain("object-src 'none'")
    })

    it('generates development CSP with Vite HMR support', () => {
      const devCsp = buildCspDirectives(true)

      expect(devCsp).toContain("script-src 'self' 'unsafe-eval' 'unsafe-inline'")
      expect(devCsp).toContain('ws:')
      expect(devCsp).toContain('http:')
      expect(devCsp).toContain('https://generativelanguage.googleapis.com')
      expect(devCsp).toContain("frame-src 'none'")
    })
  })

  describe('isValidBranchName', () => {
    it('accepts valid branch names', () => {
      expect(isValidBranchName('main')).toEqual({ valid: true })
      expect(isValidBranchName('feature/login-ui')).toEqual({ valid: true })
      expect(isValidBranchName('release-v1.0.0')).toEqual({ valid: true })
      expect(isValidBranchName('user/test_branch')).toEqual({ valid: true })
    })

    it('rejects empty or whitespace-only branch names', () => {
      expect(isValidBranchName('')).toEqual({ valid: false, error: 'Branch name cannot be empty.' })
      expect(isValidBranchName('   ')).toEqual({ valid: false, error: 'Branch name cannot be empty.' })
      expect(isValidBranchName(null)).toEqual({ valid: false, error: 'Branch name cannot be empty.' })
      expect(isValidBranchName(undefined)).toEqual({ valid: false, error: 'Branch name cannot be empty.' })
    })

    it('rejects branch names exceeding 250 characters', () => {
      const longName = 'a'.repeat(251)
      expect(isValidBranchName(longName).valid).toBe(false)
      expect(isValidBranchName(longName).error).toContain('exceeds maximum length')
      expect(isValidBranchName('a'.repeat(250)).valid).toBe(true)
    })

    it('rejects option injection attempts (leading hyphen)', () => {
      expect(isValidBranchName('-D').valid).toBe(false)
      expect(isValidBranchName('--force').valid).toBe(false)
      expect(isValidBranchName('-b').error).toContain('cannot start with a hyphen')
    })

    it('rejects leading or trailing slashes', () => {
      expect(isValidBranchName('/feature').valid).toBe(false)
      expect(isValidBranchName('feature/').valid).toBe(false)
      expect(isValidBranchName('/feature/').error).toContain('cannot start or end with a slash')
    })

    it('rejects .lock extension', () => {
      expect(isValidBranchName('branch.lock').valid).toBe(false)
      expect(isValidBranchName('feature.lock').error).toContain('cannot end with .lock')
    })

    it('rejects consecutive dots (..)', () => {
      expect(isValidBranchName('feature..branch').valid).toBe(false)
      expect(isValidBranchName('test..').error).toContain('consecutive dots')
    })

    it('rejects reflog syntax and single @', () => {
      expect(isValidBranchName('feature@{1}').valid).toBe(false)
      expect(isValidBranchName('@').valid).toBe(false)
    })

    it('rejects invalid characters (spaces, ~, ^, :, ?, *, [, \\, #)', () => {
      expect(isValidBranchName('feature branch').valid).toBe(false)
      expect(isValidBranchName('feature~1').valid).toBe(false)
      expect(isValidBranchName('feature^2').valid).toBe(false)
      expect(isValidBranchName('feature:test').valid).toBe(false)
      expect(isValidBranchName('feature?test').valid).toBe(false)
      expect(isValidBranchName('feature*test').valid).toBe(false)
      expect(isValidBranchName('feature[test').valid).toBe(false)
      expect(isValidBranchName('feature\\test').valid).toBe(false)
      expect(isValidBranchName('feature#test').valid).toBe(false)
    })

    it('rejects ASCII control characters (0x00-0x1F, 0x7F)', () => {
      expect(isValidBranchName('feature\nbranch').valid).toBe(false)
      expect(isValidBranchName('feature\tbranch').valid).toBe(false)
      expect(isValidBranchName('feature\x7Fbranch').valid).toBe(false)
    })
  })

  describe('formatGitErrorMessage', () => {
    it('returns default fallback message when error is empty or null', () => {
      expect(formatGitErrorMessage(null)).toBe('An unknown Git error occurred.')
      expect(formatGitErrorMessage('')).toBe('An unknown Git error occurred.')
      expect(formatGitErrorMessage(undefined)).toBe('An unknown Git error occurred.')
    })

    it('formats Git missing / not installed errors', () => {
      const msg = formatGitErrorMessage('spawn git ENOENT')
      expect(msg).toContain('Git is not installed or not found on system PATH')
    })

    it('formats unconfigured Git author identity errors', () => {
      const raw = 'fatal: empty ident name (for <user@domain>) not allowed'
      const formatted = formatGitErrorMessage(raw)
      expect(formatted).toContain('Git author identity is not configured')
      expect(formatted).toContain('git config --global user.name')
      expect(formatted).toContain('git config --global user.email')
    })

    it('formats index lock contention errors', () => {
      const raw = 'fatal: Unable to create .git/index.lock: File exists'
      const formatted = formatGitErrorMessage(raw)
      expect(formatted).toContain('.git/index.lock')
      expect(formatted).toContain('Another Git operation may be in progress')
    })

    it('formats checkout overwrite collision errors', () => {
      const raw = 'error: Your local changes to the following files would be overwritten by checkout:\n\tfile.ts'
      const formatted = formatGitErrorMessage(raw)
      expect(formatted).toContain('Cannot switch branch: local uncommitted changes would be overwritten')
    })

    it('formats branch already exists errors with branch name', () => {
      const raw = "fatal: A branch named 'feature/login' already exists."
      const formatted = formatGitErrorMessage(raw)
      expect(formatted).toBe("A branch named 'feature/login' already exists.")
    })

    it('formats non-Git repository errors', () => {
      const raw = 'fatal: not a git repository (or any of the parent directories): .git'
      const formatted = formatGitErrorMessage(raw)
      expect(formatted).toBe('The current workspace is not a Git repository.')
    })

    it('sanitizes workspace root path to relative prefix ./', () => {
      const root = 'C:/Users/developer/project'
      const raw = 'error: cannot open C:/Users/developer/project/src/index.ts: Permission denied'
      const formatted = formatGitErrorMessage(raw, root)
      expect(formatted).not.toContain('C:/Users/developer/project')
      expect(formatted).toContain('./src/index.ts')
    })

    it('masks user home directory paths to ~\\ or ~/', () => {
      const rawWin = 'error in C:\\Users\\john_doe\\AppData\\Local\\Temp'
      expect(formatGitErrorMessage(rawWin)).toContain('~\\AppData\\Local\\Temp')

      const rawUnix = 'error in /home/john_doe/.config/git'
      expect(formatGitErrorMessage(rawUnix)).toContain('~/.config/git')

      const rawMac = 'error in /Users/john_doe/Library'
      expect(formatGitErrorMessage(rawMac)).toContain('~/Library')
    })

    it('strips fatal: and error: prefixes', () => {
      expect(formatGitErrorMessage('fatal: something went wrong')).toBe('something went wrong')
      expect(formatGitErrorMessage('error: commit failed')).toBe('commit failed')
    })
  })
})
