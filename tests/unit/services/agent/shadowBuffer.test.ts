import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ShadowBuffer, computeContentHash } from '@renderer/services/agent/shadowBuffer'
import { setupMockElectron, resetMockElectron } from '../../../setup/electronMock'

describe('ShadowBuffer Unit Tests (Phase 14.0)', () => {
  let shadowBuffer: ShadowBuffer
  const workspaceRoot = 'C:/mock/workspace'

  beforeEach(() => {
    shadowBuffer = new ShadowBuffer()
    setupMockElectron({
      readWorkspaceFile: vi.fn(),
      editWorkspaceFile: vi.fn()
    })
  })

  afterEach(() => {
    resetMockElectron()
  })

  // 1. Snapshot Creation & Revision Baseline
  it('1. creates snapshot with revision 0, matching hashes, and clean dirty state', () => {
    const entry = shadowBuffer.createSnapshot('src/app.ts', 'const x = 1;', workspaceRoot)

    expect(entry.normalizedPath).toBe('C:/mock/workspace/src/app.ts')
    expect(entry.originalContent).toBe('const x = 1;')
    expect(entry.shadowContent).toBe('const x = 1;')
    expect(entry.revision).toBe(0)
    expect(entry.dirty).toBe(false)
    expect(entry.isConflicted).toBe(false)
    expect(entry.originalHash).toBe(computeContentHash('const x = 1;'))
    expect(entry.currentHash).toBe(entry.originalHash)

    // Re-creating returns existing snapshot
    const duplicate = shadowBuffer.createSnapshot('src/app.ts', 'different content', workspaceRoot)
    expect(duplicate.revision).toBe(0)
    expect(duplicate.originalContent).toBe('const x = 1;')
  })

  // 2. In-Memory Shadow Updates & Revision Increment
  it('2. updates shadow content in-memory with monotonic revision increment without disk access', () => {
    shadowBuffer.createSnapshot('src/app.ts', 'const x = 1;', workspaceRoot)

    const update1 = shadowBuffer.updateShadowContent('src/app.ts', 'const x = 2;', workspaceRoot)
    expect(update1.success).toBe(true)
    expect(update1.entry?.revision).toBe(1)
    expect(update1.entry?.dirty).toBe(true)
    expect(update1.entry?.shadowContent).toBe('const x = 2;')
    expect(update1.entry?.originalContent).toBe('const x = 1;')

    const update2 = shadowBuffer.updateShadowContent('src/app.ts', 'const x = 3;', workspaceRoot)
    expect(update2.success).toBe(true)
    expect(update2.entry?.revision).toBe(2)
    expect(update2.entry?.dirty).toBe(true)
    expect(update2.entry?.shadowContent).toBe('const x = 3;')

    expect(shadowBuffer.getShadowContent('src/app.ts', workspaceRoot)).toBe('const x = 3;')
    expect(shadowBuffer.getOriginalContent('src/app.ts', workspaceRoot)).toBe('const x = 1;')
  })

  // 3. Search/Replace Block Patching on Shadow Content
  it('3. applies sequential SEARCH/REPLACE patches against latest shadow content', () => {
    shadowBuffer.createSnapshot(
      'src/math.ts',
      'function add(a, b) {\n  return a - b;\n}\n',
      workspaceRoot
    )

    // First patch: A -> B
    const patch1 = [
      '<<<<<<< SEARCH',
      '  return a - b;',
      '=======',
      '  return a + b;',
      '>>>>>>> REPLACE'
    ].join('\n')

    const res1 = shadowBuffer.applyPatch('src/math.ts', patch1, undefined, workspaceRoot)
    expect(res1.success).toBe(true)
    expect(res1.revision).toBe(1)
    expect(shadowBuffer.getShadowContent('src/math.ts', workspaceRoot)).toContain('return a + b;')

    // Second patch operates against B -> C
    const patch2 = [
      '<<<<<<< SEARCH',
      'function add(a, b) {',
      '  return a + b;',
      '}',
      '=======',
      'function add(a: number, b: number): number {',
      '  return a + b;',
      '}',
      '>>>>>>> REPLACE'
    ].join('\n')

    const res2 = shadowBuffer.applyPatch('src/math.ts', patch2, undefined, workspaceRoot)
    expect(res2.success).toBe(true)
    expect(res2.revision).toBe(2)
    expect(shadowBuffer.getShadowContent('src/math.ts', workspaceRoot)).toContain(
      'function add(a: number, b: number): number'
    )
    expect(shadowBuffer.getOriginalContent('src/math.ts', workspaceRoot)).toContain(
      'return a - b;'
    )
  })

  // 4. Safe Reset / Discard Behavior
  it('4. resets shadow content back to original content, clearing dirty status and incrementing revision', () => {
    shadowBuffer.createSnapshot('src/config.ts', 'PORT=3000', workspaceRoot)
    shadowBuffer.updateShadowContent('src/config.ts', 'PORT=8080', workspaceRoot)
    expect(shadowBuffer.isDirty('src/config.ts', workspaceRoot)).toBe(true)

    const resetRes = shadowBuffer.reset('src/config.ts', workspaceRoot)
    expect(resetRes.success).toBe(true)
    expect(resetRes.entry?.shadowContent).toBe('PORT=3000')
    expect(resetRes.entry?.dirty).toBe(false)
    expect(resetRes.entry?.revision).toBe(2)
    expect(shadowBuffer.getShadowContent('src/config.ts', workspaceRoot)).toBe('PORT=3000')
  })

  // 5. Stale Workspace Hash Prevents Commit (SHADOW_CONFLICT)
  it('5. prevents commit and marks conflict if workspace file changed on disk after snapshot', async () => {
    shadowBuffer.createSnapshot('src/service.ts', 'original v1', workspaceRoot)
    shadowBuffer.updateShadowContent('src/service.ts', 'ai modified v2', workspaceRoot)

    // Simulate disk file having changed externally to v1.1
    vi.mocked(window.electronAPI.readWorkspaceFile).mockResolvedValue({
      success: true,
      content: 'externally changed v1.1'
    })

    const commitRes = await shadowBuffer.commit('src/service.ts', {
      workspaceRoot
    })

    expect(commitRes.success).toBe(false)
    expect(commitRes.conflict).toBe(true)
    expect(commitRes.error).toContain('SHADOW_CONFLICT')
    expect(shadowBuffer.getSnapshot('src/service.ts', workspaceRoot)?.isConflicted).toBe(true)
    expect(window.electronAPI.editWorkspaceFile).not.toHaveBeenCalled()
  })

  // 6. Successful Commit Updates Real File & Synchronizes State
  it('6. commits shadow content to disk via IPC and updates baseline state when hashes match', async () => {
    const original = 'let count = 0;'
    const modified = 'let count = 10;'

    shadowBuffer.createSnapshot('src/counter.ts', original, workspaceRoot)
    shadowBuffer.updateShadowContent('src/counter.ts', modified, workspaceRoot)

    vi.mocked(window.electronAPI.readWorkspaceFile).mockResolvedValue({
      success: true,
      content: original
    })
    vi.mocked(window.electronAPI.editWorkspaceFile).mockResolvedValue({
      success: true,
      path: 'src/counter.ts'
    })

    const onFileEdited = vi.fn()
    const commitRes = await shadowBuffer.commit('src/counter.ts', {
      workspaceRoot,
      onFileEdited
    })

    expect(commitRes.success).toBe(true)
    expect(commitRes.content).toBe(modified)
    expect(window.electronAPI.editWorkspaceFile).toHaveBeenCalledWith(
      workspaceRoot,
      'src/counter.ts',
      modified,
      original
    )

    // Baseline is now synchronized with disk
    const updatedEntry = shadowBuffer.getSnapshot('src/counter.ts', workspaceRoot)
    expect(updatedEntry?.dirty).toBe(false)
    expect(updatedEntry?.originalContent).toBe(modified)
    expect(updatedEntry?.shadowContent).toBe(modified)
    expect(onFileEdited).toHaveBeenCalled()
  })

  // 7. Multi-File Support & Strict Isolation
  it('7. maintains independent shadow buffers, revisions, and states across multiple files', () => {
    shadowBuffer.createSnapshot('src/a.ts', 'const a = 1;', workspaceRoot)
    shadowBuffer.createSnapshot('src/b.ts', 'const b = 1;', workspaceRoot)

    shadowBuffer.updateShadowContent('src/a.ts', 'const a = 100;', workspaceRoot)

    expect(shadowBuffer.isDirty('src/a.ts', workspaceRoot)).toBe(true)
    expect(shadowBuffer.isDirty('src/b.ts', workspaceRoot)).toBe(false)

    expect(shadowBuffer.getSnapshot('src/a.ts', workspaceRoot)?.revision).toBe(1)
    expect(shadowBuffer.getSnapshot('src/b.ts', workspaceRoot)?.revision).toBe(0)

    const dirtyList = shadowBuffer.listDirtyFiles()
    expect(dirtyList.length).toBe(1)
    expect(dirtyList[0]).toContain('src/a.ts')
  })

  // 8. Removal & Lifecycle Reset
  it('8. removes snapshot cleanly without affecting physical workspace file', () => {
    shadowBuffer.createSnapshot('src/temp.ts', 'temp', workspaceRoot)
    expect(shadowBuffer.hasSnapshot('src/temp.ts', workspaceRoot)).toBe(true)

    const removed = shadowBuffer.remove('src/temp.ts', workspaceRoot)
    expect(removed).toBe(true)
    expect(shadowBuffer.hasSnapshot('src/temp.ts', workspaceRoot)).toBe(false)
  })
})
