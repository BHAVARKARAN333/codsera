import { FunctionDeclaration } from '../ai/types'
import { ToolExecutionResult } from '../tools/types'
import { ActiveEditorContext } from './smartContextEngine'
import { AgentStepEvent } from './orchestrator'

export const AGENT_WORKER_PROTOCOL_VERSION = '1.0.0'

export const AGENT_WORKER_MSG = {
  // Host -> Worker
  WORKER_INIT: 'WORKER_INIT',
  REQUEST_START: 'REQUEST_START',
  REQUEST_CANCEL: 'REQUEST_CANCEL',
  REQUEST_ABORT: 'REQUEST_ABORT',
  TOOL_RESULT: 'TOOL_RESULT',
  IPC_CALL_RESULT: 'IPC_CALL_RESULT',
  WORKER_TERMINATE: 'WORKER_TERMINATE',

  // Worker -> Host
  WORKER_READY: 'WORKER_READY',
  AGENT_EVENT: 'AGENT_EVENT',
  STREAM_CHUNK: 'STREAM_CHUNK',
  TOOL_REQUEST: 'TOOL_REQUEST',
  IPC_CALL_REQUEST: 'IPC_CALL_REQUEST',
  REQUEST_COMPLETE: 'REQUEST_COMPLETE',
  REQUEST_ERROR: 'REQUEST_ERROR',
  WORKER_DIAGNOSTIC: 'WORKER_DIAGNOSTIC'
} as const

export type AgentWorkerMessageType = (typeof AGENT_WORKER_MSG)[keyof typeof AGENT_WORKER_MSG]

export type AgentRequestStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'CANCELLING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'TIMED_OUT'

export const AGENT_REQUEST_STATUS = {
  QUEUED: 'QUEUED',
  RUNNING: 'RUNNING',
  CANCELLING: 'CANCELLING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  TIMED_OUT: 'TIMED_OUT'
} as const

export const AGENT_ERROR_CODES = {
  QUEUE_FULL: 'ERR_QUEUE_FULL',
  TIMEOUT: 'ERR_TIMEOUT',
  CANCELLED: 'ERR_CANCELLED',
  WORKER_CRASH: 'ERR_WORKER_CRASH',
  TERMINATED: 'ERR_TERMINATED',
  INVALID_STATE: 'ERR_INVALID_STATE',
  REJECTED: 'ERR_TOOL_REJECTED'
} as const

export interface SerializedAgentError {
  message: string
  name?: string
  code?: string
  isAborted?: boolean
  isTimeout?: boolean
  stack?: string
}

export interface SerializedToolDeclaration {
  name: string
  description: string
  parameters: FunctionDeclaration['parameters']
  requiresApproval?: boolean
}

export interface SerializedAgentRunOptions {
  providerType: string
  apiKey: string
  modelName?: string
  workspaceRoot: string | null
  currentBranch?: string | null
  activeEditorContext?: ActiveEditorContext | null
  timeoutMs?: number
  tools?: SerializedToolDeclaration[]
}

// ---------------------------------------------------------------------------
// Messages: Host -> Worker
// ---------------------------------------------------------------------------

export interface WorkerInitMessage {
  type: typeof AGENT_WORKER_MSG.WORKER_INIT
  config?: Record<string, unknown>
}

export interface RequestStartMessage {
  type: typeof AGENT_WORKER_MSG.REQUEST_START
  requestId: string
  prompt: string
  options: SerializedAgentRunOptions
}

export interface RequestCancelMessage {
  type: typeof AGENT_WORKER_MSG.REQUEST_CANCEL
  requestId: string
  reason?: string
}

export interface RequestAbortMessage {
  type: typeof AGENT_WORKER_MSG.REQUEST_ABORT
  requestId: string
}

export interface ToolResultMessage {
  type: typeof AGENT_WORKER_MSG.TOOL_RESULT
  requestId: string
  toolCallId: string
  result: ToolExecutionResult
}

export type AllowedWorkerIpcMethod =
  | 'readTree'
  | 'readWorkspaceFile'
  | 'loadWorkspaceIndex'
  | 'saveWorkspaceIndex'
  | 'nvidiaChatCompletion'
  | 'opencodeChatCompletion'
  | 'cancelChatCompletion'

export interface IpcCallResultMessage {
  type: typeof AGENT_WORKER_MSG.IPC_CALL_RESULT
  callId: string
  success: boolean
  result?: unknown
  error?: string
}

export interface WorkerTerminateMessage {
  type: typeof AGENT_WORKER_MSG.WORKER_TERMINATE
}

export type MessageToWorker =
  | WorkerInitMessage
  | RequestStartMessage
  | RequestCancelMessage
  | RequestAbortMessage
  | ToolResultMessage
  | IpcCallResultMessage
  | WorkerTerminateMessage

// ---------------------------------------------------------------------------
// Messages: Worker -> Host
// ---------------------------------------------------------------------------

export interface WorkerReadyMessage {
  type: typeof AGENT_WORKER_MSG.WORKER_READY
  version: string
  timestamp: number
}

export interface AgentEventMessage {
  type: typeof AGENT_WORKER_MSG.AGENT_EVENT
  requestId: string
  event: AgentStepEvent
  sequence: number
}

export interface StreamChunkMessage {
  type: typeof AGENT_WORKER_MSG.STREAM_CHUNK
  requestId: string
  chunk: string
  sequence: number
}

export interface ToolRequestMessage {
  type: typeof AGENT_WORKER_MSG.TOOL_REQUEST
  requestId: string
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
}

export interface IpcCallRequestMessage {
  type: typeof AGENT_WORKER_MSG.IPC_CALL_REQUEST
  callId: string
  method: AllowedWorkerIpcMethod
  args: unknown[]
}

export interface RequestCompleteMessage {
  type: typeof AGENT_WORKER_MSG.REQUEST_COMPLETE
  requestId: string
  response: string
}

export interface RequestErrorMessage {
  type: typeof AGENT_WORKER_MSG.REQUEST_ERROR
  requestId: string
  error: SerializedAgentError
}

export interface WorkerDiagnosticMessage {
  type: typeof AGENT_WORKER_MSG.WORKER_DIAGNOSTIC
  level: 'info' | 'warn' | 'error'
  message: string
  details?: unknown
}

export type MessageFromWorker =
  | WorkerReadyMessage
  | AgentEventMessage
  | StreamChunkMessage
  | ToolRequestMessage
  | IpcCallRequestMessage
  | RequestCompleteMessage
  | RequestErrorMessage
  | WorkerDiagnosticMessage

// ---------------------------------------------------------------------------
// Port / Message Channel Abstractions
// ---------------------------------------------------------------------------

export interface IWorkerPort {
  postMessage(message: unknown): void
  onmessage?: ((event: { data: unknown }) => void) | null
  onerror?: ((event: unknown) => void) | null
  terminate?: () => void
}

export type WorkerFactory = () => Worker | IWorkerPort

export interface AgentWorkerDiagnostics {
  workerActive: boolean
  fallbackMode: boolean
  activeRequestsCount: number
  queuedRequestsCount: number
  maxConcurrentRequests: number
  queueCapacity: number
  totalRequestsCompleted: number
  totalRequestsFailed: number
  totalRequestsCancelled: number
  totalRequestsTimedOut: number
  lastWorkerError?: string | null
  protocolVersion: string
}

// ---------------------------------------------------------------------------
// Lifecycle State Machine & Safety Utilities
// ---------------------------------------------------------------------------

export function isTerminalStatus(status: AgentRequestStatus): boolean {
  return (
    status === 'COMPLETED' ||
    status === 'FAILED' ||
    status === 'CANCELLED' ||
    status === 'TIMED_OUT'
  )
}

export function isValidStatusTransition(
  from: AgentRequestStatus,
  to: AgentRequestStatus
): boolean {
  if (isTerminalStatus(from)) {
    return false // Terminal states are strictly immutable
  }
  switch (from) {
    case 'QUEUED':
      return to === 'RUNNING' || to === 'CANCELLED' || to === 'TIMED_OUT' || to === 'FAILED'
    case 'RUNNING':
      return (
        to === 'CANCELLING' ||
        to === 'COMPLETED' ||
        to === 'FAILED' ||
        to === 'CANCELLED' ||
        to === 'TIMED_OUT'
      )
    case 'CANCELLING':
      return to === 'CANCELLED' || to === 'FAILED'
    default:
      return false
  }
}

// ---------------------------------------------------------------------------
// Serialization & Safety Utilities
// ---------------------------------------------------------------------------

export function serializeError(err: unknown): SerializedAgentError {
  if (err instanceof Error) {
    const isAborted =
      err.name === 'AbortError' ||
      err.message.includes('stopped by user') ||
      err.message.includes('aborted')
    const isTimeout =
      (err as any).code === AGENT_ERROR_CODES.TIMEOUT ||
      err.message.toLowerCase().includes('timed out') ||
      err.message.toLowerCase().includes('timeout')
    return {
      message: err.message || 'Unknown error occurred',
      name: err.name || 'Error',
      code: (err as any).code,
      isAborted,
      isTimeout,
      stack: err.stack
    }
  }
  return {
    message: typeof err === 'string' ? err : 'Unknown error occurred',
    name: 'Error',
    isAborted: false,
    isTimeout: false
  }
}

export function deserializeError(serialized: SerializedAgentError): Error {
  const err = new Error(serialized.message)
  err.name = serialized.name || 'Error'
  if (serialized.isAborted) {
    err.name = 'AbortError'
  }
  if (serialized.code) {
    ;(err as any).code = serialized.code
  }
  if (serialized.isTimeout) {
    ;(err as any).isTimeout = true
  }
  return err
}

export function isAbortError(err: unknown): boolean {
  if (!err) return false
  if (err instanceof Error) {
    return (
      err.name === 'AbortError' ||
      err.message.includes('stopped by user') ||
      err.message.includes('aborted')
    )
  }
  if (typeof err === 'object' && (err as any).isAborted) {
    return true
  }
  return false
}
