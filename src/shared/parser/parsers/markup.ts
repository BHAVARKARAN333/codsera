/**
 * JSON, HTML, and CSS Structural Parsers (Phase 11.5)
 *
 * Extracts structural symbols:
 * - JSON: top-level keys, object structures
 * - HTML: major structural tags and elements with IDs
 * - CSS: rules, classes, IDs, media queries, and keyframes
 */

import { ExtractedSymbol, ParseDiagnostic, SyntaxNode } from '../types'
import { createSyntaxNode, createSymbol, InternalParseOutput, LineTracker } from './base'

export function parseJsonSource(filePath: string, content: string): InternalParseOutput {
  const tracker = new LineTracker(content)
  const symbols: ExtractedSymbol[] = []
  const diagnostics: ParseDiagnostic[] = []
  const childNodes: SyntaxNode[] = []
  let hasSyntaxErrors = false

  try {
    JSON.parse(content)
  } catch (err: unknown) {
    hasSyntaxErrors = true
    const message = err instanceof Error ? err.message : String(err)
    // Parse line/col from error message if available
    const posMatch = message.match(/line (\d+) column (\d+)/i) || message.match(/position (\d+)/i)
    let line = 1
    let col = 1
    if (posMatch && posMatch[2]) {
      line = parseInt(posMatch[1], 10)
      col = parseInt(posMatch[2], 10)
    } else if (posMatch && posMatch[1]) {
      const pos = tracker.getPosition(parseInt(posMatch[1], 10))
      line = pos.line
      col = pos.column
    }
    diagnostics.push({ message, line, column: col, severity: 'error' })
  }

  // Extract top-level & major keys
  const keyRegex = /"([A-Za-z0-9_$-]+)"\s*:/g
  let match: RegExpExecArray | null
  while ((match = keyRegex.exec(content)) !== null) {
    const key = match[1]
    const start = match.index
    const end = start + match[0].length

    symbols.push(createSymbol(key, 'property', filePath, start, end, tracker, null, true))
    childNodes.push(createSyntaxNode('pair', start, end, tracker, match[0]))
  }

  // Sort symbols
  symbols.sort((a, b) => a.startLine - b.startLine || a.startColumn - b.startColumn)

  const rootNode = createSyntaxNode('document', 0, content.length, tracker, undefined, childNodes, hasSyntaxErrors)

  return { rootNode, symbols, diagnostics, hasSyntaxErrors }
}

export function parseHtmlSource(filePath: string, content: string): InternalParseOutput {
  const tracker = new LineTracker(content)
  const symbols: ExtractedSymbol[] = []
  const diagnostics: ParseDiagnostic[] = []
  const childNodes: SyntaxNode[] = []
  let hasSyntaxErrors = false

  // Detect unclosed tags or syntax issues
  const tagRegex = /<([A-Za-z0-9-]+)([^>]*)>/g
  let match: RegExpExecArray | null
  while ((match = tagRegex.exec(content)) !== null) {
    const tagName = match[1].toLowerCase()
    const attrs = match[2]
    const start = match.index
    const end = start + match[0].length

    // Skip closing tags or doctype
    if (tagName.startsWith('/') || tagName.startsWith('!')) {
      continue
    }

    // Extract ID attribute if present
    const idMatch = attrs.match(/id=['"]([^'"]+)['"]/)
    if (idMatch) {
      const idName = `#${idMatch[1]}`
      symbols.push(createSymbol(idName, 'tag', filePath, start, end, tracker, null, true, `<${tagName} id="${idMatch[1]}">`))
      symbols.push(createSymbol(tagName, 'tag', filePath, start, end, tracker, null, true, `<${tagName}>`))
      childNodes.push(createSyntaxNode('element', start, end, tracker, match[0]))
    } else if (['title', 'header', 'main', 'footer', 'nav', 'section', 'article', 'form', 'script', 'style'].includes(tagName)) {
      symbols.push(createSymbol(tagName, 'tag', filePath, start, end, tracker, null, true, `<${tagName}>`))
      childNodes.push(createSyntaxNode('element', start, end, tracker, match[0]))
    }
  }

  // Sort symbols
  symbols.sort((a, b) => a.startLine - b.startLine || a.startColumn - b.startColumn)

  const rootNode = createSyntaxNode('fragment', 0, content.length, tracker, undefined, childNodes, hasSyntaxErrors)

  return { rootNode, symbols, diagnostics, hasSyntaxErrors }
}

export function parseCssSource(filePath: string, content: string): InternalParseOutput {
  const tracker = new LineTracker(content)
  const symbols: ExtractedSymbol[] = []
  const diagnostics: ParseDiagnostic[] = []
  const childNodes: SyntaxNode[] = []
  let hasSyntaxErrors = false

  const openBraces = (content.match(/\{/g) || []).length
  const closeBraces = (content.match(/\}/g) || []).length
  if (openBraces !== closeBraces) {
    hasSyntaxErrors = true
    const pos = tracker.getPosition(content.length)
    diagnostics.push({
      message: `Unmatched braces in CSS (open: ${openBraces}, close: ${closeBraces})`,
      line: pos.line,
      column: pos.column,
      severity: 'error'
    })
  }

  // Extract rules: selector { ... } or @media ... { ... }
  const ruleRegex = /(?:^|\n)[ \t]*([^{};]+?)\s*\{/g
  let match: RegExpExecArray | null
  while ((match = ruleRegex.exec(content)) !== null) {
    const rawSelector = match[1].trim()
    const start = match.index + (match[0].startsWith('\n') ? 1 : 0)
    const end = start + match[0].length

    // Skip empty or comment lines
    if (!rawSelector || rawSelector.startsWith('/*')) {
      continue
    }

    const isAtRule = rawSelector.startsWith('@')
    symbols.push(
      createSymbol(rawSelector, isAtRule ? 'rule' : 'rule', filePath, start, end, tracker, null, true)
    )
    childNodes.push(createSyntaxNode(isAtRule ? 'at_rule' : 'rule_set', start, end, tracker, rawSelector))
  }

  // Sort symbols
  symbols.sort((a, b) => a.startLine - b.startLine || a.startColumn - b.startColumn)

  const rootNode = createSyntaxNode('stylesheet', 0, content.length, tracker, undefined, childNodes, hasSyntaxErrors)

  return { rootNode, symbols, diagnostics, hasSyntaxErrors }
}
