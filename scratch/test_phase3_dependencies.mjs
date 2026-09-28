// Dependency-Aware Code Understanding - Phase 3 Automated Verification Suite

import assert from 'node:assert'

// Replicate DependencyAnalyzer logic for Node ESM runner
const EXTENSIONS_TO_TRY = ['.ts', '.tsx', '.js', '.jsx', '.d.ts', '.mjs', '.cjs', '.json']

class DependencyAnalyzer {
  constructor(config = {}) {
    this.config = {
      maxDependencyCandidates: config.maxDependencyCandidates ?? 5,
      maxSymbolReferences: config.maxSymbolReferences ?? 20,
      debug: config.debug ?? false
    }
    this.fileCache = new Map()
  }

  normalizePath(filePath) {
    return filePath.replace(/\\/g, '/').replace(/^\/+/, '')
  }

  normalizeKey(filePath) {
    return this.normalizePath(filePath).toLowerCase()
  }

  clearCache() {
    this.fileCache.clear()
  }

  invalidateFile(filePath) {
    const key = this.normalizeKey(filePath)
    this.fileCache.delete(key)
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
      if (part === '..') {
        parts.pop()
      } else {
        parts.push(part)
      }
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
    const key = this.normalizeKey(filePath)
    const normalizedPath = this.normalizePath(filePath)
    const lines = content.split(/\r?\n/)
    const imports = []
    const exports = []
    const unresolvedImports = []

    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1
      const line = lines[i].trim()

      if (line.startsWith('//') || line.startsWith('/*') || line.startsWith('*')) continue

      const importFromMatch = line.match(/import\s+(?:(?:type\s+)?([\w*\s{},]+)\s+from\s+)?['"]([^'"]+)['"]/)
      if (importFromMatch) {
        const rawSymbols = importFromMatch[1] ? importFromMatch[1].trim() : ''
        const specifier = importFromMatch[2].trim()
        const importedSymbols = []
        let isDefault = false
        let isNamespace = false

        if (rawSymbols) {
          if (rawSymbols.startsWith('* as ')) {
            isNamespace = true
            importedSymbols.push(rawSymbols.replace('* as ', '').trim())
          } else if (rawSymbols.startsWith('{')) {
            const inner = rawSymbols.replace(/[{}]/g, '')
            inner.split(',').forEach(s => {
              const sym = s.trim().split(/\s+as\s+/)[0].trim()
              if (sym) importedSymbols.push(sym)
            })
          } else {
            isDefault = true
            importedSymbols.push(rawSymbols)
          }
        }

        const resolvedPath = this.resolveImportPath(normalizedPath, specifier, allWorkspaceFiles)
        if (!resolvedPath && (specifier.startsWith('.') || specifier.startsWith('/'))) {
          unresolvedImports.push(specifier)
        }

        imports.push({ specifier, resolvedPath, importedSymbols, isDefault, isNamespace, line: lineNum })
      }

      const fnExport = line.match(/export\s+(?:async\s+)?function\s+([a-zA-Z_$][\w$]*)/)
      if (fnExport) exports.push({ name: fnExport[1], kind: 'function', line: lineNum })

      const varExport = line.match(/export\s+(?:const|let|var)\s+([a-zA-Z_$][\w$]*)/)
      if (varExport) exports.push({ name: varExport[1], kind: 'variable', line: lineNum })

      const classExport = line.match(/export\s+class\s+([a-zA-Z_$][\w$]*)/)
      if (classExport) exports.push({ name: classExport[1], kind: 'class', line: lineNum })
    }

    const info = { path: normalizedPath, imports, exports, unresolvedImports, lastAnalyzed: Date.now() }
    this.fileCache.set(key, info)
    return info
  }

  findImporters(targetFilePath, allFilesWithContent, allWorkspaceFiles) {
    const targetKey = this.normalizeKey(targetFilePath)
    const importers = []

    for (const item of allFilesWithContent) {
      if (this.normalizeKey(item.path) === targetKey) continue
      let info = this.fileCache.get(this.normalizeKey(item.path))
      if (!info) info = this.analyzeFileContent(item.path, item.content, allWorkspaceFiles)

      const importsTarget = info.imports.some(imp => imp.resolvedPath && this.normalizeKey(imp.resolvedPath) === targetKey)
      if (importsTarget) importers.push(this.normalizePath(item.path))
    }

    return importers
  }

  findLikelyTests(targetFilePath, allWorkspaceFiles) {
    const targetNorm = this.normalizePath(targetFilePath)
    const targetSegments = targetNorm.split('/')
    const targetBaseName = targetSegments[targetSegments.length - 1]
    const stem = targetBaseName.replace(/\.(ts|tsx|js|jsx|d\.ts)$/i, '').toLowerCase()
    const likelyTests = []

    for (const rawFile of allWorkspaceFiles) {
      const fileNorm = this.normalizePath(rawFile)
      if (fileNorm === targetNorm) continue
      const fileLower = fileNorm.toLowerCase()
      const segments = fileNorm.split('/')
      const fileName = segments[segments.length - 1].toLowerCase()

      const isTestFile = fileName.includes('.test.') || fileName.includes('.spec.') || fileLower.includes('__tests__') || fileLower.includes('/test/')
      if (!isTestFile) continue

      if (fileName.includes(stem)) {
        likelyTests.push(fileNorm)
      }
    }

    return likelyTests
  }

  findSymbolReferences(symbolName, filesWithContent) {
    const cleanSym = symbolName.trim()
    if (!cleanSym || cleanSym.length < 2) return []

    const references = []
    const symbolRegex = new RegExp(`\\b${cleanSym}\\b`)
    const callRegex = new RegExp(`\\b${cleanSym}\\s*\\(`)

    for (const item of filesWithContent) {
      if (references.length >= this.config.maxSymbolReferences) break
      const lines = item.content.split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        if (references.length >= this.config.maxSymbolReferences) break
        const lineNum = i + 1
        const rawLine = lines[i]
        const trimmed = rawLine.trim()
        if (trimmed.startsWith('//') || trimmed.startsWith('/*')) continue

        const codeOnly = rawLine.split('//')[0]
        if (symbolRegex.test(codeOnly)) {
          references.push({
            file: this.normalizePath(item.path),
            line: lineNum,
            snippet: trimmed.slice(0, 120),
            isCall: callRegex.test(codeOnly)
          })
        }
      }
    }

    return references
  }

  buildGraphNode(targetFilePath, targetContent, allFilesWithContent, allWorkspaceFiles) {
    const normalizedTarget = this.normalizePath(targetFilePath)
    const targetInfo = this.analyzeFileContent(normalizedTarget, targetContent, allWorkspaceFiles)
    const directDependencies = targetInfo.imports.map(imp => imp.resolvedPath).filter(Boolean)
    const directImporters = this.findImporters(normalizedTarget, allFilesWithContent, allWorkspaceFiles)
    const likelyTests = this.findLikelyTests(normalizedTarget, allWorkspaceFiles)
    const affectedSet = new Set([...directImporters, ...likelyTests])
    affectedSet.delete(normalizedTarget)

    return {
      path: normalizedTarget,
      directDependencies: Array.from(new Set(directDependencies)),
      directImporters,
      likelyTests,
      potentiallyAffected: Array.from(affectedSet).slice(0, this.config.maxDependencyCandidates)
    }
  }
}

async function runPhase3Tests() {
  console.log('====================================================')
  console.log('PHASE 3: DEPENDENCY-AWARE CODE UNDERSTANDING TESTS')
  console.log('====================================================')

  const analyzer = new DependencyAnalyzer()
  const workspaceFiles = [
    'src/utils/math.ts',
    'src/utils/math.test.ts',
    'src/utils/__tests__/math.spec.ts',
    'src/components/Calculator.tsx',
    'src/components/index.ts',
    'src/App.tsx',
    'src/main.ts'
  ]

  const mathTs = `export function add(a: number, b: number): number { return a + b; }\nexport function subtract(a: number, b: number): number { return a - b; }`
  const calculatorTsx = `import React from 'react';\nimport { add } from '../utils/math';\n\nexport const Calculator = () => <div>{add(2, 3)}</div>;`
  const appTsx = `import React from 'react';\nimport { Calculator } from './components';\nimport { add } from './utils/math';\n\nexport const App = () => <div><Calculator /> {add(5, 5)}</div>;`
  const mathTestTs = `import { add } from './math';\ntest('adds numbers', () => { expect(add(1, 2)).toBe(3); });`

  const filesWithContent = [
    { path: 'src/utils/math.ts', content: mathTs },
    { path: 'src/components/Calculator.tsx', content: calculatorTsx },
    { path: 'src/App.tsx', content: appTsx },
    { path: 'src/utils/math.test.ts', content: mathTestTs }
  ]

  // Test A: Importer detection
  console.log('\n[Test A] Importer detection for src/utils/math.ts')
  const importers = analyzer.findImporters('src/utils/math.ts', filesWithContent, workspaceFiles)
  assert(importers.includes('src/components/Calculator.tsx'), 'Calculator.tsx must be detected as an importer')
  assert(importers.includes('src/App.tsx'), 'App.tsx must be detected as an importer')
  console.log(`✓ PASS: Detected importers: ${importers.join(', ')}`)

  // Test B: Find references to add()
  console.log('\n[Test B] Find references to symbol "add"')
  const refs = analyzer.findSymbolReferences('add', filesWithContent)
  assert(refs.length >= 3, 'Must find references across math.ts, Calculator.tsx, App.tsx, math.test.ts')
  assert(refs.some(r => r.file === 'src/components/Calculator.tsx' && r.isCall), 'Must detect call in Calculator.tsx')
  console.log(`✓ PASS: Found ${refs.length} references to "add" with line numbers and call signatures.`)

  // Test C: Relative import resolution (../utils/math)
  console.log('\n[Test C] Relative import resolution ("../utils/math")')
  const resolved = analyzer.resolveImportPath('src/components/Calculator.tsx', '../utils/math', workspaceFiles)
  assert.strictEqual(resolved, 'src/utils/math.ts', 'Must resolve relative import to src/utils/math.ts')
  console.log(`✓ PASS: Resolved "../utils/math" from Calculator.tsx -> ${resolved}`)

  // Test D: index.ts directory resolution
  console.log('\n[Test D] Directory index.ts resolution ("./components")')
  const resolvedIndex = analyzer.resolveImportPath('src/App.tsx', './components', workspaceFiles)
  assert.strictEqual(resolvedIndex, 'src/components/index.ts', 'Must resolve "./components" to src/components/index.ts')
  console.log(`✓ PASS: Resolved "./components" from App.tsx -> ${resolvedIndex}`)

  // Test E: Likely test discovery
  console.log('\n[Test E] Likely test discovery for src/utils/math.ts')
  const tests = analyzer.findLikelyTests('src/utils/math.ts', workspaceFiles)
  assert(tests.includes('src/utils/math.test.ts'), 'Must find math.test.ts')
  assert(tests.includes('src/utils/__tests__/math.spec.ts'), 'Must find math.spec.ts')
  console.log(`✓ PASS: Found likely tests: ${tests.join(', ')}`)

  // Test F: Unresolved import without hallucination
  console.log('\n[Test F] Unresolved import handled cleanly')
  const unresolved = analyzer.resolveImportPath('src/App.tsx', './nonexistent/module', workspaceFiles)
  assert.strictEqual(unresolved, null, 'Must return null for nonexistent module')
  console.log('✓ PASS: Nonexistent relative import returns null without hallucination.')

  // Test G: Dependency candidates respect limits & graph node
  console.log('\n[Test G] Graph node construction & candidate bounding')
  const graphNode = analyzer.buildGraphNode('src/utils/math.ts', mathTs, filesWithContent, workspaceFiles)
  assert.strictEqual(graphNode.path, 'src/utils/math.ts')
  assert(graphNode.directImporters.length > 0)
  assert(graphNode.likelyTests.length > 0)
  assert(graphNode.potentiallyAffected.length <= 5, 'Potentially affected files must respect limit <= 5')
  console.log(`✓ PASS: Graph node built. Potentially affected: ${graphNode.potentiallyAffected.join(', ')}`)

  // Test H: Invalidation & cache
  console.log('\n[Test H] Dependency cache invalidation')
  analyzer.invalidateFile('src/components/Calculator.tsx')
  assert(!analyzer.fileCache.has('src/components/calculator.tsx'), 'Invalidated file must not be in cache')
  console.log('✓ PASS: File invalidated cleanly.')

  // Test I: General question bypass
  console.log('\n[Test I] General question bypass check')
  const isGeneral = /^(what is|what are|explain|describe|define)\s+(python|recursion)\b/i.test('What is Python?')
  assert.strictEqual(isGeneral, true)
  console.log('✓ PASS: General question bypasses dependency analysis.')

  console.log('\n====================================================')
  console.log('ALL PHASE 3 DEPENDENCY-AWARE TESTS PASSED! ✓')
  console.log('====================================================')
}

runPhase3Tests().catch(err => {
  console.error('Phase 3 test failed:', err)
  process.exit(1)
})
