import * as pty from 'node-pty'
import { EventEmitter } from 'events'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as crypto from 'crypto'
import { exec } from 'child_process'
import {
  TerminalSessionSource,
  TerminalSessionStatus,
  TerminalSpawnOptions,
  TerminalSpawnResult,
  TerminalWriteInputResult,
  TerminalKillResult,
  TerminalKillAllResult,
  TerminalSessionInfo,
  TerminalStreamDataEvent,
  TerminalSessionExitEvent,
  TerminalResizeResult
} from '../shared/types'
import { validateCommandSafety } from '../shared/commandValidator'
import { isSafeString, isSafePath, clampTimeout } from '../shared/securityUtils'
import { TerminalRingBuffer } from '../shared/terminalRingBuffer'

export interface TerminalBatchingOptions {
  batchWindowMs?: number
  maxBatchSize?: number
  defaultRingBufferSize?: number
}

export const DEFAULT_BATCH_WINDOW_MS = 12
export const DEFAULT_MAX_BATCH_SIZE = 16384
export const DEFAULT_RING_BUFFER_SIZE = 65536

export interface TerminalSession {
  id: string
  pty: pty.IPty
  child?: unknown
  pid?: number
  command: string
  cwd: string
  workspaceRoot: string
  source: TerminalSessionSource
  status: TerminalSessionStatus
  running: boolean
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  error?: string
  createdAt: number
  endedAt?: number
  timer: NodeJS.Timeout | null
  maxBuffer: number
  retainedStdout: string
  retainedStderr: string
  ended: boolean
  cols: number
  rows: number
  shell: string
  shellArgs: string[]
  isInteractive: boolean
  disposables: Array<{ dispose: () => void }>

  // Phase 13.2 Batching and Ring Buffer
  outputRingBuffer: TerminalRingBuffer
  pendingOutputChunks: string[]
  pendingOutputSize: number
  batchTimer: NodeJS.Timeout | null
  totalBatchesFlushed: number
  totalBytesProcessed: number
}

/**
 * Allowed shells on Windows to prevent arbitrary binary execution from untrusted inputs
 */
const ALLOWED_WINDOWS_SHELLS = new Set([
  'powershell.exe',
  'powershell',
  'pwsh.exe',
  'pwsh',
  'cmd.exe',
  'cmd',
  'bash.exe',
  'bash',
  'wsl.exe',
  'git-bash.exe'
])

/**
 * Detects the preferred default shell for the current operating system
 */
export function detectDefaultShell(): string {
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
    const psPath = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    return psPath
  }
  return process.env.SHELL || '/bin/bash'
}

/**
 * Resolves and validates a safe shell path and arguments
 */
export function resolveSafeShell(requestedShell?: string): {
  shellPath: string
  shellName: string
  error?: string
} {
  if (!requestedShell || requestedShell.trim() === '' || requestedShell.toLowerCase() === 'default') {
    const def = detectDefaultShell()
    return { shellPath: def, shellName: path.basename(def).toLowerCase() }
  }

  const trimmed = requestedShell.trim()
  const baseName = path.basename(trimmed).toLowerCase()

  if (process.platform === 'win32') {
    if (!ALLOWED_WINDOWS_SHELLS.has(baseName)) {
      return {
        shellPath: '',
        shellName: '',
        error: `Requested shell '${requestedShell}' is not in the allowed shells list.`
      }
    }
  }

  return { shellPath: trimmed, shellName: baseName }
}

/**
 * Safely terminates a process across platforms.
 * On Windows, terminates the process and its whole descendant tree via taskkill.
 * On POSIX, terminates the process tree using SIGTERM.
 */
export function terminateProcessTree(childOrPty?: unknown, pid?: number): Promise<boolean> {
  const targetPid =
    pid ||
    (childOrPty && typeof childOrPty === 'object' && 'pid' in childOrPty
      ? (childOrPty as { pid?: number }).pid
      : undefined)

  if (!targetPid) return Promise.resolve(true)

  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      exec(`taskkill /pid ${targetPid} /T /F`, () => {
        resolve(true)
      })
    } else {
      try {
        process.kill(targetPid, 'SIGTERM')
      } catch {
        // Already dead
      }
      resolve(true)
    }
  })
}

/**
 * Validates custom session identifier strings
 */
function isValidSessionId(id: string): boolean {
  return isSafeString(id, 128) && /^[a-zA-Z0-9_\-.:]+$/.test(id)
}

/**
 * TerminalSessionManager
 * Maintains isolated, concurrent pseudoterminal (PTY) sessions via node-pty
 * in the Electron main process.
 */
export class TerminalSessionManager extends EventEmitter {
  private sessions: Map<string, TerminalSession> = new Map()
  private batchWindowMs: number
  private maxBatchSize: number
  private defaultRingBufferSize: number

  constructor(options?: TerminalBatchingOptions) {
    super()
    this.batchWindowMs = options?.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS
    this.maxBatchSize = options?.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE
    this.defaultRingBufferSize = options?.defaultRingBufferSize ?? DEFAULT_RING_BUFFER_SIZE
  }

  /**
   * Generates a collision-resistant unique session identifier
   */
  public generateSessionId(prefix = 'term'): string {
    const randomHex = crypto.randomUUID().replace(/-/g, '').slice(0, 12)
    const timestamp = Date.now().toString(36)
    return `${prefix}_${randomHex}_${timestamp}`
  }

  /**
   * Spawns a new PTY in an independent, isolated session
   */
  public async spawnSession(options: TerminalSpawnOptions): Promise<TerminalSpawnResult> {
    const {
      command = '',
      shell: requestedShell,
      shellArgs: requestedShellArgs,
      cols = 80,
      rows = 24,
      cwd = process.cwd(),
      workspaceRoot = cwd,
      sessionId: requestedSessionId,
      source = 'user',
      timeoutMs = 60000,
      maxBuffer = 50000,
      interactive = false,
      env = {}
    } = options

    const isInteractive = interactive || (!command && Boolean(requestedShell))

    // 1. Validate Command String (if non-interactive)
    if (!isInteractive) {
      if (!command || !isSafeString(command, 32768)) {
        return {
          success: false,
          error: 'Command cannot be empty, contains invalid characters, or exceeds 32KB.'
        }
      }
    }

    // 2. Validate Session ID
    let sessionId: string
    if (requestedSessionId !== undefined && requestedSessionId !== null) {
      if (!isValidSessionId(requestedSessionId)) {
        return {
          success: false,
          error:
            'Invalid session ID. Must contain only alphanumeric characters, dashes, underscores, dots, or colons.'
        }
      }
      const existing = this.sessions.get(requestedSessionId)
      if (existing && existing.running) {
        return {
          success: false,
          sessionId: requestedSessionId,
          error: `A session with ID '${requestedSessionId}' is already running.`
        }
      }
      sessionId = requestedSessionId
    } else {
      sessionId = this.generateSessionId(
        source === 'ai' ? 'ai' : source === 'transient' ? 'transient' : 'term'
      )
    }

    // 3. Validate Working Directory & Workspace Containment
    if (!cwd || !isSafePath(cwd)) {
      return { success: false, sessionId, error: 'Invalid working directory path.' }
    }

    let resolvedCwd: string
    try {
      const stat = await fs.stat(cwd)
      if (!stat.isDirectory()) {
        return {
          success: false,
          sessionId,
          error: `Working directory '${cwd}' is not a directory.`
        }
      }
      resolvedCwd = path.resolve(cwd)
    } catch {
      return {
        success: false,
        sessionId,
        error: `Working directory does not exist: '${cwd}'.`
      }
    }

    const effectiveWorkspaceRoot =
      workspaceRoot && isSafePath(workspaceRoot) ? path.resolve(workspaceRoot) : resolvedCwd

    if (!isInteractive && command) {
      const safetyCheck = validateCommandSafety(command, effectiveWorkspaceRoot)
      if (!safetyCheck.safe) {
        return {
          success: false,
          sessionId,
          error: safetyCheck.error || 'Command rejected: working directory must remain inside workspace.'
        }
      }
    }

    // 4. Configure Boundaries & Dimensions
    const clampedTimeout = clampTimeout(timeoutMs, 60000, 0, 600000)
    const clampedMaxBuffer = Math.max(
      1024,
      Math.min(
        typeof maxBuffer === 'number' && Number.isFinite(maxBuffer) ? Math.floor(maxBuffer) : 50000,
        1000000
      )
    )
    const clampedCols = Math.max(10, Math.min(Number.isFinite(cols) ? Math.floor(cols) : 80, 500))
    const clampedRows = Math.max(2, Math.min(Number.isFinite(rows) ? Math.floor(rows) : 24, 200))

    // 5. Shell and Arguments Resolution
    const shellResolution = resolveSafeShell(requestedShell)
    if (shellResolution.error) {
      return {
        success: false,
        sessionId,
        error: shellResolution.error
      }
    }

    const shellPath = shellResolution.shellPath
    const shellName = shellResolution.shellName

    let shellArgs: string[] = []
    if (Array.isArray(requestedShellArgs) && requestedShellArgs.length > 0) {
      shellArgs = [...requestedShellArgs]
    } else if (isInteractive) {
      if (shellName.includes('powershell') || shellName.includes('pwsh')) {
        shellArgs = ['-NoLogo']
      } else if (shellName.includes('cmd')) {
        shellArgs = []
      } else {
        shellArgs = ['-i']
      }
    } else {
      // Command execution via shell
      if (process.platform === 'win32') {
        if (shellName.includes('powershell') || shellName.includes('pwsh')) {
          shellArgs = [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-Command',
            `& { ${command}; exit $LASTEXITCODE }`
          ]
        } else if (shellName.includes('cmd')) {
          shellArgs = ['/d', '/c', command]
        } else {
          shellArgs = ['-c', command]
        }
      } else {
        shellArgs = ['-c', command]
      }
    }

    // 6. Setup Session Record
    const session: TerminalSession = {
      id: sessionId,
      pty: null as unknown as pty.IPty,
      command: command || shellName,
      cwd: resolvedCwd,
      workspaceRoot: effectiveWorkspaceRoot,
      source,
      status: 'running',
      running: true,
      exitCode: null,
      signal: null,
      timedOut: false,
      createdAt: Date.now(),
      timer: null,
      maxBuffer: clampedMaxBuffer,
      retainedStdout: '',
      retainedStderr: '',
      ended: false,
      cols: clampedCols,
      rows: clampedRows,
      shell: shellPath,
      shellArgs,
      isInteractive,
      disposables: [],

      // Phase 13.2 Batching and Ring Buffer
      outputRingBuffer: new TerminalRingBuffer(clampedMaxBuffer || this.defaultRingBufferSize),
      pendingOutputChunks: [],
      pendingOutputSize: 0,
      batchTimer: null,
      totalBatchesFlushed: 0,
      totalBytesProcessed: 0
    }

    this.sessions.set(sessionId, session)

    // 7. Spawn Pseudoterminal (PTY) Process
    try {
      const ptyProcess = pty.spawn(shellPath, shellArgs, {
        name: 'xterm-256color',
        cols: clampedCols,
        rows: clampedRows,
        cwd: resolvedCwd,
        env: {
          ...process.env,
          FORCE_COLOR: '1',
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          ...env
        },
        useConpty: true
      })

      session.pty = ptyProcess
      session.child = ptyProcess
      session.pid = ptyProcess.pid

      // Handle process execution timeout
      if (clampedTimeout > 0) {
        session.timer = setTimeout(async () => {
          if (!session.ended && session.running) {
            session.timedOut = true
            session.status = 'timedOut'
            await terminateProcessTree(session.pty, session.pid)
            try {
              session.pty.kill('SIGTERM')
            } catch {
              // Ignore
            }
            this.handleProcessExit(
              session,
              null,
              'SIGTERM',
              `Execution timed out after ${clampedTimeout / 1000} seconds.`
            )
          }
        }, clampedTimeout)
      }

      // Stream raw PTY output through batching & ring buffer pipeline
      const dataDisposable = ptyProcess.onData((data: string) => {
        this.handleSessionData(session, data)
      })
      session.disposables.push(dataDisposable)

      // Listen for PTY exit
      const exitDisposable = ptyProcess.onExit((event: { exitCode: number; signal?: number }) => {
        this.handleProcessExit(
          session,
          event.exitCode,
          event.signal ? String(event.signal) : null
        )
      })
      session.disposables.push(exitDisposable)

      return {
        success: true,
        sessionId,
        pid: ptyProcess.pid,
        cols: clampedCols,
        rows: clampedRows,
        shell: shellPath
      }
    } catch (spawnErr: unknown) {
      if (session.timer) {
        clearTimeout(session.timer)
        session.timer = null
      }
      session.running = false
      session.ended = true
      session.status = 'failed'
      const msg = spawnErr instanceof Error ? spawnErr.message : String(spawnErr)
      session.error = msg
      return {
        success: false,
        sessionId,
        error: msg
      }
    }
  }

  /**
   * Internal exit handler to ensure idempotent teardown and single exit event emission
   */
  private handleProcessExit(
    session: TerminalSession,
    code: number | null,
    signal?: string | null,
    errorMessage?: string
  ): void {
    if (session.ended) return
    session.ended = true
    session.running = false
    session.endedAt = Date.now()

    if (session.timer) {
      clearTimeout(session.timer)
      session.timer = null
    }

    if (session.batchTimer) {
      clearTimeout(session.batchTimer)
      session.batchTimer = null
    }

    // Synchronously flush any pending batched output before emitting exit
    this.flushSessionBatch(session, 'exit')

    // Clean up all PTY disposables to avoid memory leaks
    for (const disp of session.disposables) {
      try {
        disp.dispose()
      } catch {
        // Ignore
      }
    }
    session.disposables = []

    // Sync retained stdout from bounded ring buffer
    session.retainedStdout = session.outputRingBuffer.toString()

    if (errorMessage && !session.error) {
      session.error = errorMessage
    }

    if (session.timedOut) {
      session.status = 'timedOut'
    } else if (session.status === 'terminated') {
      // already marked terminated by killSession
    } else if (errorMessage) {
      session.status = 'failed'
    } else if (code !== null && code !== 0) {
      session.status = 'failed'
    } else {
      session.status = 'completed'
    }

    session.exitCode = code
    session.signal = signal || null

    // For non-zero exit codes, mirror output into retainedStderr if not already populated
    if (code !== null && code !== 0 && !session.retainedStderr) {
      session.retainedStderr = session.retainedStdout
    }

    const exitEvent: TerminalSessionExitEvent = {
      sessionId: session.id,
      exitCode: code,
      signal: signal || null,
      timedOut: session.timedOut,
      error: session.error,
      stdout: session.retainedStdout,
      stderr: session.retainedStderr
    }

    this.emit('exit', exitEvent)
  }

  /**
   * Writes input to a running PTY session standard input pipe
   */
  public async writeInput(sessionId: string, inputData: string): Promise<TerminalWriteInputResult> {
    if (!sessionId || !isSafeString(sessionId, 128)) {
      return { success: false, error: 'Invalid session ID.' }
    }

    if (typeof inputData !== 'string') {
      return { success: false, error: 'Input data must be a string.' }
    }

    if (inputData.length > 65536) {
      return { success: false, error: 'Input data exceeds maximum permitted length (64KB).' }
    }

    if (inputData.includes('\0')) {
      return { success: false, error: 'Input data cannot contain null bytes.' }
    }

    const session = this.sessions.get(sessionId)
    if (!session) {
      return { success: false, error: `Session not found: '${sessionId}'.` }
    }

    if (!session.running || session.ended || !session.pty) {
      return {
        success: false,
        error: `Session '${sessionId}' is not running or stdin is closed.`
      }
    }

    try {
      // On Windows ConPTY, normalize standalone newlines (\n) to carriage returns (\r)
      // so programmatic inputs (e.g. 'command\n') execute properly as Enter
      let payload = inputData
      if (process.platform === 'win32') {
        payload = inputData.replace(/\r?\n/g, '\r')
      }

      session.pty.write(payload)
      return { success: true }
    } catch (writeErr: unknown) {
      const msg = writeErr instanceof Error ? writeErr.message : String(writeErr)
      return { success: false, error: msg }
    }
  }

  /**
   * Resizes the pseudoterminal dimensions for a session
   */
  public resizeSession(sessionId: string, cols: number, rows: number): TerminalResizeResult {
    if (!sessionId || typeof sessionId !== 'string') {
      return { success: false, error: 'Invalid session ID.' }
    }

    const session = this.sessions.get(sessionId)
    if (!session) {
      return { success: false, error: `Session not found: '${sessionId}'.` }
    }

    if (!session.running || session.ended || !session.pty) {
      return { success: false, error: `Session '${sessionId}' is not running.` }
    }

    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) {
      return { success: false, error: 'Columns and rows must be positive finite integers.' }
    }

    const clampedCols = Math.max(10, Math.min(Math.floor(cols), 500))
    const clampedRows = Math.max(2, Math.min(Math.floor(rows), 200))

    try {
      session.pty.resize(clampedCols, clampedRows)
      session.cols = clampedCols
      session.rows = clampedRows
      return { success: true, cols: clampedCols, rows: clampedRows }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return { success: false, error: msg }
    }
  }

  /**
   * Sends an interrupt signal (Ctrl+C) to a running session without killing the shell
   */
  public async sendSignal(
    sessionId: string,
    signal: 'SIGINT' | 'SIGTERM' = 'SIGINT'
  ): Promise<{ success: boolean; error?: string }> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return { success: false, error: `Session not found: '${sessionId}'.` }
    }
    if (!session.running || session.ended) {
      return { success: false, error: `Session '${sessionId}' is not running.` }
    }

    if (signal === 'SIGINT') {
      // Send ETX (\x03) character through PTY input to interrupt foreground command
      return this.writeInput(sessionId, '\x03')
    } else {
      const killRes = await this.killSession(sessionId)
      return { success: killRes.success, error: killRes.error }
    }
  }

  /**
   * Forcibly terminates a specific session by ID
   */
  public async killSession(sessionId: string): Promise<TerminalKillResult> {
    if (!sessionId || typeof sessionId !== 'string') {
      return { success: false, error: 'Invalid session ID.' }
    }

    const session = this.sessions.get(sessionId)
    if (!session) {
      return { success: false, error: `Session not found: '${sessionId}'.` }
    }

    if (!session.running || session.ended || !session.pty) {
      return { success: true, message: 'Session is not running.' }
    }

    session.status = 'terminated'

    if (session.timer) {
      clearTimeout(session.timer)
      session.timer = null
    }
    if (session.batchTimer) {
      clearTimeout(session.batchTimer)
      session.batchTimer = null
    }

    await terminateProcessTree(session.pty, session.pid)

    try {
      session.pty.kill('SIGTERM')
    } catch {
      // Already dead
    }

    this.handleProcessExit(session, null, 'SIGTERM')

    return { success: true }
  }

  /**
   * Forcibly terminates all currently active sessions (e.g. on application exit)
   */
  public async killAllSessions(): Promise<TerminalKillAllResult> {
    const activeSessions = Array.from(this.sessions.values()).filter((s) => s.running && s.pty)
    await Promise.all(
      activeSessions.map(async (session) => {
        session.status = 'terminated'
        if (session.timer) {
          clearTimeout(session.timer)
          session.timer = null
        }
        if (session.batchTimer) {
          clearTimeout(session.batchTimer)
          session.batchTimer = null
        }
        await terminateProcessTree(session.pty, session.pid)
        try {
          session.pty.kill('SIGTERM')
        } catch {
          // Ignore
        }
        this.handleProcessExit(session, null, 'SIGTERM')
      })
    )
    return { success: true, killedCount: activeSessions.length }
  }

  /**
   * Returns a specific session record by ID
   */
  public getSession(sessionId: string): TerminalSession | undefined {
    return this.sessions.get(sessionId)
  }

  /**
   * Lists all tracked sessions and their metadata
   */
  public listSessions(): TerminalSessionInfo[] {
    return Array.from(this.sessions.values()).map((s) => ({
      sessionId: s.id,
      command: s.command,
      cwd: s.cwd,
      source: s.source,
      status: s.status,
      running: s.running,
      exitCode: s.exitCode,
      timedOut: s.timedOut,
      createdAt: s.createdAt,
      pid: s.pid
    }))
  }

  /**
   * Removes a completed session from memory
   */
  public removeCompletedSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    if (session && !session.running) {
      if (session.batchTimer) {
        clearTimeout(session.batchTimer)
        session.batchTimer = null
      }
      session.outputRingBuffer.clear()
      return this.sessions.delete(sessionId)
    }
    return false
  }

  /**
   * Cleans up all terminated/completed sessions from memory
   */
  public clearAllCompletedSessions(): number {
    let clearedCount = 0
    for (const [id, session] of this.sessions.entries()) {
      if (!session.running) {
        if (session.batchTimer) {
          clearTimeout(session.batchTimer)
          session.batchTimer = null
        }
        session.outputRingBuffer.clear()
        this.sessions.delete(id)
        clearedCount++
      }
    }
    return clearedCount
  }

  /**
   * Internal handler for incoming PTY data chunks.
   * Feeds the ring buffer and batches output before IPC broadcast.
   */
  public handleSessionData(session: TerminalSession, data: string): void {
    if (!data || session.ended) return

    session.totalBytesProcessed += data.length

    // Append to bounded ring buffer (amortized O(1))
    session.outputRingBuffer.write(data)

    // Coalesce chunk into pending batch
    session.pendingOutputChunks.push(data)
    session.pendingOutputSize += data.length

    // If batch size threshold reached, flush immediately
    if (session.pendingOutputSize >= this.maxBatchSize) {
      this.flushSessionBatch(session, 'threshold')
      return
    }

    // Otherwise schedule frame-aligned flush if timer not active
    if (!session.batchTimer) {
      session.batchTimer = setTimeout(() => {
        this.flushSessionBatch(session, 'timer')
      }, this.batchWindowMs)
    }
  }

  /**
   * Flushes any pending batched output chunks for a session
   */
  public flushSessionBatch(session: TerminalSession, _reason: string = 'manual'): void {
    if (session.batchTimer) {
      clearTimeout(session.batchTimer)
      session.batchTimer = null
    }

    if (session.pendingOutputChunks.length === 0) return

    const batchedData = session.pendingOutputChunks.join('')
    session.pendingOutputChunks = []
    session.pendingOutputSize = 0
    session.totalBatchesFlushed++

    // Synchronize retainedStdout with bounded ring buffer
    session.retainedStdout = session.outputRingBuffer.toString()

    const dataEvent: TerminalStreamDataEvent = {
      sessionId: session.id,
      type: 'stdout',
      data: batchedData
    }
    this.emit('data', dataEvent)
  }

  /**
   * Flushes pending output for a specific session by ID
   */
  public flushSession(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session) {
      this.flushSessionBatch(session, 'manual')
    }
  }

  /**
   * Diagnostic statistics for a session's batching and buffer health
   */
  public getSessionDiagnostics(sessionId: string): {
    pendingOutputChunks: number
    pendingOutputSize: number
    ringBufferSize: number
    ringBufferCapacity: number
    ringBufferEvictedBytes: number
    totalBatchesFlushed: number
    totalBytesProcessed: number
  } | null {
    const session = this.sessions.get(sessionId)
    if (!session) return null
    return {
      pendingOutputChunks: session.pendingOutputChunks.length,
      pendingOutputSize: session.pendingOutputSize,
      ringBufferSize: session.outputRingBuffer.size(),
      ringBufferCapacity: session.outputRingBuffer.getCapacity(),
      ringBufferEvictedBytes: session.outputRingBuffer.getEvictedBytes(),
      totalBatchesFlushed: session.totalBatchesFlushed,
      totalBytesProcessed: session.totalBytesProcessed
    }
  }
}
