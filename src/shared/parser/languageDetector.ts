/**
 * Multi-Language File Extension Detector (Phase 11.5)
 *
 * Deterministically maps workspace file paths to supported Tree-sitter languages.
 * Handles casing differences, multi-dot filenames, and unknown extensions safely.
 */

import { LanguageDetectionResult, SupportedLanguage } from './types'

interface LanguageMeta {
  language: SupportedLanguage
  displayName: string
}

const EXTENSION_MAP: Record<string, LanguageMeta> = {
  // JavaScript
  js: { language: 'javascript', displayName: 'JavaScript' },
  mjs: { language: 'javascript', displayName: 'JavaScript' },
  cjs: { language: 'javascript', displayName: 'JavaScript' },

  // TypeScript
  ts: { language: 'typescript', displayName: 'TypeScript' },
  mts: { language: 'typescript', displayName: 'TypeScript' },
  cts: { language: 'typescript', displayName: 'TypeScript' },

  // TSX & JSX
  tsx: { language: 'tsx', displayName: 'TSX' },
  jsx: { language: 'jsx', displayName: 'JSX' },

  // Python
  py: { language: 'python', displayName: 'Python' },
  pyw: { language: 'python', displayName: 'Python' },

  // Java
  java: { language: 'java', displayName: 'Java' },

  // C
  c: { language: 'c', displayName: 'C' },
  h: { language: 'c', displayName: 'C' },

  // C++
  cpp: { language: 'cpp', displayName: 'C++' },
  hpp: { language: 'cpp', displayName: 'C++' },
  cc: { language: 'cpp', displayName: 'C++' },
  cxx: { language: 'cpp', displayName: 'C++' },
  hxx: { language: 'cpp', displayName: 'C++' },
  hh: { language: 'cpp', displayName: 'C++' },

  // C#
  cs: { language: 'csharp', displayName: 'C#' },

  // Go
  go: { language: 'go', displayName: 'Go' },

  // Rust
  rs: { language: 'rust', displayName: 'Rust' },

  // Data & Markup
  json: { language: 'json', displayName: 'JSON' },
  html: { language: 'html', displayName: 'HTML' },
  htm: { language: 'html', displayName: 'HTML' },
  css: { language: 'css', displayName: 'CSS' },
  scss: { language: 'css', displayName: 'CSS' },
  less: { language: 'css', displayName: 'CSS' }
}

const ALL_SUPPORTED_LANGUAGES: SupportedLanguage[] = [
  'javascript',
  'typescript',
  'tsx',
  'jsx',
  'python',
  'java',
  'c',
  'cpp',
  'csharp',
  'go',
  'rust',
  'json',
  'html',
  'css'
]

/**
 * Extracts the file extension from a file path safely, ignoring directory segments.
 * Returns empty string if the file has no extension (e.g. "Dockerfile", "README").
 */
export function extractExtension(filePath: string): string {
  if (!filePath || typeof filePath !== 'string') return ''

  // Normalize path separators to forward slash
  const normalized = filePath.replace(/\\/g, '/')
  const baseName = normalized.split('/').pop() || ''

  // Leading dot without second dot (e.g. ".gitignore") is not treated as extension
  const lastDotIndex = baseName.lastIndexOf('.')
  if (lastDotIndex <= 0) {
    return ''
  }

  return baseName.slice(lastDotIndex + 1).toLowerCase()
}

/**
 * Detects the programming language for a given file path based on its extension.
 */
export function detectLanguageFromPath(filePath: string): LanguageDetectionResult {
  const extension = extractExtension(filePath)

  if (!extension) {
    return {
      language: 'unknown',
      displayName: 'Unknown',
      isSupported: false,
      extension: ''
    }
  }

  const meta = EXTENSION_MAP[extension]
  if (meta) {
    return {
      language: meta.language,
      displayName: meta.displayName,
      isSupported: true,
      extension
    }
  }

  return {
    language: 'unknown',
    displayName: 'Unknown',
    isSupported: false,
    extension
  }
}

/**
 * Checks whether a given language string is recognized as a supported language.
 */
export function isLanguageSupported(language: string): language is SupportedLanguage {
  return ALL_SUPPORTED_LANGUAGES.includes(language as SupportedLanguage)
}

/**
 * Returns an immutable list of all supported languages.
 */
export function getSupportedLanguages(): SupportedLanguage[] {
  return [...ALL_SUPPORTED_LANGUAGES]
}
