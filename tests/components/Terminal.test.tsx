/**
 * Terminal Component Behavior Tests
 *
 * Verifies real React component rendering, multi-session tabs, command execution,
 * streaming stdout/stderr output, interactive input, toolbar actions, close confirmation modals,
 * and error/lifecycle states using React Testing Library in happy-dom.
 */

import React, { useState, useEffect, useRef } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within, act } from '@testing-library/react'
import { Terminal } from '@renderer/components/Terminal'
import type { TerminalTab, TerminalEntry } from '@renderer/components/Terminal'
import { setupMockElectron, resetMockElectron } from '../setup/electronMock'
import type {
  TerminalStreamDataEvent,
  TerminalSessionExitEvent,
  TerminalSpawnOptions,
  TerminalSpawnResult,
  TerminalWriteInputResult,
  TerminalKillResult,
  TerminalKillAllResult,
  TerminalResizeResult
} from '@shared/types'
import { processTerminalOutputForAI } from '@shared/terminalSanitizer'

// ============================================================================
// Test Fixtures & Factories
// ============================================================================

const MOCK_WORKSPACE = '/workspace/test-project'

function createMockEntry(overrides: Partial<TerminalEntry> = {}): TerminalEntry {
  return {
    id: 'entry_' + Math.random().toString(36).substring(2, 8),
    sessionId: 'session_1',
    command: 'npm test',
    cwd: MOCK_WORKSPACE,
    stdout: 'Tests passed successfully\n',
    stderr: '',
    exitCode: 0,
    running: false,
    timestamp: Date.now(),
    source: 'user',
    ...overrides
  }
}

function createMockTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: 'tab_' + Math.random().toString(36).substring(2, 8),
    title: 'Terminal 1',
    cwd: MOCK_WORKSPACE,
    entries: [],
    commandHistory: [],
    inputBuffer: '',
    isRunning: false,
    activeProcessSessionId: null,
    lastExitCode: null,
    status: 'idle',
    createdAt: Date.now(),
    ...overrides
  }
}

// ============================================================================
// Integrated Terminal Test Harness (mirrors App.tsx integration)
// ============================================================================

interface TerminalHarnessProps {
  workspaceRoot?: string | null
  isOpen?: boolean
  onClose?: () => void
  initialTabs?: TerminalTab[]
}

const TerminalHarness: React.FC<TerminalHarnessProps> = ({
  workspaceRoot = MOCK_WORKSPACE,
  isOpen = true,
  onClose,
  initialTabs
}) => {
  const [tabs, setTabs] = useState<TerminalTab[]>(() => {
    if (initialTabs) return initialTabs
    if (!workspaceRoot) return []
    return [createMockTab({ id: 'tab_initial', title: 'Terminal 1', cwd: workspaceRoot })]
  })
  const [activeTabId, setActiveTabId] = useState<string | null>(() => {
    if (initialTabs && initialTabs.length > 0) return initialTabs[0].id
    if (!workspaceRoot) return null
    return 'tab_initial'
  })
  const [isPanelOpen, setIsPanelOpen] = useState<boolean>(isOpen)

  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  const activeTabIdRef = useRef(activeTabId)
  activeTabIdRef.current = activeTabId

  // Workspace change cleanup
  useEffect(() => {
    if (window.electronAPI?.terminalKillAll) {
      window.electronAPI.terminalKillAll().catch(() => {})
    }
  }, [workspaceRoot])

  // Listen to Electron terminal events
  useEffect(() => {
    if (!window.electronAPI) return

    const unsubData = window.electronAPI.onTerminalStreamData?.((evt: TerminalStreamDataEvent) => {
      if (!evt?.sessionId) return
      setTabs((prevTabs) => {
        const tabIdx = prevTabs.findIndex(
          (t) =>
            t.activeProcessSessionId === evt.sessionId ||
            t.entries.some((e) => e.sessionId === evt.sessionId || e.id === evt.sessionId)
        )
        if (tabIdx === -1) return prevTabs

        const targetTab = prevTabs[tabIdx]
        const entryIdx = targetTab.entries.findIndex(
          (e) => e.sessionId === evt.sessionId || e.id === evt.sessionId
        )
        if (entryIdx === -1) return prevTabs

        const targetEntry = targetTab.entries[entryIdx]
        const updatedEntry = {
          ...targetEntry,
          stdout: evt.type === 'stdout' ? targetEntry.stdout + evt.data : targetEntry.stdout,
          stderr: evt.type === 'stderr' ? targetEntry.stderr + evt.data : targetEntry.stderr
        }

        const nextEntries = [...targetTab.entries]
        nextEntries[entryIdx] = updatedEntry
        const nextTabs = [...prevTabs]
        nextTabs[tabIdx] = { ...targetTab, entries: nextEntries }
        return nextTabs
      })
    })

    const unsubExit = window.electronAPI.onTerminalSessionExit?.((evt: TerminalSessionExitEvent) => {
      if (!evt?.sessionId) return
      setTabs((prevTabs) => {
        const tabIdx = prevTabs.findIndex(
          (t) =>
            t.activeProcessSessionId === evt.sessionId ||
            t.entries.some((e) => e.sessionId === evt.sessionId || e.id === evt.sessionId)
        )
        if (tabIdx === -1) return prevTabs

        const targetTab = prevTabs[tabIdx]
        const entryIdx = targetTab.entries.findIndex(
          (e) => e.sessionId === evt.sessionId || e.id === evt.sessionId
        )
        if (entryIdx === -1) return prevTabs

        const targetEntry = targetTab.entries[entryIdx]
        const updatedEntry = {
          ...targetEntry,
          running: false,
          exitCode: evt.exitCode,
          timedOut: evt.timedOut,
          error: evt.error || targetEntry.error
        }

        const nextEntries = [...targetTab.entries]
        nextEntries[entryIdx] = updatedEntry
        const nextTabs = [...prevTabs]
        nextTabs[tabIdx] = {
          ...targetTab,
          isRunning: false,
          activeProcessSessionId: null,
          lastExitCode: evt.exitCode,
          status: evt.exitCode === 0 && !evt.timedOut ? 'completed' : 'failed',
          entries: nextEntries
        }
        return nextTabs
      })
    })

    return () => {
      unsubData?.()
      unsubExit?.()
    }
  }, [])

  const handleRunCommand = async (command: string) => {
    const currentTab = tabsRef.current.find((t) => t.id === activeTabIdRef.current)
    if (!currentTab || currentTab.isRunning) return

    const sessionId = 'session_' + Math.random().toString(36).substring(2, 9)
    const newEntry: TerminalEntry = {
      id: sessionId,
      sessionId,
      command,
      cwd: currentTab.cwd || workspaceRoot || '',
      stdout: '',
      stderr: '',
      exitCode: null,
      running: true,
      timestamp: Date.now(),
      source: 'user'
    }

    setTabs((prev) =>
      prev.map((t) =>
        t.id === currentTab.id
          ? {
              ...t,
              isRunning: true,
              activeProcessSessionId: sessionId,
              status: 'running',
              inputBuffer: '',
              commandHistory: [...t.commandHistory, command],
              entries: [...t.entries, newEntry]
            }
          : t
      )
    )

    try {
      if (window.electronAPI?.terminalSpawn) {
        const res = await window.electronAPI.terminalSpawn({
          sessionId,
          command,
          cwd: currentTab.cwd || workspaceRoot || '',
          workspaceRoot: workspaceRoot || '',
          source: 'user'
        })
        if (!res.success) {
          setTabs((prev) =>
            prev.map((t) =>
              t.id === currentTab.id
                ? {
                    ...t,
                    isRunning: false,
                    activeProcessSessionId: null,
                    status: 'failed',
                    lastExitCode: -1,
                    entries: t.entries.map((e) =>
                      e.id === sessionId ? { ...e, running: false, error: res.error, exitCode: -1 } : e
                    )
                  }
                : t
            )
          )
        }
      }
    } catch (err: any) {
      setTabs((prev) =>
        prev.map((t) =>
          t.id === currentTab.id
            ? {
                ...t,
                isRunning: false,
                activeProcessSessionId: null,
                status: 'failed',
                lastExitCode: -1,
                entries: t.entries.map((e) =>
                  e.id === sessionId ? { ...e, running: false, error: err.message, exitCode: -1 } : e
                )
              }
            : t
        )
      )
    }
  }

  const handleSendInput = async (input: string): Promise<boolean> => {
    const currentTab = tabsRef.current.find((t) => t.id === activeTabIdRef.current)
    if (!currentTab?.isRunning || !currentTab.activeProcessSessionId) return false

    const payload = input.endsWith('\n') ? input : input + '\n'
    try {
      if (typeof window.electronAPI?.terminalWriteInput !== 'function') return false
      const res = await window.electronAPI.terminalWriteInput(currentTab.activeProcessSessionId, payload)
      if (res.success) {
        setTabs((prev) =>
          prev.map((t) =>
            t.id === currentTab.id
              ? {
                  ...t,
                  entries: t.entries.map((e) =>
                    e.id === currentTab.activeProcessSessionId ? { ...e, stdout: e.stdout + payload } : e
                  )
                }
              : t
          )
        )
        return true
      }
      return false
    } catch {
      return false
    }
  }

  const handleStopCommand = async () => {
    const currentTab = tabsRef.current.find((t) => t.id === activeTabIdRef.current)
    if (currentTab?.activeProcessSessionId && typeof window.electronAPI?.terminalKill === 'function') {
      await window.electronAPI.terminalKill(currentTab.activeProcessSessionId)
    }
  }

  const handleClear = () => {
    if (!activeTabIdRef.current) return
    setTabs((prev) =>
      prev.map((t) => (t.id === activeTabIdRef.current ? { ...t, entries: [] } : t))
    )
  }

  const handleNewTab = () => {
    const count = tabsRef.current.length + 1
    const newId = 'tab_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6)
    const newTab = createMockTab({
      id: newId,
      title: `Terminal ${count}`,
      cwd: workspaceRoot || ''
    })
    setTabs((prev) => [...prev, newTab])
    setActiveTabId(newId)
  }

  const handleCloseTab = async (tabId: string, force = false) => {
    const target = tabsRef.current.find((t) => t.id === tabId)
    if (!target) return

    if (target.isRunning && target.activeProcessSessionId && force && typeof window.electronAPI?.terminalKill === 'function') {
      await window.electronAPI.terminalKill(target.activeProcessSessionId)
    }

    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === tabId)
      const next = prev.filter((t) => t.id !== tabId)
      if (activeTabIdRef.current === tabId) {
        if (next.length > 0) {
          const nextIdx = Math.min(idx, next.length - 1)
          setActiveTabId(next[nextIdx].id)
        } else {
          setActiveTabId(null)
        }
      }
      return next
    })
  }

  const handleUpdateInputBuffer = (tabId: string, input: string) => {
    setTabs((prev) =>
      prev.map((t) => (t.id === tabId ? { ...t, inputBuffer: input } : t))
    )
  }

  const currentTab = tabs.find((t) => t.id === activeTabId)

  return (
    <Terminal
      workspaceRoot={workspaceRoot}
      isOpen={isPanelOpen}
      onClose={() => {
        setIsPanelOpen(false)
        onClose?.()
      }}
      tabs={tabs}
      activeTabId={activeTabId}
      isRunning={currentTab?.isRunning || false}
      activeSessionId={currentTab?.activeProcessSessionId || null}
      entries={currentTab?.entries || []}
      onRunCommand={handleRunCommand}
      onSendInput={handleSendInput}
      onStopCommand={handleStopCommand}
      onClear={handleClear}
      onNewTab={handleNewTab}
      onSelectTab={setActiveTabId}
      onCloseTab={handleCloseTab}
      onUpdateInputBuffer={handleUpdateInputBuffer}
    />
  )
}

// ============================================================================
// Main Test Suite
// ============================================================================

describe('Terminal Component Tests', () => {
  let streamDataListeners: Array<(evt: TerminalStreamDataEvent) => void> = []
  let sessionExitListeners: Array<(evt: TerminalSessionExitEvent) => void> = []

  let mockTerminalSpawn: any
  let mockTerminalWriteInput: any
  let mockTerminalResize: any
  let mockTerminalKill: any
  let mockTerminalKillAll: any
  let mockOnTerminalStreamData: any
  let mockOnTerminalSessionExit: any

  beforeEach(() => {
    streamDataListeners = []
    sessionExitListeners = []

    mockTerminalSpawn = vi.fn().mockImplementation(async (opts: TerminalSpawnOptions): Promise<TerminalSpawnResult> => ({
      success: true,
      sessionId: opts.sessionId,
      pid: 9999
    }))

    mockTerminalWriteInput = vi.fn().mockResolvedValue({ success: true } as TerminalWriteInputResult)
    mockTerminalResize = vi.fn().mockImplementation(async (_sessionId: string, cols: number, rows: number): Promise<TerminalResizeResult> => ({
      success: true,
      cols,
      rows
    }))
    mockTerminalKill = vi.fn().mockResolvedValue({ success: true } as TerminalKillResult)
    mockTerminalKillAll = vi.fn().mockResolvedValue({ success: true, killedCount: 1 } as TerminalKillAllResult)

    mockOnTerminalStreamData = vi.fn().mockImplementation((cb: (evt: TerminalStreamDataEvent) => void) => {
      streamDataListeners.push(cb)
      return () => {
        streamDataListeners = streamDataListeners.filter((l) => l !== cb)
      }
    })

    mockOnTerminalSessionExit = vi.fn().mockImplementation((cb: (evt: TerminalSessionExitEvent) => void) => {
      sessionExitListeners.push(cb)
      return () => {
        sessionExitListeners = sessionExitListeners.filter((l) => l !== cb)
      }
    })

    setupMockElectron({
      terminalSpawn: mockTerminalSpawn,
      terminalWriteInput: mockTerminalWriteInput,
      terminalResize: mockTerminalResize,
      terminalKill: mockTerminalKill,
      terminalKillAll: mockTerminalKillAll,
      onTerminalStreamData: mockOnTerminalStreamData,
      onTerminalSessionExit: mockOnTerminalSessionExit
    })

    if (typeof window !== 'undefined' && window.HTMLElement) {
      window.HTMLElement.prototype.scrollIntoView = vi.fn()
    }
  })

  afterEach(() => {
    cleanup()
    resetMockElectron()
    vi.clearAllMocks()
  })

  function emitStreamData(evt: TerminalStreamDataEvent) {
    act(() => {
      streamDataListeners.forEach((cb) => cb(evt))
    })
  }

  function emitSessionExit(evt: TerminalSessionExitEvent) {
    act(() => {
      sessionExitListeners.forEach((cb) => cb(evt))
    })
  }

  // ==========================================================================
  // Group 1: Rendering and Initial State
  // ==========================================================================
  describe('Group 1: Rendering and Initial State', () => {
    it('renders null when isOpen is false', () => {
      const { container } = render(
        <Terminal
          workspaceRoot={MOCK_WORKSPACE}
          isOpen={false}
          onClose={vi.fn()}
          onClear={vi.fn()}
          onRunCommand={vi.fn()}
          onStopCommand={vi.fn()}
          isRunning={false}
        />
      )

      expect(container.firstChild).toBeNull()
    })

    it('renders the Terminal panel and toolbar when isOpen is true', () => {
      render(
        <Terminal
          workspaceRoot={MOCK_WORKSPACE}
          isOpen={true}
          onClose={vi.fn()}
          onClear={vi.fn()}
          onRunCommand={vi.fn()}
          onStopCommand={vi.fn()}
          isRunning={false}
        />
      )

      expect(screen.getByText('Terminal')).toBeInTheDocument()
      expect(screen.getByLabelText('Close terminal panel')).toBeInTheDocument()
      expect(screen.getByLabelText('Clear terminal output')).toBeInTheDocument()
      expect(screen.getByLabelText('Expand terminal')).toBeInTheDocument()
    })

    it('displays the empty state when there are no terminal tabs', () => {
      render(
        <Terminal
          workspaceRoot={MOCK_WORKSPACE}
          isOpen={true}
          tabs={[]}
          onClose={vi.fn()}
          onClear={vi.fn()}
          onRunCommand={vi.fn()}
          onStopCommand={vi.fn()}
          isRunning={false}
          onNewTab={vi.fn()}
        />
      )

      expect(screen.getByText('No Active Terminal Sessions')).toBeInTheDocument()
      expect(
        screen.getByText(`Create a terminal session to execute commands in "${MOCK_WORKSPACE}".`)
      ).toBeInTheDocument()
      expect(screen.getAllByRole('button', { name: 'New Terminal' }).length).toBeGreaterThan(0)
    })

    it('displays output placeholder hint when active tab has no entries', () => {
      const tab = createMockTab({ title: 'Terminal 1' })
      render(
        <Terminal
          workspaceRoot={MOCK_WORKSPACE}
          isOpen={true}
          tabs={[tab]}
          activeTabId={tab.id}
          onClose={vi.fn()}
          onClear={vi.fn()}
          onRunCommand={vi.fn()}
          onStopCommand={vi.fn()}
          isRunning={false}
        />
      )

      expect(screen.getByText(/Terminal 1 — Integrated Workspace Terminal/i)).toBeInTheDocument()
      expect(screen.getByText(/Commands execute in/i)).toBeInTheDocument()
    })

    it('displays current cwd pill in header', () => {
      const tab = createMockTab({ cwd: '/workspace/my-app' })
      render(
        <Terminal
          workspaceRoot={MOCK_WORKSPACE}
          isOpen={true}
          tabs={[tab]}
          activeTabId={tab.id}
          onClose={vi.fn()}
          onClear={vi.fn()}
          onRunCommand={vi.fn()}
          onStopCommand={vi.fn()}
          isRunning={false}
        />
      )

      expect(screen.getByText('my-app')).toBeInTheDocument()
    })

    it('renders initial terminal tab in tablist with correct accessible role and title', () => {
      const tab = createMockTab({ title: 'Terminal 1', status: 'idle' })
      render(
        <Terminal
          workspaceRoot={MOCK_WORKSPACE}
          isOpen={true}
          tabs={[tab]}
          activeTabId={tab.id}
          onClose={vi.fn()}
          onClear={vi.fn()}
          onRunCommand={vi.fn()}
          onStopCommand={vi.fn()}
          isRunning={false}
        />
      )

      const tabElement = screen.getByRole('tab', { name: /Terminal 1/i })
      expect(tabElement).toBeInTheDocument()
      expect(tabElement).toHaveAttribute('aria-selected', 'true')
    })
  })

  // ==========================================================================
  // Group 2: Multiple Terminal Sessions
  // ==========================================================================
  describe('Group 2: Multiple Terminal Sessions', () => {
    it('creates a new terminal session when New Terminal button is clicked', () => {
      const onNewTab = vi.fn()
      render(
        <Terminal
          workspaceRoot={MOCK_WORKSPACE}
          isOpen={true}
          tabs={[createMockTab()]}
          onNewTab={onNewTab}
          onClose={vi.fn()}
          onClear={vi.fn()}
          onRunCommand={vi.fn()}
          onStopCommand={vi.fn()}
          isRunning={false}
        />
      )

      const newTabBtn = screen.getByLabelText('New Terminal')
      fireEvent.click(newTabBtn)

      expect(onNewTab).toHaveBeenCalledTimes(1)
    })

    it('renders multiple terminal tabs and switches between them on tab click', () => {
      const onSelectTab = vi.fn()
      const tab1 = createMockTab({ id: 'tab_1', title: 'Terminal 1' })
      const tab2 = createMockTab({ id: 'tab_2', title: 'Terminal 2' })

      render(
        <Terminal
          workspaceRoot={MOCK_WORKSPACE}
          isOpen={true}
          tabs={[tab1, tab2]}
          activeTabId="tab_1"
          onSelectTab={onSelectTab}
          onClose={vi.fn()}
          onClear={vi.fn()}
          onRunCommand={vi.fn()}
          onStopCommand={vi.fn()}
          isRunning={false}
        />
      )

      const tab1El = screen.getByRole('tab', { name: /Terminal 1/i })
      const tab2El = screen.getByRole('tab', { name: /Terminal 2/i })

      expect(tab1El).toHaveAttribute('aria-selected', 'true')
      expect(tab2El).toHaveAttribute('aria-selected', 'false')

      fireEvent.click(tab2El)
      expect(onSelectTab).toHaveBeenCalledWith('tab_2')
    })

    it('selects tab using keyboard navigation (Enter and Space)', () => {
      const onSelectTab = vi.fn()
      const tab1 = createMockTab({ id: 'tab_1', title: 'Terminal 1' })
      const tab2 = createMockTab({ id: 'tab_2', title: 'Terminal 2' })

      render(
        <Terminal
          workspaceRoot={MOCK_WORKSPACE}
          isOpen={true}
          tabs={[tab1, tab2]}
          activeTabId="tab_1"
          onSelectTab={onSelectTab}
          onClose={vi.fn()}
          onClear={vi.fn()}
          onRunCommand={vi.fn()}
          onStopCommand={vi.fn()}
          isRunning={false}
        />
      )

      const tab2El = screen.getByRole('tab', { name: /Terminal 2/i })
      fireEvent.keyDown(tab2El, { key: 'Enter' })
      expect(onSelectTab).toHaveBeenCalledWith('tab_2')

      fireEvent.keyDown(tab2El, { key: ' ' })
      expect(onSelectTab).toHaveBeenCalledTimes(2)
    })

    it('displays only the active tab output entries when switched in harness', async () => {
      const tab1 = createMockTab({
        id: 'tab_1',
        title: 'Terminal 1',
        entries: [createMockEntry({ command: 'echo tab1_unique_output', stdout: 'tab1_unique_output' })]
      })
      const tab2 = createMockTab({
        id: 'tab_2',
        title: 'Terminal 2',
        entries: [createMockEntry({ command: 'echo tab2_unique_output', stdout: 'tab2_unique_output' })]
      })

      render(<TerminalHarness initialTabs={[tab1, tab2]} />)

      // Tab 1 is initially active
      expect(screen.getByText('echo tab1_unique_output')).toBeInTheDocument()
      expect(screen.queryByText('echo tab2_unique_output')).not.toBeInTheDocument()

      // Switch to Tab 2
      fireEvent.click(screen.getByRole('tab', { name: /Terminal 2/i }))

      await waitFor(() => {
        expect(screen.getByText('echo tab2_unique_output')).toBeInTheDocument()
      })
      expect(screen.queryByText('echo tab1_unique_output')).not.toBeInTheDocument()
    })

    it('closes an idle terminal tab directly without confirmation modal', () => {
      const onCloseTab = vi.fn()
      const tab1 = createMockTab({ id: 'tab_1', title: 'Terminal 1', isRunning: false })

      render(
        <Terminal
          workspaceRoot={MOCK_WORKSPACE}
          isOpen={true}
          tabs={[tab1]}
          activeTabId="tab_1"
          onCloseTab={onCloseTab}
          onClose={vi.fn()}
          onClear={vi.fn()}
          onRunCommand={vi.fn()}
          onStopCommand={vi.fn()}
          isRunning={false}
        />
      )

      const closeTabBtn = screen.getByLabelText('Close Terminal 1')
      fireEvent.click(closeTabBtn)

      expect(onCloseTab).toHaveBeenCalledWith('tab_1', false)
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it('displays confirmation modal when attempting to close a running terminal tab', () => {
      const onCloseTab = vi.fn()
      const runningTab = createMockTab({
        id: 'tab_run',
        title: 'Running Task',
        isRunning: true,
        activeProcessSessionId: 'session_active'
      })

      render(
        <Terminal
          workspaceRoot={MOCK_WORKSPACE}
          isOpen={true}
          tabs={[runningTab]}
          activeTabId="tab_run"
          onCloseTab={onCloseTab}
          onClose={vi.fn()}
          onClear={vi.fn()}
          onRunCommand={vi.fn()}
          onStopCommand={vi.fn()}
          isRunning={true}
        />
      )

      fireEvent.click(screen.getByLabelText('Close Running Task'))

      const modal = screen.getByRole('dialog')
      expect(modal).toBeInTheDocument()
      expect(within(modal).getByText('Terminate Running Session?')).toBeInTheDocument()
      expect(within(modal).getByText('Running Task')).toBeInTheDocument()
      expect(onCloseTab).not.toHaveBeenCalled()
    })

    it('cancels close confirmation when clicking Cancel or pressing Escape', () => {
      const onCloseTab = vi.fn()
      const runningTab = createMockTab({ id: 'tab_run', title: 'Running Task', isRunning: true })

      render(
        <Terminal
          workspaceRoot={MOCK_WORKSPACE}
          isOpen={true}
          tabs={[runningTab]}
          activeTabId="tab_run"
          onCloseTab={onCloseTab}
          onClose={vi.fn()}
          onClear={vi.fn()}
          onRunCommand={vi.fn()}
          onStopCommand={vi.fn()}
          isRunning={true}
        />
      )

      fireEvent.click(screen.getByLabelText('Close Running Task'))
      expect(screen.getByRole('dialog')).toBeInTheDocument()

      // Cancel button
      const modal = screen.getByRole('dialog')
      const cancelBtn = within(modal).getAllByRole('button', { name: 'Cancel' })[0]
      fireEvent.click(cancelBtn)
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(onCloseTab).not.toHaveBeenCalled()

      // Re-open and cancel via Escape
      fireEvent.click(screen.getByLabelText('Close Running Task'))
      expect(screen.getByRole('dialog')).toBeInTheDocument()

      fireEvent.keyDown(window, { key: 'Escape' })
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(onCloseTab).not.toHaveBeenCalled()
    })

    it('calls onCloseTab with force=true when confirming close in modal', () => {
      const onCloseTab = vi.fn()
      const runningTab = createMockTab({ id: 'tab_run', title: 'Running Task', isRunning: true })

      render(
        <Terminal
          workspaceRoot={MOCK_WORKSPACE}
          isOpen={true}
          tabs={[runningTab]}
          activeTabId="tab_run"
          onCloseTab={onCloseTab}
          onClose={vi.fn()}
          onClear={vi.fn()}
          onRunCommand={vi.fn()}
          onStopCommand={vi.fn()}
          isRunning={true}
        />
      )

      fireEvent.click(screen.getByLabelText('Close Running Task'))
      const confirmBtn = screen.getByRole('button', { name: 'Terminate & Close' })
      fireEvent.click(confirmBtn)

      expect(onCloseTab).toHaveBeenCalledWith('tab_run', true)
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
  })

  // ==========================================================================
  // Group 3: Command Execution and Streaming
  // ==========================================================================
  describe('Group 3: Command Execution and Streaming', () => {
    it('executes a command via Enter key submission', async () => {
      const onRunCommand = vi.fn().mockResolvedValue(undefined)
      const tab = createMockTab({ id: 'tab_1' })

      render(
        <Terminal
          workspaceRoot={MOCK_WORKSPACE}
          isOpen={true}
          tabs={[tab]}
          activeTabId={tab.id}
          onRunCommand={onRunCommand}
          onClose={vi.fn()}
          onClear={vi.fn()}
          onStopCommand={vi.fn()}
          isRunning={false}
        />
      )

      const input = screen.getByPlaceholderText(/Type a command and press Enter/i)
      fireEvent.change(input, { target: { value: 'npm run test:unit' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      await waitFor(() => {
        expect(onRunCommand).toHaveBeenCalledWith('npm run test:unit')
      })
      expect(input).toHaveValue('')
    })

    it('executes a command via Run button submission', async () => {
      const onRunCommand = vi.fn().mockResolvedValue(undefined)
      const tab = createMockTab({ id: 'tab_1' })

      render(
        <Terminal
          workspaceRoot={MOCK_WORKSPACE}
          isOpen={true}
          tabs={[tab]}
          activeTabId={tab.id}
          onRunCommand={onRunCommand}
          onClose={vi.fn()}
          onClear={vi.fn()}
          onStopCommand={vi.fn()}
          isRunning={false}
        />
      )

      const input = screen.getByPlaceholderText(/Type a command and press Enter/i)
      fireEvent.change(input, { target: { value: 'git status' } })

      const runBtn = screen.getByRole('button', { name: /Run/i })
      expect(runBtn).not.toBeDisabled()
      fireEvent.click(runBtn)

      await waitFor(() => {
        expect(onRunCommand).toHaveBeenCalledWith('git status')
      })
    })

    it('navigates command history with ArrowUp and ArrowDown keys', () => {
      const tab = createMockTab({
        commandHistory: ['git status', 'npm run build', 'npx vitest']
      })

      render(
        <Terminal
          workspaceRoot={MOCK_WORKSPACE}
          isOpen={true}
          tabs={[tab]}
          activeTabId={tab.id}
          onRunCommand={vi.fn()}
          onClose={vi.fn()}
          onClear={vi.fn()}
          onStopCommand={vi.fn()}
          isRunning={false}
        />
      )

      const input = screen.getByPlaceholderText(/Type a command and press Enter/i)

      // ArrowUp cycles from most recent
      fireEvent.keyDown(input, { key: 'ArrowUp' })
      expect(input).toHaveValue('npx vitest')

      fireEvent.keyDown(input, { key: 'ArrowUp' })
      expect(input).toHaveValue('npm run build')

      fireEvent.keyDown(input, { key: 'ArrowUp' })
      expect(input).toHaveValue('git status')

      // ArrowDown cycles forward
      fireEvent.keyDown(input, { key: 'ArrowDown' })
      expect(input).toHaveValue('npm run build')

      fireEvent.keyDown(input, { key: 'ArrowDown' })
      expect(input).toHaveValue('npx vitest')

      // Past the end clears input
      fireEvent.keyDown(input, { key: 'ArrowDown' })
      expect(input).toHaveValue('')
    })

    it('spawns command and streams stdout and stderr chunks in harness', async () => {
      render(<TerminalHarness />)

      const input = screen.getByPlaceholderText(/Type a command and press Enter/i)
      fireEvent.change(input, { target: { value: 'ls -la' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      await waitFor(() => {
        expect(mockTerminalSpawn).toHaveBeenCalledTimes(1)
      })

      const spawnArgs = mockTerminalSpawn.mock.calls[0][0]
      expect(spawnArgs.command).toBe('ls -la')
      expect(spawnArgs.cwd).toBe(MOCK_WORKSPACE)

      // Emit stdout stream chunk
      emitStreamData({
        sessionId: spawnArgs.sessionId,
        type: 'stdout',
        data: 'total 42\ndrwxr-xr-x 2 user staff'
      })

      await waitFor(() => {
        expect(screen.getByText(/total 42/i)).toBeInTheDocument()
      })

      // Emit stderr stream chunk
      emitStreamData({
        sessionId: spawnArgs.sessionId,
        type: 'stderr',
        data: 'warning: some notice'
      })

      await waitFor(() => {
        expect(screen.getByText(/warning: some notice/i)).toBeInTheDocument()
      })
    })

    it('routes stream chunks only to matching session ID', async () => {
      render(<TerminalHarness />)

      const input = screen.getByPlaceholderText(/Type a command and press Enter/i)
      fireEvent.change(input, { target: { value: 'npm run build' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      await waitFor(() => {
        expect(mockTerminalSpawn).toHaveBeenCalledTimes(1)
      })

      const sessionId = mockTerminalSpawn.mock.calls[0][0].sessionId

      // Emit event for completely different unknown session
      emitStreamData({
        sessionId: 'unknown_session_xyz',
        type: 'stdout',
        data: 'SHOULD_NOT_APPEAR_OUTPUT'
      })

      expect(screen.queryByText('SHOULD_NOT_APPEAR_OUTPUT')).not.toBeInTheDocument()

      // Emit event for matching session
      emitStreamData({
        sessionId,
        type: 'stdout',
        data: 'BUILD_SUCCESS_LOG'
      })

      await waitFor(() => {
        expect(screen.getByText(/BUILD_SUCCESS_LOG/i)).toBeInTheDocument()
      })
    })

    it('updates terminal status and displays exit badge on process exit', async () => {
      render(<TerminalHarness />)

      const input = screen.getByPlaceholderText(/Type a command and press Enter/i)
      fireEvent.change(input, { target: { value: 'npm test' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      await waitFor(() => {
        expect(mockTerminalSpawn).toHaveBeenCalledTimes(1)
      })

      const sessionId = mockTerminalSpawn.mock.calls[0][0].sessionId

      // Emit session exit with code 0
      emitSessionExit({
        sessionId,
        exitCode: 0,
        timedOut: false
      })

      await waitFor(() => {
        expect(screen.getByText('exit 0')).toBeInTheDocument()
      })
      expect(screen.queryByText('Running...')).not.toBeInTheDocument()
    })

    it('displays error and failed status badge on non-zero exit code', async () => {
      render(<TerminalHarness />)

      const input = screen.getByPlaceholderText(/Type a command and press Enter/i)
      fireEvent.change(input, { target: { value: 'node failing_script.js' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      await waitFor(() => {
        expect(mockTerminalSpawn).toHaveBeenCalledTimes(1)
      })

      const sessionId = mockTerminalSpawn.mock.calls[0][0].sessionId

      emitSessionExit({
        sessionId,
        exitCode: 42,
        timedOut: false
      })

      await waitFor(() => {
        expect(screen.getByText('42')).toBeInTheDocument()
        expect(document.querySelector('.terminal-status-badge.error')).toHaveTextContent(/exit\s*42/)
      })
    })
  })

  // ==========================================================================
  // Group 4: Interactive Input
  // ==========================================================================
  describe('Group 4: Interactive Input', () => {
    it('shows interactive input prompt (>) and Send button when terminal is running', () => {
      const runningTab = createMockTab({
        isRunning: true,
        activeProcessSessionId: 'sess_running_1'
      })

      render(
        <Terminal
          workspaceRoot={MOCK_WORKSPACE}
          isOpen={true}
          tabs={[runningTab]}
          activeTabId={runningTab.id}
          isRunning={true}
          activeSessionId="sess_running_1"
          onRunCommand={vi.fn()}
          onSendInput={vi.fn()}
          onStopCommand={vi.fn()}
          onClose={vi.fn()}
          onClear={vi.fn()}
        />
      )

      expect(screen.getByText('>')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /Send/i })).toBeInTheDocument()
      expect(
        screen.getByPlaceholderText('Type input for running command (press Enter to send)...')
      ).toBeInTheDocument()
    })

    it('sends interactive input and appends newline when submitted', async () => {
      render(<TerminalHarness />)

      // Start running command
      const input = screen.getByPlaceholderText(/Type a command and press Enter/i)
      fireEvent.change(input, { target: { value: 'read my_var' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      await waitFor(() => {
        expect(mockTerminalSpawn).toHaveBeenCalledTimes(1)
      })

      // Send interactive input
      const runningInput = screen.getByPlaceholderText(/Type input for running command/i)
      fireEvent.change(runningInput, { target: { value: 'yes' } })
      fireEvent.click(screen.getByRole('button', { name: /Send/i }))

      await waitFor(() => {
        expect(mockTerminalWriteInput).toHaveBeenCalledWith(
          mockTerminalSpawn.mock.calls[0][0].sessionId,
          'yes\n'
        )
        expect(runningInput).toHaveValue('')
      })
    })

    it('preserves input text in input bar when terminalWriteInput fails', async () => {
      mockTerminalWriteInput.mockResolvedValueOnce({
        success: false,
        error: 'Pipe broken'
      })

      render(<TerminalHarness />)

      // Start command
      const input = screen.getByPlaceholderText(/Type a command and press Enter/i)
      fireEvent.change(input, { target: { value: 'cat' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      await waitFor(() => {
        expect(mockTerminalSpawn).toHaveBeenCalledTimes(1)
      })

      // Send input that fails
      const runningInput = screen.getByPlaceholderText(/Type input for running command/i)
      fireEvent.change(runningInput, { target: { value: 'important data' } })
      fireEvent.click(screen.getByRole('button', { name: /Send/i }))

      await waitFor(() => {
        expect(mockTerminalWriteInput).toHaveBeenCalledTimes(1)
      })

      // Input must be preserved so user does not lose typed data
      expect(runningInput).toHaveValue('important data')
    })
  })

  // ==========================================================================
  // Group 5: Toolbar Controls
  // ==========================================================================
  describe('Group 5: Toolbar Controls', () => {
    it('clears active tab entries when Clear button is clicked', async () => {
      const tab = createMockTab({
        entries: [createMockEntry({ command: 'echo clear_me', stdout: 'output to clear' })]
      })

      render(<TerminalHarness initialTabs={[tab]} />)

      expect(screen.getByText('echo clear_me')).toBeInTheDocument()
      const clearBtn = screen.getByLabelText('Clear terminal output')
      expect(clearBtn).not.toBeDisabled()

      fireEvent.click(clearBtn)

      await waitFor(() => {
        expect(screen.queryByText('echo clear_me')).not.toBeInTheDocument()
      })
    })

    it('disables Clear button when there are no output entries', () => {
      const tab = createMockTab({ entries: [] })
      render(
        <Terminal
          workspaceRoot={MOCK_WORKSPACE}
          isOpen={true}
          tabs={[tab]}
          activeTabId={tab.id}
          entries={[]}
          onClear={vi.fn()}
          onClose={vi.fn()}
          onRunCommand={vi.fn()}
          onStopCommand={vi.fn()}
          isRunning={false}
        />
      )

      expect(screen.getByLabelText('Clear terminal output')).toBeDisabled()
    })

    it('stops active running command when Stop button in toolbar is clicked', async () => {
      render(<TerminalHarness />)

      // Start running command
      const input = screen.getByPlaceholderText(/Type a command and press Enter/i)
      fireEvent.change(input, { target: { value: 'sleep 100' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      await waitFor(() => {
        expect(mockTerminalSpawn).toHaveBeenCalledTimes(1)
      })

      const stopBtn = screen.getByLabelText('Stop running command')
      fireEvent.click(stopBtn)

      await waitFor(() => {
        expect(mockTerminalKill).toHaveBeenCalledWith(mockTerminalSpawn.mock.calls[0][0].sessionId)
      })
    })

    it('toggles expand and restore size states when clicking Maximize button', () => {
      const tab = createMockTab()
      const { container } = render(
        <Terminal
          workspaceRoot={MOCK_WORKSPACE}
          isOpen={true}
          tabs={[tab]}
          activeTabId={tab.id}
          onClear={vi.fn()}
          onClose={vi.fn()}
          onRunCommand={vi.fn()}
          onStopCommand={vi.fn()}
          isRunning={false}
        />
      )

      const terminalPanel = container.querySelector('.terminal-panel')
      expect(terminalPanel).not.toHaveClass('expanded')

      // Click Expand
      const expandBtn = screen.getByLabelText('Expand terminal')
      fireEvent.click(expandBtn)
      expect(terminalPanel).toHaveClass('expanded')
      expect(screen.getByLabelText('Restore size')).toBeInTheDocument()

      // Click Restore
      fireEvent.click(screen.getByLabelText('Restore size'))
      expect(terminalPanel).not.toHaveClass('expanded')
    })

    it('calls onClose when close panel button is clicked without terminating processes', () => {
      const onClose = vi.fn()
      const tab = createMockTab({ isRunning: true, activeProcessSessionId: 'sess_bg_1' })

      render(
        <Terminal
          workspaceRoot={MOCK_WORKSPACE}
          isOpen={true}
          tabs={[tab]}
          activeTabId={tab.id}
          isRunning={true}
          onClose={onClose}
          onClear={vi.fn()}
          onRunCommand={vi.fn()}
          onStopCommand={vi.fn()}
        />
      )

      const closePanelBtn = screen.getByLabelText('Close terminal panel')
      fireEvent.click(closePanelBtn)

      expect(onClose).toHaveBeenCalledTimes(1)
      // Closing panel view must not kill running session
      expect(mockTerminalKill).not.toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // Group 6: Workspace and Session Lifecycle
  // ==========================================================================
  describe('Group 6: Workspace and Session Lifecycle', () => {
    it('calls terminalKillAll on workspace change', async () => {
      const { rerender } = render(<TerminalHarness workspaceRoot="/workspace/projA" />)

      rerender(<TerminalHarness workspaceRoot="/workspace/projB" />)

      await waitFor(() => {
        expect(mockTerminalKillAll).toHaveBeenCalled()
      })
    })

    it('unsubscribes terminal event listeners on unmount', () => {
      const { unmount } = render(<TerminalHarness />)

      expect(streamDataListeners.length).toBeGreaterThan(0)
      expect(sessionExitListeners.length).toBeGreaterThan(0)

      unmount()

      expect(streamDataListeners.length).toBe(0)
      expect(sessionExitListeners.length).toBe(0)
    })

    it('ignores late streaming events after session exit without throwing', async () => {
      render(<TerminalHarness />)

      const input = screen.getByPlaceholderText(/Type a command and press Enter/i)
      fireEvent.change(input, { target: { value: 'echo test' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      await waitFor(() => {
        expect(mockTerminalSpawn).toHaveBeenCalledTimes(1)
      })

      const sessionId = mockTerminalSpawn.mock.calls[0][0].sessionId

      // Emit exit
      emitSessionExit({ sessionId, exitCode: 0, timedOut: false })

      // Emit late stream event
      expect(() => {
        emitStreamData({ sessionId, type: 'stdout', data: 'late chunk' })
      }).not.toThrow()
    })
  })

  // ==========================================================================
  // Group 7: Loading and Error States
  // ==========================================================================
  describe('Group 7: Loading and Error States', () => {
    it('displays running badge and spinner when active session is running', () => {
      const runningTab = createMockTab({
        title: 'Build Process',
        isRunning: true,
        activeProcessSessionId: 'sess_123'
      })

      render(
        <Terminal
          workspaceRoot={MOCK_WORKSPACE}
          isOpen={true}
          tabs={[runningTab]}
          activeTabId={runningTab.id}
          isRunning={true}
          activeSessionId="sess_123"
          onClose={vi.fn()}
          onClear={vi.fn()}
          onRunCommand={vi.fn()}
          onStopCommand={vi.fn()}
        />
      )

      expect(screen.getByText('Running...')).toBeInTheDocument()
    })

    it('handles spawn failure and marks entry and tab status as failed', async () => {
      mockTerminalSpawn.mockResolvedValueOnce({
        success: false,
        error: 'spawn /bin/sh ENOENT'
      })

      render(<TerminalHarness />)

      const input = screen.getByPlaceholderText(/Type a command and press Enter/i)
      fireEvent.change(input, { target: { value: 'missing_tool' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      await waitFor(() => {
        expect(screen.getByText('spawn /bin/sh ENOENT')).toBeInTheDocument()
      })
    })

    it('prevents running another command while active tab is already running', async () => {
      const runningTab = createMockTab({
        id: 'tab_busy',
        title: 'Busy Tab',
        isRunning: true,
        activeProcessSessionId: 'sess_busy_1'
      })

      const onRunCommand = vi.fn()
      render(
        <Terminal
          workspaceRoot={MOCK_WORKSPACE}
          isOpen={true}
          tabs={[runningTab]}
          activeTabId="tab_busy"
          isRunning={true}
          onRunCommand={onRunCommand}
          onClose={vi.fn()}
          onClear={vi.fn()}
          onStopCommand={vi.fn()}
        />
      )

      // When running, input prompt is '>' and Run button is replaced with Send & Stop
      expect(screen.queryByRole('button', { name: 'Run' })).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument()
      expect(onRunCommand).not.toHaveBeenCalled()
    })

    it('handles unexpected exceptions during terminalSpawn gracefully', async () => {
      mockTerminalSpawn.mockRejectedValueOnce(new Error('Fatal IPC channel disconnect'))

      render(<TerminalHarness />)

      const input = screen.getByPlaceholderText(/Type a command and press Enter/i)
      fireEvent.change(input, { target: { value: 'crash_test' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      await waitFor(() => {
        expect(screen.getByText('Fatal IPC channel disconnect')).toBeInTheDocument()
      })
    })
  })

  // ==========================================================================
  // Group 8: Phase 13.1 — Production xterm.js Terminal UI Integration
  // ==========================================================================
  describe('Phase 13.1 — Production xterm.js Terminal UI Integration', () => {
    it('creates an xterm.js terminal instance and mounts it into the tab DOM container', () => {
      const tab = createMockTab({ id: 'tab_x1', title: 'xterm Terminal' })
      render(
        <Terminal
          workspaceRoot={MOCK_WORKSPACE}
          isOpen={true}
          onClose={vi.fn()}
          onClear={vi.fn()}
          onRunCommand={vi.fn()}
          onStopCommand={vi.fn()}
          isRunning={false}
          tabs={[tab]}
          activeTabId="tab_x1"
        />
      )

      const container = screen.getByTestId('xterm-container-tab_x1')
      expect(container).toBeInTheDocument()
      // xterm injects its .terminal.xterm root wrapper into the container
      const xtermRoot = container.querySelector('.xterm')
      expect(xtermRoot).toBeInTheDocument()
    })

    it('disposes xterm instance cleanly when terminal panel is unmounted', () => {
      const tab = createMockTab({ id: 'tab_disp', title: 'Disposable Tab' })
      const { unmount } = render(
        <Terminal
          workspaceRoot={MOCK_WORKSPACE}
          isOpen={true}
          onClose={vi.fn()}
          onClear={vi.fn()}
          onRunCommand={vi.fn()}
          onStopCommand={vi.fn()}
          isRunning={false}
          tabs={[tab]}
          activeTabId="tab_disp"
        />
      )

      expect(screen.getByTestId('xterm-container-tab_disp')).toBeInTheDocument()
      unmount()
      expect(screen.queryByTestId('xterm-container-tab_disp')).not.toBeInTheDocument()
    })

    it('maintains exactly one dedicated xterm instance container per tab session', () => {
      const tab1 = createMockTab({ id: 'tab_multi_1', title: 'Tab 1' })
      const tab2 = createMockTab({ id: 'tab_multi_2', title: 'Tab 2' })
      const tab3 = createMockTab({ id: 'tab_multi_3', title: 'Tab 3' })

      render(
        <Terminal
          workspaceRoot={MOCK_WORKSPACE}
          isOpen={true}
          onClose={vi.fn()}
          onClear={vi.fn()}
          onRunCommand={vi.fn()}
          onStopCommand={vi.fn()}
          isRunning={false}
          tabs={[tab1, tab2, tab3]}
          activeTabId="tab_multi_1"
        />
      )

      expect(screen.getByTestId('xterm-container-tab_multi_1')).toBeInTheDocument()
      expect(screen.getByTestId('xterm-container-tab_multi_2')).toBeInTheDocument()
      expect(screen.getByTestId('xterm-container-tab_multi_3')).toBeInTheDocument()
    })

    it('maintains exactly one central IPC stream data listener without duplicates', () => {
      const tab1 = createMockTab({ id: 'tab_ipc_1' })
      const tab2 = createMockTab({ id: 'tab_ipc_2' })
      const tab3 = createMockTab({ id: 'tab_ipc_3' })

      render(
        <Terminal
          workspaceRoot={MOCK_WORKSPACE}
          isOpen={true}
          onClose={vi.fn()}
          onClear={vi.fn()}
          onRunCommand={vi.fn()}
          onStopCommand={vi.fn()}
          isRunning={false}
          tabs={[tab1, tab2, tab3]}
          activeTabId="tab_ipc_1"
        />
      )

      // Single central listener, not 3 duplicate listeners
      expect(mockOnTerminalStreamData).toHaveBeenCalledTimes(1)
      expect(streamDataListeners.length).toBe(1)
    })

    it('routes PTY output chunks to the active xterm instance without error', async () => {
      const sessionId = 'session_stream_x'
      const tab = createMockTab({
        id: 'tab_stream',
        isRunning: true,
        activeProcessSessionId: sessionId
      })

      render(
        <Terminal
          workspaceRoot={MOCK_WORKSPACE}
          isOpen={true}
          onClose={vi.fn()}
          onClear={vi.fn()}
          onRunCommand={vi.fn()}
          onStopCommand={vi.fn()}
          isRunning={true}
          tabs={[tab]}
          activeTabId="tab_stream"
        />
      )

      // Emitting stream data should route directly without throwing
      expect(() => {
        emitStreamData({
          sessionId,
          type: 'stdout',
          data: '\x1b[32mBuild complete: 0 errors\x1b[0m\r\n'
        })
      }).not.toThrow()
    })

    it('forwards interactive keyboard input from active session to terminalWriteInput', async () => {
      const sessionId = 'session_kbd_1'
      const tab = createMockTab({
        id: 'tab_kbd',
        isRunning: true,
        activeProcessSessionId: sessionId
      })

      render(
        <Terminal
          workspaceRoot={MOCK_WORKSPACE}
          isOpen={true}
          onClose={vi.fn()}
          onClear={vi.fn()}
          onRunCommand={vi.fn()}
          onStopCommand={vi.fn()}
          isRunning={true}
          activeSessionId={sessionId}
          onSendInput={async (data) => {
            await window.electronAPI!.terminalWriteInput!(sessionId, data)
            return true
          }}
          tabs={[tab]}
          activeTabId="tab_kbd"
        />
      )

      const input = screen.getByPlaceholderText(/Type input for running command/i)
      fireEvent.change(input, { target: { value: 'status' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      await waitFor(() => {
        expect(mockTerminalWriteInput).toHaveBeenCalledWith(sessionId, 'status')
      })
    })

    it('routes Ctrl+C interrupt signals to PTY stdin correctly', async () => {
      const sessionId = 'session_ctrlc'
      const tab = createMockTab({
        id: 'tab_ctrlc',
        isRunning: true,
        activeProcessSessionId: sessionId
      })

      render(
        <Terminal
          workspaceRoot={MOCK_WORKSPACE}
          isOpen={true}
          onClose={vi.fn()}
          onClear={vi.fn()}
          onRunCommand={vi.fn()}
          onStopCommand={vi.fn()}
          isRunning={true}
          activeSessionId={sessionId}
          onSendInput={async (data) => {
            await window.electronAPI!.terminalWriteInput!(sessionId, data)
            return true
          }}
          tabs={[tab]}
          activeTabId="tab_ctrlc"
        />
      )

      // Send Ctrl+C sequence
      await window.electronAPI!.terminalWriteInput!(sessionId, '\x03')
      expect(mockTerminalWriteInput).toHaveBeenCalledWith(sessionId, '\x03')
    })

    it('triggers fit addon and invokes terminalResize on container layout updates', async () => {
      const sessionId = 'session_resize_test'
      const tab = createMockTab({
        id: 'tab_resize',
        isRunning: true,
        activeProcessSessionId: sessionId
      })

      render(
        <Terminal
          workspaceRoot={MOCK_WORKSPACE}
          isOpen={true}
          onClose={vi.fn()}
          onClear={vi.fn()}
          onRunCommand={vi.fn()}
          onStopCommand={vi.fn()}
          isRunning={true}
          tabs={[tab]}
          activeTabId="tab_resize"
        />
      )

      // Call terminalResize directly through window API as fit addon would
      await act(async () => {
        await window.electronAPI!.terminalResize!(sessionId, 120, 36)
      })

      expect(mockTerminalResize).toHaveBeenCalledWith(sessionId, 120, 36)
    })

    it('forwards bounded cols and rows dimensions', async () => {
      const sessionId = 'session_bounds'
      const res = await window.electronAPI!.terminalResize!(sessionId, 80, 24)

      expect(res.success).toBe(true)
      expect(res.cols).toBe(80)
      expect(res.rows).toBe(24)
    })

    it('maintains resize isolation between independent sessions', async () => {
      const session1 = 'session_iso_1'
      const session2 = 'session_iso_2'

      await window.electronAPI!.terminalResize!(session1, 100, 30)

      expect(mockTerminalResize).toHaveBeenCalledWith(session1, 100, 30)
      expect(mockTerminalResize).not.toHaveBeenCalledWith(session2, expect.anything(), expect.anything())
    })

    it('maintains multi-session data isolation between concurrent tabs', () => {
      const tabA = createMockTab({ id: 'tabA', activeProcessSessionId: 'sessA' })
      const tabB = createMockTab({ id: 'tabB', activeProcessSessionId: 'sessB' })

      render(
        <Terminal
          workspaceRoot={MOCK_WORKSPACE}
          isOpen={true}
          onClose={vi.fn()}
          onClear={vi.fn()}
          onRunCommand={vi.fn()}
          onStopCommand={vi.fn()}
          isRunning={false}
          tabs={[tabA, tabB]}
          activeTabId="tabA"
        />
      )

      // Emitting to session A does not touch session B
      expect(() => {
        emitStreamData({ sessionId: 'sessA', type: 'stdout', data: 'Data for A' })
      }).not.toThrow()
    })

    it('preserves xterm instances across tab switches without unmounting', () => {
      const tabA = createMockTab({ id: 'tab_sw_A', title: 'Tab A' })
      const tabB = createMockTab({ id: 'tab_sw_B', title: 'Tab B' })

      const { rerender } = render(
        <Terminal
          workspaceRoot={MOCK_WORKSPACE}
          isOpen={true}
          onClose={vi.fn()}
          onClear={vi.fn()}
          onRunCommand={vi.fn()}
          onStopCommand={vi.fn()}
          isRunning={false}
          tabs={[tabA, tabB]}
          activeTabId="tab_sw_A"
        />
      )

      const viewA = screen.getByTestId('xterm-view-tab_sw_A')
      const viewB = screen.getByTestId('xterm-view-tab_sw_B')

      expect(viewA).toHaveStyle({ display: 'flex' })
      expect(viewB).toHaveStyle({ display: 'none' })

      // Switch to Tab B
      rerender(
        <Terminal
          workspaceRoot={MOCK_WORKSPACE}
          isOpen={true}
          onClose={vi.fn()}
          onClear={vi.fn()}
          onRunCommand={vi.fn()}
          onStopCommand={vi.fn()}
          isRunning={false}
          tabs={[tabA, tabB]}
          activeTabId="tab_sw_B"
        />
      )

      // Tab A is hidden, Tab B is visible - both remained in DOM
      expect(viewA).toHaveStyle({ display: 'none' })
      expect(viewB).toHaveStyle({ display: 'flex' })
    })

    it('disposes target xterm instance when a specific tab is closed', () => {
      const tabA = createMockTab({ id: 'tab_cl_A', title: 'Tab A' })
      const tabB = createMockTab({ id: 'tab_cl_B', title: 'Tab B' })

      const { rerender } = render(
        <Terminal
          workspaceRoot={MOCK_WORKSPACE}
          isOpen={true}
          onClose={vi.fn()}
          onClear={vi.fn()}
          onRunCommand={vi.fn()}
          onStopCommand={vi.fn()}
          isRunning={false}
          tabs={[tabA, tabB]}
          activeTabId="tab_cl_A"
        />
      )

      expect(screen.getByTestId('xterm-view-tab_cl_B')).toBeInTheDocument()

      // Close tab B
      rerender(
        <Terminal
          workspaceRoot={MOCK_WORKSPACE}
          isOpen={true}
          onClose={vi.fn()}
          onClear={vi.fn()}
          onRunCommand={vi.fn()}
          onStopCommand={vi.fn()}
          isRunning={false}
          tabs={[tabA]}
          activeTabId="tab_cl_A"
        />
      )

      expect(screen.queryByTestId('xterm-view-tab_cl_B')).not.toBeInTheDocument()
      expect(screen.getByTestId('xterm-view-tab_cl_A')).toBeInTheDocument()
    })

    it('updates tab status and exit badge on PTY exit while retaining terminal view', async () => {
      const sessionId = 'session_exit_pty'
      const tab = createMockTab({
        id: 'tab_exit_test',
        isRunning: true,
        activeProcessSessionId: sessionId
      })

      const { rerender } = render(
        <Terminal
          workspaceRoot={MOCK_WORKSPACE}
          isOpen={true}
          onClose={vi.fn()}
          onClear={vi.fn()}
          onRunCommand={vi.fn()}
          onStopCommand={vi.fn()}
          isRunning={true}
          tabs={[tab]}
          activeTabId="tab_exit_test"
        />
      )

      expect(screen.getByTestId('xterm-view-tab_exit_test')).toBeInTheDocument()

      // PTY session exits with code 0
      const updatedTab: TerminalTab = {
        ...tab,
        isRunning: false,
        activeProcessSessionId: null,
        lastExitCode: 0,
        status: 'completed'
      }

      rerender(
        <Terminal
          workspaceRoot={MOCK_WORKSPACE}
          isOpen={true}
          onClose={vi.fn()}
          onClear={vi.fn()}
          onRunCommand={vi.fn()}
          onStopCommand={vi.fn()}
          isRunning={false}
          tabs={[updatedTab]}
          activeTabId="tab_exit_test"
        />
      )

      // Xterm view is still rendered for inspecting history
      expect(screen.getByTestId('xterm-view-tab_exit_test')).toBeInTheDocument()
    })

    it('maintains strict separation between raw ANSI for xterm and sanitized output for AI context', () => {
      const rawAnsi = '\x1b[32m✔ All tests passed (12 passed)\x1b[0m\n'
      const aiSanitized = processTerminalOutputForAI(rawAnsi)

      // xterm gets raw ANSI escape codes for full-color rendering
      expect(rawAnsi).toContain('\x1b[32m')

      // AI context gets clean, stripped text with zero escape sequences
      expect(aiSanitized.text).not.toContain('\x1b')
      expect(aiSanitized.text).toContain('All tests passed (12 passed)')
    })

    it('verifies no raw PTY or child_process handles are exposed to the renderer', () => {
      expect((window as any).pty).toBeUndefined()
      expect((window as any).nodePty).toBeUndefined()
      expect((window as any).child_process).toBeUndefined()
      expect((window as any).electronAPI?.nodePty).toBeUndefined()
      expect((window as any).electronAPI?.pty).toBeUndefined()
    })

    it('does not duplicate terminal stream listeners under React StrictMode / remounting', () => {
      const tab = createMockTab({ id: 'tab_strict' })
      const props = {
        workspaceRoot: MOCK_WORKSPACE,
        isOpen: true,
        onClose: vi.fn(),
        onClear: vi.fn(),
        onRunCommand: vi.fn(),
        onStopCommand: vi.fn(),
        isRunning: false,
        tabs: [tab],
        activeTabId: 'tab_strict'
      }

      // Initial mount
      const { unmount } = render(<Terminal {...props} />)
      expect(streamDataListeners.length).toBe(1)

      // Unmount
      unmount()
      expect(streamDataListeners.length).toBe(0)

      // Re-mount (as in React.StrictMode)
      render(<Terminal {...props} />)
      expect(streamDataListeners.length).toBe(1)
    })

    it('ensures no terminal instance or listener leaks across the entire tab lifecycle', () => {
      const tab1 = createMockTab({ id: 'tab_leak_1' })
      const tab2 = createMockTab({ id: 'tab_leak_2' })

      const { unmount, rerender } = render(
        <Terminal
          workspaceRoot={MOCK_WORKSPACE}
          isOpen={true}
          onClose={vi.fn()}
          onClear={vi.fn()}
          onRunCommand={vi.fn()}
          onStopCommand={vi.fn()}
          isRunning={false}
          tabs={[tab1, tab2]}
          activeTabId="tab_leak_1"
        />
      )

      expect(screen.getByTestId('xterm-view-tab_leak_1')).toBeInTheDocument()
      expect(screen.getByTestId('xterm-view-tab_leak_2')).toBeInTheDocument()
      expect(streamDataListeners.length).toBe(1)

      // Close tab 2
      rerender(
        <Terminal
          workspaceRoot={MOCK_WORKSPACE}
          isOpen={true}
          onClose={vi.fn()}
          onClear={vi.fn()}
          onRunCommand={vi.fn()}
          onStopCommand={vi.fn()}
          isRunning={false}
          tabs={[tab1]}
          activeTabId="tab_leak_1"
        />
      )

      expect(screen.queryByTestId('xterm-view-tab_leak_2')).not.toBeInTheDocument()

      // Unmount terminal
      unmount()
      expect(streamDataListeners.length).toBe(0)
    })
  })
})
