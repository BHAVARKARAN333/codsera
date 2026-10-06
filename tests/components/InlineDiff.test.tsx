import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { EditorPane, ShadowDiffInfo } from '@renderer/components/EditorPane'
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

describe('Phase 14.1 — Inline Diff UI for Shadow Buffer', () => {
  beforeEach(() => {
    setupMockElectron({
      getLastWorkspace: vi.fn().mockResolvedValue({ success: false }),
      readWorkspaceFile: vi.fn().mockResolvedValue({ success: true, content: 'const a = 1;\n' }),
      editWorkspaceFile: vi.fn().mockResolvedValue({ success: true, path: 'src/sample.ts' }),
      openDirectory: vi.fn().mockResolvedValue({
        success: true,
        rootPath: 'C:/mock/workspace',
        tree: [
          { name: 'sample.ts', path: 'C:/mock/workspace/sample.ts', isDirectory: false },
          { name: 'other.ts', path: 'C:/mock/workspace/other.ts', isDirectory: false }
        ]
      }),
      watchWorkspace: vi.fn().mockResolvedValue({ success: true }),
      unwatchWorkspace: vi.fn().mockResolvedValue({ success: true }),
      onWorkspaceFileChanged: vi.fn().mockReturnValue(() => {})
    })
  })

  afterEach(() => {
    resetMockElectron()
  })

  // Test 1: Normal file uses standard editor mode
  it('1. normal file without shadow diff uses standard editor mode', () => {
    render(
      <EditorPane
        filePath="src/sample.ts"
        content="const a = 1;"
        onChange={vi.fn()}
        onSave={vi.fn()}
        shadowDiff={null}
      />
    )

    expect(screen.getByTestId('monaco-editor-mock')).toBeInTheDocument()
    expect(screen.queryByTestId('inline-diff-toolbar')).not.toBeInTheDocument()
    expect(screen.queryByTestId('monaco-diff-editor-mock')).not.toBeInTheDocument()
  })

  // Test 2: Shadow file enters diff mode
  it('2. file with active dirty shadow buffer enters inline diff mode', () => {
    const shadowDiff: ShadowDiffInfo = {
      originalContent: 'const a = 1;\n',
      shadowContent: 'const a = 2;\n',
      revision: 1,
      dirty: true,
      isConflicted: false
    }

    render(
      <EditorPane
        filePath="src/sample.ts"
        content="const a = 2;\n"
        onChange={vi.fn()}
        onSave={vi.fn()}
        shadowDiff={shadowDiff}
        onAcceptShadowDiff={vi.fn()}
        onRejectShadowDiff={vi.fn()}
      />
    )

    expect(screen.getByTestId('inline-diff-toolbar')).toBeInTheDocument()
    expect(screen.getByText(/AI Proposed Changes/i)).toBeInTheDocument()
    expect(screen.getByText(/Rev 1/i)).toBeInTheDocument()
    expect(screen.getByTestId('monaco-diff-editor-mock')).toBeInTheDocument()
    expect(screen.getByTestId('diff-original')).toHaveTextContent('const a = 1;')
    expect(screen.getByTestId('diff-modified')).toHaveTextContent('const a = 2;')
    expect(screen.queryByTestId('monaco-editor-mock')).not.toBeInTheDocument()
  })

  // Test 3: ShadowBuffer revision updates diff content
  it('3. ShadowBuffer revision and content updates diff view reactively', () => {
    const shadowDiffRev1: ShadowDiffInfo = {
      originalContent: 'const a = 1;\n',
      shadowContent: 'const a = 2;\n',
      revision: 1,
      dirty: true,
      isConflicted: false
    }

    const { rerender } = render(
      <EditorPane
        filePath="src/sample.ts"
        content="const a = 2;\n"
        onChange={vi.fn()}
        onSave={vi.fn()}
        shadowDiff={shadowDiffRev1}
        onAcceptShadowDiff={vi.fn()}
        onRejectShadowDiff={vi.fn()}
      />
    )

    expect(screen.getByText(/Rev 1/i)).toBeInTheDocument()
    expect(screen.getByTestId('diff-modified')).toHaveTextContent('const a = 2;')

    // Live update to Revision 2
    const shadowDiffRev2: ShadowDiffInfo = {
      originalContent: 'const a = 1;\n',
      shadowContent: 'const a = 3;\n',
      revision: 2,
      dirty: true,
      isConflicted: false
    }

    rerender(
      <EditorPane
        filePath="src/sample.ts"
        content="const a = 3;\n"
        onChange={vi.fn()}
        onSave={vi.fn()}
        shadowDiff={shadowDiffRev2}
        onAcceptShadowDiff={vi.fn()}
        onRejectShadowDiff={vi.fn()}
      />
    )

    expect(screen.getByText(/Rev 2/i)).toBeInTheDocument()
    expect(screen.getByTestId('diff-modified')).toHaveTextContent('const a = 3;')
  })

  // Test 4: Accept calls accept handler
  it('4. clicking Apply triggers accept handler', () => {
    const onAccept = vi.fn()
    const onReject = vi.fn()
    const shadowDiff: ShadowDiffInfo = {
      originalContent: 'const a = 1;\n',
      shadowContent: 'const a = 2;\n',
      revision: 1,
      dirty: true,
      isConflicted: false
    }

    render(
      <EditorPane
        filePath="src/sample.ts"
        content="const a = 2;\n"
        onChange={vi.fn()}
        onSave={vi.fn()}
        shadowDiff={shadowDiff}
        onAcceptShadowDiff={onAccept}
        onRejectShadowDiff={onReject}
      />
    )

    const applyBtn = screen.getByTestId('inline-diff-accept-btn')
    fireEvent.click(applyBtn)

    expect(onAccept).toHaveBeenCalledTimes(1)
    expect(onReject).not.toHaveBeenCalled()
  })

  // Test 5: Reject calls reject handler and does not write to disk
  it('5. clicking Discard triggers reject handler', () => {
    const onAccept = vi.fn()
    const onReject = vi.fn()
    const shadowDiff: ShadowDiffInfo = {
      originalContent: 'const a = 1;\n',
      shadowContent: 'const a = 2;\n',
      revision: 1,
      dirty: true,
      isConflicted: false
    }

    render(
      <EditorPane
        filePath="src/sample.ts"
        content="const a = 2;\n"
        onChange={vi.fn()}
        onSave={vi.fn()}
        shadowDiff={shadowDiff}
        onAcceptShadowDiff={onAccept}
        onRejectShadowDiff={onReject}
      />
    )

    const discardBtn = screen.getByTestId('inline-diff-reject-btn')
    fireEvent.click(discardBtn)

    expect(onReject).toHaveBeenCalledTimes(1)
    expect(onAccept).not.toHaveBeenCalled()
  })

  // Test 6: Conflict disables Apply button and displays warning
  it('6. external file conflict disables Apply button and shows warning', () => {
    const onAccept = vi.fn()
    const shadowDiff: ShadowDiffInfo = {
      originalContent: 'const a = 1;\n',
      shadowContent: 'const a = 2;\n',
      revision: 1,
      dirty: true,
      isConflicted: true,
      conflictReason: 'External modification detected on disk.'
    }

    render(
      <EditorPane
        filePath="src/sample.ts"
        content="const a = 2;\n"
        onChange={vi.fn()}
        onSave={vi.fn()}
        shadowDiff={shadowDiff}
        onAcceptShadowDiff={onAccept}
        onRejectShadowDiff={vi.fn()}
      />
    )

    expect(screen.getByTestId('inline-diff-conflict-warning')).toBeInTheDocument()
    expect(screen.getByText(/File changed externally — review required/i)).toBeInTheDocument()

    const applyBtn = screen.getByTestId('inline-diff-accept-btn')
    expect(applyBtn).toBeDisabled()

    // Clicking disabled button does not trigger onAccept
    fireEvent.click(applyBtn)
    expect(onAccept).not.toHaveBeenCalled()
  })

  // Test 7: Tab switching preserves per-file diff state
  it('7. tab switching preserves per-file diff state and displays diff only when active file has shadow diff', () => {
    const shadowDiffA: ShadowDiffInfo = {
      originalContent: 'const a = 1;\n',
      shadowContent: 'const a = 99;\n',
      revision: 1,
      dirty: true,
      isConflicted: false
    }

    // Active Tab 1: sample.ts with shadowDiff -> diff mode
    const { rerender } = render(
      <EditorPane
        filePath="src/sample.ts"
        content="const a = 99;\n"
        onChange={vi.fn()}
        onSave={vi.fn()}
        shadowDiff={shadowDiffA}
        onAcceptShadowDiff={vi.fn()}
        onRejectShadowDiff={vi.fn()}
      />
    )

    expect(screen.getByTestId('inline-diff-toolbar')).toBeInTheDocument()
    expect(screen.getByTestId('monaco-diff-editor-mock')).toBeInTheDocument()
    expect(screen.getByTestId('diff-modified')).toHaveTextContent('const a = 99;')

    // Switch to Tab 2: other.ts without shadow diff -> standard editor mode
    rerender(
      <EditorPane
        filePath="src/other.ts"
        content="const other = true;"
        onChange={vi.fn()}
        onSave={vi.fn()}
        shadowDiff={null}
        onAcceptShadowDiff={vi.fn()}
        onRejectShadowDiff={vi.fn()}
      />
    )

    expect(screen.queryByTestId('inline-diff-toolbar')).not.toBeInTheDocument()
    expect(screen.queryByTestId('monaco-diff-editor-mock')).not.toBeInTheDocument()
    expect(screen.getByTestId('monaco-editor-mock')).toBeInTheDocument()

    // Switch back to Tab 1: sample.ts with shadow diff -> returns to diff mode
    rerender(
      <EditorPane
        filePath="src/sample.ts"
        content="const a = 99;\n"
        onChange={vi.fn()}
        onSave={vi.fn()}
        shadowDiff={shadowDiffA}
        onAcceptShadowDiff={vi.fn()}
        onRejectShadowDiff={vi.fn()}
      />
    )

    expect(screen.getByTestId('inline-diff-toolbar')).toBeInTheDocument()
    expect(screen.getByTestId('monaco-diff-editor-mock')).toBeInTheDocument()
    expect(screen.getByTestId('diff-modified')).toHaveTextContent('const a = 99;')
  })

  // Test 8: Keyboard shortcuts Esc to reject and Ctrl+Enter to accept
  it('8. handles keyboard shortcuts Esc to reject and Ctrl+Enter to accept in diff mode', () => {
    const onAccept = vi.fn()
    const onReject = vi.fn()
    const shadowDiff: ShadowDiffInfo = {
      originalContent: 'const a = 1;\n',
      shadowContent: 'const a = 2;\n',
      revision: 1,
      dirty: true,
      isConflicted: false
    }

    render(
      <EditorPane
        filePath="src/sample.ts"
        content="const a = 2;\n"
        onChange={vi.fn()}
        onSave={vi.fn()}
        shadowDiff={shadowDiff}
        onAcceptShadowDiff={onAccept}
        onRejectShadowDiff={onReject}
      />
    )

    // Press Escape -> onReject called
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onReject).toHaveBeenCalledTimes(1)

    // Press Ctrl+Enter -> onAccept called
    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true })
    expect(onAccept).toHaveBeenCalledTimes(1)
  })
})
