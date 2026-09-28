// Phase 5: Local Codebase Index and Project Understanding Automated Test Suite

import assert from 'node:assert'

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

const EXTENSIONS_TO_TRY = ['.ts', '.tsx', '.js', '.jsx', '.d.ts', '.mjs', '.cjs', '.json']
const CODE_EXTENSIONS = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'])
const STRUCTURE_EXTENSIONS = new Set(['json', 'css', 'html'])
const CONFIG_FILE_NAMES = new Set([
  'package.json',
  'tsconfig.json',
  'tsconfig.node.json',
  'tsconfig.web.json',
  'vite.config.ts',
  'vite.config.js',
  'electron.vite.config.ts',
  'jest.config.js'
])

class DependencyAnalyzer {
  normalizePath(filePath) {
    return filePath.replace(/\\/g, '/').replace(/^\/+/, '')
  }

  normalizeKey(filePath) {
    return this.normalizePath(filePath).toLowerCase()
  }

  resolveImportPath(fromFilePath, importSpecifier, allWorkspaceFiles) {
    if (!importSpecifier.startsWith('.') && !importSpecifier.startsWith('/')) {
      return null
    }
    const fromNorm = this.normalizePath(fromFilePath)
    const fromDir = fromNorm.includes('/') ? fromNorm.slice(0, fromNorm.lastIndexOf('/')) : ''
    const parts = fromDir ? fromDir.split('/') : []
    const specParts = importSpecifier.replace(/\\/g, '/').split('/')

    for (const part of specParts) {
      if (part === '.' || part === '') continue
      if (part === '..') parts.pop()
      else parts.push(part)
    }

    const candidateBase = parts.join('/')
    const fileLookup = new Map()
    for (const f of allWorkspaceFiles) {
      fileLookup.set(this.normalizeKey(f), this.normalizePath(f))
    }

    const exactKey = candidateBase.toLowerCase()
    if (fileLookup.has(exactKey)) return fileLookup.get(exactKey)

    for (const ext of EXTENSIONS_TO_TRY) {
      const withExtKey = `${candidateBase}${ext}`.toLowerCase()
      if (fileLookup.has(withExtKey)) return fileLookup.get(withExtKey)
    }

    for (const ext of EXTENSIONS_TO_TRY) {
      const indexKey = `${candidateBase}/index${ext}`.toLowerCase()
      if (fileLookup.has(indexKey)) return fileLookup.get(indexKey)
    }

    return null
  }

  analyzeFileContent(filePath, content, allWorkspaceFiles = []) {
    const normalizedPath = this.normalizePath(filePath)
    const lines = content.split(/\r?\n/)
    const imports = []
    const exports = []
    const unresolvedImports = []

    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1
      const line = lines[i].trim()
      if (line.startsWith('//') || line.startsWith('/*')) continue

      const importMatch = line.match(/import\s+(?:(?:type\s+)?([\w*\s{},]+)\s+from\s+)?['"]([^'"]+)['"]/)
      if (importMatch) {
        const specifier = importMatch[2].trim()
        const resolvedPath = this.resolveImportPath(normalizedPath, specifier, allWorkspaceFiles)
        if (!resolvedPath && (specifier.startsWith('.') || specifier.startsWith('/'))) {
          unresolvedImports.push(specifier)
        }
        imports.push({ specifier, resolvedPath, line: lineNum })
      }

      const fnExport = line.match(/export\s+(?:async\s+)?function\s+([a-zA-Z_$][\w$]*)/)
      if (fnExport) exports.push({ name: fnExport[1], kind: 'function', line: lineNum })

      const varExport = line.match(/export\s+(?:const|let|var)\s+([a-zA-Z_$][\w$]*)/)
      if (varExport) exports.push({ name: varExport[1], kind: 'variable', line: lineNum })

      const classExport = line.match(/export\s+class\s+([a-zA-Z_$][\w$]*)/)
      if (classExport) exports.push({ name: classExport[1], kind: 'class', line: lineNum })
    }

    return { path: normalizedPath, imports, exports, unresolvedImports }
  }

  findLikelyTests(targetFilePath, allWorkspaceFiles) {
    const targetNorm = this.normalizePath(targetFilePath)
    const targetBase = targetNorm.split('/').pop() || ''
    const stem = targetBase.replace(/\.(ts|tsx|js|jsx|d\.ts)$/i, '').toLowerCase()
    const likelyTests = []

    for (const rawFile of allWorkspaceFiles) {
      const fileNorm = this.normalizePath(rawFile)
      if (fileNorm === targetNorm) continue
      const fileName = fileNorm.split('/').pop().toLowerCase()
      const isTestFile = fileName.includes('.test.') || fileName.includes('.spec.') || fileNorm.toLowerCase().includes('__tests__')
      if (isTestFile && fileName.includes(stem)) {
        likelyTests.push(fileNorm)
      }
    }
    return likelyTests
  }

  findImporters(targetFilePath, allFilesWithContent, allWorkspaceFiles) {
    const targetKey = this.normalizeKey(targetFilePath)
    const importers = []

    for (const item of allFilesWithContent) {
      if (this.normalizeKey(item.path) === targetKey) continue
      const info = this.analyzeFileContent(item.path, item.content, allWorkspaceFiles)
      const importsTarget = info.imports.some((imp) => {
        return imp.resolvedPath && this.normalizeKey(imp.resolvedPath) === targetKey
      })
      if (importsTarget) {
        importers.push(this.normalizePath(item.path))
      }
    }
    return importers
  }

  buildGraphNode(targetFilePath, targetContent, allFilesWithContent, allWorkspaceFiles) {
    const normalizedTarget = this.normalizePath(targetFilePath)
    const isTargetPackageJson = normalizedTarget.toLowerCase() === 'package.json'
    const targetInfo = this.analyzeFileContent(normalizedTarget, targetContent, allWorkspaceFiles)

    const directDependencies = targetInfo.imports
      .map((imp) => imp.resolvedPath)
      .filter(Boolean)

    const rawDirectImporters = this.findImporters(normalizedTarget, allFilesWithContent, allWorkspaceFiles)
    const directImporters = rawDirectImporters.filter((p) =>
      isTargetPackageJson ? true : !p.toLowerCase().endsWith('package.json')
    )

    const likelyTests = this.findLikelyTests(normalizedTarget, allWorkspaceFiles)

    const indirectSet = new Set()
    for (const directImporter of directImporters) {
      const secondHop = this.findImporters(directImporter, allFilesWithContent, allWorkspaceFiles)
      for (const sh of secondHop) {
        if (
          sh !== normalizedTarget &&
          !directImporters.includes(sh) &&
          !likelyTests.includes(sh) &&
          (isTargetPackageJson || !sh.toLowerCase().endsWith('package.json'))
        ) {
          indirectSet.add(sh)
        }
      }
    }
    const indirectImporters = Array.from(indirectSet)

    const affectedSet = new Set([...directImporters, ...likelyTests, ...indirectImporters])
    affectedSet.delete(normalizedTarget)

    return {
      path: normalizedTarget,
      directDependencies: Array.from(new Set(directDependencies)),
      directImporters,
      likelyTests,
      indirectImporters,
      potentiallyAffected: Array.from(affectedSet),
      impactBreakdown: {
        directImporters,
        relatedTests: likelyTests,
        indirectImpact: indirectImporters
      }
    }
  }
}

class CodebaseIndex {
  constructor(dependencyAnalyzer) {
    this.entries = new Map()
    this.workspaceRoot = null
    this.dependencyAnalyzer = dependencyAnalyzer || new DependencyAnalyzer()
    this.detectedTechnologies = new Set()
  }

  normalizePath(filePath) {
    return filePath.replace(/\\/g, '/').replace(/^\/+/, '')
  }

  normalizeKey(filePath) {
    return this.normalizePath(filePath).toLowerCase()
  }

  clear() {
    this.entries.clear()
    this.detectedTechnologies.clear()
    this.workspaceRoot = null
  }

  async buildIndex(workspaceRoot, filePaths, fileReader) {
    this.clear()
    this.workspaceRoot = workspaceRoot
    const normalizedPaths = filePaths.map(p => this.normalizePath(p))

    for (const relPath of normalizedPaths) {
      if (relPath.startsWith('..') || relPath.includes('/../')) continue
      const content = await fileReader(relPath)
      if (content !== null) {
        this.indexFile(relPath, content, normalizedPaths)
      }
    }
  }

  indexFile(filePath, content, allWorkspaceFiles) {
    const normPath = this.normalizePath(filePath)
    const key = this.normalizeKey(filePath)
    const ext = normPath.split('.').pop()?.toLowerCase() || ''
    const baseName = normPath.split('/').pop() || ''
    const baseNameLower = baseName.toLowerCase()

    const isCode = CODE_EXTENSIONS.has(ext)
    const isStructure = STRUCTURE_EXTENSIONS.has(ext)
    const isConfig = CONFIG_FILE_NAMES.has(baseNameLower) || baseNameLower.includes('.config.')

    const isTestFile = baseNameLower.includes('.test.') || baseNameLower.includes('.spec.') || normPath.toLowerCase().includes('/__tests__/')
    let isEntryPoint = false
    let entryPointConfidence = 'unknown'

    if (normPath === 'src/main/index.ts' || normPath === 'src/index.ts' || normPath === 'src/App.tsx' || normPath === 'index.html') {
      isEntryPoint = true
      entryPointConfidence = normPath === 'index.html' || normPath === 'src/main/index.ts' ? 'detected' : 'likely'
    }

    let fileType = 'unknown'
    if (isTestFile) fileType = 'test'
    else if (isEntryPoint) fileType = 'entry'
    else if (isConfig) fileType = 'config'
    else if (isCode) fileType = 'source'
    else if (isStructure) fileType = 'structure'

    let imports = []
    let resolvedDependencies = []
    let unresolvedImports = []
    let exports = []
    let declaredSymbols = []

    if (isCode) {
      const depInfo = this.dependencyAnalyzer.analyzeFileContent(normPath, content, allWorkspaceFiles)
      imports = depInfo.imports.map(i => i.specifier)
      resolvedDependencies = depInfo.imports.map(i => i.resolvedPath).filter(Boolean)
      unresolvedImports = depInfo.unresolvedImports
      exports = depInfo.exports
      declaredSymbols = exports.map(e => e.name)
    }

    if (baseNameLower === 'package.json') {
      try {
        const pkg = JSON.parse(content)
        const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }
        if (allDeps['react']) this.detectedTechnologies.add('React')
        if (allDeps['electron']) this.detectedTechnologies.add('Electron')
        if (allDeps['typescript']) this.detectedTechnologies.add('TypeScript')
        if (allDeps['vite']) this.detectedTechnologies.add('Vite')
        if (allDeps['jest']) this.detectedTechnologies.add('Jest')
        if (pkg.main) {
          const mainKey = this.normalizeKey(pkg.main)
          if (this.entries.has(mainKey)) {
            this.entries.get(mainKey).isEntryPoint = true
            this.entries.get(mainKey).entryPointConfidence = 'detected'
          }
        }
      } catch {}
    }

    if (ext === 'ts' || ext === 'tsx' || baseNameLower.includes('tsconfig')) {
      this.detectedTechnologies.add('TypeScript')
    }

    const hash = computeContentHash(content)
    const entry = {
      normalizedPath: normPath,
      fileType,
      extension: ext,
      imports,
      resolvedDependencies,
      unresolvedImports,
      exports,
      declaredSymbols,
      isTestFile,
      isEntryPoint,
      entryPointConfidence,
      isConfigFile: isConfig,
      contentHash: hash,
      fileSize: content.length,
      lastIndexed: Date.now()
    }
    this.entries.set(key, entry)
    return entry
  }

  updateFile(filePath, content, allWorkspaceFiles) {
    return this.indexFile(filePath, content, allWorkspaceFiles)
  }

  removeFile(filePath) {
    return this.entries.delete(this.normalizeKey(filePath))
  }

  invalidateFile(filePath) {
    this.entries.delete(this.normalizeKey(filePath))
  }

  findFile(filePath) {
    return this.entries.get(this.normalizeKey(filePath)) || null
  }

  findImporters(filePath) {
    const targetKey = this.normalizeKey(filePath)
    const targetNorm = this.normalizePath(filePath)
    const importers = []
    for (const entry of this.entries.values()) {
      if (entry.normalizedPath.toLowerCase() === targetKey) continue
      if (entry.resolvedDependencies.some(dep => this.normalizeKey(dep) === targetKey || dep === targetNorm)) {
        importers.push(entry.normalizedPath)
      }
    }
    return importers
  }

  findDependencies(filePath) {
    const entry = this.findFile(filePath)
    return entry ? [...entry.resolvedDependencies] : []
  }

  findSymbol(symbolName) {
    const cleanSym = symbolName.trim().toLowerCase()
    const locations = []
    for (const entry of this.entries.values()) {
      for (const exp of entry.exports) {
        if (exp.name.toLowerCase() === cleanSym) {
          locations.push({ name: exp.name, file: entry.normalizedPath, kind: 'export', line: exp.line })
        }
      }
    }
    return locations
  }

  findTestsForFile(filePath) {
    const allPaths = Array.from(this.entries.values()).map(e => e.normalizedPath)
    return this.dependencyAnalyzer.findLikelyTests(filePath, allPaths)
  }

  findLikelyEntryPoints() {
    return Array.from(this.entries.values()).filter(e => e.isEntryPoint)
  }

  findConfigFiles() {
    return Array.from(this.entries.values()).filter(e => e.isConfigFile)
  }

  getAffectedFiles(filePath) {
    const normTarget = this.normalizePath(filePath)
    const isTargetPackageJson = normTarget.toLowerCase() === 'package.json'
    const importers = this.findImporters(normTarget)
    const tests = this.findTestsForFile(normTarget)
    const affected = new Set([...importers, ...tests])
    affected.delete(normTarget)

    if (!isTargetPackageJson) {
      affected.delete('package.json')
    }

    return Array.from(affected)
  }

  getProjectSummary() {
    const allEntries = Array.from(this.entries.values())
    const sourceFiles = allEntries.filter(e => e.fileType === 'source' || e.fileType === 'entry')
    const testFiles = allEntries.filter(e => e.isTestFile)
    const configFiles = allEntries.filter(e => e.isConfigFile)

    const mainDirs = new Set()
    for (const entry of allEntries) {
      const parts = entry.normalizedPath.split('/')
      if (parts.length > 1) mainDirs.add(parts[0])
    }

    const entryPoints = allEntries.filter(e => e.isEntryPoint).map(e => ({
      path: e.normalizedPath,
      confidence: e.entryPointConfidence,
      reason: e.entryPointConfidence === 'detected'
        ? '[Directly Detected] Explicitly designated primary entry point in package.json or root'
        : '[Inferred from standard convention] Typical application entry point'
    }))

    const unresolvedList = []
    for (const entry of allEntries) {
      for (const unres of entry.unresolvedImports) {
        unresolvedList.push({ from: entry.normalizedPath, specifier: unres })
      }
    }

    let runtimePlatform = 'Node.js Application'
    if (this.detectedTechnologies.has('Electron')) {
      runtimePlatform = 'Electron (Desktop Application)'
    } else if (this.detectedTechnologies.has('React') || this.detectedTechnologies.has('Vite')) {
      runtimePlatform = 'Browser / Web Client'
    }

    let testEnvironment = 'None Detected'
    if (this.detectedTechnologies.has('Jest')) {
      testEnvironment = 'Jest (Node.js Test Runner / JSDOM)'
    } else if (this.detectedTechnologies.has('Vitest')) {
      testEnvironment = 'Vitest (Vite-native Node Test Runner)'
    } else if (testFiles.length > 0) {
      testEnvironment = 'Node.js Test Runner / Inferred Test Suite'
    }

    const testFrameworks = []
    if (this.detectedTechnologies.has('Jest')) testFrameworks.push('Jest')

    return {
      workspaceRoot: this.workspaceRoot || '',
      totalFiles: allEntries.length,
      sourceFilesCount: sourceFiles.length,
      testFilesCount: testFiles.length,
      configFilesCount: configFiles.length,
      mainDirectories: Array.from(mainDirs).sort(),
      detectedEntryPoints: entryPoints,
      configFiles: configFiles.map(c => c.normalizedPath).sort(),
      unresolvedLocalImports: unresolvedList,
      detectedTestFrameworks: testFrameworks,
      detectedTechnologies: Array.from(this.detectedTechnologies).sort(),
      runtimePlatform,
      testEnvironment
    }
  }
}

async function runPhase5Tests() {
  console.log('===========================================================')
  console.log('PHASE 5: LOCAL CODEBASE INDEX & PROJECT UNDERSTANDING TESTS')
  console.log('===========================================================')

  const filesMap = new Map([
    ['package.json', JSON.stringify({ name: 'test-app', main: 'src/main/index.ts', dependencies: { react: '^18.0.0', electron: '^31.0.0' }, devDependencies: { typescript: '^5.0.0', vite: '^5.0.0', jest: '^29.0.0' } })],
    ['tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ESNext' } })],
    ['electron.vite.config.ts', 'export default {}'],
    ['src/main/index.ts', 'import { app } from "electron";\nexport function start() {}'],
    ['src/utils/math.ts', 'export function add(a: number, b: number) { return a + b; }\nexport function subtract(a: number, b: number) { return a - b; }'],
    ['src/utils/math.test.ts', 'import { add } from "./math";\ntest("adds", () => {});'],
    ['src/components/Calculator.tsx', 'import React from "react";\nimport { add } from "../utils/math";\nexport const Calculator = () => <div>{add(1, 2)}</div>;'],
    ['src/App.tsx', 'import React from "react";\nimport { Calculator } from "./components/Calculator";\nexport const App = () => <Calculator />;']
  ])

  const depAnalyzer = new DependencyAnalyzer()
  const index = new CodebaseIndex(depAnalyzer)
  const fileReader = async (path) => filesMap.get(path) || null
  const allFilePaths = Array.from(filesMap.keys())

  // Test 1: Index builds successfully
  console.log('\n[Test 1] Index build')
  await index.buildIndex('C:/test/workspace', allFilePaths, fileReader)
  assert.strictEqual(index.entries.size, allFilePaths.length)
  console.log(`✓ PASS: Index built successfully with ${index.entries.size} files.`)

  // Test 2: Source files detected
  console.log('\n[Test 2] Source files detection')
  const mathEntry = index.findFile('src/utils/math.ts')
  assert.notStrictEqual(mathEntry, null)
  assert.strictEqual(mathEntry.fileType, 'source')
  console.log('✓ PASS: Source files categorized correctly.')

  // Test 3: Test files detected
  console.log('\n[Test 3] Test file detection')
  const testEntry = index.findFile('src/utils/math.test.ts')
  assert.notStrictEqual(testEntry, null)
  assert.strictEqual(testEntry.isTestFile, true)
  assert.strictEqual(testEntry.fileType, 'test')
  console.log('✓ PASS: Test file detected correctly.')

  // Test 4: Imports / dependencies indexed
  console.log('\n[Test 4] Dependencies indexing')
  const calcDeps = index.findDependencies('src/components/Calculator.tsx')
  assert(calcDeps.includes('src/utils/math.ts'), 'Calculator.tsx must have src/utils/math.ts as dependency')
  console.log(`✓ PASS: Calculator.tsx dependencies: ${calcDeps.join(', ')}`)

  // Test 5: Exported symbols indexed
  console.log('\n[Test 5] Exported symbols indexing')
  const symbols = index.findSymbol('add')
  assert(symbols.some(s => s.file === 'src/utils/math.ts' && s.name === 'add'))
  console.log(`✓ PASS: Found symbol "add" exported at src/utils/math.ts`)

  // Test 6: findImporters()
  console.log('\n[Test 6] findImporters()')
  const mathImporters = index.findImporters('src/utils/math.ts')
  assert(mathImporters.includes('src/components/Calculator.tsx'))
  assert(mathImporters.includes('src/utils/math.test.ts'))
  console.log(`✓ PASS: Importers of math.ts: ${mathImporters.join(', ')}`)

  // Test 7: findDependencies()
  console.log('\n[Test 7] findDependencies()')
  const appDeps = index.findDependencies('src/App.tsx')
  assert(appDeps.includes('src/components/Calculator.tsx'))
  console.log(`✓ PASS: Dependencies of App.tsx: ${appDeps.join(', ')}`)

  // Test 8: findTestsForFile()
  console.log('\n[Test 8] findTestsForFile()')
  const mathTests = index.findTestsForFile('src/utils/math.ts')
  assert(mathTests.includes('src/utils/math.test.ts'))
  console.log(`✓ PASS: Found tests for math.ts: ${mathTests.join(', ')}`)

  // Test 9: Entry point detection with clear provenance
  console.log('\n[Test 9] Entry point detection & provenance')
  const entryPoints = index.findLikelyEntryPoints()
  const entryPaths = entryPoints.map(e => e.normalizedPath)
  assert(entryPaths.includes('src/main/index.ts'))
  assert(entryPaths.includes('src/App.tsx'))
  const mainEntry = entryPoints.find(e => e.normalizedPath === 'src/main/index.ts')
  assert.strictEqual(mainEntry.entryPointConfidence, 'detected')

  const projectSum = index.getProjectSummary()
  const summaryMainEntry = projectSum.detectedEntryPoints.find(e => e.path === 'src/main/index.ts')
  assert(summaryMainEntry.reason.includes('Directly Detected'))
  console.log(`✓ PASS: Detected entry points: ${entryPaths.join(', ')} with provenance.`)

  // Test 10: Config detection
  console.log('\n[Test 10] Configuration files detection')
  const configs = index.findConfigFiles().map(c => c.normalizedPath)
  assert(configs.includes('package.json'))
  assert(configs.includes('tsconfig.json'))
  assert(configs.includes('electron.vite.config.ts'))
  console.log(`✓ PASS: Detected config files: ${configs.join(', ')}`)

  // Test 11: getProjectSummary() distinguishes runtimePlatform vs testEnvironment
  console.log('\n[Test 11] Project summary distinguishes runtimePlatform from testEnvironment')
  const summary = index.getProjectSummary()
  assert.strictEqual(summary.runtimePlatform, 'Electron (Desktop Application)')
  assert(summary.testEnvironment.includes('Jest'), `Expected Jest test environment, got ${summary.testEnvironment}`)
  assert(!summary.detectedTechnologies.includes('Angular'), 'Must not hallucinate uninstalled Angular')
  console.log(`✓ PASS: Runtime Platform: "${summary.runtimePlatform}", Test Env: "${summary.testEnvironment}"`)

  // Test 12: getAffectedFiles() excludes package.json for internal math.ts edit
  console.log('\n[Test 12] getAffectedFiles() excludes package.json')
  const affected = index.getAffectedFiles('src/utils/math.ts')
  assert(!affected.includes('package.json'), 'package.json must NOT be affected by math.ts')
  assert(affected.includes('src/components/Calculator.tsx'))
  assert(affected.includes('src/utils/math.test.ts'))
  console.log(`✓ PASS: Affected files for math.ts: ${affected.join(', ')} (package.json excluded)`)

  // Test 13: 3-tier impact analysis breakdown
  console.log('\n[Test 13] 3-tier impact analysis breakdown')
  const filesWithContent = Array.from(filesMap.entries()).map(([path, content]) => ({ path, content }))
  const graphNode = depAnalyzer.buildGraphNode('src/utils/math.ts', filesMap.get('src/utils/math.ts'), filesWithContent, allFilePaths)
  assert.deepStrictEqual([...graphNode.impactBreakdown.directImporters].sort(), ['src/components/Calculator.tsx', 'src/utils/math.test.ts'].sort())
  assert.deepStrictEqual(graphNode.impactBreakdown.relatedTests, ['src/utils/math.test.ts'])
  assert.deepStrictEqual(graphNode.impactBreakdown.indirectImpact, ['src/App.tsx'])
  assert(!graphNode.potentiallyAffected.includes('package.json'))
  console.log(`✓ PASS: Direct Importers: [${graphNode.impactBreakdown.directImporters}], Tests: [${graphNode.impactBreakdown.relatedTests}], Indirect: [${graphNode.impactBreakdown.indirectImpact}]`)

  // Test 14: updateFile()
  console.log('\n[Test 14] Incremental updateFile()')
  const newMath = 'export function add() {}\nexport function multiply() {}'
  index.updateFile('src/utils/math.ts', newMath, allFilePaths)
  const updatedSymbols = index.findSymbol('multiply')
  assert.strictEqual(updatedSymbols.length, 1)
  console.log('✓ PASS: Incremental file update indexed new symbol "multiply".')

  // Test 15: invalidateFile()
  console.log('\n[Test 15] Invalidate file')
  index.invalidateFile('src/utils/math.ts')
  assert.strictEqual(index.findFile('src/utils/math.ts'), null)
  console.log('✓ PASS: Invalidated file removed from index.')

  // Test 16: Workspace reset clears index
  console.log('\n[Test 16] Workspace reset')
  index.clear()
  assert.strictEqual(index.entries.size, 0)
  assert.strictEqual(index.detectedTechnologies.size, 0)
  console.log('✓ PASS: Workspace reset cleared index state.')

  // Test 17: Path traversal rejected
  console.log('\n[Test 17] Path traversal rejection')
  await index.buildIndex('C:/test', ['../../secret.txt'], async () => 'secret')
  assert.strictEqual(index.findFile('../../secret.txt'), null)
  console.log('✓ PASS: Path traversal rejected.')

  console.log('\n===========================================================')
  console.log('ALL PHASE 5 CODEBASE INDEX TESTS PASSED! ✓')
  console.log('===========================================================')
}

runPhase5Tests().catch(err => {
  console.error('Phase 5 test failed:', err)
  process.exit(1)
})
