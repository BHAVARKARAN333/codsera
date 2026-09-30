import {
  FunctionCallPart,
  FunctionDeclaration,
  IAIProvider,
  LLMMessage,
  LLMPart,
  LLMRequestOptions,
  LLMResponse,
  ProviderCapabilities
} from './types'
import {
  calculateRetryDelay,
  classifyProviderError
} from './providerUtils'

export interface GeminiProviderConfig {
  defaultModel?: string
  defaultTimeoutMs?: number
  fetchImpl?: typeof fetch
}

/**
 * Formats LLMMessage array into Gemini's distinct contents schema.
 * Merges consecutive turns of the same role (e.g. multiple tool responses)
 * into a single turn to strictly uphold Gemini's alternating user/model contract.
 */
export function formatGeminiContents(
  messages: LLMMessage[]
): Array<{ role: 'user' | 'model'; parts: Record<string, unknown>[] }> {
  const formattedContents: Array<{ role: 'user' | 'model'; parts: Record<string, unknown>[] }> = []

  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue
    const parts: Record<string, unknown>[] = []

    if (Array.isArray(msg.parts)) {
      for (const part of msg.parts) {
        if (!part || typeof part !== 'object') continue
        const raw = part as Record<string, unknown>

        if (part.functionResponse) {
          // Format functionResponse part cleanly without any OpenAI metadata
          parts.push({
            functionResponse: {
              name: part.functionResponse.name,
              response: part.functionResponse.response
            }
          })
        } else if (part.functionCall) {
          // Format functionCall part, preserving thoughtSignature/thought if present
          const fcPart: Record<string, unknown> = {
            functionCall: {
              name: part.functionCall.name,
              args: part.functionCall.args || {}
            }
          }
          if (raw.thoughtSignature !== undefined) {
            fcPart.thoughtSignature = raw.thoughtSignature
          }
          if (raw.thought !== undefined) {
            fcPart.thought = raw.thought
          }
          parts.push(fcPart)
        } else if (part.text !== undefined) {
          const textPart: Record<string, unknown> = {
            text: part.text
          }
          if (raw.thoughtSignature !== undefined) {
            textPart.thoughtSignature = raw.thoughtSignature
          }
          if (raw.thought !== undefined) {
            textPart.thought = raw.thought
          }
          parts.push(textPart)
        } else {
          // Fallback: exclude OpenAI-specific fields (id, tool_call_id, etc.)
          const cleanPart: Record<string, unknown> = {}
          for (const [key, val] of Object.entries(raw)) {
            if (key !== 'id' && key !== 'tool_call_id' && key !== 'type' && key !== 'role') {
              cleanPart[key] = val
            }
          }
          if (Object.keys(cleanPart).length > 0) {
            parts.push(cleanPart)
          }
        }
      }
    }

    if (parts.length === 0) continue

    // Gemini v1beta multi-turn format requires 'user' or 'model' roles
    const role: 'user' | 'model' = msg.role === 'function' || msg.role === 'user' ? 'user' : 'model'

    // Strictly enforce alternating turns: merge consecutive parts into existing turn
    if (formattedContents.length > 0 && formattedContents[formattedContents.length - 1].role === role) {
      formattedContents[formattedContents.length - 1].parts.push(...parts)
    } else {
      formattedContents.push({ role, parts })
    }
  }

  return formattedContents
}

export class GeminiProvider implements IAIProvider {
  readonly id = 'gemini'
  readonly name = 'Google Gemini'
  readonly capabilities: ProviderCapabilities = {
    supportsStreaming: true,
    supportsTools: true,
    requiresApiKey: true,
    supportsModelListing: false
  }

  private defaultModel = 'gemini-3.8-flash'
  private defaultTimeoutMs = 30000 // 30 seconds
  private fetchImpl?: typeof fetch

  constructor(config?: GeminiProviderConfig) {
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

    // Check cancellation before initiating work
    if (signal?.aborted) {
      throw new Error('Request was stopped by user.')
    }

    if (!apiKey || apiKey.trim() === '') {
      throw new Error('Gemini API key is not configured. Please provide a valid API key.')
    }

    const formattedContents = formatGeminiContents(messages)

    const requestBody: Record<string, unknown> = {
      contents: formattedContents,
      generationConfig: {
        temperature
      }
    }

    if (systemInstruction) {
      requestBody['systemInstruction'] = {
        parts: [{ text: systemInstruction }]
      }
    }

    if (tools && tools.length > 0) {
      requestBody['tools'] = [
        {
          functionDeclarations: tools
        }
      ]
    }

    const isStreaming = typeof onChunk === 'function'
    const endpointAction = isStreaming ? 'streamGenerateContent?alt=sse&' : 'generateContent?'
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      modelName
    )}:${endpointAction}key=${encodeURIComponent(apiKey.trim())}`

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
            'Content-Type': 'application/json'
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
            }
          } catch {
            // Body was not JSON
          }

          const retryAfterHeader = response.headers ? response.headers.get('retry-after') : null
          const classification = classifyProviderError(new Error(errorDetails), {
            status: response.status,
            retryAfterHeader,
            providerName: this.name,
            modelName,
            signal
          })

          // User cancellations must NEVER be retried
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
          const functionCalls: FunctionCallPart[] = []
          const responseParts: LLMPart[] = []

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
                  const chunkData = JSON.parse(payload)
                  const candidate = chunkData.candidates?.[0]
                  if (!candidate) continue

                  const parts: LLMPart[] = candidate.content?.parts || []
                  for (const part of parts) {
                    responseParts.push(part)

                    if (part.functionCall && typeof part.functionCall.name === 'string') {
                      functionCalls.push({
                        name: part.functionCall.name,
                        args: (part.functionCall.args as Record<string, unknown>) || {}
                      })
                    }

                    // Strict thought isolation: never deliver internal thinking to onChunk or user-visible text
                    const isThought = Boolean((part as Record<string, unknown>).thought)
                    if (typeof part.text === 'string' && !isThought) {
                      combinedText += part.text
                      onChunk(part.text)
                    }
                  }
                } catch {
                  // Ignore partial or non-JSON chunk lines
                }
              }
            }

            // Flush trailing line in buffer if present
            if (buffer.trim().startsWith('data:')) {
              try {
                const payload = buffer.trim().slice(5).trim()
                if (payload && payload !== '[DONE]') {
                  const chunkData = JSON.parse(payload)
                  const candidate = chunkData.candidates?.[0]
                  if (candidate?.content?.parts) {
                    for (const part of candidate.content.parts) {
                      responseParts.push(part)
                      if (part.functionCall && typeof part.functionCall.name === 'string') {
                        functionCalls.push({
                          name: part.functionCall.name,
                          args: (part.functionCall.args as Record<string, unknown>) || {}
                        })
                      }
                      const isThought = Boolean((part as Record<string, unknown>).thought)
                      if (typeof part.text === 'string' && !isThought) {
                        combinedText += part.text
                        onChunk(part.text)
                      }
                    }
                  }
                }
              } catch {}
            }

            return {
              text: combinedText || undefined,
              functionCalls: functionCalls.length > 0 ? functionCalls : undefined,
              rawModelParts: responseParts
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
        const candidate = data.candidates?.[0]

        if (!candidate) {
          if (data.promptFeedback?.blockReason) {
            throw new Error(`Prompt was blocked: ${data.promptFeedback.blockReason}`)
          }
          return { text: 'No response generated by model.' }
        }

        const responseParts: LLMPart[] = candidate.content?.parts || []
        const functionCalls: FunctionCallPart[] = []
        let combinedText = ''

        for (const part of responseParts) {
          if (part.functionCall && typeof part.functionCall.name === 'string') {
            functionCalls.push({
              name: part.functionCall.name,
              args: (part.functionCall.args as Record<string, unknown>) || {}
            })
          }

          // Strict thought isolation: exclude internal reasoning parts from visible response text
          const isThought = Boolean((part as Record<string, unknown>).thought)
          if (typeof part.text === 'string' && !isThought) {
            combinedText += part.text
          }
        }

        return {
          text: combinedText || undefined,
          functionCalls: functionCalls.length > 0 ? functionCalls : undefined,
          rawModelParts: responseParts
        }
      } catch (networkOrTimeoutError: unknown) {
        clearTimeout(timer)
        if (signal) {
          signal.removeEventListener('abort', onUserAbort)
        }

        // User cancellation must immediately bubble without retrying
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
