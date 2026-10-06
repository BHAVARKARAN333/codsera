import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  ProviderRegistry,
  createDefaultProviderRegistry,
  providerRegistry
} from '@renderer/services/ai/providerRegistry'
import type { ProviderMetadata } from '@renderer/services/ai/providerRegistry'
import type {
  IAIProvider,
  ProviderCapabilities,
  LLMMessage,
  FunctionDeclaration,
  LLMRequestOptions,
  LLMResponse
} from '@renderer/services/ai/types'
import { AgentOrchestrator, AgentStepEvent } from '@renderer/services/agent/orchestrator'
import type { ITool, ToolContext, ToolExecutionResult } from '@renderer/services/tools/types'
import { setupMockElectron, resetMockElectron } from '../../setup/electronMock'

// ============================================================================
// Mock Tools & Helpers for Orchestration and Switching Tests
// ============================================================================

class MockEchoTool implements ITool {
  readonly name = 'echo_tool'
  readonly description = 'Echo input text'
  readonly parameters = {
    type: 'object',
    properties: { text: { type: 'string', description: 'Text to echo' } },
    required: ['text']
  }

  async execute(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    return {
      success: true,
      output: (args?.text as string) || ''
    }
  }
}

class MockMutatingTool implements ITool {
  readonly name = 'delete_file'
  readonly description = 'Delete file requiring explicit approval'
  readonly requiresApproval = true
  readonly parameters = {
    type: 'object',
    properties: { path: { type: 'string', description: 'Path to delete' } },
    required: ['path']
  }

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
    if (context?.requestApproval) {
      const approved = await context.requestApproval({
        toolName: this.name,
        path: (args?.path as string) || '/mock/file.txt',
        isDangerous: true
      })
      if (!approved) {
        return {
          success: false,
          rejected: true,
          output: `User rejected approval for ${this.name}`,
          error: `User rejected approval for ${this.name}`
        }
      }
    }
    return { success: true, output: `Deleted ${args?.path}` }
  }
}

function createMockProvider(
  id: string,
  name: string,
  capabilities: ProviderCapabilities,
  sendImpl?: (
    messages: LLMMessage[],
    tools: FunctionDeclaration[],
    options: LLMRequestOptions
  ) => Promise<LLMResponse>
): IAIProvider {
  return {
    id,
    name,
    capabilities,
    sendMessage:
      sendImpl ||
      (async () => ({
        text: `Response from ${name}`,
        rawModelParts: [{ text: `Response from ${name}` }]
      }))
  }
}

// ============================================================================
// Main ProviderRegistry Test Suite
// ============================================================================

describe('ProviderRegistry Unit Tests', () => {
  beforeEach(() => {
    setupMockElectron()
  })

  afterEach(() => {
    resetMockElectron()
    vi.restoreAllMocks()
  })

  // --------------------------------------------------------------------------
  // Group 1: Default Registry & Metadata Consistency
  // --------------------------------------------------------------------------
  describe('Default Registry & Metadata Consistency', () => {
    it('creates a fresh registry with all four built-in providers: gemini, openrouter, nvidia, opencode', () => {
      const registry = createDefaultProviderRegistry()
      const list = registry.list()

      expect(list).toHaveLength(4)
      const ids = list.map((p) => p.id)
      expect(ids).toContain('gemini')
      expect(ids).toContain('openrouter')
      expect(ids).toContain('nvidia')
      expect(ids).toContain('opencode')

      expect(registry.has('gemini')).toBe(true)
      expect(registry.has('openrouter')).toBe(true)
      expect(registry.has('nvidia')).toBe(true)
      expect(registry.has('opencode')).toBe(true)
    })

    it('exports a global singleton providerRegistry pre-populated with all four providers', () => {
      expect(providerRegistry).toBeInstanceOf(ProviderRegistry)
      expect(providerRegistry.list()).toHaveLength(4)
      expect(providerRegistry.has('gemini')).toBe(true)
      expect(providerRegistry.has('openrouter')).toBe(true)
      expect(providerRegistry.has('nvidia')).toBe(true)
      expect(providerRegistry.has('opencode')).toBe(true)
    })

    it('verifies Google Gemini provider metadata and capabilities', () => {
      const meta = providerRegistry.getMetadata('gemini')
      expect(meta.id).toBe('gemini')
      expect(meta.name).toBe('Google Gemini')
      expect(meta.defaultModel).toBe('gemini-3.8-flash')
      expect(meta.description).toContain('Google DeepMind')
      expect(meta.capabilities).toEqual({
        supportsStreaming: true,
        supportsTools: true,
        requiresApiKey: true,
        supportsModelListing: false
      })
    })

    it('verifies OpenRouter provider metadata and capabilities', () => {
      const meta = providerRegistry.getMetadata('openrouter')
      expect(meta.id).toBe('openrouter')
      expect(meta.name).toBe('OpenRouter')
      expect(meta.defaultModel).toBe('openrouter/free')
      expect(meta.description).toContain('Unified AI gateway')
      expect(meta.capabilities).toEqual({
        supportsStreaming: true,
        supportsTools: true,
        requiresApiKey: true,
        supportsModelListing: false
      })
    })

    it('verifies NVIDIA NIM provider metadata and capabilities (non-streaming, model listing)', () => {
      const meta = providerRegistry.getMetadata('nvidia')
      expect(meta.id).toBe('nvidia')
      expect(meta.name).toBe('NVIDIA NIM')
      expect(meta.defaultModel).toBe('')
      expect(meta.description).toContain('NVIDIA Inference Microservice')
      expect(meta.capabilities).toEqual({
        supportsStreaming: false,
        supportsTools: true,
        requiresApiKey: true,
        supportsModelListing: true
      })
    })

    it('verifies OpenCode provider metadata and capabilities (no API key required, model listing)', () => {
      const meta = providerRegistry.getMetadata('opencode')
      expect(meta.id).toBe('opencode')
      expect(meta.name).toBe('OpenCode')
      expect(meta.defaultModel).toBe('space-bunny-free')
      expect(meta.description).toContain('OpenCode community-hosted')
      expect(meta.capabilities).toEqual({
        supportsStreaming: true,
        supportsTools: true,
        requiresApiKey: false,
        supportsModelListing: true
      })
    })

    it('list() returns array containing metadata for all registered providers without mutating internal map', () => {
      const registry = createDefaultProviderRegistry()
      const list1 = registry.list()
      expect(list1).toHaveLength(4)

      // Mutating returned array should not affect registry
      list1.pop()
      expect(list1).toHaveLength(3)
      expect(registry.list()).toHaveLength(4)
    })
  })

  // --------------------------------------------------------------------------
  // Group 2: Registration, Querying & ID Normalization
  // --------------------------------------------------------------------------
  describe('Registration, Querying & ID Normalization', () => {
    it('has() performs case-insensitive and trimmed lookup', () => {
      const registry = createDefaultProviderRegistry()

      expect(registry.has('gemini')).toBe(true)
      expect(registry.has('GEMINI')).toBe(true)
      expect(registry.has('  Gemini  ')).toBe(true)
      expect(registry.has('OpenRouter')).toBe(true)
      expect(registry.has('NVIDIA')).toBe(true)
      expect(registry.has('OpEnCoDe')).toBe(true)
    })

    it('has() returns false for unregistered providers or empty/invalid inputs', () => {
      const registry = createDefaultProviderRegistry()

      expect(registry.has('anthropic')).toBe(false)
      expect(registry.has('unknown_provider')).toBe(false)
      expect(registry.has('')).toBe(false)
      expect(registry.has('   ')).toBe(false)
      expect(registry.has(null as unknown as string)).toBe(false)
      expect(registry.has(undefined as unknown as string)).toBe(false)
      expect(registry.has(123 as unknown as string)).toBe(false)
    })

    it('getMetadata() returns metadata with normalized lowercase ID', () => {
      const registry = createDefaultProviderRegistry()
      const meta = registry.getMetadata('  GEMINI  ')

      expect(meta.id).toBe('gemini')
      expect(meta.name).toBe('Google Gemini')
    })

    it('getMetadata() throws descriptive error on empty string or non-string ID', () => {
      const registry = createDefaultProviderRegistry()

      expect(() => registry.getMetadata('')).toThrow('Provider ID must be a non-empty string.')
      expect(() => registry.getMetadata(null as unknown as string)).toThrow(
        'Provider ID must be a non-empty string.'
      )
      expect(() => registry.getMetadata(undefined as unknown as string)).toThrow(
        'Provider ID must be a non-empty string.'
      )
      // Whitespace-only string is truthy so it passes string check and is treated as unknown ID
      expect(() => registry.getMetadata('   ')).toThrow(
        /Unknown AI provider ID: " {3}"\. Supported providers:/
      )
    })

    it('getMetadata() throws descriptive error listing available providers when ID is unknown', () => {
      const registry = createDefaultProviderRegistry()

      expect(() => registry.getMetadata('unknown-provider')).toThrowError(
        /Unknown AI provider ID: "unknown-provider"\. Supported providers: gemini, openrouter, nvidia, opencode/
      )
    })

    it('register() throws when metadata is missing, null, or has an invalid/empty ID', () => {
      const registry = new ProviderRegistry()

      expect(() => registry.register(null as unknown as ProviderMetadata, () => ({}) as IAIProvider)).toThrow(
        'Provider registration requires a valid metadata object with a non-empty string ID.'
      )
      expect(() =>
        registry.register(undefined as unknown as ProviderMetadata, () => ({}) as IAIProvider)
      ).toThrow('Provider registration requires a valid metadata object with a non-empty string ID.')
      expect(() =>
        registry.register({ id: '', name: 'Empty' } as ProviderMetadata, () => ({}) as IAIProvider)
      ).toThrow('Provider registration requires a valid metadata object with a non-empty string ID.')
      expect(() =>
        registry.register({ id: 123 as unknown as string, name: 'Num' } as ProviderMetadata, () => ({}) as IAIProvider)
      ).toThrow('Provider registration requires a valid metadata object with a non-empty string ID.')
    })

    it('register() normalizes custom provider ID to trimmed lowercase', () => {
      const registry = new ProviderRegistry()
      registry.register(
        {
          id: '  Custom-Model-V1  ',
          name: 'Custom Model',
          defaultModel: 'model-v1',
          capabilities: { supportsStreaming: true, supportsTools: true, requiresApiKey: false }
        },
        () => createMockProvider('custom-model-v1', 'Custom Model', {
          supportsStreaming: true,
          supportsTools: true,
          requiresApiKey: false
        })
      )

      expect(registry.has('custom-model-v1')).toBe(true)
      expect(registry.has('CUSTOM-MODEL-V1')).toBe(true)
      const meta = registry.getMetadata('Custom-Model-V1')
      expect(meta.id).toBe('custom-model-v1')
    })

    it('custom provider registration works cleanly alongside built-ins without collision', () => {
      const registry = createDefaultProviderRegistry()
      registry.register(
        {
          id: 'custom-assistant',
          name: 'Custom Assistant',
          defaultModel: 'assistant-1',
          capabilities: { supportsStreaming: false, supportsTools: false, requiresApiKey: false }
        },
        () => createMockProvider('custom-assistant', 'Custom Assistant', {
          supportsStreaming: false,
          supportsTools: false,
          requiresApiKey: false
        })
      )

      expect(registry.list()).toHaveLength(5)
      expect(registry.has('custom-assistant')).toBe(true)
      expect(registry.has('gemini')).toBe(true)
      const provider = registry.get('custom-assistant')
      expect(provider.id).toBe('custom-assistant')
    })

    it('overwriting an existing registration replaces metadata and factory cleanly', () => {
      const registry = new ProviderRegistry()
      registry.register(
        {
          id: 'test-prov',
          name: 'Version 1',
          defaultModel: 'v1',
          capabilities: { supportsStreaming: false, supportsTools: false, requiresApiKey: false }
        },
        () => createMockProvider('test-prov', 'Version 1', {
          supportsStreaming: false,
          supportsTools: false,
          requiresApiKey: false
        })
      )

      expect(registry.getMetadata('test-prov').name).toBe('Version 1')
      expect(registry.get('test-prov').name).toBe('Version 1')

      // Overwrite with Version 2
      registry.register(
        {
          id: 'test-prov',
          name: 'Version 2',
          defaultModel: 'v2',
          capabilities: { supportsStreaming: true, supportsTools: true, requiresApiKey: true }
        },
        () => createMockProvider('test-prov', 'Version 2', {
          supportsStreaming: true,
          supportsTools: true,
          requiresApiKey: true
        })
      )

      expect(registry.getMetadata('test-prov').name).toBe('Version 2')
      expect(registry.get('test-prov').name).toBe('Version 2')
    })
  })

  // --------------------------------------------------------------------------
  // Group 3: Singleton Lifecycle vs. Isolated Instance Creation
  // --------------------------------------------------------------------------
  describe('Singleton Lifecycle vs. Isolated Instance Creation', () => {
    it('get(id) returns the same cached singleton instance on repeated calls', () => {
      const registry = createDefaultProviderRegistry()
      const inst1 = registry.get('gemini')
      const inst2 = registry.get('gemini')
      const inst3 = registry.get('GEMINI')
      const inst4 = registry.get('  gemini  ')

      expect(inst1).toBe(inst2)
      expect(inst2).toBe(inst3)
      expect(inst3).toBe(inst4)
      expect(inst1.id).toBe('gemini')
    })

    it('get(id) lazily invokes the factory only on first access', () => {
      const registry = new ProviderRegistry()
      const factorySpy = vi.fn(() =>
        createMockProvider('mock', 'Mock Provider', {
          supportsStreaming: true,
          supportsTools: true,
          requiresApiKey: false
        })
      )

      registry.register(
        {
          id: 'mock',
          name: 'Mock',
          defaultModel: 'm1',
          capabilities: { supportsStreaming: true, supportsTools: true, requiresApiKey: false }
        },
        factorySpy
      )

      expect(factorySpy).not.toHaveBeenCalled()

      const first = registry.get('mock')
      expect(factorySpy).toHaveBeenCalledTimes(1)

      const second = registry.get('mock')
      expect(factorySpy).toHaveBeenCalledTimes(1)
      expect(first).toBe(second)
    })

    it('create(id, config) returns fresh isolated instances distinct from cached singleton', () => {
      const registry = createDefaultProviderRegistry()
      const singleton = registry.get('openrouter')
      const fresh1 = registry.create('openrouter')
      const fresh2 = registry.create('openrouter', { defaultTimeoutMs: 15000 })

      expect(singleton).not.toBe(fresh1)
      expect(fresh1).not.toBe(fresh2)
      expect(singleton).not.toBe(fresh2)
      expect(registry.get('openrouter')).toBe(singleton)
    })

    it('create(id, config) forwards custom configuration to the factory', () => {
      const registry = new ProviderRegistry()
      interface CustomConfig {
        apiKey?: string
        timeout?: number
      }

      const receivedConfigs: CustomConfig[] = []
      registry.register<CustomConfig>(
        {
          id: 'custom',
          name: 'Custom',
          defaultModel: 'custom',
          capabilities: { supportsStreaming: true, supportsTools: true, requiresApiKey: true }
        },
        (config) => {
          if (config) receivedConfigs.push(config)
          return createMockProvider('custom', 'Custom', {
            supportsStreaming: true,
            supportsTools: true,
            requiresApiKey: true
          })
        }
      )

      registry.create('custom', { apiKey: 'key-123', timeout: 5000 })
      registry.create('custom', { apiKey: 'key-456', timeout: 8000 })

      expect(receivedConfigs).toHaveLength(2)
      expect(receivedConfigs[0]).toEqual({ apiKey: 'key-123', timeout: 5000 })
      expect(receivedConfigs[1]).toEqual({ apiKey: 'key-456', timeout: 8000 })
    })

    it('create(id) performs case-insensitive and trimmed lookup', () => {
      const registry = createDefaultProviderRegistry()
      const instance = registry.create('  OPENROUTER  ')
      expect(instance.id).toBe('openrouter')
    })

    it('resetSingletons() purges cached singletons, causing subsequent get(id) to re-instantiate', () => {
      const registry = createDefaultProviderRegistry()
      const geminiBefore = registry.get('gemini')
      const openRouterBefore = registry.get('openrouter')

      registry.resetSingletons()

      const geminiAfter = registry.get('gemini')
      const openRouterAfter = registry.get('openrouter')

      expect(geminiBefore).not.toBe(geminiAfter)
      expect(openRouterBefore).not.toBe(openRouterAfter)
      expect(geminiAfter.id).toBe('gemini')
      expect(openRouterAfter.id).toBe('openrouter')
    })

    it('clear() purges all registrations from the registry', () => {
      const registry = createDefaultProviderRegistry()
      expect(registry.list()).toHaveLength(4)

      registry.clear()

      expect(registry.list()).toHaveLength(0)
      expect(registry.has('gemini')).toBe(false)
      expect(registry.has('openrouter')).toBe(false)
      expect(registry.has('nvidia')).toBe(false)
      expect(registry.has('opencode')).toBe(false)

      expect(() => registry.getMetadata('gemini')).toThrow(
        'Unknown AI provider ID: "gemini". Supported providers: none'
      )
      expect(() => registry.get('gemini')).toThrow(
        'Unknown AI provider ID: "gemini". Supported providers: none'
      )
      expect(() => registry.create('gemini')).toThrow(
        'Unknown AI provider ID: "gemini". Supported providers: none'
      )
    })

    it('get() wraps factory initialization exceptions in a descriptive error', () => {
      const registry = new ProviderRegistry()
      registry.register(
        {
          id: 'faulty',
          name: 'Faulty',
          defaultModel: 'faulty',
          capabilities: { supportsStreaming: false, supportsTools: false, requiresApiKey: false }
        },
        () => {
          throw new Error('Missing native driver binding.')
        }
      )

      expect(() => registry.get('faulty')).toThrow(
        'Failed to initialize provider "faulty": Missing native driver binding.'
      )
    })

    it('create() wraps factory creation exceptions in a descriptive error', () => {
      const registry = new ProviderRegistry()
      registry.register(
        {
          id: 'faulty-create',
          name: 'Faulty Create',
          defaultModel: 'faulty',
          capabilities: { supportsStreaming: false, supportsTools: false, requiresApiKey: false }
        },
        () => {
          throw new Error('Network timeout during client setup.')
        }
      )

      expect(() => registry.create('faulty-create')).toThrow(
        'Failed to create provider instance "faulty-create": Network timeout during client setup.'
      )
    })
  })

  // --------------------------------------------------------------------------
  // Group 4: Provider Selection & Fallback Logic
  // --------------------------------------------------------------------------
  describe('Provider Selection & Fallback Logic', () => {
    it('selects requested provider when present in registry', () => {
      const registry = createDefaultProviderRegistry()
      const preferredId = 'openrouter'

      const provider = registry.has(preferredId)
        ? registry.get(preferredId)
        : registry.get('gemini')

      expect(provider.id).toBe('openrouter')
    })

    it('falls back to default provider (gemini) when requested provider is unregistered', () => {
      const registry = createDefaultProviderRegistry()
      const preferredId = 'unsupported-custom-llm'

      const provider = registry.has(preferredId)
        ? registry.get(preferredId)
        : registry.get('gemini')

      expect(provider.id).toBe('gemini')
    })

    it('handles empty or whitespace provider settings by falling back to gemini', () => {
      const registry = createDefaultProviderRegistry()
      const testCases = ['', '   ', null, undefined]

      for (const input of testCases) {
        const selectedId = input && registry.has(input) ? input : 'gemini'
        const provider = registry.get(selectedId)
        expect(provider.id).toBe('gemini')
      }
    })

    it('resolves model fallback when provider defaultModel is empty (such as NVIDIA NIM)', () => {
      const registry = createDefaultProviderRegistry()
      const nvidiaMeta = registry.getMetadata('nvidia')
      expect(nvidiaMeta.defaultModel).toBe('')

      // Simulation of UI selection fallback when defaultModel is empty
      const configuredModel = ''
      const discoveredModels = [{ id: 'meta/llama-3.3-70b-instruct' }, { id: 'nvidia/llama-3.1-nemotron-70b-instruct' }]

      const activeModel =
        configuredModel.trim() ||
        nvidiaMeta.defaultModel ||
        (discoveredModels.length > 0 ? discoveredModels[0].id : '')

      expect(activeModel).toBe('meta/llama-3.3-70b-instruct')
    })

    it('filters registered providers by capability requirements', () => {
      const registry = createDefaultProviderRegistry()
      const all = registry.list()

      // Providers that do not require an API key
      const noApiKeyProviders = all.filter((p) => !p.capabilities.requiresApiKey)
      expect(noApiKeyProviders).toHaveLength(1)
      expect(noApiKeyProviders[0].id).toBe('opencode')

      // Providers that support model listing via API
      const modelListingProviders = all.filter((p) => p.capabilities.supportsModelListing)
      expect(modelListingProviders).toHaveLength(2)
      expect(modelListingProviders.map((p) => p.id)).toEqual(['nvidia', 'opencode'])

      // Streaming-capable providers
      const streamingProviders = all.filter((p) => p.capabilities.supportsStreaming)
      expect(streamingProviders).toHaveLength(3)
      expect(streamingProviders.map((p) => p.id)).toEqual(['gemini', 'openrouter', 'opencode'])
    })
  })

  // --------------------------------------------------------------------------
  // Group 5: Provider Switching, State Isolation & Capability Enforcement
  // --------------------------------------------------------------------------
  describe('Provider Switching, State Isolation & Capability Enforcement', () => {
    it('switching provider via orchestrator.setProvider updates active provider and clearHistory resets conversation turns', async () => {
      const providerA = createMockProvider('prov-a', 'Provider A', {
        supportsStreaming: true,
        supportsTools: true,
        requiresApiKey: false
      })
      const providerB = createMockProvider('prov-b', 'Provider B', {
        supportsStreaming: true,
        supportsTools: true,
        requiresApiKey: false
      })

      const orch = new AgentOrchestrator(providerA)
      expect(orch.getProvider().id).toBe('prov-a')

      await orch.run('Turn 1 on A', { apiKey: '', workspaceRoot: null })
      expect(orch.getHistory().length).toBeGreaterThan(0)

      // Switch to Provider B and clear history (mirroring AIChatPanel provider switch handler)
      orch.setProvider(providerB)
      orch.clearHistory()

      expect(orch.getProvider().id).toBe('prov-b')
      expect(orch.getHistory()).toEqual([])

      const resB = await orch.run('Turn 2 on B', { apiKey: '', workspaceRoot: null })
      expect(resB).toBe('Response from Provider B')
      // History should only contain Turn 2
      const history = orch.getHistory()
      expect(history).toHaveLength(2)
      expect(history[0].role).toBe('user')
      expect(history[0].parts[0].text).toBe('Turn 2 on B')
    })

    it('withholds tool declarations when provider capability supportsTools is false', async () => {
      let passedTools: FunctionDeclaration[] | null = null

      const noToolsProvider = createMockProvider(
        'no-tools',
        'No Tools Provider',
        {
          supportsStreaming: true,
          supportsTools: false,
          requiresApiKey: false
        },
        async (_history, tools) => {
          passedTools = tools
          return { text: 'Direct response without tools', rawModelParts: [{ text: 'Direct response without tools' }] }
        }
      )

      const orch = new AgentOrchestrator(noToolsProvider)
      orch.registerTool(new MockEchoTool())

      const response = await orch.run('Echo test', { apiKey: '', workspaceRoot: null })
      expect(response).toBe('Direct response without tools')
      expect(passedTools).toEqual([])
    })

    it('passes tool declarations when provider capability supportsTools is true', async () => {
      let passedTools: FunctionDeclaration[] | null = null

      const toolsProvider = createMockProvider(
        'tools-provider',
        'Tools Provider',
        {
          supportsStreaming: true,
          supportsTools: true,
          requiresApiKey: false
        },
        async (_history, tools) => {
          passedTools = tools
          return { text: 'Tools received', rawModelParts: [{ text: 'Tools received' }] }
        }
      )

      const orch = new AgentOrchestrator(toolsProvider)
      orch.registerTool(new MockEchoTool())

      await orch.run('List tools', { apiKey: '', workspaceRoot: null })
      expect(passedTools).not.toBeNull()
      expect(passedTools).toHaveLength(1)
      expect(passedTools![0].name).toBe('echo_tool')
    })

    it('omits onChunk callback when provider capability supportsStreaming is false', async () => {
      let receivedOnChunk: ((chunk: string) => void) | undefined = undefined

      const nonStreamingProvider = createMockProvider(
        'non-streaming',
        'Non Streaming Provider',
        {
          supportsStreaming: false,
          supportsTools: true,
          requiresApiKey: false
        },
        async (_history, _tools, options) => {
          receivedOnChunk = options.onChunk
          return { text: 'Full text completion', rawModelParts: [{ text: 'Full text completion' }] }
        }
      )

      const orch = new AgentOrchestrator(nonStreamingProvider)
      await orch.run('Query', {
        apiKey: '',
        workspaceRoot: null,
        onChunk: () => {}
      })

      expect(receivedOnChunk).toBeUndefined()
    })

    it('provides onChunk callback when provider capability supportsStreaming is true', async () => {
      let receivedOnChunk: ((chunk: string) => void) | undefined = undefined

      const streamingProvider = createMockProvider(
        'streaming-prov',
        'Streaming Provider',
        {
          supportsStreaming: true,
          supportsTools: true,
          requiresApiKey: false
        },
        async (_history, _tools, options) => {
          receivedOnChunk = options.onChunk
          options.onChunk?.('Streamed response')
          return { text: 'Streamed response', rawModelParts: [{ text: 'Streamed response' }] }
        }
      )

      const orch = new AgentOrchestrator(streamingProvider)
      const receivedChunks: string[] = []

      await orch.run('Query', {
        apiKey: '',
        workspaceRoot: null,
        onChunk: (c) => receivedChunks.push(c)
      })

      expect(receivedOnChunk).toBeDefined()
      expect(receivedChunks).toEqual(['Streamed response'])
    })

    it('dynamic model selection forwards active modelName to provider.sendMessage', async () => {
      let forwardedModel: string | undefined = undefined

      const provider = createMockProvider(
        'model-checker',
        'Model Checker',
        {
          supportsStreaming: true,
          supportsTools: true,
          requiresApiKey: false
        },
        async (_history, _tools, options) => {
          forwardedModel = options.modelName
          return { text: 'Model acknowledged', rawModelParts: [{ text: 'Model acknowledged' }] }
        }
      )

      const orch = new AgentOrchestrator(provider)
      await orch.run('Check model', {
        apiKey: '',
        workspaceRoot: null,
        modelName: 'deepseek-ai/deepseek-r1-distill-llama-70b'
      })

      expect(forwardedModel).toBe('deepseek-ai/deepseek-r1-distill-llama-70b')
    })

    it('streaming chunks from Provider A do not leak into Provider B callbacks after switching', async () => {
      const emittedEvents: Array<{ provider: string; chunk: string }> = []

      const providerA = createMockProvider(
        'stream-a',
        'Provider A',
        { supportsStreaming: true, supportsTools: true, requiresApiKey: false },
        async (_history, _tools, options) => {
          options.onChunk?.('Chunk A-1')
          options.onChunk?.('Chunk A-2')
          return { text: 'Final A', rawModelParts: [{ text: 'Final A' }] }
        }
      )

      const providerB = createMockProvider(
        'stream-b',
        'Provider B',
        { supportsStreaming: true, supportsTools: true, requiresApiKey: false },
        async (_history, _tools, options) => {
          options.onChunk?.('Chunk B-1')
          return { text: 'Final B', rawModelParts: [{ text: 'Final B' }] }
        }
      )

      const orch = new AgentOrchestrator(providerA)
      await orch.run('Req 1', {
        apiKey: '',
        workspaceRoot: null,
        onChunk: (c) => emittedEvents.push({ provider: 'A', chunk: c })
      })

      orch.setProvider(providerB)
      orch.clearHistory()

      await orch.run('Req 2', {
        apiKey: '',
        workspaceRoot: null,
        onChunk: (c) => emittedEvents.push({ provider: 'B', chunk: c })
      })

      const aChunks = emittedEvents.filter((e) => e.provider === 'A').map((e) => e.chunk)
      const bChunks = emittedEvents.filter((e) => e.provider === 'B').map((e) => e.chunk)

      expect(aChunks).toEqual(['Chunk A-1', 'Chunk A-2'])
      expect(bChunks).toEqual(['Chunk B-1'])
    })

    it('tool call and result turns from Provider A session do not persist in Provider B session', async () => {
      let providerBHistory: LLMMessage[] | null = null

      let turnA = 0
      const providerA = createMockProvider(
        'tool-a',
        'Tool Provider A',
        { supportsStreaming: true, supportsTools: true, requiresApiKey: false },
        async () => {
          turnA++
          if (turnA === 1) {
            return {
              rawModelParts: [{ functionCall: { name: 'echo_tool', args: { text: 'secret_value' } } }],
              functionCalls: [{ name: 'echo_tool', args: { text: 'secret_value' } }]
            }
          }
          return { text: 'Done A', rawModelParts: [{ text: 'Done A' }] }
        }
      )

      const providerB = createMockProvider(
        'tool-b',
        'Tool Provider B',
        { supportsStreaming: true, supportsTools: true, requiresApiKey: false },
        async (history) => {
          providerBHistory = JSON.parse(JSON.stringify(history))
          return { text: 'Done B', rawModelParts: [{ text: 'Done B' }] }
        }
      )

      const orch = new AgentOrchestrator(providerA)
      orch.registerTool(new MockEchoTool())

      await orch.run('Run tool on A', { apiKey: '', workspaceRoot: null })

      // Switch to Provider B and clear
      orch.setProvider(providerB)
      orch.clearHistory()

      await orch.run('Query on B', { apiKey: '', workspaceRoot: null })

      expect(providerBHistory).not.toBeNull()
      const hasAnyToolTurns = providerBHistory!.some((msg) =>
        msg.parts.some((p) => p.functionCall || p.functionResponse)
      )
      expect(hasAnyToolTurns).toBe(false)
      expect(providerBHistory![0].parts[0].text).toBe('Query on B')
    })

    it('active approval request is cleanly aborted when orchestrator stops or cancels', async () => {
      let approvalResolved = false

      const approvalProvider = createMockProvider(
        'approval-prov',
        'Approval Provider',
        { supportsStreaming: true, supportsTools: true, requiresApiKey: false },
        async () => ({
          rawModelParts: [{ functionCall: { name: 'delete_file', args: { path: 'important.ts' } } }],
          functionCalls: [{ name: 'delete_file', args: { path: 'important.ts' } }]
        })
      )

      const orch = new AgentOrchestrator(approvalProvider)
      orch.registerTool(new MockMutatingTool())

      const runPromise = orch.run('Delete file', {
        apiKey: '',
        workspaceRoot: null,
        requestApproval: () => {
          return new Promise<boolean>((resolve) => {
            setTimeout(() => {
              orch.stop()
              resolve(false)
              approvalResolved = true
            }, 10)
          })
        }
      })

      await expect(runPromise).rejects.toThrow('Request was stopped by user.')
      expect(approvalResolved).toBe(true)
    })

    it('pre-run cancellation halts execution immediately without calling provider.sendMessage', async () => {
      let providerCalled = false
      const provider = createMockProvider(
        'dummy',
        'Dummy',
        { supportsStreaming: true, supportsTools: true, requiresApiKey: false },
        async () => {
          providerCalled = true
          return { text: 'Should not run' }
        }
      )

      const orch = new AgentOrchestrator(provider)
      const controller = new AbortController()
      controller.abort()

      await expect(
        orch.run('Hello', {
          apiKey: '',
          workspaceRoot: null,
          signal: controller.signal
        })
      ).rejects.toThrow('Request was stopped by user.')

      expect(providerCalled).toBe(false)
    })

    it('in-flight cancellation aborts active provider request cleanly', async () => {
      const controller = new AbortController()
      const provider = createMockProvider(
        'in-flight-abort',
        'In Flight Abort',
        { supportsStreaming: true, supportsTools: true, requiresApiKey: false },
        async () => {
          controller.abort()
          throw new Error('Request was stopped by user.')
        }
      )

      const orch = new AgentOrchestrator(provider)
      await expect(
        orch.run('Cancel in flight', {
          apiKey: '',
          workspaceRoot: null,
          signal: controller.signal
        })
      ).rejects.toThrow('Request was stopped by user.')
    })

    it('transient provider retry events propagate to onStep with retryAttempt count', async () => {
      let attempts = 0
      const retryEvents: AgentStepEvent[] = []

      const provider = createMockProvider(
        'retry-provider',
        'Retry Provider',
        { supportsStreaming: true, supportsTools: true, requiresApiKey: false },
        async (_history, _tools, options) => {
          attempts++
          if (attempts === 1) {
            options.onRetry?.(1, 2, 10, 'Rate limit exceeded')
            return { text: 'Recovered after retry', rawModelParts: [{ text: 'Recovered after retry' }] }
          }
          return { text: 'Success', rawModelParts: [{ text: 'Success' }] }
        }
      )

      const orch = new AgentOrchestrator(provider)
      const result = await orch.run('Retry test', {
        apiKey: '',
        workspaceRoot: null,
        onStep: (step) => {
          if (step.type === 'retrying') retryEvents.push(step)
        }
      })

      expect(result).toBe('Recovered after retry')
      expect(retryEvents).toHaveLength(1)
      expect(retryEvents[0].retryAttempt).toBe(1)
      expect(retryEvents[0].maxRetries).toBe(2)
      expect(retryEvents[0].text).toContain('Rate limit exceeded')
    })

    it('permanent provider error propagates cleanly without infinite retry loops', async () => {
      const provider = createMockProvider(
        'fail-prov',
        'Fail Provider',
        { supportsStreaming: true, supportsTools: true, requiresApiKey: false },
        async () => {
          throw new Error('Invalid API key provided.')
        }
      )

      const orch = new AgentOrchestrator(provider)
      await expect(
        orch.run('Permanent fail', {
          apiKey: '',
          workspaceRoot: null
        })
      ).rejects.toThrow('Invalid API key provided.')
    })

    it('concurrent orchestrator instances with distinct providers run in complete isolation', async () => {
      const providerA = createMockProvider(
        'conc-a',
        'Concurrent A',
        { supportsStreaming: true, supportsTools: true, requiresApiKey: false },
        async () => {
          await new Promise((r) => setTimeout(r, 20))
          return { text: 'Response from Conc A', rawModelParts: [{ text: 'Response from Conc A' }] }
        }
      )

      const providerB = createMockProvider(
        'conc-b',
        'Concurrent B',
        { supportsStreaming: true, supportsTools: true, requiresApiKey: false },
        async () => {
          await new Promise((r) => setTimeout(r, 10))
          return { text: 'Response from Conc B', rawModelParts: [{ text: 'Response from Conc B' }] }
        }
      )

      const orchA = new AgentOrchestrator(providerA)
      const orchB = new AgentOrchestrator(providerB)

      const [resA, resB] = await Promise.all([
        orchA.run('Query A', { apiKey: '', workspaceRoot: null }),
        orchB.run('Query B', { apiKey: '', workspaceRoot: null })
      ])

      expect(resA).toBe('Response from Conc A')
      expect(resB).toBe('Response from Conc B')
      expect(orchA.getHistory()[0].parts[0].text).toBe('Query A')
      expect(orchB.getHistory()[0].parts[0].text).toBe('Query B')
    })
  })
})
