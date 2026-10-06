/**
 * Python Tree-sitter Compatible Parser (Phase 11.5)
 *
 * Extracts functions, classes, methods, constructors, and imports with
 * indentation tracking, parent association, and syntax error detection.
 */

import { ExtractedSymbol, ParseDiagnostic, SyntaxNode } from '../types'
import { createSyntaxNode, createSymbol, InternalParseOutput, LineTracker } from './base'

export function parsePythonSource(filePath: string, content: string): InternalParseOutput {
  const tracker = new LineTracker(content)
  const symbols: ExtractedSymbol[] = []
  const diagnostics: ParseDiagnostic[] = []
  const childNodes: SyntaxNode[] = []
  let hasSyntaxErrors = false

  // Check delimiter balance
  const openParens = (content.match(/\(/g) || []).length
  const closeParens = (content.match(/\)/g) || []).length
  const openBrackets = (content.match(/\[/g) || []).length
  const closeBrackets = (content.match(/\]/g) || []).length
  const openBraces = (content.match(/\{/g) || []).length
  const closeBraces = (content.match(/\}/g) || []).length

  if (openParens !== closeParens || openBrackets !== closeBrackets || openBraces !== closeBraces) {
    hasSyntaxErrors = true
    const pos = tracker.getPosition(content.length)
    diagnostics.push({
      message: `Unmatched delimiters (parens: ${openParens}/${closeParens}, brackets: ${openBrackets}/${closeBrackets}, braces: ${openBraces}/${closeBraces})`,
      line: pos.line,
      column: pos.column,
      severity: 'error'
    })
  }

  // 1. Imports
  const importRegex = /(?:^|\r?\n)[ \t]*((?:from[ \t]+[\w.]+[ \t]+)?import[ \t]+[^\r\n#]+)/g
  let match: RegExpExecArray | null
  while ((match = importRegex.exec(content)) !== null) {
    const start = match.index + (match[0].startsWith('\n') ? 1 : 0)
    const text = match[1].trim()
    const end = start + text.length

    if (text.startsWith('from ')) {
      const parts = text.match(/^from\s+([\w.]+)\s+import\s+(.+)$/)
      if (parts) {
        const mod = parts[1]
        symbols.push(createSymbol(mod, 'import', filePath, start, end, tracker, null, false, text))
        const identifiers = parts[2].split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim())
        for (const id of identifiers) {
          if (id && id !== '*' && id !== mod) {
            symbols.push(createSymbol(id, 'import', filePath, start, end, tracker, null, false, text))
          }
        }
        childNodes.push(createSyntaxNode('import_statement', start, end, tracker, text))
        continue
      }
    } else if (text.startsWith('import ')) {
      const raw = text.replace(/^import\s+/, '')
      const mods = raw.split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim())
      for (const m of mods) {
        if (m) {
          symbols.push(createSymbol(m, 'import', filePath, start, end, tracker, null, false, text))
        }
      }
      childNodes.push(createSyntaxNode('import_statement', start, end, tracker, text))
      continue
    }

    symbols.push(createSymbol(text, 'import', filePath, start, end, tracker, null, false, text))
    childNodes.push(createSyntaxNode('import_statement', start, end, tracker, text))
  }

  // Split lines for line-by-line indentation tracking
  const lines = content.split('\n')
  let currentOffset = 0
  let currentClass: { name: string; indent: number } | null = null

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx]
    const trimmed = line.trim()
    const lineStartOffset = currentOffset
    const lineEndOffset = currentOffset + line.length

    if (trimmed.length > 0 && !trimmed.startsWith('#')) {
      const indentMatch = line.match(/^[ \t]*/)
      const indent = indentMatch ? indentMatch[0].length : 0

      // Pop current class if current line has less or equal indentation
      if (currentClass && indent <= currentClass.indent) {
        currentClass = null
      }

      // Check for Class definition
      const classMatch = trimmed.match(/^class\s+([A-Za-z_][\w]*)(?:\s*\([^)]*\))?\s*:/)
      if (classMatch) {
        const className = classMatch[1]
        currentClass = { name: className, indent }
        symbols.push(
          createSymbol(className, 'class', filePath, lineStartOffset + indent, lineEndOffset, tracker, null, true)
        )
        childNodes.push(
          createSyntaxNode('class_definition', lineStartOffset + indent, lineEndOffset, tracker, trimmed)
        )
      } else {
        // Check for Function / Method definition
        const defMatch = trimmed.match(/^(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*(\([^)]*\)?)?\s*(?::)?/)
        if (defMatch) {
          const funcName = defMatch[1]
          const isMethod = currentClass !== null
          const isConstructor = funcName === '__init__'
          const kind = isConstructor ? 'constructor' : isMethod ? 'method' : 'function'
          const parentName = currentClass ? currentClass.name : null
          const hasColon = trimmed.endsWith(':')

          if (!hasColon) {
            hasSyntaxErrors = true
            diagnostics.push({
              message: `Incomplete function or method definition for '${funcName}' (missing colon)`,
              line: lineIdx + 1,
              column: indent + 1,
              severity: 'error'
            })
          }

          symbols.push(
            createSymbol(
              funcName,
              kind,
              filePath,
              lineStartOffset + indent,
              lineEndOffset,
              tracker,
              parentName,
              !isMethod,
              trimmed
            )
          )
          childNodes.push(
            createSyntaxNode(
              isMethod ? 'method_definition' : 'function_definition',
              lineStartOffset + indent,
              lineEndOffset,
              tracker,
              trimmed,
              [],
              !hasColon
            )
          )
        }
      }
    }

    currentOffset += line.length + 1 // +1 for '\n'
  }

  // Sort symbols deterministically
  symbols.sort((a, b) => a.startLine - b.startLine || a.startColumn - b.startColumn)

  const rootNode = createSyntaxNode('module', 0, content.length, tracker, undefined, childNodes, hasSyntaxErrors)

  return {
    rootNode,
    symbols,
    diagnostics,
    hasSyntaxErrors
  }
}
