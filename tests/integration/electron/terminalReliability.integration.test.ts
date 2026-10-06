/**
 * Terminal Reliability & Process Lifecycle Edge Case Integration Tests
 *
 * Verifies robust terminal lifecycle behavior across:
 * 1. Non-zero exit code capture and delivery through WebContents events.
 * 2. Process execution timeout triggering automatic SIGTERM and timedOut flag.
 * 3. Stdin write attempts on terminated or closed sessions.
 * 4. Double kill idempotency without throwing unhandled exceptions.
 * 5. Retention buffer capping (maxBuffer) preventing unbounded memory growth.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import path from 'path'
import fs from 'fs/promises'
import { electronHarness, createTestWorkspace } from './harness'

vi.mock('electron', async () => {
  const { electronHarness } = await import('./harness')
  return {
    app: electronHarness.mockApp,
    BrowserWindow: electronHarness.MockBrowserWindow,
    dialog: electronHarness.mockDialog,
    ipcMain: electronHarness.mockIpcMain,
    ipcRenderer: electronHarness.mockIpcRenderer,
    shell: electronHarness.mockShell,
    session: electronHarness.mockSession,
    contextBridge: electronHarness.mockContextBridge
  }
})

import { registerIpcHandlers, terminalSessionManager } from '../../../src/main/index'
import { api as rawApi } from '../../../src/preload/index'
import type { TerminalSessionExitEvent } from '../../../src/shared/types'

const api = rawApi as Required<typeof rawApi>

describe('Terminal Reliability & Process Lifecycle Edge Cases', () => {
  let workspace: { rootPath: string; cleanup: () => Promise<void> }

  beforeEach(async () => {
    registerIpcHandlers()
    electronHarness.state.rendererListeners.clear()
    terminalSessionManager.clearAllCompletedSessions()
    workspace = await createTestWorkspace('ai-ide-term-rel-')
  })

  afterEach(async () => {
    try {
      await api.terminalKillAll()
      terminalSessionManager.clearAllCompletedSessions()
    } catch {}
    await new Promise((r) => setTimeout(r, 100))
    await workspace.cleanup()
  })

  it('captures non-zero process exit codes and delivers them via exit event', async () => {
    const errorScript = path.join(workspace.rootPath, 'exit_code_42.cjs').replace(/\\/g, '/')
    await fs.writeFile(errorScript, 'process.stderr.write("Critical error occurred\\n"); process.exit(42);')

    let exitEvent: TerminalSessionExitEvent | null = null
    const unsub = api.onTerminalSessionExit((evt) => {
      if (evt.sessionId === 'session-nonzero-exit') {
        exitEvent = evt
      }
    })

    try {
      const spawnRes = await api.terminalSpawn({
        sessionId: 'session-nonzero-exit',
        command: `node "${errorScript}"`,
        cwd: workspace.rootPath,
        workspaceRoot: workspace.rootPath
      })
      expect(spawnRes.success).toBe(true)

      await vi.waitFor(
        () => {
          expect(exitEvent).not.toBeNull()
        },
        { timeout: 4000 }
      )

      const finalExit = exitEvent as TerminalSessionExitEvent | null
      expect(finalExit?.exitCode).toBe(42)
      expect(finalExit?.timedOut).toBe(false)
      expect(finalExit?.stderr).toContain('Critical error occurred')
    } finally {
      unsub()
    }
  })

  it('enforces execution timeout, forcibly terminating long-running processes', async () => {
    const loopScript = path.join(workspace.rootPath, 'infinite_loop.cjs').replace(/\\/g, '/')
    await fs.writeFile(loopScript, 'setInterval(() => {}, 1000);')

    let exitEvent: TerminalSessionExitEvent | null = null
    const unsub = api.onTerminalSessionExit((evt) => {
      if (evt.sessionId === 'session-timeout-test') {
        exitEvent = evt
      }
    })

    try {
      const spawnRes = await api.terminalSpawn({
        sessionId: 'session-timeout-test',
        command: `node "${loopScript}"`,
        cwd: workspace.rootPath,
        workspaceRoot: workspace.rootPath,
        timeoutMs: 400 // Short 400ms timeout
      })
      expect(spawnRes.success).toBe(true)

      // Await automatic termination by timeout
      await vi.waitFor(
        () => {
          expect(exitEvent).not.toBeNull()
          const finalExit = exitEvent as TerminalSessionExitEvent | null
          expect(finalExit?.timedOut).toBe(true)
        },
        { timeout: 4000 }
      )

      const finalExit = exitEvent as TerminalSessionExitEvent | null
      expect(finalExit?.timedOut).toBe(true)

      // Verify session list reflects timedOut status
      const listRes = await api.terminalListSessions()
      const sess = listRes.sessions.find((s) => s.sessionId === 'session-timeout-test')
      expect(sess?.status).toBe('timedOut')
      expect(sess?.running).toBe(false)
    } finally {
      unsub()
    }
  })

  it('rejects stdin write attempts on sessions that have already completed or exited', async () => {
    const quickScript = path.join(workspace.rootPath, 'quick_exit.cjs').replace(/\\/g, '/')
    await fs.writeFile(quickScript, 'process.exit(0);')

    let isDone = false
    const unsub = api.onTerminalSessionExit((evt) => {
      if (evt.sessionId === 'session-quick-exit') {
        isDone = true
      }
    })

    try {
      await api.terminalSpawn({
        sessionId: 'session-quick-exit',
        command: `node "${quickScript}"`,
        cwd: workspace.rootPath,
        workspaceRoot: workspace.rootPath
      })

      await vi.waitFor(() => expect(isDone).toBe(true), { timeout: 3000 })

      // Attempt write after exit
      const writeRes = await api.terminalWriteInput('session-quick-exit', 'should fail')
      expect(writeRes.success).toBe(false)
      expect(writeRes.error).toMatch(/not running or stdin is closed/i)
    } finally {
      unsub()
    }
  })

  it('handles double kill requests idempotently without crashing or erroring', async () => {
    const sleepScript = path.join(workspace.rootPath, 'sleep_quick.cjs').replace(/\\/g, '/')
    await fs.writeFile(sleepScript, 'setInterval(() => {}, 1000);')

    await api.terminalSpawn({
      sessionId: 'session-double-kill',
      command: `node "${sleepScript}"`,
      cwd: workspace.rootPath,
      workspaceRoot: workspace.rootPath
    })

    // First kill
    const kill1 = await api.terminalKill('session-double-kill')
    expect(kill1.success).toBe(true)

    // Second kill on already terminated process
    const kill2 = await api.terminalKill('session-double-kill')
    expect(kill2.success).toBe(true)
    expect(kill2.message).toMatch(/not running/i)
  })

  it('caps retained output buffers to maxBuffer preventing memory leaks', async () => {
    const floodScript = path.join(workspace.rootPath, 'flood_output.cjs').replace(/\\/g, '/')
    // Emits 10,000 characters
    await fs.writeFile(floodScript, 'process.stdout.write("A".repeat(10000)); process.exit(0);')

    const state: { exitEvent: TerminalSessionExitEvent | null } = { exitEvent: null }
    const unsub = api.onTerminalSessionExit((evt) => {
      if (evt.sessionId === 'session-buffer-cap') {
        state.exitEvent = evt
      }
    })

    try {
      await api.terminalSpawn({
        sessionId: 'session-buffer-cap',
        command: `node "${floodScript}"`,
        cwd: workspace.rootPath,
        workspaceRoot: workspace.rootPath,
        maxBuffer: 2048 // Cap to 2048 bytes
      })

      await vi.waitFor(() => expect(state.exitEvent).not.toBeNull(), { timeout: 4000 })

      expect((state.exitEvent?.stdout ?? '').length).toBeLessThanOrEqual(2048)
    } finally {
      unsub()
    }
  })
})
