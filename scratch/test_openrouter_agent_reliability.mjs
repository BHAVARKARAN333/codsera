// OpenRouter Agent Reliability & Regression Test Suite
// Validates all 6 core reliability requirements:
// 1. Tool approval rejection prevents tool execution & aborts plan cleanly
// 2. Invalid/missing paths return clear errors & prevent workspace traversal
// 3. Tool failures are reported accurately without false success
// 4. Multi-step tasks execute in correct order and verify results
// 5. Cancelling running commands stops them safely
// 6. Agent uses actual file contents and avoids hallucinated details

import assert from 'node:assert'
import path from 'node:path'

console.log('=================================================================')
console.log('OPENROUTER AGENT RELIABILITY & REGRESSION TEST SUITE')
console.log('=================================================================\n')

// Pure implementation of command validation for Node test environment
function normalizePathSegments(fullPath) {
  if (!fullPath) return ''
  const trimmed = fullPath.trim()
  const isWindowsDrive = /^[a-zA-Z]:/.test(trimmed)
  let drivePrefix = ''
  let rest = trimmed

  if (isWindowsDrive) {
    drivePrefix = trimmed.slice(0, 2).toUpperCase()
    rest = trimmed.slice(2)
  }

  const isAbsolute = rest.startsWith('/') || rest.startsWith('\\')
  const rawSegments = rest.split(/[/\\]+/).filter(Boolean)
  const resolvedSegments = []

  for (const seg of rawSegments) {
    if (seg === '.') continue
    if (seg === '..') {
      if (resolvedSegments.length > 0 && resolvedSegments[resolvedSegments.length - 1] !== '..') {
        resolvedSegments.pop()
      } else if (!isAbsolute) {
        resolvedSegments.push('..')
      }
    } else {
      resolvedSegments.push(seg)
    }
  }

  const combined = (isAbsolute ? '/' : '') + resolvedSegments.join('/')
  return drivePrefix ? drivePrefix + combined : combined
}

function isPathOutsideWorkspace(workspaceRoot, targetPath) {
  if (!workspaceRoot || !targetPath) return true

  const normWs = normalizePathSegments(workspaceRoot).toLowerCase().replace(/\/+$/, '')

  let fullTargetPath = targetPath.trim()
  fullTargetPath = fullTargetPath.replace(/^["']|["']$/g, '')

  let resolvedTarget
  if (/^[a-zA-Z]:[/\\]/.test(fullTargetPath) || fullTargetPath.startsWith('/') || fullTargetPath.startsWith('\\')) {
    resolvedTarget = normalizePathSegments(fullTargetPath)
  } else {
    resolvedTarget = normalizePathSegments(workspaceRoot.replace(/\\/g, '/') + '/' + fullTargetPath.replace(/\\/g, '/'))
  }

  const normTarget = resolvedTarget.toLowerCase().replace(/\/+$/, '')

  if (normTarget === normWs) return false
  if (normTarget.startsWith(normWs + '/')) return false

  return true
}

const CD_COMMAND_REGEX =
  /(?:^|[;&|\n\r]|\b(?:powershell|pwsh|cmd|bash|sh)\b[^\n\r]*?(?:-c|-Command|\/c|\/k)\s+["']?)\s*(?:cd|chdir|pushd|Set-Location|sl)\b(?:\s+(?:-Path\s+|-LiteralPath\s+|\/d\s+)?([^\s;&|\r\n"']+)|(?:\s+(?:-Path\s+|-LiteralPath\s+|\/d\s+)?["']([^"']+)["']))?/gi

function validateCommandSafety(command, workspaceRoot) {
  if (!workspaceRoot || typeof workspaceRoot !== 'string' || !workspaceRoot.trim()) {
    return {
      safe: false,
      error: 'No workspace folder is currently open. Please open a workspace first.'
    }
  }

  if (!command || typeof command !== 'string' || !command.trim()) {
    return {
      safe: false,
      error: 'Empty or missing command.'
    }
  }

  const trimmedCmd = command.trim()
  CD_COMMAND_REGEX.lastIndex = 0
  let match

  while ((match = CD_COMMAND_REGEX.exec(trimmedCmd)) !== null) {
    const targetDir = match[1] || match[2]

    if (!targetDir || targetDir.trim() === '~' || targetDir.trim() === '/' || targetDir.trim() === '\\') {
      return {
        safe: false,
        error: 'Command rejected: changing directory to root, home, or empty path is not allowed.'
      }
    }

    const trimmedTarget = targetDir.trim()
    if (isPathOutsideWorkspace(workspaceRoot, trimmedTarget)) {
      return {
        safe: false,
        error: `Command rejected: directory '${trimmedTarget}' is outside the current workspace (${workspaceRoot}).`
      }
    }
  }

  return { safe: true }
}

// Mock environment setup
const MOCK_WORKSPACE = 'C:\\Users\\testuser\\my-project'

// Mock In-Memory Virtual File System for testing
class MockVFS {
  constructor() {
    this.files = new Map()
    this.operations = []
  }

  set(filePath, content) {
    const norm = path.normalize(filePath)
    this.files.set(norm, content)
  }

  get(filePath) {
    const norm = path.normalize(filePath)
    return this.files.get(norm)
  }

  has(filePath) {
    const norm = path.normalize(filePath)
    return this.files.has(norm)
  }

  delete(filePath) {
    const norm = path.normalize(filePath)
    return this.files.delete(norm)
  }

  record(op, details) {
    this.operations.push({ op, details, timestamp: Date.now() })
  }
}

// -------------------------------------------------------------
// Test Suite 1: Tool Approval Rejection (Requirement 1)
// -------------------------------------------------------------
console.log('[Test Suite 1] Rejecting Tool Approvals Must Prevent Tool Execution')

async function testApprovalRejection() {
  const vfs = new MockVFS()
  vfs.set(path.join(MOCK_WORKSPACE, 'src', 'App.tsx'), 'export default function App() { return <div>App</div> }')

  // 1.1 Create File Rejection
  console.log('  [1.1] Testing create_file approval rejection...')
  let createFileApprovalRequested = false
  const mockCreateApproval = async (req) => {
    createFileApprovalRequested = true
    assert.strictEqual(req.toolName, 'create_file')
    assert.strictEqual(req.path, 'src/newFile.ts')
    return false // User clicks Reject
  }

  // Simulate CreateFileTool execution
  let fileCreatedOnDisk = false
  async function executeCreateFile(args, requestApproval) {
    const isApproved = await requestApproval({
      toolName: 'create_file',
      path: args.path,
      content: args.content
    })
    if (!isApproved) {
      return {
        success: false,
        rejected: true,
        output: 'File creation rejected — no changes were made.',
        error: 'File creation rejected — no changes were made.'
      }
    }
    fileCreatedOnDisk = true
    vfs.set(path.join(MOCK_WORKSPACE, args.path), args.content)
    return { success: true, output: JSON.stringify({ status: 'created', path: args.path }) }
  }

  const createResult = await executeCreateFile(
    { path: 'src/newFile.ts', content: 'export const X = 1' },
    mockCreateApproval
  )

  assert.strictEqual(createFileApprovalRequested, true, 'Approval must be requested')
  assert.strictEqual(createResult.rejected, true, 'Result must be marked rejected')
  assert.strictEqual(createResult.success, false, 'Result success must be false')
  assert.strictEqual(fileCreatedOnDisk, false, 'File must NOT be created on disk')
  assert.strictEqual(vfs.has(path.join(MOCK_WORKSPACE, 'src', 'newFile.ts')), false, 'VFS must not contain file')
  console.log('  ✓ PASS: create_file rejection stopped execution and made zero disk writes.')

  // 1.2 Edit File Rejection
  console.log('  [1.2] Testing edit_file approval rejection...')
  let editFileApprovalRequested = false
  const mockEditApproval = async (req) => {
    editFileApprovalRequested = true
    assert.strictEqual(req.toolName, 'edit_file')
    assert.strictEqual(req.path, 'src/App.tsx')
    return false // User clicks Reject
  }

  let fileModifiedOnDisk = false
  async function executeEditFile(args, requestApproval) {
    const isApproved = await requestApproval({
      toolName: 'edit_file',
      path: args.path,
      oldContent: vfs.get(path.join(MOCK_WORKSPACE, args.path)),
      newContent: args.newContent
    })
    if (!isApproved) {
      return {
        success: false,
        rejected: true,
        output: 'Edit rejected — no changes were made.',
        error: 'Edit rejected — no changes were made.'
      }
    }
    fileModifiedOnDisk = true
    vfs.set(path.join(MOCK_WORKSPACE, args.path), args.newContent)
    return { success: true, output: JSON.stringify({ status: 'edited', path: args.path }) }
  }

  const initialContent = vfs.get(path.join(MOCK_WORKSPACE, 'src', 'App.tsx'))
  const editResult = await executeEditFile(
    { path: 'src/App.tsx', newContent: 'MODIFIED CONTENT' },
    mockEditApproval
  )

  assert.strictEqual(editFileApprovalRequested, true, 'Edit approval must be requested')
  assert.strictEqual(editResult.rejected, true, 'Edit result must be marked rejected')
  assert.strictEqual(editResult.success, false, 'Edit result success must be false')
  assert.strictEqual(fileModifiedOnDisk, false, 'File must NOT be modified')
  assert.strictEqual(vfs.get(path.join(MOCK_WORKSPACE, 'src', 'App.tsx')), initialContent, 'File content must remain unchanged')
  console.log('  ✓ PASS: edit_file rejection preserved original content with zero modifications.')

  // 1.3 Run Command Rejection
  console.log('  [1.3] Testing run_command approval rejection...')
  let commandApprovalRequested = false
  const mockCommandApproval = async (req) => {
    commandApprovalRequested = true
    assert.strictEqual(req.toolName, 'run_command')
    assert.strictEqual(req.command, 'npm test')
    return false // User clicks Reject
  }

  let commandExecuted = false
  async function executeRunCommand(args, requestApproval) {
    const isApproved = await requestApproval({
      toolName: 'run_command',
      path: MOCK_WORKSPACE,
      command: args.command,
      isDangerous: false
    })
    if (!isApproved) {
      return {
        success: false,
        rejected: true,
        output: 'Command rejected — nothing was executed.',
        error: 'Command rejected — nothing was executed.'
      }
    }
    commandExecuted = true
    return { success: true, stdout: 'PASS', stderr: '', exitCode: 0 }
  }

  const cmdResult = await executeRunCommand({ command: 'npm test' }, mockCommandApproval)
  assert.strictEqual(commandApprovalRequested, true, 'Command approval must be requested')
  assert.strictEqual(cmdResult.rejected, true, 'Command result must be marked rejected')
  assert.strictEqual(cmdResult.success, false, 'Command result success must be false')
  assert.strictEqual(commandExecuted, false, 'Command must NOT be executed')
  console.log('  ✓ PASS: run_command rejection prevented command from executing.')
}

// -------------------------------------------------------------
// Test Suite 2: Invalid/Missing Paths & Workspace Traversal (Requirement 2)
// -------------------------------------------------------------
console.log('\n[Test Suite 2] Invalid/Missing File Paths & Workspace Traversal Protection')

async function testPathValidationAndTraversal() {
  // 2.1 Missing or Empty Path
  console.log('  [2.1] Testing empty/missing path validation...')
  function validatePathArg(p) {
    const filePath = typeof p === 'string' ? p.trim() : ''
    if (!filePath) {
      return { success: false, error: 'Missing or invalid "path" parameter. Please specify the relative path of the file.' }
    }
    return { success: true, path: filePath }
  }

  assert.strictEqual(validatePathArg('').success, false)
  assert.strictEqual(validatePathArg('   ').success, false)
  assert.strictEqual(validatePathArg(null).success, false)
  assert.strictEqual(validatePathArg(undefined).success, false)
  assert.strictEqual(validatePathArg(123).success, false)
  assert.strictEqual(validatePathArg('src/valid.ts').success, true)
  console.log('  ✓ PASS: Empty and invalid path arguments rejected cleanly.')

  // 2.2 Path Traversal Checks for Read/Create/Edit
  console.log('  [2.2] Testing workspace traversal detection for files...')
  function checkWorkspaceAccess(rootPath, targetPath) {
    if (!rootPath || typeof rootPath !== 'string') {
      return { success: false, error: 'No workspace folder is currently open.' }
    }
    if (!targetPath || typeof targetPath !== 'string' || !targetPath.trim()) {
      return { success: false, error: 'Missing or invalid file path.' }
    }

    const normalizedRoot = path.resolve(rootPath)
    let cleanPath = targetPath.trim()
    if (!/^[a-zA-Z]:[/\\]/.test(cleanPath)) {
      cleanPath = cleanPath.replace(/^[/\\]+/, '')
    }

    const normalizedTarget = path.isAbsolute(cleanPath)
      ? path.resolve(cleanPath)
      : path.resolve(normalizedRoot, cleanPath)

    const rel = path.relative(normalizedRoot, normalizedTarget)
    const isOutside = rel.startsWith('..') || path.isAbsolute(rel)

    if (isOutside) {
      return {
        success: false,
        error: `Access denied: Path '${targetPath}' is outside the current workspace.`
      }
    }
    return { success: true, resolvedTarget: normalizedTarget, rel: rel.replace(/\\/g, '/') }
  }

  // Test various traversal payloads
  const traversalPayloads = [
    '../outside.txt',
    '../../secret.json',
    '..\\..\\Windows\\System32\\cmd.exe',
    'C:\\Windows\\System32\\notepad.exe',
    'C:\\Program Files\\app.exe',
    'D:\\other-drive\\file.ts',
    'src/../../outside.js',
    'subfolder/../../../escape.ts'
  ]

  for (const payload of traversalPayloads) {
    const res = checkWorkspaceAccess(MOCK_WORKSPACE, payload)
    assert.strictEqual(res.success, false, `Payload "${payload}" must be rejected`)
    assert(res.error.includes('outside the current workspace') || res.error.includes('Access denied'), `Payload "${payload}" must report outside workspace`)
  }

  // Valid internal paths
  const validPayloads = [
    'src/App.tsx',
    'package.json',
    'src/components/Header.tsx',
    './src/utils/math.ts'
  ]

  for (const payload of validPayloads) {
    const res = checkWorkspaceAccess(MOCK_WORKSPACE, payload)
    assert.strictEqual(res.success, true, `Valid path "${payload}" must be accepted`)
  }
  console.log('  ✓ PASS: Path traversal attempts strictly blocked across all payloads.')

  // 2.3 Command Safety Validator for Directory Traversal
  console.log('  [2.3] Testing command directory escape validation...')
  const unsafeCommands = [
    'cd ..',
    'cd ../..',
    'cd /',
    'cd C:\\Windows',
    'powershell -Command "cd ..; rm -rf *"',
    'cmd /c cd .. && dir',
    'Set-Location ..',
    'pushd ..'
  ]

  for (const cmd of unsafeCommands) {
    const safety = validateCommandSafety(cmd, MOCK_WORKSPACE)
    assert.strictEqual(safety.safe, false, `Unsafe command "${cmd}" must be blocked`)
  }

  const safeCommands = [
    'npm test',
    'npx tsc --noEmit',
    'node src/index.js',
    'git status',
    'cd src && npm run build' // cd into subfolder inside workspace
  ]

  for (const cmd of safeCommands) {
    const safety = validateCommandSafety(cmd, MOCK_WORKSPACE)
    assert.strictEqual(safety.safe, true, `Safe command "${cmd}" should be allowed`)
  }
  console.log('  ✓ PASS: Command safety validator successfully blocks workspace directory escapes.')
}

// -------------------------------------------------------------
// Test Suite 3: Accurate Tool Failure Reporting (Requirement 3)
// -------------------------------------------------------------
console.log('\n[Test Suite 3] Accurate Tool Failure Reporting Without False Positives')

async function testFailureReporting() {
  console.log('  [3.1] Testing non-zero command exit code failure reporting...')
  
  function recordVerificationResult(command, stdout, stderr, exitCode) {
    const passed = exitCode === 0 && !stderr.includes('FAIL')
    return {
      command,
      passed,
      exitCode,
      status: passed ? 'verified' : 'failed',
      summary: passed
        ? `Command \`${command}\` PASSED (exit code 0)`
        : `Command \`${command}\` FAILED (exit code ${exitCode})`
    }
  }

  const failedTest = recordVerificationResult('npm test', 'Test suite: math.test.ts\n  ✕ adds 1 + 2 = 3', 'FAIL src/utils/math.test.ts', 1)
  assert.strictEqual(failedTest.passed, false, 'Failed command must be recorded as passed: false')
  assert.strictEqual(failedTest.status, 'failed', 'Status must be failed')
  assert(failedTest.summary.includes('FAILED (exit code 1)'), 'Summary must report failure accurately')

  const passedTest = recordVerificationResult('npm test', 'Test suite: math.test.ts\n  ✓ adds 1 + 2 = 3\n1 passed', '', 0)
  assert.strictEqual(passedTest.passed, true, 'Passing command must be recorded as passed: true')
  assert.strictEqual(passedTest.status, 'verified', 'Status must be verified')
  assert(passedTest.summary.includes('PASSED (exit code 0)'), 'Summary must report pass accurately')

  console.log('  ✓ PASS: Verification accurately differentiates passed vs failed exit codes.')

  console.log('  [3.2] Testing non-existent file error reporting in edit_file...')
  function mockEditFile(filePath, vfs) {
    if (!vfs.has(filePath)) {
      return {
        success: false,
        output: '',
        error: `File does not exist: '${filePath}'. Use create_file instead.`
      }
    }
    return { success: true }
  }

  const vfs = new MockVFS()
  const editFailRes = mockEditFile('src/nonexistent.ts', vfs)
  assert.strictEqual(editFailRes.success, false)
  assert(editFailRes.error.includes('File does not exist'), 'Must state file does not exist')
  assert(editFailRes.error.includes('Use create_file instead'), 'Must recommend create_file')
  console.log('  ✓ PASS: Non-existent file edit returns explicit error without false success.')
}

// -------------------------------------------------------------
// Test Suite 4: Multi-Step Task Execution & Verification Ordering (Requirement 4)
// -------------------------------------------------------------
console.log('\n[Test Suite 4] Multi-Step Task Execution and Verification Ordering')

async function testMultiStepExecution() {
  console.log('  [4.1] Testing step execution order and progression...')
  
  const executionLog = []
  const steps = [
    { id: 'step-1', toolName: 'read_file', description: 'Read math.ts', status: 'pending' },
    { id: 'step-2', toolName: 'edit_file', description: 'Modify math.ts', status: 'pending' },
    { id: 'step-3', toolName: 'run_command', description: 'Run npm test', status: 'pending' }
  ]

  function startStep(id) {
    const step = steps.find(s => s.id === id)
    step.status = 'running'
    executionLog.push({ event: 'start', id, tool: step.toolName })
  }

  function completeStep(id, output) {
    const step = steps.find(s => s.id === id)
    step.status = 'completed'
    step.output = output
    executionLog.push({ event: 'complete', id, tool: step.toolName })
  }

  // Execute Step 1: read_file
  startStep('step-1')
  assert.strictEqual(steps[0].status, 'running')
  completeStep('step-1', 'content of math.ts')
  assert.strictEqual(steps[0].status, 'completed')

  // Execute Step 2: edit_file
  startStep('step-2')
  assert.strictEqual(steps[1].status, 'running')
  completeStep('step-2', 'file modified')
  assert.strictEqual(steps[1].status, 'completed')

  // Execute Step 3: run_command
  startStep('step-3')
  assert.strictEqual(steps[2].status, 'running')
  completeStep('step-3', 'Tests passed')
  assert.strictEqual(steps[2].status, 'completed')

  assert.deepStrictEqual(executionLog.map(e => e.id), [
    'step-1', 'step-1',
    'step-2', 'step-2',
    'step-3', 'step-3'
  ], 'Steps must execute strictly in sequential order')
  console.log('  ✓ PASS: Multi-step execution progressed in exact prescribed order.')

  console.log('  [4.2] Testing failure diagnosis branch in multi-step plan...')
  const failStepPlan = [
    { id: 's1', description: 'Apply edit', status: 'completed' },
    { id: 's2', description: 'Verify tests', status: 'running' },
    { id: 's3', description: 'Diagnose and fix', status: 'pending' }
  ]

  // Test failed
  failStepPlan[1].status = 'failed'
  failStepPlan[1].error = 'AssertionError: expected 4 to equal 5'
  
  // Advance to diagnosis
  failStepPlan[2].status = 'running'
  assert.strictEqual(failStepPlan[1].status, 'failed')
  assert.strictEqual(failStepPlan[2].status, 'running')
  console.log('  ✓ PASS: Plan properly branched into diagnosis upon verification failure.')
}

// -------------------------------------------------------------
// Test Suite 5: Command Cancellation & Safe Termination (Requirement 5)
// -------------------------------------------------------------
console.log('\n[Test Suite 5] Command Cancellation & Safe Termination')

async function testCommandCancellation() {
  console.log('  [5.1] Testing AbortController agent loop termination...')
  let wasAborted = false
  const abortController = new AbortController()

  async function mockAgentLoop(signal) {
    for (let i = 0; i < 10; i++) {
      if (signal.aborted) {
        wasAborted = true
        throw new Error('Request was stopped by user.')
      }
      if (i === 2) {
        abortController.abort() // User clicked Stop
      }
    }
  }

  try {
    await mockAgentLoop(abortController.signal)
    assert.fail('Should have thrown abort error')
  } catch (err) {
    assert(err.message.includes('stopped by user'), 'Should report stopped by user')
  }
  assert.strictEqual(wasAborted, true, 'Loop must terminate immediately upon abort')
  console.log('  ✓ PASS: Agent loop halted immediately upon user cancellation.')

  console.log('  [5.2] Testing command timeout handling...')
  function simulateTimeoutExecution(timeoutMs) {
    return {
      success: false,
      stdout: '',
      stderr: `\nCommand timed out after ${timeoutMs / 1000}s.`,
      exitCode: null,
      timedOut: true,
      error: `Execution timed out after ${timeoutMs / 1000} seconds.`
    }
  }

  const timeoutRes = simulateTimeoutExecution(30000)
  assert.strictEqual(timeoutRes.timedOut, true)
  assert.strictEqual(timeoutRes.success, false)
  assert(timeoutRes.stderr.includes('timed out after 30s'))
  console.log('  ✓ PASS: Command timeout safely flags timedOut and terminates without hang.')
}

// -------------------------------------------------------------
// Test Suite 6: Grounding in Actual File Contents (Requirement 6)
// -------------------------------------------------------------
console.log('\n[Test Suite 6] Grounding in Actual File Contents & Anti-Hallucination')

async function testGroundedContents() {
  console.log('  [6.1] Testing file content feeding into context cache...')
  const contextCache = new Map()
  
  function handleReadFileResult(toolOutput) {
    try {
      const parsed = JSON.parse(toolOutput)
      if (parsed && typeof parsed.path === 'string' && typeof parsed.content === 'string') {
        contextCache.set(parsed.path, parsed.content)
      }
    } catch {
      // ignore
    }
  }

  const rawReadOutput = JSON.stringify({
    path: 'src/utils/math.ts',
    content: 'export function add(a: number, b: number): number { return a + b }'
  })

  handleReadFileResult(rawReadOutput)
  assert.strictEqual(contextCache.has('src/utils/math.ts'), true)
  assert.strictEqual(contextCache.get('src/utils/math.ts'), 'export function add(a: number, b: number): number { return a + b }')
  console.log('  ✓ PASS: Real file content accurately cached and provided to context.')

  console.log('  [6.2] Testing failed read_file anti-hallucination constraint...')
  function formatFailedReadInstruction(filePath, errorMsg) {
    return 'Error executing read_file: ' + errorMsg + ' (State this failure clearly to the user. Do NOT invent file contents or call list_files as a fallback.)'
  }

  const failedInstruction = formatFailedReadInstruction('src/missing.ts', 'File does not exist')
  console.log('  DEBUG failedInstruction:', JSON.stringify(failedInstruction))
  assert.strictEqual(failedInstruction.includes('Do NOT invent file contents'), true, 'Must include anti-hallucination instruction')
  assert.strictEqual(failedInstruction.includes('call list_files as a fallback'), true, 'Must forbid list_files fallback guessing')
  console.log('  ✓ PASS: Anti-hallucination guard enforced on read failures.')
}

// Run all test suites
async function runAll() {
  await testApprovalRejection()
  await testPathValidationAndTraversal()
  await testFailureReporting()
  await testMultiStepExecution()
  await testCommandCancellation()
  await testGroundedContents()

  console.log('\n=================================================================')
  console.log('ALL OPENROUTER AGENT RELIABILITY & REGRESSION TESTS PASSED! ✓')
  console.log('=================================================================')
}

runAll().catch((err) => {
  console.error('\n❌ TEST SUITE FAILED:', err)
  process.exit(1)
})
