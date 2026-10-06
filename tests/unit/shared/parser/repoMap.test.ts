import { describe, it, expect, beforeEach } from 'vitest'
import {
  SymbolIndex,
  DependencyGraph,
  ModuleResolver,
  extractDependencies,
  RepoMapGenerator,
  normalizeWorkspacePath
} from '@shared/parser'
import { SmartContextEngine } from '@renderer/services/agent/smartContextEngine'

describe('Phase 11.6 — Repo Map + Symbol Index + Dependency Graph Foundation', () => {
  describe('Dependency Extraction Across Languages', () => {
    it('extracts TypeScript and JavaScript imports, require, and export-from', () => {
      const tsCode = `
import React, { useState } from 'react';
import { Button } from './components/Button';
import './global.css';
export { Modal } from './components/Modal';
const utils = require('../utils/helpers');
const dynamicMod = import('./dynamicModule');
      `.trim()

      const deps = extractDependencies('src/App.tsx', tsCode, 'tsx')
      const specifiers = deps.map((d) => d.specifier)

      expect(specifiers).toContain('react')
      expect(specifiers).toContain('./components/Button')
      expect(specifiers).toContain('./global.css')
      expect(specifiers).toContain('./components/Modal')
      expect(specifiers).toContain('../utils/helpers')
      expect(specifiers).toContain('./dynamicModule')

      const reactDep = deps.find((d) => d.specifier === 'react')
      expect(reactDep?.isExternalHint).toBe(true)
      expect(reactDep?.kind).toBe('import')

      const buttonDep = deps.find((d) => d.specifier === './components/Button')
      expect(buttonDep?.isExternalHint).toBe(false)

      const exportFromDep = deps.find((d) => d.specifier === './components/Modal')
      expect(exportFromDep?.kind).toBe('export_from')

      const reqDep = deps.find((d) => d.specifier === '../utils/helpers')
      expect(reqDep?.kind).toBe('require')
    })

    it('extracts Python imports (from-import and import, including relative)', () => {
      const pyCode = `
import os
import sys, math
from datetime import datetime
from .models import User
from ..common.utils import sanitize
      `.trim()

      const deps = extractDependencies('app/views.py', pyCode, 'python')
      const specifiers = deps.map((d) => d.specifier)

      expect(specifiers).toContain('os')
      expect(specifiers).toContain('sys')
      expect(specifiers).toContain('math')
      expect(specifiers).toContain('datetime')
      expect(specifiers).toContain('.models')
      expect(specifiers).toContain('..common.utils')

      const relDep = deps.find((d) => d.specifier === '.models')
      expect(relDep?.isExternalHint).toBe(false)

      const osDep = deps.find((d) => d.specifier === 'os')
      expect(osDep?.isExternalHint).toBe(true)
    })

    it('extracts Java imports', () => {
      const javaCode = `
package com.example.service;

import java.util.List;
import java.util.Map;
import com.example.model.User;
import static org.junit.Assert.assertEquals;
      `.trim()

      const deps = extractDependencies('src/UserService.java', javaCode, 'java')
      const specifiers = deps.map((d) => d.specifier)

      expect(specifiers).toContain('java.util.List')
      expect(specifiers).toContain('com.example.model.User')
      expect(specifiers).toContain('org.junit.Assert.assertEquals')

      const sysDep = deps.find((d) => d.specifier === 'java.util.List')
      expect(sysDep?.isExternalHint).toBe(true)
    })

    it('extracts C and C++ includes distinguishing system and local', () => {
      const cppCode = `
#include <iostream>
#include <vector>
#include "engine.h"
#include "utils/math.hpp"
      `.trim()

      const deps = extractDependencies('src/main.cpp', cppCode, 'cpp')
      const specifiers = deps.map((d) => d.specifier)

      expect(specifiers).toContain('iostream')
      expect(specifiers).toContain('vector')
      expect(specifiers).toContain('engine.h')
      expect(specifiers).toContain('utils/math.hpp')

      const sysInc = deps.find((d) => d.specifier === 'iostream')
      expect(sysInc?.isExternalHint).toBe(true)

      const localInc = deps.find((d) => d.specifier === 'engine.h')
      expect(localInc?.isExternalHint).toBe(false)
    })

    it('extracts C# using statements', () => {
      const csCode = `
using System;
using System.Collections.Generic;
using CloudApp.Models;
using static System.Math;
      `.trim()

      const deps = extractDependencies('Controllers/UserController.cs', csCode, 'csharp')
      const specifiers = deps.map((d) => d.specifier)

      expect(specifiers).toContain('System')
      expect(specifiers).toContain('System.Collections.Generic')
      expect(specifiers).toContain('CloudApp.Models')
      expect(specifiers).toContain('System.Math')
    })

    it('extracts Go imports (single and multiline)', () => {
      const goCode = `
package main

import "fmt"
import (
    "net/http"
    "myproject/server"
)
      `.trim()

      const deps = extractDependencies('main.go', goCode, 'go')
      const specifiers = deps.map((d) => d.specifier)

      expect(specifiers).toContain('fmt')
      expect(specifiers).toContain('net/http')
      expect(specifiers).toContain('myproject/server')
    })

    it('extracts Rust use statements', () => {
      const rustCode = `
use std::collections::HashMap;
use crate::models::User;
use super::helpers;
use serde::{Serialize, Deserialize};
      `.trim()

      const deps = extractDependencies('src/service.rs', rustCode, 'rust')
      const specifiers = deps.map((d) => d.specifier)

      expect(specifiers).toContain('std::collections::HashMap')
      expect(specifiers).toContain('crate::models::User')
      expect(specifiers).toContain('super::helpers')
      expect(specifiers).toContain('serde::Serialize')
      expect(specifiers).toContain('serde::Deserialize')
    })
  })

  describe('Safe Module Resolution & Security Boundaries', () => {
    let resolver: ModuleResolver

    beforeEach(() => {
      resolver = new ModuleResolver({
        knownFiles: [
          'src/App.tsx',
          'src/components/Header.tsx',
          'src/components/Button/index.ts',
          'src/utils/math.ts',
          'src/styles.css',
          'app/main.py',
          'app/models.py',
          'app/utils/__init__.py'
        ]
      })
    })

    it('resolves relative file paths with and without extension', () => {
      // Direct extension
      const r1 = resolver.resolve('./components/Header.tsx', 'src/App.tsx')
      expect(r1.resolved).toBe(true)
      expect(r1.resolvedPath).toBe('src/components/Header.tsx')
      expect(r1.external).toBe(false)

      // Extension inferred (.tsx)
      const r2 = resolver.resolve('./components/Header', 'src/App.tsx')
      expect(r2.resolved).toBe(true)
      expect(r2.resolvedPath).toBe('src/components/Header.tsx')

      // Relative with parent traversal inside workspace
      const r3 = resolver.resolve('../utils/math', 'src/components/Header.tsx')
      expect(r3.resolved).toBe(true)
      expect(r3.resolvedPath).toBe('src/utils/math.ts')
    })

    it('resolves directory index files', () => {
      const res = resolver.resolve('./components/Button', 'src/App.tsx')
      expect(res.resolved).toBe(true)
      expect(res.resolvedPath).toBe('src/components/Button/index.ts')
    })

    it('resolves path aliases (@/* and @shared/*)', () => {
      const res = resolver.resolve('@/components/Header', 'src/App.tsx')
      expect(res.resolved).toBe(true)
      expect(res.resolvedPath).toBe('src/components/Header.tsx')
    })

    it('marks external modules without inventing workspace paths', () => {
      const externalPackages = ['react', 'lodash', 'fs', 'path', 'node:crypto', 'express']
      for (const pkg of externalPackages) {
        const res = resolver.resolve(pkg, 'src/App.tsx')
        expect(res.resolved).toBe(false)
        expect(res.resolvedPath).toBeNull()
        expect(res.external).toBe(true)
      }
    })

    it('handles ambiguous or non-existent local files safely', () => {
      const res = resolver.resolve('./nonExistentComponent', 'src/App.tsx')
      expect(res.resolved).toBe(false)
      expect(res.resolvedPath).toBeNull()
      expect(res.external).toBe(false)
    })

    it('strictly blocks directory traversal escaping workspace', () => {
      // Traversal attempts
      const attempts = [
        '../../../../etc/passwd',
        '../../../secret.key',
        '../../outside.txt',
        'C:/Windows/System32/calc.exe'
      ]

      for (const badPath of attempts) {
        const res = resolver.resolve(badPath, 'src/App.tsx')
        expect(res.resolved).toBe(false)
        expect(res.resolvedPath).toBeNull()
      }
    })

    it('normalizes workspace paths and prevents root traversal', () => {
      expect(normalizeWorkspacePath('src/../src/App.tsx')).toBe('src/App.tsx')
      expect(normalizeWorkspacePath('src/components/./Header.tsx')).toBe('src/components/Header.tsx')
      expect(normalizeWorkspacePath('C:/Users/test/workspace/file.ts')).toBe('Users/test/workspace/file.ts')
      expect(normalizeWorkspacePath('../outside.ts')).toBeNull()
      expect(normalizeWorkspacePath('src/../../outside.ts')).toBeNull()
    })
  })

  describe('Dependency Graph', () => {
    let graph: DependencyGraph

    beforeEach(() => {
      graph = new DependencyGraph()
    })

    it('adds edges and prevents duplicates', () => {
      graph.addEdge({
        from: 'src/App.tsx',
        to: 'src/Header.tsx',
        specifier: './Header',
        resolved: true,
        external: false,
        kind: 'import',
        line: 2
      })

      // Duplicate addition
      graph.addEdge({
        from: 'src/App.tsx',
        to: 'src/Header.tsx',
        specifier: './Header',
        resolved: true,
        external: false,
        kind: 'import',
        line: 2
      })

      expect(graph.getEdgeCount()).toBe(1)
      expect(graph.getNodeCount()).toBe(2)
    })

    it('retrieves dependencies (outgoing) and dependents (incoming)', () => {
      graph.addEdge({
        from: 'src/App.tsx',
        to: 'src/Header.tsx',
        specifier: './Header',
        resolved: true,
        external: false,
        kind: 'import',
        line: 1
      })
      graph.addEdge({
        from: 'src/App.tsx',
        to: 'src/Footer.tsx',
        specifier: './Footer',
        resolved: true,
        external: false,
        kind: 'import',
        line: 2
      })
      graph.addEdge({
        from: 'src/Sidebar.tsx',
        to: 'src/Header.tsx',
        specifier: './Header',
        resolved: true,
        external: false,
        kind: 'import',
        line: 1
      })

      // Outgoing from App.tsx
      const appDeps = graph.getDependencies('src/App.tsx')
      expect(appDeps.length).toBe(2)
      expect(appDeps.map((d) => d.to)).toEqual(['src/Footer.tsx', 'src/Header.tsx'])

      // Incoming to Header.tsx
      const headerDependents = graph.getDependents('src/Header.tsx')
      expect(headerDependents.length).toBe(2)
      expect(headerDependents.map((d) => d.from)).toEqual(['src/App.tsx', 'src/Sidebar.tsx'])
    })

    it('removes file and cleans up all associated incoming and outgoing edges', () => {
      graph.addEdge({
        from: 'src/A.ts',
        to: 'src/B.ts',
        specifier: './B',
        resolved: true,
        external: false,
        kind: 'import',
        line: 1
      })
      graph.addEdge({
        from: 'src/B.ts',
        to: 'src/C.ts',
        specifier: './C',
        resolved: true,
        external: false,
        kind: 'import',
        line: 1
      })

      expect(graph.getEdgeCount()).toBe(2)

      // Remove B.ts -> cleans A -> B and B -> C
      graph.removeFile('src/B.ts')

      expect(graph.getEdgeCount()).toBe(0)
      expect(graph.getDependencies('src/A.ts')).toEqual([])
      expect(graph.getDependents('src/C.ts')).toEqual([])
    })

    it('clears all edges and resets node count', () => {
      graph.addEdge({
        from: 'src/A.ts',
        to: 'src/B.ts',
        specifier: './B',
        resolved: true,
        external: false,
        kind: 'import',
        line: 1
      })
      graph.clear()
      expect(graph.getEdgeCount()).toBe(0)
      expect(graph.getNodeCount()).toBe(0)
    })
  })

  describe('SymbolIndex Multi-File Intelligence', () => {
    let index: SymbolIndex

    beforeEach(() => {
      index = new SymbolIndex()
      index.setKnownFiles([
        'src/App.tsx',
        'src/components/EditorPane.tsx',
        'src/services/compiler.ts',
        'backend/server.py'
      ])
    })

    it('indexes TypeScript file and extracts symbols and dependencies', () => {
      const code = `
import { EditorPane } from './components/EditorPane';

export class MainApp {
  public render(): void {}
}

export function startApp(): boolean {
  return true;
}
      `.trim()

      const indexed = index.indexFile('src/App.tsx', code)
      expect(indexed.filePath).toBe('src/App.tsx')
      expect(indexed.language).toBe('tsx')
      expect(indexed.symbols.length).toBeGreaterThan(0)
      expect(indexed.exports).toContain('MainApp')
      expect(indexed.exports).toContain('startApp')

      const symbols = index.getFileSymbols('src/App.tsx')
      const names = symbols.map((s) => s.name)
      expect(names).toContain('MainApp')
      expect(names).toContain('startApp')
      expect(names).toContain('render')

      // Dependency resolved to known file
      const deps = index.getDependencies('src/App.tsx')
      expect(deps.length).toBe(1)
      expect(deps[0].to).toBe('src/components/EditorPane.tsx')
      expect(deps[0].resolved).toBe(true)
    })

    it('indexes Python file and supports symbol search', () => {
      const pyCode = `
class RequestHandler:
    def handle_request(self, req):
        pass

def init_server():
    return True
      `.trim()

      index.indexFile('backend/server.py', pyCode)
      const symbols = index.getFileSymbols('backend/server.py')
      const names = symbols.map((s) => s.name)

      expect(names).toContain('RequestHandler')
      expect(names).toContain('handle_request')
      expect(names).toContain('init_server')
    })

    it('performs exact and case-insensitive symbol lookups with deterministic ordering', () => {
      index.indexFile(
        'src/services/compiler.ts',
        `
export class Compiler {
  public compile(): void {}
}
export function compiler(): void {}
        `.trim()
      )

      // Exact search for "Compiler"
      const exactMatches = index.getSymbol('Compiler')
      expect(exactMatches.length).toBe(1)
      expect(exactMatches[0].name).toBe('Compiler')
      expect(exactMatches[0].kind).toBe('class')

      // Search symbols case-insensitive
      const searchRes = index.searchSymbols('compiler')
      expect(searchRes.length).toBeGreaterThanOrEqual(2)
      // Rank 0 / exact case first
      expect(searchRes[0].name).toBe('compiler')
    })

    it('supports qualified symbol searches (Parent.Child)', () => {
      index.indexFile(
        'src/services/compiler.ts',
        `
export class Engine {
  public start(): void {}
  public stop(): void {}
}
        `.trim()
      )

      const matches = index.searchSymbols('Engine.start')
      expect(matches.length).toBe(1)
      expect(matches[0].name).toBe('start')
      expect(matches[0].parent).toBe('Engine')
    })

    it('removes file cleanly from symbol index and dependency graph', () => {
      index.indexFile(
        'src/temp.ts',
        `
export function tempHelper() {}
        `.trim()
      )
      expect(index.getSymbol('tempHelper').length).toBe(1)

      const removed = index.removeFile('src/temp.ts')
      expect(removed).toBe(true)
      expect(index.getSymbol('tempHelper').length).toBe(0)
      expect(index.getFileSymbols('src/temp.ts')).toEqual([])
    })

    it('skips re-parsing if content hash is unchanged', () => {
      const code = 'export const VERSION = "1.0.0";'
      const first = index.indexFile('src/version.ts', code)
      const second = index.indexFile('src/version.ts', code)

      expect(first).toBe(second) // exact same object reference returned
    })

    it('updates symbols and graph upon file modification', () => {
      const code1 = `
import { EditorPane } from './components/EditorPane';
export function oldFunc() {}
      `.trim()
      index.indexFile('src/App.tsx', code1)
      expect(index.getSymbol('oldFunc').length).toBe(1)
      expect(index.getDependencies('src/App.tsx').length).toBe(1)

      // Modified content
      const code2 = `
export function newFunc() {}
      `.trim()
      index.indexFile('src/App.tsx', code2)

      expect(index.getSymbol('oldFunc').length).toBe(0)
      expect(index.getSymbol('newFunc').length).toBe(1)
      expect(index.getDependencies('src/App.tsx').length).toBe(0)
    })
  })

  describe('Repo Map Generation & Budget Limits', () => {
    let index: SymbolIndex
    let generator: RepoMapGenerator

    beforeEach(() => {
      index = new SymbolIndex()
      generator = new RepoMapGenerator(index)

      index.setKnownFiles([
        'src/App.tsx',
        'src/components/EditorPane.tsx',
        'src/components/Terminal.tsx',
        'src/services/agent.ts'
      ])

      index.indexFile(
        'src/App.tsx',
        `
import { EditorPane } from './components/EditorPane';
import { Terminal } from './components/Terminal';

export class App {
  public render() {}
}
        `.trim()
      )

      index.indexFile(
        'src/components/EditorPane.tsx',
        `
export class EditorPane {
  public openFile() {}
}
        `.trim()
      )

      index.indexFile(
        'src/components/Terminal.tsx',
        `
export class Terminal {
  public write() {}
}
        `.trim()
      )
    })

    it('generates a compact deterministic RepoMap with structure and dependencies', () => {
      const result = generator.generateRepoMap()
      expect(result.truncated).toBe(false)
      expect(result.map.files.length).toBe(3)
      expect(result.formattedText).toContain('PROJECT STRUCTURE & KEY SYMBOLS')
      expect(result.formattedText).toContain('├── src/App.tsx')
      expect(result.formattedText).toContain('├── src/components/EditorPane.tsx')
      expect(result.formattedText).toContain('class App')
      expect(result.formattedText).toContain('DEPENDENCIES (RESOLVED)')
      expect(result.formattedText).toContain('src/App.tsx')
      expect(result.formattedText).toContain('→ src/components/EditorPane.tsx')
      expect(result.formattedText).toContain('→ src/components/Terminal.tsx')
    })

    it('is strictly deterministic across multiple runs', () => {
      const res1 = generator.generateRepoMap()
      const res2 = generator.generateRepoMap()

      expect(res1.formattedText).toBe(res2.formattedText)
      expect(res1.tokenEstimate).toBe(res2.tokenEstimate)
    })

    it('enforces maxFiles limit and adds explicit truncation notice', () => {
      const result = generator.generateRepoMap({ maxFiles: 1 })
      expect(result.truncated).toBe(true)
      expect(result.map.files.length).toBe(1)
      expect(result.formattedText).toContain('[Repo Map truncated:')
    })

    it('enforces maxOutputChars limit cleanly with line boundary truncation', () => {
      const result = generator.generateRepoMap({ maxOutputChars: 250 })
      expect(result.truncated).toBe(true)
      expect(result.formattedText.length).toBeLessThanOrEqual(350)
      expect(result.formattedText).toContain('[Repo Map truncated:')
    })

    it('enforces maxSymbolsPerFile limit', () => {
      index.indexFile(
        'src/manySymbols.ts',
        `
export const a = 1;
export const b = 2;
export const c = 3;
export const d = 4;
export const e = 5;
export class BigClass {}
export interface BigInterface {}
        `.trim()
      )

      const result = generator.generateRepoMap({ maxSymbolsPerFile: 2 })
      const fileEntry = result.map.files.find((f) => f.filePath === 'src/manySymbols.ts')
      expect(fileEntry).toBeDefined()
      expect(fileEntry!.symbols.length).toBe(2)
      // Primary symbols (BigClass, BigInterface) prioritized over constants
      const names = fileEntry!.symbols.map((s) => s.name)
      expect(names).toContain('BigClass')
      expect(names).toContain('BigInterface')
    })
  })

  describe('SmartContextEngine Integration', () => {
    let engine: SmartContextEngine

    beforeEach(() => {
      engine = new SmartContextEngine()
    })

    it('exposes getRepoMap and searchSymbols', () => {
      const tsCode = `
export class WorkspaceController {
  public switchWorkspace() {}
}
      `.trim()

      engine.getFileSymbols('src/controller.ts', tsCode)

      const searchRes = engine.searchSymbols('WorkspaceController')
      expect(searchRes.length).toBe(1)
      expect(searchRes[0].name).toBe('WorkspaceController')

      const repoMap = engine.getRepoMap()
      expect(repoMap.formattedText).toContain('src/controller.ts')
      expect(repoMap.formattedText).toContain('WorkspaceController')
    })

    it('provides getFileDependencies and getFileDependents', () => {
      const code1 = `
import { helper } from './helper';
export function run() {}
      `.trim()
      const code2 = `
export function helper() {}
      `.trim()

      engine.getSymbolIndex().setKnownFiles(['src/main.ts', 'src/helper.ts'])
      engine.getFileSymbols('src/helper.ts', code2)
      engine.getFileSymbols('src/main.ts', code1)

      const outgoing = engine.getFileDependencies('src/main.ts')
      expect(outgoing.length).toBe(1)
      expect(outgoing[0].to).toBe('src/helper.ts')

      const incoming = engine.getFileDependents('src/helper.ts')
      expect(incoming.length).toBe(1)
      expect(incoming[0].from).toBe('src/main.ts')
    })

    it('clears symbol index when clearCache is called', () => {
      engine.getFileSymbols('src/dummy.ts', 'export const dummy = 1;')
      expect(engine.getSymbolIndex().getIndexedFiles().length).toBe(1)

      engine.clearCache()
      expect(engine.getSymbolIndex().getIndexedFiles().length).toBe(0)
    })
  })
})
