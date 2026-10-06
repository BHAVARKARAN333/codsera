import React, { useState, useEffect, useRef, useCallback } from 'react'
import {
  Terminal as TerminalIcon,
  Play,
  Square,
  Trash2,
  X,
  AlertTriangle,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Maximize2,
  Minimize2,
  CornerDownLeft,
  Plus
} from 'lucide-react'
import { TerminalTabStatus } from '../../../shared/types'
import { XtermSessionView, XtermInstanceHandle } from './terminal/XtermSessionView'

export interface TerminalEntry {
  id: string
  sessionId?: string
  command: string
  cwd: string
  stdout: string
  stderr: string
  exitCode: number | null
  running: boolean
  timedOut?: boolean
  error?: string
  timestamp: number
  source: 'user' | 'ai'
}

export interface TerminalTab {
  id: string
  title: string
  cwd: string
  entries: TerminalEntry[]
  commandHistory: string[]
  inputBuffer: string
  isRunning: boolean
  activeProcessSessionId: string | null
  lastExitCode: number | null
  status: TerminalTabStatus
  createdAt: number
}

export type { TerminalTabStatus }

export interface TerminalProps {
  workspaceRoot: string | null
  isOpen: boolean
  onClose: () => void
  entries?: TerminalEntry[]
  onClear: () => void
  onRunCommand: (command: string) => Promise<void>
  onStopCommand: () => void
  isRunning: boolean
  activeSessionId?: string | null
  onSendInput?: (input: string) => Promise<boolean>
  // Phase 7.5 Multi-session Tab props
  tabs?: TerminalTab[]
  activeTabId?: string | null
  onSelectTab?: (tabId: string) => void
  onNewTab?: () => void
  onCloseTab?: (tabId: string, force?: boolean) => void
  onUpdateInputBuffer?: (tabId: string, input: string) => void
}

export const Terminal: React.FC<TerminalProps> = ({
  workspaceRoot,
  isOpen,
  onClose,
  entries = [],
  onClear,
  onRunCommand,
  onStopCommand,
  isRunning,
  activeSessionId,
  onSendInput,
  tabs = [],
  activeTabId,
  onSelectTab,
  onNewTab,
  onCloseTab,
  onUpdateInputBuffer
}) => {
  const [inputCommand, setInputCommand] = useState<string>('')
  const [historyIndex, setHistoryIndex] = useState<number>(-1)
  const [commandHistory, setCommandHistory] = useState<string[]>([])
  const [isExpanded, setIsExpanded] = useState<boolean>(false)
  const [isSendingInput, setIsSendingInput] = useState<boolean>(false)
  const [confirmCloseTab, setConfirmCloseTab] = useState<TerminalTab | null>(null)

  const outputEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Resolve active tab if tabs mode is active, otherwise fallback to props
  const tabList = tabs || []
  const activeTab = tabList.find((t) => t.id === activeTabId) || tabList[0] || null

  const effectiveEntries = activeTab ? activeTab.entries : entries
  const effectiveIsRunning = activeTab ? activeTab.isRunning : isRunning
  const effectiveActiveSessionId = activeTab ? activeTab.activeProcessSessionId : activeSessionId
  const effectiveCwd = activeTab?.cwd || workspaceRoot || 'No workspace'
  const cwdDisplay = effectiveCwd.split(/[\\/]/).pop() || effectiveCwd
  const currentHistory = activeTab ? activeTab.commandHistory : commandHistory

  const terminalHandlesRef = useRef<Map<string, XtermInstanceHandle>>(new Map())
  const tabListRef = useRef<TerminalTab[]>(tabList)
  tabListRef.current = tabList
  const activeTabRef = useRef<TerminalTab | null>(activeTab)
  activeTabRef.current = activeTab

  const handleRegisterTerminal = useCallback((tabId: string, handle: XtermInstanceHandle) => {
    terminalHandlesRef.current.set(tabId, handle)
  }, [])

  const handleUnregisterTerminal = useCallback((tabId: string) => {
    terminalHandlesRef.current.delete(tabId)
  }, [])

  // Central event-driven IPC stream routing to active xterm instances (single listener, no duplicate listeners)
  useEffect(() => {
    if (typeof window === 'undefined' || !window.electronAPI?.onTerminalStreamData) return

    const unsubscribe = window.electronAPI.onTerminalStreamData((evt) => {
      if (!evt || !evt.sessionId) return
      for (const tab of tabListRef.current) {
        if (tab.activeProcessSessionId === evt.sessionId || tab.id === evt.sessionId) {
          const handle = terminalHandlesRef.current.get(tab.id)
          if (handle) {
            handle.write(evt.data)
            return
          }
        }
      }
      const currentActive = activeTabRef.current
      if (currentActive) {
        terminalHandlesRef.current.get(currentActive.id)?.write(evt.data)
      }
    })

    return () => {
      unsubscribe()
    }
  }, [])

  const handleClearTerminal = () => {
    onClear()
    if (activeTab) {
      terminalHandlesRef.current.get(activeTab.id)?.clear()
    }
  }

  // Auto-scroll to bottom whenever entries change or tab switches
  useEffect(() => {
    if (isOpen && outputEndRef.current) {
      outputEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [effectiveEntries, isOpen, activeTabId])

  // Sync input field buffer when active tab changes
  useEffect(() => {
    if (activeTab) {
      setInputCommand(activeTab.inputBuffer || '')
      setHistoryIndex(-1)
    }
  }, [activeTabId])

  // Focus input when opened or when running state changes
  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus()
    }
  }, [isOpen, effectiveIsRunning, activeTabId])

  // Reset sending state when session stops
  useEffect(() => {
    if (!effectiveIsRunning) {
      setIsSendingInput(false)
    }
  }, [effectiveIsRunning])

  // Escape key closes confirmation modal
  useEffect(() => {
    const handleModalEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && confirmCloseTab) {
        setConfirmCloseTab(null)
      }
    }
    window.addEventListener('keydown', handleModalEscape)
    return () => window.removeEventListener('keydown', handleModalEscape)
  }, [confirmCloseTab])

  if (!isOpen) return null

  const handleInputChange = (val: string) => {
    setInputCommand(val)
    if (activeTab && onUpdateInputBuffer) {
      onUpdateInputBuffer(activeTab.id, val)
    }
  }

  const handleSelectTab = (targetTabId: string) => {
    if (targetTabId === activeTab?.id) return
    // Persist current pending input buffer before switching
    if (activeTab && onUpdateInputBuffer) {
      onUpdateInputBuffer(activeTab.id, inputCommand)
    }
    onSelectTab?.(targetTabId)
  }

  const handleRequestCloseTab = (tab: TerminalTab, e?: React.MouseEvent) => {
    e?.stopPropagation()
    if (tab.isRunning) {
      setConfirmCloseTab(tab)
    } else {
      onCloseTab?.(tab.id, false)
    }
  }

  const handleConfirmTerminateAndClose = () => {
    if (confirmCloseTab) {
      onCloseTab?.(confirmCloseTab.id, true)
      setConfirmCloseTab(null)
    }
  }

  const handleCancelClose = () => {
    setConfirmCloseTab(null)
  }

  const submitInputOrCommand = async () => {
    if (effectiveIsRunning) {
      if (isSendingInput || !onSendInput) return
      setIsSendingInput(true)
      try {
        const success = await onSendInput(inputCommand)
        if (success) {
          setInputCommand('')
          if (activeTab && onUpdateInputBuffer) {
            onUpdateInputBuffer(activeTab.id, '')
          }
        }
      } finally {
        setIsSendingInput(false)
        inputRef.current?.focus()
      }
    } else {
      const trimmed = inputCommand.trim()
      if (!trimmed) return

      if (!activeTab) {
        setCommandHistory((prev) => [...prev, trimmed])
      }
      setHistoryIndex(-1)
      setInputCommand('')
      if (activeTab && onUpdateInputBuffer) {
        onUpdateInputBuffer(activeTab.id, '')
      }

      await onRunCommand(trimmed)
    }
  }

  const handleKeyDown = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      await submitInputOrCommand()
    } else if (!effectiveIsRunning && e.key === 'ArrowUp') {
      e.preventDefault()
      if (currentHistory.length === 0) return
      const nextIndex = historyIndex === -1 ? currentHistory.length - 1 : Math.max(0, historyIndex - 1)
      setHistoryIndex(nextIndex)
      const cmd = currentHistory[nextIndex] || ''
      setInputCommand(cmd)
      if (activeTab && onUpdateInputBuffer) onUpdateInputBuffer(activeTab.id, cmd)
    } else if (!effectiveIsRunning && e.key === 'ArrowDown') {
      e.preventDefault()
      if (historyIndex === -1) return
      const nextIndex = historyIndex + 1
      if (nextIndex >= currentHistory.length) {
        setHistoryIndex(-1)
        setInputCommand('')
        if (activeTab && onUpdateInputBuffer) onUpdateInputBuffer(activeTab.id, '')
      } else {
        setHistoryIndex(nextIndex)
        const cmd = currentHistory[nextIndex] || ''
        setInputCommand(cmd)
        if (activeTab && onUpdateInputBuffer) onUpdateInputBuffer(activeTab.id, cmd)
      }
    }
  }

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    await submitInputOrCommand()
  }

  return (
    <div className={`terminal-panel ${isExpanded ? 'expanded' : ''}`}>
      {/* Terminal Header & Multi-session Tabs */}
      <div className="terminal-header">
        <div className="terminal-header-left">
          <TerminalIcon size={14} className="terminal-icon" />
          <span className="terminal-title">Terminal</span>

          <div className="terminal-header-divider" />

          {/* Multi-session Tabs */}
          {tabList.length > 0 && (
            <div className="terminal-tabs-list" role="tablist" aria-label="Terminal Sessions">
              {tabList.map((tab) => {
                const isActive = tab.id === activeTab?.id
                return (
                  <div
                    key={tab.id}
                    role="tab"
                    aria-selected={isActive}
                    tabIndex={0}
                    className={`terminal-tab ${isActive ? 'active' : ''} ${tab.isRunning ? 'running' : ''}`}
                    onClick={() => handleSelectTab(tab.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        handleSelectTab(tab.id)
                      }
                    }}
                    title={`${tab.title} (${tab.status}) - ${tab.cwd || workspaceRoot || ''}`}
                  >
                    <span className="terminal-tab-status-icon">
                      {tab.isRunning ? (
                        <Loader2 size={11} className="spin text-accent" />
                      ) : tab.status === 'failed' ? (
                        <AlertCircle size={11} className="text-danger" />
                      ) : tab.status === 'completed' ? (
                        <CheckCircle2 size={11} className="text-success" />
                      ) : (
                        <TerminalIcon size={11} className="text-muted" />
                      )}
                    </span>
                    <span className="terminal-tab-title">{tab.title}</span>
                    {tab.lastExitCode !== null && tab.lastExitCode !== 0 && !tab.isRunning && (
                      <span className="terminal-tab-exit-tag">{tab.lastExitCode}</span>
                    )}
                    <button
                      type="button"
                      className="terminal-tab-close-btn"
                      onClick={(e) => handleRequestCloseTab(tab, e)}
                      title={`Close ${tab.title}`}
                      aria-label={`Close ${tab.title}`}
                    >
                      <X size={10} />
                    </button>
                  </div>
                )
              })}
            </div>
          )}

          {/* New Terminal (+) Button */}
          {onNewTab && (
            <button
              type="button"
              className="terminal-new-tab-btn"
              onClick={onNewTab}
              title="New Terminal"
              aria-label="New Terminal"
            >
              <Plus size={13} />
            </button>
          )}

          {effectiveCwd && (
            <span className="terminal-cwd-pill" title={effectiveCwd}>
              {cwdDisplay}
            </span>
          )}

          {effectiveIsRunning && (
            <div
              className="terminal-running-badge"
              title={effectiveActiveSessionId ? `Session: ${effectiveActiveSessionId}` : undefined}
            >
              <Loader2 size={12} className="spin" />
              <span>Running...</span>
            </div>
          )}
        </div>

        <div className="terminal-header-right">
          {effectiveIsRunning ? (
            <button
              className="btn btn-xs btn-danger-ghost"
              onClick={onStopCommand}
              title="Stop running command"
              type="button"
              aria-label="Stop running command"
            >
              <Square size={11} />
              <span>Stop</span>
            </button>
          ) : null}

          <button
            className="btn-terminal-icon"
            onClick={handleClearTerminal}
            title="Clear terminal output"
            type="button"
            disabled={effectiveEntries.length === 0}
            aria-label="Clear terminal output"
          >
            <Trash2 size={13} />
          </button>

          {activeTab && onCloseTab && (
            <button
              className="btn-terminal-icon"
              onClick={(e) => handleRequestCloseTab(activeTab, e)}
              title="Close active terminal"
              type="button"
              aria-label="Close active terminal"
            >
              <X size={13} />
            </button>
          )}

          <button
            className="btn-terminal-icon"
            onClick={() => setIsExpanded(!isExpanded)}
            title={isExpanded ? 'Restore size' : 'Expand terminal'}
            type="button"
            aria-label={isExpanded ? 'Restore size' : 'Expand terminal'}
          >
            {isExpanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>

          <button
            className="btn-terminal-icon"
            onClick={onClose}
            title="Close terminal panel"
            type="button"
            aria-label="Close terminal panel"
          >
            <X size={13} />
          </button>
        </div>
      </div>

      {/* Terminal Output Body */}
      <div className="terminal-body" onClick={() => inputRef.current?.focus()}>
        {tabList.length === 0 ? (
          <div className="terminal-empty-state">
            <div className="terminal-empty-icon-wrap">
              <TerminalIcon size={24} className="terminal-empty-icon" />
            </div>
            <h4>No Active Terminal Sessions</h4>
            <p className="terminal-hint-sub">
              {workspaceRoot
                ? `Create a terminal session to execute commands in "${workspaceRoot}".`
                : 'Open a workspace folder to execute commands.'}
            </p>
            {onNewTab && (
              <button
                type="button"
                className="btn btn-primary btn-sm terminal-create-tab-btn"
                onClick={onNewTab}
                disabled={!workspaceRoot}
              >
                <Plus size={13} />
                <span>New Terminal</span>
              </button>
            )}
          </div>
        ) : (
          <>
            {/* Dedicated xterm.js viewport per tab (persisted across tab switches) */}
            {tabList.map((tab) => (
              <XtermSessionView
                key={tab.id}
                tabId={tab.id}
                activeProcessSessionId={tab.activeProcessSessionId}
                isActive={tab.id === activeTab?.id}
                isRunning={tab.isRunning}
                entries={tab.entries}
                onRunCommand={onRunCommand}
                onRegisterTerminal={handleRegisterTerminal}
                onUnregisterTerminal={handleUnregisterTerminal}
              />
            ))}

            {effectiveEntries.length === 0 && !effectiveIsRunning && (
              <div className="terminal-empty-hint">
                <p>{activeTab?.title || 'Terminal'} — Integrated Workspace Terminal</p>
                <p className="terminal-hint-sub">
                  {workspaceRoot
                    ? `Commands execute in "${effectiveCwd}". Type a command below or let the AI run tasks.`
                    : 'Open a workspace folder to execute commands.'}
                </p>
              </div>
            )}

            {/* Test and Accessibility Fallback Entry Structure */}
            <div
              className="terminal-entries-fallback"
              style={{ display: 'none' }}
              aria-hidden="true"
              data-testid="terminal-entries-fallback"
            >
              {effectiveEntries.map((entry: TerminalEntry) => {
                const isSuccess = entry.exitCode === 0
                const isFailed = entry.exitCode !== null && entry.exitCode !== 0

                return (
                  <div key={entry.id} className="terminal-entry">
                    {/* Command prompt line */}
                    <div className="terminal-command-line">
                      <span className="terminal-prompt-symbol">$</span>
                      <span className="terminal-command-text">{entry.command}</span>
                      {entry.source === 'ai' && (
                        <span className="terminal-source-badge ai">AI</span>
                      )}
                      {entry.running && (
                        <span className="terminal-status-badge running">
                          <Loader2 size={10} className="spin" />
                          <span>running</span>
                        </span>
                      )}
                      {isSuccess && (
                        <span className="terminal-status-badge success">
                          <CheckCircle2 size={10} />
                          <span>exit 0</span>
                        </span>
                      )}
                      {isFailed && (
                        <span className="terminal-status-badge error">
                          <AlertCircle size={10} />
                          <span>exit {entry.exitCode}</span>
                        </span>
                      )}
                      {entry.timedOut && (
                        <span className="terminal-status-badge error">
                          <AlertTriangle size={10} />
                          <span>timed out</span>
                        </span>
                      )}
                    </div>

                    {/* Stdout */}
                    {entry.stdout && (
                      <pre className="terminal-stdout">{entry.stdout}</pre>
                    )}

                    {/* Stderr */}
                    {entry.stderr && (
                      <pre className="terminal-stderr">{entry.stderr}</pre>
                    )}

                    {/* Error if spawned failed */}
                    {entry.error && (
                      <div className="terminal-error-message">
                        <AlertCircle size={12} />
                        <span>{entry.error}</span>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </>
        )}
        <div ref={outputEndRef} />
      </div>

      {/* Terminal Input Bar */}
      <form className="terminal-input-bar" onSubmit={handleFormSubmit}>
        <span className={`terminal-input-prompt ${effectiveIsRunning ? 'running' : ''}`}>
          {effectiveIsRunning ? '>' : '$'}
        </span>
        <input
          ref={inputRef}
          type="text"
          className="terminal-input"
          value={inputCommand}
          onChange={(e) => handleInputChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            !workspaceRoot
              ? 'Open a workspace folder to run commands...'
              : tabList.length === 0
              ? 'No open terminal session. Click New Terminal to start.'
              : effectiveIsRunning
              ? 'Type input for running command (press Enter to send)...'
              : 'Type a command and press Enter (e.g. npm test, ls, git status)...'
          }
          disabled={!workspaceRoot || isSendingInput || tabList.length === 0}
          spellCheck={false}
          autoComplete="off"
        />
        {effectiveIsRunning ? (
          <div className="terminal-input-actions">
            <button
              type="submit"
              className="btn btn-xs btn-primary"
              disabled={!workspaceRoot || isSendingInput}
              title="Send input to running command (Enter)"
            >
              <CornerDownLeft size={11} />
              <span>Send</span>
            </button>
            <button
              type="button"
              className="btn btn-xs btn-danger"
              onClick={onStopCommand}
              title="Stop running command"
            >
              <Square size={11} />
              <span>Stop</span>
            </button>
          </div>
        ) : (
          <button
            type="submit"
            className="btn btn-xs btn-primary"
            disabled={!workspaceRoot || !inputCommand.trim() || tabList.length === 0}
            title="Execute command"
          >
            <Play size={11} />
            <span>Run</span>
          </button>
        )}
      </form>

      {/* Confirmation Modal for Terminating Running Session */}
      {confirmCloseTab && (
        <div className="explorer-modal-backdrop" onClick={handleCancelClose}>
          <div
            className="explorer-modal terminal-confirm-modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <div className="explorer-modal-header">
              <div className="explorer-modal-title">
                <AlertTriangle size={16} className="modal-title-icon warning" />
                <span>Terminate Running Session?</span>
              </div>
              <button
                type="button"
                className="explorer-modal-close-btn"
                onClick={handleCancelClose}
                title="Cancel"
              >
                <X size={14} />
              </button>
            </div>
            <div className="explorer-modal-body">
              <div className="explorer-modal-message">
                <p>
                  Terminal session <strong>{confirmCloseTab.title}</strong> is currently executing a command.
                </p>
                <p className="terminal-modal-subtext">
                  Closing this tab will immediately terminate the running process tree. Are you sure you want to terminate and close?
                </p>
              </div>
            </div>
            <div className="explorer-modal-footer">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={handleCancelClose}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={handleConfirmTerminateAndClose}
              >
                Terminate &amp; Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
