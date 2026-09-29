export interface FunctionDeclaration {
  name: string
  description: string
  parameters?: {
    type: string
    properties?: Record<string, {
      type: string
      description?: string
      enum?: string[]
    }>
    required?: string[]
  }
}

export interface FunctionCallPart {
  name: string
  args: Record<string, unknown>
}

export interface FunctionResponsePart {
  name: string
  response: {
    name: string
    content: Record<string, unknown>
  }
}

export interface LLMPart {
  text?: string
  functionCall?: FunctionCallPart
  functionResponse?: FunctionResponsePart
  thoughtSignature?: string
  [key: string]: unknown
}

export interface LLMMessage {
  role: 'user' | 'model' | 'function'
  parts: LLMPart[]
}

export interface LLMRequestOptions {
  apiKey: string
  modelName?: string
  systemInstruction?: string
  temperature?: number
  timeoutMs?: number
  onRetry?: (attempt: number, maxRetries: number, delayMs: number, reason: string) => void
  onChunk?: (chunk: string) => void
}

export interface LLMResponse {
  text?: string
  functionCalls?: FunctionCallPart[]
  rawModelParts?: LLMPart[]
}

export interface IAIProvider {
  readonly id: string
  readonly name: string
  sendMessage(
    messages: LLMMessage[],
    tools: FunctionDeclaration[],
    options: LLMRequestOptions
  ): Promise<LLMResponse>
}
