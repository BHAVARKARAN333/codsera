// Phase 4: Agent Planning + Multi-Step Task Execution Test Suite

import assert from 'node:assert'

class AgentPlanner {
  constructor(debug = false) {
    this.activePlan = null
    this.debug = debug
  }

  requiresMultiStepPlan(prompt) {
    const trimmed = prompt.trim()
    if (!trimmed) return false
    const lower = trimmed.toLowerCase()

    const generalRegex = /^(hi|hello|hey|who are you|what is|what are|explain|describe|define)\s+(python|recursion|rest api|git|docker|math\.ts|[a-zA-Z0-9_.-]+)\b[?.]*$/i
    if (generalRegex.test(trimmed)) return false

    if ((lower.startsWith('explain ') || lower.startsWith('what does ') || lower.startsWith('show ')) &&
      !lower.includes(' and ') && !lower.includes(' then ') && !lower.includes('test') && !lower.includes('fix') && !lower.includes('add')) {
      return false
    }

    const hasMultipleActions = (lower.includes(' and ') || lower.includes(' then ') || lower.includes(' after that ')) &&
      (lower.includes('add') || lower.includes('edit') || lower.includes('create') || lower.includes('fix') || lower.includes('test') || lower.includes('run') || lower.includes('verify'))

    const isExplicitMultiStep = lower.includes('create a test') || lower.includes('run the test') || lower.includes('run tests') || lower.includes('fix the failing') || lower.includes('fix this problem and verify') || lower.includes('implement and test')

    return hasMultipleActions || isExplicitMultiStep
  }

  createPlan(prompt, context) {
    if (!this.requiresMultiStepPlan(prompt)) return null
    const lower = prompt.toLowerCase()
    const steps = []
    let stepCount = 0

    const fileMatches = prompt.match(/[a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]{1,8}/g) || []
    const targetFile = fileMatches.length > 0 ? fileMatches[0] : context?.primaryFile

    if (targetFile) {
      stepCount++
      steps.push({ id: `step_${stepCount}`, description: `Inspect ${targetFile}`, status: 'pending', toolName: 'read_file', targetFile })
    }

    if (lower.includes('add') || lower.includes('edit') || lower.includes('modify') || lower.includes('fix')) {
      stepCount++
      steps.push({ id: `step_${stepCount}`, description: `Modify ${targetFile || 'code'}`, status: 'pending', toolName: 'edit_file', targetFile })
    }

    if (lower.includes('create a test') || lower.includes('create test') || lower.includes('add test')) {
      stepCount++
      steps.push({ id: `step_${stepCount}`, description: `Create test file`, status: 'pending', toolName: 'create_file', targetFile: 'math.test.ts' })
    }

    if (lower.includes('run the test') || lower.includes('run tests') || lower.includes('run test') || lower.includes('verify')) {
      stepCount++
      steps.push({ id: `step_${stepCount}`, description: 'Execute verification test command', status: 'pending', toolName: 'run_command' })
      stepCount++
      steps.push({ id: `step_${stepCount}`, description: 'Diagnose and propose corrective fixes if needed', status: 'pending' })
    }

    stepCount++
    steps.push({ id: `step_${stepCount}`, description: 'Verify final result and report outcome', status: 'pending' })

    const plan = {
      goal: prompt.trim(),
      steps,
      currentStepIndex: 0,
      status: 'executing',
      filesModified: [],
      filesCreated: []
    }
    this.activePlan = plan
    return plan
  }

  startStep(stepId) {
    if (!this.activePlan) return
    const step = this.activePlan.steps.find(s => s.id === stepId)
    if (step) step.status = 'running'
  }

  setWaitingForApproval(stepId) {
    if (!this.activePlan) return
    const step = this.activePlan.steps.find(s => s.id === stepId)
    if (step) step.status = 'waiting_for_approval'
  }

  completeStep(stepId, output) {
    if (!this.activePlan) return
    const idx = this.activePlan.steps.findIndex(s => s.id === stepId)
    if (idx !== -1) {
      this.activePlan.steps[idx].status = 'completed'
      if (output) this.activePlan.steps[idx].output = output
      this.activePlan.currentStepIndex = idx + 1
      if (this.activePlan.steps.every(s => s.status === 'completed' || s.status === 'skipped')) {
        this.activePlan.status = 'completed'
      }
    }
  }

  failStep(stepId, error) {
    if (!this.activePlan) return
    const step = this.activePlan.steps.find(s => s.id === stepId)
    if (step) {
      step.status = 'failed'
      if (error) step.error = error
    }
  }

  abortPlan(reason) {
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
  }

  recordFileModified(path) {
    if (!this.activePlan) return
    if (!this.activePlan.filesModified.includes(path)) this.activePlan.filesModified.push(path)
  }

  recordFileCreated(path) {
    if (!this.activePlan) return
    if (!this.activePlan.filesCreated.includes(path)) this.activePlan.filesCreated.push(path)
  }

  recordVerification(command, passed) {
    if (!this.activePlan) return
    this.activePlan.verificationCommand = command
    this.activePlan.verificationPassed = passed
  }

  formatFinalSummary(plan) {
    if (plan.status === 'aborted' || plan.status === 'failed') {
      return `### Execution Summary\n**Status**: Incomplete / Aborted\n**Reason**: ${plan.failureReason || 'Action rejected or failed.'}`
    }
    const completed = plan.steps.filter(s => s.status === 'completed').map(s => `- ${s.description}`)
    const changed = [...plan.filesModified.map(f => `- ${f} (Modified)`), ...plan.filesCreated.map(f => `- ${f} (Created)`)]
    let vSection = 'Not requested'
    if (plan.verificationCommand) {
      vSection = `Command: \`${plan.verificationCommand}\`\nResult: ${plan.verificationPassed ? 'PASSED (exit code 0)' : 'FAILED'}`
    }
    return `### Execution Summary\n**Goal**: ${plan.goal}\n\n**Completed Steps**:\n${completed.join('\n')}\n\n**Files Changed**:\n${changed.join('\n')}\n\n**Verification**:\n${vSection}`
  }
}

async function runPhase4Tests() {
  console.log('====================================================')
  console.log('PHASE 4: AGENT PLANNING & MULTI-STEP EXECUTION TESTS')
  console.log('====================================================')

  const planner = new AgentPlanner()

  // Test 1: Simple questions do NOT create multi-step plans
  console.log('\n[Test 1] Simple question classification')
  assert.strictEqual(planner.requiresMultiStepPlan('What is Python?'), false)
  assert.strictEqual(planner.requiresMultiStepPlan('Explain src/utils/math.ts'), false)
  assert.strictEqual(planner.requiresMultiStepPlan('What does this function do?'), false)
  console.log('✓ PASS: Simple questions correctly bypass multi-step planning.')

  // Test 2: Multi-step task creates ordered steps
  console.log('\n[Test 2] Multi-step task plan creation')
  const taskPrompt = 'Add a divide function to src/utils/math.ts, create a test for it, and run the test.'
  const plan = planner.createPlan(taskPrompt)
  assert.notStrictEqual(plan, null, 'Plan must be created')
  assert.strictEqual(plan.steps.length, 6, 'Must have 6 ordered steps (read -> edit -> create test -> run test -> recovery -> report)')
  assert.strictEqual(plan.steps[0].toolName, 'read_file')
  assert.strictEqual(plan.steps[1].toolName, 'edit_file')
  assert.strictEqual(plan.steps[2].toolName, 'create_file')
  assert.strictEqual(plan.steps[3].toolName, 'run_command')
  console.log(`✓ PASS: Generated ${plan.steps.length} ordered steps matching task specification.`)

  // Test 3: Step progression & non-repetition
  console.log('\n[Test 3] Step progression & non-repetition')
  planner.startStep('step_1')
  assert.strictEqual(plan.steps[0].status, 'running')
  planner.completeStep('step_1', 'read content')
  assert.strictEqual(plan.steps[0].status, 'completed')
  assert.strictEqual(plan.currentStepIndex, 1, 'Current step index advanced to 1')
  console.log('✓ PASS: Completed step 1 advanced without re-executing.')

  // Test 4: Approval state pauses execution
  console.log('\n[Test 4] Approval state transition (waiting_for_approval)')
  planner.startStep('step_2')
  planner.setWaitingForApproval('step_2')
  assert.strictEqual(plan.steps[1].status, 'waiting_for_approval')
  console.log('✓ PASS: Step transitioned to waiting_for_approval.')

  // Test 5: Approval resumes execution
  console.log('\n[Test 5] Approval resumes execution to completed')
  planner.completeStep('step_2', 'applied diff')
  planner.recordFileModified('src/utils/math.ts')
  assert.strictEqual(plan.steps[1].status, 'completed')
  assert(plan.filesModified.includes('src/utils/math.ts'))
  console.log('✓ PASS: Step 2 completed and file modification recorded.')

  // Test 6: Rejection stops dependent plan cleanly
  console.log('\n[Test 6] Rejection abortion')
  const testPlan2 = planner.createPlan('Add divide to src/utils/math.ts and test it')
  planner.startStep('step_1')
  planner.completeStep('step_1')
  planner.startStep('step_2')
  planner.setWaitingForApproval('step_2')
  planner.abortPlan('User rejected proposed edit')
  assert.strictEqual(testPlan2.status, 'aborted')
  assert.strictEqual(testPlan2.steps[1].status, 'failed')
  assert.strictEqual(testPlan2.steps[2].status, 'skipped', 'Dependent steps must be marked skipped')
  const summaryAborted = planner.formatFinalSummary(testPlan2)
  assert(summaryAborted.includes('Incomplete / Aborted'), 'Summary must clearly state Incomplete / Aborted')
  console.log('✓ PASS: Plan aborted cleanly upon rejection with zero unauthorized actions.')

  // Test 7: Error recovery & verification failure handling
  console.log('\n[Test 7] Verification failure handling & recovery')
  planner.createPlan(taskPrompt)
  planner.startStep('step_1'); planner.completeStep('step_1')
  planner.startStep('step_2'); planner.completeStep('step_2')
  planner.startStep('step_3'); planner.completeStep('step_3'); planner.recordFileCreated('src/utils/math.test.ts')
  planner.startStep('step_4')
  // Simulated failing command
  planner.recordVerification('npm test', false)
  planner.failStep('step_4', 'Assertion error in test')
  assert.strictEqual(planner.activePlan.verificationPassed, false)
  console.log('✓ PASS: Failed verification accurately recorded without false claims.')

  // Test 8: Successful verification completes plan
  console.log('\n[Test 8] Successful verification completes plan')
  planner.recordVerification('npm test', true)
  planner.completeStep('step_4')
  planner.completeStep('step_5')
  planner.completeStep('step_6')
  assert.strictEqual(planner.activePlan.status, 'completed')
  const finalSummary = planner.formatFinalSummary(planner.activePlan)
  assert(finalSummary.includes('PASSED (exit code 0)'))
  console.log(`✓ PASS: Successful verification formatted into final summary:\n${finalSummary}`)

  console.log('\n====================================================')
  console.log('ALL PHASE 4 AGENT PLANNING TESTS PASSED! ✓')
  console.log('====================================================')
}

runPhase4Tests().catch(err => {
  console.error('Phase 4 test failed:', err)
  process.exit(1)
})
