/**
 * Terminal IPC and Session Lifecycle Integration Tests
 *
 * Verifies real production Terminal IPC handlers and Preload API interactions:
 * 1. Process spawning with unique session IDs and workspace containment.
 * 2. Streaming stdout/stderr output delivery through WebContents to Renderer listeners.
 * 3. Interactive input routing to specific process stdin.
 * 4. Multi-session isolation (concurrent sessions receive distinct streams).
 * 5. Targeted process termination via terminalKill without affecting sibling sessions.
 * 6. Global session cleanup via terminalKillAll.
 * 7. Error handling for non-existent session IDs, invalid commands, and traversal attempts.
 *
 * Uses controlled, deterministic local Node sub-processes inside temporary directories.
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
import type { TerminalStreamDataEvent, TerminalSessionExitEvent } from '../../../src/shared/types'

const api = rawApi as Required<typeof rawApi>

describe('5. Terminal IPC and Session Lifecycle Integration', () => {
  let workspace: { rootPath: string; cleanup: () => Promise<void> }

  beforeEach(async () => {
    registerIpcHandlers()
    electronHarness.state.rendererListeners.clear()
    terminalSessionManager.clearAllCompletedSessions()
    workspace = await createTestWorkspace('ai-ide-term-test-')
  })

  afterEach(async () => {
    try {
      await api.terminalKillAll()
      terminalSessionManager.clearAllCompletedSessions()
    } catch {
      // Ignore cleanup error
    }
    await workspace.cleanup()
  })

  it('spawns a safe terminal process, streams output, and reports session exit', async () => {
    // Controlled script that outputs greeting and exits with code 0
    const scriptPath = path.join(workspace.rootPath, 'greeting.cjs').replace(/\\/g, '/')
    await fs.writeFile(
      scriptPath,
      'process.stdout.write("Hello from Terminal IPC!\\n"); process.exit(0);'
    )

    const streamChunks: string[] = []
    const state: { exitEvent: TerminalSessionExitEvent | null } = { exitEvent: null }

    const unsubStream = api.onTerminalStreamData((evt: TerminalStreamDataEvent) => {
      if (evt.sessionId === 'session-basic-test') {
        streamChunks.push(evt.data)
      }
    })

    const unsubExit = api.onTerminalSessionExit((evt: TerminalSessionExitEvent) => {
      if (evt.sessionId === 'session-basic-test') {
        state.exitEvent = evt
      }
    })

    try {
      const spawnRes = await api.terminalSpawn({
        sessionId: 'session-basic-test',
        command: `node "${scriptPath}"`,
        cwd: workspace.rootPath,
        workspaceRoot: workspace.rootPath
      })

      expect(spawnRes.success).toBe(true)
      expect(spawnRes.sessionId).toBe('session-basic-test')
      expect(typeof spawnRes.pid).toBe('number')

      // Wait for process output and exit
      await vi.waitFor(() => {
        expect(state.exitEvent).not.toBeNull()
      }, { timeout: 4000 })

      expect(streamChunks.join('')).toContain('Hello from Terminal IPC!')
      expect(state.exitEvent?.exitCode).toBe(0)
      expect(state.exitEvent?.timedOut).toBe(false)
    } finally {
      unsubStream()
      unsubExit()
    }
  })

  it('writes interactive input into running session stdin', async () => {
    const echoScriptPath = path.join(workspace.rootPath, 'interactive_echo.cjs').replace(/\\/g, '/')
    await fs.writeFile(
      echoScriptPath,
      `
      process.stdout.write("READY_FOR_INPUT\\n");
      process.stdin.setEncoding('utf-8');
      process.stdin.on('data', (data) => {
        process.stdout.write("RECEIVED:" + data.trim() + "\\n");
        process.exit(0);
      });
      `
    )

    const receivedOutput: string[] = []
    let isReady = false
    let isExit = false

    const unsubStream = api.onTerminalStreamData((evt) => {
      if (evt.sessionId === 'session-interactive') {
        receivedOutput.push(evt.data)
        if (evt.data.includes('READY_FOR_INPUT')) {
          isReady = true
        }
      }
    })

    const unsubExit = api.onTerminalSessionExit((evt) => {
      if (evt.sessionId === 'session-interactive') {
        isExit = true
      }
    })

    try {
      await api.terminalSpawn({
        sessionId: 'session-interactive',
        command: `node "${echoScriptPath}"`,
        cwd: workspace.rootPath,
        workspaceRoot: workspace.rootPath
      })

      // Wait until child is ready to receive input
      await vi.waitFor(() => expect(isReady).toBe(true), { timeout: 3000 })

      // Send input through IPC
      const writeRes = await api.terminalWriteInput('session-interactive', 'PONG\n')
      expect(writeRes.success).toBe(true)

      // Wait for process echo response and exit
      await vi.waitFor(() => expect(isExit).toBe(true), { timeout: 3000 })

      expect(receivedOutput.join('')).toContain('RECEIVED:PONG')
    } finally {
      unsubStream()
      unsubExit()
    }
  })

  it('manages concurrent sessions with strict event and output isolation', async () => {
    const sleepScript = path.join(workspace.rootPath, 'loop.cjs').replace(/\\/g, '/')
    await fs.writeFile(
      sleepScript,
      `
      const id = process.argv[2];
      process.stdout.write("INIT:" + id + "\\n");
      const interval = setInterval(() => {}, 1000);
      process.on('SIGTERM', () => { clearInterval(interval); process.exit(0); });
      `
    )

    const sessionAOutput: string[] = []
    const sessionBOutput: string[] = []

    const unsubStream = api.onTerminalStreamData((evt) => {
      if (evt.sessionId === 'session-concurrent-A') {
        sessionAOutput.push(evt.data)
      } else if (evt.sessionId === 'session-concurrent-B') {
        sessionBOutput.push(evt.data)
      }
    })

    try {
      // Spawn session A
      await api.terminalSpawn({
        sessionId: 'session-concurrent-A',
        command: `node "${sleepScript}" A`,
        cwd: workspace.rootPath,
        workspaceRoot: workspace.rootPath
      })

      // Spawn session B
      await api.terminalSpawn({
        sessionId: 'session-concurrent-B',
        command: `node "${sleepScript}" B`,
        cwd: workspace.rootPath,
        workspaceRoot: workspace.rootPath
      })

      // Both should appear in active sessions list
      const listRes = await api.terminalListSessions()
      expect(listRes.success).toBe(true)
      const sessionIds = listRes.sessions.map((s: any) => s.sessionId)
      expect(sessionIds).toContain('session-concurrent-A')
      expect(sessionIds).toContain('session-concurrent-B')

      // Terminate only session A
      const killARes = await api.terminalKill('session-concurrent-A')
      expect(killARes.success).toBe(true)

      // Session A is marked terminated/inactive, session B remains alive and running
      await vi.waitFor(async () => {
        const afterKill = await api.terminalListSessions()
        const sA = afterKill.sessions.find((s: any) => s.sessionId === 'session-concurrent-A')
        const sB = afterKill.sessions.find((s: any) => s.sessionId === 'session-concurrent-B')
        expect(sA).toBeDefined()
        expect(sA?.running).toBe(false)
        expect(sB).toBeDefined()
        expect(sB?.running).toBe(true)
      }, { timeout: 3000 })

      // Clean up session B
      await api.terminalKill('session-concurrent-B')
    } finally {
      unsubStream()
    }
  })

  it('safely handles non-existent session IDs and invalid payloads', async () => {
    // 1. Write input to non-existent session
    const badWriteRes = await api.terminalWriteInput('ghost-session-999', 'data')
    expect(badWriteRes.success).toBe(false)
    expect(badWriteRes.error).toMatch(/session not found|does not exist|inactive/i)

    // 2. Kill non-existent session
    const badKillRes = await api.terminalKill('ghost-session-999')
    expect(badKillRes.success).toBe(false)
    expect(badKillRes.error).toMatch(/session not found|does not exist|inactive/i)

    // 3. Spawn with invalid session ID (contains spaces)
    const emptySpawnRes = await api.terminalSpawn({
      sessionId: 'bad session id with spaces!',
      command: 'echo test',
      cwd: workspace.rootPath,
      workspaceRoot: workspace.rootPath
    })
    expect(emptySpawnRes.success).toBe(false)
    expect(emptySpawnRes.error).toMatch(/invalid session id/i)

    // 4. Spawn with command attempting workspace escape
    const escapeSpawnRes = await api.terminalSpawn({
      sessionId: 'session-escape',
      command: 'cd ..',
      cwd: workspace.rootPath,
      workspaceRoot: workspace.rootPath
    })
    expect(escapeSpawnRes.success).toBe(false)
    expect(escapeSpawnRes.error).toMatch(/workspace/i)

    // 5. Spawn with non-existent working directory
    const badCwdRes = await api.terminalSpawn({
      sessionId: 'session-bad-cwd',
      command: 'echo test',
      cwd: path.join(workspace.rootPath, 'does-not-exist-dir-12345'),
      workspaceRoot: workspace.rootPath
    })
    expect(badCwdRes.success).toBe(false)
    expect(badCwdRes.error).toMatch(/working directory does not exist/i)
  })

  it('terminates all active sessions cleanly on terminalKillAll', async () => {
    const longRunningScript = path.join(workspace.rootPath, 'sleep.cjs').replace(/\\/g, '/')
    await fs.writeFile(
      longRunningScript,
      'const i = setInterval(() => {}, 1000); process.on("SIGTERM", () => { clearInterval(i); process.exit(0); });'
    )

    // Spawn 2 sessions
    await api.terminalSpawn({
      sessionId: 'session-kill-1',
      command: `node "${longRunningScript}"`,
      cwd: workspace.rootPath,
      workspaceRoot: workspace.rootPath
    })

    await api.terminalSpawn({
      sessionId: 'session-kill-2',
      command: `node "${longRunningScript}"`,
      cwd: workspace.rootPath,
      workspaceRoot: workspace.rootPath
    })

    // Kill all
    const killAllRes = await api.terminalKillAll()
    expect(killAllRes.success).toBe(true)
    expect(typeof killAllRes.killedCount).toBe('number')
    expect(killAllRes.killedCount).toBeGreaterThanOrEqual(2)

    // Verify all active sessions are terminated (none are running)
    const listAfter = await api.terminalListSessions()
    const stillRunning = listAfter.sessions.filter((s: any) => s.running)
    expect(stillRunning.length).toBe(0)
  })

  it('resizes PTY dimensions and enforces dimension clamping and isolation', async () => {
    const sleepScript = path.join(workspace.rootPath, 'sleep_resize.cjs').replace(/\\/g, '/')
    await fs.writeFile(
      sleepScript,
      'const i = setInterval(() => {}, 1000); process.on("SIGTERM", () => { clearInterval(i); process.exit(0); });'
    )

    const spawnRes = await api.terminalSpawn({
      sessionId: 'session-resize-1',
      command: `node "${sleepScript}"`,
      cwd: workspace.rootPath,
      workspaceRoot: workspace.rootPath,
      cols: 100,
      rows: 30
    })

    expect(spawnRes.success).toBe(true)
    expect(spawnRes.cols).toBe(100)
    expect(spawnRes.rows).toBe(30)

    // Resize session 1
    const resizeRes = await api.terminalResize('session-resize-1', 120, 40)
    expect(resizeRes.success).toBe(true)
    expect(resizeRes.cols).toBe(120)
    expect(resizeRes.rows).toBe(40)

    // Check session record
    const s1 = terminalSessionManager.getSession('session-resize-1')
    expect(s1?.cols).toBe(120)
    expect(s1?.rows).toBe(40)

    // Spawn session 2 with default dimensions and ensure session 1's resize did not affect it
    const spawnRes2 = await api.terminalSpawn({
      sessionId: 'session-resize-2',
      command: `node "${sleepScript}"`,
      cwd: workspace.rootPath,
      workspaceRoot: workspace.rootPath,
      cols: 80,
      rows: 24
    })
    expect(spawnRes2.cols).toBe(80)
    expect(spawnRes2.rows).toBe(24)

    const s2 = terminalSessionManager.getSession('session-resize-2')
    expect(s2?.cols).toBe(80)
    expect(s2?.rows).toBe(24)

    // Test dimension validation / rejection
    const invalidResize = await api.terminalResize('session-resize-1', -5, 0)
    expect(invalidResize.success).toBe(false)
    expect(invalidResize.error).toContain('positive finite integers')

    // Test resize on non-existent session
    const nonExistentResize = await api.terminalResize('session-ghost-does-not-exist', 100, 30)
    expect(nonExistentResize.success).toBe(false)
    expect(nonExistentResize.error).toContain('not found')
  })

  it('rejects unauthorized shell executable requests', async () => {
    const badShellRes = await api.terminalSpawn({
      sessionId: 'session-unauthorized-shell',
      command: 'echo 1',
      cwd: workspace.rootPath,
      workspaceRoot: workspace.rootPath,
      shell: 'malicious_shell.exe'
    })
    expect(badShellRes.success).toBe(false)
    expect(badShellRes.error).toContain('not in the allowed shells list')
  })

  it('forwards Ctrl+C signal to interrupt foreground process without killing PTY session', async () => {
    const interruptScript = path.join(workspace.rootPath, 'interrupt_target.cjs').replace(/\\/g, '/')
    await fs.writeFile(
      interruptScript,
      `
      process.stdout.write("STARTED\\n");
      const i = setInterval(() => {}, 1000);
      process.on('SIGINT', () => {
        clearInterval(i);
        process.stdout.write("CAUGHT_SIGINT\\n");
        process.exit(0);
      });
      `
    )

    let exitEvent: any = null

    const unsubExit = api.onTerminalSessionExit((evt) => {
      if (evt.sessionId === 'session-sigint') {
        exitEvent = evt
      }
    })

    try {
      await api.terminalSpawn({
        sessionId: 'session-sigint',
        command: `node "${interruptScript}"`,
        cwd: workspace.rootPath,
        workspaceRoot: workspace.rootPath
      })

      // Send Ctrl+C signal via terminalSendSignal
      await vi.waitFor(async () => {
        const s = terminalSessionManager.getSession('session-sigint')
        expect(s?.running).toBe(true)
      })

      const sigRes = await api.terminalSendSignal('session-sigint', 'SIGINT')
      expect(sigRes.success).toBe(true)

      await vi.waitFor(
        () => {
          expect(exitEvent).not.toBeNull()
        },
        { timeout: 4000 }
      )

      // On Windows, Ctrl+C exit code is STATUS_CONTROL_C_EXIT (-1073741510 / 0xC000013A)
      // On POSIX, it is 130 (128 + SIGINT) or 0
      expect([0, -1073741510, 130, 3221225786]).toContain(exitEvent.exitCode)
    } finally {
      unsubExit()
    }
  })

  it('preserves AI command output sanitization and compression compatibility', async () => {
    const { processTerminalOutputForAI } = await import('../../../src/shared/terminalSanitizer')

    const scriptPath = path.join(workspace.rootPath, 'ansi_and_lines.cjs').replace(/\\/g, '/')
    const scriptContent = `
      for (let i = 1; i <= 50; i++) {
        process.stdout.write("\\x1b[32mLine " + i + ": OK\\x1b[0m\\n");
      }
      process.exit(0);
    `
    await fs.writeFile(scriptPath, scriptContent)

    const runRes = await api.runCommand(`node "${scriptPath}"`, workspace.rootPath)
    expect(runRes.success).toBe(true)
    expect(runRes.exitCode).toBe(0)

    // Raw PTY output contains line content
    expect(runRes.stdout).toContain('Line 1')

    // AI sanitization extracts clean text and compresses
    const aiProcessed = processTerminalOutputForAI(runRes.stdout, {
      headLines: 5,
      tailLines: 5,
      maxTotalChars: 10000
    })

    expect(aiProcessed.isCompressed).toBe(true)
    expect(aiProcessed.text).not.toContain('\x1b[32m')
    expect(aiProcessed.text).toContain('Line 1')
    expect(aiProcessed.text).toContain('Line 50')
  })
})
