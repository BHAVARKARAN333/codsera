/**
 * Parser Foundation Base Utilities (Phase 11.5)
 *
 * Provides line-offset indexing, position mapping, syntax node construction,
 * and error recovery primitives for multi-language AST building.
 */

import {
  ExtractedSymbol,
  ParseDiagnostic,
  SymbolKind,
  SyntaxNode,
  SyntaxNodePosition
} from '../types'

export class LineTracker {
  private lineOffsets: number[] = [0]
  private textLength: number

  constructor(text: string) {
    this.textLength = text.length
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) {
        // '\n'
        this.lineOffsets.push(i + 1)
      }
    }
  }

  /**
   * Translates a 0-based character index to 1-based line & column numbers,
   * plus a 0-based row for Tree-sitter compatibility.
   */
  getPosition(offset: number): { line: number; column: number; row: number } {
    const clamped = Math.max(0, Math.min(offset, this.textLength))
    let low = 0
    let high = this.lineOffsets.length - 1

    while (low <= high) {
      const mid = (low + high) >> 1
      if (this.lineOffsets[mid] <= clamped) {
        low = mid + 1
      } else {
        high = mid - 1
      }
    }

    const rowIndex = Math.max(0, high) // 0-based row
    const line = rowIndex + 1 // 1-based line
    const col = clamped - this.lineOffsets[rowIndex] + 1 // 1-based column

    return { line, column: col, row: rowIndex }
  }

  getTreeSitterPosition(offset: number): SyntaxNodePosition {
    const pos = this.getPosition(offset)
    return { row: pos.row, column: pos.column - 1 }
  }
}

export function createSyntaxNode(
  type: string,
  startIndex: number,
  endIndex: number,
  tracker: LineTracker,
  text?: string,
  children: SyntaxNode[] = [],
  isError = false
): SyntaxNode {
  const startPos = tracker.getTreeSitterPosition(startIndex)
  const endPos = tracker.getTreeSitterPosition(endIndex)

  const node: SyntaxNode = {
    type,
    text,
    startPosition: startPos,
    endPosition: endPos,
    startIndex,
    endIndex,
    children,
    isError,
    hasError: isError || children.some((c) => c.hasError || c.isError)
  }

  for (const child of children) {
    child.parent = node
  }

  return node
}

export function createSymbol(
  name: string,
  kind: SymbolKind,
  filePath: string,
  startIndex: number,
  endIndex: number,
  tracker: LineTracker,
  parent: string | null = null,
  exported = false,
  detail?: string
): ExtractedSymbol {
  const start = tracker.getPosition(startIndex)
  const end = tracker.getPosition(endIndex)

  return {
    name: name.trim(),
    kind,
    filePath,
    startLine: start.line,
    startColumn: start.column,
    endLine: end.line,
    endColumn: end.column,
    parent: parent ? parent.trim() : null,
    exported,
    detail: detail ? detail.trim() : undefined
  }
}

export interface InternalParseOutput {
  rootNode: SyntaxNode
  symbols: ExtractedSymbol[]
  diagnostics: ParseDiagnostic[]
  hasSyntaxErrors: boolean
}
