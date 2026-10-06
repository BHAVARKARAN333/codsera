import { describe, it, expect, beforeEach } from 'vitest'
import {
  SmartContextEngine,
  toRelativeWorkspacePath,
  coalesceEventTypes
} from '@renderer/services/agent/smartContextEngine'

describe('smartContextEngine Unit Tests', () => {
  describe('toRelativeWorkspacePath', () => {
    it('returns normalized relative path for child file', () => {
      const rel = toRelativeWorkspacePath('C:/project/src/index.ts', 'C:/project')
      expect(rel).toBe('src/index.ts')
    })

    it('handles Windows backslashes in path and root', () => {
      const rel = toRelativeWorkspacePath('C:\\project\\src\\components\\App.tsx', 'C:\\project')
      expect(rel).toBe('src/components/App.tsx')
    })

    it('protects against sibling folder prefix confusion', () => {
      // C:/project-other starts with C:/project, but is NOT a subfolder of C:/project
      const rel = toRelativeWorkspacePath('C:/project-other/secret.txt', 'C:/project')
      expect(rel).toBeNull()
    })

    it('returns empty string if fullPath equals workspaceRoot', () => {
      const rel = toRelativeWorkspacePath('C:/project', 'C:/project')
      expect(rel).toBe('')
    })

    it('returns null for path on a completely different drive or outside root', () => {
      const rel = toRelativeWorkspacePath('D:/other/file.txt', 'C:/project')
      expect(rel).toBeNull()
    })
  })

  describe('coalesceEventTypes', () => {
    it('coalesces add followed by change into add', () => {
      expect(coalesceEventTypes('add', 'change')).toBe('add')
    })

    it('coalesces add followed by unlink into unlink', () => {
      expect(coalesceEventTypes('add', 'unlink')).toBe('unlink')
    })

    it('coalesces change followed by unlink into unlink', () => {
      expect(coalesceEventTypes('change', 'unlink')).toBe('unlink')
    })

    it('coalesces unlink followed by add into change', () => {
      expect(coalesceEventTypes('unlink', 'add')).toBe('change')
    })

    it('coalesces unlink followed by change into change', () => {
      expect(coalesceEventTypes('unlink', 'change')).toBe('change')
    })

    it('preserves same event type consecutively', () => {
      expect(coalesceEventTypes('change', 'change')).toBe('change')
    })
  })

  describe('SmartContextEngine class', () => {
    let engine: SmartContextEngine

    beforeEach(() => {
      engine = new SmartContextEngine({
        maxCandidates: 10,
        minScoreThreshold: 40,
        debug: false
      })
    })

    describe('tokenize', () => {
      it('splits camelCase, kebab-case, and snake_case', () => {
        const tokens = engine.tokenize('userProfileController my-component_name')
        expect(tokens).toContain('user')
        expect(tokens).toContain('profile')
        expect(tokens).toContain('controller')
        expect(tokens).toContain('component')
        expect(tokens).toContain('name')
      })

      it('strips common stop words and file extensions', () => {
        const tokens = engine.tokenize('find the auth service in index.ts and App.tsx')
        expect(tokens).toContain('auth')
        expect(tokens).toContain('service')
        expect(tokens).not.toContain('the')
        expect(tokens).not.toContain('in')
        expect(tokens).not.toContain('and')
        expect(tokens).not.toContain('ts')
        expect(tokens).not.toContain('tsx')
      })
    })

    describe('isProjectContextRequired', () => {
      const ws = 'C:/project'

      it('returns false when no workspace is open', () => {
        const res = engine.isProjectContextRequired('fix this bug', null)
        expect(res.required).toBe(false)
        expect(res.reason).toContain('No workspace folder')
      })

      it('returns false for conversational greetings and conceptual questions', () => {
        expect(engine.isProjectContextRequired('hello there', ws).required).toBe(false)
        expect(engine.isProjectContextRequired('what is recursion', ws).required).toBe(false)
        expect(engine.isProjectContextRequired('explain binary search in python', ws).required).toBe(false)
      })

      it('returns true when prompt explicitly mentions a file', () => {
        const res = engine.isProjectContextRequired('check App.tsx for render issues', ws)
        expect(res.required).toBe(true)
        expect(res.reason).toContain('explicitly mentions a file')
      })

      it('returns true for project architecture and code flow questions', () => {
        expect(engine.isProjectContextRequired('how does the project structure look', ws).required).toBe(true)
        expect(engine.isProjectContextRequired('trace the request flow in this app', ws).required).toBe(true)
        expect(engine.isProjectContextRequired('how does git status work in this repo', ws).required).toBe(true)
      })
    })

    describe('rankCandidateFiles', () => {
      const filePaths = [
        'src/renderer/src/App.tsx',
        'src/main/index.ts',
        'src/main/terminalSessionManager.ts',
        'src/shared/securityUtils.ts',
        'src/renderer/src/services/tools/gitStatusTool.ts',
        'package.json'
      ]

      it('gives top rank and explicit flag to exact file mentions', () => {
        const candidates = engine.rankCandidateFiles('please inspect App.tsx for changes', filePaths)
        expect(candidates.length).toBeGreaterThan(0)
        expect(candidates[0].path).toBe('src/renderer/src/App.tsx')
        expect(candidates[0].isExplicit).toBe(true)
        expect(candidates[0].score).toBeGreaterThanOrEqual(500)
      })

      it('scores Git-related files highly for Git intent prompts', () => {
        const candidates = engine.rankCandidateFiles('how does git commit and branch work', filePaths)
        const gitCandidate = candidates.find((c) => c.path.includes('gitStatusTool'))
        expect(gitCandidate).toBeDefined()
        expect(gitCandidate?.score).toBeGreaterThan(100)
      })

      it('scores Terminal-related files highly for Terminal intent prompts', () => {
        const candidates = engine.rankCandidateFiles('fix terminal command execution in powershell', filePaths)
        const termCandidate = candidates.find((c) => c.path.includes('terminalSessionManager'))
        expect(termCandidate).toBeDefined()
        expect(termCandidate?.score).toBeGreaterThan(100)
      })
    })
  })
})
