/**
 * JavaScript / TypeScript / TSX / JSX Tree-sitter Compatible Parser (Phase 11.5)
 *
 * Extracts functions, classes, methods, constructors, interfaces, types,
 * enums, variables, constants, imports, and exports with fault tolerance.
 */

import { ExtractedSymbol, ParseDiagnostic, SyntaxNode } from '../types'
import { createSyntaxNode, createSymbol, InternalParseOutput, LineTracker } from './base'

export function parseTypeScriptSource(filePath: string, content: string): InternalParseOutput {
  const tracker = new LineTracker(content)
  const symbols: ExtractedSymbol[] = []
  const diagnostics: ParseDiagnostic[] = []
  const childNodes: SyntaxNode[] = []
  let hasSyntaxErrors = false

  // Check for unclosed delimiters or malformed syntax
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

  // 1. Imports
  const importRegex = /(?:^|\n)[ \t]*(import\s+(?:(?:type\s+)?[\w*\s{},$]+?\s+from\s+)?['"][^'"]+['"])/g
  let match: RegExpExecArray | null
  while ((match = importRegex.exec(content)) !== null) {
    const start = match.index + (match[0].startsWith('\n') ? 1 : 0)
    const text = match[1]
    const end = start + text.length

    // Extract specifier or imported name
    const specMatch = text.match(/from\s+['"]([^'"]+)['"]/)
    const name = specMatch ? specMatch[1] : text

    symbols.push(createSymbol(name, 'import', filePath, start, end, tracker, null, false, text))
    childNodes.push(createSyntaxNode('import_statement', start, end, tracker, text))
  }

  // 2. Interfaces
  const interfaceRegex = /(?:^|\n)[ \t]*(export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)(?:<[^>]+>)?(?:\s+extends\s+[^{]+)?\s*\{/g
  while ((match = interfaceRegex.exec(content)) !== null) {
    const start = match.index + (match[0].startsWith('\n') ? 1 : 0)
    const isExported = !!match[1]
    const name = match[2]
    const text = match[0].trim()
    const end = start + text.length

    symbols.push(createSymbol(name, 'interface', filePath, start, end, tracker, null, isExported))
    childNodes.push(createSyntaxNode('interface_declaration', start, end, tracker, text))
  }

  // 3. Type aliases
  const typeRegex = /(?:^|\n)[ \t]*(export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)(?:<[^>]+>)?\s*=/g
  while ((match = typeRegex.exec(content)) !== null) {
    const start = match.index + (match[0].startsWith('\n') ? 1 : 0)
    const isExported = !!match[1]
    const name = match[2]
    const text = match[0].trim()
    const end = start + text.length

    symbols.push(createSymbol(name, 'type', filePath, start, end, tracker, null, isExported))
    childNodes.push(createSyntaxNode('type_alias_declaration', start, end, tracker, text))
  }

  // 4. Enums
  const enumRegex = /(?:^|\n)[ \t]*(export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)\s*\{/g
  while ((match = enumRegex.exec(content)) !== null) {
    const start = match.index + (match[0].startsWith('\n') ? 1 : 0)
    const isExported = !!match[1]
    const name = match[2]
    const text = match[0].trim()
    const end = start + text.length

    symbols.push(createSymbol(name, 'enum', filePath, start, end, tracker, null, isExported))
    childNodes.push(createSyntaxNode('enum_declaration', start, end, tracker, text))
  }

  // 5. Classes & Class Methods / Constructors
  const classRegex = /(?:^|\n)[ \t]*(export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)(?:<[^>]+>)?(?:\s+extends\s+[^{]+)?(?:\s+implements\s+[^{]+)?\s*\{/g
  while ((match = classRegex.exec(content)) !== null) {
    const start = match.index + (match[0].startsWith('\n') ? 1 : 0)
    const isExported = !!match[1]
    const className = match[2]
    const text = match[0].trim()
    const end = start + text.length

    symbols.push(createSymbol(className, 'class', filePath, start, end, tracker, null, isExported))
    const classNode = createSyntaxNode('class_declaration', start, end, tracker, text)
    childNodes.push(classNode)

    // Find class body end (balance braces)
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
      const classBody = content.slice(openBraceIdx + 1, searchEnd)

      // Methods inside class
      const methodRegex = /(?:^|\n)[ \t]*(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:async\s+)?(?:\*\s*)?(get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{;]+)?\s*\{/g
      let methodMatch: RegExpExecArray | null
      while ((methodMatch = methodRegex.exec(classBody)) !== null) {
        const methodStart = openBraceIdx + 1 + methodMatch.index
        const methodName = methodMatch[2]
        const isConstructor = methodName === 'constructor'
        const kind = isConstructor ? 'constructor' : 'method'
        const methodText = methodMatch[0].trim()
        const methodEnd = methodStart + methodText.length

        symbols.push(
          createSymbol(methodName, kind, filePath, methodStart, methodEnd, tracker, className, false)
        )
        classNode.children.push(createSyntaxNode(isConstructor ? 'constructor' : 'method_definition', methodStart, methodEnd, tracker, methodText))
      }
    }
  }

  // 6. Regular & Async Functions (including incomplete declarations like "function hello(")
  const funcRegex = /(?:^|\n)[ \t]*(export\s+(?:default\s+)?)?(?:async\s+)?function(?:\s*\*|\s+)\s*([A-Za-z_$][\w$]*)\s*(\([^)]*\)?)?/g
  while ((match = funcRegex.exec(content)) !== null) {
    const start = match.index + (match[0].startsWith('\n') ? 1 : 0)
    const isExported = !!match[1]
    const funcName = match[2]
    const text = match[0].trim()
    const end = start + text.length
    const hasClosedParams = !!match[3] && match[3].endsWith(')')

    if (!hasClosedParams && !content.slice(start).includes(')')) {
      hasSyntaxErrors = true
      diagnostics.push({
        message: `Incomplete function declaration for '${funcName}'`,
        line: tracker.getPosition(start).line,
        column: tracker.getPosition(start).column,
        severity: 'error'
      })
    }

    symbols.push(createSymbol(funcName, 'function', filePath, start, end, tracker, null, isExported))
    childNodes.push(createSyntaxNode('function_declaration', start, end, tracker, text, [], !hasClosedParams))
  }

  // 7. Arrow functions & Function Expressions assigned to variables
  const arrowRegex = /(?:^|\n)[ \t]*(export\s+)?(const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g
  while ((match = arrowRegex.exec(content)) !== null) {
    const start = match.index + (match[0].startsWith('\n') ? 1 : 0)
    const isExported = !!match[1]
    const name = match[3]
    const text = match[0].trim()
    const end = start + text.length

    symbols.push(createSymbol(name, 'function', filePath, start, end, tracker, null, isExported, 'arrow_function'))
    childNodes.push(createSyntaxNode('lexical_declaration', start, end, tracker, text))
  }

  // 8. Top-level variables & constants (structurally identifiable)
  const varRegex = /(?:^|\n)[ \t]*(export\s+)?(const|let|var)\s+([A-Z0-9_$]+)\s*=/g
  while ((match = varRegex.exec(content)) !== null) {
    const start = match.index + (match[0].startsWith('\n') ? 1 : 0)
    const isExported = !!match[1]
    const name = match[3]
    const isConst = match[2] === 'const'

    // Skip if already captured as arrow function
    if (!symbols.some((s) => s.name === name && s.startLine === tracker.getPosition(start).line)) {
      const text = match[0].trim()
      const end = start + text.length
      symbols.push(createSymbol(name, isConst ? 'constant' : 'variable', filePath, start, end, tracker, null, isExported))
      childNodes.push(createSyntaxNode('variable_declaration', start, end, tracker, text))
    }
  }

  // 9. Re-exports
  const exportRegex = /(?:^|\n)[ \t]*(export\s+\{[^}]+\}(?:\s+from\s+['"][^'"]+['"])?)/g
  while ((match = exportRegex.exec(content)) !== null) {
    const start = match.index + (match[0].startsWith('\n') ? 1 : 0)
    const text = match[1]
    const end = start + text.length
    symbols.push(createSymbol(text, 'export', filePath, start, end, tracker, null, true))
    childNodes.push(createSyntaxNode('export_statement', start, end, tracker, text))
  }

  // Sort symbols deterministically by start line and column
  symbols.sort((a, b) => a.startLine - b.startLine || a.startColumn - b.startColumn)

  const rootNode = createSyntaxNode('program', 0, content.length, tracker, undefined, childNodes, hasSyntaxErrors)

  return {
    rootNode,
    symbols,
    diagnostics,
    hasSyntaxErrors
  }
}
