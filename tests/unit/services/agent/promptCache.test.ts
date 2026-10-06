import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { StaticPromptCache } from '@renderer/services/agent/promptCache'
import { ContextDeduplicator } from '@renderer/services/agent/contextDeduplicator'
import { AgentOrchestrator } from '@renderer/services/agent/orchestrator'
import { ReadFileRangeTool } from '@renderer/services/tools/readFileRangeTool'
import { GeminiProvider } from '@renderer/services/ai/geminiProvider'
import { OpenRouterProvider } from '@renderer/services/ai/openRouterProvider'
import { OpenCodeProvider } from '@renderer/services/ai/opencodeProvider'
import { NvidiaProvider } from '@renderer/services/ai/nvidiaProvider'
import {
  FunctionDeclaration,
  IAIProvider,
  LLMMessage,
  LLMRequestOptions,
  LLMResponse
} from '@renderer/services/ai/types'
import { setupMockElectron, resetMockElectron } from '../../../setup/electronMock'

class MockAIProvider implements IAIProvider {
  readonly id = 'mock-provider'
  readonly name = 'Mock Provider'
  readonly capabilities = {
    supportsStreaming: true,
    supportsTools: true,
    requiresApiKey: false
  }

  private responseQueue: LLMResponse[] = []
  public recordedCalls: Array<{
    messages: LLMMessage[]
    tools: FunctionDeclaration[]
    options: LLMRequestOptions
  }> = []

  enqueueResponse(response: LLMResponse): void {
    this.responseQueue.push(response)
  }

  clear(): void {
    this.responseQueue = []
    this.recordedCalls = []
  }

  async sendMessage(
    messages: LLMMessage[],
    tools: FunctionDeclaration[],
    options: LLMRequestOptions
  ): Promise<LLMResponse> {
    this.recordedCalls.push({
      messages: JSON.parse(JSON.stringify(messages)),
      tools,
      options
    })
    if (this.responseQueue.length > 0) {
      const resp = this.responseQueue.shift()!
      if (resp.text && options.onChunk) {
        options.onChunk(resp.text)
      }
      return resp
    }
    return { text: 'Default mock response' }
  }
}

describe('Phase 11.4: Prompt Caching & Static Context Separation', () => {
  describe('StaticPromptCache Unit Tests', () => {
    let cache: StaticPromptCache

    const sampleTools: FunctionDeclaration[] = [
      {
        name: 'read_file',
        description: 'Reads file',
        parameters: { type: 'object', properties: { path: { type: 'string' } } }
      },
      {
        name: 'run_command',
        description: 'Runs command',
        parameters: { type: 'object', properties: { command: { type: 'string' } } }
      }
    ]

    beforeEach(() => {
      cache = new StaticPromptCache(3)
    })

    it('generates deterministic keys regardless of tool declaration array order', () => {
      const prompt = 'Static system instructions rules 1-14'
      const toolsReversed = [...sampleTools].reverse()

      const res1 = cache.computeKey(prompt, sampleTools)
      const res2 = cache.computeKey(prompt, toolsReversed)

      expect(res1.key).toBe(res2.key)
      expect(res1.toolSchemaHash).toBe(res2.toolSchemaHash)
      expect(typeof res1.key).toBe('string')
      expect(res1.key.length).toBeGreaterThan(0)
    })

    it('returns cacheHit: false on first call, cacheHit: true on second call', () => {
      const prompt = 'Stable rules'
      const first = cache.getOrCreateSnapshot(prompt, sampleTools)
      expect(first.cacheHit).toBe(false)
      expect(first.snapshot.systemPrompt).toBe('Stable rules')
      expect(first.snapshot.key).toBe(first.snapshot.hash)
      expect(first.snapshot.version).toBe(first.snapshot.hash)

      const second = cache.getOrCreateSnapshot(prompt, sampleTools)
      expect(second.cacheHit).toBe(true)
      expect(second.snapshot.key).toBe(first.snapshot.key)
    })

    it('detects changes in static system instructions', () => {
      const first = cache.getOrCreateSnapshot('Version 1 prompt', sampleTools)
      const second = cache.getOrCreateSnapshot('Version 2 prompt with updated rules', sampleTools)

      expect(first.cacheHit).toBe(false)
      expect(second.cacheHit).toBe(false)
      expect(first.snapshot.key).not.toBe(second.snapshot.key)
    })

    it('detects changes in tool declaration schemas', () => {
      const modifiedTools: FunctionDeclaration[] = [
        ...sampleTools,
        {
          name: 'new_tool',
          description: 'A new tool added',
          parameters: { type: 'object' }
        }
      ]

      const first = cache.getOrCreateSnapshot('Rules', sampleTools)
      const second = cache.getOrCreateSnapshot('Rules', modifiedTools)

      expect(first.cacheHit).toBe(false)
      expect(second.cacheHit).toBe(false)
      expect(first.snapshot.key).not.toBe(second.snapshot.key)
      expect(first.snapshot.toolSchemaHash).not.toBe(second.snapshot.toolSchemaHash)
    })

    it('evicts oldest entries according to LRU policy when exceeding maxEntries', () => {
      const c = new StaticPromptCache(2)
      c.getOrCreateSnapshot('Prompt A', sampleTools)
      c.getOrCreateSnapshot('Prompt B', sampleTools)
      expect(c.size()).toBe(2)

      // Access A to make it recently used
      const accessedA = c.getOrCreateSnapshot('Prompt A', sampleTools)
      expect(accessedA.cacheHit).toBe(true)

      // Add C - should evict B because A was recently accessed
      c.getOrCreateSnapshot('Prompt C', sampleTools)
      expect(c.size()).toBe(2)

      // Check that A is still cached, but B was evicted
      const keyB = c.computeKey('Prompt B', sampleTools).key
      const keyA = c.computeKey('Prompt A', sampleTools).key
      const keyC = c.computeKey('Prompt C', sampleTools).key

      expect(c.has(keyA)).toBe(true)
      expect(c.has(keyC)).toBe(true)
      expect(c.has(keyB)).toBe(false)
    })

    it('maintains hit and miss statistics and clears properly', () => {
      cache.getOrCreateSnapshot('P1', sampleTools) // miss
      cache.getOrCreateSnapshot('P1', sampleTools) // hit
      cache.getOrCreateSnapshot('P2', sampleTools) // miss

      const stats = cache.getStats()
      expect(stats.hits).toBe(1)
      expect(stats.misses).toBe(2)
      expect(stats.size).toBe(2)

      cache.clear()
      expect(cache.size()).toBe(0)
      expect(cache.getStats().hits).toBe(0)
      expect(cache.getStats().misses).toBe(0)
    })
  })

  describe('Range-Aware Slice Context Deduplication', () => {
    let deduplicator: ContextDeduplicator

    beforeEach(() => {
      deduplicator = new ContextDeduplicator(false)
    })

    it('tracks full files and line slices independently', () => {
      const filePath = 'src/services/compiler.ts'
      const sliceContent = 'line3\nline4\nline5'

      // Initially neither full file nor slice is in context
      expect(deduplicator.isFileInContext(filePath)).toBe(false)
      expect(deduplicator.isFileSliceInContext(filePath, 3, 5)).toBe(false)

      // Mark slice only
      deduplicator.markFileSliceInContext(filePath, 3, 5, sliceContent)

      expect(deduplicator.isFileSliceInContext(filePath, 3, 5)).toBe(true)
      expect(deduplicator.isFileSliceInContext(filePath, 3, 5, sliceContent)).toBe(true)
      // Different slice range is not in context
      expect(deduplicator.isFileSliceInContext(filePath, 6, 8)).toBe(false)
      // Modified content in the same range returns false
      expect(deduplicator.isFileSliceInContext(filePath, 3, 5, 'altered content')).toBe(false)
    })

    it('invalidates all line slices when the parent file is invalidated', () => {
      const filePath = 'src/utils/math.ts'
      deduplicator.markFileSliceInContext(filePath, 1, 10, 'function add() {}')
      deduplicator.markFileSliceInContext(filePath, 20, 30, 'function sub() {}')

      expect(deduplicator.isFileSliceInContext(filePath, 1, 10)).toBe(true)
      expect(deduplicator.isFileSliceInContext(filePath, 20, 30)).toBe(true)

      // Invalidate file (e.g. after edit_file)
      deduplicator.invalidateFile(filePath)

      expect(deduplicator.isFileSliceInContext(filePath, 1, 10)).toBe(false)
      expect(deduplicator.isFileSliceInContext(filePath, 20, 30)).toBe(false)
    })

    it('tracks character savings from deduplication', () => {
      expect(deduplicator.getDeduplicatedCharsSaved()).toBe(0)

      deduplicator.recordDeduplicatedChars(1500)
      deduplicator.recordDeduplicatedChars(500)

      expect(deduplicator.getDeduplicatedCharsSaved()).toBe(2000)

      deduplicator.reset()
      expect(deduplicator.getDeduplicatedCharsSaved()).toBe(0)
    })
  })

  describe('AgentOrchestrator Static/Dynamic Separation & Caching', () => {
    let mockProvider: MockAIProvider
    let orchestrator: AgentOrchestrator

    beforeEach(() => {
      setupMockElectron({
        readWorkspaceFile: vi.fn().mockResolvedValue({
          success: true,
          content: ''
        })
      })
      mockProvider = new MockAIProvider()
      orchestrator = new AgentOrchestrator(mockProvider)
    })

    afterEach(() => {
      resetMockElectron()
      vi.clearAllMocks()
    })

    it('provides immutable static system prompt containing rules 1-14', () => {
      const staticPrompt = orchestrator.getStaticSystemPrompt()
      expect(staticPrompt).toContain("1. 'read_file'")
      expect(staticPrompt).toContain("2. 'read_file_range'")
      expect(staticPrompt).toContain("4. 'create_file'")
      expect(staticPrompt).toContain("5. 'edit_file'")
      expect(staticPrompt).toContain("6. 'run_command'")
      expect(staticPrompt).toContain("11. 'list_files' FAILURE HANDLING")
      expect(staticPrompt).toContain('12. TOOL FAILURE & ANTI-FABRICATION CONTRACT')
      expect(staticPrompt).toContain('13. GIT BRANCH & STATE CONTRACT')
      expect(staticPrompt).toContain('14. If a request does NOT require')
    })

    it('builds dynamic context decoupled from static prompt', () => {
      const dynamicCtx = orchestrator.buildDynamicContext({
        currentBranch: 'feature/prompt-caching',
        activeEditorContext: {
          filePath: 'src/main.ts',
          cursorLine: 42,
          visibleRange: { startLine: 30, endLine: 60 }
        }
      })

      expect(dynamicCtx).toContain('Verified Workspace Git State: The active Git branch in this workspace is "feature/prompt-caching"')
      expect(dynamicCtx).toContain("Active file currently open in editor: 'src/main.ts' (cursor at line 42)")
      expect(dynamicCtx).toContain('visible viewport lines: 30-60')
    })

    it('reuses static snapshot across consecutive agent runs and records cache diagnostics', async () => {
      mockProvider.enqueueResponse({ text: 'Answer 1' })
      await orchestrator.run('What is recursion?', {
        apiKey: 'test-key',
        workspaceRoot: null
      })

      const diag1 = orchestrator.getLastCacheDiagnostics()
      expect(diag1).not.toBeNull()
      expect(diag1?.cacheHit).toBe(false)
      const key1 = diag1?.staticPromptKey

      mockProvider.enqueueResponse({ text: 'Answer 2' })
      await orchestrator.run('What is iteration?', {
        apiKey: 'test-key',
        workspaceRoot: null
      })

      const diag2 = orchestrator.getLastCacheDiagnostics()
      expect(diag2).not.toBeNull()
      expect(diag2?.cacheHit).toBe(true)
      expect(diag2?.staticPromptKey).toBe(key1)

      // Verify that provider received staticPromptKey and staticPromptVersion
      expect(mockProvider.recordedCalls[1].options.staticPromptKey).toBe(key1)
      expect(mockProvider.recordedCalls[1].options.cacheHit).toBe(true)
    })

    it('tracks read_file_range results in context deduplicator during tool loop', async () => {
      vi.mocked(window.electronAPI.readWorkspaceFile).mockResolvedValue({
        success: true,
        content: 'export const a = 1\nexport const b = 2\nexport const c = 3\nexport const d = 4'
      })

      const rangeTool = new ReadFileRangeTool()
      orchestrator.registerTool(rangeTool)

      // Step 1: Model calls read_file_range
      mockProvider.enqueueResponse({
        text: 'Let me read lines 1 to 2.',
        functionCalls: [
          {
            name: 'read_file_range',
            args: { path: 'src/utils.ts', startLine: 1, endLine: 2 }
          }
        ]
      })
      // Step 2: Model finishes
      mockProvider.enqueueResponse({
        text: 'The values are a=1 and b=2.'
      })

      await orchestrator.run('Show me lines 1-2 of src/utils.ts', {
        apiKey: 'test-key',
        workspaceRoot: 'C:\\test\\workspace'
      })

      const deduplicator = orchestrator.getSmartContextEngine().getDeduplicator()
      expect(deduplicator.isFileSliceInContext('src/utils.ts', 1, 2)).toBe(true)
      expect(deduplicator.isFileSliceInContext('src/utils.ts', 3, 4)).toBe(false)
    })

    it('deduplicates duplicate tool calls and records saved chars', async () => {
      vi.mocked(window.electronAPI.readWorkspaceFile).mockResolvedValue({
        success: true,
        content: 'export const a = 1\nexport const b = 2\nexport const c = 3'
      })

      const rangeTool = new ReadFileRangeTool()
      orchestrator.registerTool(rangeTool)

      // Model calls read_file_range twice with identical arguments
      mockProvider.enqueueResponse({
        functionCalls: [
          {
            name: 'read_file_range',
            args: { path: 'src/utils.ts', startLine: 1, endLine: 2 }
          }
        ]
      })
      mockProvider.enqueueResponse({
        functionCalls: [
          {
            name: 'read_file_range',
            args: { path: 'src/utils.ts', startLine: 1, endLine: 2 }
          }
        ]
      })
      mockProvider.enqueueResponse({
        text: 'Finished inspecting ranges.'
      })

      await orchestrator.run('Read range twice', {
        apiKey: 'test-key',
        workspaceRoot: 'C:\\test\\workspace'
      })

      const deduplicator = orchestrator.getSmartContextEngine().getDeduplicator()
      // History should have the second tool result marked as duplicate notice
      const history = orchestrator.getHistory()
      const functionTurns = history.filter((h) => h.role === 'function')
      expect(functionTurns.length).toBe(2)

      const secondResp = functionTurns[1].parts[0]?.functionResponse?.response?.content?.output
      expect(secondResp).toContain('[Notice: Output of read_file_range with identical arguments was already provided earlier')
      expect(deduplicator.getDeduplicatedCharsSaved()).toBeGreaterThan(0)
    })
  })

  describe('Provider Wire Compatibility with Prompt Caching Options', () => {
    it('GeminiProvider does not include prompt cache diagnostic properties in wire request body', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'Response from Gemini' }] } }]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )

      const provider = new GeminiProvider({ fetchImpl: mockFetch as unknown as typeof fetch })
      await provider.sendMessage(
        [{ role: 'user', parts: [{ text: 'Hi' }] }],
        [],
        {
          apiKey: 'test-key',
          systemInstruction: 'Be helpful',
          staticPromptKey: 'hash-12345',
          staticPromptVersion: 'hash-12345',
          cacheHit: true
        }
      )

      expect(mockFetch).toHaveBeenCalledTimes(1)
      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body).not.toHaveProperty('staticPromptKey')
      expect(body).not.toHaveProperty('staticPromptVersion')
      expect(body).not.toHaveProperty('cacheHit')
    })

    it('OpenRouterProvider does not include prompt cache diagnostic properties in wire request body', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'Response from OpenRouter' } }]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )

      const provider = new OpenRouterProvider({ fetchImpl: mockFetch as unknown as typeof fetch })
      await provider.sendMessage(
        [{ role: 'user', parts: [{ text: 'Hi' }] }],
        [],
        {
          apiKey: 'test-key',
          systemInstruction: 'Be helpful',
          staticPromptKey: 'hash-12345',
          staticPromptVersion: 'hash-12345',
          cacheHit: true
        }
      )

      expect(mockFetch).toHaveBeenCalledTimes(1)
      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body).not.toHaveProperty('staticPromptKey')
      expect(body).not.toHaveProperty('staticPromptVersion')
      expect(body).not.toHaveProperty('cacheHit')
    })

    it('OpenCodeProvider does not leak prompt cache diagnostic properties into IPC request', async () => {
      const ipcCaller = vi.fn().mockResolvedValue({
        success: true,
        data: { choices: [{ message: { role: 'assistant', content: 'Response from OpenCode' } }] }
      })

      const provider = new OpenCodeProvider({ defaultModel: 'opencode-free', ipcCaller })
      await provider.sendMessage(
        [{ role: 'user', parts: [{ text: 'Hi' }] }],
        [],
        {
          apiKey: 'test-key',
          systemInstruction: 'Be helpful',
          staticPromptKey: 'hash-12345',
          staticPromptVersion: 'hash-12345',
          cacheHit: true
        }
      )

      expect(ipcCaller).toHaveBeenCalledTimes(1)
      const ipcPayload = ipcCaller.mock.calls[0][0]
      expect(ipcPayload).not.toHaveProperty('staticPromptKey')
      expect(ipcPayload).not.toHaveProperty('staticPromptVersion')
      expect(ipcPayload).not.toHaveProperty('cacheHit')
    })

    it('NvidiaProvider does not leak prompt cache diagnostic properties into IPC request', async () => {
      const ipcCaller = vi.fn().mockResolvedValue({
        success: true,
        data: { choices: [{ message: { role: 'assistant', content: 'Response from NVIDIA' } }] }
      })

      const provider = new NvidiaProvider({ defaultModel: 'meta/llama-3.1-8b-instruct', ipcCaller })
      await provider.sendMessage(
        [{ role: 'user', parts: [{ text: 'Hi' }] }],
        [],
        {
          apiKey: 'test-key',
          systemInstruction: 'Be helpful',
          staticPromptKey: 'hash-12345',
          staticPromptVersion: 'hash-12345',
          cacheHit: true
        }
      )

      expect(ipcCaller).toHaveBeenCalledTimes(1)
      const ipcPayload = ipcCaller.mock.calls[0][0]
      expect(ipcPayload).not.toHaveProperty('staticPromptKey')
      expect(ipcPayload).not.toHaveProperty('staticPromptVersion')
      expect(ipcPayload).not.toHaveProperty('cacheHit')
    })
  })
})

