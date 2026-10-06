/**
 * C# Tree-sitter Compatible Parser (Phase 11.5)
 *
 * Extracts classes, interfaces, enums, methods, properties,
 * namespaces, and using directives with class member scoping.
 */

import { ExtractedSymbol, ParseDiagnostic, SyntaxNode } from '../types'
import { createSyntaxNode, createSymbol, InternalParseOutput, LineTracker } from './base'

export function parseCSharpSource(filePath: string, content: string): InternalParseOutput {
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

  // 1. Using directives (imports)
  const usingRegex = /(?:^|\n)[ \t]*(using\s+(?:static\s+)?[\w.]+)\s*;/g
  let match: RegExpExecArray | null
  while ((match = usingRegex.exec(content)) !== null) {
    const start = match.index + (match[0].startsWith('\n') ? 1 : 0)
    const text = match[1].trim()
    const end = start + text.length
    const name = text.replace(/^using\s+(?:static\s+)?/, '')

    symbols.push(createSymbol(name, 'import', filePath, start, end, tracker, null, false, text))
    childNodes.push(createSyntaxNode('using_directive', start, end, tracker, text))
  }

  // 2. Namespaces (block or file-scoped)
  const nsRegex = /(?:^|\n)[ \t]*namespace\s+([\w.]+)\s*([;{])/g
  while ((match = nsRegex.exec(content)) !== null) {
    const start = match.index + (match[0].startsWith('\n') ? 1 : 0)
    const nsName = match[1]
    const text = match[0].trim()
    const end = start + text.length

    symbols.push(createSymbol(nsName, 'namespace', filePath, start, end, tracker, null, true))
    childNodes.push(createSyntaxNode('namespace_declaration', start, end, tracker, text))
  }

  // 3. Classes, Interfaces, Enums, Structs
  const typeRegex = /(?:^|\n)[ \t]*((?:public|internal|protected|private|static|abstract|sealed|partial)\s+)*(class|interface|enum|struct|record)\s+([A-Za-z_][\w]*)(?:<[^>]+>)?(?:\s*:[^{]+)?\s*\{/g
  while ((match = typeRegex.exec(content)) !== null) {
    const start = match.index + (match[0].startsWith('\n') ? 1 : 0)
    const modifiers = match[1] || ''
    const isPublic = modifiers.includes('public')
    const rawKind = match[2]
    const kind = rawKind === 'class' || rawKind === 'record' ? 'class' : rawKind === 'interface' ? 'interface' : rawKind === 'enum' ? 'enum' : 'struct'
    const typeName = match[3]
    const text = match[0].trim()
    const end = start + text.length

    symbols.push(createSymbol(typeName, kind, filePath, start, end, tracker, null, isPublic))
    const typeNode = createSyntaxNode(`${kind}_declaration`, start, end, tracker, text)
    childNodes.push(typeNode)

    // Parse member methods & properties
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

      // Methods
      const methodRegex = /(?:^|\n)[ \t]*((?:public|protected|private|internal|static|async|override|virtual|abstract)\s+)+(?:[A-Za-z0-9_<>[\],? ]+?)\s+([A-Za-z_][\w]*)\s*\([^)]*\)\s*(\{|=>)/g
      let mMatch: RegExpExecArray | null
      while ((mMatch = methodRegex.exec(bodyContent)) !== null) {
        const methodName = mMatch[2]
        const mStart = openBraceIdx + 1 + mMatch.index
        const mText = mMatch[0].trim()
        const mEnd = mStart + mText.length
        const mMods = mMatch[1] || ''

        symbols.push(
          createSymbol(methodName, 'method', filePath, mStart, mEnd, tracker, typeName, mMods.includes('public'))
        )
        typeNode.children.push(createSyntaxNode('method_declaration', mStart, mEnd, tracker, mText))
      }

      // Properties (e.g. public string Name { get; set; })
      const propRegex = /(?:^|\n)[ \t]*((?:public|protected|private|internal|static)\s+)+(?:[A-Za-z0-9_<>[\],? ]+?)\s+([A-Za-z_][\w]*)\s*\{\s*(?:get|set|init)/g
      let pMatch: RegExpExecArray | null
      while ((pMatch = propRegex.exec(bodyContent)) !== null) {
        const propName = pMatch[2]
        const pStart = openBraceIdx + 1 + pMatch.index
        const pText = pMatch[0].trim()
        const pEnd = pStart + pText.length

        symbols.push(
          createSymbol(propName, 'property', filePath, pStart, pEnd, tracker, typeName, pMatch[1].includes('public'))
        )
        typeNode.children.push(createSyntaxNode('property_declaration', pStart, pEnd, tracker, pText))
      }
    }
  }

  // Sort symbols
  symbols.sort((a, b) => a.startLine - b.startLine || a.startColumn - b.startColumn)

  const rootNode = createSyntaxNode('compilation_unit', 0, content.length, tracker, undefined, childNodes, hasSyntaxErrors)

  return {
    rootNode,
    symbols,
    diagnostics,
    hasSyntaxErrors
  }
}
