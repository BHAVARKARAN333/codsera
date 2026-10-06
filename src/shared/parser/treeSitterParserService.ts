/**
 * Tree-sitter Parser Service Facade (Phase 11.5)
 *
 * Central, production-grade parser facade supporting multi-language syntax
 * analysis, AST node generation, symbol extraction, and bounded LRU caching.
 *
 * Safe for Electron renderer and main processes (100% offline, zero native deps).
 */

import {
  ExtractedSymbol,
  LanguageDetectionResult,
  LanguageId,
  ParseResult,
  ParseSourceOptions,
  SupportedLanguage
} from './types'
import { detectLanguageFromPath, isLanguageSupported } from './languageDetector'
import { CacheStats, ParserCache } from './parserCache'
import { InternalParseOutput } from './parsers/base'
import { parseTypeScriptSource } from './parsers/typescript'
import { parsePythonSource } from './parsers/python'
import { parseJavaSource } from './parsers/java'
import { parseCCppSource } from './parsers/c_cpp'
import { parseCSharpSource } from './parsers/csharp'
import { parseGoSource } from './parsers/go'
import { parseRustSource } from './parsers/rust'
import { parseCssSource, parseHtmlSource, parseJsonSource } from './parsers/markup'

export class TreeSitterParserService {
  private readonly cache: ParserCache

  constructor(maxCacheEntries = 100) {
    this.cache = new ParserCache(maxCacheEntries)
  }

  /**
   * Detects the programming language for a given file path.
   */
  detectLanguage(filePath: string): LanguageDetectionResult {
    return detectLanguageFromPath(filePath)
  }

  /**
   * Parses source code, generates AST nodes, and extracts code symbols.
   * Leverages bounded LRU caching unless bypassCache is explicitly requested.
   */
  parseSource(options: ParseSourceOptions): ParseResult {
    const startTime = performance.now()
    const { filePath, content, bypassCache = false } = options

    // Check LRU cache first
    if (!bypassCache) {
      const cachedResult = this.cache.get(filePath, content)
      if (cachedResult) {
        return cachedResult
      }
    }

    // Determine target language
    let targetLang: LanguageId
    if (options.language && isLanguageSupported(options.language)) {
      targetLang = options.language
    } else {
      const detected = this.detectLanguage(filePath)
      targetLang = detected.language
    }

    // Handle unsupported/unknown file formats safely
    if (!isLanguageSupported(targetLang)) {
      const unsupportedResult: ParseResult = {
        filePath,
        language: targetLang,
        parsed: false,
        isSupported: false,
        hasSyntaxErrors: false,
        symbols: [],
        diagnostics: [],
        cached: false,
        parseTimeMs: Math.round((performance.now() - startTime) * 100) / 100
      }
      return unsupportedResult
    }

    try {
      const parsedOutput = this.executeLanguageParser(targetLang, filePath, content)
      const parseTimeMs = Math.round((performance.now() - startTime) * 100) / 100

      const result: ParseResult = {
        filePath,
        language: targetLang,
        parsed: true,
        isSupported: true,
        hasSyntaxErrors: parsedOutput.hasSyntaxErrors,
        rootNode: parsedOutput.rootNode,
        symbols: parsedOutput.symbols,
        diagnostics: parsedOutput.diagnostics,
        cached: false,
        parseTimeMs
      }

      // Store in LRU cache
      this.cache.set(filePath, content, result)

      return result
    } catch (err: unknown) {
      const parseTimeMs = Math.round((performance.now() - startTime) * 100) / 100
      const errorMessage = err instanceof Error ? err.message : String(err)

      // Safe failure mode: never throw or crash the IDE
      const failureResult: ParseResult = {
        filePath,
        language: targetLang,
        parsed: false,
        isSupported: true,
        hasSyntaxErrors: true,
        symbols: [],
        diagnostics: [
          {
            message: `Parser execution failed: ${errorMessage}`,
            line: 1,
            column: 1,
            severity: 'error'
          }
        ],
        cached: false,
        parseTimeMs
      }

      return failureResult
    }
  }

  /**
   * Helper to extract symbols directly from source content.
   */
  extractSymbols(filePath: string, content: string): ExtractedSymbol[] {
    const parseResult = this.parseSource({ filePath, content })
    return parseResult.symbols
  }

  /**
   * Clears the in-memory parse cache.
   */
  clearCache(): void {
    this.cache.clear()
  }

  /**
   * Invalidates cached results for a specific file path.
   */
  invalidateFile(filePath: string): void {
    this.cache.invalidateFile(filePath)
  }

  /**
   * Returns current cache statistics.
   */
  getCacheStats(): CacheStats {
    return this.cache.getStats()
  }

  /**
   * Returns the underlying ParserCache instance.
   */
  getCache(): ParserCache {
    return this.cache
  }

  /**
   * Internal language-specific parser dispatcher.
   */
  private executeLanguageParser(
    lang: SupportedLanguage,
    filePath: string,
    content: string
  ): InternalParseOutput {
    switch (lang) {
      case 'javascript':
      case 'typescript':
      case 'tsx':
      case 'jsx':
        return parseTypeScriptSource(filePath, content)

      case 'python':
        return parsePythonSource(filePath, content)

      case 'java':
        return parseJavaSource(filePath, content)

      case 'c':
      case 'cpp':
        return parseCCppSource(filePath, content)

      case 'csharp':
        return parseCSharpSource(filePath, content)

      case 'go':
        return parseGoSource(filePath, content)

      case 'rust':
        return parseRustSource(filePath, content)

      case 'json':
        return parseJsonSource(filePath, content)

      case 'html':
        return parseHtmlSource(filePath, content)

      case 'css':
        return parseCssSource(filePath, content)

      default: {
        const _exhaustive: never = lang
        throw new Error(`Unhandled parser language: ${_exhaustive}`)
      }
    }
  }
}

/**
 * Singleton parser service instance for shared application access.
 */
export const defaultParserService = new TreeSitterParserService()
