import React, { useEffect, useRef, useCallback } from 'react'
import Editor, { Monaco, OnMount } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'

interface EditorPaneProps {
  filePath: string | null
  content: string
  onChange: (newContent: string) => void
  onSave: (currentContent?: string) => void
}

function detectLanguage(filePath: string | null): string {
  if (!filePath) return 'plaintext'

  const ext = filePath.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'ts':
      return 'typescript'
    case 'tsx':
      return 'typescript'
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'javascript'
    case 'jsx':
      return 'javascript'
    case 'json':
      return 'json'
    case 'html':
    case 'htm':
      return 'html'
    case 'css':
      return 'css'
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

export const EditorPane: React.FC<EditorPaneProps> = ({
  filePath,
  content,
  onChange,
  onSave
}) => {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave
  const contentRef = useRef(content)
  contentRef.current = content

  const language = detectLanguage(filePath)

  const triggerSave = useCallback(() => {
    const latestContent = editorRef.current ? editorRef.current.getValue() : contentRef.current
    onSaveRef.current(latestContent)
  }, [])

  const handleEditorDidMount: OnMount = (editorInstance, monacoInstance: Monaco) => {
    editorRef.current = editorInstance

    // Define custom dark theme matching IDE color system
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
        'minimap.background': '#131417'
      }
    })
    monacoInstance.editor.setTheme('ai-ide-dark')

    // Add Ctrl+S / Cmd+S save command inside Monaco
    editorInstance.addCommand(
      monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.KeyS,
      () => {
        triggerSave()
      }
    )
  }

  // Global Ctrl+S key listener as fallback
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault()
        e.stopPropagation()
        triggerSave()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [triggerSave])

  return (
    <div className="editor-canvas">
      <Editor
        height="100%"
        language={language}
        value={content}
        theme="vs-dark"
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
