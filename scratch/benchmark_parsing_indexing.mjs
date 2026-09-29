/**
 * Focused Performance Benchmark: Production Dependency Parsing & Workspace Indexing
 * Measures baseline-relevant timings for:
 *   1. Files with no imports/exports/require (fast-path)
 *   2. Typical TypeScript/ESM source files (components, services, require, multiline)
 *   3. Large source files (2,000 to 6,000 lines)
 *   4. End-to-end workspace indexing (cold vs warm / fast-path)
 */

import { performance } from 'node:perf_hooks'
import { DependencyAnalyzer } from '../src/renderer/src/services/agent/dependencyAnalyzer.ts'

// =========================================================================
// Benchmark Utility Functions
// =========================================================================

function computeStats(timingsMs) {
  const sorted = [...timingsMs].sort((a, b) => a - b)
  const count = sorted.length
  const sum = sorted.reduce((acc, t) => acc + t, 0)
  const avg = sum / count
  const median = count % 2 === 0
    ? (sorted[count / 2 - 1] + sorted[count / 2]) / 2
    : sorted[Math.floor(count / 2)]
  const p95 = sorted[Math.floor(count * 0.95)]
  const min = sorted[0]
  const max = sorted[count - 1]
  const throughput = 1000 / avg

  return {
    count,
    totalMs: sum,
    avgMs: avg,
    avgUs: avg * 1000,
    medianMs: median,
    medianUs: median * 1000,
    p95Ms: p95,
    minMs: min,
    maxMs: max,
    throughputFilesPerSec: Math.round(throughput)
  }
}

function formatUsOrMs(ms) {
  if (ms < 0.01) {
    return `${(ms * 1000).toFixed(1)} µs`
  }
  if (ms < 1) {
    return `${(ms * 1000).toFixed(0)} µs (${ms.toFixed(3)} ms)`
  }
  return `${ms.toFixed(3)} ms`
}

function computeContentHash(content) {
  let h1 = 0xdeadbeef ^ 0
  let h2 = 0x41c6ce57 ^ 0
  for (let i = 0; i < content.length; i++) {
    const ch = content.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(16, '0')
}

// Lightweight simulation of CodebaseIndex indexing algorithm wrapping production DependencyAnalyzer
class BenchmarkCodebaseIndex {
  constructor(depAnalyzer) {
    this.dependencyAnalyzer = depAnalyzer
    this.entries = new Map()
    this.reverseDependencies = new Map()
  }

  normalizePath(p) {
    return p.replace(/\\/g, '/').replace(/^\/+/, '')
  }

  normalizeKey(p) {
    return this.normalizePath(p).toLowerCase()
  }

  indexFile(filePath, content, allWorkspaceFiles, mtimeMs, fileSize) {
    const normPath = this.normalizePath(filePath)
    const key = this.normalizeKey(filePath)
    const ext = normPath.split('.').pop()?.toLowerCase() || ''
    const isCode = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(ext)

    let imports = []
    let resolvedDependencies = []
    let unresolvedImports = []
    let exports = []
    let declaredSymbols = []

    if (isCode) {
      const depInfo = this.dependencyAnalyzer.analyzeFileContent(
        normPath,
        content,
        allWorkspaceFiles
      )
      imports = depInfo.imports.map((i) => i.specifier)
      resolvedDependencies = depInfo.imports
        .map((i) => i.resolvedPath)
        .filter((p) => typeof p === 'string' && p.length > 0)
      unresolvedImports = depInfo.unresolvedImports
      exports = depInfo.exports
      declaredSymbols = exports.map((e) => e.name)
    }

    const hash = computeContentHash(content)
    const entry = {
      normalizedPath: normPath,
      extension: ext,
      imports,
      resolvedDependencies,
      unresolvedImports,
      exports,
      declaredSymbols,
      contentHash: hash,
      fileSize: fileSize !== undefined ? fileSize : content.length,
      mtimeMs,
      lastIndexed: Date.now()
    }

    // Register reverse dependencies
    for (const dep of resolvedDependencies) {
      const depKey = this.normalizeKey(dep)
      let set = this.reverseDependencies.get(depKey)
      if (!set) {
        set = new Set()
        this.reverseDependencies.set(depKey, set)
      }
      set.add(key)
    }

    this.entries.set(key, entry)
    return entry
  }
}

// =========================================================================
// File Fixture Generators
// =========================================================================

function generateNoImportFile(linesCount) {
  const lines = [
    '// Mathematical constants and algorithmic utility',
    'const BASE_RADIX = 16;',
    'const EPSILON = 0.000001;'
  ]
  for (let i = 0; i < linesCount - 3; i++) {
    lines.push(`const factor_${i} = Math.sin(${i}) * BASE_RADIX + EPSILON;`)
  }
  return lines.join('\n')
}

function generateTypicalComponent() {
  return `
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { ChevronRight, Settings, AlertCircle } from 'lucide-react';
import { formatTime, sanitizeString } from '../utils/formatter';
import { UserProfile, SessionConfig } from '../types/session';

interface Props {
  sessionId: string;
  config: SessionConfig;
  onUpdate: (user: UserProfile) => void;
}

export const SessionHeader: React.FC<Props> = ({ sessionId, config, onUpdate }) => {
  const [active, setActive] = useState(false);
  const formatted = useMemo(() => formatTime(Date.now()), []);

  const handleClick = useCallback(() => {
    setActive(!active);
    onUpdate({ id: sessionId, name: sanitizeString(config.name) });
  }, [active, sessionId, config, onUpdate]);

  return (
    <div className="header-container">
      <h1>Session {sessionId}</h1>
      <span className="timestamp">{formatted}</span>
      <button onClick={handleClick}>Toggle</button>
    </div>
  );
};

export default SessionHeader;
`.trim()
}

function generateTypicalService() {
  return `
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Logger } from '../logging/logger';
import {
  ConfigOptions,
  ValidationResult,
  DEFAULT_TIMEOUT
} from '../common/types';
const { createHash } = require('node:crypto');

export interface ServiceState {
  isInitialized: boolean;
  activePath: string | null;
}

export class WorkspaceManager {
  private logger = new Logger('WorkspaceManager');
  private state: ServiceState = { isInitialized: false, activePath: null };

  constructor(private basePath: string, private options: ConfigOptions = {}) {}

  public initialize(configPath: string): ValidationResult {
    const fullPath = path.resolve(this.basePath, configPath);
    try {
      const raw = readFileSync(fullPath, 'utf8');
      const hash = createHash('sha256').update(raw).digest('hex');
      this.state.isInitialized = true;
      this.state.activePath = fullPath;
      this.logger.info('Initialized with hash: ' + hash);
      return { success: true, hash };
    } catch (err) {
      this.logger.error('Failed to initialize', err);
      return { success: false, error: String(err) };
    }
  }

  public getActive(): string | null {
    return this.state.activePath;
  }
}
`.trim()
}

function generateLargeSourceFile(linesCount) {
  const lines = [
    'import { useState, useEffect } from "react";',
    'import { HelperA, HelperB, HelperC } from "../utils/helpers";',
    'import { Logger } from "../logging/logger";',
    'import {',
    '  TypeOne,',
    '  TypeTwo,',
    '  TypeThree,',
    '  TypeFour',
    '} from "../types/models";',
    'const crypto = require("crypto");',
    'export const MODULE_VERSION = "2.4.0";',
    'export const BUILD_NUMBER = 402;'
  ]

  const funcsToGenerate = Math.floor((linesCount - lines.length) / 8)
  for (let i = 0; i < funcsToGenerate; i++) {
    lines.push(`export function calculateMetricsBlock_${i}(input: TypeOne): TypeTwo {`)
    lines.push(`  const hash = crypto.createHash("md5").update(String(input.id)).digest("hex");`)
    lines.push(`  const a = HelperA(input.score + ${i});`)
    lines.push(`  const b = HelperB(a, "${i}");`)
    lines.push(`  if (input.score > 100) {`)
    lines.push(`    return { valid: true, code: ${i}, tag: hash, score: b };`)
    lines.push(`  }`)
    lines.push(`  return { valid: false, code: -1, tag: "invalid", score: a };`)
    lines.push(`}`)
  }

  lines.push('export default calculateMetricsBlock_0;')
  return lines.join('\n')
}

// =========================================================================
// Benchmark Runner
// =========================================================================

async function runBenchmarks() {
  console.log('===========================================================================')
  console.log('   PRODUCTION DEPENDENCY PARSING & WORKSPACE INDEXING BENCHMARK')
  console.log('===========================================================================')
  console.log(`Node Environment: Node ${process.version} (${process.arch})`)
  console.log(`High-Resolution Timer: performance.now()`)
  console.log('---------------------------------------------------------------------------\n')

  const analyzer = new DependencyAnalyzer()
  const workspaceFiles = [
    'src/utils/math.ts',
    'src/utils/formatter.ts',
    'src/utils/helpers.ts',
    'src/types/session.ts',
    'src/common/types.ts',
    'src/types/models.ts',
    'src/logging/logger.ts',
    'src/circle.ts',
    'src/components/SessionHeader.tsx'
  ]

  // -------------------------------------------------------------------------
  // Part 1: Dependency Parsing by File Category
  // -------------------------------------------------------------------------
  console.log('PART 1: DEPENDENCY PARSING (DependencyAnalyzer.analyzeFileContent)')
  console.log('===========================================================================')

  const testCases = [
    {
      category: 'No Imports (Small)',
      path: 'src/constants/mathSmall.ts',
      content: generateNoImportFile(20),
      iterations: 2000
    },
    {
      category: 'No Imports (Medium)',
      path: 'src/constants/lookupTable.ts',
      content: generateNoImportFile(500),
      iterations: 1500
    },
    {
      category: 'No Imports (Large)',
      path: 'src/constants/hugeMatrix.ts',
      content: generateNoImportFile(2500),
      iterations: 1000
    },
    {
      category: 'Typical ESM Component',
      path: 'src/components/SessionHeader.tsx',
      content: generateTypicalComponent(),
      iterations: 1500
    },
    {
      category: 'Typical Service (Multiline + CJS)',
      path: 'src/services/WorkspaceManager.ts',
      content: generateTypicalService(),
      iterations: 1500
    },
    {
      category: 'Large Source File (~2,000 lines)',
      path: 'src/services/MetricsCalculator.ts',
      content: generateLargeSourceFile(2000),
      iterations: 200
    },
    {
      category: 'Very Large Source File (~6,000 lines)',
      path: 'src/services/DataSchemaValidator.ts',
      content: generateLargeSourceFile(6000),
      iterations: 100
    }
  ]

  const results = []

  for (const tc of testCases) {
    const sizeBytes = Buffer.byteLength(tc.content, 'utf8')
    const sizeKb = (sizeBytes / 1024).toFixed(2)
    const lineCount = tc.content.split(/\r?\n/).length

    // Warm-up JIT
    for (let w = 0; w < 30; w++) {
      analyzer.invalidateFile(tc.path)
      analyzer.analyzeFileContent(tc.path, tc.content, workspaceFiles)
    }

    const timings = []

    for (let i = 0; i < tc.iterations; i++) {
      // Invalidate cache before each iteration to measure pure uncached parsing throughput
      analyzer.invalidateFile(tc.path)

      const start = performance.now()
      analyzer.analyzeFileContent(tc.path, tc.content, workspaceFiles)
      const end = performance.now()
      timings.push(end - start)
    }

    const stats = computeStats(timings)
    results.push({ ...tc, sizeBytes, sizeKb, lineCount, stats })

    console.log(`[Category: ${tc.category}]`)
    console.log(`  File Path:      ${tc.path}`)
    console.log(`  File Size:      ${sizeBytes.toLocaleString()} bytes (${sizeKb} KB) | ${lineCount.toLocaleString()} lines`)
    console.log(`  Iterations:     ${tc.iterations.toLocaleString()} runs`)
    console.log(`  Average Time:   ${formatUsOrMs(stats.avgMs)}`)
    console.log(`  Median Time:    ${formatUsOrMs(stats.medianMs)}`)
    console.log(`  p95 Time:       ${formatUsOrMs(stats.p95Ms)}`)
    console.log(`  Min / Max:      ${formatUsOrMs(stats.minMs)} / ${formatUsOrMs(stats.maxMs)}`)
    console.log(`  Throughput:     ${stats.throughputFilesPerSec.toLocaleString()} files/sec`)
    console.log('')
  }

  // -------------------------------------------------------------------------
  // Part 2: Workspace Indexing Benchmark (CodebaseIndex Simulation)
  // -------------------------------------------------------------------------
  console.log('\nPART 2: WORKSPACE INDEXING BENCHMARK (CodebaseIndex.buildIndex)')
  console.log('===========================================================================')

  const workspaceProfiles = [
    { name: 'Small Workspace (50 files)', totalFiles: 50, iterations: 20 },
    { name: 'Medium Workspace (250 files)', totalFiles: 250, iterations: 10 },
    { name: 'Large Workspace (1,000 files)', totalFiles: 1000, iterations: 5 }
  ]

  for (const wp of workspaceProfiles) {
    // Generate synthetic workspace files matching standard project distribution:
    // 60% typical source files, 30% files without imports, 10% large source files
    const files = []
    for (let f = 0; f < wp.totalFiles; f++) {
      const rand = f % 10
      let relPath, content
      if (rand < 3) {
        relPath = `src/constants/data_${f}.ts`
        content = generateNoImportFile(100)
      } else if (rand < 9) {
        relPath = `src/components/Component_${f}.tsx`
        content = generateTypicalComponent()
      } else {
        relPath = `src/services/Service_${f}.ts`
        content = generateLargeSourceFile(800)
      }
      files.push({ relPath, content })
    }

    const allPaths = files.map((f) => f.relPath)
    const totalWorkspaceBytes = files.reduce((acc, f) => acc + Buffer.byteLength(f.content, 'utf8'), 0)
    const totalWorkspaceKb = (totalWorkspaceBytes / 1024).toFixed(1)

    // Benchmark Cold Workspace Indexing
    const coldTimings = []
    for (let it = 0; it < wp.iterations; it++) {
      const idxAnalyzer = new DependencyAnalyzer()
      const indexer = new BenchmarkCodebaseIndex(idxAnalyzer)

      const start = performance.now()
      for (const file of files) {
        indexer.indexFile(file.relPath, file.content, allPaths)
      }
      const end = performance.now()
      coldTimings.push(end - start)
    }

    const coldStats = computeStats(coldTimings)
    const perFileAvgMs = coldStats.avgMs / wp.totalFiles
    const perFileMedianMs = coldStats.medianMs / wp.totalFiles

    console.log(`[${wp.name}]`)
    console.log(`  Total Files:       ${wp.totalFiles.toLocaleString()} files (${totalWorkspaceKb} KB total payload)`)
    console.log(`  Iterations:        ${wp.iterations} full-build runs`)
    console.log(`  Total Build Time:  Average ${coldStats.avgMs.toFixed(2)} ms | Median ${coldStats.medianMs.toFixed(2)} ms | p95 ${coldStats.p95Ms.toFixed(2)} ms`)
    console.log(`  Per-File Time:     Average ${formatUsOrMs(perFileAvgMs)} | Median ${formatUsOrMs(perFileMedianMs)}`)
    console.log(`  Indexing Rate:     ${Math.round(wp.totalFiles / (coldStats.avgMs / 1000)).toLocaleString()} files/sec`)
    console.log('')
  }

  // -------------------------------------------------------------------------
  // Part 3: Memory Cache Parity & Hit Benchmark
  // -------------------------------------------------------------------------
  console.log('\nPART 3: FILE CACHE HIT PERFORMANCE')
  console.log('===========================================================================')
  const typicalContent = generateTypicalComponent()
  const cachedAnalyzer = new DependencyAnalyzer()
  cachedAnalyzer.analyzeFileContent('src/cached.tsx', typicalContent, workspaceFiles)

  const hitTimings = []
  for (let i = 0; i < 5000; i++) {
    const start = performance.now()
    cachedAnalyzer.fileCache.get('src/cached.tsx')
    const end = performance.now()
    hitTimings.push(end - start)
  }
  const hitStats = computeStats(hitTimings)
  console.log(`  Cache Hit Retrieval: Average ${formatUsOrMs(hitStats.avgMs)} | Median ${formatUsOrMs(hitStats.medianMs)}`)
  console.log(`  Cache Hit Rate:      ${hitStats.throughputFilesPerSec.toLocaleString()} lookups/sec`)

  console.log('\n===========================================================================')
  console.log('   BENCHMARK COMPLETED SUCCESSFULLY')
  console.log('===========================================================================')
}

runBenchmarks().catch((err) => {
  console.error('Benchmark error:', err)
  process.exit(1)
})
