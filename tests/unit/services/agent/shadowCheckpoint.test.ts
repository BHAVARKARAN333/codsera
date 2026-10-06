import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ShadowBuffer } from '@renderer/services/agent/shadowBuffer'
import { ShadowCheckpointManager } from '@renderer/services/agent/shadowCheckpoint'
import { setupMockElectron, resetMockElectron } from '../../../setup/electronMock'

describe('ShadowCheckpoint & Transactional Rollback Tests (Phase 14.2)', () => {
  let shadowBuffer: ShadowBuffer
  let checkpointManager: ShadowCheckpointManager
  const workspaceRoot = 'C:/mock/workspace'

  const resolveKey = (rel: string): string => {
    return rel.replace(/\\/g, '/').split('/').pop() || rel
  }

  beforeEach(() => {
    shadowBuffer = new ShadowBuffer()
    checkpointManager = new ShadowCheckpointManager(shadowBuffer)
    setupMockElectron({
      readWorkspaceFile: vi.fn(),
      editWorkspaceFile: vi.fn()
    })
  })

  afterEach(() => {
    resetMockElectron()
  })

  // 1. Checkpoint captures only dirty files
  it('1. captures only dirty files in the checkpoint, excluding clean files', () => {
    shadowBuffer.createSnapshot('A.tsx', 'content A', workspaceRoot)
    shadowBuffer.createSnapshot('B.tsx', 'content B', workspaceRoot)
    shadowBuffer.createSnapshot('C.ts', 'content C', workspaceRoot)

    // Mark only A.tsx and B.tsx dirty
    shadowBuffer.updateShadowContent('A.tsx', 'modified A', workspaceRoot)
    shadowBuffer.updateShadowContent('B.tsx', 'modified B', workspaceRoot)

    const checkpoint = checkpointManager.createCheckpoint(workspaceRoot)

    expect(checkpoint.fileCount).toBe(2)
    expect(checkpoint.state).toBe('ACTIVE')
    expect(checkpointManager.hasFile('A.tsx', checkpoint.checkpointId, workspaceRoot)).toBe(true)
    expect(checkpointManager.hasFile('B.tsx', checkpoint.checkpointId, workspaceRoot)).toBe(true)
    expect(checkpointManager.hasFile('C.ts', checkpoint.checkpointId, workspaceRoot)).toBe(false)
  })

  // 2. Checkpoint is immutable after ShadowBuffer changes
  it('2. ensures checkpoint is immutable after creation even if ShadowBuffer undergoes later edits', () => {
    shadowBuffer.createSnapshot('A.tsx', 'original A', workspaceRoot)
    shadowBuffer.updateShadowContent('A.tsx', 'staged A v1', workspaceRoot)

    const checkpoint = checkpointManager.createCheckpoint(workspaceRoot)
    const fileBefore = checkpointManager.getFile('A.tsx', checkpoint.checkpointId, workspaceRoot)
    expect(fileBefore?.shadowContent).toBe('staged A v1')
    expect(fileBefore?.revision).toBe(1)

    // Later modification in ShadowBuffer
    shadowBuffer.updateShadowContent('A.tsx', 'staged A v2', workspaceRoot)
    expect(shadowBuffer.getShadowContent('A.tsx', workspaceRoot)).toBe('staged A v2')

    // Checkpoint must retain its original captured snapshot!
    const fileAfter = checkpointManager.getFile('A.tsx', checkpoint.checkpointId, workspaceRoot)
    expect(fileAfter?.shadowContent).toBe('staged A v1')
    expect(fileAfter?.revision).toBe(1)
  })

  // 3. Preflight detects one conflicting file before ANY write
  it('3. preflight detects a conflicting file before ANY write, aborting the entire transaction', async () => {
    const diskStore: Record<string, string> = {
      'A.tsx': 'content A',
      'B.tsx': 'content B MODIFIED EXTERNALLY',
      'C.ts': 'content C'
    }

    const editWorkspaceFileMock = vi.fn().mockImplementation(async (_root, rel, newContent) => {
      const key = resolveKey(rel)
      diskStore[key] = newContent
      return { success: true }
    })

    const readWorkspaceFileMock = vi.fn().mockImplementation(async (_root, rel) => {
      const key = resolveKey(rel)
      const content = diskStore[key]
      return content !== undefined ? { success: true, content } : { success: false, error: 'Not found' }
    })

    setupMockElectron({
      readWorkspaceFile: readWorkspaceFileMock,
      editWorkspaceFile: editWorkspaceFileMock
    })

    shadowBuffer.createSnapshot('A.tsx', 'content A', workspaceRoot)
    shadowBuffer.createSnapshot('B.tsx', 'content B', workspaceRoot)
    shadowBuffer.createSnapshot('C.ts', 'content C', workspaceRoot)

    shadowBuffer.updateShadowContent('A.tsx', 'new A', workspaceRoot)
    shadowBuffer.updateShadowContent('B.tsx', 'new B', workspaceRoot)
    shadowBuffer.updateShadowContent('C.ts', 'new C', workspaceRoot)

    const checkpoint = checkpointManager.createCheckpoint(workspaceRoot)
    expect(checkpoint.fileCount).toBe(3)

    const result = await checkpointManager.commitCheckpoint(checkpoint.checkpointId, {
      workspaceRoot,
      skipApproval: true
    })

    expect(result.success).toBe(false)
    expect(result.conflict).toBe(true)
    expect(result.state).toBe('CONFLICTED')
    // ZERO files must be written when preflight fails!
    expect(editWorkspaceFileMock).not.toHaveBeenCalled()
    expect(diskStore['A.tsx']).toBe('content A')
    expect(diskStore['C.ts']).toBe('content C')
  })

  // 4. Successful multi-file commit updates all files
  it('4. commits all files transactionally and updates physical disk when preflight succeeds', async () => {
    const diskStore: Record<string, string> = {
      'A.tsx': 'old A',
      'B.tsx': 'old B',
      'C.ts': 'old C'
    }

    const editWorkspaceFileMock = vi.fn().mockImplementation(async (_root, rel, newContent) => {
      const key = resolveKey(rel)
      diskStore[key] = newContent
      return { success: true, path: rel }
    })

    const readWorkspaceFileMock = vi.fn().mockImplementation(async (_root, rel) => {
      const key = resolveKey(rel)
      return { success: true, content: diskStore[key] }
    })

    setupMockElectron({
      readWorkspaceFile: readWorkspaceFileMock,
      editWorkspaceFile: editWorkspaceFileMock
    })

    shadowBuffer.createSnapshot('A.tsx', 'old A', workspaceRoot)
    shadowBuffer.createSnapshot('B.tsx', 'old B', workspaceRoot)
    shadowBuffer.createSnapshot('C.ts', 'old C', workspaceRoot)

    shadowBuffer.updateShadowContent('A.tsx', 'new A', workspaceRoot)
    shadowBuffer.updateShadowContent('B.tsx', 'new B', workspaceRoot)
    shadowBuffer.updateShadowContent('C.ts', 'new C', workspaceRoot)

    const checkpoint = checkpointManager.createCheckpoint(workspaceRoot)
    const committedPaths: string[] = []

    const result = await checkpointManager.commitCheckpoint(checkpoint.checkpointId, {
      workspaceRoot,
      skipApproval: true,
      onFileCommitted: (p) => committedPaths.push(p)
    })

    expect(result.success).toBe(true)
    expect(result.state).toBe('COMMITTED')
    expect(result.committedFiles.length).toBe(3)
    expect(committedPaths.length).toBe(3)

    // Verify all 3 files updated on disk
    expect(diskStore['A.tsx']).toBe('new A')
    expect(diskStore['B.tsx']).toBe('new B')
    expect(diskStore['C.ts']).toBe('new C')
  })

  // 5. Simulated later write failure triggers rollback
  it('5. triggers safe rollback when a later write fails midway', async () => {
    const diskStore: Record<string, string> = {
      'A.tsx': 'old A',
      'B.tsx': 'old B',
      'C.ts': 'old C'
    }

    const editWorkspaceFileMock = vi.fn().mockImplementation(async (_root, rel, newContent) => {
      const key = resolveKey(rel)
      diskStore[key] = newContent
      return { success: true, path: rel }
    })

    const readWorkspaceFileMock = vi.fn().mockImplementation(async (_root, rel) => {
      const key = resolveKey(rel)
      return { success: true, content: diskStore[key] }
    })

    setupMockElectron({
      readWorkspaceFile: readWorkspaceFileMock,
      editWorkspaceFile: editWorkspaceFileMock
    })

    shadowBuffer.createSnapshot('A.tsx', 'old A', workspaceRoot)
    shadowBuffer.createSnapshot('B.tsx', 'old B', workspaceRoot)
    shadowBuffer.createSnapshot('C.ts', 'old C', workspaceRoot)

    shadowBuffer.updateShadowContent('A.tsx', 'new A', workspaceRoot)
    shadowBuffer.updateShadowContent('B.tsx', 'new B', workspaceRoot)
    shadowBuffer.updateShadowContent('C.ts', 'new C', workspaceRoot)

    const checkpoint = checkpointManager.createCheckpoint(workspaceRoot)

    // Simulate failure on C.ts: A and B are written first, then C fails
    const result = await checkpointManager.commitCheckpoint(checkpoint.checkpointId, {
      workspaceRoot,
      skipApproval: true,
      _simulateWriteFailureOnPath: 'C:/mock/workspace/C.ts'
    })

    expect(result.success).toBe(false)
    expect(result.state).toBe('ROLLED_BACK')
    expect(result.rolledBackFiles?.length).toBeGreaterThanOrEqual(1)
    expect(result.error).toContain('TRANSACTION_ROLLED_BACK')
  })

  // 6. Rollback restores previously modified files and verifies hashes
  it('6. safely restores previously modified files back to baseline on rollback', async () => {
    const diskStore: Record<string, string> = {
      'A.tsx': 'original A content',
      'B.tsx': 'original B content',
      'C.ts': 'original C content'
    }

    const editWorkspaceFileMock = vi.fn().mockImplementation(async (_root, rel, newContent) => {
      const key = resolveKey(rel)
      diskStore[key] = newContent
      return { success: true, path: rel }
    })

    const readWorkspaceFileMock = vi.fn().mockImplementation(async (_root, rel) => {
      const key = resolveKey(rel)
      return { success: true, content: diskStore[key] }
    })

    setupMockElectron({
      readWorkspaceFile: readWorkspaceFileMock,
      editWorkspaceFile: editWorkspaceFileMock
    })

    shadowBuffer.createSnapshot('A.tsx', 'original A content', workspaceRoot)
    shadowBuffer.createSnapshot('B.tsx', 'original B content', workspaceRoot)
    shadowBuffer.createSnapshot('C.ts', 'original C content', workspaceRoot)

    shadowBuffer.updateShadowContent('A.tsx', 'staged A', workspaceRoot)
    shadowBuffer.updateShadowContent('B.tsx', 'staged B', workspaceRoot)
    shadowBuffer.updateShadowContent('C.ts', 'staged C', workspaceRoot)

    const checkpoint = checkpointManager.createCheckpoint(workspaceRoot)

    // Force failure on B.tsx after A.tsx is written
    const result = await checkpointManager.commitCheckpoint(checkpoint.checkpointId, {
      workspaceRoot,
      skipApproval: true,
      _simulateWriteFailureOnPath: 'C:/mock/workspace/B.tsx'
    })

    expect(result.success).toBe(false)
    expect(result.state).toBe('ROLLED_BACK')
    // A.tsx was written and then rolled back
    expect(diskStore['A.tsx']).toBe('original A content')
    expect(diskStore['B.tsx']).toBe('original B content')
    expect(diskStore['C.ts']).toBe('original C content')
  })

  // 7. Successful commit synchronizes ShadowBuffer state
  it('7. synchronizes ShadowBuffer baseline state after successful commit so dirty state clears', async () => {
    const diskStore: Record<string, string> = {
      'A.tsx': 'old A',
      'B.tsx': 'old B'
    }

    setupMockElectron({
      readWorkspaceFile: vi.fn().mockImplementation(async (_root, rel) => {
        const key = resolveKey(rel)
        return { success: true, content: diskStore[key] }
      }),
      editWorkspaceFile: vi.fn().mockImplementation(async (_root, rel, newContent) => {
        const key = resolveKey(rel)
        diskStore[key] = newContent
        return { success: true, path: rel }
      })
    })

    shadowBuffer.createSnapshot('A.tsx', 'old A', workspaceRoot)
    shadowBuffer.createSnapshot('B.tsx', 'old B', workspaceRoot)

    shadowBuffer.updateShadowContent('A.tsx', 'new A', workspaceRoot)
    shadowBuffer.updateShadowContent('B.tsx', 'new B', workspaceRoot)

    expect(shadowBuffer.isDirty('A.tsx', workspaceRoot)).toBe(true)
    expect(shadowBuffer.isDirty('B.tsx', workspaceRoot)).toBe(true)

    const checkpoint = checkpointManager.createCheckpoint(workspaceRoot)
    const result = await checkpointManager.commitCheckpoint(checkpoint.checkpointId, {
      workspaceRoot,
      skipApproval: true
    })

    expect(result.success).toBe(true)
    expect(result.state).toBe('COMMITTED')

    // After commit, ShadowBuffer entries should be clean and matching new baseline
    expect(shadowBuffer.isDirty('A.tsx', workspaceRoot)).toBe(false)
    expect(shadowBuffer.isDirty('B.tsx', workspaceRoot)).toBe(false)
    expect(shadowBuffer.getOriginalContent('A.tsx', workspaceRoot)).toBe('new A')
    expect(shadowBuffer.getOriginalContent('B.tsx', workspaceRoot)).toBe('new B')
    expect(shadowBuffer.listDirtyFiles()).toEqual([])
  })
})
