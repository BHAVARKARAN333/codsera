import {
  FunctionDeclaration,
  IAIProvider,
  LLMMessage,
  LLMPart,
  LLMRequestOptions,
  LLMResponse
} from './types'

export class GeminiProvider implements IAIProvider {
  readonly id = 'gemini'
  readonly name = 'Google Gemini'

  private defaultModel = 'gemini-3.8-flash'
  private defaultTimeoutMs = 30000 // 30 seconds

  private isRetryableError(status: number, message: string): boolean {
    // Retryable HTTP status codes
    if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
      return true
    }

    // Temporary overload or network failure keywords
    const lower = message.toLowerCase()
    if (
      lower.includes('high demand') ||
      lower.includes('temporarily unavailable') ||
      lower.includes('resource_exhausted') ||
      lower.includes('overloaded') ||
      lower.includes('try again') ||
      lower.includes('rate limit') ||
      lower.includes('timed out') ||
      lower.includes('timeout')
    ) {
      return true
    }

    return false
  }

  private formatUserFriendlyError(status: number, rawMessage: string): string {
    if (
      status === 400 &&
      (rawMessage.toLowerCase().includes('api_key') ||
        rawMessage.toLowerCase().includes('key not valid'))
    ) {
      return 'Invalid Gemini API key. Please check your key in Settings.'
    }
    if (
      status === 401 ||
      status === 403 ||
      rawMessage.toLowerCase().includes('api key') ||
      rawMessage.toLowerCase().includes('unauthorized')
    ) {
      return 'Invalid Gemini API key. Please check your key in Settings.'
    }
    if (
      status === 404 ||
      rawMessage.toLowerCase().includes('not found') ||
      rawMessage.toLowerCase().includes('is not available')
    ) {
      return 'The selected AI model (gemini-3.8-flash) is currently unavailable.'
    }
    if (
      status === 429 ||
      rawMessage.toLowerCase().includes('resource_exhausted') ||
      rawMessage.toLowerCase().includes('rate limit')
    ) {
      return 'Gemini rate limit reached or model is under high demand. Please try again shortly.'
    }
    if (rawMessage.toLowerCase().includes('timed out') || rawMessage.toLowerCase().includes('abort')) {
      return 'Request timed out after 30s. The Gemini service may be experiencing high load.'
    }
    return (
      rawMessage.replace(/^Gemini API error:\s*/i, '').trim() ||
      'The AI provider is temporarily unavailable. Please try again.'
    )
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
      onRetry
    } = options

    if (!apiKey || apiKey.trim() === '') {
      throw new Error('Gemini API key is not configured. Please provide a valid API key.')
    }

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(
      apiKey.trim()
    )}`

    // Format messages for Gemini API, strictly adhering to Gemini's Part schema
    const formattedContents = messages.map((msg) => {
      const parts: Record<string, unknown>[] = []

      for (const part of msg.parts) {
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

      // Gemini maps 'function' role to 'user' in v1beta multi-turn chat format
      const role = msg.role === 'function' ? 'user' : msg.role
      return { role, parts }
    })

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

    const MAX_RETRIES = 2
    let lastError: Error | null = null

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)

      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal
        })
        clearTimeout(timer)

        if (!response.ok) {
          let errorDetails = `Status ${response.status} (${response.statusText})`
          try {
            const errorJson = await response.json()
            if (errorJson.error?.message) {
              errorDetails = errorJson.error.message
            }
          } catch {
            // Use status text if body isn't JSON
          }

          const isRetryable = this.isRetryableError(response.status, errorDetails)
          if (isRetryable && attempt < MAX_RETRIES) {
            const backoffMs = (attempt + 1) * 1000 // 1000ms for 1st retry, 2000ms for 2nd retry
            onRetry?.(attempt + 1, MAX_RETRIES, backoffMs, errorDetails)
            await new Promise((resolve) => setTimeout(resolve, backoffMs))
            continue
          }

          const friendlyError = this.formatUserFriendlyError(response.status, errorDetails)
          throw new Error(friendlyError)
        }

        const data = await response.json()
        const candidate = data.candidates?.[0]

        if (!candidate) {
          if (data.promptFeedback?.blockReason) {
            throw new Error(`Prompt was blocked: ${data.promptFeedback.blockReason}`)
          }
          return { text: 'No response generated by model.' }
        }

        const responseParts: LLMPart[] = candidate.content?.parts || []
        const functionCalls: { name: string; args: Record<string, unknown> }[] = []
        let combinedText = ''

        for (const part of responseParts) {
          if (part.functionCall) {
            functionCalls.push({
              name: part.functionCall.name,
              args: (part.functionCall.args as Record<string, unknown>) || {}
            })
          }
          if (part.text) {
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

        const isAbort =
          networkOrTimeoutError instanceof Error &&
          (networkOrTimeoutError.name === 'AbortError' ||
            networkOrTimeoutError.message.toLowerCase().includes('abort'))

        const rawMessage = isAbort
          ? `Request timed out after ${timeoutMs / 1000}s`
          : networkOrTimeoutError instanceof Error
          ? networkOrTimeoutError.message
          : String(networkOrTimeoutError)

        const isRetryable = isAbort || this.isRetryableError(0, rawMessage)
        if (isRetryable && attempt < MAX_RETRIES) {
          const backoffMs = (attempt + 1) * 1000 // 1000ms, 2000ms
          onRetry?.(attempt + 1, MAX_RETRIES, backoffMs, rawMessage)
          await new Promise((resolve) => setTimeout(resolve, backoffMs))
          continue
        }

        const friendlyMsg = this.formatUserFriendlyError(0, rawMessage)
        lastError = new Error(friendlyMsg)
        throw lastError
      }
    }

    throw lastError || new Error('The AI provider is temporarily unavailable. Please try again.')
  }
}
