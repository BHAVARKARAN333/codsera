import React, { useEffect, useRef, useState, useCallback } from 'react'
import Editor, { DiffEditor, Monaco, OnMount } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import {
  Loader2,
  Sparkles,
  Check,
  X,
  AlertTriangle,
  Columns,
  AlignJustify
} from 'lucide-react'
import '../monacoConfig'

export interface ShadowDiffInfo {
  originalContent: string
  shadowContent: string
  revision: number
  dirty: boolean
  isConflicted: boolean
  conflictReason?: string
}

export interface MultiFileDiffInfo {
  readonly dirtyFileCount: number
  readonly dirtyFiles: string[]
  readonly onApplyAll?: () => void
  readonly onDiscardAll?: () => void
}

export interface EditorPaneProps {
  filePath: string | null
  content: string
  onChange: (newContent: string) => void
  onSave: (currentContent?: string) => void
  onCursorChange?: (info: {
    cursorLine: number
    cursorColumn: number
    visibleRange?: { startLine: number; endLine: number } | null
  }) => void
  shadowDiff?: ShadowDiffInfo | null
  multiFileDiffInfo?: MultiFileDiffInfo | null
  onAcceptShadowDiff?: () => void
  onRejectShadowDiff?: () => void
}


function detectLanguage(filePath: string | null): string {
  if (!filePath) return 'plaintext'

  const ext = filePath.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'ts':
    case 'tsx':
      return 'typescript'
    case 'js':
    case 'mjs':
    case 'cjs':
    case 'jsx':
      return 'javascript'
    case 'json':
      return 'json'
    case 'html':
    case 'htm':
      return 'html'
    case 'css':
    case 'scss':
    case 'less':
      return 'css'
    case 'md':
    case 'markdown':
      return 'markdown'
    case 'py':
      return 'python'
    case 'rs':
      return 'rust'
    case 'go':
      return 'go'
    case 'java':
      return 'java'
    case 'c':
    case 'h':
      return 'c'
    case 'cpp':
    case 'hpp':
    case 'cc':
      return 'cpp'
    case 'yaml':
    case 'yml':
      return 'yaml'
    case 'xml':
    case 'svg':
      return 'xml'
    case 'sql':
      return 'sql'
    case 'sh':
    case 'bash':
      return 'shell'
    default:
      return 'plaintext'
  }
}

function ensureAiIdeTheme(monacoInstance: Monaco): void {
  monacoInstance.editor.defineTheme('ai-ide-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#131417',
      'editor.foreground': '#d4d4d8',
      'editor.lineHighlightBackground': '#1b1c21',
      'editorLineNumber.foreground': '#4b5563',
      'editorLineNumber.activeForeground': '#9ca3af',
      'editorCursor.foreground': '#38bdf8',
      'editor.selectionBackground': '#264f78',
      'editor.inactiveSelectionBackground': '#1e385b',
      'editorGutter.background': '#131417',
      'minimap.background': '#131417',
      'diffEditor.insertedTextBackground': '#10b98126',
      'diffEditor.removedTextBackground': '#ef444426',
      'diffEditor.insertedLineBackground': '#10b98114',
      'diffEditor.removedLineBackground': '#ef444414',
      'diffEditorGutter.insertedLineBackground': '#10b98133',
      'diffEditorGutter.removedLineBackground': '#ef444433'
    }
  })
  monacoInstance.editor.setTheme('ai-ide-dark')
}

export const EditorPane: React.FC<EditorPaneProps> = ({
  filePath,
  content,
  onChange,
  onSave,
  onCursorChange,
  shadowDiff,
  multiFileDiffInfo,
  onAcceptShadowDiff,
  onRejectShadowDiff
}) => {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const diffEditorRef = useRef<editor.IDiffEditor | null>(null)
  const [sideBySide, setSideBySide] = useState<boolean>(true)

  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave
  const contentRef = useRef(content)
  contentRef.current = content

  const isDiffActive = Boolean(shadowDiff && shadowDiff.dirty)
  const language = detectLanguage(filePath)

  const triggerSave = useCallback(() => {
    const latestContent = editorRef.current ? editorRef.current.getValue() : contentRef.current
    onSaveRef.current(latestContent)
  }, [])

  // Auto-switch to inline diff view on narrow windows
  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth < 760) {
        setSideBySide(false)
      }
    }
    handleResize()
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  // Standard editor mount handler
  const handleEditorDidMount: OnMount = (editorInstance, monacoInstance: Monaco) => {
    editorRef.current = editorInstance
    ensureAiIdeTheme(monacoInstance)

    // Add Ctrl+S / Cmd+S save command inside Monaco
    editorInstance.addCommand(
      monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.KeyS,
      () => {
        triggerSave()
      }
    )

    // Notify cursor and viewport position on cursor movement
    const notifyCursorChange = () => {
      if (typeof editorInstance.getPosition !== 'function') return
      const pos = editorInstance.getPosition()
      const visibleRanges =
        typeof editorInstance.getVisibleRanges === 'function'
          ? editorInstance.getVisibleRanges()
          : null
      const firstRange = visibleRanges && visibleRanges.length > 0 ? visibleRanges[0] : null
      if (pos) {
        onCursorChange?.({
          cursorLine: pos.lineNumber,
          cursorColumn: pos.column,
          visibleRange: firstRange
            ? {
                startLine: firstRange.startLineNumber,
                endLine: firstRange.endLineNumber
              }
            : null
        })
      }
    }

    if (typeof editorInstance.onDidChangeCursorPosition === 'function') {
      editorInstance.onDidChangeCursorPosition(() => {
        notifyCursorChange()
      })
    }
  }

  // Diff editor mount handler
  const handleDiffMount = (diffInstance: editor.IDiffEditor, monacoInstance: Monaco) => {
    diffEditorRef.current = diffInstance
    ensureAiIdeTheme(monacoInstance)
  }

  // Live update: Synchronize diff models when shadow revision or content changes
  useEffect(() => {
    if (diffEditorRef.current && isDiffActive && shadowDiff) {
      const model = diffEditorRef.current.getModel()
      if (model) {
        if (model.original && model.original.getValue() !== shadowDiff.originalContent) {
          model.original.setValue(shadowDiff.originalContent)
        }
        if (model.modified && model.modified.getValue() !== shadowDiff.shadowContent) {
          model.modified.setValue(shadowDiff.shadowContent)
        }
      }
    }
  }, [isDiffActive, shadowDiff?.originalContent, shadowDiff?.shadowContent, shadowDiff?.revision])

  // Global Ctrl+S key listener as fallback for standard editor mode
  useEffect(() => {
    if (isDiffActive) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault()
        e.stopPropagation()
        triggerSave()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isDiffActive, triggerSave])

  // Diff mode keyboard shortcuts: Esc to reject, Ctrl/Cmd+Enter to accept
  useEffect(() => {
    if (!isDiffActive) return

    const handleDiffKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onRejectShadowDiff?.()
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        if (!shadowDiff?.isConflicted) {
          e.preventDefault()
          e.stopPropagation()
          onAcceptShadowDiff?.()
        }
      }
    }
    window.addEventListener('keydown', handleDiffKeyDown)
    return () => window.removeEventListener('keydown', handleDiffKeyDown)
  }, [isDiffActive, onRejectShadowDiff, onAcceptShadowDiff, shadowDiff?.isConflicted])

  // Clean up diff editor reference on unmount or mode change
  useEffect(() => {
    return () => {
      diffEditorRef.current = null
    }
  }, [isDiffActive])

  // RENDER INLINE DIFF MODE
  if (isDiffActive && shadowDiff) {
    return (
      <div className="inline-diff-container" data-testid="inline-diff-container">
        {/* Diff Action Toolbar */}
        <div className="inline-diff-toolbar" data-testid="inline-diff-toolbar">
          <div className="inline-diff-info">
            <Sparkles size={14} color="#38bdf8" className="inline-diff-sparkle-icon" />
            <span className="inline-diff-title">AI Proposed Changes</span>
            <span className="inline-diff-rev-badge">Rev {shadowDiff.revision}</span>

            {shadowDiff.isConflicted && (
              <div
                className="inline-diff-conflict-badge"
                title={shadowDiff.conflictReason || 'File changed externally on disk.'}
                data-testid="inline-diff-conflict-warning"
              >
                <AlertTriangle size={13} color="#f59e0b" />
                <span>File changed externally — review required</span>
              </div>
            )}
          </div>

          <div className="inline-diff-actions">
            <button
              type="button"
              className="btn btn-secondary btn-xs diff-mode-toggle"
              onClick={() => setSideBySide((prev) => !prev)}
              title={sideBySide ? 'Switch to inline diff view' : 'Switch to side-by-side diff view'}
              aria-label={sideBySide ? 'Inline view' : 'Split view'}
            >
              {sideBySide ? <Columns size={12} /> : <AlignJustify size={12} />}
              <span>{sideBySide ? 'Split' : 'Inline'}</span>
            </button>

            {multiFileDiffInfo && multiFileDiffInfo.dirtyFileCount > 1 && (
              <>
                <button
                  type="button"
                  className="btn btn-secondary btn-xs inline-diff-discard-all-btn"
                  onClick={multiFileDiffInfo.onDiscardAll}
                  title={`Discard all staged changes (${multiFileDiffInfo.dirtyFileCount} files)`}
                  aria-label="Discard all changes"
                  data-testid="inline-diff-discard-all-btn"
                >
                  <X size={12} />
                  <span>Discard All</span>
                </button>

                <button
                  type="button"
                  className="btn btn-primary btn-xs inline-diff-apply-all-btn"
                  onClick={multiFileDiffInfo.onApplyAll}
                  disabled={shadowDiff.isConflicted}
                  title={
                    shadowDiff.isConflicted
                      ? 'Cannot apply: file was modified externally.'
                      : `Apply changes across all ${multiFileDiffInfo.dirtyFileCount} files`
                  }
                  aria-label="Apply all changes"
                  data-testid="inline-diff-apply-all-btn"
                >
                  <Check size={12} />
                  <span>Apply All ({multiFileDiffInfo.dirtyFileCount})</span>
                </button>
              </>
            )}

            <button
              type="button"
              className="btn btn-secondary btn-xs inline-diff-reject-btn"
              onClick={onRejectShadowDiff}
              title="Reject & Discard AI changes (Esc)"
              aria-label="Discard changes"
              data-testid="inline-diff-reject-btn"
            >
              <X size={12} />
              <span>Discard</span>
            </button>

            <button
              type="button"
              className="btn btn-primary btn-xs inline-diff-accept-btn"
              onClick={onAcceptShadowDiff}
              disabled={shadowDiff.isConflicted}
              title={
                shadowDiff.isConflicted
                  ? 'Cannot apply: file was modified externally.'
                  : 'Accept & Apply AI changes to file (Ctrl+Enter)'
              }
              aria-label="Apply changes"
              data-testid="inline-diff-accept-btn"
            >
              <Check size={12} />
              <span>Apply</span>
            </button>
          </div>
        </div>

        {/* Monaco Diff Editor */}
        <div className="inline-diff-body" data-testid="inline-diff-body">
          <DiffEditor
            height="100%"
            language={language}
            original={shadowDiff.originalContent}
            modified={shadowDiff.shadowContent}
            theme="ai-ide-dark"
            onMount={handleDiffMount}
            options={{
              readOnly: true,
              renderSideBySide: sideBySide,
              automaticLayout: true,
              minimap: { enabled: true, side: 'right' },
              scrollBeyondLastLine: false,
              fontSize: 13,
              fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', 'Courier New', monospace",
              lineNumbersMinChars: 3,
              smoothScrolling: true,
              padding: { top: 8, bottom: 8 }
            }}
          />
        </div>
      </div>
    )
  }

  // RENDER STANDARD MONACO EDITOR MODE
  return (
    <div className="editor-canvas">
      <Editor
        height="100%"
        language={language}
        value={content}
        theme="vs-dark"
        loading={
          <div className="editor-loading-state" data-testid="monaco-initializing-state">
            <Loader2 size={24} className="spinning" color="#38bdf8" />
            <p className="editor-loading-text">Initializing editor...</p>
          </div>
        }
        onMount={handleEditorDidMount}
        onChange={(val) => onChange(val ?? '')}
        options={{
          fontSize: 13,
          fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', 'Courier New', monospace",
          fontLigatures: true,
          minimap: { enabled: true, side: 'right' },
          scrollBeyondLastLine: false,
          smoothScrolling: true,
          cursorBlinking: 'smooth',
          cursorSmoothCaretAnimation: 'on',
          renderWhitespace: 'selection',
          automaticLayout: true,
          tabSize: 2,
          padding: { top: 8, bottom: 8 },
          lineNumbersMinChars: 3
        }}
      />
    </div>
  )
}
