import React, { useState, useEffect, useRef } from 'react'
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
  Minimize2
} from 'lucide-react'

export interface TerminalEntry {
  id: string
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

interface TerminalProps {
  workspaceRoot: string | null
  isOpen: boolean
  onClose: () => void
  entries: TerminalEntry[]
  onClear: () => void
  onRunCommand: (command: string) => Promise<void>
  onStopCommand: () => void
  isRunning: boolean
}

export const Terminal: React.FC<TerminalProps> = ({
  workspaceRoot,
  isOpen,
  onClose,
  entries,
  onClear,
  onRunCommand,
  onStopCommand,
  isRunning
}) => {
  const [inputCommand, setInputCommand] = useState<string>('')
  const [historyIndex, setHistoryIndex] = useState<number>(-1)
  const [commandHistory, setCommandHistory] = useState<string[]>([])
  const [isExpanded, setIsExpanded] = useState<boolean>(false)

  const outputEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Auto-scroll to bottom whenever entries change
  useEffect(() => {
    if (isOpen && outputEndRef.current) {
      outputEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [entries, isOpen])

  // Focus input when opened
  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus()
    }
  }, [isOpen])

  if (!isOpen) return null

  const handleKeyDown = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      const trimmed = inputCommand.trim()
      if (!trimmed || isRunning) return

      // Add to command history
      setCommandHistory((prev) => [...prev, trimmed])
      setHistoryIndex(-1)
      setInputCommand('')

      await onRunCommand(trimmed)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (commandHistory.length === 0) return
      const nextIndex = historyIndex === -1 ? commandHistory.length - 1 : Math.max(0, historyIndex - 1)
      setHistoryIndex(nextIndex)
      setInputCommand(commandHistory[nextIndex] || '')
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (historyIndex === -1) return
      const nextIndex = historyIndex + 1
      if (nextIndex >= commandHistory.length) {
        setHistoryIndex(-1)
        setInputCommand('')
      } else {
        setHistoryIndex(nextIndex)
        setInputCommand(commandHistory[nextIndex] || '')
      }
    }
  }

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = inputCommand.trim()
    if (!trimmed || isRunning) return

    setCommandHistory((prev) => [...prev, trimmed])
    setHistoryIndex(-1)
    setInputCommand('')

    await onRunCommand(trimmed)
  }

  const cwdDisplay = workspaceRoot ? workspaceRoot.split(/[\\/]/).pop() || workspaceRoot : 'No workspace'

  return (
    <div className={`terminal-panel ${isExpanded ? 'expanded' : ''}`}>
      {/* Terminal Header */}
      <div className="terminal-header">
        <div className="terminal-header-left">
          <TerminalIcon size={14} className="terminal-icon" />
          <span className="terminal-title">Terminal</span>
          <span className="terminal-cwd-pill" title={workspaceRoot || 'No workspace opened'}>
            {cwdDisplay}
          </span>
          {isRunning && (
            <div className="terminal-running-badge">
              <Loader2 size={12} className="spin" />
              <span>Running...</span>
            </div>
          )}
        </div>

        <div className="terminal-header-right">
          {isRunning ? (
            <button
              className="btn btn-xs btn-danger-ghost"
              onClick={onStopCommand}
              title="Stop running command"
              type="button"
            >
              <Square size={11} />
              <span>Stop</span>
            </button>
          ) : null}

          <button
            className="btn-terminal-icon"
            onClick={onClear}
            title="Clear terminal output"
            type="button"
          >
            <Trash2 size={13} />
          </button>

          <button
            className="btn-terminal-icon"
            onClick={() => setIsExpanded(!isExpanded)}
            title={isExpanded ? 'Restore size' : 'Expand terminal'}
            type="button"
          >
            {isExpanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>

          <button
            className="btn-terminal-icon"
            onClick={onClose}
            title="Close terminal"
            type="button"
          >
            <X size={13} />
          </button>
        </div>
      </div>

      {/* Terminal Output Body */}
      <div className="terminal-body" onClick={() => inputRef.current?.focus()}>
        {entries.length === 0 ? (
          <div className="terminal-empty-hint">
            <p>Integrated Workspace Terminal</p>
            <p className="terminal-hint-sub">
              {workspaceRoot
                ? `Commands execute in "${workspaceRoot}". Type a command below or let the AI run tasks.`
                : 'Open a workspace folder to execute commands.'}
            </p>
          </div>
        ) : (
          entries.map((entry) => {
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
          })
        )}
        <div ref={outputEndRef} />
      </div>

      {/* Terminal Input Bar */}
      <form className="terminal-input-bar" onSubmit={handleFormSubmit}>
        <span className="terminal-input-prompt">$</span>
        <input
          ref={inputRef}
          type="text"
          className="terminal-input"
          value={inputCommand}
          onChange={(e) => setInputCommand(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            !workspaceRoot
              ? 'Open a workspace folder to run commands...'
              : isRunning
              ? 'Command is executing (click Stop to cancel)...'
              : 'Type a command and press Enter (e.g. npm test, ls, git status)...'
          }
          disabled={!workspaceRoot || isRunning}
          spellCheck={false}
          autoComplete="off"
        />
        {isRunning ? (
          <button
            type="button"
            className="btn btn-xs btn-danger"
            onClick={onStopCommand}
            title="Stop running command"
          >
            <Square size={11} />
            <span>Stop</span>
          </button>
        ) : (
          <button
            type="submit"
            className="btn btn-xs btn-primary"
            disabled={!workspaceRoot || !inputCommand.trim()}
            title="Execute command"
          >
            <Play size={11} />
            <span>Run</span>
          </button>
        )}
      </form>
    </div>
  )
}
