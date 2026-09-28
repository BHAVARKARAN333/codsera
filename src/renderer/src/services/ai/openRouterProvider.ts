import {
  FunctionDeclaration,
  IAIProvider,
  LLMMessage,
  LLMPart,
  LLMRequestOptions,
  LLMResponse
} from './types'

export class OpenRouterProvider implements IAIProvider {
  readonly id = 'openrouter'
  readonly name = 'OpenRouter'

  // Default free router selecting an available free model
  private defaultModel = 'openrouter/free'
  private defaultTimeoutMs = 30000 // 30 seconds

  private isRetryableError(status: number, message: string): boolean {
    if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
      return true
    }

    const lower = message.toLowerCase()
    if (
      lower.includes('rate limit') ||
      lower.includes('too many requests') ||
      lower.includes('high demand') ||
      lower.includes('overloaded') ||
      lower.includes('service unavailable') ||
      lower.includes('temporarily unavailable') ||
      lower.includes('timeout') ||
      lower.includes('timed out') ||
      lower.includes('try again')
    ) {
      return true
    }

    return false
  }

  private formatUserFriendlyError(status: number, rawMessage: string): string {
    if (
      status === 401 ||
      status === 403 ||
      rawMessage.toLowerCase().includes('api key') ||
      rawMessage.toLowerCase().includes('unauthorized')
    ) {
      return 'Invalid OpenRouter API key. Please check your key in Settings.'
    }
    if (
      status === 404 ||
      rawMessage.toLowerCase().includes('model not found') ||
      rawMessage.toLowerCase().includes('no available model')
    ) {
      return 'The selected AI model (openrouter/free) is currently unavailable.'
    }
    if (status === 429 || rawMessage.toLowerCase().includes('rate limit')) {
      return 'OpenRouter free rate limit reached. Please try again in a moment.'
    }
    if (rawMessage.toLowerCase().includes('timed out') || rawMessage.toLowerCase().includes('abort')) {
      return 'Request timed out after 30s. The provider may be experiencing high demand.'
    }
    return (
      rawMessage.replace(/^OpenRouter API error:\s*/i, '').trim() ||
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
      throw new Error('OpenRouter API key is not configured. Please provide a valid API key.')
    }

    const endpoint = 'https://openrouter.ai/api/v1/chat/completions'

    // Format messages for OpenAI-compatible Chat Completions API
    const formattedMessages: Record<string, unknown>[] = []

    if (systemInstruction) {
      formattedMessages.push({
        role: 'system',
        content: systemInstruction
      })
    }

    // Keep track of tool_call IDs to align tool responses
    let lastToolCallId = 'call_list_files_1'

    for (const msg of messages) {
      if (msg.role === 'user') {
        const text = msg.parts.map((p) => p.text || '').join('\n')
        formattedMessages.push({
          role: 'user',
          content: text
        })
      } else if (msg.role === 'model') {
        const toolCalls: Record<string, unknown>[] = []
        let textContent = ''

        for (const part of msg.parts) {
          if (part.functionCall) {
            const toolCallId =
              (part['id'] as string) ||
              (part['tool_call_id'] as string) ||
              `call_${part.functionCall.name}_${formattedMessages.length}`
            part['id'] = toolCallId
            part['tool_call_id'] = toolCallId
            lastToolCallId = toolCallId

            toolCalls.push({
              id: toolCallId,
              type: 'function',
              function: {
                name: part.functionCall.name,
                arguments: JSON.stringify(part.functionCall.args || {})
              }
            })
          }
          if (part.text) {
            textContent += part.text
          }
        }

        const assistantMsg: Record<string, unknown> = {
          role: 'assistant',
          content: textContent || null
        }

        if (toolCalls.length > 0) {
          assistantMsg['tool_calls'] = toolCalls
        }

        formattedMessages.push(assistantMsg)
      } else if (msg.role === 'function') {
        for (const part of msg.parts) {
          if (part.functionResponse) {
            const content = part.functionResponse.response.content
            const contentStr =
              typeof content === 'string'
                ? content
                : JSON.stringify(content, null, 2)

            const toolCallId =
              (part['tool_call_id'] as string) ||
              (part['id'] as string) ||
              lastToolCallId

            formattedMessages.push({
              role: 'tool',
              tool_call_id: toolCallId,
              name: part.functionResponse.name,
              content: contentStr
            })
          }
        }
      }
    }

    const requestBody: Record<string, unknown> = {
      model: modelName,
      messages: formattedMessages,
      temperature
    }

    if (tools && tools.length > 0) {
      requestBody['tools'] = tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters
        }
      }))
      requestBody['tool_choice'] = 'auto'
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
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey.trim()}`,
            'HTTP-Referer': 'https://ai-ide.local',
            'X-Title': 'AI IDE'
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
            // Non-JSON response
          }

          const isRetryable = this.isRetryableError(response.status, errorDetails)
          if (isRetryable && attempt < MAX_RETRIES) {
            const backoffMs = (attempt + 1) * 1000
            onRetry?.(attempt + 1, MAX_RETRIES, backoffMs, errorDetails)
            await new Promise((resolve) => setTimeout(resolve, backoffMs))
            continue
          }

          const friendlyError = this.formatUserFriendlyError(response.status, errorDetails)
          throw new Error(friendlyError)
        }

        const data = await response.json()
        const choice = data.choices?.[0]

        if (!choice || !choice.message) {
          return { text: 'No response returned from OpenRouter.' }
        }

        const choiceMsg = choice.message
        const functionCalls: { name: string; args: Record<string, unknown> }[] = []
        const rawModelParts: LLMPart[] = []

        if (choiceMsg.tool_calls && Array.isArray(choiceMsg.tool_calls)) {
          for (const call of choiceMsg.tool_calls) {
            let parsedArgs: Record<string, unknown> = {}
            try {
              parsedArgs =
                typeof call.function.arguments === 'string'
                  ? JSON.parse(call.function.arguments)
                  : call.function.arguments || {}
            } catch {
              parsedArgs = {}
            }

            functionCalls.push({
              name: call.function.name,
              args: parsedArgs
            })

            rawModelParts.push({
              functionCall: {
                name: call.function.name,
                args: parsedArgs
              },
              id: call.id,
              tool_call_id: call.id
            })
          }
        }

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
          const backoffMs = (attempt + 1) * 1000
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
