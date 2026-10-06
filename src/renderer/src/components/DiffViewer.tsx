import React, { useState, useEffect } from 'react'
import { DiffEditor, Monaco } from '@monaco-editor/react'
import '../monacoConfig'
import {
  GitCompare,
  RefreshCw,
  X,
  AlertCircle,
  CheckCircle2,
  FileCode,
  Columns,
  AlignJustify,
  Loader2,
  Code2
} from 'lucide-react'
import { detectLanguage } from '../../../shared/diffUtils'

export interface DiffViewerProps {
  filePath: string
  staged: boolean
  originalContent: string
  modifiedContent: string
  rawDiff: string
  isBinary?: boolean
  isLoading?: boolean
  error?: string | null
  truncated?: boolean
  hasStagedChanges?: boolean
  hasUnstagedChanges?: boolean
  onToggleMode: (staged: boolean) => void
  onRefresh: () => void
  onClose: () => void
}

export const DiffViewer: React.FC<DiffViewerProps> = ({
  filePath,
  staged,
  originalContent,
  modifiedContent,
  rawDiff,
  isBinary = false,
  isLoading = false,
  error = null,
  truncated = false,
  hasStagedChanges = false,
  hasUnstagedChanges = false,
  onToggleMode,
  onRefresh,
  onClose
}) => {
  const [sideBySide, setSideBySide] = useState<boolean>(true)
  const [showRawPatch, setShowRawPatch] = useState<boolean>(false)

  const language = detectLanguage(filePath)
  const fileName = filePath.split(/[\\/]/).pop() || filePath
  const fileDir = filePath.includes('/') || filePath.includes('\\')
    ? filePath.substring(0, Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')))
    : ''

  // Responsive fallback: auto-switch to inline view on narrow windows
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

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const handleDiffMount = (_editorInstance: unknown, monacoInstance: Monaco) => {
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

  const hasContent = rawDiff && rawDiff.trim().length > 0

  return (
    <div className="diff-viewer-container" data-testid="diff-viewer">
      {/* Diff Header Bar */}
      <div className="diff-viewer-header">
        <div className="diff-viewer-title-wrap">
          <GitCompare size={15} color="#38bdf8" className="diff-viewer-icon" />
          <span className="diff-viewer-filename" title={filePath}>
            {fileName}
          </span>
          {fileDir && <span className="diff-viewer-dir">({fileDir})</span>}
          <span className={`diff-viewer-badge ${staged ? 'staged' : 'unstaged'}`}>
            {staged ? 'INDEX' : 'WORKING TREE'}
          </span>
        </div>

        {/* Diff Mode Selector: Staged vs Unstaged */}
        <div className="diff-viewer-controls">
          <div className="diff-mode-switcher" role="group" aria-label="Diff Version Selector">
            <button
              type="button"
              className={`diff-mode-btn ${!staged ? 'active' : ''}`}
              onClick={() => onToggleMode(false)}
              title="View unstaged changes against working tree"
            >
              Working Tree
              {hasUnstagedChanges && <span className="diff-mode-dot unstaged" />}
            </button>
            <button
              type="button"
              className={`diff-mode-btn ${staged ? 'active' : ''}`}
              onClick={() => onToggleMode(true)}
              title="View staged changes against Git index"
            >
              Staged (Index)
              {hasStagedChanges && <span className="diff-mode-dot staged" />}
            </button>
          </div>

          {/* View Toggles */}
          <div className="diff-view-toggles">
            <button
              type="button"
              className={`diff-tool-btn ${sideBySide ? 'active' : ''}`}
              onClick={() => setSideBySide(!sideBySide)}
              title={sideBySide ? 'Switch to inline diff view' : 'Switch to side-by-side diff view'}
              aria-label={sideBySide ? 'Inline view' : 'Side-by-side view'}
            >
              {sideBySide ? <Columns size={13} /> : <AlignJustify size={13} />}
              <span className="btn-label">{sideBySide ? 'Split' : 'Inline'}</span>
            </button>

            <button
              type="button"
              className={`diff-tool-btn ${showRawPatch ? 'active' : ''}`}
              onClick={() => setShowRawPatch(!showRawPatch)}
              title={showRawPatch ? 'Switch to Monaco graphical diff' : 'View raw unified patch'}
              aria-label="Toggle raw patch"
            >
              <Code2 size={13} />
              <span className="btn-label">Patch</span>
            </button>

            <button
              type="button"
              className={`diff-tool-btn ${isLoading ? 'spin' : ''}`}
              onClick={onRefresh}
              title="Refresh Diff"
              aria-label="Refresh Diff"
              disabled={isLoading}
            >
              <RefreshCw size={13} />
            </button>

            <button
              type="button"
              className="diff-tool-btn close-btn"
              onClick={onClose}
              title="Close Diff (Esc)"
              aria-label="Close Diff"
            >
              <X size={14} />
            </button>
          </div>
        </div>
      </div>

      {/* Truncated Warning Banner */}
      {truncated && (
        <div className="diff-truncated-banner">
          <AlertCircle size={13} color="#f59e0b" />
          <span>This diff exceeds 50,000 characters and was truncated for performance.</span>
        </div>
      )}

      {/* Main Diff Content Area */}
      <div className="diff-viewer-body">
        {isLoading ? (
          <div className="diff-viewer-state loading" data-testid="diff-loading">
            <div className="diff-state-icon spin">
              <Loader2 size={28} color="#38bdf8" />
            </div>
            <div className="diff-state-title">Loading Git Diff</div>
            <div className="diff-state-desc">Comparing {staged ? 'index' : 'working tree'} changes...</div>
          </div>
        ) : error ? (
          <div className="diff-viewer-state error" data-testid="diff-error">
            <div className="diff-state-icon">
              <AlertCircle size={28} color="#ef4444" />
            </div>
            <div className="diff-state-title">Failed to Load Diff</div>
            <div className="diff-state-desc">{error}</div>
            <button type="button" className="btn btn-secondary btn-sm" onClick={onRefresh}>
              <RefreshCw size={12} />
              <span>Retry</span>
            </button>
          </div>
        ) : isBinary ? (
          <div className="diff-viewer-state" data-testid="diff-binary">
            <div className="diff-state-icon">
              <FileCode size={32} color="#94a3b8" />
            </div>
            <div className="diff-state-title">Binary File Diff Not Supported</div>
            <div className="diff-state-desc">
              Git detected that <strong>{fileName}</strong> is a binary file or contains non-text encoding.
              Visual diff cannot be displayed for binary assets.
            </div>
          </div>
        ) : !hasContent ? (
          <div className="diff-viewer-state clean" data-testid="diff-empty">
            <div className="diff-state-icon">
              <CheckCircle2 size={28} color="#10b981" />
            </div>
            <div className="diff-state-title">No {staged ? 'Staged' : 'Unstaged'} Changes</div>
            <div className="diff-state-desc">
              There are no {staged ? 'staged' : 'unstaged'} modifications in <strong>{fileName}</strong>.
            </div>
            {(staged ? hasUnstagedChanges : hasStagedChanges) && (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => onToggleMode(!staged)}
                style={{ marginTop: '8px' }}
              >
                <span>View {staged ? 'Unstaged (Working Tree)' : 'Staged (Index)'} Changes</span>
              </button>
            )}
          </div>
        ) : showRawPatch ? (
          <div className="diff-viewer-raw" data-testid="diff-raw">
            <pre className="diff-raw-code">
              {rawDiff.split(/\r?\n/).map((line, idx) => {
                let lineClass = 'diff-line'
                if (line.startsWith('+') && !line.startsWith('+++')) lineClass += ' added'
                else if (line.startsWith('-') && !line.startsWith('---')) lineClass += ' removed'
                else if (line.startsWith('@@')) lineClass += ' hunk-header'
                return (
                  <div key={idx} className={lineClass}>
                    <span className="diff-line-num">{idx + 1}</span>
                    <span className="diff-line-text">{line}</span>
                  </div>
                )
              })}
            </pre>
          </div>
        ) : (
          <div className="diff-viewer-monaco" data-testid="diff-monaco">
            <DiffEditor
              height="100%"
              language={language}
              original={originalContent}
              modified={modifiedContent}
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
        )}
      </div>
    </div>
  )
}
