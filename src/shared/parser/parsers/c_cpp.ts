/**
 * C / C++ Tree-sitter Compatible Parser (Phase 11.5)
 *
 * Extracts functions, classes, structs, methods, namespaces,
 * enums, and includes with fault tolerance.
 */

import { ExtractedSymbol, ParseDiagnostic, SyntaxNode } from '../types'
import { createSyntaxNode, createSymbol, InternalParseOutput, LineTracker } from './base'

export function parseCCppSource(filePath: string, content: string): InternalParseOutput {
  const tracker = new LineTracker(content)
  const symbols: ExtractedSymbol[] = []
  const diagnostics: ParseDiagnostic[] = []
  const childNodes: SyntaxNode[] = []
  let hasSyntaxErrors = false

  // Check delimiter balance
  const openBraces = (content.match(/\{/g) || []).length
  const closeBraces = (content.match(/\}/g) || []).length
  const openParens = (content.match(/\(/g) || []).length
  const closeParens = (content.match(/\)/g) || []).length

  if (openBraces !== closeBraces || openParens !== closeParens) {
    hasSyntaxErrors = true
    const pos = tracker.getPosition(content.length)
    diagnostics.push({
      message: `Unmatched delimiters (braces: ${openBraces}/${closeBraces}, parens: ${openParens}/${closeParens})`,
      line: pos.line,
      column: pos.column,
      severity: 'error'
    })
  }

  // 1. Includes
  const includeRegex = /(?:^|\n)[ \t]*(#include\s+[<"][^>"]+[>"])/g
  let match: RegExpExecArray | null
  while ((match = includeRegex.exec(content)) !== null) {
    const start = match.index + (match[0].startsWith('\n') ? 1 : 0)
    const text = match[1].trim()
    const end = start + text.length
    const headerName = text.replace(/^#include\s+[<"]/, '').replace(/[>"]$/, '')

    symbols.push(createSymbol(headerName, 'import', filePath, start, end, tracker, null, false, text))
    childNodes.push(createSyntaxNode('preproc_include', start, end, tracker, text))
  }

  // 2. Namespaces
  const nsRegex = /(?:^|\n)[ \t]*namespace\s+([A-Za-z_][\w:]*)\s*\{/g
  while ((match = nsRegex.exec(content)) !== null) {
    const start = match.index + (match[0].startsWith('\n') ? 1 : 0)
    const nsName = match[1]
    const text = match[0].trim()
    const end = start + text.length

    symbols.push(createSymbol(nsName, 'namespace', filePath, start, end, tracker, null, true))
    childNodes.push(createSyntaxNode('namespace_definition', start, end, tracker, text))
  }

  // 3. Classes & Structs
  const classStructRegex = /(?:^|\n)[ \t]*(class|struct|union)\s+([A-Za-z_][\w]*)(?:\s*:[^{]+)?\s*\{/g
  while ((match = classStructRegex.exec(content)) !== null) {
    const start = match.index + (match[0].startsWith('\n') ? 1 : 0)
    const kind = match[1] === 'struct' ? 'struct' : 'class'
    const name = match[2]
    const text = match[0].trim()
    const end = start + text.length

    symbols.push(createSymbol(name, kind, filePath, start, end, tracker, null, true))
    const structNode = createSyntaxNode(`${kind}_specifier`, start, end, tracker, text)
    childNodes.push(structNode)

    // Parse member methods within class/struct
    const openBraceIdx = content.indexOf('{', start)
    if (openBraceIdx !== -1) {
      let depth = 1
      let bodyEnd = -1
      for (let i = openBraceIdx + 1; i < content.length; i++) {
        if (content[i] === '{') depth++
        else if (content[i] === '}') {
          depth--
          if (depth === 0) {
            bodyEnd = i
            break
          }
        }
      }

      const searchEnd = bodyEnd !== -1 ? bodyEnd : content.length
      const bodyContent = content.slice(openBraceIdx + 1, searchEnd)

      // Inner methods
      const innerMethodRegex = /(?:^|\n)[ \t]*(?:virtual\s+|static\s+|inline\s+)?(?:[A-Za-z0-9_&*<>:]+\s+)+([A-Za-z_][\w]*)\s*\([^)]*\)\s*(?:const\s*)?(?:override\s*)?(?:final\s*)?(?:=\s*0\s*)?(\{|;)/g
      let mMatch: RegExpExecArray | null
      while ((mMatch = innerMethodRegex.exec(bodyContent)) !== null) {
        const methodName = mMatch[1]
        const mStart = openBraceIdx + 1 + mMatch.index
        const mText = mMatch[0].trim()
        const mEnd = mStart + mText.length

        symbols.push(createSymbol(methodName, 'method', filePath, mStart, mEnd, tracker, name, true))
        structNode.children.push(createSyntaxNode('function_definition', mStart, mEnd, tracker, mText))
      }
    }
  }

  // 4. Out-of-line methods (e.g. void Engine::start() { ... })
  const outOfLineRegex = /(?:^|\n)[ \t]*(?:[A-Za-z0-9_&*<>:]+\s+)+([A-Za-z_][\w]*)::([A-Za-z_][\w]*)\s*\([^)]*\)\s*(?:const\s*)?\{/g
  while ((match = outOfLineRegex.exec(content)) !== null) {
    const start = match.index + (match[0].startsWith('\n') ? 1 : 0)
    const parentClass = match[1]
    const methodName = match[2]
    const text = match[0].trim()
    const end = start + text.length

    symbols.push(createSymbol(methodName, 'method', filePath, start, end, tracker, parentClass, true))
    childNodes.push(createSyntaxNode('function_definition', start, end, tracker, text))
  }

  // 5. Global Functions
  const funcRegex = /(?:^|\n)[ \t]*(?:inline\s+|static\s+|extern\s+)?([A-Za-z0-9_&*<>:]+)\s+([A-Za-z_][\w]*)\s*\([^)]*\)\s*\{/g
  while ((match = funcRegex.exec(content)) !== null) {
    const start = match.index + (match[0].startsWith('\n') ? 1 : 0)
    const returnType = match[1]
    const funcName = match[2]

    // Skip control flow keywords (if, while, for, switch)
    if (['if', 'while', 'for', 'switch', 'catch'].includes(funcName)) {
      continue
    }

    // Skip if already captured as method
    if (!symbols.some((s) => s.name === funcName && s.startLine === tracker.getPosition(start).line)) {
      const text = match[0].trim()
      const end = start + text.length

      symbols.push(createSymbol(funcName, 'function', filePath, start, end, tracker, null, true, returnType))
      childNodes.push(createSyntaxNode('function_definition', start, end, tracker, text))
    }
  }

  // 6. Enums
  const enumRegex = /(?:^|\n)[ \t]*enum(?:\s+class)?\s+([A-Za-z_][\w]*)\s*\{/g
  while ((match = enumRegex.exec(content)) !== null) {
    const start = match.index + (match[0].startsWith('\n') ? 1 : 0)
    const enumName = match[1]
    const text = match[0].trim()
    const end = start + text.length

    symbols.push(createSymbol(enumName, 'enum', filePath, start, end, tracker, null, true))
    childNodes.push(createSyntaxNode('enum_specifier', start, end, tracker, text))
  }

  // Sort symbols
  symbols.sort((a, b) => a.startLine - b.startLine || a.startColumn - b.startColumn)

  const rootNode = createSyntaxNode('translation_unit', 0, content.length, tracker, undefined, childNodes, hasSyntaxErrors)

  return {
    rootNode,
    symbols,
    diagnostics,
    hasSyntaxErrors
  }
}
