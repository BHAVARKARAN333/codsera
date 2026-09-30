import {
  FunctionDeclaration,
  IAIProvider,
  LLMMessage,
  LLMRequestOptions,
  LLMResponse,
  ProviderCapabilities
} from './types'
import { NvidiaChatCompletionRequest, NvidiaChatCompletionResponse } from '../../../../shared/types'
import {
  calculateRetryDelay,
  cancellableSleep,
  classifyProviderError,
  parseOpenAIToolCalls,
  serializeOpenAIMessages,
  serializeOpenAITools
} from './providerUtils'

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

  readonly capabilities: ProviderCapabilities = {
    supportsStreaming: false,
    supportsTools: true,
    requiresApiKey: true,
    supportsModelListing: true
  }

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

    // Format messages and tools using standardized OpenAI-compatible serializers
    const formattedMessages = serializeOpenAIMessages(messages, systemInstruction)
    const formattedTools = serializeOpenAITools(tools)

    const MAX_RETRIES = 2
    let lastError: Error | null = null

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (signal?.aborted) {
        throw new Error('Request was stopped by user.')
      }

      const requestId = `nvidia_${Date.now()}_${Math.random().toString(36).slice(2, 9)}_att${attempt}`
      const ipcRequest: NvidiaChatCompletionRequest = {
        model: activeModel,
        messages: formattedMessages,
        temperature,
        apiKey: apiKey.trim(),
        timeoutMs,
        requestId
      }

      if (formattedTools && formattedTools.length > 0) {
        ipcRequest.tools = formattedTools
        ipcRequest.tool_choice = 'auto'
      }

      const onAbort = () => {
        if (typeof window !== 'undefined' && window.electronAPI?.cancelChatCompletion) {
          window.electronAPI.cancelChatCompletion(requestId).catch(() => {})
        }
      }

      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true })
      }

      try {
        let ipcResponse: NvidiaChatCompletionResponse

        if (this.ipcCaller) {
          this.logDiagnostic('sending_custom_ipc', { attempt, model: activeModel, requestId })
          ipcResponse = await this.ipcCaller(ipcRequest)
        } else if (typeof window !== 'undefined' && window.electronAPI?.nvidiaChatCompletion) {
          this.logDiagnostic('sending_electron_ipc', { attempt, model: activeModel, requestId })
          ipcResponse = await window.electronAPI.nvidiaChatCompletion(ipcRequest)
        } else if (typeof window !== 'undefined' && !this.fetchImpl) {
          this.logDiagnostic('missing_electron_ipc', { attempt, model: activeModel })
          ipcResponse = {
            success: false,
            error: 'Electron IPC handler for NVIDIA NIM is not available. Please restart the application.',
            errorDetails: 'window.electronAPI.nvidiaChatCompletion is undefined in renderer context.',
            stage: 'init'
          }
        } else {
          // Direct fetch fallback for non-browser / unit test environments
          this.logDiagnostic('sending_direct_fetch', { attempt, model: activeModel, requestId })
          const fetchFunction = this.fetchImpl || fetch
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
            if (signal) {
              signal.removeEventListener('abort', onSignalAbort)
            }

            if (!resp.ok) {
              let errorDetails = `Status ${resp.status} (${resp.statusText})`
              try {
                const errorJson = (await resp.json()) as any
                if (errorJson.error?.message) {
                  errorDetails = errorJson.error.message
                } else if (errorJson.message) {
                  errorDetails = errorJson.message
                } else if (errorJson.detail) {
                  errorDetails = typeof errorJson.detail === 'string' ? errorJson.detail : JSON.stringify(errorJson.detail)
                }
              } catch {}

              const retryAfter = resp.headers.get('retry-after')
              ipcResponse = {
                success: false,
                status: resp.status,
                statusText: resp.statusText,
                error: errorDetails,
                errorDetails,
                retryAfter: retryAfter || undefined,
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
            if (signal) {
              signal.removeEventListener('abort', onSignalAbort)
            }

            const isUserCancel = (signal?.aborted || controller.signal.aborted) && !isTimedOut
            const isAbort =
              fetchErr instanceof Error &&
              (fetchErr.name === 'AbortError' || fetchErr.message.toLowerCase().includes('abort'))
            const rawMsg = isUserCancel
              ? 'Request was stopped by user.'
              : isAbort || isTimedOut
              ? `Request timed out after ${timeoutMs / 1000}s`
              : String(fetchErr)

            ipcResponse = {
              success: false,
              isNetworkError: !isUserCancel,
              error: rawMsg,
              errorDetails: rawMsg,
              stage: isUserCancel ? 'cancelled' : 'failed'
            }
          }
        }

        if (signal?.aborted) {
          throw new Error('Request was stopped by user.')
        }

        if (!ipcResponse.success) {
          const classification = classifyProviderError(
            {
              status: ipcResponse.status,
              message: ipcResponse.errorDetails || ipcResponse.error,
              errorDetails: ipcResponse.errorDetails,
              isNetworkError: ipcResponse.isNetworkError
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
            const delayMs = calculateRetryDelay(attempt, (ipcResponse as any).retryAfter || null, {
              baseDelayMs: 1000,
              minDelayMs: 500,
              maxDelayMs: 30000
            })
            this.logDiagnostic('retrying', { attempt: attempt + 1, delayMs, status: ipcResponse.status })
            onRetry?.(attempt + 1, MAX_RETRIES, delayMs, classification.reason)
            await cancellableSleep(delayMs, signal)
            continue
          }

          this.logDiagnostic('failed_final', {
            status: ipcResponse.status,
            sanitizedError: classification.userFriendlyMessage
          })
          throw new Error(classification.userFriendlyMessage)
        }

        const choice = ipcResponse.data?.choices?.[0]
        if (!choice || !choice.message) {
          this.logDiagnostic('empty_choices_returned')
          return { text: 'No response returned from NVIDIA NIM.' }
        }

        const choiceMsg = choice.message
        const { functionCalls, rawModelParts } = parseOpenAIToolCalls(choiceMsg.tool_calls)

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
          this.logDiagnostic('retrying_catch', { attempt: attempt + 1, delayMs })
          onRetry?.(attempt + 1, MAX_RETRIES, delayMs, classification.reason)
          await cancellableSleep(delayMs, signal)
          continue
        }

        lastError = new Error(classification.userFriendlyMessage)
        throw lastError
      } finally {
        if (signal) {
          signal.removeEventListener('abort', onAbort)
        }
      }
    }

    throw lastError || new Error('The NVIDIA AI provider is temporarily unavailable. Please try again.')
  }
}
