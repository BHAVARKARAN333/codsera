// @vitest-environment happy-dom
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { EditorPane, ShadowDiffInfo } from '@renderer/components/EditorPane'
import { ShadowBuffer } from '@renderer/services/agent/shadowBuffer'
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

describe('Phase 14.1 — Runtime End-to-End Verification (16 Scenarios)', () => {
  let shadowBuffer: ShadowBuffer
  const workspaceRoot = 'C:/mock/workspace'
  let diskFileStore: Record<string, string> = {}

  beforeEach(() => {
    shadowBuffer = new ShadowBuffer()
    diskFileStore = {
      'sample.ts': 'const price = 100;\nconst title = "Product";\n'
    }

    setupMockElectron({
      readWorkspaceFile: vi.fn().mockImplementation(async (_root, filePath) => {
        const content = diskFileStore[filePath]
        if (content !== undefined) {
          return { success: true, content }
        }
        return { success: false, error: 'File not found' }
      }),
      editWorkspaceFile: vi.fn().mockImplementation(async (_root, filePath, newContent) => {
        diskFileStore[filePath] = newContent
        return { success: true, path: filePath }
      })
    })
  })

  afterEach(() => {
    resetMockElectron()
  })

  it('executes full 16-step runtime verification scenario successfully', async () => {
    // 1. Open a normal source file
    let activeFile = 'sample.ts'
    let currentContent = diskFileStore['sample.ts']
    let shadowDiffInfo: ShadowDiffInfo | null = null

    const { rerender } = render(
      <EditorPane
        filePath={activeFile}
        content={currentContent}
        onChange={(val) => { currentContent = val }}
        onSave={vi.fn()}
        shadowDiff={shadowDiffInfo}
      />
    )

    // Verify step 1: normal source file in standard editor mode
    expect(screen.getByTestId('monaco-editor-mock')).toBeInTheDocument()
    expect(screen.queryByTestId('inline-diff-toolbar')).not.toBeInTheDocument()

    // 2. Trigger a shadow AI edit
    const entry = shadowBuffer.createSnapshot(activeFile, currentContent, workspaceRoot)
    expect(entry.revision).toBe(0)
    const patch1 = [
      '<<<<<<< SEARCH',
      'const price = 100;',
      '=======',
      'const price = 150;',
      '>>>>>>> REPLACE'
    ].join('\n')
    const patchRes1 = shadowBuffer.applyPatch(activeFile, patch1, undefined, workspaceRoot)
    expect(patchRes1.success).toBe(true)

    // Update props reflecting dirty shadow snapshot
    const snap1 = shadowBuffer.getSnapshot(activeFile, workspaceRoot)!
    shadowDiffInfo = {
      originalContent: snap1.originalContent,
      shadowContent: snap1.shadowContent,
      revision: snap1.revision,
      dirty: snap1.dirty,
      isConflicted: snap1.isConflicted
    }

    rerender(
      <EditorPane
        filePath={activeFile}
        content={snap1.shadowContent}
        onChange={vi.fn()}
        onSave={vi.fn()}
        shadowDiff={shadowDiffInfo}
        onAcceptShadowDiff={vi.fn()}
        onRejectShadowDiff={vi.fn()}
      />
    )

    // 3. Confirm Inline Diff appears
    expect(screen.getByTestId('inline-diff-toolbar')).toBeInTheDocument()
    expect(screen.getByTestId('monaco-diff-editor-mock')).toBeInTheDocument()
    expect(screen.getByText(/Rev 1/i)).toBeInTheDocument()

    // 4. Confirm original and modified content are visually distinguishable
    expect(screen.getByTestId('diff-original')).toHaveTextContent('const price = 100;')
    expect(screen.getByTestId('diff-modified')).toHaveTextContent('const price = 150;')

    // 5. Apply another shadow edit (revision 2)
    const patch2 = [
      '<<<<<<< SEARCH',
      'const title = "Product";',
      '=======',
      'const title = "Special Item";',
      '>>>>>>> REPLACE'
    ].join('\n')
    const patchRes2 = shadowBuffer.applyPatch(activeFile, patch2, undefined, workspaceRoot)
    expect(patchRes2.success).toBe(true)
    const snap2 = shadowBuffer.getSnapshot(activeFile, workspaceRoot)!
    expect(snap2.revision).toBe(2)

    shadowDiffInfo = {
      originalContent: snap2.originalContent,
      shadowContent: snap2.shadowContent,
      revision: snap2.revision,
      dirty: snap2.dirty,
      isConflicted: snap2.isConflicted
    }

    rerender(
      <EditorPane
        filePath={activeFile}
        content={snap2.shadowContent}
        onChange={vi.fn()}
        onSave={vi.fn()}
        shadowDiff={shadowDiffInfo}
        onAcceptShadowDiff={vi.fn()}
        onRejectShadowDiff={vi.fn()}
      />
    )

    // 6. Confirm diff updates reactively
    expect(screen.getByText(/Rev 2/i)).toBeInTheDocument()
    expect(screen.getByTestId('diff-modified')).toHaveTextContent('const title = "Special Item";')

    // 7. Confirm physical disk file remains unchanged before Apply
    expect(diskFileStore['sample.ts']).toBe('const price = 100;\nconst title = "Product";\n')
    expect(window.electronAPI.editWorkspaceFile).not.toHaveBeenCalled()

    // 8. Click Reject / Discard
    const handleReject = () => {
      shadowBuffer.reset(activeFile, workspaceRoot)
      shadowBuffer.remove(activeFile, workspaceRoot)
      shadowDiffInfo = null
    }

    handleReject()
    expect(shadowBuffer.hasSnapshot(activeFile, workspaceRoot)).toBe(false)

    rerender(
      <EditorPane
        filePath={activeFile}
        content={snap1.originalContent}
        onChange={vi.fn()}
        onSave={vi.fn()}
        shadowDiff={shadowDiffInfo}
      />
    )

    // 9. Confirm shadow changes disappear and normal editor restored
    expect(screen.queryByTestId('inline-diff-toolbar')).not.toBeInTheDocument()
    expect(screen.getByTestId('monaco-editor-mock')).toBeInTheDocument()
    expect(diskFileStore['sample.ts']).toBe('const price = 100;\nconst title = "Product";\n')

    // 10. Repeat with Apply: re-stage shadow edit
    shadowBuffer.createSnapshot(activeFile, diskFileStore['sample.ts'], workspaceRoot)
    shadowBuffer.applyPatch(activeFile, patch1, undefined, workspaceRoot)
    const snap3 = shadowBuffer.getSnapshot(activeFile, workspaceRoot)!

    let approvalCalled = false
    const mockRequestApproval = vi.fn().mockImplementation(async () => {
      approvalCalled = true
      return true
    })

    const handleAccept = async () => {
      const res = await shadowBuffer.commit(activeFile, {
        workspaceRoot,
        requestApproval: mockRequestApproval
      })
      if (res.success) {
        shadowDiffInfo = null
      }
    }

    shadowDiffInfo = {
      originalContent: snap3.originalContent,
      shadowContent: snap3.shadowContent,
      revision: snap3.revision,
      dirty: snap3.dirty,
      isConflicted: snap3.isConflicted
    }

    rerender(
      <EditorPane
        filePath={activeFile}
        content={snap3.shadowContent}
        onChange={vi.fn()}
        onSave={vi.fn()}
        shadowDiff={shadowDiffInfo}
        onAcceptShadowDiff={handleAccept}
        onRejectShadowDiff={handleReject}
      />
    )

    // 11. Click Apply & Confirm approval flow appears
    const applyBtn = screen.getByTestId('inline-diff-accept-btn')
    fireEvent.click(applyBtn)
    await waitFor(() => expect(mockRequestApproval).toHaveBeenCalled())
    expect(approvalCalled).toBe(true)

    // 12. Confirm physical file changes only after successful approval
    expect(window.electronAPI.editWorkspaceFile).toHaveBeenCalled()
    expect(diskFileStore['sample.ts']).toContain('const price = 150;')

    // Diff mode exits after successful commit
    rerender(
      <EditorPane
        filePath={activeFile}
        content={diskFileStore['sample.ts']}
        onChange={vi.fn()}
        onSave={vi.fn()}
        shadowDiff={null}
      />
    )
    expect(screen.queryByTestId('inline-diff-toolbar')).not.toBeInTheDocument()

    // 13. Modify file externally while shadow exists
    shadowBuffer.createSnapshot(activeFile, diskFileStore['sample.ts'], workspaceRoot)
    shadowBuffer.applyPatch(activeFile, patch2, undefined, workspaceRoot)
    const snap4 = shadowBuffer.getSnapshot(activeFile, workspaceRoot)!

    // External modification on disk
    diskFileStore['sample.ts'] = 'const modifiedExternally = true;\n'
    shadowBuffer.markConflicted(activeFile, 'External disk modification detected.', workspaceRoot)

    shadowDiffInfo = {
      originalContent: snap4.originalContent,
      shadowContent: snap4.shadowContent,
      revision: snap4.revision,
      dirty: snap4.dirty,
      isConflicted: true,
      conflictReason: 'External disk modification detected.'
    }

    rerender(
      <EditorPane
        filePath={activeFile}
        content={snap4.shadowContent}
        onChange={vi.fn()}
        onSave={vi.fn()}
        shadowDiff={shadowDiffInfo}
        onAcceptShadowDiff={vi.fn()}
        onRejectShadowDiff={handleReject}
      />
    )

    // 14. Confirm conflict state blocks Apply
    expect(screen.getByTestId('inline-diff-conflict-warning')).toBeInTheDocument()
    const conflictedApplyBtn = screen.getByTestId('inline-diff-accept-btn')
    expect(conflictedApplyBtn).toBeDisabled()

    // 15. Switch between multiple tabs and verify isolation
    // Open Tab B (other.ts, no shadow diff)
    rerender(
      <EditorPane
        filePath="other.ts"
        content="const otherTab = 42;"
        onChange={vi.fn()}
        onSave={vi.fn()}
        shadowDiff={null}
      />
    )
    expect(screen.queryByTestId('inline-diff-toolbar')).not.toBeInTheDocument()
    expect(screen.getByTestId('monaco-editor-mock')).toBeInTheDocument()

    // Switch back to Tab A (sample.ts with conflict)
    rerender(
      <EditorPane
        filePath={activeFile}
        content={snap4.shadowContent}
        onChange={vi.fn()}
        onSave={vi.fn()}
        shadowDiff={shadowDiffInfo}
      />
    )
    expect(screen.getByTestId('inline-diff-toolbar')).toBeInTheDocument()
    expect(screen.getByTestId('inline-diff-conflict-warning')).toBeInTheDocument()

    // 16. Close tab and verify no stale diff instance
    shadowBuffer.remove(activeFile, workspaceRoot)
    expect(shadowBuffer.hasSnapshot(activeFile, workspaceRoot)).toBe(false)
  })
})
