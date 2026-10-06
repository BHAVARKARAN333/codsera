import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { isSafePath, isValidBranchName } from '@shared/securityUtils'
import { createMockElectronAPI, setupMockElectron, resetMockElectron } from './setup/electronMock'

describe('Vitest Testing Infrastructure Smoke Suite', () => {
  beforeEach(() => {
    setupMockElectron()
  })

  afterEach(() => {
    resetMockElectron()
  })

  it('executes basic assertions in Vitest environment', () => {
    expect(true).toBe(true)
    expect([1, 2, 3]).toHaveLength(3)
  })

  it('resolves @shared path alias correctly', () => {
    expect(isSafePath('src/main/index.ts')).toBe(true)
    expect(isSafePath('src/\0invalid')).toBe(false)
    expect(isValidBranchName('feature/branch-1').valid).toBe(true)
    expect(isValidBranchName('-invalid-start').valid).toBe(false)
  })

  it('provides safe typed mock electronAPI on global window', async () => {
    const api = (window as unknown as { electronAPI: ReturnType<typeof createMockElectronAPI> }).electronAPI
    expect(api).toBeDefined()
    expect(typeof api.gitStatus).toBe('function')

    const status = await api.gitStatus('/mock/workspace')
    expect(status.success).toBe(true)
    expect(status.isRepository).toBe(true)
    expect(status.branch).toBe('main')
    expect(status.clean).toBe(true)
  })

  it('supports overriding mock electronAPI methods', async () => {
    const customApi = createMockElectronAPI({
      gitStatus: async () => ({
        success: true,
        isRepository: false,
        branch: null,
        staged: [],
        unstaged: [],
        untracked: [],
        conflicted: [],
        error: 'Not a git repo'
      })
    })

    const status = await customApi.gitStatus('/custom/path')
    expect(status.success).toBe(true)
    expect(status.isRepository).toBe(false)
    expect(status.error).toBe('Not a git repo')
  })
})
