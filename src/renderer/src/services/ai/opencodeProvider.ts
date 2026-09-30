import {
  FunctionDeclaration,
  IAIProvider,
  LLMMessage,
  LLMRequestOptions,
  LLMResponse,
  ProviderCapabilities
} from './types'
import {
  OpenCodeChatCompletionRequest,
  OpenCodeChatCompletionResponse,
  OpenCodeListModelsRequest,
  OpenCodeListModelsResponse,
  OpenCodeModelItem,
  OpenCodeStreamChunkEvent
} from '../../../../shared/types'
import {
  calculateRetryDelay,
  cancellableSleep,
  classifyProviderError,
  parseOpenAIToolCalls,
  serializeOpenAIMessages,
  serializeOpenAITools
} from './providerUtils'

export interface OpenCodeProviderConfig {
  defaultModel?: string
  defaultTimeoutMs?: number
  debug?: boolean
  fetchImpl?: typeof fetch
  ipcCaller?: (req: OpenCodeChatCompletionRequest) => Promise<OpenCodeChatCompletionResponse>
  listModelsIpcCaller?: (req?: OpenCodeListModelsRequest) => Promise<OpenCodeListModelsResponse>
  streamListener?: (cb: (event: OpenCodeStreamChunkEvent) => void) => () => void
}

export class OpenCodeProvider implements IAIProvider {
  readonly id = 'opencode'
  readonly name = 'OpenCode'

  readonly capabilities: ProviderCapabilities = {
    supportsStreaming: true,
    supportsTools: true,
    requiresApiKey: false,
    supportsModelListing: true
  }

  // Default verified working free model
  private defaultModel = 'space-bunny-free'
  private defaultTimeoutMs = 60000 // 60 seconds
  private debug = false
  private fetchImpl?: typeof fetch
  private ipcCaller?: (req: OpenCodeChatCompletionRequest) => Promise<OpenCodeChatCompletionResponse>
  private listModelsIpcCaller?: (req?: OpenCodeListModelsRequest) => Promise<OpenCodeListModelsResponse>
  private streamListener?: (cb: (event: OpenCodeStreamChunkEvent) => void) => () => void

  constructor(config?: OpenCodeProviderConfig) {
    if (config?.defaultModel) this.defaultModel = config.defaultModel
    if (config?.defaultTimeoutMs) this.defaultTimeoutMs = config.defaultTimeoutMs
    if (config?.debug !== undefined) this.debug = config.debug
    if (config?.fetchImpl) this.fetchImpl = config.fetchImpl
    if (config?.ipcCaller) this.ipcCaller = config.ipcCaller
    if (config?.listModelsIpcCaller) this.listModelsIpcCaller = config.listModelsIpcCaller
    if (config?.streamListener) this.streamListener = config.streamListener
  }

  setDebug(enabled: boolean): void {
    this.debug = enabled
  }

  private logDiagnostic(stage: string, details?: Record<string, unknown>): void {
    if (this.debug) {
      const detailsStr = details ? ` | ${JSON.stringify(details)}` : ''
      console.debug(`[OpenCodeProvider] Stage: ${stage}${detailsStr}`)
    }
  }

  /**
   * Fetches available models from the official OpenCode models endpoint and filters strictly for free models.
   */
  async listFreeModels(apiKey?: string, timeoutMs = 15000): Promise<OpenCodeModelItem[]> {
    if (this.listModelsIpcCaller) {
      const res = await this.listModelsIpcCaller({ apiKey, timeoutMs })
      if (res.success && res.models) return res.models
      throw new Error(res.errorDetails || res.error || 'Failed to list OpenCode models')
    }

    if (typeof window !== 'undefined' && window.electronAPI?.opencodeListModels) {
      const res = await window.electronAPI.opencodeListModels({ apiKey, timeoutMs })
      if (res.success && res.models) return res.models
      throw new Error(res.errorDetails || res.error || 'Failed to list OpenCode models')
    }

    // Direct fetch fallback for non-Electron test environments
    const fetchFunc = this.fetchImpl || fetch
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const headers: Record<string, string> = { Accept: 'application/json' }
      if (apiKey && apiKey.trim()) {
        headers.Authorization = `Bearer ${apiKey.trim()}`
      }

      const resp = await fetchFunc('https://opencode.ai/inference/v1/models', {
        method: 'GET',
        headers,
        signal: controller.signal
      })
      clearTimeout(timer)

      if (!resp.ok) {
        throw new Error(`Failed to fetch models: HTTP ${resp.status} ${resp.statusText}`)
      }

      const data = (await resp.json()) as any
      const list: any[] = Array.isArray(data.data) ? data.data : Array.isArray(data) ? data : []

      return list
        .filter((m) => String(m.id || '').toLowerCase().includes('free'))
        .map((m) => ({
          id: String(m.id),
          created: m.created,
          owned_by: m.owned_by,
          object: m.object,
          isFree: true
        }))
    } catch (err: unknown) {
      clearTimeout(timer)
      throw err instanceof Error ? err : new Error(String(err))
    }
  }

  async sendMessage(
    messages: LLMMessage[],
    tools: FunctionDeclaration[],
    options: LLMRequestOptions
  ): Promise<LLMResponse> {
    const {
      apiKey,
      modelName = this.defaultModel,
      systemInstruction,
      temperature = 0.2,
      timeoutMs = this.defaultTimeoutMs,
      signal,
      onRetry
    } = options

    if (signal?.aborted) {
      throw new Error('Request was stopped by user.')
    }

    const activeModel = modelName.trim() || this.defaultModel
    this.logDiagnostic('start', { model: activeModel, hasKey: !!apiKey?.trim() })

    // Format messages and tools with shared serializers
    const formattedMessages = serializeOpenAIMessages(messages, systemInstruction)
    const formattedTools = serializeOpenAITools(tools)

    const onChunkCallback = options.onChunk
    const isStreaming = typeof onChunkCallback === 'function'

    const MAX_RETRIES = 2
    let lastError: Error | null = null

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (signal?.aborted) {
        throw new Error('Request was stopped by user.')
      }

      // Generate a fresh unique requestId for each attempt to prevent late-chunk bleed
      const requestId = `opencode_${Date.now()}_${Math.random().toString(36).slice(2, 9)}_att${attempt}`

      const requestPayload: OpenCodeChatCompletionRequest = {
        model: activeModel,
        messages: formattedMessages,
        temperature,
        timeoutMs,
        apiKey: apiKey?.trim() || undefined,
        requestId
      }

      if (formattedTools && formattedTools.length > 0) {
        requestPayload.tools = formattedTools
        requestPayload.tool_choice = 'auto'
      }

      if (isStreaming) {
        requestPayload.stream = true
      }

      let cleanupStreamListener: (() => void) | null = null
      let accumulatedStreamText = ''
      let attemptActive = true

      const onAbort = () => {
        if (typeof window !== 'undefined' && window.electronAPI?.cancelChatCompletion) {
          window.electronAPI.cancelChatCompletion(requestId).catch(() => {})
        }
      }

      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true })
      }

      try {
        // Listen for streaming chunks strictly associated with this attempt's requestId
        if (isStreaming) {
          const streamListener =
            this.streamListener ||
            (typeof window !== 'undefined' && window.electronAPI?.onOpenCodeStreamChunk
              ? window.electronAPI.onOpenCodeStreamChunk
              : null)

          if (streamListener) {
            cleanupStreamListener = streamListener((event) => {
              // Discard any chunk that arrives after attempt finishes or doesn't match this attempt's requestId
              if (!attemptActive || event.requestId !== requestId) return
              if (signal?.aborted) return

              if (event.chunk) {
                accumulatedStreamText += event.chunk
                onChunkCallback(event.chunk)
              }
            })
          }
        }

        let response: OpenCodeChatCompletionResponse

        try {
          if (this.ipcCaller) {
            this.logDiagnostic('sending_custom_ipc', { attempt, model: activeModel, stream: isStreaming, requestId })
            response = await this.ipcCaller(requestPayload)
          } else if (typeof window !== 'undefined' && window.electronAPI?.opencodeChatCompletion) {
            this.logDiagnostic('sending_electron_ipc', { attempt, model: activeModel, stream: isStreaming, requestId })
            response = await window.electronAPI.opencodeChatCompletion(requestPayload)
          } else {
            // Direct Node / test harness fallback
            this.logDiagnostic('sending_direct_fetch', { attempt, model: activeModel, stream: isStreaming, requestId })
            response = await this.sendDirectFetch(requestPayload, onChunkCallback, signal)
          }
        } finally {
          // Immediately mark attempt inactive and clean up stream listener so late chunks during retry sleep are dropped
          attemptActive = false
          if (cleanupStreamListener) {
            cleanupStreamListener()
            cleanupStreamListener = null
          }
        }

        if (signal?.aborted) {
          throw new Error('Request was stopped by user.')
        }

        if (!response.success) {
          const classification = classifyProviderError(
            {
              status: response.status,
              message: response.errorDetails || response.error,
              errorDetails: response.errorDetails,
              isNetworkError: response.isNetworkError
            },
            {
              signal,
              providerName: this.name,
              modelName: activeModel
            }
          )

          if (classification.isUserCancellation) {
            throw new Error('Request was stopped by user.')
          }

          if (classification.isRetryable && attempt < MAX_RETRIES) {
            const delayMs = calculateRetryDelay(attempt, (response as any).retryAfter || null, {
              baseDelayMs: 1000,
              minDelayMs: 500,
              maxDelayMs: 30000
            })
            this.logDiagnostic('retrying', { attempt: attempt + 1, delayMs, status: response.status })
            onRetry?.(attempt + 1, MAX_RETRIES, delayMs, classification.reason)
            await cancellableSleep(delayMs, signal)
            continue
          }

          this.logDiagnostic('failed_final', { status: response.status, error: classification.userFriendlyMessage })
          throw new Error(classification.userFriendlyMessage)
        }

        const choice = response.data?.choices?.[0]
        if (!choice || !choice.message) {
          return { text: 'No response returned from OpenCode.' }
        }

        const choiceMsg = choice.message
        const { functionCalls, rawModelParts } = parseOpenAIToolCalls(choiceMsg.tool_calls)

        // Ensure final response matches stream deltas cleanly without duplicates
        const finalText = (accumulatedStreamText || choiceMsg.content || '').trim() || undefined
        if (finalText) {
          rawModelParts.push({ text: finalText })
        }

        return {
          text: finalText,
          functionCalls: functionCalls.length > 0 ? functionCalls : undefined,
          rawModelParts
        }
      } catch (err: unknown) {
        if (signal?.aborted) {
          throw new Error('Request was stopped by user.')
        }

        const classification = classifyProviderError(err, {
          signal,
          providerName: this.name,
          modelName: activeModel
        })

        if (classification.isUserCancellation) {
          throw new Error('Request was stopped by user.')
        }

        if (classification.isRetryable && attempt < MAX_RETRIES) {
          const delayMs = calculateRetryDelay(attempt, null, {
            baseDelayMs: 1000,
            minDelayMs: 500,
            maxDelayMs: 30000
          })
          onRetry?.(attempt + 1, MAX_RETRIES, delayMs, classification.reason)
          await cancellableSleep(delayMs, signal)
          continue
        }

        lastError = new Error(classification.userFriendlyMessage)
        throw lastError
      } finally {
        if (cleanupStreamListener) {
          cleanupStreamListener()
        }
        if (signal) {
          signal.removeEventListener('abort', onAbort)
        }
      }
    }

    throw lastError || new Error('The OpenCode AI provider is temporarily unavailable. Please try again.')
  }

  /**
   * Direct fetch implementation for Node / test runner environments.
   */
  private async sendDirectFetch(
    req: OpenCodeChatCompletionRequest,
    onChunk?: (chunk: string) => void,
    signal?: AbortSignal
  ): Promise<OpenCodeChatCompletionResponse> {
    const fetchFunc = this.fetchImpl || fetch
    const timeoutMs = req.timeoutMs || this.defaultTimeoutMs
    const controller = new AbortController()
    let isTimedOut = false
    const timer = setTimeout(() => {
      isTimedOut = true
      controller.abort()
    }, timeoutMs)

    const onSignalAbort = () => controller.abort()
    if (signal) {
      signal.addEventListener('abort', onSignalAbort, { once: true })
    }

    const endpoint = 'https://opencode.ai/inference/openai/v1/chat/completions'
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: req.stream ? 'text/event-stream, application/json' : 'application/json'
    }

    if (req.apiKey && req.apiKey.trim()) {
      headers.Authorization = `Bearer ${req.apiKey.trim()}`
    }

    const requestBody: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      temperature: req.temperature,
      stream: req.stream
    }

    if (req.tools) {
      requestBody.tools = req.tools
      requestBody.tool_choice = req.tool_choice || 'auto'
    }

    try {
      const response = await fetchFunc(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: controller.signal
      })
      clearTimeout(timer)
      if (signal) {
        signal.removeEventListener('abort', onSignalAbort)
      }

      if (!response.ok) {
        let errorDetails = `Status ${response.status} (${response.statusText})`
        try {
          const errJson = (await response.json()) as any
          if (errJson.error?.message) {
            errorDetails = errJson.error.message
          } else if (errJson.message) {
            errorDetails = errJson.message
          }
        } catch {}

        const retryAfter = response.headers.get('retry-after')
        return {
          success: false,
          status: response.status,
          statusText: response.statusText,
          error: errorDetails,
          errorDetails,
          retryAfter: retryAfter || undefined
        }
      }

      if (req.stream && response.body) {
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let accumulatedContent = ''
        const toolCallsMap = new Map<number, { id: string; name: string; arguments: string }>()

        let buffer = ''
        try {
          while (true) {
            if (controller.signal.aborted) break

            const { done, value } = await reader.read()
            if (done) break

            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop() || ''

            for (const line of lines) {
              if (controller.signal.aborted) break

              const trimmed = line.trim()
              if (!trimmed || !trimmed.startsWith('data:')) continue
              const payload = trimmed.slice(5).trim()
              if (payload === '[DONE]') continue

              try {
                const parsed = JSON.parse(payload)
                const choice = parsed.choices?.[0]
                if (!choice) continue

                const delta = choice.delta
                if (delta) {
                  if (delta.content) {
                    accumulatedContent += delta.content
                    onChunk?.(delta.content)
                  }

                  if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
                    for (const tc of delta.tool_calls) {
                      const idx = typeof tc.index === 'number' ? tc.index : toolCallsMap.size
                      const existing = toolCallsMap.get(idx) || { id: '', name: '', arguments: '' }
                      if (tc.id) existing.id = tc.id
                      if (tc.function?.name) existing.name += tc.function.name
                      if (tc.function?.arguments) existing.arguments += tc.function.arguments
                      toolCallsMap.set(idx, existing)
                    }
                  }
                }
              } catch {}
            }
          }
        } catch (streamErr: unknown) {
          try {
            await reader.cancel()
          } catch {}
          throw streamErr
        }

        if (controller.signal.aborted) {
          return {
            success: false,
            isNetworkError: false,
            error: 'Request was stopped by user.',
            errorDetails: 'Request was stopped by user.'
          }
        }

        const finalToolCalls = Array.from(toolCallsMap.values())
          .filter((tc) => tc.name)
          .map((tc) => ({
            id: tc.id || `call_${tc.name}_${Date.now()}`,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: tc.arguments
            }
          }))

        return {
          success: true,
          status: response.status,
          statusText: response.statusText,
          data: {
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: accumulatedContent || null,
                  tool_calls: finalToolCalls.length > 0 ? finalToolCalls : undefined
                }
              }
            ]
          }
        }
      }

      const data = (await response.json()) as any
      return {
        success: true,
        status: response.status,
        statusText: response.statusText,
        data
      }
    } catch (err: unknown) {
      clearTimeout(timer)
      if (signal) {
        signal.removeEventListener('abort', onSignalAbort)
      }

      const isUserCancel = (signal?.aborted || controller.signal.aborted) && !isTimedOut
      const isAbort =
        err instanceof Error &&
        (err.name === 'AbortError' || err.message.toLowerCase().includes('abort'))
      const rawMsg = isUserCancel
        ? 'Request was stopped by user.'
        : isAbort || isTimedOut
        ? `Request timed out after ${timeoutMs / 1000}s`
        : String(err)

      return {
        success: false,
        isNetworkError: !isUserCancel,
        error: rawMsg,
        errorDetails: rawMsg
      }
    }
  }
}
