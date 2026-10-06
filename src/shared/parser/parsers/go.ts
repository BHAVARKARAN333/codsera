/**
 * Go Tree-sitter Compatible Parser (Phase 11.5)
 *
 * Extracts functions, receiver methods, structs, interfaces, types,
 * imports, and constants with Go capitalization-based export detection.
 */

import { ExtractedSymbol, ParseDiagnostic, SyntaxNode } from '../types'
import { createSyntaxNode, createSymbol, InternalParseOutput, LineTracker } from './base'

export function parseGoSource(filePath: string, content: string): InternalParseOutput {
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

  // Helper for Go export check: starts with an uppercase letter
  const isGoExported = (name: string): boolean => {
    return /^[A-Z]/.test(name)
  }

  // 1. Package declaration
  const pkgMatch = content.match(/(?:^|\n)[ \t]*package\s+([A-Za-z_][\w]*)/)
  if (pkgMatch) {
    const start = pkgMatch.index || 0
    const name = pkgMatch[1]
    const text = pkgMatch[0].trim()
    const end = start + text.length
    symbols.push(createSymbol(name, 'namespace', filePath, start, end, tracker, null, true, text))
    childNodes.push(createSyntaxNode('package_clause', start, end, tracker, text))
  }

  // 2. Imports (single-line or multiline block)
  const singleImportRegex = /(?:^|\n)[ \t]*import\s+['"]([^'"]+)['"]/g
  let match: RegExpExecArray | null
  while ((match = singleImportRegex.exec(content)) !== null) {
    const start = match.index + (match[0].startsWith('\n') ? 1 : 0)
    const name = match[1]
    const text = match[0].trim()
    const end = start + text.length
    symbols.push(createSymbol(name, 'import', filePath, start, end, tracker, null, false, text))
    childNodes.push(createSyntaxNode('import_spec', start, end, tracker, text))
  }

  const blockImportRegex = /(?:^|\n)[ \t]*import\s*\(([\s\S]*?)\)/g
  while ((match = blockImportRegex.exec(content)) !== null) {
    const start = match.index + (match[0].startsWith('\n') ? 1 : 0)
    const inner = match[1]
    const fullText = match[0].trim()
    const end = start + fullText.length

    const lineImportRegex = /['"]([^'"]+)['"]/g
    let lineMatch: RegExpExecArray | null
    while ((lineMatch = lineImportRegex.exec(inner)) !== null) {
      const impName = lineMatch[1]
      symbols.push(createSymbol(impName, 'import', filePath, start, end, tracker, null, false, impName))
    }
    childNodes.push(createSyntaxNode('import_declaration', start, end, tracker, fullText))
  }

  // 3. Types (Structs, Interfaces, Type definitions)
  const typeRegex = /(?:^|\n)[ \t]*type\s+([A-Za-z_][\w]*)\s+(struct|interface|[A-Za-z0-9_.*[\]]+)/g
  while ((match = typeRegex.exec(content)) !== null) {
    const start = match.index + (match[0].startsWith('\n') ? 1 : 0)
    const name = match[1]
    const rawKind = match[2]
    const kind = rawKind === 'struct' ? 'struct' : rawKind === 'interface' ? 'interface' : 'type'
    const text = match[0].trim()
    const end = start + text.length

    symbols.push(createSymbol(name, kind, filePath, start, end, tracker, null, isGoExported(name)))
    childNodes.push(createSyntaxNode('type_declaration', start, end, tracker, text))
  }

  // 4. Methods with receivers: func (r *Receiver) MethodName(...) ...
  const methodRegex = /(?:^|\n)[ \t]*func\s*\(\s*(?:[\w]+\s+)?\*?([A-Za-z_][\w]*)\s*\)\s*([A-Za-z_][\w]*)\s*\([^)]*\)/g
  while ((match = methodRegex.exec(content)) !== null) {
    const start = match.index + (match[0].startsWith('\n') ? 1 : 0)
    const receiverType = match[1]
    const methodName = match[2]
    const text = match[0].trim()
    const end = start + text.length

    symbols.push(
      createSymbol(methodName, 'method', filePath, start, end, tracker, receiverType, isGoExported(methodName))
    )
    childNodes.push(createSyntaxNode('method_declaration', start, end, tracker, text))
  }

  // 5. Global Functions: func FunctionName(...) ...
  const funcRegex = /(?:^|\n)[ \t]*func\s+([A-Za-z_][\w]*)\s*\([^)]*\)/g
  while ((match = funcRegex.exec(content)) !== null) {
    const start = match.index + (match[0].startsWith('\n') ? 1 : 0)
    const funcName = match[1]
    const text = match[0].trim()
    const end = start + text.length

    symbols.push(createSymbol(funcName, 'function', filePath, start, end, tracker, null, isGoExported(funcName)))
    childNodes.push(createSyntaxNode('function_declaration', start, end, tracker, text))
  }

  // 6. Constants & Variables
  const constVarRegex = /(?:^|\n)[ \t]*(const|var)\s+([A-Za-z_][\w]*)\s*(?:[A-Za-z0-9_.*[\]]+)?\s*=/g
  while ((match = constVarRegex.exec(content)) !== null) {
    const start = match.index + (match[0].startsWith('\n') ? 1 : 0)
    const kind = match[1] === 'const' ? 'constant' : 'variable'
    const name = match[2]
    const text = match[0].trim()
    const end = start + text.length

    symbols.push(createSymbol(name, kind, filePath, start, end, tracker, null, isGoExported(name)))
    childNodes.push(createSyntaxNode('const_var_declaration', start, end, tracker, text))
  }

  // Sort symbols
  symbols.sort((a, b) => a.startLine - b.startLine || a.startColumn - b.startColumn)

  const rootNode = createSyntaxNode('source_file', 0, content.length, tracker, undefined, childNodes, hasSyntaxErrors)

  return {
    rootNode,
    symbols,
    diagnostics,
    hasSyntaxErrors
  }
}
