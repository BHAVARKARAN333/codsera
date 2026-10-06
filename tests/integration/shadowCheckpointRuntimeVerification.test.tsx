// @vitest-environment happy-dom
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { EditorPane } from '@renderer/components/EditorPane'
import { ShadowBuffer } from '@renderer/services/agent/shadowBuffer'
import { ShadowCheckpointManager } from '@renderer/services/agent/shadowCheckpoint'
import { setupMockElectron, resetMockElectron } from '../setup/electronMock'

// Mock Monaco Editor (Hoisted for Vitest)
const { mockEditorInstance, mockMonaco } = vi.hoisted(() => {
  const instance = {
    getValue: vi.fn().mockReturnValue(''),
    setValue: vi.fn(),
    addCommand: vi.fn(),
    onDidChangeCursorPosition: vi.fn(),
    getPosition: vi.fn().mockReturnValue({ lineNumber: 1, column: 1 }),
    getVisibleRanges: vi.fn().mockReturnValue([{ startLineNumber: 1, endLineNumber: 20 }]),
    getModel: vi.fn().mockReturnValue({
      original: { getValue: vi.fn().mockReturnValue(''), setValue: vi.fn() },
      modified: { getValue: vi.fn().mockReturnValue(''), setValue: vi.fn() }
    })
  }

  const monaco = {
    editor: {
      defineTheme: vi.fn(),
      setTheme: vi.fn()
    },
    KeyMod: { CtrlCmd: 2048 },
    KeyCode: { KeyS: 49, KeyEnter: 3 }
  }

  return { mockEditorInstance: instance, mockMonaco: monaco }
})

vi.mock('@renderer/monacoConfig', () => ({
  monaco: mockMonaco
}))

vi.mock('monaco-editor', () => ({
  editor: {
    defineTheme: vi.fn(),
    setTheme: vi.fn()
  },
  KeyMod: { CtrlCmd: 2048 },
  KeyCode: { KeyS: 49, KeyEnter: 3 }
}))

vi.mock('@monaco-editor/react', () => {
  const MockEditor = ({ value, onChange, onMount }: any) => {
    React.useEffect(() => {
      mockEditorInstance.getValue.mockReturnValue(value || '')
      onMount?.(mockEditorInstance, mockMonaco)
    }, [])

    return (
      <textarea
        data-testid="monaco-editor-mock"
        value={value}
        onChange={(e) => {
          mockEditorInstance.getValue.mockReturnValue(e.target.value)
          onChange?.(e.target.value)
        }}
      />
    )
  }

  const MockDiffEditor = ({ original, modified, onMount }: any) => {
    React.useEffect(() => {
      onMount?.(mockEditorInstance, mockMonaco)
    }, [])

    return (
      <div data-testid="monaco-diff-editor-mock">
        <div data-testid="diff-original">{original}</div>
        <div data-testid="diff-modified">{modified}</div>
      </div>
    )
  }

  return {
    __esModule: true,
    default: MockEditor,
    DiffEditor: MockDiffEditor,
    loader: {
      config: vi.fn(),
      init: vi.fn().mockResolvedValue(mockMonaco)
    }
  }
})

describe('Phase 14.2 — Practical Runtime Verification (Step 22)', () => {
  let shadowBuffer: ShadowBuffer
  let checkpointManager: ShadowCheckpointManager
  const workspaceRoot = 'C:/mock/workspace'
  let diskStore: Record<string, string> = {}

  const resolveKey = (rel: string): string => {
    return rel.replace(/\\/g, '/').split('/').pop() || rel
  }

  beforeEach(() => {
    shadowBuffer = new ShadowBuffer()
    checkpointManager = new ShadowCheckpointManager(shadowBuffer)

    diskStore = {
      'A.ts': 'export const A = 1;\n',
      'B.ts': 'export const B = 2;\n',
      'C.ts': 'export const C = 3;\n'
    }

    setupMockElectron({
      readWorkspaceFile: vi.fn().mockImplementation(async (_root, rel) => {
        const key = resolveKey(rel)
        const content = diskStore[key]
        return content !== undefined
          ? { success: true, content }
          : { success: false, error: 'File not found on disk' }
      }),
      editWorkspaceFile: vi.fn().mockImplementation(async (_root, rel, newContent) => {
        const key = resolveKey(rel)
        diskStore[key] = newContent
        return { success: true, path: rel }
      })
    })
  })

  afterEach(() => {
    resetMockElectron()
  })

  // Scenario 1: Clean Multi-file Staging, Preflight, Approval, Commit, and UI Synchronization
  it('Scenario 1: Stages 3 files, verifies checkpoint, preflight, approval, commit, and ShadowBuffer sync', async () => {
    // 1. Initialize snapshots
    shadowBuffer.createSnapshot('A.ts', diskStore['A.ts'], workspaceRoot)
    shadowBuffer.createSnapshot('B.ts', diskStore['B.ts'], workspaceRoot)
    shadowBuffer.createSnapshot('C.ts', diskStore['C.ts'], workspaceRoot)

    // Stage AI edits in all 3 files
    shadowBuffer.updateShadowContent('A.ts', 'export const A = 100;\n', workspaceRoot)
    shadowBuffer.updateShadowContent('B.ts', 'export const B = 200;\n', workspaceRoot)
    shadowBuffer.updateShadowContent('C.ts', 'export const C = 300;\n', workspaceRoot)

    // 1. Verify checkpoint contains exactly 3 files
    const checkpoint = checkpointManager.createCheckpoint(workspaceRoot)
    expect(checkpoint.fileCount).toBe(3)
    expect(checkpointManager.listCheckpointFiles().length).toBe(3)
    expect(checkpoint.state).toBe('ACTIVE')

    // 2. Verify disk remains completely unchanged before commit
    expect(diskStore['A.ts']).toBe('export const A = 1;\n')
    expect(diskStore['B.ts']).toBe('export const B = 2;\n')
    expect(diskStore['C.ts']).toBe('export const C = 3;\n')

    // 3. UI Multi-File Diff review rendering
    const onApplyAllMock = vi.fn()
    const onDiscardAllMock = vi.fn()

    const snapA = shadowBuffer.getSnapshot('A.ts', workspaceRoot)!
    const { rerender } = render(
      <EditorPane
        filePath="A.ts"
        content={snapA.originalContent}
        onChange={vi.fn()}
        onSave={vi.fn()}
        shadowDiff={{
          originalContent: snapA.originalContent,
          shadowContent: snapA.shadowContent,
          revision: snapA.revision,
          dirty: snapA.dirty,
          isConflicted: snapA.isConflicted
        }}
        multiFileDiffInfo={{
          dirtyFileCount: 3,
          dirtyFiles: ['A.ts', 'B.ts', 'C.ts'],
          onApplyAll: onApplyAllMock,
          onDiscardAll: onDiscardAllMock
        }}
      />
    )

    // Verify multi-file action buttons are visible in diff toolbar
    const applyAllBtn = screen.getByTestId('inline-diff-apply-all-btn')
    const discardAllBtn = screen.getByTestId('inline-diff-discard-all-btn')
    expect(applyAllBtn).toBeInTheDocument()
    expect(discardAllBtn).toBeInTheDocument()
    expect(applyAllBtn.textContent).toContain('Apply All (3)')

    // Click Apply All
    fireEvent.click(applyAllBtn)
    expect(onApplyAllMock).toHaveBeenCalledTimes(1)

    // 4. Preflight succeeds
    const preflight = await checkpointManager.preflight(checkpoint.checkpointId, workspaceRoot)
    expect(preflight.valid).toBe(true)
    expect(preflight.checkedFiles).toBe(3)
    expect(preflight.errors).toEqual([])

    // 5. Approval & Commit Transaction
    let approvalRequested = false
    const commitResult = await checkpointManager.commitCheckpoint(checkpoint.checkpointId, {
      workspaceRoot,
      requestApproval: async (files) => {
        approvalRequested = true
        expect(files.length).toBe(3)
        return true // User approves
      }
    })

    expect(approvalRequested).toBe(true)
    expect(commitResult.success).toBe(true)
    expect(commitResult.state).toBe('COMMITTED')
    expect(commitResult.committedFiles.length).toBe(3)

    // 6. Verify physical disk updated for all 3 files
    expect(diskStore['A.ts']).toBe('export const A = 100;\n')
    expect(diskStore['B.ts']).toBe('export const B = 200;\n')
    expect(diskStore['C.ts']).toBe('export const C = 300;\n')

    // 7. Verify ShadowBuffer becomes clean
    expect(shadowBuffer.isDirty('A.ts', workspaceRoot)).toBe(false)
    expect(shadowBuffer.isDirty('B.ts', workspaceRoot)).toBe(false)
    expect(shadowBuffer.isDirty('C.ts', workspaceRoot)).toBe(false)
    expect(shadowBuffer.listDirtyFiles()).toEqual([])

    // 8. Verify diff state disappears in UI
    rerender(
      <EditorPane
        filePath="A.ts"
        content={diskStore['A.ts']}
        onChange={vi.fn()}
        onSave={vi.fn()}
        shadowDiff={null}
        multiFileDiffInfo={null}
      />
    )
    expect(screen.queryByTestId('inline-diff-container')).not.toBeInTheDocument()
    expect(screen.getByTestId('monaco-editor-mock')).toBeInTheDocument()
  })

  // Scenario 2: Controlled Conflict on B.ts -> Preflight Aborts, Zero Writes
  it('Scenario 2: Detects controlled external conflict on B.ts, aborts preflight, writes NO files', async () => {
    shadowBuffer.createSnapshot('A.ts', diskStore['A.ts'], workspaceRoot)
    shadowBuffer.createSnapshot('B.ts', diskStore['B.ts'], workspaceRoot)
    shadowBuffer.createSnapshot('C.ts', diskStore['C.ts'], workspaceRoot)

    shadowBuffer.updateShadowContent('A.ts', 'export const A = 111;\n', workspaceRoot)
    shadowBuffer.updateShadowContent('B.ts', 'export const B = 222;\n', workspaceRoot)
    shadowBuffer.updateShadowContent('C.ts', 'export const C = 333;\n', workspaceRoot)

    // 2. Externally modify B.ts on disk
    diskStore['B.ts'] = 'export const B = 999; // MODIFIED EXTERNALLY\n'

    // 3. Start commit flow
    const checkpoint = checkpointManager.createCheckpoint(workspaceRoot)
    expect(checkpoint.fileCount).toBe(3)

    // Track write calls
    const editSpy = vi.fn().mockImplementation(async (_root, rel, newContent) => {
      const key = resolveKey(rel)
      diskStore[key] = newContent
      return { success: true }
    })
    setupMockElectron({
      readWorkspaceFile: vi.fn().mockImplementation(async (_root, rel) => {
        const key = resolveKey(rel)
        return { success: true, content: diskStore[key] }
      }),
      editWorkspaceFile: editSpy
    })

    const commitResult = await checkpointManager.commitCheckpoint(checkpoint.checkpointId, {
      workspaceRoot,
      skipApproval: true
    })

    // 4. Verify preflight detects B conflict and transaction stops
    expect(commitResult.success).toBe(false)
    expect(commitResult.conflict).toBe(true)
    expect(commitResult.state).toBe('CONFLICTED')
    expect(commitResult.error).toContain('SHADOW_CONFLICT')

    // 5. Verify A and C are NOT written!
    expect(editSpy).not.toHaveBeenCalled()
    expect(diskStore['A.ts']).toBe('export const A = 1;\n')
    expect(diskStore['C.ts']).toBe('export const C = 3;\n')

    // 6. Verify B external content remains completely untouched
    expect(diskStore['B.ts']).toBe('export const B = 999; // MODIFIED EXTERNALLY\n')

    // Verify checkpoint and shadow buffer marked conflicted
    expect(checkpointManager.getActiveCheckpoint()?.state).toBe('CONFLICTED')
    expect(shadowBuffer.getSnapshot('B.ts', workspaceRoot)?.isConflicted).toBe(true)
  })

  // Scenario 3: Controlled Write Failure Simulation on B.ts -> Rollback A.ts, C.ts untouched
  it('Scenario 3: Simulates write failure on B.ts after A.ts write, verifies rollback of A.ts, C.ts unwritten', async () => {
    shadowBuffer.createSnapshot('A.ts', diskStore['A.ts'], workspaceRoot)
    shadowBuffer.createSnapshot('B.ts', diskStore['B.ts'], workspaceRoot)
    shadowBuffer.createSnapshot('C.ts', diskStore['C.ts'], workspaceRoot)

    shadowBuffer.updateShadowContent('A.ts', 'export const A = 400;\n', workspaceRoot)
    shadowBuffer.updateShadowContent('B.ts', 'export const B = 500;\n', workspaceRoot)
    shadowBuffer.updateShadowContent('C.ts', 'export const C = 600;\n', workspaceRoot)

    const checkpoint = checkpointManager.createCheckpoint(workspaceRoot)

    // Execute with simulated write failure on B.ts
    const commitResult = await checkpointManager.commitCheckpoint(checkpoint.checkpointId, {
      workspaceRoot,
      skipApproval: true,
      _simulateWriteFailureOnPath: 'C:/mock/workspace/B.ts'
    })

    // 1. Transaction failed and initiated rollback
    expect(commitResult.success).toBe(false)
    expect(commitResult.state).toBe('ROLLED_BACK')
    expect(commitResult.error).toContain('TRANSACTION_ROLLED_BACK')

    // 2. A.ts was written then restored back to baseline
    expect(diskStore['A.ts']).toBe('export const A = 1;\n')

    // 3. B.ts was never overwritten with invalid content
    expect(diskStore['B.ts']).toBe('export const B = 2;\n')

    // 4. C.ts was never touched
    expect(diskStore['C.ts']).toBe('export const C = 3;\n')

    // 5. Staged shadow changes remain recoverable in memory!
    expect(shadowBuffer.getShadowContent('A.ts', workspaceRoot)).toBe('export const A = 400;\n')
    expect(shadowBuffer.getShadowContent('B.ts', workspaceRoot)).toBe('export const B = 500;\n')
    expect(shadowBuffer.getShadowContent('C.ts', workspaceRoot)).toBe('export const C = 600;\n')
  })
})
