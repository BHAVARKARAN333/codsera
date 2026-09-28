/**
 * Agent Planner - Phase 4
 * Provides structured planning, task classification, deterministic step state machines,
 * and execution progress tracking for multi-step coding workflows.
 */

export type StepStatus =
  | 'pending'
  | 'running'
  | 'waiting_for_approval'
  | 'completed'
  | 'failed'
  | 'skipped'

export interface AgentPlanStep {
  id: string
  description: string
  status: StepStatus
  toolName?: string
  targetFile?: string
  command?: string
  output?: string
  error?: string
}

export interface AgentPlan {
  goal: string
  steps: AgentPlanStep[]
  currentStepIndex: number
  status: 'planning' | 'executing' | 'completed' | 'failed' | 'aborted'
  filesModified: string[]
  filesCreated: string[]
  verificationCommand?: string
  verificationPassed?: boolean
  failureReason?: string
}

export interface PlannerContext {
  primaryFile?: string
  candidateFiles?: string[]
  affectedFiles?: string[]
  likelyTests?: string[]
}

export class AgentPlanner {
  private activePlan: AgentPlan | null = null
  private debug = false

  constructor(debug = false) {
    this.debug = debug
  }

  setDebug(enabled: boolean): void {
    this.debug = enabled
  }

  getActivePlan(): AgentPlan | null {
    return this.activePlan
  }

  clearPlan(): void {
    this.activePlan = null
  }

  /**
   * Determines if a user prompt requires a structured multi-step execution plan.
   */
  requiresMultiStepPlan(prompt: string): boolean {
    const trimmed = prompt.trim()
    if (!trimmed) return false

    const lower = trimmed.toLowerCase()

    // 1. General questions & greetings (never multi-step)
    const generalRegex =
      /^(hi|hello|hey|who are you|what is|what are|explain|describe|define)\s+(python|recursion|rest api|git|docker|math\.ts|[a-zA-Z0-9_.-]+)\b[?.]*$/i
    if (generalRegex.test(trimmed)) {
      return false
    }

    // 2. Simple single-file explanations without action verbs
    if (
      (lower.startsWith('explain ') || lower.startsWith('what does ') || lower.startsWith('show ')) &&
      !lower.includes(' and ') &&
      !lower.includes(' then ') &&
      !lower.includes('test') &&
      !lower.includes('fix') &&
      !lower.includes('add') &&
      !lower.includes('edit') &&
      !lower.includes('create')
    ) {
      return false
    }

    // 3. Multi-action indicators
    const hasMultipleActions =
      (lower.includes(' and ') || lower.includes(' then ') || lower.includes(' after that ')) &&
      (lower.includes('add') ||
        lower.includes('edit') ||
        lower.includes('create') ||
        lower.includes('fix') ||
        lower.includes('test') ||
        lower.includes('run') ||
        lower.includes('verify'))

    const isExplicitMultiStep =
      lower.includes('create a test') ||
      lower.includes('run the test') ||
      lower.includes('run tests') ||
      lower.includes('fix the failing') ||
      lower.includes('fix this problem and verify') ||
      lower.includes('implement and test') ||
      lower.includes('refactor and verify')

    return hasMultipleActions || isExplicitMultiStep
  }

  /**
   * Generates a structured plan based on the user's prompt and resolved workspace context.
   */
  createPlan(prompt: string, context?: PlannerContext): AgentPlan | null {
    if (!this.requiresMultiStepPlan(prompt)) {
      return null
    }

    const lower = prompt.toLowerCase()
    const steps: AgentPlanStep[] = []
    let stepCount = 0

    // Extract file target if mentioned
    const fileMatches = prompt.match(/[a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]{1,8}/g) || []
    const targetFile = fileMatches.length > 0 ? fileMatches[0] : context?.primaryFile

    // Step 1: Inspect target/relevant files
    if (targetFile) {
      stepCount++
      steps.push({
        id: `step_${stepCount}`,
        description: `Inspect ${targetFile} to understand the current implementation`,
        status: 'pending',
        toolName: 'read_file',
        targetFile
      })
    } else {
      stepCount++
      steps.push({
        id: `step_${stepCount}`,
        description: 'Inspect workspace files to locate relevant code',
        status: 'pending',
        toolName: 'read_file'
      })
    }

    // Step 2: Code modifications (if asked to add/edit/update/fix/refactor)
    if (
      lower.includes('add') ||
      lower.includes('edit') ||
      lower.includes('update') ||
      lower.includes('modify') ||
      lower.includes('fix') ||
      lower.includes('refactor')
    ) {
      stepCount++
      const editDesc = targetFile
        ? `Propose required modifications to ${targetFile}`
        : 'Propose required code modifications'
      steps.push({
        id: `step_${stepCount}`,
        description: editDesc,
        status: 'pending',
        toolName: 'edit_file',
        targetFile
      })
    }

    // Step 3: Test file creation (if asked to create a test)
    if (
      lower.includes('create a test') ||
      lower.includes('create test') ||
      lower.includes('add test') ||
      lower.includes('write test')
    ) {
      stepCount++
      const testFileName = targetFile
        ? targetFile.replace(/\.(ts|js|tsx|jsx)$/, '.test.$1')
        : 'test file'
      steps.push({
        id: `step_${stepCount}`,
        description: `Create test file ${testFileName}`,
        status: 'pending',
        toolName: 'create_file',
        targetFile: testFileName
      })
    }

    // Step 4: Verification command execution (if asked to run/test/verify)
    if (
      lower.includes('run the test') ||
      lower.includes('run tests') ||
      lower.includes('run test') ||
      lower.includes('verify') ||
      lower.includes('execute test')
    ) {
      stepCount++
      steps.push({
        id: `step_${stepCount}`,
        description: 'Execute verification test command',
        status: 'pending',
        toolName: 'run_command'
      })

      // Step 5: Error recovery (if verification fails)
      stepCount++
      steps.push({
        id: `step_${stepCount}`,
        description: 'Diagnose and propose corrective fixes if verification encounters failures',
        status: 'pending'
      })
    }

    // Final step: Summary & report
    stepCount++
    steps.push({
      id: `step_${stepCount}`,
      description: 'Verify final result and report outcome',
      status: 'pending'
    })

    const plan: AgentPlan = {
      goal: prompt.trim(),
      steps,
      currentStepIndex: 0,
      status: 'executing',
      filesModified: [],
      filesCreated: []
    }

    this.activePlan = plan

    if (this.debug) {
      console.debug(
        `[AgentPlanner] Created plan with ${steps.length} steps for: "${prompt}"`
      )
    }

    return plan
  }

  /**
   * Advances the state of a step to 'running'.
   */
  startStep(stepId: string): void {
    if (!this.activePlan) return
    const step = this.activePlan.steps.find((s) => s.id === stepId)
    if (step) {
      step.status = 'running'
    }
  }

  /**
   * Sets step status to 'waiting_for_approval'.
   */
  setWaitingForApproval(stepId: string): void {
    if (!this.activePlan) return
    const step = this.activePlan.steps.find((s) => s.id === stepId)
    if (step) {
      step.status = 'waiting_for_approval'
    }
  }

  /**
   * Marks a step as 'completed'.
   */
  completeStep(stepId: string, output?: string): void {
    if (!this.activePlan) return
    const stepIndex = this.activePlan.steps.findIndex((s) => s.id === stepId)
    if (stepIndex !== -1) {
      const step = this.activePlan.steps[stepIndex]
      step.status = 'completed'
      if (output) step.output = output
      this.activePlan.currentStepIndex = stepIndex + 1

      // Check if all steps completed
      const allDone = this.activePlan.steps.every(
        (s) => s.status === 'completed' || s.status === 'skipped'
      )
      if (allDone) {
        this.activePlan.status = 'completed'
      }
    }
  }

  /**
   * Marks a step as 'failed'.
   */
  failStep(stepId: string, error?: string): void {
    if (!this.activePlan) return
    const step = this.activePlan.steps.find((s) => s.id === stepId)
    if (step) {
      step.status = 'failed'
      if (error) step.error = error
    }
  }

  /**
   * Aborts the entire plan (e.g. after a rejection).
   */
  abortPlan(reason: string): void {
    if (!this.activePlan) return
    this.activePlan.status = 'aborted'
    this.activePlan.failureReason = reason

    for (const step of this.activePlan.steps) {
      if (step.status === 'running' || step.status === 'waiting_for_approval') {
        step.status = 'failed'
        step.error = reason
      } else if (step.status === 'pending') {
        step.status = 'skipped'
      }
    }

    if (this.debug) {
      console.debug(`[AgentPlanner] Plan aborted: ${reason}`)
    }
  }

  /**
   * Records a modified file.
   */
  recordFileModified(filePath: string): void {
    if (!this.activePlan) return
    if (!this.activePlan.filesModified.includes(filePath)) {
      this.activePlan.filesModified.push(filePath)
    }
  }

  /**
   * Records a created file.
   */
  recordFileCreated(filePath: string): void {
    if (!this.activePlan) return
    if (!this.activePlan.filesCreated.includes(filePath)) {
      this.activePlan.filesCreated.push(filePath)
    }
  }

  /**
   * Records a verification command and result.
   */
  recordVerification(command: string, passed: boolean): void {
    if (!this.activePlan) return
    this.activePlan.verificationCommand = command
    this.activePlan.verificationPassed = passed
  }

  /**
   * Formats a structured plan string for system prompt injection.
   */
  formatPlanContext(plan: AgentPlan): string {
    const stepLines = plan.steps.map((s, idx) => {
      let icon = '[ ]'
      if (s.status === 'completed') icon = '[x]'
      else if (s.status === 'running') icon = '[>]'
      else if (s.status === 'waiting_for_approval') icon = '[?]'
      else if (s.status === 'failed') icon = '[!]'
      else if (s.status === 'skipped') icon = '[-]'
      return `${idx + 1}. ${icon} ${s.description} (Status: ${s.status})`
    })

    return `[Structured Execution Plan]:\nGoal: ${plan.goal}\nPlan Status: ${plan.status}\n\nExecution Steps:\n${stepLines.join('\n')}\n\nPlan Execution Directives:\n- Execute the next pending step in order.\n- Propose required file modifications ('edit_file') and creations ('create_file') through the approval flow.\n- Wait for explicit user approval before considering modifications applied.\n- Do NOT repeat completed steps unnecessarily.\n- For verification ('run_command'), capture exact output and verify exitCode === 0 before declaring success.\n- If a verification command fails, analyze the exact error output and propose a corrective edit.`
  }

  /**
   * Generates a final factual summary formatted to Section 11 specifications.
   */
  formatFinalSummary(plan: AgentPlan): string {
    if (plan.status === 'aborted' || plan.status === 'failed') {
      return `### Execution Summary\n**Status**: Incomplete / Aborted\n**Reason**: ${plan.failureReason || 'One or more required steps were rejected or failed.'}`
    }

    const completedSteps = plan.steps.filter((s) => s.status === 'completed')
    const completedLines = completedSteps.map((s) => `- ${s.description}`)

    const changedFiles = [
      ...plan.filesModified.map((f) => `- ${f} (Modified)`),
      ...plan.filesCreated.map((f) => `- ${f} (Created)`)
    ]

    let verificationSection = 'Not requested'
    if (plan.verificationCommand) {
      const statusStr = plan.verificationPassed ? 'PASSED (exit code 0)' : 'FAILED'
      verificationSection = `Command: \`${plan.verificationCommand}\`\nResult: ${statusStr}`
    }

    return `### Execution Summary\n**Goal**: ${plan.goal}\n\n**Completed Steps**:\n${completedLines.length > 0 ? completedLines.join('\n') : '- None'}\n\n**Files Changed**:\n${changedFiles.length > 0 ? changedFiles.join('\n') : '- None'}\n\n**Verification**:\n${verificationSection}`
  }
}
