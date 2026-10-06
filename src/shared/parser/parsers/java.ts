/**
 * Java Tree-sitter Compatible Parser (Phase 11.5)
 *
 * Extracts classes, interfaces, enums, methods, constructors, fields,
 * packages, and imports with class nesting and fault tolerance.
 */

import { ExtractedSymbol, ParseDiagnostic, SyntaxNode } from '../types'
import { createSyntaxNode, createSymbol, InternalParseOutput, LineTracker } from './base'

export function parseJavaSource(filePath: string, content: string): InternalParseOutput {
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

  // 1. Package declaration
  const pkgMatch = content.match(/(?:^|\n)[ \t]*package\s+([\w.]+)\s*;/m)
  if (pkgMatch) {
    const start = pkgMatch.index || 0
    const name = pkgMatch[1]
    const text = pkgMatch[0].trim()
    const end = start + text.length
    symbols.push(createSymbol(name, 'namespace', filePath, start, end, tracker, null, true, text))
    childNodes.push(createSyntaxNode('package_declaration', start, end, tracker, text))
  }

  // 2. Imports
  const importRegex = /(?:^|\n)[ \t]*(import\s+(?:static\s+)?[\w.*]+)\s*;/g
  let match: RegExpExecArray | null
  while ((match = importRegex.exec(content)) !== null) {
    const start = match.index + (match[0].startsWith('\n') ? 1 : 0)
    const text = match[1].trim()
    const end = start + text.length
    const name = text.replace(/^import\s+(?:static\s+)?/, '')

    symbols.push(createSymbol(name, 'import', filePath, start, end, tracker, null, false, text))
    childNodes.push(createSyntaxNode('import_declaration', start, end, tracker, text))
  }

  // 3. Classes, Interfaces, Enums
  const typeDeclRegex = /(?:^|\n)[ \t]*((?:public|protected|private|abstract|static|final)\s+)*(class|interface|enum)\s+([A-Za-z_][\w]*)(?:<[^>]+>)?(?:\s+extends\s+[^{]+)?(?:\s+implements\s+[^{]+)?\s*\{/g
  while ((match = typeDeclRegex.exec(content)) !== null) {
    const start = match.index + (match[0].startsWith('\n') ? 1 : 0)
    const modifiers = match[1] || ''
    const isExported = modifiers.includes('public')
    const typeKind = match[2] as 'class' | 'interface' | 'enum'
    const typeName = match[3]
    const text = match[0].trim()
    const end = start + text.length

    symbols.push(createSymbol(typeName, typeKind, filePath, start, end, tracker, null, isExported))
    const typeNode = createSyntaxNode(`${typeKind}_declaration`, start, end, tracker, text)
    childNodes.push(typeNode)

    // Parse members within body
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

      // Constructors
      const ctorRegex = new RegExp(`(?:^|\\n)[ \\t]*((?:public|protected|private)\\s+)?${typeName}\\s*\\([^)]*\\)\\s*(?:throws\\s+[^{]+)?\\s*\\{`, 'g')
      let ctorMatch: RegExpExecArray | null
      while ((ctorMatch = ctorRegex.exec(bodyContent)) !== null) {
        const cStart = openBraceIdx + 1 + ctorMatch.index
        const cText = ctorMatch[0].trim()
        const cEnd = cStart + cText.length
        symbols.push(createSymbol(typeName, 'constructor', filePath, cStart, cEnd, tracker, typeName, isExported))
        typeNode.children.push(createSyntaxNode('constructor_declaration', cStart, cEnd, tracker, cText))
      }

      // Methods
      const methodRegex = /(?:^|\n)[ \t]*((?:(?:public|protected|private|static|final|abstract|synchronized|native|default)\s+)*)(?!if|for|while|switch|catch|return)(?:<[^>]+>\s+)?([A-Za-z0-9_<>[\], ]+?)\s+([A-Za-z_][\w]*)\s*\([^)]*\)\s*(?:throws\s+[^;{]+)?\s*(\{|;)/g
      let mMatch: RegExpExecArray | null
      while ((mMatch = methodRegex.exec(bodyContent)) !== null) {
        const methodName = mMatch[3]
        if (methodName !== typeName) {
          const mStart = openBraceIdx + 1 + mMatch.index
          const mText = mMatch[0].trim()
          const mEnd = mStart + mText.length
          const mMods = mMatch[1] || ''

          symbols.push(
            createSymbol(
              methodName,
              'method',
              filePath,
              mStart,
              mEnd,
              tracker,
              typeName,
              mMods.includes('public') || typeKind === 'interface'
            )
          )
          typeNode.children.push(createSyntaxNode('method_declaration', mStart, mEnd, tracker, mText))
        }
      }

      // Fields (public static final or regular fields)
      const fieldRegex = /(?:^|\n)[ \t]*((?:public|protected|private|static|final)\s+)+([A-Za-z0-9_<>[\], ]+?)\s+([A-Za-z_][\w]*)\s*(?:=[^;]+)?;/g
      let fMatch: RegExpExecArray | null
      while ((fMatch = fieldRegex.exec(bodyContent)) !== null) {
        const fieldName = fMatch[3]
        // Make sure it wasn't a method or constructor
        if (!symbols.some((s) => s.name === fieldName && s.parent === typeName)) {
          const fStart = openBraceIdx + 1 + fMatch.index
          const fText = fMatch[0].trim()
          const fEnd = fStart + fText.length
          symbols.push(createSymbol(fieldName, 'property', filePath, fStart, fEnd, tracker, typeName, fMatch[1].includes('public')))
          typeNode.children.push(createSyntaxNode('field_declaration', fStart, fEnd, tracker, fText))
        }
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
