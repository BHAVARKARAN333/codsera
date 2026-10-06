import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import path from 'path'
import fs from 'fs/promises'
import os from 'os'
import {
  TerminalSessionManager,
  detectDefaultShell,
  resolveSafeShell,
  terminateProcessTree
} from '../../src/main/terminalSessionManager'
import { processTerminalOutputForAI } from '../../src/shared/terminalSanitizer'
import type { TerminalStreamDataEvent, TerminalSessionExitEvent } from '../../src/shared/types'

describe('TerminalSessionManager Unit Tests (Phase 13.0 node-pty Backend)', () => {
  let manager: TerminalSessionManager
  let testDir: string

  beforeEach(async () => {
    manager = new TerminalSessionManager()
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-ide-term-mgr-'))
  })

  afterEach(async () => {
    try {
      await manager.killAllSessions()
      manager.clearAllCompletedSessions()
    } catch {
      // Ignore
    }
    try {
      await fs.rm(testDir, { recursive: true, force: true })
    } catch {
      // Ignore
    }
  })

  // 1. Session ID Generation
  it('1. generates collision-resistant unique session identifiers', () => {
    const id1 = manager.generateSessionId('term')
    const id2 = manager.generateSessionId('term')
    const idAi = manager.generateSessionId('ai')

    expect(id1).toMatch(/^term_[a-f0-9]{12}_[a-z0-9]+$/)
    expect(id2).toMatch(/^term_[a-f0-9]{12}_[a-z0-9]+$/)
    expect(idAi).toMatch(/^ai_[a-f0-9]{12}_[a-z0-9]+$/)
    expect(id1).not.toBe(id2)
  })

  // 2. Shell Detection and Resolution
  it('2. detects appropriate default shell and resolves safe shells', () => {
    const defaultShell = detectDefaultShell()
    expect(typeof defaultShell).toBe('string')
    expect(defaultShell.length).toBeGreaterThan(0)

    if (process.platform === 'win32') {
      expect(defaultShell.toLowerCase()).toContain('powershell')
    }

    // Default resolution
    const resDefault = resolveSafeShell()
    expect(resDefault.shellPath).toBe(defaultShell)
    expect(resDefault.error).toBeUndefined()

    // Explicit valid shell
    if (process.platform === 'win32') {
      const resCmd = resolveSafeShell('cmd.exe')
      expect(resCmd.shellName).toBe('cmd.exe')
      expect(resCmd.error).toBeUndefined()

      const resPwsh = resolveSafeShell('powershell')
      expect(resPwsh.shellName).toBe('powershell')
      expect(resPwsh.error).toBeUndefined()

      // Reject unauthorized shell
      const resBad = resolveSafeShell('unauthorized_malware.exe')
      expect(resBad.error).toContain('not in the allowed shells list')
    }
  })

  // 3. PTY Session Creation & Options
  it('3. spawns a PTY session with bounded dimensions and workspace root', async () => {
    const script = path.join(testDir, 'quick.cjs').replace(/\\/g, '/')
    await fs.writeFile(script, 'process.stdout.write("PTY_SPAWN_OK\\n"); process.exit(0);')

    let streamData = ''
    let exitEvent: TerminalSessionExitEvent | null = null

    manager.on('data', (d: TerminalStreamDataEvent) => {
      if (d.sessionId === 'session-spawn-test') streamData += d.data
    })
    manager.on('exit', (e: TerminalSessionExitEvent) => {
      if (e.sessionId === 'session-spawn-test') exitEvent = e
    })

    const result = await manager.spawnSession({
      sessionId: 'session-spawn-test',
      command: `node "${script}"`,
      cwd: testDir,
      workspaceRoot: testDir,
      cols: 90,
      rows: 28
    })

    expect(result.success).toBe(true)
    expect(result.sessionId).toBe('session-spawn-test')
    expect(typeof result.pid).toBe('number')
    expect(result.cols).toBe(90)
    await vi.waitFor(() => expect(exitEvent).not.toBeNull(), { timeout: 4000 })
    expect(streamData).toContain('PTY_SPAWN_OK')
    const finalEvt = exitEvent as TerminalSessionExitEvent | null
    expect(finalEvt?.exitCode).toBe(0)
  })

  // 4. Dimension Clamping on Spawn
  it('4. clamps cols and rows to bounded range on spawn', async () => {
    const script = path.join(testDir, 'clamp.cjs').replace(/\\/g, '/')
    await fs.writeFile(script, 'process.exit(0);')

    const result = await manager.spawnSession({
      command: `node "${script}"`,
      cwd: testDir,
      cols: 10000, // exceeds max 500
      rows: -50 // below min 2
    })

    expect(result.success).toBe(true)
    expect(result.cols).toBe(500)
    expect(result.rows).toBe(2)
  })

  // 5. CWD and Path Security Validation
  it('5. rejects invalid CWD and workspace traversal attempts', async () => {
    // Non-existent directory
    const badCwd = await manager.spawnSession({
      command: 'echo test',
      cwd: path.join(testDir, 'non_existent_folder_xyz')
    })
    expect(badCwd.success).toBe(false)
    expect(badCwd.error).toContain('does not exist')

    // Dangerous traversal command
    const badCmd = await manager.spawnSession({
      command: 'cd ../../.. && echo escape',
      cwd: testDir,
      workspaceRoot: testDir
    })
    expect(badCmd.success).toBe(false)
    expect(badCmd.error).toContain('workspace')
  })

  // 6. Interactive Stdin and Enter Normalization
  it('6. routes interactive stdin through PTY write with Enter normalization', async () => {
    const echoScript = path.join(testDir, 'echo_stdin.cjs').replace(/\\/g, '/')
    await fs.writeFile(
      echoScript,
      `
      process.stdout.write("READY_FOR_DATA\\n");
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (d) => {
        process.stdout.write("RECV:" + d.trim() + "\\n");
        process.exit(0);
      });
      `
    )

    let isReady = false
    let allOutput = ''
    let exited = false

    manager.on('data', (evt) => {
      if (evt.sessionId === 'session-stdin-unit') {
        allOutput += evt.data
        if (allOutput.includes('READY_FOR_DATA')) isReady = true
      }
    })
    manager.on('exit', (evt) => {
      if (evt.sessionId === 'session-stdin-unit') exited = true
    })

    await manager.spawnSession({
      sessionId: 'session-stdin-unit',
      command: `node "${echoScript}"`,
      cwd: testDir
    })

    await vi.waitFor(() => expect(isReady).toBe(true), { timeout: 3000 })

    const writeRes = await manager.writeInput('session-stdin-unit', 'HELLO_PTY\n')
    expect(writeRes.success).toBe(true)

    await vi.waitFor(() => expect(exited).toBe(true), { timeout: 3000 })
    expect(allOutput).toContain('RECV:HELLO_PTY')
  })

  // 7. PTY Resize and Validation
  it('7. resizes running session PTY and isolates resize between sessions', async () => {
    const loopScript = path.join(testDir, 'loop_resize.cjs').replace(/\\/g, '/')
    await fs.writeFile(
      loopScript,
      'const i = setInterval(() => {}, 1000); process.on("SIGTERM", () => { clearInterval(i); process.exit(0); });'
    )

    await manager.spawnSession({
      sessionId: 'sess-a',
      command: `node "${loopScript}"`,
      cwd: testDir,
      cols: 80,
      rows: 24
    })

    await manager.spawnSession({
      sessionId: 'sess-b',
      command: `node "${loopScript}"`,
      cwd: testDir,
      cols: 90,
      rows: 30
    })

    // Resize session A
    const resA = manager.resizeSession('sess-a', 140, 45)
    expect(resA.success).toBe(true)
    expect(resA.cols).toBe(140)
    expect(resA.rows).toBe(45)

    // Session B remains untouched
    const sessionB = manager.getSession('sess-b')
    expect(sessionB?.cols).toBe(90)
    expect(sessionB?.rows).toBe(30)

    // Invalid dimension rejection
    const resBad = manager.resizeSession('sess-a', 0, -10)
    expect(resBad.success).toBe(false)
    expect(resBad.error).toContain('positive finite integers')

    // Non-existent session
    const resNone = manager.resizeSession('sess-does-not-exist', 100, 30)
    expect(resNone.success).toBe(false)
    expect(resNone.error).toContain('not found')
  })

  // 8. Ctrl+C Signal Forwarding
  it('8. forwards Ctrl+C (SIGINT) to interrupt foreground process', async () => {
    const sigScript = path.join(testDir, 'sigint_test.cjs').replace(/\\/g, '/')
    await fs.writeFile(
      sigScript,
      `
      process.stdout.write("READY_SIG\\n");
      const i = setInterval(() => {}, 1000);
      process.on('SIGINT', () => {
        clearInterval(i);
        process.stdout.write("HANDLED_SIGINT\\n");
        process.exit(0);
      });
      `
    )

    let exitEvt: TerminalSessionExitEvent | null = null
    manager.on('exit', (e) => {
      if (e.sessionId === 'sess-sigint') exitEvt = e
    })

    await manager.spawnSession({
      sessionId: 'sess-sigint',
      command: `node "${sigScript}"`,
      cwd: testDir
    })

    await vi.waitFor(async () => {
      const s = manager.getSession('sess-sigint')
      expect(s?.running).toBe(true)
    })

    const sigRes = await manager.sendSignal('sess-sigint', 'SIGINT')
    expect(sigRes.success).toBe(true)

    await vi.waitFor(() => expect(exitEvt).not.toBeNull(), { timeout: 4000 })
    const finalSigEvt = exitEvt as TerminalSessionExitEvent | null
    expect([0, -1073741510, 130, 3221225786]).toContain(finalSigEvt?.exitCode)
  })

  // 9. Session Termination & Idempotency
  it('9. terminates session cleanly and handles duplicate kill requests idempotently', async () => {
    const sleepScript = path.join(testDir, 'sleep_term.cjs').replace(/\\/g, '/')
    await fs.writeFile(
      sleepScript,
      'const i = setInterval(() => {}, 1000); process.on("SIGTERM", () => { clearInterval(i); process.exit(0); });'
    )

    await manager.spawnSession({
      sessionId: 'sess-kill',
      command: `node "${sleepScript}"`,
      cwd: testDir
    })

    // First kill
    const kill1 = await manager.killSession('sess-kill')
    expect(kill1.success).toBe(true)

    const session = manager.getSession('sess-kill')
    expect(session?.running).toBe(false)
    expect(session?.status).toBe('terminated')

    // Duplicate kill
    const kill2 = await manager.killSession('sess-kill')
    expect(kill2.success).toBe(true)
    expect(kill2.message).toContain('not running')
  })

  // 10. Multi-session Output & Lifecycle Isolation
  it('10. manages concurrent sessions with isolated output and lifecycle tracking', async () => {
    const sA = path.join(testDir, 'sA.cjs').replace(/\\/g, '/')
    const sB = path.join(testDir, 'sB.cjs').replace(/\\/g, '/')

    await fs.writeFile(sA, 'process.stdout.write("ALPHA_MSG\\n"); process.exit(0);')
    await fs.writeFile(sB, 'process.stdout.write("BETA_MSG\\n"); process.exit(0);')

    let outA = ''
    let outB = ''

    manager.on('data', (d) => {
      if (d.sessionId === 'sess-alpha') outA += d.data
      if (d.sessionId === 'sess-beta') outB += d.data
    })

    await Promise.all([
      manager.spawnSession({ sessionId: 'sess-alpha', command: `node "${sA}"`, cwd: testDir }),
      manager.spawnSession({ sessionId: 'sess-beta', command: `node "${sB}"`, cwd: testDir })
    ])

    await vi.waitFor(() => {
      expect(outA).toContain('ALPHA_MSG')
      expect(outB).toContain('BETA_MSG')
    }, { timeout: 4000 })

    expect(outA).not.toContain('BETA_MSG')
    expect(outB).not.toContain('ALPHA_MSG')
  })

  // 11. Stdin Validation on Closed / Invalid Sessions
  it('11. rejects stdin writes on invalid, non-existent, or terminated sessions', async () => {
    // Non-existent
    const resNone = await manager.writeInput('ghost-sess', 'data\n')
    expect(resNone.success).toBe(false)
    expect(resNone.error).toContain('not found')

    // Null bytes
    const resNull = await manager.writeInput('ghost-sess', 'abc\0def')
    expect(resNull.success).toBe(false)
    expect(resNull.error).toContain('null bytes')

    // Invalid session ID
    const resBadId = await manager.writeInput('', 'data')
    expect(resBadId.success).toBe(false)
    expect(resBadId.error).toContain('Invalid session ID')
  })

  // 12. Session List & Cleanup
  it('12. lists active/completed sessions and prunes completed sessions', async () => {
    const doneScript = path.join(testDir, 'done.cjs').replace(/\\/g, '/')
    await fs.writeFile(doneScript, 'process.exit(0);')

    let exitReported = false
    manager.on('exit', () => {
      exitReported = true
    })

    await manager.spawnSession({
      sessionId: 'sess-cleanup-1',
      command: `node "${doneScript}"`,
      cwd: testDir
    })

    await vi.waitFor(() => expect(exitReported).toBe(true), { timeout: 3000 })

    const list = manager.listSessions()
    expect(list.some((s) => s.sessionId === 'sess-cleanup-1')).toBe(true)

    // Remove single completed session
    const removed = manager.removeCompletedSession('sess-cleanup-1')
    expect(removed).toBe(true)
    expect(manager.getSession('sess-cleanup-1')).toBeUndefined()

    // Clear all completed
    const cleared = manager.clearAllCompletedSessions()
    expect(cleared).toBe(0) // already removed
  })

  // 13. AI Context Output Sanitization & Compression Compatibility
  it('13. produces raw output that cleanly feeds into AI terminal sanitizer', () => {
    // Emulate raw PTY output with VT100 colors and cursor controls
    const rawPtyOutput = '\x1b[31mError: \x1b[32mSuccess on line 1\x1b[0m\r\n\x1b[34mInfo: line 2\x1b[0m\r\n'

    const sanitized = processTerminalOutputForAI(rawPtyOutput, {
      headLines: 10,
      tailLines: 10,
      maxTotalChars: 2000
    })

    expect(sanitized.text).not.toContain('\x1b[31m')
    expect(sanitized.text).not.toContain('\x1b[32m')
    expect(sanitized.text).toContain('Error: Success on line 1')
    expect(sanitized.text).toContain('Info: line 2')
  })

  // 14. Global Kill All Shutdown Safety
  it('14. terminates all active PTY processes safely on killAllSessions', async () => {
    const loopScript = path.join(testDir, 'sleep_all.cjs').replace(/\\/g, '/')
    await fs.writeFile(
      loopScript,
      'const i = setInterval(() => {}, 1000); process.on("SIGTERM", () => { clearInterval(i); process.exit(0); });'
    )

    await manager.spawnSession({ sessionId: 'all-1', command: `node "${loopScript}"`, cwd: testDir })
    await manager.spawnSession({ sessionId: 'all-2', command: `node "${loopScript}"`, cwd: testDir })

    const killAll = await manager.killAllSessions()
    expect(killAll.success).toBe(true)
    expect(killAll.killedCount).toBe(2)

    const remainingRunning = manager.listSessions().filter((s) => s.running)
    expect(remainingRunning.length).toBe(0)
  })

  // 15. Helper terminateProcessTree Safety
  it('15. handles terminateProcessTree gracefully with invalid or empty PID', async () => {
    const resUndefined = await terminateProcessTree(undefined, undefined)
    expect(resUndefined).toBe(true)

    const resZero = await terminateProcessTree(undefined, 0)
    expect(resZero).toBe(true)
  })

  // 16. Phase 13.2 — Bounded Ring Buffer & Output Memory Control
  it('16. caps retained output to maxBuffer using ring buffer without memory bloat', async () => {
    const floodScript = path.join(testDir, 'flood.cjs').replace(/\\/g, '/')
    // Emits 5,000 lines of 30 characters each (~150,000 characters)
    await fs.writeFile(
      floodScript,
      'for (let i = 0; i < 5000; i++) { process.stdout.write("line " + i.toString().padStart(6, "0") + "\\n"); } process.exit(0);'
    )

    let exitEvent: TerminalSessionExitEvent | null = null
    manager.on('exit', (e) => {
      if (e.sessionId === 'session-flood-test') exitEvent = e
    })

    const spawnRes = await manager.spawnSession({
      sessionId: 'session-flood-test',
      command: `node "${floodScript}"`,
      cwd: testDir,
      workspaceRoot: testDir,
      maxBuffer: 4096 // Bounded to 4KB
    })
    expect(spawnRes.success).toBe(true)

    // Wait for exit
    await vi.waitFor(() => expect(exitEvent).not.toBeNull(), { timeout: 10000 })
    expect(exitEvent!.exitCode).toBe(0)

    // Verify session retainedStdout is strictly bounded to 4096
    const session = manager.getSession('session-flood-test')
    expect(session).toBeDefined()
    expect(session!.retainedStdout.length).toBeLessThanOrEqual(4096)
    // The latest lines must be present in the retained buffer
    expect(session!.retainedStdout).toContain('line 004999')

    // Diagnostics should confirm eviction occurred
    const diag = manager.getSessionDiagnostics('session-flood-test')
    expect(diag).not.toBeNull()
    expect(diag!.ringBufferSize).toBeLessThanOrEqual(4096)
    expect(diag!.ringBufferEvictedBytes).toBeGreaterThan(50000)
    expect(diag!.totalBytesProcessed).toBeGreaterThan(50000)
  })

  // 17. Phase 13.2 — Event-Driven Output Batching Coalescence
  it('17. coalesces rapid output chunks within batch window into consolidated IPC events', async () => {
    const rapidScript = path.join(testDir, 'rapid.cjs').replace(/\\/g, '/')
    // Write 50 chunks in rapid succession synchronously
    await fs.writeFile(
      rapidScript,
      'for (let i = 0; i < 50; i++) { process.stdout.write("chunk" + i + ";"); } process.exit(0);'
    )

    const receivedBatches: string[] = []
    manager.on('data', (d) => {
      if (d.sessionId === 'session-rapid-test') {
        receivedBatches.push(d.data)
      }
    })

    let exitEvent: TerminalSessionExitEvent | null = null
    manager.on('exit', (e) => {
      if (e.sessionId === 'session-rapid-test') exitEvent = e
    })

    await manager.spawnSession({
      sessionId: 'session-rapid-test',
      command: `node "${rapidScript}"`,
      cwd: testDir
    })

    await vi.waitFor(() => expect(exitEvent).not.toBeNull(), { timeout: 10000 })

    // Received batches should be significantly fewer than 50 raw writes due to batching
    expect(receivedBatches.length).toBeLessThan(25)
    // Complete content must be intact across batches
    const fullReceived = receivedBatches.join('')
    expect(fullReceived).toContain('chunk0;')
    expect(fullReceived).toContain('chunk49;')
  })

  // 18. Phase 13.2 — Immediate Flush on 16KB Threshold
  it('18. flushes immediately without timer delay when pending output exceeds maxBatchSize', () => {
    const customMgr = new TerminalSessionManager({
      batchWindowMs: 5000, // Very long window
      maxBatchSize: 1024 // Small threshold for testing
    })

    // Construct an artificial session
    const mockSession = {
      id: 'test-threshold-sess',
      ended: false,
      totalBytesProcessed: 0,
      totalBatchesFlushed: 0,
      pendingOutputChunks: [] as string[],
      pendingOutputSize: 0,
      batchTimer: null,
      outputRingBuffer: { write: vi.fn(), size: () => 0, getCapacity: () => 4096, getEvictedBytes: () => 0 } as any
    } as any

    const emittedData: string[] = []
    customMgr.on('data', (d) => {
      emittedData.push(d.data)
    })

    // Write chunk smaller than threshold: should not flush immediately (timer scheduled)
    customMgr.handleSessionData(mockSession, 'hello ')
    expect(emittedData.length).toBe(0)
    expect(mockSession.batchTimer).not.toBeNull()

    // Write chunk that crosses 1024 byte threshold: should flush immediately
    const bigChunk = 'X'.repeat(1200)
    customMgr.handleSessionData(mockSession, bigChunk)
    expect(emittedData.length).toBe(1)
    expect(emittedData[0]).toBe('hello ' + bigChunk)
    expect(mockSession.pendingOutputChunks.length).toBe(0)
    expect(mockSession.batchTimer).toBeNull()
  })

  // 19. Phase 13.2 — Process Exit Synchronously Flushes Trailing Output
  it('19. guarantees pending batched output is flushed before exit event emission', async () => {
    const exitScript = path.join(testDir, 'exit_flush.cjs').replace(/\\/g, '/')
    // Emits one chunk and exits immediately
    await fs.writeFile(
      exitScript,
      'process.stdout.write("FINAL_OUTPUT_BEFORE_EXIT"); process.exit(0);'
    )

    const events: string[] = []
    manager.on('data', (d) => {
      if (d.sessionId === 'session-exit-flush-test') {
        events.push(`data:${d.data}`)
      }
    })
    manager.on('exit', (e) => {
      if (e.sessionId === 'session-exit-flush-test') {
        events.push('exit')
      }
    })

    await manager.spawnSession({
      sessionId: 'session-exit-flush-test',
      command: `node "${exitScript}"`,
      cwd: testDir
    })

    await vi.waitFor(() => expect(events).toContain('exit'), { timeout: 10000 })

    // 'data' event MUST precede 'exit' event
    const dataIndex = events.findIndex((e) => e.includes('FINAL_OUTPUT_BEFORE_EXIT'))
    const exitIndex = events.indexOf('exit')
    expect(dataIndex).toBeGreaterThanOrEqual(0)
    expect(exitIndex).toBeGreaterThan(dataIndex)
  })

  // 20. Phase 13.2 — Multi-Session Batching and Buffer Isolation
  it('20. maintains strict batching and ring buffer isolation between concurrent sessions', async () => {
    const scriptA = path.join(testDir, 'sessA.cjs').replace(/\\/g, '/')
    const scriptB = path.join(testDir, 'sessB.cjs').replace(/\\/g, '/')

    await fs.writeFile(scriptA, 'process.stdout.write("OUTPUT_FROM_A\\n"); process.exit(0);')
    await fs.writeFile(scriptB, 'process.stdout.write("OUTPUT_FROM_B\\n"); process.exit(0);')

    let dataA = ''
    let dataB = ''
    let exitCount = 0

    manager.on('data', (d) => {
      if (d.sessionId === 'sess-iso-A') dataA += d.data
      if (d.sessionId === 'sess-iso-B') dataB += d.data
    })
    manager.on('exit', (e) => {
      if (e.sessionId === 'sess-iso-A' || e.sessionId === 'sess-iso-B') exitCount++
    })

    await Promise.all([
      manager.spawnSession({ sessionId: 'sess-iso-A', command: `node "${scriptA}"`, cwd: testDir }),
      manager.spawnSession({ sessionId: 'sess-iso-B', command: `node "${scriptB}"`, cwd: testDir })
    ])

    await vi.waitFor(
      () => {
        expect(dataA).toContain('OUTPUT_FROM_A')
        expect(dataB).toContain('OUTPUT_FROM_B')
        expect(exitCount).toBe(2)
      },
      { timeout: 10000 }
    )

    expect(dataA).not.toContain('OUTPUT_FROM_B')
    expect(dataB).not.toContain('OUTPUT_FROM_A')

    const sessA = manager.getSession('sess-iso-A')
    const sessB = manager.getSession('sess-iso-B')

    expect(sessA!.retainedStdout).toContain('OUTPUT_FROM_A')
    expect(sessA!.retainedStdout).not.toContain('OUTPUT_FROM_B')
    expect(sessB!.retainedStdout).toContain('OUTPUT_FROM_B')
    expect(sessB!.retainedStdout).not.toContain('OUTPUT_FROM_A')
  })

  // 21. Phase 13.2 — Clean Session Disposal and Timer/Buffer Release
  it('21. cancels pending batch timers and releases ring buffer on removeCompletedSession', async () => {
    const quickScript = path.join(testDir, 'quick_cleanup.cjs').replace(/\\/g, '/')
    await fs.writeFile(quickScript, 'process.stdout.write("done"); process.exit(0);')

    let exited = false
    manager.on('exit', (e) => {
      if (e.sessionId === 'sess-dispose-test') exited = true
    })

    await manager.spawnSession({
      sessionId: 'sess-dispose-test',
      command: `node "${quickScript}"`,
      cwd: testDir
    })

    await vi.waitFor(
      () => {
        expect(exited).toBe(true)
      },
      { timeout: 10000 }
    )

    const sessionBefore = manager.getSession('sess-dispose-test')!
    expect(sessionBefore.batchTimer).toBeNull()

    const removed = manager.removeCompletedSession('sess-dispose-test')
    expect(removed).toBe(true)
    expect(manager.getSession('sess-dispose-test')).toBeUndefined()
  })

  // 22. Phase 13.2 — Session Diagnostics Reporting
  it('22. returns accurate diagnostics for active and completed sessions', async () => {
    const diagScript = path.join(testDir, 'diag.cjs').replace(/\\/g, '/')
    await fs.writeFile(diagScript, 'process.stdout.write("DIAGNOSTIC_PAYLOAD\\n"); process.exit(0);')

    let exited = false
    manager.on('exit', (e) => {
      if (e.sessionId === 'sess-diag-test') exited = true
    })

    await manager.spawnSession({
      sessionId: 'sess-diag-test',
      command: `node "${diagScript}"`,
      cwd: testDir
    })

    await vi.waitFor(
      () => {
        expect(exited).toBe(true)
      },
      { timeout: 10000 }
    )

    const diag = manager.getSessionDiagnostics('sess-diag-test')
    expect(diag).not.toBeNull()
    expect(diag!.totalBytesProcessed).toBeGreaterThan(0)
    expect(diag!.totalBatchesFlushed).toBeGreaterThanOrEqual(1)
    expect(diag!.pendingOutputChunks).toBe(0)
    expect(diag!.pendingOutputSize).toBe(0)
    expect(diag!.ringBufferSize).toBeGreaterThan(0)
    expect(diag!.ringBufferCapacity).toBeGreaterThan(0)

    // Non-existent session diagnostics
    expect(manager.getSessionDiagnostics('non-existent-session')).toBeNull()
  })
})
