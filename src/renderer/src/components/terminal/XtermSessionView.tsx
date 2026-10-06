import React, { useEffect, useRef } from 'react'
import { Terminal as XtermTerminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { DEFAULT_XTERM_OPTIONS } from './terminalConfig'
import type { TerminalEntry } from '../Terminal'

export interface XtermInstanceHandle {
  term: XtermTerminal
  fitAddon: FitAddon
  clear: () => void
  write: (data: string) => void
  focus: () => void
  getCols: () => number
  getRows: () => number
}

export interface XtermSessionViewProps {
  tabId: string
  activeProcessSessionId: string | null
  isActive: boolean
  isRunning?: boolean
  entries?: TerminalEntry[]
  onRunCommand?: (command: string) => Promise<void>
  onRegisterTerminal?: (tabId: string, instance: XtermInstanceHandle) => void
  onUnregisterTerminal?: (tabId: string) => void
  onResize?: (tabId: string, cols: number, rows: number) => void
}

export const XtermSessionView: React.FC<XtermSessionViewProps> = ({
  tabId,
  activeProcessSessionId,
  isActive,
  isRunning = false,
  entries = [],
  onRunCommand,
  onRegisterTerminal,
  onUnregisterTerminal,
  onResize
}) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XtermTerminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const activeSessionIdRef = useRef<string | null>(activeProcessSessionId)
  activeSessionIdRef.current = activeProcessSessionId

  const isRunningRef = useRef<boolean>(isRunning)
  isRunningRef.current = isRunning

  const isActiveRef = useRef<boolean>(isActive)
  isActiveRef.current = isActive

  const lineBufferRef = useRef<string>('')
  const lastColsRef = useRef<number>(80)
  const lastRowsRef = useRef<number>(24)
  const writtenEntriesRef = useRef<Set<string>>(new Set())

  // Lifecycle: Initialize xterm instance, fit addon, keyboard handling, and resize observer
  useEffect(() => {
    if (!containerRef.current) return

    // 1. Instantiate xterm.js Terminal with centralized developer options
    const term = new XtermTerminal(DEFAULT_XTERM_OPTIONS)
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)

    termRef.current = term
    fitAddonRef.current = fitAddon

    // 2. Open xterm in the tab's container element
    term.open(containerRef.current)

    // Initial fit
    try {
      fitAddon.fit()
      lastColsRef.current = term.cols
      lastRowsRef.current = term.rows
    } catch {
      // Dimension lookup fallback in headless/unmeasured environments
    }

    // 3. Register instance with parent
    const handle: XtermInstanceHandle = {
      term,
      fitAddon,
      clear: () => {
        term.clear()
        writtenEntriesRef.current.clear()
      },
      write: (data: string) => {
        term.write(data)
      },
      focus: () => {
        term.focus()
      },
      getCols: () => term.cols,
      getRows: () => term.rows
    }
    onRegisterTerminal?.(tabId, handle)

    // 4. Keyboard / Data handler (stdin bridge)
    const dataDisposable = term.onData((data: string) => {
      const currentSessionId = activeSessionIdRef.current
      if (currentSessionId && isRunningRef.current) {
        // Forward directly to PTY stdin via validated IPC preload bridge
        if (typeof window !== 'undefined' && window.electronAPI?.terminalWriteInput) {
          window.electronAPI.terminalWriteInput(currentSessionId, data).catch(() => {})
        }
      } else {
        // Tab is idle: support direct typing in xterm
        if (data === '\r' || data === '\n') {
          term.write('\r\n')
          const cmd = lineBufferRef.current.trim()
          lineBufferRef.current = ''
          if (cmd && onRunCommand) {
            onRunCommand(cmd)
          }
        } else if (data === '\x7f' || data === '\b') {
          if (lineBufferRef.current.length > 0) {
            lineBufferRef.current = lineBufferRef.current.slice(0, -1)
            term.write('\b \b')
          }
        } else if (data === '\x03') {
          // Ctrl+C in idle
          lineBufferRef.current = ''
          term.write('^C\r\n')
        } else if (data === '\x0c') {
          // Ctrl+L: Clear screen
          term.clear()
        } else if (data >= ' ') {
          lineBufferRef.current += data
          term.write(data)
        }
      }
    })

    // 5. Custom key event handler for native clipboard copy/paste and Ctrl+C isolation
    term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
      // Ctrl+Shift+C: Copy selected text to clipboard
      if (
        event.ctrlKey &&
        event.shiftKey &&
        (event.key === 'C' || event.key === 'c') &&
        event.type === 'keydown'
      ) {
        const selection = term.getSelection()
        if (selection && typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(selection).catch(() => {})
          return false
        }
      }

      // Ctrl+Shift+V: Paste from clipboard
      if (
        event.ctrlKey &&
        event.shiftKey &&
        (event.key === 'V' || event.key === 'v') &&
        event.type === 'keydown'
      ) {
        if (typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
          navigator.clipboard
            .readText()
            .then((text) => {
              if (text) {
                const currentSessionId = activeSessionIdRef.current
                if (currentSessionId && isRunningRef.current && window.electronAPI?.terminalWriteInput) {
                  window.electronAPI.terminalWriteInput(currentSessionId, text)
                } else {
                  lineBufferRef.current += text
                  term.write(text)
                }
              }
            })
            .catch(() => {})
          return false
        }
      }

      // Ctrl+C with text selected copies text; without selection allows Ctrl+C (\x03) to pass through to PTY
      if (
        event.ctrlKey &&
        !event.shiftKey &&
        (event.key === 'c' || event.key === 'C') &&
        event.type === 'keydown'
      ) {
        if (term.hasSelection()) {
          const selection = term.getSelection()
          if (selection && typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(selection).catch(() => {})
            return false // don't send SIGINT if user intended to copy selected text
          }
        }
        return true // let standard \x03 flow to PTY
      }

      return true
    })

    // 6. Resize handling via ResizeObserver
    let resizeTimer: NodeJS.Timeout | null = null
    const handleResize = () => {
      if (!isActiveRef.current || !containerRef.current) return
      try {
        fitAddon.fit()
        const cols = Math.max(10, Math.min(term.cols, 500))
        const rows = Math.max(5, Math.min(term.rows, 200))

        if (cols !== lastColsRef.current || rows !== lastRowsRef.current) {
          lastColsRef.current = cols
          lastRowsRef.current = rows

          const currentSessionId = activeSessionIdRef.current
          if (currentSessionId && typeof window !== 'undefined' && window.electronAPI?.terminalResize) {
            window.electronAPI.terminalResize(currentSessionId, cols, rows).catch(() => {})
          }
          onResize?.(tabId, cols, rows)
        }
      } catch {
        // Ignore resize calculation issues during layout reflows
      }
    }

    let resizeObserver: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined' && containerRef.current) {
      resizeObserver = new ResizeObserver(() => {
        if (resizeTimer) clearTimeout(resizeTimer)
        resizeTimer = setTimeout(handleResize, 50)
      })
      resizeObserver.observe(containerRef.current)
    }

    // 7. Cleanup upon unmount / tab close
    return () => {
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeObserver?.disconnect()
      dataDisposable.dispose()
      onUnregisterTerminal?.(tabId)
      fitAddon.dispose()
      term.dispose()
      termRef.current = null
      fitAddonRef.current = null
    }
  }, [tabId])

  // Replay any historical entries into xterm on initial load
  useEffect(() => {
    const term = termRef.current
    if (!term || !entries || entries.length === 0) return

    for (const entry of entries) {
      if (!writtenEntriesRef.current.has(entry.id)) {
        writtenEntriesRef.current.add(entry.id)
        if (entry.command) {
          term.writeln(`\x1b[32m$\x1b[0m \x1b[1m${entry.command}\x1b[0m`)
        }
        if (entry.stdout) {
          term.write(entry.stdout)
        }
        if (entry.stderr) {
          term.write(`\x1b[31m${entry.stderr}\x1b[0m`)
        }
        if (entry.exitCode !== null && !entry.running) {
          const color = entry.exitCode === 0 ? '\x1b[32m' : '\x1b[31m'
          term.writeln(`${color}[Process exited ${entry.exitCode}]\x1b[0m`)
        }
      }
    }
  }, [entries])

  // When tab becomes active, re-fit dimensions and request keyboard focus
  useEffect(() => {
    if (isActive) {
      const term = termRef.current
      const fitAddon = fitAddonRef.current
      if (term && fitAddon) {
        setTimeout(() => {
          try {
            fitAddon.fit()
            const cols = Math.max(10, Math.min(term.cols, 500))
            const rows = Math.max(5, Math.min(term.rows, 200))
            if (cols !== lastColsRef.current || rows !== lastRowsRef.current) {
              lastColsRef.current = cols
              lastRowsRef.current = rows
              const currentSessionId = activeSessionIdRef.current
              if (currentSessionId && typeof window !== 'undefined' && window.electronAPI?.terminalResize) {
                window.electronAPI.terminalResize(currentSessionId, cols, rows).catch(() => {})
              }
              onResize?.(tabId, cols, rows)
            }
            term.focus()
          } catch {
            // Container may not be measured yet
          }
        }, 16)
      }
    }
  }, [isActive, tabId])

  return (
    <div
      className="terminal-xterm-view"
      data-testid={`xterm-view-${tabId}`}
      style={{
        display: isActive ? 'flex' : 'none',
        flex: 1,
        width: '100%',
        height: '100%',
        minHeight: 0
      }}
      onClick={() => termRef.current?.focus()}
    >
      <div
        ref={containerRef}
        className="terminal-xterm-container"
        data-testid={`xterm-container-${tabId}`}
        style={{ flex: 1, width: '100%', height: '100%', minHeight: 0 }}
      />
    </div>
  )
}
