import { describe, it, expect } from 'vitest'
import { normalizeFilePath, arePathsEqual } from '../../../src/shared/pathUtils'

describe('Path Utilities (normalizeFilePath & arePathsEqual)', () => {
  const workspaceRoot = 'C:/Users/tester/workspace'

  describe('normalizeFilePath', () => {
    it('normalizes Windows backslashes to forward slashes', () => {
      expect(normalizeFilePath('C:\\Users\\tester\\workspace\\test.ts')).toBe(
        'C:/Users/tester/workspace/test.ts'
      )
    })

    it('capitalizes Windows drive letters', () => {
      expect(normalizeFilePath('c:/users/tester/workspace/test.ts')).toBe(
        'C:/users/tester/workspace/test.ts'
      )
      expect(normalizeFilePath('d:\\projects\\app\\main.py')).toBe(
        'D:/projects/app/main.py'
      )
    })

    it('collapses consecutive slashes', () => {
      expect(normalizeFilePath('C://Users///tester////workspace//test.ts')).toBe(
        'C:/Users/tester/workspace/test.ts'
      )
    })

    it('resolves relative . and .. segments', () => {
      expect(normalizeFilePath('C:/Users/tester/workspace/./sub/../test.ts')).toBe(
        'C:/Users/tester/workspace/test.ts'
      )
      expect(normalizeFilePath('C:/Users/tester/../tester/workspace/test.ts')).toBe(
        'C:/Users/tester/workspace/test.ts'
      )
    })

    it('resolves relative workspace paths against workspaceRoot', () => {
      expect(normalizeFilePath('test.ts', workspaceRoot)).toBe(
        'C:/Users/tester/workspace/test.ts'
      )
      expect(normalizeFilePath('src/components/Editor.tsx', workspaceRoot)).toBe(
        'C:/Users/tester/workspace/src/components/Editor.tsx'
      )
      expect(normalizeFilePath('.\\src\\App.tsx', workspaceRoot)).toBe(
        'C:/Users/tester/workspace/src/App.tsx'
      )
    })

    it('handles empty, null, or undefined gracefully', () => {
      expect(normalizeFilePath('')).toBe('')
      expect(normalizeFilePath(null as any)).toBe('')
      expect(normalizeFilePath(undefined as any)).toBe('')
      expect(normalizeFilePath('   ')).toBe('')
    })
  })

  describe('arePathsEqual', () => {
    it('returns true for exact matching strings', () => {
      expect(arePathsEqual('C:/project/test.ts', 'C:/project/test.ts')).toBe(true)
    })

    it('returns true for forward vs backward slashes (Windows vs POSIX)', () => {
      expect(
        arePathsEqual(
          'C:/Users/tester/workspace/test.ts',
          'C:\\Users\\tester\\workspace\\test.ts'
        )
      ).toBe(true)
    })

    it('returns true for mixed slashes and consecutive slashes', () => {
      expect(
        arePathsEqual(
          'C:/Users/tester/workspace/test.ts',
          'C:\\Users//tester\\workspace///test.ts'
        )
      ).toBe(true)
    })

    it('returns true for case-insensitive Windows paths', () => {
      expect(
        arePathsEqual(
          'c:/users/tester/workspace/test.ts',
          'C:/Users/tester/workspace/test.ts'
        )
      ).toBe(true)
      expect(
        arePathsEqual(
          'C:\\PROJECT\\SRC\\INDEX.TS',
          'c:\\project\\src\\index.ts'
        )
      ).toBe(true)
    })

    it('returns true when resolving relative path against workspace root', () => {
      expect(
        arePathsEqual('test.ts', 'C:/Users/tester/workspace/test.ts', workspaceRoot)
      ).toBe(true)
      expect(
        arePathsEqual(
          'src\\components\\Editor.tsx',
          'C:/Users/tester/workspace/src/components/Editor.tsx',
          workspaceRoot
        )
      ).toBe(true)
    })

    it('returns true when one path contains . or .. relative segments', () => {
      expect(
        arePathsEqual(
          'C:/Users/tester/workspace/./test.ts',
          'C:/Users/tester/workspace/test.ts'
        )
      ).toBe(true)
      expect(
        arePathsEqual(
          'C:/Users/tester/workspace/src/../test.ts',
          'C:/Users/tester/workspace/test.ts'
        )
      ).toBe(true)
    })

    it('returns false for different files in the same directory', () => {
      expect(
        arePathsEqual(
          'C:/Users/tester/workspace/fileA.ts',
          'C:/Users/tester/workspace/fileB.ts'
        )
      ).toBe(false)
    })

    it('returns false for the same filename in different directories', () => {
      expect(
        arePathsEqual(
          'C:/Users/tester/workspace/dirA/test.ts',
          'C:/Users/tester/workspace/dirB/test.ts'
        )
      ).toBe(false)
      expect(
        arePathsEqual(
          'dirA/test.ts',
          'dirB/test.ts',
          workspaceRoot
        )
      ).toBe(false)
    })

    it('returns false when either path is empty, null, or undefined', () => {
      expect(arePathsEqual('', 'C:/project/test.ts')).toBe(false)
      expect(arePathsEqual('C:/project/test.ts', null as any)).toBe(false)
      expect(arePathsEqual(undefined as any, undefined as any)).toBe(false)
    })
  })
})
