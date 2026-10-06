/**
 * Tree-sitter Multi-language Parsing & Symbol Extraction Types (Phase 11.5)
 *
 * Production-oriented AST & symbol extraction abstractions designed for
 * multi-language code intelligence, Repo Maps, and context optimization.
 */

export type SupportedLanguage =
  | 'javascript'
  | 'typescript'
  | 'tsx'
  | 'jsx'
  | 'python'
  | 'java'
  | 'c'
  | 'cpp'
  | 'csharp'
  | 'go'
  | 'rust'
  | 'json'
  | 'html'
  | 'css'

export type LanguageId = SupportedLanguage | 'unknown'

export interface LanguageDetectionResult {
  language: LanguageId
  displayName: string
  isSupported: boolean
  extension: string
}

export type SymbolKind =
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'struct'
  | 'trait'
  | 'impl'
  | 'property'
  | 'variable'
  | 'constant'
  | 'constructor'
  | 'namespace'
  | 'module'
  | 'import'
  | 'export'
  | 'rule'
  | 'tag'
  | 'object'

export interface SymbolPosition {
  /** 1-based line number (aligned with read_file_range) */
  line: number
  /** 1-based column offset */
  column: number
}

export interface ExtractedSymbol {
  name: string
  kind: SymbolKind
  filePath: string
  startLine: number
  startColumn: number
  endLine: number
  endColumn: number
  parent: string | null
  exported: boolean
  detail?: string
}

export interface SyntaxNodePosition {
  /** 0-based row offset (standard Tree-sitter row index) */
  row: number
  /** 0-based column offset */
  column: number
}

export interface SyntaxNode {
  type: string
  text?: string
  startPosition: SyntaxNodePosition
  endPosition: SyntaxNodePosition
  startIndex: number
  endIndex: number
  children: SyntaxNode[]
  parent?: SyntaxNode | null
  isError?: boolean
  hasError?: boolean
}

export interface SyntaxTree {
  language: SupportedLanguage
  rootNode: SyntaxNode
  hasSyntaxErrors: boolean
  text: string
}

export interface ParseDiagnostic {
  message: string
  line: number
  column: number
  severity: 'error' | 'warning' | 'info'
}

export interface ParseResult {
  filePath: string
  language: LanguageId
  parsed: boolean
  isSupported: boolean
  hasSyntaxErrors: boolean
  rootNode?: SyntaxNode
  symbols: ExtractedSymbol[]
  diagnostics: ParseDiagnostic[]
  cached?: boolean
  parseTimeMs: number
}

export interface ParseSourceOptions {
  filePath: string
  content: string
  language?: LanguageId
  bypassCache?: boolean
}
