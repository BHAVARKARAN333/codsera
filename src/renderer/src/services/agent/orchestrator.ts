import { FunctionDeclaration, IAIProvider, LLMMessage } from '../ai/types'
import { ITool, ToolApprovalRequest, ToolContext, ToolExecutionResult } from '../tools/types'
import { SmartContextEngine } from './smartContextEngine'
import { AgentPlan, AgentPlanner } from './agentPlanner'

export interface AgentStepEvent {
  type: 'thinking' | 'tool_call' | 'tool_result' | 'retrying' | 'done' | 'error'
  toolName?: string
  toolArgs?: Record<string, unknown>
  toolOutput?: string
  toolSuccess?: boolean
  text?: string
  error?: string
  retryAttempt?: number
  maxRetries?: number
}

export interface AgentRunOptions {
  apiKey: string
  workspaceRoot: string | null
  modelName?: string
  timeoutMs?: number
  requestApproval?: (request: ToolApprovalRequest) => Promise<boolean>
  onFileCreated?: (path: string) => void
  onFileEdited?: (path: string, newContent: string) => void
  onCommandExecuted?: (
    command: string,
    result: { stdout: string; stderr: string; exitCode: number | null }
  ) => void
  onStep?: (event: AgentStepEvent) => void
  onChunk?: (chunk: string) => void
}

export class AgentOrchestrator {
  private provider: IAIProvider
  private tools: Map<string, ITool> = new Map()
  private history: LLMMessage[] = []
  private abortController: AbortController | null = null
  private activeRunId = 0
  private processedToolCallIds: Set<string> = new Set()
  private consecutiveToolFailures: Map<string, number> = new Map()
  private smartContextEngine: SmartContextEngine = new SmartContextEngine()
  private agentPlanner: AgentPlanner = new AgentPlanner()

  constructor(provider: IAIProvider) {
    this.provider = provider
  }

  getSmartContextEngine(): SmartContextEngine {
    return this.smartContextEngine
  }

  getAgentPlanner(): AgentPlanner {
    return this.agentPlanner
  }

  setProvider(provider: IAIProvider): void {
    this.provider = provider
  }

  getProvider(): IAIProvider {
    return this.provider
  }

  registerTool(tool: ITool): void {
    this.tools.set(tool.name, tool)
  }

  private getToolDeclarations(): FunctionDeclaration[] {
    return Array.from(this.tools.values()).map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters
    }))
  }

  private getHistoryCharCount(): number {
    let total = 0
    for (const msg of this.history) {
      total += JSON.stringify(msg).length
    }
    return total
  }

  clearHistory(): void {
    this.history = []
    this.processedToolCallIds.clear()
    this.consecutiveToolFailures.clear()
    this.smartContextEngine.clearCache()
    this.agentPlanner.clearPlan()
  }

  getHistory(): LLMMessage[] {
    return JSON.parse(JSON.stringify(this.history))
  }

  /**
   * Prunes older conversation turns from the beginning of history when total context
   * exceeds maxTotalContextChars. Preserves the current/most recent user turn,
   * ensures every model tool_call retains its paired function response, and guarantees
   * that history always begins with a user turn.
   */
  private pruneHistoryToBudget(): void {
    const maxBudget = this.smartContextEngine.getConfig().maxTotalContextChars
    if (this.getHistoryCharCount() <= maxBudget) {
      return
    }

    const getUserTurnIndices = (): number[] => {
      const indices: number[] = []
      for (let i = 0; i < this.history.length; i++) {
        if (this.history[i].role === 'user') {
          indices.push(i)
        }
      }
      return indices
    }

    let userTurns = getUserTurnIndices()

    // 1. Drop oldest completed rounds if multiple user turns exist
    while (userTurns.length > 1 && this.getHistoryCharCount() > maxBudget) {
      const nextTurnStart = userTurns[1]
      this.history.splice(0, nextTurnStart)
      userTurns = getUserTurnIndices()
    }

    // 2. If history is still over budget within the single active round, compress earlier tool outputs
    if (this.getHistoryCharCount() > maxBudget) {
      for (let i = 0; i < this.history.length - 1; i++) {
        if (this.getHistoryCharCount() <= maxBudget) break
        const msg = this.history[i]
        if (msg.role === 'function') {
          for (const part of msg.parts) {
            const resp = part.functionResponse?.response as Record<string, unknown> | undefined
            const content = resp?.content as Record<string, unknown> | undefined
            if (content && typeof content.output === 'string' && content.output.length > 1200) {
              const notice = '\n[... Earlier tool output compressed to preserve context budget ...]'
              content.output = content.output.slice(0, 800) + notice
            }
          }
        }
      }
    }
  }

  /**
   * Sanitizes history when an execution halts prematurely (cancellation or unhandled error).
   * Ensures every model functionCall has a corresponding function response,
   * every user prompt has a closing model turn, and history remains structurally valid.
   */
  private sanitizeIncompleteTurns(reason: string, isAbort: boolean): void {
    if (this.history.length === 0) return

    // 1. Check if there are any model messages with unanswered tool calls
    for (let i = 0; i < this.history.length; i++) {
      if (this.history[i].role === 'model') {
        const modelMsg = this.history[i]
        const toolCallsInModel: Array<{ id: string; name: string }> = []

        for (const part of modelMsg.parts) {
          const raw = part as Record<string, unknown>
          if (part.functionCall) {
            const id = (raw['id'] as string) || (raw['tool_call_id'] as string) || part.functionCall.name
            toolCallsInModel.push({ id, name: part.functionCall.name })
          }
        }

        if (toolCallsInModel.length > 0) {
          const answeredIds = new Set<string>()
          let insertIdx = i + 1
          while (insertIdx < this.history.length && this.history[insertIdx].role === 'function') {
            for (const part of this.history[insertIdx].parts) {
              const raw = part as Record<string, unknown>
              const id = (raw['tool_call_id'] as string) || (part.functionResponse?.name)
              if (id) answeredIds.add(id)
            }
            insertIdx++
          }

          for (const call of toolCallsInModel) {
            if (!answeredIds.has(call.id)) {
              this.history.splice(insertIdx, 0, {
                role: 'function',
                parts: [
                  {
                    tool_call_id: call.id,
                    functionResponse: {
                      name: call.name,
                      response: {
                        name: call.name,
                        content: {
                          success: false,
                          status: isAbort ? 'cancelled' : 'failed',
                          output: reason
                        }
                      }
                    }
                  }
                ]
              })
              insertIdx++
              answeredIds.add(call.id)
            }
          }
        }
      }
    }

    // 2. Ensure history ends with a model message so that alternating turns are preserved
    const lastMsg = this.history[this.history.length - 1]
    if (lastMsg && lastMsg.role !== 'model') {
      this.history.push({
        role: 'model',
        parts: [{ text: isAbort ? 'Request was stopped by user.' : `Execution halted: ${reason}` }]
      })
    }
  }

  /**
   * Stops the currently active run by aborting its AbortController and sending a process cleanup request.
   * If called when no run is active, it halts any background processes that may be running via stopCommand.
   * Calling run() afterwards always begins a fresh run with a new AbortController.
   */
  stop(): void {
    if (this.abortController) {
      this.abortController.abort()
    }
    if (typeof window !== 'undefined' && window.electronAPI?.stopCommand) {
      window.electronAPI.stopCommand().catch(() => {})
    }
  }

  async run(prompt: string, options: AgentRunOptions): Promise<string> {
    const {
      apiKey,
      workspaceRoot,
      modelName,
      timeoutMs,
      onStep,
      onChunk,
      requestApproval,
      onFileCreated,
      onFileEdited,
      onCommandExecuted
    } = options
    const requestStartTime = performance.now()

    const systemInstruction = `You are an AI coding assistant in a desktop IDE.
Use available tools ONLY when strictly necessary to answer the user's request about the local workspace.
Do NOT call tools for greetings (e.g. 'hi', 'hello'), conversational messages, general programming questions (e.g. 'What is Python?', 'Explain recursion'), or requests that do not require inspecting the local project.

Rules for tool usage & failure handling:
1. 'read_file': Use ONLY when the user's request requires inspecting the contents of a specific local project file (e.g. 'Read src/renderer/src/App.tsx and explain what it does'). If the user names a specific file path, call 'read_file' directly.
2. 'read_file' FAILURE HANDLING: If 'read_file' fails (e.g. file not found, access denied, or read error):
   - Do NOT call 'list_files' as a fallback to guess the file contents.
   - Do NOT attempt to read the same failing path again.
   - Do NOT invent, assume, or fabricate the contents of the file.
   - Explain honestly to the user that the file could not be read and state the exact error returned.
3. 'create_file': Use ONLY when the user explicitly asks to create or add a new file. Provide the relative workspace 'path' and the complete initial 'content' to write.
   - Do NOT use 'create_file' to modify or overwrite existing files.
   - Do NOT use 'create_file' for general questions or explanations.
   - The user will be asked to review and approve the file creation before it is written to disk.
4. 'edit_file': Use ONLY when the user explicitly asks to modify, update, change, or fix code in an existing file.
   - You MUST provide the relative workspace 'path' and the complete modified 'newContent'.
   - Before editing an existing file, use 'read_file' if you need to inspect its current contents. Do not guess existing code.
   - Do NOT use 'edit_file' to create new files (use 'create_file' instead).
   - The user will be presented with a diff preview and must explicitly approve the edit before any changes are written to disk.
   - Do NOT claim that the file was edited until the tool execution succeeds.
5. 'run_command': Use ONLY when the user asks to run a shell/terminal command, execute tests, build, install packages, check git status, or verify code changes.
   - You MUST provide the exact shell 'command' string.
   - The command will be executed with working directory locked to the workspace root.
   - NEVER generate commands that attempt to change directories outside the workspace (such as 'cd ..', 'cd ../..', 'pushd ..', 'Set-Location ..', or path traversal).
   - Dangerous commands (e.g. rm -rf, del, format, dd, fork bombs) should be avoided unless strictly requested.
   - The user will be prompted for explicit approval in the UI before any command runs.
   - Verification & Error Recovery Workflow:
     * When asked to fix an issue and verify it:
       1. First read the relevant file using 'read_file' to inspect the code and understand the problem.
       2. Propose the fix using 'edit_file' with the complete modified file content.
       3. Wait for user approval. Once the edit is applied, execute the appropriate verification command using 'run_command' (e.g. "npm test", "npx tsc --noEmit", "node test.js", etc.).
       4. If the verification command succeeds (exitCode: 0):
          - Report success clearly to the user.
          - Summarize what was fixed and changed.
          - State the actual verification command and its passing result.
       5. If the verification command fails (non-zero exitCode or error output):
          - Capture and analyze the actual stdout/stderr from the command output.
          - Explain the exact failure honestly based strictly on the real command output.
          - NEVER claim verification succeeded if the command actually failed.
          - NEVER fabricate test or compiler results.
          - Formulate a corrective fix to address the failure and propose another 'edit_file' call.
          - Wait for explicit user approval for the corrective edit before it is applied.
          - After the corrective edit is approved and applied, rerun the verification command to confirm the fix.
     * If any tool call is rejected by the user, stop immediately without re-prompting or retrying.
   - Never run interactive commands that wait forever for stdin input (like nano, vim, or prompt loops).
6. 'git_status': Use ONLY when the user asks about Git status, current branch, changed/staged/unstaged/untracked files (e.g. 'Show me the Git status', 'What files have I changed?').
7. 'git_diff': Use ONLY when the user asks to see current Git changes or diffs (e.g. 'Show me my current diff', 'What changes did I make?').
8. 'git_log': Use ONLY when the user asks to see recent commit history (e.g. 'What did I commit recently?', 'Show recent commits').
9. 'list_files': Use ONLY when project structure, directory tree, or file listing is explicitly requested. Do NOT call 'list_files' when the user requested Git information, file contents, or commands.
10. If a request does NOT require inspecting, creating, or modifying local files, checking Git, or running terminal commands, answer directly WITHOUT calling any tool.`

    const runId = ++this.activeRunId
    const runController = new AbortController()
    this.abortController = runController
    const runSignal = runController.signal

    let isRunFinished = false
    let plan: AgentPlan | null = null

    try {
      // Resolve smart project context
      const smartContext = await this.smartContextEngine.resolveContext(prompt, workspaceRoot)

      if (runSignal.aborted) {
        throw new Error('Request was stopped by user.')
      }

      // Generate multi-step execution plan if required
      plan = this.agentPlanner.createPlan(prompt, {
        primaryFile: smartContext.readFiles[0]?.path,
        candidateFiles: smartContext.selectedFiles.map((f) => f.path),
        affectedFiles: smartContext.dependencyGraph?.potentiallyAffected,
        likelyTests: smartContext.dependencyGraph?.likelyTests
      })

      if (runSignal.aborted) {
        throw new Error('Request was stopped by user.')
      }

      let dynamicSystemInstruction = systemInstruction
      if (smartContext.required && smartContext.formattedContext) {
        dynamicSystemInstruction += `\n\n${smartContext.formattedContext}\n\nNote: The relevant project files above have been pre-loaded by the Smart Context Engine. If these files provide all the information needed to answer the user's request, do NOT call 'read_file' or 'list_files' again for them. Answer directly or propose edits using 'edit_file' directly.`
      } else if (!smartContext.required) {
        dynamicSystemInstruction += `\n\nNote: This is a general, conceptual, or conversational query. Do NOT call any filesystem, terminal, or Git tools. Answer the user directly.`
      }

      if (plan) {
        dynamicSystemInstruction += `\n\n${this.agentPlanner.formatPlanContext(plan)}`
      }

    const safeOnChunk = onChunk
      ? (chunk: string) => {
          if (!chunk || runSignal.aborted || isRunFinished || this.activeRunId !== runId) return
          onChunk(chunk)
        }
      : undefined

    const safeOnStep = onStep
      ? (event: AgentStepEvent) => {
          if (runSignal.aborted || isRunFinished || this.activeRunId !== runId) return
          onStep(event)
        }
      : undefined

    const wrappedOnFileCreated = (createdPath: string) => {
      if (this.activeRunId !== runId) return
      this.smartContextEngine.invalidateFile(createdPath)
      this.agentPlanner.recordFileCreated(createdPath)
      onFileCreated?.(createdPath)
    }

    const wrappedOnFileEdited = (editedPath: string, newContent: string) => {
      if (this.activeRunId !== runId) return
      this.smartContextEngine.invalidateFile(editedPath)
      this.agentPlanner.recordFileModified(editedPath)
      onFileEdited?.(editedPath, newContent)
    }

    let toolApprovedForCurrentCall = false

    const wrappedRequestApproval = async (req: ToolApprovalRequest): Promise<boolean> => {
      if (this.activeRunId !== runId || runSignal.aborted) {
        return false
      }

      if (plan && plan === this.agentPlanner.getActivePlan() && this.activeRunId === runId) {
        const matchingStep = plan.steps.find(
          (s) => s.status === 'running' || (s.status === 'pending' && s.toolName === req.toolName)
        )
        if (matchingStep) {
          this.agentPlanner.setWaitingForApproval(matchingStep.id)
        }
      }

      let approved = false
      try {
        approved = requestApproval ? await requestApproval(req) : false
      } catch {
        approved = false
      }

      // Guard against approval resolving after cancellation or superseded run
      if (this.activeRunId !== runId || runSignal.aborted) {
        return false
      }

      if (approved) {
        toolApprovedForCurrentCall = true
        if (plan && plan === this.agentPlanner.getActivePlan() && this.activeRunId === runId) {
          const matchingStep = plan.steps.find(
            (s) =>
              s.status === 'waiting_for_approval' && (!s.toolName || s.toolName === req.toolName)
          )
          if (matchingStep) {
            this.agentPlanner.startStep(matchingStep.id)
          }
        }
      } else {
        if (plan && plan === this.agentPlanner.getActivePlan() && this.activeRunId === runId) {
          const rejectReason = requestApproval
            ? `User rejected approval for ${req.toolName}`
            : `Approval required for ${req.toolName} but no approval handler was provided`
          this.agentPlanner.abortPlan(rejectReason)
        }
      }

      return approved
    }

    const toolContext: ToolContext = {
      workspaceRoot,
      signal: runSignal,
      requestApproval: wrappedRequestApproval,
      onFileCreated: wrappedOnFileCreated,
      onFileEdited: wrappedOnFileEdited,
      onCommandExecuted
    }
    const toolDeclarations = this.getToolDeclarations()

    // Context budget ceiling enforcement for user prompt: cap if exceedingly large
    const maxBudget = this.smartContextEngine.getConfig().maxTotalContextChars
    let promptText = prompt
    const maxPromptChars = Math.max(1000, maxBudget - 2000)
    if (promptText.length > maxPromptChars) {
      const truncationNotice = '\n\n[... User prompt truncated to fit context budget ...]'
      promptText = promptText.slice(0, maxPromptChars - truncationNotice.length) + truncationNotice
    }

    // Add user message to conversation history
    this.history.push({
      role: 'user',
      parts: [{ text: promptText }]
    })

    this.pruneHistoryToBudget()

    const MAX_TOOL_ITERATIONS = 12
    let iterations = 0
    let totalProviderTime = 0
    let totalToolTime = 0

    while (iterations < MAX_TOOL_ITERATIONS) {
        if (runSignal.aborted || this.activeRunId !== runId) {
          throw new Error('Request was stopped by user.')
        }

        iterations++
        safeOnStep?.({ type: 'thinking' })

        if (runSignal.aborted || this.activeRunId !== runId) {
          throw new Error('Request was stopped by user.')
        }

        // Ensure history adheres to total context budget before sending to provider
        this.pruneHistoryToBudget()

        let response
        const providerStart = performance.now()
        try {
          response = await this.provider.sendMessage(this.history, toolDeclarations, {
            apiKey,
            modelName,
            systemInstruction: dynamicSystemInstruction,
            timeoutMs,
            signal: runSignal,
            onChunk: safeOnChunk,
            onRetry: (attempt, maxRetries, _delayMs, reason) => {
              const retryText = reason
                ? `Temporary provider issue: ${reason} — retrying (${attempt}/${maxRetries})...`
                : `Temporary provider issue — retrying (${attempt}/${maxRetries})...`
              safeOnStep?.({
                type: 'retrying',
                text: retryText,
                retryAttempt: attempt,
                maxRetries
              })
            }
          })
        } catch (err: unknown) {
          const isAbort =
            runSignal.aborted ||
            this.activeRunId !== runId ||
            (err instanceof Error &&
              (err.name === 'AbortError' || err.message === 'Request was stopped by user.'))
          if (!isAbort) {
            const errorMsg = err instanceof Error ? err.message : String(err)
            safeOnStep?.({ type: 'error', error: errorMsg })
          }
          throw err
        } finally {
          totalProviderTime += performance.now() - providerStart
        }

        if (runSignal.aborted || this.activeRunId !== runId) {
          throw new Error('Request was stopped by user.')
        }

        // Check if model decided to call tools
        if (response.functionCalls && response.functionCalls.length > 0) {
          // Save complete model turn in history (preserving thoughtSignature and exact parts)
          const modelParts =
            response.rawModelParts && response.rawModelParts.length > 0
              ? response.rawModelParts
              : [
                  ...(response.text ? [{ text: response.text }] : []),
                  ...response.functionCalls.map((call) => ({ functionCall: call }))
                ]

          this.history.push({
            role: 'model',
            parts: modelParts
          })

          for (let i = 0; i < response.functionCalls.length; i++) {
            toolApprovedForCurrentCall = false
            if (runSignal.aborted || this.activeRunId !== runId) {
              throw new Error('Request was stopped by user.')
            }

            const call = response.functionCalls[i]
            const rawPart = modelParts[i] as Record<string, unknown> | undefined
            const toolCallId =
              (rawPart?.['id'] as string) ||
              (rawPart?.['tool_call_id'] as string) ||
              `call_${call.name}_r${runId}_i${iterations}_${i}`

            if (rawPart) {
              rawPart['id'] = toolCallId
              rawPart['tool_call_id'] = toolCallId
            }

            let toolResultOutput: string
            let toolSuccess = false

            if (this.processedToolCallIds.has(toolCallId)) {
              // This exact tool call ID was already executed - skip execution
              continue
            }

            this.processedToolCallIds.add(toolCallId)

            safeOnStep?.({
              type: 'tool_call',
              toolName: call.name,
              toolArgs: call.args
            })

            const activeStep = plan?.steps.find(
              (s) =>
                (s.status === 'running' ||
                  s.status === 'waiting_for_approval' ||
                  s.status === 'pending') &&
                (!s.toolName || s.toolName === call.name)
            )
            if (activeStep && activeStep.status === 'pending') {
              this.agentPlanner.startStep(activeStep.id)
            }

            const tool = this.tools.get(call.name)
            if (!tool) {
              toolResultOutput = `Error: Tool '${call.name}' is not recognized or available.`
              toolSuccess = false
              if (activeStep) {
                this.agentPlanner.failStep(activeStep.id, toolResultOutput)
              }
            } else {
              let execResult: ToolExecutionResult
              const toolStart = performance.now()
              const safeArgs =
                call.args && typeof call.args === 'object' ? call.args : {}
              try {
                execResult = await tool.execute(safeArgs, toolContext)
              } catch (toolErr: unknown) {
                const errorMsg = toolErr instanceof Error ? toolErr.message : String(toolErr)
                if (activeStep && plan && plan === this.agentPlanner.getActivePlan() && this.activeRunId === runId) {
                  this.agentPlanner.failStep(activeStep.id, errorMsg)
                }
                if (plan && plan === this.agentPlanner.getActivePlan() && this.activeRunId === runId) {
                  this.agentPlanner.abortPlan(`Tool execution error: ${errorMsg}`)
                }
                throw toolErr
              } finally {
                totalToolTime += performance.now() - toolStart
              }

              // Normalize tool execution result to ensure non-null object
              if (!execResult || typeof execResult !== 'object') {
                execResult = {
                  success: false,
                  output: `Error executing ${call.name}: Tool returned invalid result (expected ToolExecutionResult object).`,
                  error: `Invalid tool result from ${call.name}`
                }
              }

              // Guardrail check: if tool declares requiresApproval: true, it MUST have been approved via wrappedRequestApproval
              if (tool.requiresApproval === true && !toolApprovedForCurrentCall && execResult.success) {
                execResult = {
                  success: false,
                  rejected: true,
                  output: `Security violation: Tool '${tool.name}' requires explicit approval but executed without obtaining approval.`,
                  error: `Security violation: Tool '${tool.name}' requires explicit approval but executed without obtaining approval.`
                }
              }

              // Handle rejection first so rejection reason and plan cleanup are preserved even if stop() was triggered
              if (execResult.rejected) {
                const rejectionText = execResult.output || 'Edit rejected — no changes were made.'
                if (plan && plan === this.agentPlanner.getActivePlan() && this.activeRunId === runId) {
                  this.agentPlanner.abortPlan(rejectionText)
                }

                // If cancellation also occurred, throw stopped error with plan already cleaned up
                if (runSignal.aborted || this.activeRunId !== runId) {
                  throw new Error('Request was stopped by user.')
                }

                safeOnStep?.({
                  type: 'tool_result',
                  toolName: call.name,
                  toolArgs: call.args,
                  toolOutput: rejectionText,
                  toolSuccess: false
                })

                this.history.push({
                  role: 'function',
                  parts: [
                    {
                      tool_call_id: toolCallId,
                      functionResponse: {
                        name: call.name,
                        response: {
                          name: call.name,
                          content: {
                            success: false,
                            status: 'rejected',
                            output: rejectionText
                          }
                        }
                      }
                    }
                  ]
                })

                this.history.push({
                  role: 'model',
                  parts: [{ text: rejectionText }]
                })

                safeOnStep?.({ type: 'done', text: rejectionText })
                return rejectionText
              }

              // Check cancellation signal after tool execution
              if (runSignal.aborted || this.activeRunId !== runId) {
                throw new Error('Request was stopped by user.')
              }

              toolSuccess = execResult.success
              toolResultOutput = execResult.output
                ? execResult.output
                : `Error executing ${call.name}: ${execResult.error} (State this failure clearly to the user. Do NOT invent file contents or call list_files as a fallback.)`

              if (execResult.success && execResult.output) {
                const successKey = `${call.name}:${JSON.stringify(call.args || {})}`
                this.consecutiveToolFailures.delete(successKey)

                const deduplicator = this.smartContextEngine.getDeduplicator()
                const argsKey = JSON.stringify(call.args || {})

                if (deduplicator.isToolResultDuplicate(call.name, argsKey, execResult.output)) {
                  toolResultOutput = `[Notice: Output of ${call.name} with identical arguments was already provided earlier in the conversation and is omitted to conserve context.]`
                } else {
                  deduplicator.markToolResult(call.name, argsKey, execResult.output)

                  if (call.name === 'read_file') {
                    try {
                      const parsed = JSON.parse(execResult.output)
                      if (parsed && typeof parsed.path === 'string' && typeof parsed.content === 'string') {
                        this.smartContextEngine.getCache().set(parsed.path, parsed.content)
                        this.smartContextEngine.getDeduplicator().markFileInContext(parsed.path, parsed.content)
                      }
                    } catch {
                      // Plain string output
                    }
                  } else if (call.name === 'create_file') {
                    const targetPath = (call.args?.path as string) || ''
                    this.agentPlanner.recordFileCreated(targetPath)
                  } else if (call.name === 'edit_file') {
                    const targetPath = (call.args?.path as string) || ''
                    this.agentPlanner.recordFileModified(targetPath)
                  } else if (call.name === 'run_command') {
                    const cmd = (call.args?.command as string) || ''
                    const passed =
                      !execResult.output.includes('"exitCode": 1') &&
                      !execResult.output.includes('"exitCode": 2') &&
                      !execResult.output.includes('"exitCode": -1') &&
                      !execResult.output.includes('Command failed')
                    this.agentPlanner.recordVerification(cmd, passed && execResult.success)
                  }
                }

                if (activeStep) {
                  this.agentPlanner.completeStep(activeStep.id, execResult.output)
                }
              } else if (!execResult.success) {
                const failKey = `${call.name}:${JSON.stringify(call.args || {})}`
                const failCount = (this.consecutiveToolFailures.get(failKey) || 0) + 1
                this.consecutiveToolFailures.set(failKey, failCount)
                if (failCount > 1) {
                  toolResultOutput += `\n[Notice: Tool '${call.name}' with identical arguments has failed ${failCount} times. Do NOT call '${call.name}' with these identical failing arguments again. Please diagnose the failure or report it to the user.]`
                }
                if (activeStep) {
                  this.agentPlanner.failStep(activeStep.id, execResult.error || 'Execution failed')
                }
              }
            }

            // Context budget ceiling enforcement: cap tool output to stay within maxTotalContextChars
            const maxBudget = this.smartContextEngine.getConfig().maxTotalContextChars
            const currentHistoryChars = this.getHistoryCharCount()
            const remainingBudget = maxBudget - currentHistoryChars
            const overhead = 300 // JSON wrapper overhead for function message part

            if (remainingBudget <= overhead + 100) {
              toolResultOutput =
                '[Notice: Context budget exhausted (maximum total context limit reached). Additional tool output truncated.]'
            } else if (toolResultOutput.length > remainingBudget - overhead) {
              const truncationNotice = '\n[... Output truncated to stay within total context budget ...]'
              const maxAllowed = Math.max(100, remainingBudget - overhead - truncationNotice.length)
              toolResultOutput = toolResultOutput.slice(0, maxAllowed) + truncationNotice
            }

            safeOnStep?.({
              type: 'tool_result',
              toolName: call.name,
              toolArgs: call.args,
              toolOutput: toolResultOutput,
              toolSuccess
            })

            // Save tool response back into conversation history with strictly paired tool_call_id
            this.history.push({
              role: 'function',
              parts: [
                {
                  tool_call_id: toolCallId,
                  functionResponse: {
                    name: call.name,
                    response: {
                      name: call.name,
                      content: {
                        success: toolSuccess,
                        output: toolResultOutput
                      }
                    }
                  }
                }
              ]
            })

            this.pruneHistoryToBudget()
          }
          // Continue loop to let model produce final response
          continue
        }

        // Final response produced by model
        let finalText = response.text || 'Completed.'

        if (plan && plan.status === 'executing') {
          const allDone = plan.steps.every((s) => s.status === 'completed' || s.status === 'skipped')
          if (allDone) {
            plan.status = 'completed'
          }
        }

        this.history.push({
          role: 'model',
          parts: [{ text: finalText }]
        })

        const totalRequestTime = performance.now() - requestStartTime
        console.debug(
          `[AgentTiming] Total: ${totalRequestTime.toFixed(1)}ms | LLM: ${totalProviderTime.toFixed(1)}ms | Tools: ${totalToolTime.toFixed(1)}ms`
        )

        safeOnStep?.({ type: 'done', text: finalText })
        return finalText
      }

      if (plan && plan.status === 'executing' && plan === this.agentPlanner.getActivePlan() && this.activeRunId === runId) {
        const activeStep = plan.steps.find((s) => s.status === 'running' || s.status === 'pending')
        if (activeStep) {
          this.agentPlanner.failStep(activeStep.id, 'Maximum tool execution iterations reached')
        }
        this.agentPlanner.abortPlan('Maximum tool execution iterations reached')
      }

      const maxReachedText = 'Maximum tool execution iterations reached.'
      safeOnStep?.({ type: 'done', text: maxReachedText })
      return maxReachedText
    } catch (err: unknown) {
      if (this.activeRunId === runId) {
        const isAbort =
          runSignal.aborted ||
          (err instanceof Error && err.message === 'Request was stopped by user.')
        const abortReason = isAbort
          ? 'Request was stopped by user.'
          : (err instanceof Error ? err.message : String(err))

        if (plan && plan === this.agentPlanner.getActivePlan()) {
          if (plan.status === 'executing' || plan.status === 'planning') {
            this.agentPlanner.abortPlan(abortReason)
          }
        }

        this.sanitizeIncompleteTurns(abortReason, isAbort)
      }
      throw err
    } finally {
      isRunFinished = true
      if (this.abortController === runController) {
        this.abortController = null
      }
    }
  }
}
