import { describe, it, expect, beforeEach } from 'vitest'
import { DependencyAnalyzer } from '@renderer/services/agent/dependencyAnalyzer'

describe('dependencyAnalyzer Unit Tests', () => {
  let analyzer: DependencyAnalyzer

  beforeEach(() => {
    analyzer = new DependencyAnalyzer({
      baseUrl: '.',
      pathAliases: {
        '@shared/*': ['src/shared/*'],
        '@renderer/*': ['src/renderer/src/*']
      }
    })
  })

  describe('analyzeFileContent imports & exports', () => {
    it('parses named, default, and namespace imports', () => {
      const code = `
        import { isSafePath, isValidBranchName } from './securityUtils'
        import React, { useState } from 'react'
        import * as path from 'node:path'
        import './styles.css'
      `
      const info = analyzer.analyzeFileContent('src/test.ts', code)

      expect(info.imports).toHaveLength(4)

      const named = info.imports.find((i) => i.specifier === './securityUtils')
      expect(named).toBeDefined()
      expect(named?.importedSymbols).toContain('isSafePath')
      expect(named?.importedSymbols).toContain('isValidBranchName')

      const def = info.imports.find((i) => i.specifier === 'react')
      expect(def).toBeDefined()
      expect(def?.isDefault).toBe(true)
      expect(def?.importedSymbols).toContain('React')
      expect(def?.importedSymbols).toContain('useState')

      const ns = info.imports.find((i) => i.specifier === 'node:path')
      expect(ns).toBeDefined()
      expect(ns?.isNamespace).toBe(true)

      const sideEffect = info.imports.find((i) => i.specifier === './styles.css')
      expect(sideEffect).toBeDefined()
    })

    it('parses multiline imports with trailing commas', () => {
      const code = `
        import {
          foo,
          bar,
          baz,
        } from './multi'
      `
      const info = analyzer.analyzeFileContent('src/main.ts', code)
      expect(info.imports).toHaveLength(1)
      expect(info.imports[0].importedSymbols).toEqual(['foo', 'bar', 'baz'])
      expect(info.imports[0].specifier).toBe('./multi')
    })

    it('parses functions, variables, classes, interfaces, and types', () => {
      const code = `
        export function helper() {}
        export const API_URL = 'http://localhost'
        export class Engine {}
        export interface Config {}
        export type Status = 'active' | 'idle'
        export default function main() {}
      `
      const info = analyzer.analyzeFileContent('src/types.ts', code)

      const names = info.exports.map((e) => e.name)
      expect(names).toContain('helper')
      expect(names).toContain('API_URL')
      expect(names).toContain('Engine')
      expect(names).toContain('Config')
      expect(names).toContain('Status')
      expect(names).toContain('main')
      expect(info.exports.find((e) => e.name === 'main')?.kind).toBe('default')
    })
  })

  describe('resolveImportPath', () => {
    const availableFiles = [
      'src/main/index.ts',
      'src/shared/types.ts',
      'src/shared/securityUtils.ts',
      'src/renderer/src/App.tsx',
      'src/renderer/src/components/Header.tsx',
      'src/renderer/src/components/index.ts'
    ]

    it('resolves relative imports with extension omission', () => {
      const resolved = analyzer.resolveImportPath('src/shared/securityUtils.ts', './types', availableFiles)
      expect(resolved).toBe('src/shared/types.ts')
    })

    it('resolves directory imports to index files', () => {
      const resolved = analyzer.resolveImportPath('src/renderer/src/App.tsx', './components', availableFiles)
      expect(resolved).toBe('src/renderer/src/components/index.ts')
    })

    it('resolves path aliases configured in tsconfig', () => {
      const resolvedShared = analyzer.resolveImportPath('src/main/index.ts', '@shared/securityUtils', availableFiles)
      expect(resolvedShared).toBe('src/shared/securityUtils.ts')

      const resolvedRenderer = analyzer.resolveImportPath('src/main/index.ts', '@renderer/App', availableFiles)
      expect(resolvedRenderer).toBe('src/renderer/src/App.tsx')
    })

    it('returns null for external or unresolvable modules', () => {
      expect(analyzer.resolveImportPath('src/App.tsx', 'react', availableFiles)).toBeNull()
      expect(analyzer.resolveImportPath('src/App.tsx', './missing-file', availableFiles)).toBeNull()
    })
  })

  describe('findLikelyTests', () => {
    const availableFiles = [
      'src/utils/math.ts',
      'src/utils/math.test.ts',
      'src/utils/math.spec.ts',
      'tests/utils/math.test.ts',
      'src/components/Button.tsx',
      'src/components/Button.test.tsx'
    ]

    it('identifies co-located and tests directory test files', () => {
      const tests = analyzer.findLikelyTests('src/utils/math.ts', availableFiles)
      expect(tests).toContain('src/utils/math.test.ts')
      expect(tests).toContain('src/utils/math.spec.ts')
    })
  })

  describe('buildGraphNode', () => {
    it('builds dependency graph node for target file with impact tiers', () => {
      const targetPath = 'src/b.ts'
      const targetContent = 'export const bVal = 2;'
      const allFilesWithContent = [
        {
          path: 'src/b.ts',
          content: targetContent
        },
        {
          path: 'src/a.ts',
          content: 'import { bVal } from "./b"; export const aVal = bVal + 1;'
        }
      ]
      const allWorkspaceFiles = ['src/a.ts', 'src/b.ts']

      const node = analyzer.buildGraphNode(targetPath, targetContent, allFilesWithContent, allWorkspaceFiles)

      expect(node).toBeDefined()
      expect(node.path).toBe('src/b.ts')
      // File A imports B, so A is a directImporter of B
      expect(node.directImporters).toContain('src/a.ts')
      expect(node.potentiallyAffected).toContain('src/a.ts')
    })
  })
})
