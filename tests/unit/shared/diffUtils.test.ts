import { describe, it, expect } from 'vitest'
import { parseUnifiedDiff, detectLanguage } from '@shared/diffUtils'

describe('diffUtils Unit Tests', () => {
  describe('parseUnifiedDiff', () => {
    it('returns empty diff structure for empty, null, or invalid inputs', () => {
      expect(parseUnifiedDiff('')).toEqual({
        original: '',
        modified: '',
        hasChanges: false
      })
      expect(parseUnifiedDiff(null as unknown as string)).toEqual({
        original: '',
        modified: '',
        hasChanges: false
      })
      expect(parseUnifiedDiff(undefined as unknown as string)).toEqual({
        original: '',
        modified: '',
        hasChanges: false
      })
    })

    it('returns empty result when diff contains only headers with no hunks', () => {
      const headerOnly = [
        'diff --git a/file.txt b/file.txt',
        'index 1234567..89abcdef 100644',
        '--- a/file.txt',
        '+++ b/file.txt'
      ].join('\n')

      const result = parseUnifiedDiff(headerOnly)
      expect(result).toEqual({
        original: '',
        modified: '',
        hasChanges: false
      })
    })

    it('correctly parses modified content in a single hunk', () => {
      const diff = [
        'diff --git a/test.ts b/test.ts',
        '--- a/test.ts',
        '+++ b/test.ts',
        '@@ -1,3 +1,3 @@',
        ' line 1',
        '-old line 2',
        '+new line 2',
        ' line 3'
      ].join('\n')

      const result = parseUnifiedDiff(diff)
      expect(result.hasChanges).toBe(true)
      expect(result.original).toBe('line 1\nold line 2\nline 3')
      expect(result.modified).toBe('line 1\nnew line 2\nline 3')
    })

    it('correctly parses added files (new file additions)', () => {
      const diff = [
        'diff --git a/new.ts b/new.ts',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/new.ts',
        '@@ -0,0 +1,2 @@',
        '+export const a = 1',
        '+export const b = 2'
      ].join('\n')

      const result = parseUnifiedDiff(diff)
      expect(result.hasChanges).toBe(true)
      expect(result.original).toBe('')
      expect(result.modified).toBe('export const a = 1\nexport const b = 2')
    })

    it('correctly parses deleted files', () => {
      const diff = [
        'diff --git a/deleted.ts b/deleted.ts',
        'deleted file mode 100644',
        '--- a/deleted.ts',
        '+++ /dev/null',
        '@@ -1,2 +0,0 @@',
        '-line to remove 1',
        '-line to remove 2'
      ].join('\n')

      const result = parseUnifiedDiff(diff)
      expect(result.hasChanges).toBe(true)
      expect(result.original).toBe('line to remove 1\nline to remove 2')
      expect(result.modified).toBe('')
    })

    it('inserts visual hunk separators between non-contiguous hunks', () => {
      const diff = [
        'diff --git a/multi.ts b/multi.ts',
        '--- a/multi.ts',
        '+++ b/multi.ts',
        '@@ -1,2 +1,2 @@',
        ' start',
        '-hunk1 old',
        '+hunk1 new',
        '@@ -20,2 +20,2 @@',
        ' middle',
        '-hunk2 old',
        '+hunk2 new'
      ].join('\n')

      const result = parseUnifiedDiff(diff)
      expect(result.hasChanges).toBe(true)
      expect(result.original).toContain('--- (hunk 1) ---')
      expect(result.modified).toContain('--- (hunk 1) ---')
      expect(result.original).toBe('start\nhunk1 old\n--- (hunk 1) ---\nmiddle\nhunk2 old')
      expect(result.modified).toBe('start\nhunk1 new\n--- (hunk 1) ---\nmiddle\nhunk2 new')
    })

    it('ignores "\\ No newline at end of file" annotations', () => {
      const diff = [
        '@@ -1,2 +1,2 @@',
        '-line one',
        '\\ No newline at end of file',
        '+line two',
        '\\ No newline at end of file'
      ].join('\n')

      const result = parseUnifiedDiff(diff)
      expect(result.hasChanges).toBe(true)
      expect(result.original).toBe('line one')
      expect(result.modified).toBe('line two')
      expect(result.original).not.toContain('No newline')
      expect(result.modified).not.toContain('No newline')
    })

    it('handles Windows CRLF newlines correctly', () => {
      const diff = '@@ -1,2 +1,2 @@\r\n-old\r\n+new\r\n context'
      const result = parseUnifiedDiff(diff)
      expect(result.hasChanges).toBe(true)
      expect(result.original).toBe('old\ncontext')
      expect(result.modified).toBe('new\ncontext')
    })
  })

  describe('detectLanguage', () => {
    it('returns plaintext for null, undefined, or empty path', () => {
      expect(detectLanguage(null)).toBe('plaintext')
      expect(detectLanguage('')).toBe('plaintext')
      expect(detectLanguage('file-without-extension')).toBe('plaintext')
    })

    it('detects TypeScript and TSX files', () => {
      expect(detectLanguage('src/index.ts')).toBe('typescript')
      expect(detectLanguage('src/components/App.tsx')).toBe('typescript')
    })

    it('detects JavaScript variations', () => {
      expect(detectLanguage('index.js')).toBe('javascript')
      expect(detectLanguage('module.mjs')).toBe('javascript')
      expect(detectLanguage('script.cjs')).toBe('javascript')
      expect(detectLanguage('Component.jsx')).toBe('javascript')
    })

    it('detects Web and markup formats', () => {
      expect(detectLanguage('package.json')).toBe('json')
      expect(detectLanguage('index.html')).toBe('html')
      expect(detectLanguage('page.htm')).toBe('html')
      expect(detectLanguage('styles.css')).toBe('css')
      expect(detectLanguage('theme.scss')).toBe('css')
      expect(detectLanguage('legacy.less')).toBe('css')
      expect(detectLanguage('README.md')).toBe('markdown')
      expect(detectLanguage('DOCS.markdown')).toBe('markdown')
    })

    it('detects backend and systems programming languages', () => {
      expect(detectLanguage('server.py')).toBe('python')
      expect(detectLanguage('main.rs')).toBe('rust')
      expect(detectLanguage('main.go')).toBe('go')
      expect(detectLanguage('App.java')).toBe('java')
      expect(detectLanguage('main.c')).toBe('c')
      expect(detectLanguage('header.h')).toBe('c')
      expect(detectLanguage('main.cpp')).toBe('cpp')
      expect(detectLanguage('header.hpp')).toBe('cpp')
      expect(detectLanguage('source.cc')).toBe('cpp')
    })

    it('detects data, query, and shell languages', () => {
      expect(detectLanguage('docker-compose.yml')).toBe('yaml')
      expect(detectLanguage('config.yaml')).toBe('yaml')
      expect(detectLanguage('data.xml')).toBe('xml')
      expect(detectLanguage('icon.svg')).toBe('xml')
      expect(detectLanguage('query.sql')).toBe('sql')
      expect(detectLanguage('deploy.sh')).toBe('shell')
      expect(detectLanguage('init.bash')).toBe('shell')
    })

    it('handles uppercase extensions and unusual paths', () => {
      expect(detectLanguage('SRC/MAIN.TS')).toBe('typescript')
      expect(detectLanguage('CONFIG.JSON')).toBe('json')
      expect(detectLanguage('C:\\Users\\test\\FILE.PY')).toBe('python')
    })

    it('returns plaintext for unrecognized extensions', () => {
      expect(detectLanguage('archive.zip')).toBe('plaintext')
      expect(detectLanguage('binary.exe')).toBe('plaintext')
      expect(detectLanguage('unknown.xyz123')).toBe('plaintext')
    })
  })
})
