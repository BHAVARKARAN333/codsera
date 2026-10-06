/**
 * Rust Tree-sitter Compatible Parser (Phase 11.5)
 *
 * Extracts functions, structs, enums, traits, impl methods,
 * and use declarations with visibility and trait scoping.
 */

import { ExtractedSymbol, ParseDiagnostic, SyntaxNode } from '../types'
import { createSyntaxNode, createSymbol, InternalParseOutput, LineTracker } from './base'

export function parseRustSource(filePath: string, content: string): InternalParseOutput {
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

  // 1. Use declarations (imports)
  const useRegex = /(?:^|\n)[ \t]*((?:pub\s+)?use\s+[\w:*{}, ]+);/g
  let match: RegExpExecArray | null
  while ((match = useRegex.exec(content)) !== null) {
    const start = match.index + (match[0].startsWith('\n') ? 1 : 0)
    const text = match[1].trim()
    const end = start + text.length
    const isExported = text.startsWith('pub')
    const name = text.replace(/^(?:pub\s+)?use\s+/, '')

    symbols.push(createSymbol(name, 'import', filePath, start, end, tracker, null, isExported, text))
    childNodes.push(createSyntaxNode('use_declaration', start, end, tracker, text))
  }

  // 2. Structs
  const structRegex = /(?:^|\n)[ \t]*(pub(?:\([^)]+\))?\s+)?struct\s+([A-Za-z_][\w]*)(?:<[^>]+>)?\s*([;{])/g
  while ((match = structRegex.exec(content)) !== null) {
    const start = match.index + (match[0].startsWith('\n') ? 1 : 0)
    const isExported = !!match[1]
    const name = match[2]
    const text = match[0].trim()
    const end = start + text.length

    symbols.push(createSymbol(name, 'struct', filePath, start, end, tracker, null, isExported))
    childNodes.push(createSyntaxNode('struct_item', start, end, tracker, text))
  }

  // 3. Enums
  const enumRegex = /(?:^|\n)[ \t]*(pub(?:\([^)]+\))?\s+)?enum\s+([A-Za-z_][\w]*)(?:<[^>]+>)?\s*\{/g
  while ((match = enumRegex.exec(content)) !== null) {
    const start = match.index + (match[0].startsWith('\n') ? 1 : 0)
    const isExported = !!match[1]
    const name = match[2]
    const text = match[0].trim()
    const end = start + text.length

    symbols.push(createSymbol(name, 'enum', filePath, start, end, tracker, null, isExported))
    childNodes.push(createSyntaxNode('enum_item', start, end, tracker, text))
  }

  // 4. Traits
  const traitRegex = /(?:^|\n)[ \t]*(pub(?:\([^)]+\))?\s+)?trait\s+([A-Za-z_][\w]*)(?:<[^>]+>)?(?:\s*:[^{]+)?\s*\{/g
  while ((match = traitRegex.exec(content)) !== null) {
    const start = match.index + (match[0].startsWith('\n') ? 1 : 0)
    const isExported = !!match[1]
    const name = match[2]
    const text = match[0].trim()
    const end = start + text.length

    symbols.push(createSymbol(name, 'trait', filePath, start, end, tracker, null, isExported))
    childNodes.push(createSyntaxNode('trait_item', start, end, tracker, text))
  }

  // 5. Impl Blocks & Impl Methods: impl [Trait for] Type { ... }
  const implRegex = /(?:^|\n)[ \t]*impl(?:<[^>]+>)?\s+(?:([A-Za-z_][\w]*)(?:<[^>]+>)?\s+for\s+)?([A-Za-z_][\w]*)(?:<[^>]+>)?\s*\{/g
  while ((match = implRegex.exec(content)) !== null) {
    const start = match.index + (match[0].startsWith('\n') ? 1 : 0)
    const targetType = match[2]
    const traitName = match[1] || null
    const text = match[0].trim()
    const end = start + text.length

    const implNode = createSyntaxNode('impl_item', start, end, tracker, text)
    childNodes.push(implNode)

    // Parse methods inside this impl block
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

      const methodRegex = /(?:^|\n)[ \t]*(pub(?:\([^)]+\))?\s+)?(?:async\s+)?(?:const\s+)?fn\s+([A-Za-z_][\w]*)\s*(?:<[^>]+>)?\s*\([^)]*\)/g
      let mMatch: RegExpExecArray | null
      while ((mMatch = methodRegex.exec(bodyContent)) !== null) {
        const isExported = !!mMatch[1]
        const methodName = mMatch[2]
        const mStart = openBraceIdx + 1 + mMatch.index
        const mText = mMatch[0].trim()
        const mEnd = mStart + mText.length

        symbols.push(
          createSymbol(methodName, 'method', filePath, mStart, mEnd, tracker, targetType, isExported, traitName ? `for ${traitName}` : undefined)
        )
        implNode.children.push(createSyntaxNode('function_item', mStart, mEnd, tracker, mText))
      }
    }
  }

  // 6. Free Functions (not inside an impl block)
  const fnRegex = /(?:^|\n)[ \t]*(pub(?:\([^)]+\))?\s+)?(?:async\s+)?(?:const\s+)?fn\s+([A-Za-z_][\w]*)\s*(?:<[^>]+>)?\s*\([^)]*\)/g
  while ((match = fnRegex.exec(content)) !== null) {
    const start = match.index + (match[0].startsWith('\n') ? 1 : 0)
    const isExported = !!match[1]
    const fnName = match[2]

    // Skip if already captured as method inside impl
    if (!symbols.some((s) => s.name === fnName && s.startLine === tracker.getPosition(start).line)) {
      const text = match[0].trim()
      const end = start + text.length

      symbols.push(createSymbol(fnName, 'function', filePath, start, end, tracker, null, isExported))
      childNodes.push(createSyntaxNode('function_item', start, end, tracker, text))
    }
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
