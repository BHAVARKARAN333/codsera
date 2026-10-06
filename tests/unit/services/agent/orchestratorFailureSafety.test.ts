import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { AgentOrchestrator, AgentStepEvent } from '@renderer/services/agent/orchestrator'
import { ListFilesTool } from '@renderer/services/tools/listFilesTool'
import { ReadFileTool } from '@renderer/services/tools/readFileTool'
import { CreateFileTool } from '@renderer/services/tools/createFileTool'
import {
  IAIProvider,
  LLMMessage,
  LLMResponse,
  FunctionDeclaration,
  LLMRequestOptions
} from '@renderer/services/ai/types'
import { setupMockElectron, resetMockElectron } from '../../../setup/electronMock'

class MockAIProvider implements IAIProvider {
  readonly id = 'mock-provider'
  readonly name = 'Mock Provider'
  readonly capabilities = {
    supportsStreaming: true,
    supportsTools: true,
    requiresApiKey: false
  }

  private responseQueue: LLMResponse[] = []
  public recordedCalls: Array<{
    messages: LLMMessage[]
    tools: FunctionDeclaration[]
    options: LLMRequestOptions
  }> = []

  enqueueResponse(response: LLMResponse): void {
    this.responseQueue.push(response)
  }

  clear(): void {
    this.responseQueue = []
    this.recordedCalls = []
  }

  async sendMessage(
    messages: LLMMessage[],
    tools: FunctionDeclaration[],
    options: LLMRequestOptions
  ): Promise<LLMResponse> {
    this.recordedCalls.push({
      messages: JSON.parse(JSON.stringify(messages)),
      tools,
      options
    })
    if (this.responseQueue.length > 0) {
      const resp = this.responseQueue.shift()!
      if (resp.text && options.onChunk) {
        options.onChunk(resp.text)
      }
      return resp
    }
    return { text: 'Default mock response' }
  }
}

describe('AgentOrchestrator Failure Safety & Anti-Fabrication Suite', () => {
  let mockProvider: MockAIProvider
  let orchestrator: AgentOrchestrator

  beforeEach(() => {
    mockProvider = new MockAIProvider()
    orchestrator = new AgentOrchestrator(mockProvider)
    orchestrator.registerTool(new ListFilesTool())
    orchestrator.registerTool(new ReadFileTool())
    orchestrator.registerTool(new CreateFileTool())
  })

  afterEach(() => {
    resetMockElectron()
    mockProvider.clear()
    orchestrator.clearHistory()
  })

  // Test A: list_files succeeds -> AI summarizes actual returned files
  it('Test A: list_files succeeds -> AI summarizes actual returned files', async () => {
    setupMockElectron({
      listFiles: async () => ({
        success: true,
        treeString: '├── src\n│   ├── App.tsx\n│   └── index.ts\n└── package.json',
        totalFiles: 3,
        totalDirs: 1
      })
    })

    mockProvider.enqueueResponse({
      functionCalls: [{ name: 'list_files', args: { maxDepth: 4 } }]
    })
    mockProvider.enqueueResponse({
      text: 'The workspace contains 3 files: src/App.tsx, src/index.ts, and package.json organized under src and the root.'
    })

    const steps: AgentStepEvent[] = []
    const result = await orchestrator.run(
      'List the files in my current workspace and briefly explain the project structure.',
      {
        apiKey: 'test-key',
        workspaceRoot: '/mock/workspace',
        onStep: (e) => steps.push(e)
      }
    )

    expect(result).toContain('The workspace contains 3 files')
    expect(result).toContain('src/App.tsx')
    expect(result).not.toContain("I couldn't list the workspace files")

    const toolResultStep = steps.find(
      (s) => s.type === 'tool_result' && s.toolName === 'list_files'
    )
    expect(toolResultStep).toBeDefined()
    expect(toolResultStep?.toolSuccess).toBe(true)
    expect(toolResultStep?.toolOutput).toContain('Project Tree (3 files, 1 folders)')
  })

  // Test B: list_files fails -> AI does NOT fabricate a file listing, acknowledges failure
  it('Test B: list_files fails -> AI does NOT fabricate a file listing, acknowledges failure', async () => {
    setupMockElectron({
      listFiles: async () => ({
        success: false,
        error: 'EACCES: permission denied'
      })
    })

    mockProvider.enqueueResponse({
      functionCalls: [{ name: 'list_files', args: {} }]
    })
    // Simulate model attempting to hallucinate a complete file listing despite tool failure
    mockProvider.enqueueResponse({
      text: `Here is the complete project structure:
- package.json
- src/App.tsx
- src/index.ts
- vite.config.ts
- tsconfig.json
On branch master.`
    })

    const steps: AgentStepEvent[] = []
    const result = await orchestrator.run(
      'List the files in my current workspace and briefly explain the project structure. Do not modify any files.',
      {
        apiKey: 'test-key',
        workspaceRoot: '/mock/workspace',
        currentBranch: 'qa-test',
        onStep: (e) => steps.push(e)
      }
    )

    // Must acknowledge failure
    expect(result).toContain("I couldn't list the workspace files because the file-listing operation failed: EACCES: permission denied")
    // Must strip out the fabricated list
    expect(result).not.toContain('- vite.config.ts')
    expect(result).not.toContain('- tsconfig.json')
    // Must not report master branch when verified branch is qa-test
    expect(result).not.toContain('On branch master')
    expect(result).toContain('qa-test')

    const toolResultStep = steps.find(
      (s) => s.type === 'tool_result' && s.toolName === 'list_files'
    )
    expect(toolResultStep).toBeDefined()
    expect(toolResultStep?.toolSuccess).toBe(false)
  })

  // Test C: list_files returns empty/invalid result -> AI does NOT fabricate files
  it('Test C: list_files returns empty/invalid result -> AI does NOT fabricate files', async () => {
    setupMockElectron({
      listFiles: async () => ({
        success: false
        // missing treeString, invalid response
      })
    })

    mockProvider.enqueueResponse({
      functionCalls: [{ name: 'list_files', args: {} }]
    })
    mockProvider.enqueueResponse({
      text: `Here are the files:
\`\`\`
├── src/
│   └── main.py
└── requirements.txt
\`\`\``
    })

    const result = await orchestrator.run('Show me all project files.', {
      apiKey: 'test-key',
      workspaceRoot: '/mock/workspace'
    })

    // Must acknowledge failure
    expect(result).toContain("I couldn't list the workspace files because the file-listing operation failed")
    // Must strip out the fabricated tree block
    expect(result).not.toContain('main.py')
    expect(result).not.toContain('requirements.txt')
    expect(result).not.toContain('├── src/')
  })

  // Test D: list_files throws an exception -> AI reports inability/failure safely without unhandled error
  it('Test D: list_files throws an exception -> AI reports inability/failure safely without unhandled error', async () => {
    setupMockElectron({
      listFiles: async () => {
        throw new Error('IPC channel crashed unexpectedly')
      }
    })

    mockProvider.enqueueResponse({
      functionCalls: [{ name: 'list_files', args: {} }]
    })
    mockProvider.enqueueResponse({
      text: 'I was unable to list the files due to an internal error.'
    })

    const steps: AgentStepEvent[] = []
    const result = await orchestrator.run('List files in this folder.', {
      apiKey: 'test-key',
      workspaceRoot: '/mock/workspace',
      onStep: (e) => steps.push(e)
    })

    // Orchestrator handled exception gracefully without throwing
    expect(result).toBeDefined()
    expect(result).toMatch(/(unable to list|failed to list|could not list|couldn't list)/i)

    const toolResultStep = steps.find(
      (s) => s.type === 'tool_result' && s.toolName === 'list_files'
    )
    expect(toolResultStep?.toolSuccess).toBe(false)
    expect(toolResultStep?.toolOutput).toContain('IPC channel crashed unexpectedly')
  })

  it('Test D2: list_files throws exception and model attempts fabrication -> strips fabricated list and states failure', async () => {
    setupMockElectron({
      listFiles: async () => {
        throw new Error('Kernel crash')
      }
    })

    mockProvider.enqueueResponse({
      functionCalls: [{ name: 'list_files', args: {} }]
    })
    mockProvider.enqueueResponse({
      text: `Here is the complete file listing:
- index.html
- src/main.ts
- package.json`
    })

    const result = await orchestrator.run('List files in the workspace.', {
      apiKey: 'test-key',
      workspaceRoot: '/mock/workspace'
    })

    expect(result).toContain("I couldn't list the workspace files because the file-listing operation failed")
    expect(result).toContain('Kernel crash')
    expect(result).not.toContain('- index.html')
    expect(result).not.toContain('- src/main.ts')
  })

  // Test E: Tool failure followed by model response -> failed result cannot be treated as successful context
  it('Test E: Tool failure followed by model response -> failed result cannot be treated as successful context', async () => {
    setupMockElectron({
      listFiles: async () => ({
        success: false,
        error: 'Folder not found'
      })
    })

    mockProvider.enqueueResponse({
      functionCalls: [{ name: 'list_files', args: {} }]
    })
    mockProvider.enqueueResponse({
      text: 'I could not list the workspace files because the folder was not found.'
    })

    await orchestrator.run('List files.', {
      apiKey: 'test-key',
      workspaceRoot: '/mock/workspace'
    })

    // Verify the functionResponse delivered to the model recorded failure
    expect(mockProvider.recordedCalls.length).toBe(2)
    const secondCallMessages = mockProvider.recordedCalls[1].messages
    const functionMessage = secondCallMessages.find((m) => m.role === 'function')
    expect(functionMessage).toBeDefined()

    const functionResponsePart = functionMessage?.parts[0]?.functionResponse
    expect(functionResponsePart).toBeDefined()
    expect(functionResponsePart?.response.content.success).toBe(false)
    expect(String(functionResponsePart?.response.content.output)).toContain("Error: 'list_files' failed: Folder not found")
    expect(String(functionResponsePart?.response.content.output)).toContain('Do NOT invent, assume, or fabricate any file listing')
  })

  // Test F: Current branch is qa-test -> AI does not report master, uses qa-test
  it('Test F: Current branch is qa-test -> AI does not report master, uses qa-test', async () => {
    mockProvider.enqueueResponse({
      text: 'You are currently working on the master branch. Everything on master is up to date.'
    })

    const result = await orchestrator.run('What branch am I on?', {
      apiKey: 'test-key',
      workspaceRoot: '/mock/workspace',
      currentBranch: 'qa-test'
    })

    // Verify system instruction conveyed verified branch
    const firstCall = mockProvider.recordedCalls[0]
    expect(firstCall.options.systemInstruction).toContain('Verified Workspace Git State: The active Git branch in this workspace is "qa-test"')
    expect(firstCall.options.systemInstruction).toContain('NEVER claim "master", "main"')

    // Verify final text had false master claims replaced with verified qa-test branch
    expect(result).not.toContain('master branch')
    expect(result).toContain('qa-test branch')
  })

  // Test G: Branch information unavailable/stale -> AI avoids presenting unverified branch as fact
  it('Test G: Branch information unavailable/stale -> AI avoids presenting unverified branch as fact', async () => {
    mockProvider.enqueueResponse({
      text: '- Git Branch: master\nWorkspace files are ready.'
    })

    const result = await orchestrator.run('What is the project status?', {
      apiKey: 'test-key',
      workspaceRoot: '/mock/workspace',
      currentBranch: undefined
    })

    // Verify system instruction alerted model that branch is unverified
    const firstCall = mockProvider.recordedCalls[0]
    expect(firstCall.options.systemInstruction).toContain('Git Branch State: The current Git branch has not been verified.')

    // Verify final text sanitized unverified branch claim
    expect(result).toContain('- Git Branch: (unverified)')
    expect(result).not.toContain('- Git Branch: master')
  })

  // Test H: Existing successful tool workflows still work (read_file, create_file)
  describe('Test H: Existing successful tool workflows still work', () => {
    it('Test H1: read_file succeeds and returns content without false failure warnings', async () => {
      setupMockElectron({
        readWorkspaceFile: async (_root, relPath) => ({
          success: true,
          path: relPath,
          content: 'export const App = () => <h1>Hello World</h1>'
        })
      })

      mockProvider.enqueueResponse({
        functionCalls: [{ name: 'read_file', args: { path: 'src/App.tsx' } }]
      })
      mockProvider.enqueueResponse({
        text: 'The file src/App.tsx contains a simple React component that renders "Hello World".'
      })

      const steps: AgentStepEvent[] = []
      const result = await orchestrator.run('Read src/App.tsx and explain what it does.', {
        apiKey: 'test-key',
        workspaceRoot: '/mock/workspace',
        onStep: (e) => steps.push(e)
      })

      expect(result).toContain('renders "Hello World"')
      expect(result).not.toContain("I couldn't read the requested file")

      const toolResultStep = steps.find(
        (s) => s.type === 'tool_result' && s.toolName === 'read_file'
      )
      expect(toolResultStep?.toolSuccess).toBe(true)
      expect(toolResultStep?.toolOutput).toContain('Hello World')
    })

    it('Test H2: create_file succeeds after approval and notifies listeners', async () => {
      setupMockElectron({
        createWorkspaceFile: async (_root, relPath) => ({
          success: true,
          path: relPath
        })
      })

      mockProvider.enqueueResponse({
        functionCalls: [
          {
            name: 'create_file',
            args: { path: 'src/utils/math.ts', content: 'export const sum = (a: number, b: number) => a + b' }
          }
        ]
      })
      mockProvider.enqueueResponse({
        text: 'Successfully created src/utils/math.ts with the sum function.'
      })

      const createdFiles: string[] = []
      const approvalHandler = vi.fn().mockResolvedValue(true)

      const result = await orchestrator.run('Create a new math utility file src/utils/math.ts.', {
        apiKey: 'test-key',
        workspaceRoot: '/mock/workspace',
        requestApproval: approvalHandler,
        onFileCreated: (p) => createdFiles.push(p)
      })

      expect(approvalHandler).toHaveBeenCalledWith({
        toolName: 'create_file',
        path: 'src/utils/math.ts',
        content: 'export const sum = (a: number, b: number) => a + b'
      })
      expect(createdFiles).toContain('src/utils/math.ts')
      expect(result).toContain('Successfully created src/utils/math.ts')
    })
  })
})
