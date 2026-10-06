/**
 * Multi-Language Dependency Extractor (Phase 11.6)
 *
 * Extracts raw import, require, include, using, and export-from statements
 * with line offsets across all supported languages.
 */

import { LanguageId } from './types'
import { ExtractedDependency } from './repoMapTypes'
import { LineTracker } from './parsers/base'

export function extractDependencies(
  _filePath: string,
  content: string,
  language: LanguageId
): ExtractedDependency[] {
  const tracker = new LineTracker(content)
  const results: ExtractedDependency[] = []

  switch (language) {
    case 'javascript':
    case 'typescript':
    case 'tsx':
    case 'jsx':
      extractJavaScriptDependencies(content, tracker, results)
      break

    case 'python':
      extractPythonDependencies(content, tracker, results)
      break

    case 'java':
      extractJavaDependencies(content, tracker, results)
      break

    case 'c':
    case 'cpp':
      extractCCppDependencies(content, tracker, results)
      break

    case 'csharp':
      extractCSharpDependencies(content, tracker, results)
      break

    case 'go':
      extractGoDependencies(content, tracker, results)
      break

    case 'rust':
      extractRustDependencies(content, tracker, results)
      break

    default:
      // Markup / Data files do not have standard code imports
      break
  }

  // Deduplicate dependencies that have identical specifier and kind on the same line
  const seen = new Set<string>()
  const deduped: ExtractedDependency[] = []
  for (const dep of results) {
    const key = `${dep.specifier}:::${dep.kind}:::${dep.line}`
    if (!seen.has(key)) {
      seen.add(key)
      deduped.push(dep)
    }
  }

  return deduped.sort((a, b) => a.line - b.line)
}

function extractJavaScriptDependencies(
  content: string,
  tracker: LineTracker,
  results: ExtractedDependency[]
): void {
  // 1. Static import: import ... from 'specifier' or import 'specifier'
  const importRegex = /(?:^|\n)[ \t]*(?:export\s+)?import\s+(?:(?:(?:type\s+)?(?:[\w*\s{},$]+)\s+from\s+)|)(['"])([^'"]+)\1/g
  let match: RegExpExecArray | null

  while ((match = importRegex.exec(content)) !== null) {
    const specifier = match[2].trim()
    if (specifier) {
      const line = tracker.getPosition(match.index).line
      const isExternalHint = !specifier.startsWith('.') && !specifier.startsWith('/')
      results.push({
        specifier,
        line,
        kind: 'import',
        isExternalHint
      })
    }
  }

  // 2. Export ... from 'specifier'
  const exportFromRegex = /(?:^|\n)[ \t]*export\s+(?:type\s+)?(?:[\w*\s{},$]+)\s+from\s+(['"])([^'"]+)\1/g
  while ((match = exportFromRegex.exec(content)) !== null) {
    const specifier = match[2].trim()
    if (specifier) {
      const line = tracker.getPosition(match.index).line
      const isExternalHint = !specifier.startsWith('.') && !specifier.startsWith('/')
      results.push({
        specifier,
        line,
        kind: 'export_from',
        isExternalHint
      })
    }
  }

  // 3. require('specifier') or require("specifier")
  const requireRegex = /\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g
  while ((match = requireRegex.exec(content)) !== null) {
    const specifier = match[2].trim()
    if (specifier) {
      const line = tracker.getPosition(match.index).line
      const isExternalHint = !specifier.startsWith('.') && !specifier.startsWith('/')
      results.push({
        specifier,
        line,
        kind: 'require',
        isExternalHint
      })
    }
  }

  // 4. Dynamic import('specifier')
  const dynamicImportRegex = /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g
  while ((match = dynamicImportRegex.exec(content)) !== null) {
    const specifier = match[2].trim()
    if (specifier) {
      const line = tracker.getPosition(match.index).line
      const isExternalHint = !specifier.startsWith('.') && !specifier.startsWith('/')
      results.push({
        specifier,
        line,
        kind: 'import',
        isExternalHint
      })
    }
  }
}

function extractPythonDependencies(
  content: string,
  tracker: LineTracker,
  results: ExtractedDependency[]
): void {
  // from x.y import z (including relative from . import y, from ..parent import z)
  const fromRegex = /(?:^|\r?\n)[ \t]*from\s+([.\w]+)\s+import\s+([^\r\n#]+)/g
  let match: RegExpExecArray | null

  while ((match = fromRegex.exec(content)) !== null) {
    const specifier = match[1].trim()
    const line = tracker.getPosition(match.index).line
    const isRelative = specifier.startsWith('.')
    results.push({
      specifier,
      line,
      kind: 'import',
      isExternalHint: !isRelative
    })
  }

  // import x, y.z
  const importRegex = /(?:^|\r?\n)[ \t]*import\s+([^\r\n#]+)/g
  while ((match = importRegex.exec(content)) !== null) {
    const raw = match[1].trim()
    const modules = raw.split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim())
    const line = tracker.getPosition(match.index).line

    for (const mod of modules) {
      if (mod) {
        const isRelative = mod.startsWith('.')
        results.push({
          specifier: mod,
          line,
          kind: 'import',
          isExternalHint: !isRelative
        })
      }
    }
  }
}

function extractJavaDependencies(
  content: string,
  tracker: LineTracker,
  results: ExtractedDependency[]
): void {
  const javaImportRegex = /(?:^|\r?\n)[ \t]*import\s+(?:static\s+)?([A-Za-z0-9_.*]+)\s*;/g
  let match: RegExpExecArray | null

  while ((match = javaImportRegex.exec(content)) !== null) {
    const specifier = match[1].trim()
    const line = tracker.getPosition(match.index).line
    const isExternalHint =
      specifier.startsWith('java.') ||
      specifier.startsWith('javax.') ||
      specifier.startsWith('org.junit.') ||
      specifier.startsWith('sun.')
    results.push({
      specifier,
      line,
      kind: 'import',
      isExternalHint
    })
  }
}

function extractCCppDependencies(
  content: string,
  tracker: LineTracker,
  results: ExtractedDependency[]
): void {
  // #include <iostream> or #include "header.h"
  const includeRegex = /(?:^|\r?\n)[ \t]*#\s*include\s*(<[^>]+>|"[^"]+")/g
  let match: RegExpExecArray | null

  while ((match = includeRegex.exec(content)) !== null) {
    const raw = match[1].trim()
    const line = tracker.getPosition(match.index).line

    if (raw.startsWith('<') && raw.endsWith('>')) {
      const specifier = raw.slice(1, -1).trim()
      results.push({
        specifier,
        line,
        kind: 'include',
        isExternalHint: true
      })
    } else if (raw.startsWith('"') && raw.endsWith('"')) {
      const specifier = raw.slice(1, -1).trim()
      results.push({
        specifier,
        line,
        kind: 'include',
        isExternalHint: false
      })
    }
  }
}

function extractCSharpDependencies(
  content: string,
  tracker: LineTracker,
  results: ExtractedDependency[]
): void {
  const usingRegex = /(?:^|\r?\n)[ \t]*using\s+(?:(?:static\s+)|(?:[\w]+\s*=\s*))?([A-Za-z0-9_.]+)\s*;/g
  let match: RegExpExecArray | null

  while ((match = usingRegex.exec(content)) !== null) {
    const specifier = match[1].trim()
    const line = tracker.getPosition(match.index).line
    const isExternalHint =
      specifier.startsWith('System') ||
      specifier.startsWith('Microsoft')
    results.push({
      specifier,
      line,
      kind: 'using',
      isExternalHint
    })
  }
}

function extractGoDependencies(
  content: string,
  tracker: LineTracker,
  results: ExtractedDependency[]
): void {
  // 1. Single-line: import "fmt" or import p "path"
  const singleRegex = /(?:^|\r?\n)[ \t]*import\s+(?:[A-Za-z_]\w*\s+)?(['"])([^'"]+)\1/g
  let match: RegExpExecArray | null

  while ((match = singleRegex.exec(content)) !== null) {
    const specifier = match[2].trim()
    const line = tracker.getPosition(match.index).line
    const isExternalHint = !specifier.includes('/') || !specifier.startsWith('.')
    results.push({
      specifier,
      line,
      kind: 'import',
      isExternalHint
    })
  }

  // 2. Multi-line import ( ... )
  const multiRegex = /(?:^|\r?\n)[ \t]*import\s*\(([^)]*)\)/g
  while ((match = multiRegex.exec(content)) !== null) {
    const block = match[1]
    const blockStartPos = match.index
    const lineRegex = /(?:^|\r?\n)[ \t]*(?:[A-Za-z_]\w*\s+)?(['"])([^'"]+)\1/g
    let lineMatch: RegExpExecArray | null

    while ((lineMatch = lineRegex.exec(block)) !== null) {
      const specifier = lineMatch[2].trim()
      const line = tracker.getPosition(blockStartPos + lineMatch.index).line
      const isExternalHint = !specifier.includes('/') || !specifier.startsWith('.')
      results.push({
        specifier,
        line,
        kind: 'import',
        isExternalHint
      })
    }
  }
}

function extractRustDependencies(
  content: string,
  tracker: LineTracker,
  results: ExtractedDependency[]
): void {
  const useRegex = /(?:^|\r?\n)[ \t]*(?:pub\s+)?use\s+([^;{}]+(?:\{[^}]+\})?)\s*;/g
  let match: RegExpExecArray | null

  while ((match = useRegex.exec(content)) !== null) {
    let raw = match[1].trim()
    const line = tracker.getPosition(match.index).line

    // Handle nested group: use foo::{bar, baz}
    const groupMatch = raw.match(/^([^{]+)::\{([^}]+)\}$/)
    if (groupMatch) {
      const base = groupMatch[1].trim()
      const items = groupMatch[2].split(',').map((s) => s.trim())
      for (const item of items) {
        if (item) {
          const specifier = `${base}::${item}`
          const isExternalHint = !specifier.startsWith('crate') && !specifier.startsWith('super')
          results.push({
            specifier,
            line,
            kind: 'use',
            isExternalHint
          })
        }
      }
    } else {
      raw = raw.replace(/\s+as\s+[\w]+$/, '').trim()
      const isExternalHint = !raw.startsWith('crate') && !raw.startsWith('super')
      results.push({
        specifier: raw,
        line,
        kind: 'use',
        isExternalHint
      })
    }
  }
}
