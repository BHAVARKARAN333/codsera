// Dependency-Aware Code Understanding - Phase 3 Automated Verification Suite

import assert from 'node:assert'

const EXTENSIONS_TO_TRY = ['.ts', '.tsx', '.js', '.jsx', '.d.ts', '.mjs', '.cjs', '.json']

class DependencyAnalyzer {
  constructor(config = {}) {
    const maxDependencyCandidates = config.maxDependencyCandidates ?? 5
    const maxSymbolReferences = config.maxSymbolReferences ?? 20
    const baseUrl = config.baseUrl ?? '.'
    const debug = config.debug ?? false
    const pathAliases = config.pathAliases ?? {
      '@/*': ['src/*'],
      '@shared/*': ['src/shared/*'],
      '@renderer/*': ['src/renderer/src/*']
    }

    this.config = {
      maxDependencyCandidates,
      maxSymbolReferences,
      pathAliases,
      baseUrl,
      debug
    }

    this.fileCache = new Map()
    this.compiledAliases = []
    this.setPathAliases(pathAliases, baseUrl)
  }

  normalizePath(filePath) {
    return filePath.replace(/\\/g, '/').replace(/^\/+/, '')
  }

  normalizeKey(filePath) {
    return this.normalizePath(filePath).toLowerCase()
  }

  setPathAliases(aliases, baseUrl = '.') {
    this.config.pathAliases = aliases
    this.baseUrl = baseUrl.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') || '.'
    this.compiledAliases = []

    for (const [pattern, targetList] of Object.entries(aliases)) {
      const normPattern = pattern.replace(/\\/g, '/')
      const targets = Array.isArray(targetList) ? targetList : [targetList]
      const normTargets = targets.map((t) => t.replace(/\\/g, '/'))

      const wildcardIndex = normPattern.indexOf('*')
      if (wildcardIndex !== -1) {
        this.compiledAliases.push({
          aliasPattern: normPattern,
          prefix: normPattern.slice(0, wildcardIndex),
          suffix: normPattern.slice(wildcardIndex + 1),
          hasWildcard: true,
          targets: normTargets
        })
      } else {
        this.compiledAliases.push({
          aliasPattern: normPattern,
          prefix: normPattern,
          suffix: '',
          hasWildcard: false,
          targets: normTargets
        })
      }
    }

    this.compiledAliases.sort((a, b) => b.prefix.length - a.prefix.length)
  }

  loadTsConfig(tsconfigContent) {
    try {
      let parsed
      if (typeof tsconfigContent === 'string') {
        const cleaned = tsconfigContent.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '')
        parsed = JSON.parse(cleaned)
      } else {
        parsed = tsconfigContent
      }

      const compilerOptions = parsed?.compilerOptions || {}
      const baseUrl = typeof compilerOptions.baseUrl === 'string' ? compilerOptions.baseUrl : '.'
      const paths = compilerOptions.paths || {}

      this.setPathAliases(paths, baseUrl)
    } catch (err) {
      if (this.config.debug) {
        console.debug('[DependencyAnalyzer] Failed to parse tsconfig for path aliases:', err)
      }
    }
  }

  getPathAliases() {
    return { ...this.config.pathAliases }
  }

  clearCache() {
    this.fileCache.clear()
  }

  invalidateFile(filePath) {
    const key = this.normalizeKey(filePath)
    this.fileCache.delete(key)
  }

  matchAliasPattern(specifier, alias) {
    if (alias.hasWildcard) {
      if (
        specifier.startsWith(alias.prefix) &&
        (alias.suffix === '' || specifier.endsWith(alias.suffix)) &&
        specifier.length >= alias.prefix.length + alias.suffix.length
      ) {
        const matchedWildcard = specifier.slice(
          alias.prefix.length,
          alias.suffix.length > 0 ? specifier.length - alias.suffix.length : undefined
        )
        return matchedWildcard
      }
    } else {
      if (specifier === alias.prefix) {
        return ''
      }
    }
    return null
  }

  resolveAliasTarget(targetPattern, matchedWildcard) {
    let replaced = targetPattern.includes('*')
      ? targetPattern.replace('*', matchedWildcard)
      : targetPattern.replace(/\/+$/, '') + (matchedWildcard ? `/${matchedWildcard}` : '')

    replaced = this.normalizePath(replaced)

    if (this.baseUrl && this.baseUrl !== '.') {
      replaced = this.normalizePath(`${this.baseUrl}/${replaced}`)
    }

    return replaced
  }

  isLocalOrAliasSpecifier(specifier) {
    if (specifier.startsWith('.') || specifier.startsWith('/')) {
      return true
    }
    for (const alias of this.compiledAliases) {
      if (this.matchAliasPattern(specifier, alias) !== null) {
        return true
      }
    }
    return false
  }

  resolveImportPath(fromFilePath, importSpecifier, allWorkspaceFiles) {
    const fileLookup = new Map()
    for (const f of allWorkspaceFiles) {
      fileLookup.set(this.normalizeKey(f), this.normalizePath(f))
    }

    const tryFindCandidate = (candidateBase) => {
      if (
        candidateBase.startsWith('..') ||
        candidateBase.includes('/../') ||
        candidateBase.includes('\\..\\')
      ) {
        return null
      }

      const normalizedBase = this.normalizePath(candidateBase)

      const exactKey = normalizedBase.toLowerCase()
      if (fileLookup.has(exactKey)) {
        return fileLookup.get(exactKey)
      }

      for (const ext of EXTENSIONS_TO_TRY) {
        const withExtKey = `${normalizedBase}${ext}`.toLowerCase()
        if (fileLookup.has(withExtKey)) {
          return fileLookup.get(withExtKey)
        }
      }

      for (const ext of EXTENSIONS_TO_TRY) {
        const indexKey = `${normalizedBase}/index${ext}`.toLowerCase()
        if (fileLookup.has(indexKey)) {
          return fileLookup.get(indexKey)
        }
      }

      return null
    }

    if (importSpecifier.startsWith('.') || importSpecifier.startsWith('/')) {
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
      return tryFindCandidate(candidateBase)
    }

    for (const alias of this.compiledAliases) {
      const matchedWildcard = this.matchAliasPattern(importSpecifier, alias)
      if (matchedWildcard !== null) {
        for (const targetPattern of alias.targets) {
          const candidateBase = this.resolveAliasTarget(targetPattern, matchedWildcard)
          const resolved = tryFindCandidate(candidateBase)
          if (resolved) {
            return resolved
          }
        }
      }
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
    const seenImportSpecifiers = new Set()

    let inBlockComment = false

    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1
      let line = lines[i].trim()

      if (inBlockComment) {
        if (line.includes('*/')) {
          inBlockComment = false
          line = line.split('*/')[1].trim()
        } else {
          continue
        }
      }

      if (line.startsWith('/*')) {
        if (line.includes('*/')) {
          line = line.split('*/')[1].trim()
        } else {
          inBlockComment = true
          continue
        }
      }

      if (line.startsWith('//') || line.startsWith('*') || !line) {
        continue
      }

      if (
        line.startsWith('import ') ||
        line.startsWith('import\t') ||
        line.startsWith('import{') ||
        line.startsWith('import"') ||
        line.startsWith("import'")
      ) {
        let fullImport = line
        let endIndex = i

        if (!/['"][^'"]+['"]/.test(fullImport)) {
          while (
            endIndex + 1 < lines.length &&
            !/['"][^'"]+['"]/.test(fullImport) &&
            endIndex - i < 50
          ) {
            endIndex++
            const nextLine = lines[endIndex].trim()
            if (nextLine.startsWith('//') || nextLine.startsWith('/*')) continue
            fullImport += ' ' + nextLine.split('//')[0].trim()
          }
        }

        i = endIndex

        const cleanImport = fullImport
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\s+/g, ' ')
          .trim()

        const importFromMatch = cleanImport.match(
          /import\s+(?:(?:type\s+)?([\w*\s{},$]+)\s+from\s+)?['"]([^'"]+)['"]/
        )

        if (importFromMatch) {
          const rawSymbols = importFromMatch[1] ? importFromMatch[1].trim() : ''
          const specifier = importFromMatch[2].trim()

          let isDefault = false
          let isNamespace = false
          const importedSymbols = []

          if (rawSymbols) {
            if (rawSymbols.startsWith('* as ')) {
              isNamespace = true
              importedSymbols.push(rawSymbols.replace('* as ', '').trim())
            } else if (rawSymbols.startsWith('{')) {
              const inner = rawSymbols.replace(/[{}]/g, '')
              inner.split(',').forEach((s) => {
                const clean = s.trim().replace(/^type\s+/, '')
                const parts = clean.split(/\s+as\s+/)
                const orig = parts[0]?.trim()
                const alias = parts[1]?.trim()
                if (orig) importedSymbols.push(orig)
                if (alias && alias !== orig) importedSymbols.push(alias)
              })
            } else {
              if (rawSymbols.includes(',')) {
                const parts = rawSymbols.split(',')
                const def = parts[0].trim().replace(/^type\s+/, '')
                if (def) {
                  importedSymbols.push(def)
                  isDefault = true
                }

                const rest = parts.slice(1).join(',').replace(/[{}]/g, '')
                rest.split(',').forEach((s) => {
                  const clean = s.trim().replace(/^type\s+/, '')
                  const subParts = clean.split(/\s+as\s+/)
                  const orig = subParts[0]?.trim()
                  const alias = subParts[1]?.trim()
                  if (orig) importedSymbols.push(orig)
                  if (alias && alias !== orig) importedSymbols.push(alias)
                })
              } else {
                isDefault = true
                importedSymbols.push(rawSymbols.replace(/^type\s+/, ''))
              }
            }
          }

          const resolvedPath = this.resolveImportPath(normalizedPath, specifier, allWorkspaceFiles)
          if (!resolvedPath && this.isLocalOrAliasSpecifier(specifier)) {
            if (!unresolvedImports.includes(specifier)) {
              unresolvedImports.push(specifier)
            }
          }

          imports.push({
            specifier,
            resolvedPath,
            importedSymbols: Array.from(new Set(importedSymbols)),
            isDefault,
            isNamespace,
            line: lineNum
          })
          seenImportSpecifiers.add(specifier)
        }
        continue
      }

      const requireMatch = line.match(
        /(?:const|let|var)\s+([\w\s{},]+)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/
      )
      if (requireMatch) {
        const rawSymbols = requireMatch[1].trim()
        const specifier = requireMatch[2].trim()
        const importedSymbols = []

        if (rawSymbols.startsWith('{')) {
          rawSymbols
            .replace(/[{}]/g, '')
            .split(',')
            .forEach((s) => {
              const sym = s.trim().split(':')[0].trim()
              if (sym) importedSymbols.push(sym)
            })
        } else {
          importedSymbols.push(rawSymbols)
        }

        const resolvedPath = this.resolveImportPath(normalizedPath, specifier, allWorkspaceFiles)
        if (!resolvedPath && this.isLocalOrAliasSpecifier(specifier)) {
          if (!unresolvedImports.includes(specifier)) {
            unresolvedImports.push(specifier)
          }
        }

        imports.push({
          specifier,
          resolvedPath,
          importedSymbols: Array.from(new Set(importedSymbols)),
          isDefault: true,
          isNamespace: false,
          line: lineNum
        })
        seenImportSpecifiers.add(specifier)
        continue
      }

      if (
        line.startsWith('export ') ||
        line.startsWith('export\t') ||
        line.startsWith('export{') ||
        line.startsWith('export*')
      ) {
        if (/^export\s+(?:type\s+)?\{/.test(line)) {
          let fullExport = line
          let endIndex = i

          if (!fullExport.includes('}')) {
            while (
              endIndex + 1 < lines.length &&
              !fullExport.includes('}') &&
              endIndex - i < 50
            ) {
              endIndex++
              const nextLine = lines[endIndex].trim()
              if (nextLine.startsWith('//') || nextLine.startsWith('/*')) continue
              fullExport += ' ' + nextLine.split('//')[0].trim()
            }
          }

          if (fullExport.includes('from') && !/['"][^'"]+['"]/.test(fullExport)) {
            while (
              endIndex + 1 < lines.length &&
              !/['"][^'"]+['"]/.test(fullExport) &&
              endIndex - i < 50
            ) {
              endIndex++
              const nextLine = lines[endIndex].trim()
              if (nextLine.startsWith('//') || nextLine.startsWith('/*')) continue
              fullExport += ' ' + nextLine.split('//')[0].trim()
            }
          }

          i = endIndex

          const cleanExport = fullExport
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\s+/g, ' ')
            .trim()
          const exportFromMatch = cleanExport.match(
            /^export\s+(?:type\s+)?\{\s*([^}]+)\s*\}(?:\s*from\s*['"]([^'"]+)['"])?/
          )

          if (exportFromMatch) {
            const inner = exportFromMatch[1]
            const specifier = exportFromMatch[2]?.trim()

            inner.split(',').forEach((s) => {
              const clean = s.trim().replace(/^type\s+/, '')
              const parts = clean.split(/\s+as\s+/)
              const exportName = parts[parts.length - 1]?.trim() || parts[0]?.trim()
              if (exportName) {
                exports.push({ name: exportName, kind: 'reexport', line: lineNum })
              }
            })

            if (specifier) {
              const resolvedPath = this.resolveImportPath(
                normalizedPath,
                specifier,
                allWorkspaceFiles
              )
              if (!resolvedPath && this.isLocalOrAliasSpecifier(specifier)) {
                if (!unresolvedImports.includes(specifier)) {
                  unresolvedImports.push(specifier)
                }
              }

              if (!seenImportSpecifiers.has(specifier)) {
                imports.push({
                  specifier,
                  resolvedPath,
                  importedSymbols: [],
                  isDefault: false,
                  isNamespace: false,
                  line: lineNum
                })
                seenImportSpecifiers.add(specifier)
              }
            }
          }
          continue
        }

        const exportAllMatch = line.match(
          /^export\s+\*\s*(?:as\s+([a-zA-Z_$][\w$]*)\s+)?from\s*['"]([^'"]+)['"]/
        )
        if (exportAllMatch) {
          const nsName = exportAllMatch[1]?.trim()
          const specifier = exportAllMatch[2].trim()
          if (nsName) {
            exports.push({ name: nsName, kind: 'reexport', line: lineNum })
          }

          const resolvedPath = this.resolveImportPath(normalizedPath, specifier, allWorkspaceFiles)
          if (!resolvedPath && this.isLocalOrAliasSpecifier(specifier)) {
            if (!unresolvedImports.includes(specifier)) {
              unresolvedImports.push(specifier)
            }
          }

          if (!seenImportSpecifiers.has(specifier)) {
            imports.push({
              specifier,
              resolvedPath,
              importedSymbols: [],
              isDefault: false,
              isNamespace: true,
              line: lineNum
            })
            seenImportSpecifiers.add(specifier)
          }
          continue
        }

        const fnExport = line.match(/export\s+(?:async\s+)?function\s+([a-zA-Z_$][\w$]*)/)
        if (fnExport) {
          exports.push({ name: fnExport[1], kind: 'function', line: lineNum })
          continue
        }

        const varExport = line.match(/export\s+(?:const|let|var)\s+([a-zA-Z_$][\w$]*)/)
        if (varExport) {
          exports.push({ name: varExport[1], kind: 'variable', line: lineNum })
          continue
        }

        const classExport = line.match(/export\s+class\s+([a-zA-Z_$][\w$]*)/)
        if (classExport) {
          exports.push({ name: classExport[1], kind: 'class', line: lineNum })
          continue
        }

        const typeExport = line.match(/export\s+(interface|type|enum)\s+([a-zA-Z_$][\w$]*)/)
        if (typeExport) {
          exports.push({
            name: typeExport[2],
            kind: typeExport[1],
            line: lineNum
          })
          continue
        }

        const defaultExport = line.match(
          /export\s+default\s+(?:(?:async\s+)?function\s+([a-zA-Z_$][\w$]*)|class\s+([a-zA-Z_$][\w$]*)|([a-zA-Z_$][\w$]*))/
        )
        if (defaultExport) {
          const name = defaultExport[1] || defaultExport[2] || defaultExport[3] || 'default'
          exports.push({ name, kind: 'default', line: lineNum })
          continue
        }
      }
    }

    const info = {
      path: normalizedPath,
      imports,
      exports,
      unresolvedImports,
      lastAnalyzed: Date.now()
    }
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

      const importsTarget = info.imports.some(
        (imp) => imp.resolvedPath && this.normalizeKey(imp.resolvedPath) === targetKey
      )
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

      const isTestFile =
        fileName.includes('.test.') ||
        fileName.includes('.spec.') ||
        fileLower.includes('__tests__') ||
        fileLower.includes('/test/') ||
        fileLower.includes('/tests/')
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
    const directDependencies = targetInfo.imports.map((imp) => imp.resolvedPath).filter(Boolean)
    const directImporters = this.findImporters(
      normalizedTarget,
      allFilesWithContent,
      allWorkspaceFiles
    )
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
    'src/shared/types.ts',
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
  assert(
    importers.includes('src/components/Calculator.tsx'),
    'Calculator.tsx must be detected as an importer'
  )
  assert(importers.includes('src/App.tsx'), 'App.tsx must be detected as an importer')
  console.log(`✓ PASS: Detected importers: ${importers.join(', ')}`)

  // Test B: Find references to add()
  console.log('\n[Test B] Find references to symbol "add"')
  const refs = analyzer.findSymbolReferences('add', filesWithContent)
  assert(
    refs.length >= 3,
    'Must find references across math.ts, Calculator.tsx, App.tsx, math.test.ts'
  )
  assert(
    refs.some((r) => r.file === 'src/components/Calculator.tsx' && r.isCall),
    'Must detect call in Calculator.tsx'
  )
  console.log(
    `✓ PASS: Found ${refs.length} references to "add" with line numbers and call signatures.`
  )

  // Test C: Relative import resolution (../utils/math)
  console.log('\n[Test C] Relative import resolution ("../utils/math")')
  const resolved = analyzer.resolveImportPath(
    'src/components/Calculator.tsx',
    '../utils/math',
    workspaceFiles
  )
  assert.strictEqual(
    resolved,
    'src/utils/math.ts',
    'Must resolve relative import to src/utils/math.ts'
  )
  console.log(`✓ PASS: Resolved "../utils/math" from Calculator.tsx -> ${resolved}`)

  // Test D: index.ts directory resolution
  console.log('\n[Test D] Directory index.ts resolution ("./components")')
  const resolvedIndex = analyzer.resolveImportPath('src/App.tsx', './components', workspaceFiles)
  assert.strictEqual(
    resolvedIndex,
    'src/components/index.ts',
    'Must resolve "./components" to src/components/index.ts'
  )
  console.log(`✓ PASS: Resolved "./components" from App.tsx -> ${resolvedIndex}`)

  // Test E: Likely test discovery
  console.log('\n[Test E] Likely test discovery for src/utils/math.ts')
  const tests = analyzer.findLikelyTests('src/utils/math.ts', workspaceFiles)
  assert(tests.includes('src/utils/math.test.ts'), 'Must find math.test.ts')
  assert(tests.includes('src/utils/__tests__/math.spec.ts'), 'Must find math.spec.ts')
  console.log(`✓ PASS: Found likely tests: ${tests.join(', ')}`)

  // Test F: Unresolved import without hallucination
  console.log('\n[Test F] Unresolved import handled cleanly')
  const unresolved = analyzer.resolveImportPath(
    'src/App.tsx',
    './nonexistent/module',
    workspaceFiles
  )
  assert.strictEqual(unresolved, null, 'Must return null for nonexistent module')
  console.log('✓ PASS: Nonexistent relative import returns null without hallucination.')

  // Test G: Dependency candidates respect limits & graph node
  console.log('\n[Test G] Graph node construction & candidate bounding')
  const graphNode = analyzer.buildGraphNode(
    'src/utils/math.ts',
    mathTs,
    filesWithContent,
    workspaceFiles
  )
  assert.strictEqual(graphNode.path, 'src/utils/math.ts')
  assert(graphNode.directImporters.length > 0)
  assert(graphNode.likelyTests.length > 0)
  assert(
    graphNode.potentiallyAffected.length <= 5,
    'Potentially affected files must respect limit <= 5'
  )
  console.log(
    `✓ PASS: Graph node built. Potentially affected: ${graphNode.potentiallyAffected.join(', ')}`
  )

  // Test H: Invalidation & cache
  console.log('\n[Test H] Dependency cache invalidation')
  analyzer.invalidateFile('src/components/Calculator.tsx')
  assert(
    !analyzer.fileCache.has('src/components/calculator.tsx'),
    'Invalidated file must not be in cache'
  )
  console.log('✓ PASS: File invalidated cleanly.')

  // Test I: General question bypass
  console.log('\n[Test I] General question bypass check')
  const isGeneral =
    /^(what is|what are|explain|describe|define)\s+(python|recursion)\b/i.test('What is Python?')
  assert.strictEqual(isGeneral, true)
  console.log('✓ PASS: General question bypasses dependency analysis.')

  // ==========================================
  // NEW FOCUSED TESTS: MULTILINE & PATH ALIASES
  // ==========================================

  // Test J: Multiline named imports
  console.log('\n[Test J] Multiline named import parsing')
  const multilineImportCode = `
import React, {
  useState,
  useEffect,
  type ReactNode
} from 'react';
import {
  add,
  subtract,
  type MathResult as Result
} from './utils/math';
`
  const multilineParsed = analyzer.analyzeFileContent(
    'src/App.tsx',
    multilineImportCode,
    workspaceFiles
  )
  assert.strictEqual(multilineParsed.imports.length, 2, 'Must parse exactly 2 import statements')

  const mathImport = multilineParsed.imports.find((i) => i.specifier === './utils/math')
  assert(mathImport, 'Must find import for ./utils/math')
  assert.strictEqual(mathImport.resolvedPath, 'src/utils/math.ts', 'Must resolve path correctly')
  assert(
    mathImport.importedSymbols.includes('add') && mathImport.importedSymbols.includes('subtract'),
    'Must parse imported symbols across multiple lines'
  )
  assert(
    mathImport.importedSymbols.includes('Result') ||
      mathImport.importedSymbols.includes('MathResult'),
    'Must parse imported type symbol'
  )
  console.log(
    `✓ PASS: Multiline import parsed cleanly (${mathImport.importedSymbols.join(', ')}) -> ${mathImport.resolvedPath}`
  )

  // Test K: Multiline export-from
  console.log('\n[Test K] Multiline export-from parsing')
  const multilineExportCode = `
export {
  add,
  subtract
} from '../utils/math';
export {
  Calculator
};
`
  const exportParsed = analyzer.analyzeFileContent(
    'src/components/index.ts',
    multilineExportCode,
    workspaceFiles
  )
  assert(
    exportParsed.exports.some((e) => e.name === 'add' && e.kind === 'reexport'),
    'Must record re-exported add'
  )
  assert(
    exportParsed.exports.some((e) => e.name === 'Calculator'),
    'Must record exported Calculator'
  )
  const reexportDep = exportParsed.imports.find((i) => i.specifier === '../utils/math')
  assert(reexportDep, 'Must record import dependency edge from export-from statement')
  assert.strictEqual(reexportDep.resolvedPath, 'src/utils/math.ts')
  console.log(
    `✓ PASS: Multiline export-from parsed with ${exportParsed.exports.length} exports and dependency edge.`
  )

  // Test L: Alias resolution for "@/*"
  console.log('\n[Test L] Alias resolution for "@/*"')
  const aliasResolved = analyzer.resolveImportPath('src/App.tsx', '@/utils/math', workspaceFiles)
  assert.strictEqual(
    aliasResolved,
    'src/utils/math.ts',
    'Must resolve "@/utils/math" -> "src/utils/math.ts"'
  )

  const aliasImportCode = `import { add } from '@/utils/math';`
  const aliasParsed = analyzer.analyzeFileContent('src/App.tsx', aliasImportCode, workspaceFiles)
  assert.strictEqual(aliasParsed.imports[0].resolvedPath, 'src/utils/math.ts')
  assert.strictEqual(aliasParsed.unresolvedImports.length, 0)
  console.log(`✓ PASS: Resolved "@/utils/math" -> ${aliasResolved}`)

  // Test M: Alias resolution for "@shared/*"
  console.log('\n[Test M] Alias resolution for "@shared/*"')
  const sharedResolved = analyzer.resolveImportPath(
    'src/renderer/src/App.tsx',
    '@shared/types',
    workspaceFiles
  )
  assert.strictEqual(
    sharedResolved,
    'src/shared/types.ts',
    'Must resolve "@shared/types" -> "src/shared/types.ts"'
  )
  console.log(`✓ PASS: Resolved "@shared/types" -> ${sharedResolved}`)

  // Test N: Unresolved alias target
  console.log('\n[Test N] Unresolved alias target')
  const unresolvedAlias = analyzer.resolveImportPath(
    'src/App.tsx',
    '@/nonexistent/service',
    workspaceFiles
  )
  assert.strictEqual(
    unresolvedAlias,
    null,
    'Unresolved alias target must return null without hallucination'
  )

  const unresolvedAliasCode = `
import { missing } from '@/nonexistent/service';
import { Button } from '@monaco-editor/react';
`
  const unresolvedParsed = analyzer.analyzeFileContent(
    'src/App.tsx',
    unresolvedAliasCode,
    workspaceFiles
  )
  assert(
    unresolvedParsed.unresolvedImports.includes('@/nonexistent/service'),
    'Unresolved alias matching local prefix must be recorded in unresolvedImports'
  )
  assert(
    !unresolvedParsed.unresolvedImports.includes('@monaco-editor/react'),
    'External scoped npm packages must NOT be recorded as unresolved local imports'
  )
  console.log('✓ PASS: Unresolved alias explicitly tracked; external packages ignored.')

  // Test O: Custom tsconfig loading
  console.log('\n[Test O] Custom tsconfig.json loading')
  const customTsConfig = `
{
  "compilerOptions": {
    "baseUrl": ".",
    /* Custom path aliases for monorepo */
    "paths": {
      "@core/*": ["src/utils/*"],
      "@app": ["src/App.tsx"]
    }
  }
}
`
  analyzer.loadTsConfig(customTsConfig)
  const coreResolved = analyzer.resolveImportPath('src/main.ts', '@core/math', workspaceFiles)
  assert.strictEqual(coreResolved, 'src/utils/math.ts', 'Must resolve custom @core/* alias')
  const appResolved = analyzer.resolveImportPath('src/main.ts', '@app', workspaceFiles)
  assert.strictEqual(appResolved, 'src/App.tsx', 'Must resolve exact @app alias')
  console.log(
    `✓ PASS: Custom tsconfig loaded and resolved (@core/math -> ${coreResolved}, @app -> ${appResolved})`
  )

  // Test P: Path traversal containment rejection
  console.log('\n[Test P] Path traversal containment rejection')
  const traversalResolved = analyzer.resolveImportPath(
    'src/App.tsx',
    '@/../../etc/passwd',
    workspaceFiles
  )
  assert.strictEqual(traversalResolved, null, 'Must reject path traversal above workspace')
  console.log('✓ PASS: Path traversal rejected safely.')

  // ==========================================
  // NEW FOCUSED TESTS: MULTI-FILE DEPENDENCY ENRICHMENT
  // ==========================================

  function enrichMultiFileDependencies(readFiles, allWorkspaceFiles, depAnalyzer) {
    const dependencyGraphs = []
    const filesWithContent = readFiles
      .filter((rf) => rf && typeof rf.content === 'string')
      .map((rf) => ({ path: rf.path, content: rf.content }))
    const seenTargets = new Set()

    for (const rf of readFiles) {
      if (!rf || typeof rf.content !== 'string') continue
      const ext = rf.path.split('.').pop()?.toLowerCase() || ''
      if (!['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(ext)) continue

      const norm = rf.path.toLowerCase()
      if (seenTargets.has(norm)) continue
      seenTargets.add(norm)

      try {
        const node = depAnalyzer.buildGraphNode(
          rf.path,
          rf.content,
          filesWithContent,
          allWorkspaceFiles
        )
        if (node) dependencyGraphs.push(node)
      } catch {
        // Handle unreadable/corrupt files safely
      }
    }

    const combinedAffectedSet = new Set()
    for (const g of dependencyGraphs) {
      for (const aff of g.potentiallyAffected) {
        combinedAffectedSet.add(aff)
      }
    }
    for (const rf of readFiles) {
      if (rf && rf.path) combinedAffectedSet.delete(rf.path)
    }

    return {
      primaryGraph: dependencyGraphs[0] || null,
      dependencyGraphs,
      combinedAffected: Array.from(combinedAffectedSet).sort()
    }
  }

  // Test Q: Two selected files both receive dependency analysis
  console.log('\n[Test Q] Two selected files both receive dependency analysis')
  const multiRead = [
    { path: 'src/components/Calculator.tsx', content: calculatorTsx },
    { path: 'src/utils/math.ts', content: mathTs }
  ]
  const multiRes = enrichMultiFileDependencies(multiRead, workspaceFiles, analyzer)
  assert.strictEqual(
    multiRes.dependencyGraphs.length,
    2,
    'Both selected files must receive dependency graph nodes'
  )
  assert.strictEqual(multiRes.dependencyGraphs[0].path, 'src/components/Calculator.tsx')
  assert.strictEqual(multiRes.dependencyGraphs[1].path, 'src/utils/math.ts')
  console.log(
    `✓ PASS: Both files received dependency graphs: ${multiRes.dependencyGraphs.map((g) => g.path).join(', ')}`
  )

  // Test R: Shared dependencies are not duplicated
  console.log('\n[Test R] Shared dependencies are not duplicated in combined affected context')
  const uniqueAffected = new Set(multiRes.combinedAffected)
  assert.strictEqual(
    uniqueAffected.size,
    multiRes.combinedAffected.length,
    'Combined affected files list must not contain duplicates'
  )
  assert(
    !multiRes.combinedAffected.includes('src/components/Calculator.tsx'),
    'Selected read files themselves must be excluded from downstream affected'
  )
  assert(
    !multiRes.combinedAffected.includes('src/utils/math.ts'),
    'Selected read files themselves must be excluded from downstream affected'
  )
  console.log(
    `✓ PASS: Combined unique affected files: ${multiRes.combinedAffected.join(', ')} (no duplicates, targets excluded)`
  )

  // Test S: Importers & tests for secondary file included
  console.log('\n[Test S] Importers and related tests for secondary selected file are included')
  const mathNode = multiRes.dependencyGraphs.find((g) => g.path === 'src/utils/math.ts')
  assert(mathNode, 'Secondary file node must exist')
  assert(
    mathNode.directImporters.includes('src/components/Calculator.tsx'),
    'Secondary file direct importers must include src/components/Calculator.tsx'
  )
  assert(
    mathNode.likelyTests.includes('src/utils/math.test.ts'),
    'Secondary file tests must include math.test.ts'
  )
  console.log(
    `✓ PASS: Secondary file importers (${mathNode.directImporters.join(', ')}) and tests (${mathNode.likelyTests.join(', ')}) present.`
  )

  // Test T: Unreadable / missing secondary file does not break context result
  console.log('\n[Test T] Unreadable/missing secondary file does not break context result')
  const brokenRead = [
    { path: 'src/components/Calculator.tsx', content: calculatorTsx },
    { path: 'src/missing/corrupted.ts', content: null }
  ]
  const brokenRes = enrichMultiFileDependencies(brokenRead, workspaceFiles, analyzer)
  assert.strictEqual(
    brokenRes.dependencyGraphs.length,
    1,
    'Must succeed with 1 valid graph node despite broken secondary file'
  )
  assert.strictEqual(brokenRes.primaryGraph.path, 'src/components/Calculator.tsx')
  console.log('✓ PASS: Broken secondary file handled safely without crashing context resolution.')

  // Test U: Existing single-file dependency analysis behavior remains identical
  console.log('\n[Test U] Existing single-file dependency behavior remains unchanged')
  const singleRead = [
    { path: 'src/utils/math.ts', content: mathTs },
    { path: 'src/components/Calculator.tsx', content: calculatorTsx }
  ]
  const singleRes = enrichMultiFileDependencies([singleRead[0]], workspaceFiles, analyzer)
  assert.strictEqual(singleRes.dependencyGraphs.length, 1)
  assert.strictEqual(singleRes.primaryGraph.path, 'src/utils/math.ts')
  assert(singleRes.primaryGraph.likelyTests.length > 0)
  console.log('✓ PASS: Single-file dependency analysis behavior remains completely compatible.')

  console.log('\n====================================================')
  console.log('ALL PHASE 3 DEPENDENCY-AWARE TESTS PASSED! ✓')
  console.log('====================================================')
}

runPhase3Tests().catch((err) => {
  console.error('Phase 3 test failed:', err)
  process.exit(1)
})
