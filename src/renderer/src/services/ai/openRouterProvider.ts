import {
  FunctionDeclaration,
  IAIProvider,
  LLMMessage,
  LLMRequestOptions,
  LLMResponse,
  ProviderCapabilities
} from './types'
import {
  calculateRetryDelay,
  classifyProviderError,
  parseOpenAIToolCalls,
  serializeOpenAIMessages,
  serializeOpenAITools
} from './providerUtils'

export interface OpenRouterProviderConfig {
  defaultModel?: string
  defaultTimeoutMs?: number
  fetchImpl?: typeof fetch
}

export class OpenRouterProvider implements IAIProvider {
  readonly id = 'openrouter'
  readonly name = 'OpenRouter'
  readonly capabilities: ProviderCapabilities = {
    supportsStreaming: true,
    supportsTools: true,
    requiresApiKey: true,
    supportsModelListing: false
  }

  // Default free router selecting an available free model
  private defaultModel = 'openrouter/free'
  private defaultTimeoutMs = 30000 // 30 seconds
  private fetchImpl?: typeof fetch

  constructor(config?: OpenRouterProviderConfig) {
    if (config?.defaultModel) this.defaultModel = config.defaultModel
    if (config?.defaultTimeoutMs) this.defaultTimeoutMs = config.defaultTimeoutMs
    if (config?.fetchImpl) this.fetchImpl = config.fetchImpl
  }

  isRetryableError(status: number, message: string): boolean {
    return classifyProviderError(new Error(message), {
      status,
      providerName: this.name
    }).isRetryable
  }

  formatUserFriendlyError(status: number, rawMessage: string): string {
    return classifyProviderError(new Error(rawMessage), {
      status,
      providerName: this.name,
      modelName: this.defaultModel
    }).userFriendlyMessage
  }

  /**
   * Cancellable delay that aborts immediately if the signal fires during the sleep.
   */
  private async cancellableSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new Error('Request was stopped by user.')
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        resolve()
      }, delayMs)

      const onAbort = () => {
        cleanup()
        reject(new Error('Request was stopped by user.'))
      }

      const cleanup = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }

      signal?.addEventListener('abort', onAbort, { once: true })
    })
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
      onChunk,
      onRetry
    } = options

    if (signal?.aborted) {
      throw new Error('Request was stopped by user.')
    }

    if (!apiKey || apiKey.trim() === '') {
      throw new Error('OpenRouter API key is not configured. Please provide a valid API key.')
    }

    const endpoint = 'https://openrouter.ai/api/v1/chat/completions'

    // Format messages and tools using robust shared OpenAI-compatible serializer
    const formattedMessages = serializeOpenAIMessages(messages, systemInstruction)
    const formattedTools = serializeOpenAITools(tools)

    const isStreaming = typeof onChunk === 'function'

    const requestBody: Record<string, unknown> = {
      model: modelName,
      messages: formattedMessages,
      temperature
    }

    if (isStreaming) {
      requestBody['stream'] = true
    }

    if (formattedTools && formattedTools.length > 0) {
      requestBody['tools'] = formattedTools
      requestBody['tool_choice'] = 'auto'
    }

    const MAX_RETRIES = 2
    let lastError: Error | null = null

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (signal?.aborted) {
        throw new Error('Request was stopped by user.')
      }

      const controller = new AbortController()
      let timeoutFired = false
      const timer = setTimeout(() => {
        timeoutFired = true
        controller.abort()
      }, timeoutMs)

      const onUserAbort = () => {
        controller.abort()
      }

      if (signal) {
        signal.addEventListener('abort', onUserAbort, { once: true })
      }

      const fetchFunc = this.fetchImpl || fetch

      try {
        const response = await fetchFunc(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey.trim()}`,
            'HTTP-Referer': 'https://ai-ide.local',
            'X-Title': 'AI IDE',
            ...(isStreaming ? { Accept: 'text/event-stream' } : {})
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal
        })

        clearTimeout(timer)
        if (signal) {
          signal.removeEventListener('abort', onUserAbort)
        }

        if (signal?.aborted) {
          throw new Error('Request was stopped by user.')
        }

        if (!response.ok) {
          let errorDetails = `Status ${response.status} (${response.statusText})`
          try {
            const errorJson = await response.json()
            if (errorJson.error?.message) {
              errorDetails = errorJson.error.message
            } else if (typeof errorJson.error === 'string') {
              errorDetails = errorJson.error
            }
          } catch {
            // Non-JSON response
          }

          const retryAfterHeader = response.headers ? response.headers.get('retry-after') : null
          const classification = classifyProviderError(new Error(errorDetails), {
            status: response.status,
            retryAfterHeader,
            providerName: this.name,
            modelName,
            signal
          })

          if (classification.isUserCancellation || signal?.aborted) {
            throw new Error('Request was stopped by user.')
          }

          if (classification.isRetryable && attempt < MAX_RETRIES) {
            const delayMs = calculateRetryDelay(attempt, retryAfterHeader, {
              baseDelayMs: 1000,
              minDelayMs: 500,
              maxDelayMs: 30000
            })
            onRetry?.(attempt + 1, MAX_RETRIES, delayMs, errorDetails)
            await this.cancellableSleep(delayMs, signal)
            continue
          }

          throw new Error(classification.userFriendlyMessage)
        }

        // Handle SSE streaming response
        if (isStreaming && response.body) {
          const reader = response.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          let combinedText = ''
          const toolCallsMap = new Map<number, { id: string; name: string; arguments: string }>()

          const onStreamAbort = () => {
            try {
              reader.cancel().catch(() => {})
            } catch {}
          }
          if (signal) {
            signal.addEventListener('abort', onStreamAbort, { once: true })
          }

          try {
            while (true) {
              if (signal?.aborted) {
                throw new Error('Request was stopped by user.')
              }

              const { done, value } = await reader.read()
              if (done) {
                if (signal?.aborted) {
                  throw new Error('Request was stopped by user.')
                }
                break
              }

              buffer += decoder.decode(value, { stream: true })
              const lines = buffer.split('\n')
              buffer = lines.pop() || ''

              for (const line of lines) {
                const trimmed = line.trim()
                if (!trimmed || !trimmed.startsWith('data:')) continue
                const payload = trimmed.slice(5).trim()
                if (payload === '[DONE]') continue

                try {
                  const parsed = JSON.parse(payload)
                  if (parsed.error) {
                    const errMsg =
                      typeof parsed.error === 'string'
                        ? parsed.error
                        : parsed.error.message || JSON.stringify(parsed.error)
                    throw new Error(errMsg)
                  }

                  const choice = parsed.choices?.[0]
                  if (!choice) continue

                  const delta = choice.delta
                  if (delta) {
                    if (typeof delta.content === 'string') {
                      combinedText += delta.content
                      onChunk(delta.content)
                    }

                    if (Array.isArray(delta.tool_calls)) {
                      for (const tc of delta.tool_calls) {
                        const idx = typeof tc.index === 'number' ? tc.index : toolCallsMap.size
                        const existing = toolCallsMap.get(idx) || { id: '', name: '', arguments: '' }
                        if (typeof tc.id === 'string' && tc.id.trim()) existing.id = tc.id.trim()
                        if (tc.function?.name) existing.name += tc.function.name
                        if (tc.function?.arguments) existing.arguments += tc.function.arguments
                        toolCallsMap.set(idx, existing)
                      }
                    }
                  }
                } catch (parseErr: unknown) {
                  if (
                    parseErr instanceof Error &&
                    parseErr.message &&
                    !parseErr.message.includes('JSON')
                  ) {
                    throw parseErr
                  }
                  // Ignore partial or non-JSON chunk lines
                }
              }
            }

            // Flush trailing buffer line if present
            if (buffer.trim().startsWith('data:')) {
              const payload = buffer.trim().slice(5).trim()
              if (payload && payload !== '[DONE]') {
                try {
                  const parsed = JSON.parse(payload)
                  const choice = parsed.choices?.[0]
                  if (choice?.delta) {
                    if (typeof choice.delta.content === 'string') {
                      combinedText += choice.delta.content
                      onChunk(choice.delta.content)
                    }
                    if (Array.isArray(choice.delta.tool_calls)) {
                      for (const tc of choice.delta.tool_calls) {
                        const idx = typeof tc.index === 'number' ? tc.index : toolCallsMap.size
                        const existing = toolCallsMap.get(idx) || { id: '', name: '', arguments: '' }
                        if (typeof tc.id === 'string' && tc.id.trim()) existing.id = tc.id.trim()
                        if (tc.function?.name) existing.name += tc.function.name
                        if (tc.function?.arguments) existing.arguments += tc.function.arguments
                        toolCallsMap.set(idx, existing)
                      }
                    }
                  }
                } catch {}
              }
            }

            const rawToolCalls = Array.from(toolCallsMap.values())
              .filter((tc) => tc.name)
              .map((tc) => ({
                id: tc.id || `call_${tc.name}_${Date.now()}`,
                type: 'function' as const,
                function: {
                  name: tc.name,
                  arguments: tc.arguments
                }
              }))

            const { functionCalls, rawModelParts } = parseOpenAIToolCalls(rawToolCalls)

            if (combinedText) {
              rawModelParts.push({ text: combinedText })
            }

            return {
              text: combinedText || undefined,
              functionCalls: functionCalls.length > 0 ? functionCalls : undefined,
              rawModelParts
            }
          } catch (streamErr: unknown) {
            try {
              await reader.cancel()
            } catch {}
            throw streamErr
          } finally {
            if (signal) {
              signal.removeEventListener('abort', onStreamAbort)
            }
          }
        }

        // Standard non-streaming JSON response handling
        const data = await response.json()
        const choice = data.choices?.[0]

        if (!choice || !choice.message) {
          if (data.error?.message) {
            throw new Error(data.error.message)
          }
          return { text: 'No response returned from OpenRouter.' }
        }

        const choiceMsg = choice.message
        const { functionCalls, rawModelParts } = parseOpenAIToolCalls(choiceMsg.tool_calls)

        if (choiceMsg.content) {
          rawModelParts.push({
            text: choiceMsg.content
          })
        }

        return {
          text: choiceMsg.content || undefined,
          functionCalls: functionCalls.length > 0 ? functionCalls : undefined,
          rawModelParts
        }
      } catch (networkOrTimeoutError: unknown) {
        clearTimeout(timer)
        if (signal) {
          signal.removeEventListener('abort', onUserAbort)
        }

        if (signal?.aborted) {
          throw new Error('Request was stopped by user.')
        }

        const classification = classifyProviderError(networkOrTimeoutError, {
          signal,
          isTimeout: timeoutFired,
          providerName: this.name,
          modelName
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
          await this.cancellableSleep(delayMs, signal)
          continue
        }

        lastError = new Error(classification.userFriendlyMessage)
        throw lastError
      }
    }

    throw lastError || new Error('The AI provider is temporarily unavailable. Please try again.')
  }
}
