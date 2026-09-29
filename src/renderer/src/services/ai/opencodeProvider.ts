import {
  FunctionDeclaration,
  IAIProvider,
  LLMMessage,
  LLMPart,
  LLMRequestOptions,
  LLMResponse
} from './types'
import {
  OpenCodeChatCompletionRequest,
  OpenCodeChatCompletionResponse,
  OpenCodeListModelsRequest,
  OpenCodeListModelsResponse,
  OpenCodeModelItem,
  OpenCodeStreamChunkEvent
} from '../../../../shared/types'

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

  private formatUserFriendlyError(
    status: number,
    rawMessage: string,
    modelName: string
  ): string {
    const lower = rawMessage.toLowerCase()

    if (lower.includes('freetiererror') || lower.includes('from within opencode')) {
      return `The model "${modelName}" is restricted to official OpenCode client requests. Please switch to "space-bunny-free" or add a Console API key in Settings.`
    }
    if (
      status === 401 ||
      status === 403 ||
      lower.includes('unauthorized') ||
      lower.includes('invalid token')
    ) {
      return 'Invalid OpenCode Console API key. Please check your credentials in Settings, or clear the key to use free access.'
    }
    if (status === 404 || lower.includes('model not found') || lower.includes('unavailable')) {
      return `The selected OpenCode model "${modelName}" is currently unavailable. Please fetch models in Settings to select an active free model.`
    }
    if (status === 429 || lower.includes('rate limit')) {
      return 'OpenCode free inference rate limit reached. Please wait a moment and try again.'
    }
    if (lower.includes('timed out') || lower.includes('abort')) {
      return `Request timed out after ${this.defaultTimeoutMs / 1000}s. The provider may be experiencing high demand.`
    }

    return (
      rawMessage.replace(/^OpenCode API error:\s*/i, '').trim() ||
      'The OpenCode AI provider is temporarily unavailable. Please try again.'
    )
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
      onRetry
    } = options

    const activeModel = modelName.trim() || this.defaultModel
    this.logDiagnostic('start', { model: activeModel, hasKey: !!apiKey?.trim() })

    // Format messages for OpenAI-compatible Chat Completions API
    const formattedMessages: Array<{
      role: string
      content: string | null
      tool_calls?: Array<{
        id: string
        type: 'function'
        function: {
          name: string
          arguments: string
        }
      }>
      tool_call_id?: string
      name?: string
    }> = []

    if (systemInstruction) {
      formattedMessages.push({
        role: 'system',
        content: systemInstruction
      })
    }

    let lastToolCallId = 'call_list_files_1'

    for (const msg of messages) {
      if (msg.role === 'user') {
        const text = msg.parts.map((p) => p.text || '').join('\n')
        formattedMessages.push({
          role: 'user',
          content: text
        })
      } else if (msg.role === 'model') {
        const toolCalls: Array<{
          id: string
          type: 'function'
          function: {
            name: string
            arguments: string
          }
        }> = []
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

        const assistantMsg: {
          role: string
          content: string | null
          tool_calls?: typeof toolCalls
        } = {
          role: 'assistant',
          content: textContent || null
        }

        if (toolCalls.length > 0) {
          assistantMsg.tool_calls = toolCalls
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

    const requestPayload: OpenCodeChatCompletionRequest = {
      model: activeModel,
      messages: formattedMessages,
      temperature,
      timeoutMs,
      apiKey: apiKey?.trim() || undefined
    }

    if (tools && tools.length > 0) {
      requestPayload.tools = tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters
        }
      }))
      requestPayload.tool_choice = 'auto'
    }

    // Support streaming if onChunk callback provided in options
    const onChunkCallback = options.onChunk
    const isStreaming = typeof onChunkCallback === 'function'

    if (isStreaming) {
      requestPayload.stream = true
      requestPayload.requestId = `opencode_req_${Math.random().toString(36).slice(2)}_${Date.now()}`
    }

    const MAX_RETRIES = 2
    let lastError: Error | null = null

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      let cleanupStreamListener: (() => void) | null = null

      try {
        let response: OpenCodeChatCompletionResponse

        // Listen for streaming chunks if streaming is active
        if (isStreaming && requestPayload.requestId) {
          const streamListener =
            this.streamListener ||
            (typeof window !== 'undefined' && window.electronAPI?.onOpenCodeStreamChunk
              ? window.electronAPI.onOpenCodeStreamChunk
              : null)

          if (streamListener) {
            cleanupStreamListener = streamListener((event) => {
              if (event.requestId === requestPayload.requestId && event.chunk) {
                onChunkCallback(event.chunk)
              }
            })
          }
        }

        // 1. Electron IPC dispatch (avoids Chromium CORS restrictions)
        if (this.ipcCaller) {
          this.logDiagnostic('sending_custom_ipc', { attempt, model: activeModel, stream: isStreaming })
          response = await this.ipcCaller(requestPayload)
        } else if (typeof window !== 'undefined' && window.electronAPI?.opencodeChatCompletion) {
          this.logDiagnostic('sending_electron_ipc', { attempt, model: activeModel, stream: isStreaming })
          response = await window.electronAPI.opencodeChatCompletion(requestPayload)
        } else {
          // 2. Direct Node / test harness fallback (direct fetch to OpenAI-compatible endpoint)
          this.logDiagnostic('sending_direct_fetch', { attempt, model: activeModel, stream: isStreaming })
          response = await this.sendDirectFetch(requestPayload, onChunkCallback)
        }

        if (!response.success) {
          const status = response.status || 0
          const rawMsg = response.errorDetails || response.error || 'Unknown error'
          const isRetryable = this.isRetryableError(status, rawMsg)

          if (isRetryable && attempt < MAX_RETRIES) {
            const backoffMs = (attempt + 1) * 1000
            this.logDiagnostic('retrying', { attempt: attempt + 1, backoffMs, status })
            onRetry?.(attempt + 1, MAX_RETRIES, backoffMs, rawMsg)
            await new Promise((resolve) => setTimeout(resolve, backoffMs))
            continue
          }

          const friendlyError = this.formatUserFriendlyError(status, rawMsg, activeModel)
          this.logDiagnostic('failed_final', { status, error: friendlyError })
          throw new Error(friendlyError)
        }

        const choice = response.data?.choices?.[0]
        if (!choice || !choice.message) {
          return { text: 'No response returned from OpenCode.' }
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
      } catch (err: unknown) {
        const isAbort =
          err instanceof Error &&
          (err.name === 'AbortError' || err.message.toLowerCase().includes('abort'))
        const rawMsg = isAbort ? `Request timed out after ${timeoutMs / 1000}s` : String(err)
        const isRetryable = isAbort || this.isRetryableError(0, rawMsg)

        if (isRetryable && attempt < MAX_RETRIES) {
          const backoffMs = (attempt + 1) * 1000
          onRetry?.(attempt + 1, MAX_RETRIES, backoffMs, rawMsg)
          await new Promise((resolve) => setTimeout(resolve, backoffMs))
          continue
        }

        const friendlyMsg = this.formatUserFriendlyError(0, rawMsg, activeModel)
        lastError = new Error(friendlyMsg)
        throw lastError
      } finally {
        if (cleanupStreamListener) {
          cleanupStreamListener()
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
    onChunk?: (chunk: string) => void
  ): Promise<OpenCodeChatCompletionResponse> {
    const fetchFunc = this.fetchImpl || fetch
    const timeoutMs = req.timeoutMs || this.defaultTimeoutMs
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

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

        return {
          success: false,
          status: response.status,
          statusText: response.statusText,
          error: errorDetails,
          errorDetails
        }
      }

      if (req.stream && response.body) {
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let accumulatedContent = ''
        const toolCallsMap = new Map<number, { id: string; name: string; arguments: string }>()

        let buffer = ''
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

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
                    if (tc.function?.name) existing.name = tc.function.name
                    if (tc.function?.arguments) existing.arguments += tc.function.arguments
                    toolCallsMap.set(idx, existing)
                  }
                }
              }
            } catch {}
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
      const isAbort =
        err instanceof Error &&
        (err.name === 'AbortError' || err.message.toLowerCase().includes('abort'))
      const rawMsg = isAbort ? `Request timed out after ${timeoutMs / 1000}s` : String(err)
      return {
        success: false,
        isNetworkError: true,
        error: rawMsg,
        errorDetails: rawMsg
      }
    }
  }
}
