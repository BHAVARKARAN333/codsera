import {
  FunctionCallPart,
  FunctionDeclaration,
  LLMMessage,
  LLMPart
} from './types'

export interface OpenAIToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: OpenAIToolCall[]
  tool_call_id?: string
  name?: string
}

export interface OpenAIToolDeclaration {
  type: 'function'
  function: {
    name: string
    description: string
    parameters?: Record<string, unknown>
  }
}

export interface ErrorClassificationOptions {
  signal?: AbortSignal
  isTimeout?: boolean
  providerName?: string
  modelName?: string
  status?: number
  retryAfterHeader?: string | number | null
}

export interface ProviderErrorClassification {
  isUserCancellation: boolean
  isTimeout: boolean
  isRetryable: boolean
  isRateLimit: boolean
  isAuthError: boolean
  isNotFound: boolean
  isToolCallingUnsupported: boolean
  status?: number
  reason: string
  userFriendlyMessage: string
  retryAfterMs?: number
}

export interface RetryDelayOptions {
  baseDelayMs?: number
  minDelayMs?: number
  maxDelayMs?: number
  backoffType?: 'linear' | 'exponential'
}

/**
 * Robustly serializes tool execution responses into OpenAI-compatible tool message content strings.
 * Handles standard orchestrator wrapped formats, bare object results, strings, primitives,
 * null/undefined values, and prevents circular reference exceptions.
 */
export function serializeToolResponse(response: unknown): string {
  if (response === null || response === undefined) {
    return '{}'
  }

  if (typeof response === 'string') {
    return response
  }

  if (typeof response === 'object') {
    const rec = response as Record<string, unknown>
    // Handle orchestrator standard format: { name: string, content: Record<string, unknown> | string }
    if ('content' in rec && rec.content !== undefined) {
      if (typeof rec.content === 'string') {
        return rec.content
      }
      if (rec.content === null) {
        return '{}'
      }
      try {
        return JSON.stringify(rec.content, null, 2)
      } catch {
        return String(rec.content)
      }
    }

    // Bare object result without 'content' key (e.g. { success: true, output: '...' })
    try {
      return JSON.stringify(response, null, 2)
    } catch {
      return '{}'
    }
  }

  if (typeof response === 'number' || typeof response === 'boolean' || typeof response === 'bigint') {
    return String(response)
  }

  return '{}'
}

/**
 * Robustly parses OpenAI-style tool_calls from model choices.
 * Handles valid JSON strings, pre-parsed objects, malformed JSON, and missing names/args.
 */
export function parseOpenAIToolCalls(rawToolCalls: unknown): {
  functionCalls: FunctionCallPart[]
  rawModelParts: LLMPart[]
} {
  if (!Array.isArray(rawToolCalls) || rawToolCalls.length === 0) {
    return { functionCalls: [], rawModelParts: [] }
  }

  const functionCalls: FunctionCallPart[] = []
  const rawModelParts: LLMPart[] = []

  for (let i = 0; i < rawToolCalls.length; i++) {
    const item = rawToolCalls[i]
    if (!item || typeof item !== 'object') continue

    const func = (item as { function?: { name?: unknown; arguments?: unknown } }).function
    if (!func || typeof func !== 'object') continue

    const name = typeof func.name === 'string' ? func.name.trim() : ''
    if (!name) continue

    let parsedArgs: Record<string, unknown> = {}
    const rawArgs = func.arguments

    if (typeof rawArgs === 'string') {
      const trimmed = rawArgs.trim()
      if (trimmed.length > 0) {
        try {
          const parsed = JSON.parse(trimmed)
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            parsedArgs = parsed as Record<string, unknown>
          } else if (Array.isArray(parsed)) {
            parsedArgs = { items: parsed }
          } else if (parsed !== null) {
            parsedArgs = { value: parsed }
          }
        } catch {
          // Malformed JSON fallback to empty object without crashing
          parsedArgs = {}
        }
      }
    } else if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
      parsedArgs = rawArgs as Record<string, unknown>
    } else if (Array.isArray(rawArgs)) {
      parsedArgs = { items: rawArgs }
    }

    const callId =
      typeof (item as { id?: unknown }).id === 'string' && (item as { id: string }).id.trim()
        ? (item as { id: string }).id.trim()
        : `call_${name}_${functionCalls.length + 1}`

    functionCalls.push({
      name,
      args: parsedArgs
    })

    rawModelParts.push({
      functionCall: {
        name,
        args: parsedArgs
      },
      id: callId,
      tool_call_id: callId
    })
  }

  return { functionCalls, rawModelParts }
}

/**
 * Serializes shared LLMMessage array into OpenAI Chat Completions messages schema.
 * Accurately tracks and pairs tool_call_id across model turns and subsequent tool responses.
 */
export function serializeOpenAIMessages(
  messages: LLMMessage[],
  systemInstruction?: string
): OpenAIChatMessage[] {
  const formattedMessages: OpenAIChatMessage[] = []

  if (systemInstruction && systemInstruction.trim()) {
    formattedMessages.push({
      role: 'system',
      content: systemInstruction.trim()
    })
  }

  // Queue of tool calls from the most recent assistant message for ID resolution fallback
  const pendingAssistantToolCalls: Array<{ id: string; name: string }> = []

  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue

    if (msg.role === 'user') {
      const text = Array.isArray(msg.parts)
        ? msg.parts
            .map((p) => (p && typeof p.text === 'string' ? p.text : ''))
            .filter(Boolean)
            .join('\n')
        : ''

      formattedMessages.push({
        role: 'user',
        content: text
      })
    } else if (msg.role === 'model') {
      pendingAssistantToolCalls.length = 0 // Clear prior assistant calls
      const toolCalls: OpenAIToolCall[] = []
      let textContent = ''

      if (Array.isArray(msg.parts)) {
        for (const part of msg.parts) {
          if (!part || typeof part !== 'object') continue

          if (part.functionCall && typeof part.functionCall.name === 'string') {
            const raw = part as Record<string, unknown>
            const toolCallId =
              (typeof raw.tool_call_id === 'string' && raw.tool_call_id.trim()) ||
              (typeof raw.id === 'string' && raw.id.trim()) ||
              `call_${part.functionCall.name}_${toolCalls.length + 1}`

            // Ensure part retains assigned id for subsequent lookups
            raw.id = toolCallId
            raw.tool_call_id = toolCallId

            let argsString = '{}'
            if (typeof part.functionCall.args === 'string') {
              argsString = part.functionCall.args
            } else if (part.functionCall.args && typeof part.functionCall.args === 'object') {
              try {
                argsString = JSON.stringify(part.functionCall.args)
              } catch {
                argsString = '{}'
              }
            }

            toolCalls.push({
              id: toolCallId,
              type: 'function',
              function: {
                name: part.functionCall.name,
                arguments: argsString
              }
            })

            pendingAssistantToolCalls.push({
              id: toolCallId,
              name: part.functionCall.name
            })
          }

          if (typeof part.text === 'string') {
            textContent += part.text
          }
        }
      }

      const assistantMsg: OpenAIChatMessage = {
        role: 'assistant',
        content: textContent || null
      }

      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls
      }

      formattedMessages.push(assistantMsg)
    } else if (msg.role === 'function') {
      if (Array.isArray(msg.parts)) {
        for (const part of msg.parts) {
          if (!part || typeof part !== 'object') continue

          if (part.functionResponse) {
            const raw = part as Record<string, unknown>
            let toolCallId =
              (typeof raw.tool_call_id === 'string' && raw.tool_call_id.trim()) ||
              (typeof raw.id === 'string' && raw.id.trim())

            // If missing, find matching unconsumed tool call from preceding assistant turn
            if (!toolCallId) {
              const matchIdx = pendingAssistantToolCalls.findIndex(
                (tc) => tc.name === part.functionResponse?.name
              )
              if (matchIdx >= 0) {
                toolCallId = pendingAssistantToolCalls[matchIdx].id
                pendingAssistantToolCalls.splice(matchIdx, 1)
              } else {
                toolCallId = `call_${part.functionResponse.name || 'tool'}_1`
              }
            }

            const contentStr = serializeToolResponse(part.functionResponse.response)

            formattedMessages.push({
              role: 'tool',
              tool_call_id: toolCallId,
              name: part.functionResponse.name,
              content: contentStr
            })
          } else if (typeof part.text === 'string') {
            formattedMessages.push({
              role: 'tool',
              tool_call_id: 'call_fallback',
              name: 'unknown',
              content: part.text
            })
          }
        }
      }
    }
  }

  return formattedMessages
}

/**
 * Serializes shared FunctionDeclaration tools into OpenAI Chat Completions tools array.
 */
export function serializeOpenAITools(
  tools?: FunctionDeclaration[]
): OpenAIToolDeclaration[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) {
    return undefined
  }

  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: (tool.parameters as Record<string, unknown>) || {
        type: 'object',
        properties: {}
      }
    }
  }))
}

/**
 * Parses a standard HTTP Retry-After header according to RFC 7231 / RFC 9110.
 * Supports integer delta-seconds and RFC 1123 HTTP-date formats.
 * Returns delay in milliseconds, or null if the header is missing, invalid, or negative.
 */
export function parseRetryAfterHeader(header?: string | number | null): number | null {
  if (header === null || header === undefined || header === '') {
    return null
  }

  if (typeof header === 'number') {
    if (isNaN(header) || !isFinite(header) || header < 0) {
      return null
    }
    return Math.floor(header * 1000)
  }

  if (typeof header === 'string') {
    const trimmed = header.trim()
    if (!trimmed) return null

    // If numeric (including negative numbers or explicit signs)
    if (/^[+-]?\d+(\.\d+)?$/.test(trimmed)) {
      const val = parseFloat(trimmed)
      if (isNaN(val) || !isFinite(val) || val < 0) {
        return null
      }
      return Math.floor(val * 1000)
    }

    // Try parsing as HTTP-date (e.g. "Wed, 21 Oct 2026 07:28:00 GMT") - requires alphabetic characters
    if (/[a-zA-Z]/.test(trimmed)) {
      const parsedDate = Date.parse(trimmed)
      if (!isNaN(parsedDate)) {
        const diffMs = parsedDate - Date.now()
        return Math.max(0, diffMs)
      }
    }
  }

  return null
}

/**
 * Calculates a safe, bounded retry delay in milliseconds.
 * Respects Retry-After if valid, otherwise applies linear or exponential backoff.
 * Delay is guaranteed to be clamped between minDelayMs and maxDelayMs.
 */
export function calculateRetryDelay(
  attempt: number,
  retryAfterHeader?: string | number | null,
  options?: RetryDelayOptions
): number {
  const baseDelayMs = options?.baseDelayMs ?? 1000
  const minDelayMs = options?.minDelayMs ?? 500
  const maxDelayMs = options?.maxDelayMs ?? 30000
  const backoffType = options?.backoffType ?? 'linear'
  const safeAttempt = Math.max(0, attempt)

  const parsedHeaderMs = parseRetryAfterHeader(retryAfterHeader)
  if (parsedHeaderMs !== null) {
    return Math.min(Math.max(parsedHeaderMs, minDelayMs), maxDelayMs)
  }

  let delay: number
  if (backoffType === 'exponential') {
    delay = baseDelayMs * Math.pow(2, safeAttempt)
  } else {
    delay = (safeAttempt + 1) * baseDelayMs
  }

  return Math.min(Math.max(delay, minDelayMs), maxDelayMs)
}

/**
 * Classifies an error into a structured provider error object.
 * Strictly differentiates user cancellation from genuine timeouts,
 * ensuring user cancellations are never marked as retryable.
 */
export function classifyProviderError(
  error: unknown,
  options?: ErrorClassificationOptions
): ProviderErrorClassification {
  let rawMessage = ''
  let status = options?.status

  if (error instanceof Error) {
    rawMessage = error.message
    if ('status' in error && typeof (error as { status: unknown }).status === 'number') {
      status = status ?? (error as { status: number }).status
    }
  } else if (typeof error === 'object' && error !== null) {
    const errObj = error as Record<string, unknown>
    if (typeof errObj.status === 'number') status = status ?? errObj.status
    if (typeof errObj.errorDetails === 'string') rawMessage = errObj.errorDetails
    else if (typeof errObj.message === 'string') rawMessage = errObj.message
    else if (typeof errObj.error === 'string') rawMessage = errObj.error
    else rawMessage = JSON.stringify(error)
  } else {
    rawMessage = String(error || '')
  }

  const lowerMsg = rawMessage.toLowerCase()
  const providerName = options?.providerName || 'AI provider'
  const modelName = options?.modelName || ''

  // 1. User Cancellation Check
  // If signal is aborted AND it was not flagged as an internal request timeout
  const signalAborted = !!options?.signal?.aborted
  const isExplicitUserStop =
    lowerMsg.includes('stopped by user') ||
    lowerMsg.includes('user cancel') ||
    lowerMsg.includes('request was stopped')
  const isGenericAbort =
    (error instanceof Error && error.name === 'AbortError') ||
    lowerMsg.includes('abort') ||
    lowerMsg.includes('operation was aborted')

  const isUserCancellation =
    !options?.isTimeout &&
    !lowerMsg.includes('timed out') &&
    !lowerMsg.includes('timeout') &&
    (signalAborted || isExplicitUserStop || isGenericAbort)

  if (isUserCancellation) {
    return {
      isUserCancellation: true,
      isTimeout: false,
      isRetryable: false, // NEVER retry user cancellation!
      isRateLimit: false,
      isAuthError: false,
      isNotFound: false,
      isToolCallingUnsupported: false,
      status,
      reason: 'user_cancellation',
      userFriendlyMessage: 'Request was stopped by user.'
    }
  }

  // 2. Genuine Timeout Check
  const isTimeout =
    options?.isTimeout === true ||
    status === 408 ||
    status === 504 ||
    lowerMsg.includes('timed out') ||
    lowerMsg.includes('timeout')

  if (isTimeout) {
    return {
      isUserCancellation: false,
      isTimeout: true,
      isRetryable: true,
      isRateLimit: false,
      isAuthError: false,
      isNotFound: false,
      isToolCallingUnsupported: false,
      status: status || 408,
      reason: 'timeout',
      userFriendlyMessage: `Request timed out. The ${providerName} service may be experiencing high demand or latency.`
    }
  }

  // 3. Rate Limit Check (429 / resource_exhausted)
  const isRateLimit =
    status === 429 ||
    lowerMsg.includes('rate limit') ||
    lowerMsg.includes('too many requests') ||
    lowerMsg.includes('resource_exhausted')

  if (isRateLimit) {
    const retryAfterMs = parseRetryAfterHeader(options?.retryAfterHeader) ?? undefined
    return {
      isUserCancellation: false,
      isTimeout: false,
      isRetryable: true,
      isRateLimit: true,
      isAuthError: false,
      isNotFound: false,
      isToolCallingUnsupported: false,
      status: status || 429,
      reason: 'rate_limit',
      userFriendlyMessage: `${providerName} rate limit reached. Please wait a moment and try again.`,
      retryAfterMs
    }
  }

  // 4. Authentication / Authorization Check (401 / 403)
  const isAuthError =
    status === 401 ||
    status === 403 ||
    lowerMsg.includes('unauthorized') ||
    lowerMsg.includes('forbidden') ||
    lowerMsg.includes('api key') ||
    lowerMsg.includes('invalid token') ||
    lowerMsg.includes('key not valid') ||
    (status === 400 && lowerMsg.includes('api_key'))

  if (isAuthError) {
    return {
      isUserCancellation: false,
      isTimeout: false,
      isRetryable: false,
      isRateLimit: false,
      isAuthError: true,
      isNotFound: false,
      isToolCallingUnsupported: false,
      status: status || 401,
      reason: 'authentication',
      userFriendlyMessage: `Invalid ${providerName} API key. Please check your credentials in Settings.`
    }
  }

  // 5. Tool Calling Unsupported Check (400 / 422 with tool keywords)
  const isToolCallingUnsupported =
    (status === 400 || status === 422) &&
    (lowerMsg.includes('tools') ||
      lowerMsg.includes('function') ||
      lowerMsg.includes('tool_choice') ||
      lowerMsg.includes('not supported') ||
      lowerMsg.includes('unrecognized field') ||
      lowerMsg.includes('extra fields not permitted') ||
      lowerMsg.includes('function calling'))

  if (isToolCallingUnsupported) {
    return {
      isUserCancellation: false,
      isTimeout: false,
      isRetryable: false,
      isRateLimit: false,
      isAuthError: false,
      isNotFound: false,
      isToolCallingUnsupported: true,
      status,
      reason: 'tool_calling_unsupported',
      userFriendlyMessage: `The selected model${modelName ? ` ('${modelName}')` : ''} does not support tool calling. Please choose a tool-compatible model.`
    }
  }

  // 6. Model Not Found / Deprecated Check (404 / 410)
  const isNotFound =
    status === 404 ||
    status === 410 ||
    lowerMsg.includes('not found') ||
    lowerMsg.includes('does not exist') ||
    lowerMsg.includes('unknown model') ||
    lowerMsg.includes('model is disabled') ||
    lowerMsg.includes('end of life') ||
    lowerMsg.includes('deprecated')

  if (isNotFound) {
    return {
      isUserCancellation: false,
      isTimeout: false,
      isRetryable: false,
      isRateLimit: false,
      isAuthError: false,
      isNotFound: true,
      isToolCallingUnsupported: false,
      status: status || 404,
      reason: 'model_not_found',
      userFriendlyMessage: `The selected model${modelName ? ` ('${modelName}')` : ''} was not found or has been deprecated. Please select an active model in Settings.`
    }
  }

  // 7. Temporary Server Error Check (500, 502, 503)
  const isServerError =
    status === 500 ||
    status === 502 ||
    status === 503 ||
    lowerMsg.includes('high demand') ||
    lowerMsg.includes('temporarily unavailable') ||
    lowerMsg.includes('service unavailable') ||
    lowerMsg.includes('overloaded') ||
    lowerMsg.includes('try again') ||
    lowerMsg.includes('econnreset') ||
    lowerMsg.includes('econnrefused')

  if (isServerError) {
    return {
      isUserCancellation: false,
      isTimeout: false,
      isRetryable: true,
      isRateLimit: false,
      isAuthError: false,
      isNotFound: false,
      isToolCallingUnsupported: false,
      status: status || 500,
      reason: 'server_error',
      userFriendlyMessage: `The ${providerName} service is temporarily unavailable. Please try again.`
    }
  }

  // 8. General Error Fallback
  const cleanMsg =
    rawMessage.replace(/^[A-Za-z0-9_\s]+(?:API error|error):\s*/i, '').trim() ||
    'An unexpected provider error occurred.'

  return {
    isUserCancellation: false,
    isTimeout: false,
    isRetryable: typeof status === 'number' && status >= 500,
    isRateLimit: false,
    isAuthError: false,
    isNotFound: false,
    isToolCallingUnsupported: false,
    status,
    reason: 'general_error',
    userFriendlyMessage: cleanMsg
  }
}

/**
 * Convenience helper returning whether an error is retryable.
 */
export function isRetryableProviderError(
  error: unknown,
  options?: ErrorClassificationOptions
): boolean {
  return classifyProviderError(error, options).isRetryable
}

/**
 * Cancellable delay that aborts immediately if the signal fires during the sleep.
 */
export async function cancellableSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw new Error('Request was stopped by user.')
  }
  return new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout | null = null

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      signal?.removeEventListener('abort', onAbort)
    }

    const onAbort = () => {
      cleanup()
      reject(new Error('Request was stopped by user.'))
    }

    timer = setTimeout(() => {
      cleanup()
      resolve()
    }, delayMs)

    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

