import { describe, it, expect, beforeEach } from 'vitest'
import {
  TreeSitterParserService,
  defaultParserService,
  detectLanguageFromPath,
  extractExtension,
  isLanguageSupported,
  getSupportedLanguages,
  ParserCache,
  computeContentHash,
  LineTracker
} from '@shared/parser'
import { SmartContextEngine } from '@renderer/services/agent/smartContextEngine'

describe('Phase 11.5 — Tree-sitter Multi-language Parsing & Symbol Extraction', () => {
  describe('Language Detection & Extension Handling', () => {
    it('detects all 14 supported languages accurately', () => {
      const expectations: Record<string, string> = {
        'index.js': 'javascript',
        'module.mjs': 'javascript',
        'bundle.cjs': 'javascript',
        'app.ts': 'typescript',
        'worker.mts': 'typescript',
        'component.tsx': 'tsx',
        'widget.jsx': 'jsx',
        'script.py': 'python',
        'app.pyw': 'python',
        'Application.java': 'java',
        'main.c': 'c',
        'header.h': 'c',
        'engine.cpp': 'cpp',
        'engine.hpp': 'cpp',
        'core.cc': 'cpp',
        'Program.cs': 'csharp',
        'server.go': 'go',
        'lib.rs': 'rust',
        'package.json': 'json',
        'index.html': 'html',
        'page.htm': 'html',
        'styles.css': 'css',
        'theme.scss': 'css',
        'base.less': 'css'
      }

      for (const [filename, expectedLang] of Object.entries(expectations)) {
        const result = detectLanguageFromPath(filename)
        expect(result.isSupported, `Expected ${filename} to be supported`).toBe(true)
        expect(result.language, `Expected ${filename} to be ${expectedLang}`).toBe(expectedLang)
      }
    })

    it('handles case-insensitivity in extensions', () => {
      expect(detectLanguageFromPath('App.TS').language).toBe('typescript')
      expect(detectLanguageFromPath('Script.PY').language).toBe('python')
      expect(detectLanguageFromPath('Config.JSON').language).toBe('json')
      expect(detectLanguageFromPath('Component.TSX').language).toBe('tsx')
      expect(detectLanguageFromPath('Main.CPP').language).toBe('cpp')
    })

    it('handles multi-dot complex filenames', () => {
      expect(detectLanguageFromPath('user.service.spec.ts').language).toBe('typescript')
      expect(detectLanguageFromPath('api.v2.controller.js').language).toBe('javascript')
      expect(detectLanguageFromPath('schema.final.v1.json').language).toBe('json')
      expect(detectLanguageFromPath('archive.tar.gz').isSupported).toBe(false)
    })

    it('handles extensionless files gracefully', () => {
      expect(extractExtension('foo.ts')).toBe('ts')
      expect(extractExtension('Dockerfile')).toBe('')
      expect(detectLanguageFromPath('Dockerfile').isSupported).toBe(false)
      expect(detectLanguageFromPath('Dockerfile').language).toBe('unknown')
      expect(detectLanguageFromPath('Makefile').isSupported).toBe(false)
      expect(detectLanguageFromPath('.gitignore').isSupported).toBe(false)
      expect(detectLanguageFromPath('').isSupported).toBe(false)
    })

    it('handles unsupported file types safely', () => {
      const unsupported = ['notes.txt', 'doc.pdf', 'data.csv', 'photo.png', 'binary.exe']
      for (const file of unsupported) {
        const res = detectLanguageFromPath(file)
        expect(res.isSupported).toBe(false)
        expect(res.language).toBe('unknown')
      }
    })

    it('provides getSupportedLanguages and isLanguageSupported', () => {
      const allLangs = getSupportedLanguages()
      expect(allLangs).toContain('typescript')
      expect(allLangs).toContain('python')
      expect(allLangs).toContain('rust')
      expect(allLangs).toContain('go')
      expect(allLangs.length).toBeGreaterThanOrEqual(14)

      expect(isLanguageSupported('typescript')).toBe(true)
      expect(isLanguageSupported('unknown')).toBe(false)
      expect(isLanguageSupported('fortran')).toBe(false)
    })
  })

  describe('LineTracker & Coordinate Mapping', () => {
    it('correctly maps character offsets to 1-based lines and columns', () => {
      const code = 'line 1\nline 2\nline 3'
      const tracker = new LineTracker(code)

      // Start of line 1
      const p1 = tracker.getPosition(0)
      expect(p1.line).toBe(1)
      expect(p1.column).toBe(1)
      expect(p1.row).toBe(0)

      // End of line 1
      const p1End = tracker.getPosition(6)
      expect(p1End.line).toBe(1)
      expect(p1End.column).toBe(7)

      // Start of line 2 (offset 7 after '\n')
      const p2 = tracker.getPosition(7)
      expect(p2.line).toBe(2)
      expect(p2.column).toBe(1)
      expect(p2.row).toBe(1)

      // Tree-sitter format (0-based row and column)
      const tsPos = tracker.getTreeSitterPosition(7)
      expect(tsPos.row).toBe(1)
      expect(tsPos.column).toBe(0)
    })
  })

  describe('Multi-Language Parsing & Symbol Extraction', () => {
    let parser: TreeSitterParserService

    beforeEach(() => {
      parser = new TreeSitterParserService(50)
    })

    it('extracts JavaScript & TypeScript symbols with export flags and parents', () => {
      const code = `
import { readFile } from 'fs';
export const API_KEY = 'secret';
let counter = 0;

export function calculateTotal(a: number, b: number): number {
  return a + b;
}

export class OrderProcessor {
  private taxRate: number;
  constructor(rate: number) {
    this.taxRate = rate;
  }
  public processOrder(id: string): boolean {
    return true;
  }
}

export interface UserConfig {
  id: string;
}

export type StringOrNumber = string | number;

export enum Status {
  Active = 'ACTIVE',
  Inactive = 'INACTIVE'
}
      `.trim()

      const result = parser.parseSource({ filePath: 'src/order.ts', content: code })
      expect(result.parsed).toBe(true)
      expect(result.isSupported).toBe(true)
      expect(result.symbols.length).toBeGreaterThan(0)

      const names = result.symbols.map((s) => s.name)
      expect(names).toContain('calculateTotal')
      expect(names).toContain('OrderProcessor')
      expect(names).toContain('processOrder')
      expect(names).toContain('UserConfig')
      expect(names).toContain('StringOrNumber')
      expect(names).toContain('Status')
      expect(names).toContain('API_KEY')

      // Verify parent relationship
      const methodSym = result.symbols.find((s) => s.name === 'processOrder')
      expect(methodSym).toBeDefined()
      expect(methodSym?.parent).toBe('OrderProcessor')
      expect(methodSym?.kind).toBe('method')

      // Verify exported flag
      const funcSym = result.symbols.find((s) => s.name === 'calculateTotal')
      expect(funcSym?.exported).toBe(true)

      // Verify 1-based line coordinates
      expect(funcSym?.startLine).toBeGreaterThan(0)
      expect(funcSym?.endLine).toBeGreaterThanOrEqual(funcSym!.startLine)
    })

    it('extracts Python classes, methods, constructors, and imports', () => {
      const code = `
import os
from sys import path

class DataPipeline:
    def __init__(self, name: str):
        self.name = name

    def execute(self, payload: dict) -> bool:
        return True

def standalone_helper():
    pass
      `.trim()

      const result = parser.parseSource({ filePath: 'pipeline.py', content: code })
      expect(result.parsed).toBe(true)
      expect(result.language).toBe('python')

      const names = result.symbols.map((s) => s.name)
      expect(names).toContain('DataPipeline')
      expect(names).toContain('__init__')
      expect(names).toContain('execute')
      expect(names).toContain('standalone_helper')
      expect(names).toContain('os')
      expect(names).toContain('path')

      const initSym = result.symbols.find((s) => s.name === '__init__')
      expect(initSym?.kind).toBe('constructor')
      expect(initSym?.parent).toBe('DataPipeline')

      const executeSym = result.symbols.find((s) => s.name === 'execute')
      expect(executeSym?.kind).toBe('method')
      expect(executeSym?.parent).toBe('DataPipeline')
    })

    it('extracts Java classes, interfaces, enums, constructors, and methods', () => {
      const code = `
package com.example.service;

import java.util.List;

public class UserService {
    private String domain;

    public UserService(String domain) {
        this.domain = domain;
    }

    public List<String> getUsers() {
        return List.of();
    }
}

public interface AuthProvider {
    boolean authenticate(String token);
}
      `.trim()

      const result = parser.parseSource({ filePath: 'UserService.java', content: code })
      expect(result.parsed).toBe(true)
      expect(result.language).toBe('java')

      const names = result.symbols.map((s) => s.name)
      expect(names).toContain('UserService')
      expect(names).toContain('getUsers')
      expect(names).toContain('AuthProvider')
      expect(names).toContain('authenticate')

      const ctorSym = result.symbols.find((s) => s.name === 'UserService' && s.kind === 'constructor')
      expect(ctorSym).toBeDefined()
      expect(ctorSym?.parent).toBe('UserService')
    })

    it('extracts C / C++ functions, structs, classes, and namespaces', () => {
      const code = `
#include <iostream>
#include "engine.h"

namespace Core {
    class Renderer {
    public:
        void renderScene();
    };

    struct Point3D {
        float x, y, z;
    };
}

void Renderer::renderScene() {
}

int main() {
    return 0;
}
      `.trim()

      const result = parser.parseSource({ filePath: 'main.cpp', content: code })
      expect(result.parsed).toBe(true)
      expect(result.language).toBe('cpp')

      const names = result.symbols.map((s) => s.name)
      expect(names).toContain('Core')
      expect(names).toContain('Renderer')
      expect(names).toContain('Point3D')
      expect(names).toContain('renderScene')
      expect(names).toContain('main')

      const outOfLineMethod = result.symbols.find((s) => s.name === 'renderScene')
      expect(outOfLineMethod?.parent).toBe('Renderer')
    })

    it('extracts C# namespaces, classes, methods, properties, and structs', () => {
      const code = `
using System;
using System.Threading.Tasks;

namespace CloudApp.Controllers {
    public class HealthCheck {
        public string Status { get; set; }

        public async Task<bool> IsHealthyAsync() {
            return true;
        }
    }

    public interface IMetricSink {
        void Record(string metric);
    }
}
      `.trim()

      const result = parser.parseSource({ filePath: 'HealthCheck.cs', content: code })
      expect(result.parsed).toBe(true)
      expect(result.language).toBe('csharp')

      const names = result.symbols.map((s) => s.name)
      expect(names).toContain('CloudApp.Controllers')
      expect(names).toContain('HealthCheck')
      expect(names).toContain('Status')
      expect(names).toContain('IsHealthyAsync')
      expect(names).toContain('IMetricSink')

      const methodSym = result.symbols.find((s) => s.name === 'IsHealthyAsync')
      expect(methodSym?.parent).toBe('HealthCheck')
      expect(methodSym?.kind).toBe('method')
    })

    it('extracts Go packages, structs, interfaces, functions, and receiver methods', () => {
      const code = `
package server

import (
    "fmt"
    "net/http"
)

type Config struct {
    Port int
}

type Handler interface {
    ServeHTTP()
}

func (c *Config) GetPort() int {
    return c.Port
}

func StartServer(cfg *Config) error {
    return nil
}
      `.trim()

      const result = parser.parseSource({ filePath: 'server.go', content: code })
      expect(result.parsed).toBe(true)
      expect(result.language).toBe('go')

      const names = result.symbols.map((s) => s.name)
      expect(names).toContain('server')
      expect(names).toContain('Config')
      expect(names).toContain('Handler')
      expect(names).toContain('GetPort')
      expect(names).toContain('StartServer')

      // Receiver method parent extraction
      const methodSym = result.symbols.find((s) => s.name === 'GetPort')
      expect(methodSym?.kind).toBe('method')
      expect(methodSym?.parent).toBe('Config')

      // Capitalized exported status
      const exportedFunc = result.symbols.find((s) => s.name === 'StartServer')
      expect(exportedFunc?.exported).toBe(true)
    })

    it('extracts Rust structs, enums, traits, functions, and impl methods', () => {
      const code = `
use std::collections::HashMap;

pub struct CacheManager {
    capacity: usize,
}

pub enum CachePolicy {
    Lru,
    Fifo,
}

pub trait EvictionStrategy {
    fn evict(&mut self);
}

impl CacheManager {
    pub fn new(capacity: usize) -> Self {
        CacheManager { capacity }
    }

    pub fn get(&self, key: &str) -> Option<&str> {
        None
    }
}
      `.trim()

      const result = parser.parseSource({ filePath: 'cache.rs', content: code })
      expect(result.parsed).toBe(true)
      expect(result.language).toBe('rust')

      const names = result.symbols.map((s) => s.name)
      expect(names).toContain('CacheManager')
      expect(names).toContain('CachePolicy')
      expect(names).toContain('EvictionStrategy')
      expect(names).toContain('new')
      expect(names).toContain('get')

      // Impl methods parent extraction
      const newMethod = result.symbols.find((s) => s.name === 'new')
      expect(newMethod?.parent).toBe('CacheManager')
      expect(newMethod?.kind).toBe('method')
      expect(newMethod?.exported).toBe(true)
    })

    it('extracts JSON properties and pairs', () => {
      const code = `
{
  "name": "ai-ide",
  "version": "0.1.0-rc2",
  "private": true,
  "scripts": {
    "build": "electron-vite build",
    "test": "vitest"
  }
}
      `.trim()

      const result = parser.parseSource({ filePath: 'package.json', content: code })
      expect(result.parsed).toBe(true)
      expect(result.language).toBe('json')

      const names = result.symbols.map((s) => s.name)
      expect(names).toContain('name')
      expect(names).toContain('version')
      expect(names).toContain('scripts')
    })

    it('extracts HTML tags and elements with IDs', () => {
      const code = `
<!DOCTYPE html>
<html>
  <head><title>Test</title></head>
  <body>
    <div id="app-root"></div>
    <header id="main-header"></header>
    <main></main>
  </body>
</html>
      `.trim()

      const result = parser.parseSource({ filePath: 'index.html', content: code })
      expect(result.parsed).toBe(true)
      expect(result.language).toBe('html')

      const names = result.symbols.map((s) => s.name)
      expect(names).toContain('#app-root')
      expect(names).toContain('#main-header')
      expect(names).toContain('div')
      expect(names).toContain('header')
    })

    it('extracts CSS selectors, rules, and at-rules', () => {
      const code = `
@media (max-width: 768px) {
  .responsive-container {
    padding: 10px;
  }
}

.button-primary {
  background: blue;
}

#editor-pane {
  display: flex;
}
      `.trim()

      const result = parser.parseSource({ filePath: 'styles.css', content: code })
      expect(result.parsed).toBe(true)
      expect(result.language).toBe('css')

      const names = result.symbols.map((s) => s.name)
      expect(names).toContain('@media (max-width: 768px)')
      expect(names).toContain('.button-primary')
      expect(names).toContain('#editor-pane')
    })
  })

  describe('Fault Tolerance & Error Recovery', () => {
    let parser: TreeSitterParserService

    beforeEach(() => {
      parser = new TreeSitterParserService(50)
    })

    it('recovers from incomplete function definitions without throwing', () => {
      const code = `
export function completedFunction() {
  return 42;
}

function brokenFunction(
      `.trim()

      const result = parser.parseSource({ filePath: 'broken.ts', content: code })
      expect(result.parsed).toBe(true)
      expect(result.hasSyntaxErrors).toBe(true)
      expect(result.diagnostics.length).toBeGreaterThan(0)

      // Successfully extracted the valid completedFunction
      const names = result.symbols.map((s) => s.name)
      expect(names).toContain('completedFunction')
    })

    it('recovers from Python code with missing colon and unclosed block', () => {
      const code = `
def valid_function():
    return True

def broken_function()
    print("missing colon")
      `.trim()

      const result = parser.parseSource({ filePath: 'broken.py', content: code })
      expect(result.parsed).toBe(true)
      expect(result.hasSyntaxErrors).toBe(true)

      const names = result.symbols.map((s) => s.name)
      expect(names).toContain('valid_function')
    })

    it('handles completely unsupported file types gracefully', () => {
      const result = parser.parseSource({
        filePath: 'archive.tar.gz',
        content: 'binary content'
      })

      expect(result.parsed).toBe(false)
      expect(result.isSupported).toBe(false)
      expect(result.symbols).toEqual([])
      expect(result.diagnostics).toEqual([])
    })

    it('extractSymbols returns empty array on unsupported files without error', () => {
      const symbols = parser.extractSymbols('image.png', 'binary data')
      expect(symbols).toEqual([])
    })
  })

  describe('Bounded LRU Parse Cache', () => {
    it('returns cached results for identical filePath and content', () => {
      const cache = new ParserCache(10)
      const filePath = 'src/test.ts'
      const content = 'export const x = 1;'
      const mockResult = {
        filePath,
        language: 'typescript' as const,
        parsed: true,
        isSupported: true,
        hasSyntaxErrors: false,
        symbols: [],
        diagnostics: [],
        parseTimeMs: 1
      }

      cache.set(filePath, content, mockResult)
      expect(cache.has(filePath, content)).toBe(true)

      const fetched = cache.get(filePath, content)
      expect(fetched).toBeDefined()
      expect(fetched?.cached).toBe(true)

      const stats = cache.getStats()
      expect(stats.hits).toBe(1)
      expect(stats.misses).toBe(0)
    })

    it('returns miss when content changes', () => {
      const cache = new ParserCache(10)
      const filePath = 'src/test.ts'
      const content1 = 'export const x = 1;'
      const content2 = 'export const x = 2;'

      cache.set(filePath, content1, {
        filePath,
        language: 'typescript',
        parsed: true,
        isSupported: true,
        hasSyntaxErrors: false,
        symbols: [],
        diagnostics: [],
        parseTimeMs: 1
      })

      const fetched = cache.get(filePath, content2)
      expect(fetched).toBeUndefined()

      const stats = cache.getStats()
      expect(stats.misses).toBe(1)
    })

    it('evicts least recently used entries when exceeding maxEntries', () => {
      const cache = new ParserCache(2)

      cache.set('f1.ts', 'c1', { filePath: 'f1.ts' } as any)
      cache.set('f2.ts', 'c2', { filePath: 'f2.ts' } as any)
      expect(cache.getStats().size).toBe(2)

      // Add third entry -> evicts f1.ts
      cache.set('f3.ts', 'c3', { filePath: 'f3.ts' } as any)

      expect(cache.getStats().size).toBe(2)
      expect(cache.getStats().evictions).toBe(1)
      expect(cache.get('f1.ts', 'c1')).toBeUndefined()
      expect(cache.get('f2.ts', 'c2')).toBeDefined()
      expect(cache.get('f3.ts', 'c3')).toBeDefined()
    })

    it('computes deterministic hashes', () => {
      const h1 = computeContentHash('function test() {}')
      const h2 = computeContentHash('function test() {}')
      const h3 = computeContentHash('function test2() {}')

      expect(h1).toBe(h2)
      expect(h1).not.toBe(h3)
    })
  })

  describe('SmartContextEngine Integration', () => {
    it('exposes getParserService and getFileSymbols', () => {
      const engine = new SmartContextEngine()
      const parserService = engine.getParserService()

      expect(parserService).toBeDefined()
      expect(typeof parserService.parseSource).toBe('function')

      const tsCode = `
export function add(a: number, b: number): number {
  return a + b;
}
      `.trim()

      const symbols = engine.getFileSymbols('src/math.ts', tsCode)
      expect(symbols.length).toBeGreaterThan(0)
      expect(symbols[0].name).toBe('add')
      expect(symbols[0].kind).toBe('function')
      expect(symbols[0].startLine).toBe(1)
    })

    it('returns empty array when content is not provided and not in cache', () => {
      const engine = new SmartContextEngine()
      const symbols = engine.getFileSymbols('nonexistent.ts')
      expect(symbols).toEqual([])
    })
  })

  describe('Default Singleton Service', () => {
    it('provides defaultParserService instance', () => {
      expect(defaultParserService).toBeInstanceOf(TreeSitterParserService)
      const res = defaultParserService.detectLanguage('App.vue')
      expect(res.isSupported).toBe(false)
    })
  })
})
