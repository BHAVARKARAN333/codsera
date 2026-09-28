import React, { useState } from 'react'
import {
  FolderOpen,
  Save,
  Code2,
  X,
  CheckCircle2,
  AlertCircle,
  Sparkles,
  Layers,
  FileCode,
  FileText,
  FileJson,
  FileType,
  Bot,
  Terminal as TerminalIcon,
  GitBranch
} from 'lucide-react'
import { FileEntry } from '../../shared/types'
import { FileExplorer } from './components/FileExplorer'
import { EditorPane } from './components/EditorPane'
import { AIChatPanel } from './components/AIChatPanel'
import { Terminal, TerminalEntry } from './components/Terminal'

interface OpenTab {
  path: string
  name: string
  content: string
  originalContent: string
  isDirty: boolean
}

function getTabFileIcon(fileName: string) {
  const ext = fileName.split('.').pop()?.toLowerCase() || ''
  switch (ext) {
    case 'ts':
    case 'tsx':
      return <FileCode size={13} color="#60a5fa" />
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return <FileCode size={13} color="#facc15" />
    case 'json':
      return <FileJson size={13} color="#fb923c" />
    case 'css':
    case 'scss':
    case 'less':
      return <FileType size={13} color="#c084fc" />
    case 'html':
    case 'svg':
      return <FileCode size={13} color="#f97316" />
    case 'md':
    case 'markdown':
    case 'txt':
      return <FileText size={13} color="#38bdf8" />
    default:
      return <FileText size={13} color="#94a3b8" />
  }
}

export const App: React.FC = () => {
  const [rootPath, setRootPath] = useState<string | null>(null)
  const [tree, setTree] = useState<FileEntry[]>([])
  const [tabs, setTabs] = useState<OpenTab[]>([])
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState<string>('Ready')
  const [isSaving, setIsSaving] = useState<boolean>(false)
  const [isAIPanelOpen, setIsAIPanelOpen] = useState<boolean>(true)
  const [isTerminalOpen, setIsTerminalOpen] = useState<boolean>(false)
  const [terminalEntries, setTerminalEntries] = useState<TerminalEntry[]>([])
  const [isTerminalRunning, setIsTerminalRunning] = useState<boolean>(false)
  const [gitBranch, setGitBranch] = useState<string | null>(null)

  const activeTab = tabs.find((t) => t.path === activeFilePath)
  const projectName = rootPath ? rootPath.split(/[\\/]/).pop() || 'Project' : null

  // Check Git branch whenever workspace changes
  React.useEffect(() => {
    if (rootPath) {
      window.electronAPI
        .gitStatus(rootPath)
        .then((res) => {
          if (res.success && res.isRepository && res.branch) {
            setGitBranch(res.branch)
          } else {
            setGitBranch(null)
          }
        })
        .catch(() => setGitBranch(null))
    } else {
      setGitBranch(null)
    }
  }, [rootPath])

  // Restore previously opened workspace on startup if it still exists
  React.useEffect(() => {
    window.electronAPI.getLastWorkspace().then((result) => {
      if (result.success && result.rootPath && result.tree) {
        setRootPath(result.rootPath)
        setTree(result.tree)
        setStatusMessage(`Workspace: ${result.rootPath}`)
      }
    }).catch(() => {
      // Gracefully fall back to clean empty state if folder was moved/deleted
    })
  }, [])

  // Start workspace filesystem watcher whenever workspace opens or switches
  React.useEffect(() => {
    if (rootPath) {
      window.electronAPI.watchWorkspace(rootPath).catch(() => {})
    } else {
      window.electronAPI.unwatchWorkspace().catch(() => {})
    }
    return () => {
      window.electronAPI.unwatchWorkspace().catch(() => {})
    }
  }, [rootPath])

  // Refresh directory tree
  const handleRefreshTree = async () => {
    if (!rootPath) return
    try {
      const result = await window.electronAPI.readTree(rootPath)
      if (result.success && result.tree) {
        setTree(result.tree)
      }
    } catch (err) {
      console.error('Failed to refresh explorer tree:', err)
    }
  }

  const handleFileCreated = async (createdPath: string) => {
    await handleRefreshTree()
    setStatusMessage(`Created file: ${createdPath}`)
  }

  const handleFileEdited = (editedPath: string, newContent: string) => {
    const cleanEdited = editedPath.replace(/^[/\\]+/, '').replace(/\\/g, '/')

    setTabs((prev) =>
      prev.map((t) => {
        const cleanTabPath = t.path.replace(/\\/g, '/')
        if (cleanTabPath.endsWith(cleanEdited) || cleanTabPath === cleanEdited) {
          return {
            ...t,
            content: newContent,
            originalContent: newContent,
            isDirty: false
          }
        }
        return t
      })
    )
    setStatusMessage(`Edited file: ${editedPath}`)
  }

  // Integrated Terminal Handlers
  const handleRunTerminalCommand = async (command: string) => {
    if (!rootPath || isTerminalRunning) return
    const entryId = crypto.randomUUID()
    const newEntry: TerminalEntry = {
      id: entryId,
      command,
      cwd: rootPath,
      stdout: '',
      stderr: '',
      exitCode: null,
      running: true,
      timestamp: Date.now(),
      source: 'user'
    }
    setTerminalEntries((prev) => [...prev, newEntry])
    setIsTerminalRunning(true)
    setStatusMessage(`Running: ${command}`)

    try {
      const result = await window.electronAPI.runCommand(command, rootPath)
      setTerminalEntries((prev) =>
        prev.map((e) =>
          e.id === entryId
            ? {
                ...e,
                running: false,
                stdout: result.stdout,
                stderr: result.stderr,
                exitCode: result.exitCode,
                timedOut: result.timedOut,
                error: result.error
              }
            : e
        )
      )
      setStatusMessage(
        result.success
          ? `Finished: ${command} (exit 0)`
          : `Command failed: ${command} (exit ${result.exitCode ?? 'err'})`
      )
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setTerminalEntries((prev) =>
        prev.map((e) =>
          e.id === entryId
            ? {
                ...e,
                running: false,
                error: msg,
                exitCode: -1
              }
            : e
        )
      )
      setStatusMessage(`Command error: ${msg}`)
    } finally {
      setIsTerminalRunning(false)
    }
  }

  const handleStopTerminalCommand = async () => {
    try {
      await window.electronAPI.stopCommand()
      setStatusMessage('Command stopped by user.')
    } catch (err) {
      console.error('Failed to stop command:', err)
    }
  }

  const handleClearTerminal = () => {
    setTerminalEntries([])
  }

  const handleAICommandExecuted = (
    command: string,
    result: { stdout: string; stderr: string; exitCode: number | null }
  ) => {
    const newEntry: TerminalEntry = {
      id: crypto.randomUUID(),
      command,
      cwd: rootPath || '',
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      running: false,
      timestamp: Date.now(),
      source: 'ai'
    }
    setTerminalEntries((prev) => [...prev, newEntry])
    setIsTerminalOpen(true)
    setStatusMessage(`AI executed: ${command}`)
  }

  // Open directory via native dialog
  const handleOpenFolderDialog = async () => {
    try {
      const result = await window.electronAPI.openDirectory()
      if (result.success && result.rootPath && result.tree) {
        setRootPath(result.rootPath)
        setTree(result.tree)
        setStatusMessage(`Opened workspace: ${result.rootPath}`)
      } else if (result.error) {
        setStatusMessage(`Error opening folder: ${result.error}`)
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setStatusMessage(`Failed to open folder: ${msg}`)
    }
  }

  // Open and read file
  const handleOpenFile = async (filePath: string, fileName: string) => {
    // Check if tab already open
    const existing = tabs.find((t) => t.path === filePath)
    if (existing) {
      setActiveFilePath(filePath)
      return
    }

    try {
      const result = await window.electronAPI.readFile(filePath)
      if (result.success && result.content !== undefined) {
        const newTab: OpenTab = {
          path: filePath,
          name: fileName,
          content: result.content,
          originalContent: result.content,
          isDirty: false
        }
        setTabs((prev) => [...prev, newTab])
        setActiveFilePath(filePath)
        setStatusMessage(`Loaded ${fileName}`)
      } else {
        setStatusMessage(`Failed to read file: ${result.error || 'Unknown error'}`)
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setStatusMessage(`Error reading file: ${msg}`)
    }
  }

  // Close tab
  const handleCloseTab = (e: React.MouseEvent, filePath: string) => {
    e.stopPropagation()
    const newTabs = tabs.filter((t) => t.path !== filePath)
    setTabs(newTabs)

    if (activeFilePath === filePath) {
      if (newTabs.length > 0) {
        setActiveFilePath(newTabs[newTabs.length - 1].path)
      } else {
        setActiveFilePath(null)
      }
    }
  }

  // Change content in editor
  const handleContentChange = (newContent: string) => {
    if (!activeFilePath) return

    setTabs((prev) =>
      prev.map((t) => {
        if (t.path === activeFilePath) {
          return {
            ...t,
            content: newContent,
            isDirty: newContent !== t.originalContent
          }
        }
        return t
      })
    )
  }

  // Save changes to disk
  const handleSaveFile = async (explicitContent?: string) => {
    const currentActiveTab = tabs.find((t) => t.path === activeFilePath)
    if (!currentActiveTab || isSaving) return

    const contentToSave =
      explicitContent !== undefined ? explicitContent : currentActiveTab.content

    setIsSaving(true)
    setStatusMessage(`Saving ${currentActiveTab.name}...`)

    try {
      const result = await window.electronAPI.writeFile(currentActiveTab.path, contentToSave)
      if (result.success) {
        setTabs((prev) =>
          prev.map((t) => {
            if (t.path === currentActiveTab.path) {
              return {
                ...t,
                content: contentToSave,
                originalContent: contentToSave,
                isDirty: false
              }
            }
            return t
          })
        )
        setStatusMessage(`Saved ${currentActiveTab.name}`)
      } else {
        setStatusMessage(`Failed to save: ${result.error || 'Unknown error'}`)
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setStatusMessage(`Save error: ${msg}`)
    } finally {
      setIsSaving(false)
    }
  }

  // Global Ctrl+S key listener across the application
  React.useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault()
        handleSaveFile()
      }
    }
    window.addEventListener('keydown', handleGlobalKeyDown)
    return () => window.removeEventListener('keydown', handleGlobalKeyDown)
  }, [tabs, activeFilePath, isSaving])

  return (
    <div className="app-container">
      {/* Top Header Bar */}
      <header className="header-bar">
        <div className="header-left">
          <div className="app-logo-badge">
            <Code2 size={15} className="app-logo-icon" />
          </div>
          <div className="app-title-group">
            <span className="app-title">AI IDE</span>
            <span className="app-version-pill">PRO</span>
          </div>
        </div>

        {/* Center Workspace Project Pill */}
        <div className="header-center">
          {projectName ? (
            <div className="workspace-pill" title={rootPath || ''}>
              <Layers size={12} className="workspace-pill-icon" />
              <span className="workspace-pill-text">{projectName}</span>
            </div>
          ) : (
            <div className="workspace-pill empty">
              <span>No Workspace Opened</span>
            </div>
          )}
        </div>

        {/* Right Action Buttons */}
        <div className="header-actions">
          <button className="btn btn-secondary btn-header" onClick={handleOpenFolderDialog} title="Open Workspace Folder">
            <FolderOpen size={13} />
            <span>Open Folder</span>
          </button>
          <button
            className={`btn ${activeTab?.isDirty ? 'btn-primary' : 'btn-secondary'} btn-header`}
            onClick={() => handleSaveFile()}
            disabled={!activeTab || !activeTab.isDirty || isSaving}
            title="Save Active File (Ctrl+S)"
          >
            <Save size={13} />
            <span>{isSaving ? 'Saving...' : activeTab?.isDirty ? 'Save (Ctrl+S)' : 'Saved'}</span>
          </button>
          <button
            className={`btn ${isTerminalOpen ? 'btn-active-toggle' : 'btn-secondary'} btn-header`}
            onClick={() => setIsTerminalOpen(!isTerminalOpen)}
            title="Toggle Integrated Terminal"
          >
            <TerminalIcon size={13} className={isTerminalOpen ? 'active-sparkle' : ''} />
            <span>Terminal</span>
          </button>
          <button
            className={`btn ${isAIPanelOpen ? 'btn-active-toggle' : 'btn-secondary'} btn-header`}
            onClick={() => setIsAIPanelOpen(!isAIPanelOpen)}
            title="Toggle AI Assistant Panel"
          >
            <Sparkles size={13} className={isAIPanelOpen ? 'active-sparkle' : ''} />
            <span>AI Assistant</span>
          </button>
        </div>
      </header>

      {/* Main Body */}
      <div className="workspace-body">
        {/* File Explorer Sidebar */}
        <FileExplorer
          rootPath={rootPath}
          tree={tree}
          activeFilePath={activeFilePath}
          onOpenFile={handleOpenFile}
          onOpenFolderDialog={handleOpenFolderDialog}
          onRefresh={handleRefreshTree}
        />

        {/* Editor Container */}
        <div className="editor-container">
          {/* Tabs Bar */}
          {tabs.length > 0 && (
            <div className="editor-tabs">
              {tabs.map((tab) => {
                const isActive = tab.path === activeFilePath
                return (
                  <div
                    key={tab.path}
                    className={`editor-tab ${isActive ? 'active' : ''}`}
                    onClick={() => setActiveFilePath(tab.path)}
                    title={tab.path}
                  >
                    <span className="tab-icon">{getTabFileIcon(tab.name)}</span>
                    <span className="tab-title">{tab.name}</span>
                    {tab.isDirty && <span className="tab-dirty-indicator" title="Unsaved changes" />}
                    <button
                      className="tab-close-btn"
                      onClick={(e) => handleCloseTab(e, tab.path)}
                      title="Close Tab"
                      type="button"
                    >
                      <X size={11} />
                    </button>
                  </div>
                )
              })}
            </div>
          )}

          {/* Monaco Editor Pane or Empty State */}
          {activeTab ? (
            <EditorPane
              key={activeTab.path}
              filePath={activeTab.path}
              content={activeTab.content}
              onChange={handleContentChange}
              onSave={handleSaveFile}
            />
          ) : (
            <div className="editor-empty">
              <div className="editor-empty-card">
                <div className="editor-empty-icon-wrap">
                  <Bot size={36} color="#38bdf8" />
                </div>
                <h3>AI IDE</h3>
                <p className="editor-empty-lead">Open a file from the explorer or open a workspace to start coding.</p>
                <div className="editor-empty-shortcuts">
                  <div className="shortcut-row">
                    <span className="shortcut-key">Ctrl + S</span>
                    <span className="shortcut-label">Save Active File</span>
                  </div>
                  <div className="shortcut-row">
                    <span className="shortcut-key">Enter</span>
                    <span className="shortcut-label">Submit AI Prompt</span>
                  </div>
                  <div className="shortcut-row">
                    <span className="shortcut-key">Shift + Enter</span>
                    <span className="shortcut-label">New Line in Chat</span>
                  </div>
                </div>
                {!rootPath && (
                  <button className="btn btn-primary btn-sm" onClick={handleOpenFolderDialog}>
                    <FolderOpen size={13} />
                    <span>Open Workspace</span>
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Integrated Terminal Panel */}
          <Terminal
            workspaceRoot={rootPath}
            isOpen={isTerminalOpen}
            onClose={() => setIsTerminalOpen(false)}
            entries={terminalEntries}
            onClear={handleClearTerminal}
            onRunCommand={handleRunTerminalCommand}
            onStopCommand={handleStopTerminalCommand}
            isRunning={isTerminalRunning}
          />
        </div>

        {/* AI Chat Panel */}
        {isAIPanelOpen && (
          <AIChatPanel
            workspaceRoot={rootPath}
            onFileCreated={handleFileCreated}
            onFileEdited={handleFileEdited}
            onCommandExecuted={handleAICommandExecuted}
            onClose={() => setIsAIPanelOpen(false)}
          />
        )}
      </div>

      {/* Bottom Status Bar */}
      <footer className="status-bar">
        <div className="status-left">
          <div className="status-pill">
            {activeTab?.isDirty ? (
              <AlertCircle size={11} color="#f59e0b" />
            ) : (
              <CheckCircle2 size={11} color="#10b981" />
            )}
            <span className="status-text">{statusMessage}</span>
          </div>
          {gitBranch && (
            <div className="status-pill git-branch-pill" title={`Git Branch: ${gitBranch}`}>
              <GitBranch size={11} color="#60a5fa" />
              <span className="status-text" style={{ color: '#93c5fd', fontWeight: 500 }}>
                {gitBranch}
              </span>
            </div>
          )}
        </div>
        <div className="status-right">
          {activeTab && (
            <>
              <span className="status-item file-path-item" title={activeTab.path}>
                {activeTab.name}
              </span>
              <span className="status-badge">
                {activeTab.path.split('.').pop()?.toUpperCase() || 'PLAIN'}
              </span>
              <span className="status-item">UTF-8</span>
            </>
          )}
          <span className="status-item provider-status">
            <span className="status-dot online" />
            <span>AI Ready</span>
          </span>
        </div>
      </footer>
    </div>
  )
}
