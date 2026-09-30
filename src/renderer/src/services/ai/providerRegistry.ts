import { IAIProvider, ProviderCapabilities } from './types'
import { GeminiProvider, GeminiProviderConfig } from './geminiProvider'
import { OpenRouterProvider, OpenRouterProviderConfig } from './openRouterProvider'
import { NvidiaProvider, NvidiaProviderConfig } from './nvidiaProvider'
import { OpenCodeProvider, OpenCodeProviderConfig } from './opencodeProvider'

export interface ProviderMetadata {
  id: string
  name: string
  capabilities: ProviderCapabilities
  defaultModel: string
  description?: string
}

export type ProviderFactory<TConfig = unknown> = (config?: TConfig) => IAIProvider

export interface ProviderRegistration<TConfig = unknown> {
  metadata: ProviderMetadata
  factory: ProviderFactory<TConfig>
  singleton?: IAIProvider
}

/**
 * Centralized registry and factory for managing AI providers and their capabilities.
 * Supports lazy singleton instantiation, isolated factory creation, capability querying,
 * and graceful handling of unknown or unsupported provider IDs.
 */
export class ProviderRegistry {
  private registrations = new Map<string, ProviderRegistration<any>>()

  /**
   * Registers a provider definition with metadata and a factory function.
   */
  register<TConfig = unknown>(
    metadata: ProviderMetadata,
    factory: ProviderFactory<TConfig>
  ): void {
    if (!metadata || !metadata.id || typeof metadata.id !== 'string') {
      throw new Error('Provider registration requires a valid metadata object with a non-empty string ID.')
    }
    const id = metadata.id.trim().toLowerCase()
    this.registrations.set(id, {
      metadata: { ...metadata, id },
      factory: factory as ProviderFactory<any>
    })
  }

  /**
   * Checks whether a provider is registered.
   */
  has(id: string): boolean {
    if (!id || typeof id !== 'string') return false
    return this.registrations.has(id.trim().toLowerCase())
  }

  /**
   * Retrieves provider metadata by ID.
   * Throws an error with available IDs if not found.
   */
  getMetadata(id: string): ProviderMetadata {
    if (!id || typeof id !== 'string') {
      throw new Error('Provider ID must be a non-empty string.')
    }
    const normalized = id.trim().toLowerCase()
    const reg = this.registrations.get(normalized)
    if (!reg) {
      const available = Array.from(this.registrations.keys()).join(', ')
      throw new Error(`Unknown AI provider ID: "${id}". Supported providers: ${available || 'none'}`)
    }
    return reg.metadata
  }

  /**
   * Retrieves a shared singleton instance of the provider by ID.
   * Lazily instantiates the provider on first access and caches it for lifecycle consistency.
   */
  get(id: string): IAIProvider {
    if (!id || typeof id !== 'string') {
      throw new Error('Provider ID must be a non-empty string.')
    }
    const normalized = id.trim().toLowerCase()
    const reg = this.registrations.get(normalized)
    if (!reg) {
      const available = Array.from(this.registrations.keys()).join(', ')
      throw new Error(`Unknown AI provider ID: "${id}". Supported providers: ${available || 'none'}`)
    }

    if (!reg.singleton) {
      try {
        reg.singleton = reg.factory()
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        throw new Error(`Failed to initialize provider "${id}": ${msg}`)
      }
    }

    return reg.singleton
  }

  /**
   * Creates a fresh, isolated instance of the provider by ID, optionally passing configuration.
   * Does not modify or cache the singleton instance.
   */
  create<TConfig = unknown>(id: string, config?: TConfig): IAIProvider {
    if (!id || typeof id !== 'string') {
      throw new Error('Provider ID must be a non-empty string.')
    }
    const normalized = id.trim().toLowerCase()
    const reg = this.registrations.get(normalized)
    if (!reg) {
      const available = Array.from(this.registrations.keys()).join(', ')
      throw new Error(`Unknown AI provider ID: "${id}". Supported providers: ${available || 'none'}`)
    }

    try {
      return reg.factory(config)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`Failed to create provider instance "${id}": ${msg}`)
    }
  }

  /**
   * Lists metadata for all registered providers.
   */
  list(): ProviderMetadata[] {
    return Array.from(this.registrations.values()).map((r) => r.metadata)
  }

  /**
   * Clears cached singletons (useful for test resets or configuration updates).
   */
  resetSingletons(): void {
    for (const reg of this.registrations.values()) {
      delete reg.singleton
    }
  }

  /**
   * Unregisters all providers.
   */
  clear(): void {
    this.registrations.clear()
  }
}

/**
 * Creates a registry pre-configured with the default production providers.
 */
export function createDefaultProviderRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry()

  // 1. Google Gemini
  registry.register<GeminiProviderConfig>(
    {
      id: 'gemini',
      name: 'Google Gemini',
      defaultModel: 'gemini-3.8-flash',
      description: 'Google DeepMind multimodal AI models with high reasoning capability and fast streaming.',
      capabilities: {
        supportsStreaming: true,
        supportsTools: true,
        requiresApiKey: true,
        supportsModelListing: false
      }
    },
    (config) => new GeminiProvider(config)
  )

  // 2. OpenRouter
  registry.register<OpenRouterProviderConfig>(
    {
      id: 'openrouter',
      name: 'OpenRouter',
      defaultModel: 'openrouter/free',
      description: 'Unified AI gateway providing access to a wide variety of open-source and proprietary models.',
      capabilities: {
        supportsStreaming: true,
        supportsTools: true,
        requiresApiKey: true,
        supportsModelListing: false
      }
    },
    (config) => new OpenRouterProvider(config)
  )

  // 3. NVIDIA NIM
  registry.register<NvidiaProviderConfig>(
    {
      id: 'nvidia',
      name: 'NVIDIA NIM',
      defaultModel: '',
      description: 'NVIDIA Inference Microservice offering accelerated open-source models with dedicated enterprise infrastructure.',
      capabilities: {
        supportsStreaming: false,
        supportsTools: true,
        requiresApiKey: true,
        supportsModelListing: true
      }
    },
    (config) => new NvidiaProvider(config)
  )

  // 4. OpenCode
  registry.register<OpenCodeProviderConfig>(
    {
      id: 'opencode',
      name: 'OpenCode',
      defaultModel: 'space-bunny-free',
      description: 'OpenCode community-hosted free inference models with streaming and tool-calling support.',
      capabilities: {
        supportsStreaming: true,
        supportsTools: true,
        requiresApiKey: false,
        supportsModelListing: true
      }
    },
    (config) => new OpenCodeProvider(config)
  )

  return registry
}

/**
 * Global singleton provider registry instance.
 */
export const providerRegistry = createDefaultProviderRegistry()
