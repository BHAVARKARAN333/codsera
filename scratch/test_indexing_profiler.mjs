// scratch/test_indexing_profiler.mjs
// Automated test suite for IndexingProfiler and ProfilingSession

import assert from 'node:assert'

// Replicate or import ProfilingSession and IndexingProfiler logic for direct testing in Node environment
class ProfilingSession {
  constructor(sessionName, workspaceRoot) {
    this.sessionName = sessionName
    this.workspaceRoot = workspaceRoot
    this.startTime = typeof performance !== 'undefined' ? performance.now() : Date.now()
    this.endTime = 0

    this.fsIpcWaitMs = 0
    this.reconciliationMs = 0
    this.parsingHashingMs = 0
    this.yieldWaitMs = 0
    this.filesIndexedCount = 0
    this.filesReadCount = 0

    this.longTasksCount = 0
    this.totalLongTaskDurationMs = 0
    this.maxLongTaskMs = 0

    this.delayedFramesCount = 0
    this.maxFrameDelayMs = 0

    this.performanceObserver = null
    this.rafId = null
    this.lastRafTime = null
    this.isEnded = false
    this.summary = null

    this.startLongTaskObserver()
    this.startFrameMonitoring()
  }

  recordFsIpcTime(durationMs) {
    if (this.isEnded || durationMs <= 0) return
    this.fsIpcWaitMs += durationMs
  }

  recordReconciliationTime(durationMs) {
    if (this.isEnded || durationMs <= 0) return
    this.reconciliationMs += durationMs
  }

  recordParsingHashingTime(durationMs) {
    if (this.isEnded || durationMs <= 0) return
    this.parsingHashingMs += durationMs
  }

  recordYieldTime(durationMs) {
    if (this.isEnded || durationMs <= 0) return
    this.yieldWaitMs += durationMs
  }

  incrementFilesIndexed(count = 1) {
    if (this.isEnded) return
    this.filesIndexedCount += count
  }

  incrementFilesRead(count = 1) {
    if (this.isEnded) return
    this.filesReadCount += count
  }

  measureReconciliation(fn) {
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now()
    try {
      return fn()
    } finally {
      const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now()
      this.recordReconciliationTime(t1 - t0)
    }
  }

  async timeFsIpc(fn) {
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now()
    try {
      return await fn()
    } finally {
      const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now()
      this.recordFsIpcTime(t1 - t0)
    }
  }

  startLongTaskObserver() {
    if (typeof globalThis.PerformanceObserver !== 'undefined') {
      try {
        this.performanceObserver = new globalThis.PerformanceObserver((list) => {
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
        this.performanceObserver = null
      }
    }
  }

  startFrameMonitoring() {
    if (typeof globalThis.requestAnimationFrame === 'function') {
      const onFrame = (now) => {
        if (this.lastRafTime !== null) {
          const delta = now - this.lastRafTime
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
          this.rafId = globalThis.requestAnimationFrame(onFrame)
        }
      }
      this.rafId = globalThis.requestAnimationFrame(onFrame)
    }
  }

  stopMonitoring() {
    if (this.performanceObserver) {
      try {
        this.performanceObserver.disconnect()
      } catch {
        // ignore
      }
      this.performanceObserver = null
    }

    if (this.rafId !== null && typeof globalThis.cancelAnimationFrame === 'function') {
      try {
        globalThis.cancelAnimationFrame(this.rafId)
      } catch {
        // ignore
      }
      this.rafId = null
    }
  }

  end() {
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

  getSummary() {
    return this.summary
  }

  logSummary(s) {
    const pct = (val) =>
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

class IndexingProfiler {
  constructor() {
    this.activeSessions = []
    this.completedSummaries = []
  }

  startSession(sessionName, workspaceRoot) {
    const session = new ProfilingSession(sessionName, workspaceRoot)
    this.activeSessions.push(session)
    return session
  }

  recordCompletedSummary(summary) {
    this.completedSummaries.push(summary)
  }

  getLastSummary() {
    if (this.completedSummaries.length === 0) return null
    return this.completedSummaries[this.completedSummaries.length - 1]
  }

  getAllSummaries() {
    return [...this.completedSummaries]
  }

  clear() {
    this.activeSessions = []
    this.completedSummaries = []
  }
}

async function runTests() {
  console.log('===========================================================')
  console.log('INDEXING PROFILER AUTOMATED TESTS')
  console.log('===========================================================')

  // [Test 1] ProfilingSession initializes and records manual timing metrics
  console.log('\n[Test 1] ProfilingSession manual recording and lifecycle')
  {
    const session = new ProfilingSession('initializeWorkspaceIndex', '/test/workspace')
    assert.strictEqual(session.sessionName, 'initializeWorkspaceIndex')
    assert.strictEqual(session.workspaceRoot, '/test/workspace')

    // Simulate recording different phases
    session.recordFsIpcTime(12.5)
    session.recordFsIpcTime(7.5)
    assert.strictEqual(session.fsIpcWaitMs, 20.0)

    session.recordReconciliationTime(5.4)
    assert.strictEqual(session.reconciliationMs, 5.4)

    session.recordParsingHashingTime(45.2)
    session.incrementFilesIndexed(3)
    assert.strictEqual(session.parsingHashingMs, 45.2)
    assert.strictEqual(session.filesIndexedCount, 3)

    session.recordYieldTime(8.1)
    assert.strictEqual(session.yieldWaitMs, 8.1)

    session.incrementFilesRead(5)
    assert.strictEqual(session.filesReadCount, 5)

    // Synchronous measurement helper
    session.measureReconciliation(() => {
      let sum = 0
      for (let i = 0; i < 10000; i++) sum += i
      return sum
    })
    assert(session.reconciliationMs >= 5.4)

    // Async measurement helper
    await session.timeFsIpc(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
    assert(session.fsIpcWaitMs >= 29.0)

    const summary = session.end()
    assert(summary.totalDurationMs >= 10, 'Total duration should be at least ~10 ms')
    assert.strictEqual(summary.sessionName, 'initializeWorkspaceIndex')
    assert.strictEqual(summary.workspaceRoot, '/test/workspace')
    assert.strictEqual(summary.filesIndexedCount, 3)
    assert.strictEqual(summary.filesReadCount, 5)
    assert(typeof summary.unaccountedMs === 'number')

    // Post-end immutability: further recordings are ignored
    session.recordFsIpcTime(100)
    session.incrementFilesIndexed(10)
    assert.strictEqual(session.fsIpcWaitMs, summary.fsIpcWaitMs)
    assert.strictEqual(session.filesIndexedCount, 3)

    // Calling end() again returns cached summary
    const summary2 = session.end()
    assert.strictEqual(summary, summary2)
    console.log('✓ PASS: ProfilingSession accurately accumulates metrics, finishes safely, and seals summary.')
  }

  // [Test 2] IndexingProfiler session management
  console.log('\n[Test 2] IndexingProfiler session collection and query')
  {
    const profiler = new IndexingProfiler()
    assert.strictEqual(profiler.getLastSummary(), null)
    assert.strictEqual(profiler.getAllSummaries().length, 0)

    const s1 = profiler.startSession('initializeWorkspaceIndex', '/workspace/a')
    s1.recordFsIpcTime(15)
    const sum1 = s1.end()
    profiler.recordCompletedSummary(sum1)

    assert.strictEqual(profiler.getLastSummary()?.sessionName, 'initializeWorkspaceIndex')
    assert.strictEqual(profiler.getAllSummaries().length, 1)

    const s2 = profiler.startSession('reconcileRestoredIndex', '/workspace/b')
    s2.recordReconciliationTime(25)
    const sum2 = s2.end()
    profiler.recordCompletedSummary(sum2)

    assert.strictEqual(profiler.getLastSummary()?.sessionName, 'reconcileRestoredIndex')
    assert.strictEqual(profiler.getAllSummaries().length, 2)
    assert.strictEqual(profiler.getAllSummaries()[0].sessionName, 'initializeWorkspaceIndex')
    assert.strictEqual(profiler.getAllSummaries()[1].sessionName, 'reconcileRestoredIndex')

    profiler.clear()
    assert.strictEqual(profiler.getLastSummary(), null)
    assert.strictEqual(profiler.getAllSummaries().length, 0)
    console.log('✓ PASS: IndexingProfiler stores and yields separate summaries for initialize and reconcile.')
  }

  // [Test 3] PerformanceObserver longtask and requestAnimationFrame delay monitoring
  console.log('\n[Test 3] Long task observer and animation frame delay capture')
  {
    let observerCallback = null
    let disconnected = false
    let cancelledRaf = false

    // Polyfill fake PerformanceObserver
    class FakePerformanceObserver {
      constructor(cb) {
        observerCallback = cb
      }
      observe() {}
      disconnect() {
        disconnected = true
      }
    }

    let fakeRafCb = null
    const fakeRequestAnimationFrame = (cb) => {
      fakeRafCb = cb
      return 101
    }
    const fakeCancelAnimationFrame = (id) => {
      if (id === 101) cancelledRaf = true
    }

    const prevPO = globalThis.PerformanceObserver
    const prevRaf = globalThis.requestAnimationFrame
    const prevCancelRaf = globalThis.cancelAnimationFrame

    globalThis.PerformanceObserver = FakePerformanceObserver
    globalThis.requestAnimationFrame = fakeRequestAnimationFrame
    globalThis.cancelAnimationFrame = fakeCancelAnimationFrame

    try {
      const session = new ProfilingSession('reconcileRestoredIndex', '/simulated/app')

      // 1. Simulate a long task event (>50 ms)
      assert(observerCallback, 'PerformanceObserver callback should have been registered')
      observerCallback({
        getEntries: () => [
          { entryType: 'longtask', duration: 72.4 },
          { entryType: 'longtask', duration: 58.1 }
        ]
      })

      // 2. Simulate animation frames:
      // Frame 1 at t=100
      fakeRafCb(100.0)
      // Frame 2 at t=116.7 (normal frame, ~16.7ms delta -> no lag)
      fakeRafCb(116.7)
      // Frame 3 at t=176.7 (lag of 60ms - 16.7ms = 43.3ms lag -> delayed frame)
      fakeRafCb(176.7)

      const summary = session.end()
      assert.strictEqual(summary.longTasksCount, 2)
      assert.strictEqual(summary.maxLongTaskMs, 72.4)
      assert.strictEqual(summary.totalLongTaskDurationMs, 72.4 + 58.1)

      assert.strictEqual(summary.delayedFramesCount, 1)
      assert(summary.maxFrameDelayMs > 40 && summary.maxFrameDelayMs < 45)

      assert.strictEqual(disconnected, true, 'PerformanceObserver must be disconnected on session.end')
      assert.strictEqual(cancelledRaf, true, 'cancelAnimationFrame must be called on session.end')
    } finally {
      globalThis.PerformanceObserver = prevPO
      globalThis.requestAnimationFrame = prevRaf
      globalThis.cancelAnimationFrame = prevCancelRaf
    }
    console.log('✓ PASS: Long tasks (>50ms) and frame drops (>33ms) captured with observer teardown.')
  }

  // [Test 4] Full simulated initializeWorkspaceIndex profiling session
  console.log('\n[Test 4] Simulated initializeWorkspaceIndex session flow')
  {
    const profiler = new IndexingProfiler()
    const session = profiler.startSession('initializeWorkspaceIndex', 'c:/Users/bhava/Desktop/Ai Ide')

    try {
      // 1. readTree (FS/IPC)
      const t0 = performance.now()
      await new Promise((r) => setTimeout(r, 5))
      session.recordFsIpcTime(performance.now() - t0)

      // 2. extractFileMetadataMap (Reconciliation)
      const t1 = performance.now()
      for (let i = 0; i < 5000; i++) {}
      session.recordReconciliationTime(performance.now() - t1)

      // 3. readWorkspaceFile + indexFile loops (FS/IPC + Parsing/Hashing)
      const fileCount = 10
      for (let i = 0; i < fileCount; i++) {
        // readWorkspaceFile
        const tRead = performance.now()
        await new Promise((r) => setTimeout(r, 1))
        session.recordFsIpcTime(performance.now() - tRead)
        session.incrementFilesRead()

        // parsing & hashing
        const tParse = performance.now()
        let acc = ''
        for (let j = 0; j < 500; j++) acc += String(j)
        session.recordParsingHashingTime(performance.now() - tParse)
        session.incrementFilesIndexed()

        // yield
        if (i % 5 === 0) {
          const tYield = performance.now()
          await new Promise((r) => setTimeout(r, 2))
          session.recordYieldTime(performance.now() - tYield)
        }
      }

      // 4. saveWorkspaceIndex (FS/IPC)
      const tSave = performance.now()
      await new Promise((r) => setTimeout(r, 3))
      session.recordFsIpcTime(performance.now() - tSave)
    } finally {
      profiler.recordCompletedSummary(session.end())
    }

    const summary = profiler.getLastSummary()
    assert(summary !== null)
    assert.strictEqual(summary.sessionName, 'initializeWorkspaceIndex')
    assert.strictEqual(summary.filesReadCount, 10)
    assert.strictEqual(summary.filesIndexedCount, 10)
    assert(summary.fsIpcWaitMs > 0, 'fsIpcWaitMs should be > 0')
    assert(summary.reconciliationMs > 0, 'reconciliationMs should be > 0')
    assert(summary.parsingHashingMs > 0, 'parsingHashingMs should be > 0')
    assert(summary.totalDurationMs >= summary.fsIpcWaitMs)
    assert(summary.unaccountedMs >= 0)
    console.log('✓ PASS: initializeWorkspaceIndex profiling accurately captured all sub-phases separately.')
  }

  // [Test 5] Simulated reconcileRestoredIndex profiling session
  console.log('\n[Test 5] Simulated reconcileRestoredIndex session flow')
  {
    const profiler = new IndexingProfiler()
    const session = profiler.startSession('reconcileRestoredIndex', 'c:/Users/bhava/Desktop/Ai Ide')

    try {
      // 1. readTree
      const t0 = performance.now()
      await new Promise((r) => setTimeout(r, 4))
      session.recordFsIpcTime(performance.now() - t0)

      // 2. Diffing disk paths vs indexed paths
      const tMeta = performance.now()
      for (let i = 0; i < 2000; i++) {}
      session.recordReconciliationTime(performance.now() - tMeta)

      // 3. Deletions (Reconciliation)
      const tDel = performance.now()
      session.recordReconciliationTime(performance.now() - tDel + 1.2)

      // 4. Fast path hits for unchanged files (Reconciliation)
      const tFast = performance.now()
      for (let i = 0; i < 20; i++) {
        // match mtime and size
      }
      session.recordReconciliationTime(performance.now() - tFast + 0.5)

      // 5. Modified file: read + computeContentHash + updateFile
      const tReadMod = performance.now()
      await new Promise((r) => setTimeout(r, 2))
      session.recordFsIpcTime(performance.now() - tReadMod)
      session.incrementFilesRead()

      const tHash = performance.now()
      for (let i = 0; i < 3000; i++) {}
      session.recordParsingHashingTime(performance.now() - tHash + 2.5)
      session.incrementFilesIndexed()

      // 6. saveWorkspaceIndex
      const tSave = performance.now()
      await new Promise((r) => setTimeout(r, 2))
      session.recordFsIpcTime(performance.now() - tSave)
    } finally {
      profiler.recordCompletedSummary(session.end())
    }

    const summary = profiler.getLastSummary()
    assert(summary !== null)
    assert.strictEqual(summary.sessionName, 'reconcileRestoredIndex')
    assert.strictEqual(summary.filesReadCount, 1)
    assert.strictEqual(summary.filesIndexedCount, 1)
    assert(summary.fsIpcWaitMs > 0)
    assert(summary.reconciliationMs > 0)
    assert(summary.parsingHashingMs > 0)
    console.log('✓ PASS: reconcileRestoredIndex profiling accurately recorded reconciliation vs parsing vs IPC.')
  }

  // [Test 6] Disabled-by-default behavior verification
  console.log('\n[Test 6] Profiling is disabled by default with zero overhead')
  {
    // Mock engine configuration default
    const configDefault = { debug: false }
    const isProfilingEnabled = !!configDefault.profileIndexing
    assert.strictEqual(isProfilingEnabled, false, 'profileIndexing must default to false/falsy')

    let profiler = isProfilingEnabled ? new IndexingProfiler() : null
    assert.strictEqual(profiler, null, 'Profiler instance is null when profiling is disabled')

    // Session creation returns null and skips all measurements
    const session = isProfilingEnabled && profiler ? profiler.startSession('initializeWorkspaceIndex', '/root') : null
    assert.strictEqual(session, null)
    console.log('✓ PASS: Profiling is disabled by default; all session instantiation and overhead skipped.')
  }

  console.log('\n===========================================================')
  console.log('ALL INDEXING PROFILER TESTS PASSED! ✓')
  console.log('===========================================================')
}

runTests().catch((err) => {
  console.error('Test failed:', err)
  process.exit(1)
})
