import {
  FunctionDeclaration,
  IAIProvider,
  LLMMessage,
  LLMPart,
  LLMRequestOptions,
  LLMResponse
} from './types'
import { NvidiaChatCompletionRequest, NvidiaChatCompletionResponse } from '../../../../shared/types'

export interface NvidiaProviderConfig {
  defaultModel?: string
  defaultTimeoutMs?: number
  debug?: boolean
  fetchImpl?: typeof fetch
  ipcCaller?: (req: NvidiaChatCompletionRequest) => Promise<NvidiaChatCompletionResponse>
}

export class NvidiaProvider implements IAIProvider {
  readonly id = 'nvidia'
  readonly name = 'NVIDIA NIM'

  private defaultModel?: string
  private defaultTimeoutMs = 30000 // 30 seconds
  private debug = false
  private fetchImpl?: typeof fetch
  private ipcCaller?: (req: NvidiaChatCompletionRequest) => Promise<NvidiaChatCompletionResponse>

  constructor(config?: NvidiaProviderConfig) {
    if (config?.defaultModel) this.defaultModel = config.defaultModel
    if (config?.defaultTimeoutMs) this.defaultTimeoutMs = config.defaultTimeoutMs
    if (config?.debug !== undefined) this.debug = config.debug
    if (config?.fetchImpl) this.fetchImpl = config.fetchImpl
    if (config?.ipcCaller) this.ipcCaller = config.ipcCaller
  }

  setDebug(enabled: boolean): void {
    this.debug = enabled
  }

  private logDiagnostic(stage: string, details?: Record<string, unknown>): void {
    if (this.debug) {
      const detailsStr = details ? ` | ${JSON.stringify(details)}` : ''
      console.debug(`[NvidiaProvider] Stage: ${stage}${detailsStr}`)
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

  private isToolCallingUnsupportedError(status: number, message: string): boolean {
    const lower = message.toLowerCase()
    return (
      (status === 400 || status === 422) &&
      (lower.includes('tools') ||
        lower.includes('function') ||
        lower.includes('tool_choice') ||
        lower.includes('not supported') ||
        lower.includes('unrecognized field') ||
        lower.includes('extra fields not permitted') ||
        lower.includes('function calling'))
    )
  }

  private formatUserFriendlyError(
    status: number,
    rawMessage: string,
    modelName: string,
    failedBeforeResponse = false
  ): string {
    if (
      rawMessage.includes('Electron IPC handler for NVIDIA NIM is not available') ||
      rawMessage.includes('nvidiaChatCompletion is undefined')
    ) {
      return 'Electron IPC handler for NVIDIA NIM is not available. Please restart the application.'
    }
    if (rawMessage.includes('API key is not configured') || rawMessage.includes('Please provide a valid API key in Settings')) {
      return rawMessage
    }
    if (rawMessage.includes('No NVIDIA NIM model')) {
      return rawMessage
    }
    if (
      status === 401 ||
      status === 403 ||
      rawMessage.toLowerCase().includes('api key') ||
      rawMessage.toLowerCase().includes('unauthorized') ||
      rawMessage.toLowerCase().includes('forbidden')
    ) {
      return 'Invalid NVIDIA API key. Please check your key in Settings.'
    }
    const lower = rawMessage.toLowerCase()
    const isExplicitEol =
      lower.includes('end of life') ||
      lower.includes('end-of-life') ||
      lower.includes('retired') ||
      lower.includes('deprecated') ||
      lower.includes('decommissioned') ||
      lower.includes('no longer available') ||
      lower.includes('model is disabled')

    if (isExplicitEol) {
      return `The selected NVIDIA model ('${modelName}') has reached end of life. Please fetch and select an available model from the NVIDIA NIM catalog in Settings.`
    }

    if (
      status === 404 ||
      status === 410 ||
      lower.includes('model not found') ||
      lower.includes('does not exist') ||
      lower.includes('unknown model')
    ) {
      return `The selected NVIDIA model ('${modelName}') was not found in NVIDIA NIM. Please fetch and select an active model in Settings.`
    }

    if (this.isToolCallingUnsupportedError(status, rawMessage)) {
      return `The selected NVIDIA model ('${modelName}') does not support tool calling or rejected the tools parameter. Please choose a tool-compatible model or use conversational mode.`
    }
    if (status === 429 || rawMessage.toLowerCase().includes('rate limit')) {
      return 'NVIDIA NIM rate limit reached. Please try again in a moment.'
    }
    if (
      rawMessage.toLowerCase().includes('timed out') ||
      rawMessage.toLowerCase().includes('abort') ||
      rawMessage.toLowerCase().includes('timeout')
    ) {
      return 'Request timed out after 30s. The NVIDIA API service may be experiencing high latency.'
    }
    if (failedBeforeResponse || rawMessage.toLowerCase().includes('fetch') || rawMessage.toLowerCase().includes('econnrefused')) {
      return `Failed to connect to NVIDIA NIM (${rawMessage.replace(/^Error:\s*/i, '')}). Please verify your network connection and proxy settings.`
    }
    return (
      rawMessage.replace(/^NVIDIA NIM API error:\s*/i, '').trim() ||
      'The NVIDIA AI provider is temporarily unavailable. Please try again.'
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
      this.logDiagnostic('validation_failed', { reason: 'missing_api_key' })
      throw new Error('NVIDIA NIM API key is not configured. Please provide a valid API key in Settings.')
    }

    const activeModel = modelName ? modelName.trim() : ''
    if (!activeModel) {
      this.logDiagnostic('validation_failed', { reason: 'missing_model' })
      throw new Error('No NVIDIA NIM model configured. Please open Settings, fetch available models, and select one.')
    }

    this.logDiagnostic('preparing_request', {
      model: modelName,
      messageCount: messages.length,
      toolCount: tools?.length || 0
    })

    // Format messages for OpenAI-compatible Chat Completions API
    const formattedMessages: Array<{
      role: string
      content: string | null
      tool_calls?: Array<{
        id: string
        type: 'function'
        function: { name: string; arguments: string }
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

    let lastToolCallId = 'call_tool_1'

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
          function: { name: string; arguments: string }
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
          tool_calls?: Array<{
            id: string
            type: 'function'
            function: { name: string; arguments: string }
          }>
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

            formattedMessages.push({
              role: 'tool',
              tool_call_id: (part['tool_call_id'] as string) || lastToolCallId,
              name: part.functionResponse.name,
              content: contentStr
            })
          }
        }
      }
    }

    const ipcRequest: NvidiaChatCompletionRequest = {
      model: activeModel,
      messages: formattedMessages,
      temperature,
      apiKey: apiKey.trim(),
      timeoutMs
    }

    if (tools && tools.length > 0) {
      ipcRequest.tools = tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters
        }
      }))
      ipcRequest.tool_choice = 'auto'
    }

    const MAX_RETRIES = 2
    let lastError: Error | null = null

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        let ipcResponse: NvidiaChatCompletionResponse

        // Check if running in Electron environment with window.electronAPI.nvidiaChatCompletion or injected ipcCaller
        if (this.ipcCaller) {
          this.logDiagnostic('sending_custom_ipc', { attempt, model: modelName })
          ipcResponse = await this.ipcCaller(ipcRequest)
        } else if (typeof window !== 'undefined' && window.electronAPI?.nvidiaChatCompletion) {
          this.logDiagnostic('sending_electron_ipc', { attempt, model: modelName })
          ipcResponse = await window.electronAPI.nvidiaChatCompletion(ipcRequest)
        } else if (typeof window !== 'undefined' && !this.fetchImpl) {
          // Running in Electron window but IPC bridge is missing - never attempt direct browser fetch (CORS block)
          this.logDiagnostic('missing_electron_ipc', { attempt, model: modelName })
          ipcResponse = {
            success: false,
            error: 'Electron IPC handler for NVIDIA NIM is not available. Please restart the application.',
            errorDetails: 'window.electronAPI.nvidiaChatCompletion is undefined in renderer context.',
            stage: 'init'
          }
        } else {
          // Direct fallback for Node.js / non-browser test harnesses or when fetchImpl is injected
          this.logDiagnostic('sending_direct_fetch', { attempt, model: modelName })
          const fetchFunction = this.fetchImpl || fetch
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), timeoutMs)

          const requestBody: Record<string, unknown> = {
            model: ipcRequest.model,
            messages: ipcRequest.messages,
            temperature: ipcRequest.temperature
          }
          if (ipcRequest.tools) {
            requestBody.tools = ipcRequest.tools
            requestBody.tool_choice = ipcRequest.tool_choice
          }

          try {
            const resp = await fetchFunction('https://integrate.api.nvidia.com/v1/chat/completions', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey.trim()}`,
                Accept: 'application/json'
              },
              body: JSON.stringify(requestBody),
              signal: controller.signal
            })
            clearTimeout(timer)

            if (!resp.ok) {
              let errorDetails = `Status ${resp.status} (${resp.statusText})`
              try {
                const errorJson = (await resp.json()) as any
                if (errorJson.error?.message) {
                  errorDetails = errorJson.error.message
                } else if (errorJson.message) {
                  errorDetails = errorJson.message
                }
              } catch {}

              ipcResponse = {
                success: false,
                status: resp.status,
                statusText: resp.statusText,
                error: errorDetails,
                errorDetails,
                stage: 'response_received'
              }
            } else {
              const data = (await resp.json()) as any
              ipcResponse = {
                success: true,
                status: resp.status,
                data,
                stage: 'completed'
              }
            }
          } catch (fetchErr: unknown) {
            clearTimeout(timer)
            const isAbort =
              fetchErr instanceof Error &&
              (fetchErr.name === 'AbortError' || fetchErr.message.toLowerCase().includes('abort'))
            const rawMsg = isAbort ? `Request timed out after ${timeoutMs / 1000}s` : String(fetchErr)
            ipcResponse = {
              success: false,
              isNetworkError: true,
              error: rawMsg,
              errorDetails: rawMsg,
              stage: 'failed'
            }
          }
        }

        this.logDiagnostic('response_evaluated', {
          success: ipcResponse.success,
          status: ipcResponse.status,
          stage: ipcResponse.stage
        })

        if (!ipcResponse.success) {
          const status = ipcResponse.status || 0
          const rawMessage = ipcResponse.errorDetails || ipcResponse.error || 'Unknown error'
          const isRetryable = this.isRetryableError(status, rawMessage)

          if (isRetryable && attempt < MAX_RETRIES) {
            const backoffMs = (attempt + 1) * 1000
            this.logDiagnostic('retrying', { attempt: attempt + 1, backoffMs, status })
            onRetry?.(attempt + 1, MAX_RETRIES, backoffMs, rawMessage)
            await new Promise((resolve) => setTimeout(resolve, backoffMs))
            continue
          }

          const friendlyError = this.formatUserFriendlyError(
            status,
            rawMessage,
            activeModel,
            ipcResponse.isNetworkError || status === 0
          )
          this.logDiagnostic('failed_final', {
            status,
            sanitizedError: friendlyError,
            failedBeforeResponse: ipcResponse.isNetworkError || status === 0
          })
          throw new Error(friendlyError)
        }

        const choice = ipcResponse.data?.choices?.[0]
        if (!choice || !choice.message) {
          this.logDiagnostic('empty_choices_returned')
          return { text: 'No response returned from NVIDIA NIM.' }
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

        this.logDiagnostic('success_parsed', {
          hasText: !!choiceMsg.content,
          functionCallsCount: functionCalls.length
        })

        return {
          text: choiceMsg.content || undefined,
          functionCalls: functionCalls.length > 0 ? functionCalls : undefined,
          rawModelParts
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.message.startsWith('Invalid NVIDIA API key')) {
          throw err
        }
        if (err instanceof Error && err.message.includes('not found or is currently unavailable')) {
          throw err
        }
        if (err instanceof Error && err.message.includes('does not support tool calling')) {
          throw err
        }
        if (err instanceof Error && err.message.includes('rate limit')) {
          throw err
        }
        if (err instanceof Error && err.message.includes('Failed to connect to NVIDIA NIM')) {
          throw err
        }

        const rawMessage = err instanceof Error ? err.message : String(err)
        const isRetryable = this.isRetryableError(0, rawMessage)

        if (isRetryable && attempt < MAX_RETRIES) {
          const backoffMs = (attempt + 1) * 1000
          this.logDiagnostic('retrying_catch', { attempt: attempt + 1, backoffMs })
          onRetry?.(attempt + 1, MAX_RETRIES, backoffMs, rawMessage)
          await new Promise((resolve) => setTimeout(resolve, backoffMs))
          continue
        }

        const friendlyMsg = this.formatUserFriendlyError(0, rawMessage, activeModel, true)
        this.logDiagnostic('failed_catch_final', {
          sanitizedError: friendlyMsg,
          failedBeforeResponse: true
        })
        lastError = new Error(friendlyMsg)
        throw lastError
      }
    }

    throw lastError || new Error('The NVIDIA AI provider is temporarily unavailable. Please try again.')
  }
}
