/**
 * Indexing Profiler for Live Electron App
 * Measures real-world workspace indexing and offline reconciliation performance:
 *   - Filesystem & IPC wait time (readTree, readWorkspaceFile, load/saveWorkspaceIndex)
 *   - Reconciliation time (metadata comparisons, set diffing)
 *   - Parsing and hashing CPU time (DependencyAnalyzer.analyzeFileContent, computeContentHash)
 *   - Yield time (macro-task yields to Electron event loop)
 *   - Renderer thread contention: long tasks (>50 ms) via PerformanceObserver
 *   - Delayed animation frames (requestAnimationFrame frame lag / dropped frames)
 *
 * Disabled by default. Enabled strictly via `profileIndexing: true` config or `enableProfiling(true)`.
 */

export interface IndexingProfileSummary {
  sessionName: string
  workspaceRoot: string
  totalDurationMs: number
  fsIpcWaitMs: number
  reconciliationMs: number
  parsingHashingMs: number
  yieldWaitMs: number
  unaccountedMs: number
  longTasksCount: number
  totalLongTaskDurationMs: number
  maxLongTaskMs: number
  delayedFramesCount: number
  maxFrameDelayMs: number
  filesIndexedCount: number
  filesReadCount: number
}

export interface IndexingHooks {
  onIndexFile?: (relPath: string, parseDurationMs: number) => void
  onYield?: (yieldDurationMs: number) => void
}

/**
 * An individual profiling session measuring a specific phase (e.g., initializeWorkspaceIndex or reconcileRestoredIndex).
 */
export class ProfilingSession {
  public sessionName: string
  public workspaceRoot: string
  private startTime: number = 0
  private endTime: number = 0

  public fsIpcWaitMs: number = 0
  public reconciliationMs: number = 0
  public parsingHashingMs: number = 0
  public yieldWaitMs: number = 0
  public filesIndexedCount: number = 0
  public filesReadCount: number = 0

  private longTasksCount: number = 0
  private totalLongTaskDurationMs: number = 0
  private maxLongTaskMs: number = 0

  private delayedFramesCount: number = 0
  private maxFrameDelayMs: number = 0

  private performanceObserver: PerformanceObserver | null = null
  private rafId: number | null = null
  private lastRafTime: number | null = null
  private isEnded: boolean = false
  private summary: IndexingProfileSummary | null = null

  constructor(sessionName: string, workspaceRoot: string) {
    this.sessionName = sessionName
    this.workspaceRoot = workspaceRoot
    this.startTime = typeof performance !== 'undefined' ? performance.now() : Date.now()
    this.startLongTaskObserver()
    this.startFrameMonitoring()
  }

  public recordFsIpcTime(durationMs: number): void {
    if (this.isEnded || durationMs <= 0) return
    this.fsIpcWaitMs += durationMs
  }

  public recordReconciliationTime(durationMs: number): void {
    if (this.isEnded || durationMs <= 0) return
    this.reconciliationMs += durationMs
  }

  public recordParsingHashingTime(durationMs: number): void {
    if (this.isEnded || durationMs <= 0) return
    this.parsingHashingMs += durationMs
  }

  public recordYieldTime(durationMs: number): void {
    if (this.isEnded || durationMs <= 0) return
    this.yieldWaitMs += durationMs
  }

  public incrementFilesIndexed(count = 1): void {
    if (this.isEnded) return
    this.filesIndexedCount += count
  }

  public incrementFilesRead(count = 1): void {
    if (this.isEnded) return
    this.filesReadCount += count
  }

  /**
   * Helper to measure any synchronous block as reconciliation time.
   */
  public measureReconciliation<T>(fn: () => T): T {
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now()
    try {
      return fn()
    } finally {
      const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now()
      this.recordReconciliationTime(t1 - t0)
    }
  }

  /**
   * Helper to measure any async IPC / filesystem operation.
   */
  public async timeFsIpc<T>(fn: () => Promise<T>): Promise<T> {
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now()
    try {
      return await fn()
    } finally {
      const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now()
      this.recordFsIpcTime(t1 - t0)
    }
  }

  /**
   * Listens for Chromium long tasks (>50 ms) on the renderer thread.
   */
  private startLongTaskObserver(): void {
    if (typeof PerformanceObserver !== 'undefined') {
      try {
        this.performanceObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.entryType === 'longtask') {
              this.longTasksCount++
              this.totalLongTaskDurationMs += entry.duration
              if (entry.duration > this.maxLongTaskMs) {
                this.maxLongTaskMs = entry.duration
              }
            }
          }
        })
        this.performanceObserver.observe({ entryTypes: ['longtask'] })
      } catch {
        // PerformanceObserver or 'longtask' entry type unavailable in this environment (e.g. Node tests)
        this.performanceObserver = null
      }
    }
  }

  /**
   * Monitors requestAnimationFrame delta to detect frame lag or dropped frames during indexing.
   */
  private startFrameMonitoring(): void {
    if (typeof requestAnimationFrame === 'function') {
      const onFrame = (now: number) => {
        if (this.lastRafTime !== null) {
          const delta = now - this.lastRafTime
          // A standard 60 Hz frame takes ~16.7 ms. If delta > 33.3 ms, at least one visual frame was delayed/dropped.
          if (delta > 33.3) {
            this.delayedFramesCount++
            const lag = delta - 16.7
            if (lag > this.maxFrameDelayMs) {
              this.maxFrameDelayMs = lag
            }
          }
        }
        this.lastRafTime = now
        if (!this.isEnded) {
          this.rafId = requestAnimationFrame(onFrame)
        }
      }
      this.rafId = requestAnimationFrame(onFrame)
    }
  }

  private stopMonitoring(): void {
    if (this.performanceObserver) {
      try {
        this.performanceObserver.disconnect()
      } catch {
        // ignore
      }
      this.performanceObserver = null
    }

    if (this.rafId !== null && typeof cancelAnimationFrame === 'function') {
      try {
        cancelAnimationFrame(this.rafId)
      } catch {
        // ignore
      }
      this.rafId = null
    }
  }

  /**
   * Concludes the profiling session, computes metrics, and logs structured summary to DevTools console.
   */
  public end(): IndexingProfileSummary {
    if (this.isEnded && this.summary) {
      return this.summary
    }

    this.isEnded = true
    this.endTime = typeof performance !== 'undefined' ? performance.now() : Date.now()
    this.stopMonitoring()

    const totalDurationMs = Math.max(0, this.endTime - this.startTime)
    const accountedMs = this.fsIpcWaitMs + this.reconciliationMs + this.parsingHashingMs + this.yieldWaitMs
    const unaccountedMs = Math.max(0, totalDurationMs - accountedMs)

    this.summary = {
      sessionName: this.sessionName,
      workspaceRoot: this.workspaceRoot,
      totalDurationMs,
      fsIpcWaitMs: this.fsIpcWaitMs,
      reconciliationMs: this.reconciliationMs,
      parsingHashingMs: this.parsingHashingMs,
      yieldWaitMs: this.yieldWaitMs,
      unaccountedMs,
      longTasksCount: this.longTasksCount,
      totalLongTaskDurationMs: this.totalLongTaskDurationMs,
      maxLongTaskMs: this.maxLongTaskMs,
      delayedFramesCount: this.delayedFramesCount,
      maxFrameDelayMs: this.maxFrameDelayMs,
      filesIndexedCount: this.filesIndexedCount,
      filesReadCount: this.filesReadCount
    }

    this.logSummary(this.summary)
    return this.summary
  }

  public getSummary(): IndexingProfileSummary | null {
    return this.summary
  }

  /**
   * Logs structured profiling summary to the DevTools console using console.group and console.table.
   */
  private logSummary(s: IndexingProfileSummary): void {
    const pct = (val: number) =>
      s.totalDurationMs > 0 ? `${((val / s.totalDurationMs) * 100).toFixed(1)}%` : '0.0%'

    const header = `[SmartContextEngine Profiler] ${s.sessionName} for "${s.workspaceRoot}" (${s.totalDurationMs.toFixed(2)} ms)`

    if (typeof console.groupCollapsed === 'function') {
      console.groupCollapsed(header)
    } else {
      console.log(`\n=== ${header} ===`)
    }

    const tableData = [
      {
        'Metric / Phase': 'Total Wall-Clock Time',
        'Duration (ms)': Number(s.totalDurationMs.toFixed(2)),
        '% of Total': '100.0%'
      },
      {
        'Metric / Phase': 'Filesystem & IPC Wait',
        'Duration (ms)': Number(s.fsIpcWaitMs.toFixed(2)),
        '% of Total': pct(s.fsIpcWaitMs)
      },
      {
        'Metric / Phase': 'Reconciliation Diffing',
        'Duration (ms)': Number(s.reconciliationMs.toFixed(2)),
        '% of Total': pct(s.reconciliationMs)
      },
      {
        'Metric / Phase': 'Parsing & Hashing CPU',
        'Duration (ms)': Number(s.parsingHashingMs.toFixed(2)),
        '% of Total': pct(s.parsingHashingMs)
      },
      {
        'Metric / Phase': 'Event Loop Yield Wait',
        'Duration (ms)': Number(s.yieldWaitMs.toFixed(2)),
        '% of Total': pct(s.yieldWaitMs)
      },
      {
        'Metric / Phase': 'Other / Unaccounted',
        'Duration (ms)': Number(s.unaccountedMs.toFixed(2)),
        '% of Total': pct(s.unaccountedMs)
      }
    ]

    if (typeof console.table === 'function') {
      console.table(tableData)
    } else {
      for (const row of tableData) {
        console.log(`  ${row['Metric / Phase'].padEnd(25)}: ${String(row['Duration (ms)']).padStart(8)} ms (${row['% of Total']})`)
      }
    }

    console.log(
      `[UI Contention] Long Tasks (>50ms): ${s.longTasksCount} (max: ${s.maxLongTaskMs.toFixed(1)} ms, total: ${s.totalLongTaskDurationMs.toFixed(1)} ms) | ` +
      `Delayed Frames (>33ms): ${s.delayedFramesCount} (max lag: ${s.maxFrameDelayMs.toFixed(1)} ms)`
    )
    console.log(
      `[File Counts] Files Indexed: ${s.filesIndexedCount} | Files Read from Disk: ${s.filesReadCount}`
    )

    if (typeof console.groupEnd === 'function') {
      console.groupEnd()
    }
  }
}

/**
 * Top-level manager for creating and accessing profiling sessions.
 */
export class IndexingProfiler {
  private activeSessions: ProfilingSession[] = []
  private completedSummaries: IndexingProfileSummary[] = []

  public startSession(sessionName: string, workspaceRoot: string): ProfilingSession {
    const session = new ProfilingSession(sessionName, workspaceRoot)
    this.activeSessions.push(session)
    return session
  }

  public recordCompletedSummary(summary: IndexingProfileSummary): void {
    this.completedSummaries.push(summary)
  }

  public getLastSummary(): IndexingProfileSummary | null {
    if (this.completedSummaries.length === 0) return null
    return this.completedSummaries[this.completedSummaries.length - 1]
  }

  public getAllSummaries(): IndexingProfileSummary[] {
    return [...this.completedSummaries]
  }

  public clear(): void {
    this.activeSessions = []
    this.completedSummaries = []
  }
}
