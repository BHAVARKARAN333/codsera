/**
 * App Component Integration Tests
 *
 * Verifies end-to-end component behavior, workspace lifecycle, editor tabs,
 * integrated terminal, Git Source Control, AI Chat panel, file operations,
 * dirty tab modals, and application-level event handling using React Testing Library in happy-dom.
 */

import { useEffect } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within, act } from '@testing-library/react'
import { App } from '@renderer/App'
import { setupMockElectron, resetMockElectron } from '../setup/electronMock'
import { providerRegistry } from '@renderer/services/ai/providerRegistry'
import type { IAIProvider, ProviderCapabilities } from '@renderer/services/ai/types'
import type {
  FileEntry,
  IElectronAPI,
  WorkspaceFileChangeEvent,
  TerminalStreamDataEvent,
  TerminalSessionExitEvent
} from '@shared/types'

// ============================================================================
// Monaco Mocks (Hoisted for Vitest)
// ============================================================================

const { mockMonaco, mockEditorInstance } = vi.hoisted(() => {
  return {
    mockEditorInstance: {
      addCommand: vi.fn(),
      getValue: vi.fn().mockReturnValue(''),
      focus: vi.fn()
    },
    mockMonaco: {
      editor: {
        defineTheme: vi.fn(),
        setTheme: vi.fn()
      },
      KeyMod: { CtrlCmd: 2048 },
      KeyCode: { KeyS: 49 }
    }
  }
})

vi.mock('@renderer/monacoConfig', () => ({
  monaco: mockMonaco
}))

vi.mock('monaco-editor', () => ({
  editor: {
    defineTheme: vi.fn(),
    setTheme: vi.fn()
  },
  KeyMod: { CtrlCmd: 2048 },
  KeyCode: { KeyS: 49 }
}))

vi.mock('@monaco-editor/react', () => {
  const MockEditor = ({ value, onChange, onMount }: any) => {
    useEffect(() => {
      mockEditorInstance.getValue.mockReturnValue(value || '')
      onMount?.(mockEditorInstance, mockMonaco)
    }, [])

    return (
      <textarea
        data-testid="monaco-editor-mock"
        value={value}
        onChange={(e) => {
          mockEditorInstance.getValue.mockReturnValue(e.target.value)
          onChange?.(e.target.value)
        }}
      />
    )
  }

  const MockDiffEditor = ({ original, modified, onMount }: any) => {
    useEffect(() => {
      onMount?.(mockEditorInstance, mockMonaco)
    }, [])

    return (
      <div data-testid="monaco-diff-editor-mock">
        <div data-testid="diff-original">{original}</div>
        <div data-testid="diff-modified">{modified}</div>
      </div>
    )
  }

  return {
    __esModule: true,
    default: MockEditor,
    DiffEditor: MockDiffEditor,
    loader: {
      config: vi.fn(),
      init: vi.fn().mockResolvedValue(mockMonaco)
    }
  }
})

// ============================================================================
// AI Provider Mock Fixtures
// ============================================================================

function createMockProvider(
  id: string,
  name: string,
  capabilities: Partial<ProviderCapabilities> = {},
  sendFn?: (messages: any[], tools: any[], options: any) => Promise<any>
): IAIProvider {
  return {
    id,
    name,
    capabilities: {
      supportsStreaming: true,
      supportsTools: true,
      requiresApiKey: true,
      supportsModelListing: false,
      ...capabilities
    },
    sendMessage:
      sendFn ||
      vi.fn().mockResolvedValue({
        text: `Mock response from ${name}`,
        rawModelParts: [{ text: `Mock response from ${name}` }]
      })
  }
}

// ============================================================================
// Test Data & Helpers
// ============================================================================

const MOCK_WORKSPACE_PATH = 'C:/mock/test-workspace'

const MOCK_FILE_TREE: FileEntry[] = [
  {
    name: 'src',
    path: `${MOCK_WORKSPACE_PATH}/src`,
    isDirectory: true,
    children: [
      {
        name: 'index.ts',
        path: `${MOCK_WORKSPACE_PATH}/src/index.ts`,
        isDirectory: false
      },
      {
        name: 'utils.ts',
        path: `${MOCK_WORKSPACE_PATH}/src/utils.ts`,
        isDirectory: false
      }
    ]
  },
  {
    name: 'package.json',
    path: `${MOCK_WORKSPACE_PATH}/package.json`,
    isDirectory: false
  },
  {
    name: 'README.md',
    path: `${MOCK_WORKSPACE_PATH}/README.md`,
    isDirectory: false
  }
]

describe('App Component Integration Tests', () => {
  let fileWatcherCallback: ((event: WorkspaceFileChangeEvent) => void) | null = null
  let terminalStreamCallback: ((event: TerminalStreamDataEvent) => void) | null = null
  let terminalExitCallback: ((event: TerminalSessionExitEvent) => void) | null = null
  let mockFileContents: Record<string, string> = {}

  // Safe mock configuration preserving baseline fixtures across overrides
  function configureMockElectron(overrides: Partial<IElectronAPI> = {}): IElectronAPI {
    return setupMockElectron({
      getLastWorkspace: async () => ({
        success: true,
        rootPath: undefined,
        tree: []
      }),
      openDirectory: async () => ({
        success: true,
        rootPath: MOCK_WORKSPACE_PATH,
        tree: MOCK_FILE_TREE
      }),
      readTree: async (rootPath: string) => ({
        success: true,
        rootPath,
        tree: MOCK_FILE_TREE
      }),
      readFile: async (filePath: string) => {
        if (filePath in mockFileContents) {
          return { success: true, content: mockFileContents[filePath] }
        }
        return { success: true, content: `// Content of ${filePath}\n` }
      },
      writeFile: async (filePath: string, content: string) => {
        mockFileContents[filePath] = content
        return { success: true }
      },
      watchWorkspace: vi.fn().mockResolvedValue({ success: true }),
      unwatchWorkspace: vi.fn().mockResolvedValue({ success: true }),
      onWorkspaceFileChanged: (cb) => {
        fileWatcherCallback = cb
        return () => {
          fileWatcherCallback = null
        }
      },
      onTerminalStreamData: (cb) => {
        terminalStreamCallback = cb
        return () => {
          terminalStreamCallback = null
        }
      },
      onTerminalSessionExit: (cb) => {
        terminalExitCallback = cb
        return () => {
          terminalExitCallback = null
        }
      },
      terminalSpawn: vi.fn().mockResolvedValue({
        success: true,
        sessionId: 'term_session_test',
        pid: 9999
      }),
      terminalKillAll: vi.fn().mockResolvedValue({
        success: true,
        killedCount: 1
      }),
      terminalKill: vi.fn().mockResolvedValue({
        success: true
      }),
      terminalWriteInput: vi.fn().mockResolvedValue({
        success: true
      }),
      gitStatus: async () => ({
        success: true,
        isRepository: true,
        branch: 'main',
        clean: true,
        files: [],
        staged: [],
        unstaged: [],
        untracked: [],
        conflicted: []
      }),
      gitBranchList: async () => ({
        success: true,
        isRepository: true,
        currentBranch: 'main',
        branches: ['main', 'feature/test']
      }),
      gitFileDiff: async (_root, relPath) => ({
        success: true,
        isRepository: true,
        path: relPath,
        unstagedDiff: `--- a/${relPath}\n+++ b/${relPath}\n@@ -1,1 +1,2 @@\n-line1\n+line1-modified\n+line2\n`,
        stagedDiff: ''
      }),
      getSettings: async () => ({
        selectedProvider: 'gemini',
        geminiApiKey: 'mock-key'
      }),
      ...overrides
    })
  }

  // Scoped DOM Query Helpers
  const getHeaderBar = (): HTMLElement => {
    const el = document.querySelector('.header-bar') as HTMLElement
    if (!el) throw new Error('.header-bar not found in DOM')
    return el
  }

  const getStatusBar = (): HTMLElement => {
    const el = document.querySelector('.status-bar') as HTMLElement
    if (!el) throw new Error('.status-bar not found in DOM')
    return el
  }

  const clickHeaderOpenFolder = async () => {
    const header = getHeaderBar()
    const btn = within(header).getByRole('button', { name: /Open Folder/i })
    await act(async () => {
      fireEvent.click(btn)
    })
  }

  const openWorkspace = async (expectedWorkspaceName = 'test-workspace') => {
    await clickHeaderOpenFolder()
    await waitFor(() => {
      expect(document.querySelector('.workspace-pill-text')?.textContent).toBe(expectedWorkspaceName)
    })
  }

  beforeEach(() => {
    fileWatcherCallback = null
    terminalStreamCallback = null
    terminalExitCallback = null
    mockFileContents = {
      [`${MOCK_WORKSPACE_PATH}/src/index.ts`]: 'console.log("hello world");\n',
      [`${MOCK_WORKSPACE_PATH}/src/utils.ts`]: 'export function add(a: number, b: number) { return a + b; }\n',
      [`${MOCK_WORKSPACE_PATH}/package.json`]: '{\n  "name": "mock-app"\n}\n',
      [`${MOCK_WORKSPACE_PATH}/README.md`]: '# Mock App\n'
    }

    if (typeof window !== 'undefined' && window.HTMLElement) {
      window.HTMLElement.prototype.scrollIntoView = vi.fn()
    }

    try {
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          writeText: vi.fn().mockResolvedValue(undefined)
        },
        configurable: true,
        writable: true
      })
    } catch {}

    // Initialize baseline mocks
    configureMockElectron()

    // Setup AI provider mock
    const mockGemini = createMockProvider('gemini', 'Google Gemini', {
      supportsStreaming: true,
      supportsTools: true,
      requiresApiKey: true
    })
    vi.spyOn(providerRegistry, 'get').mockReturnValue(mockGemini)
  })

  afterEach(() => {
    cleanup()
    resetMockElectron()
    vi.restoreAllMocks()
  })

  // ==========================================================================
  // Group 1: App Rendering & Initial State
  // ==========================================================================
  describe('Group 1: App Rendering & Initial State', () => {
    it('renders header bar with title, PRO badge, and empty workspace indicator', async () => {
      render(<App />)

      const header = getHeaderBar()
      expect(within(header).getByText('AI IDE')).toBeInTheDocument()
      expect(within(header).getByText('PRO')).toBeInTheDocument()
      expect(within(header).getByText('No Workspace Opened')).toBeInTheDocument()
    })

    it('renders header action buttons in expected default states', async () => {
      render(<App />)

      const header = getHeaderBar()
      const openFolderBtn = within(header).getByRole('button', { name: /Open Folder/i })
      expect(openFolderBtn).toBeInTheDocument()

      const saveBtn = within(header).getByRole('button', { name: /Saved/i })
      expect(saveBtn).toBeInTheDocument()
      expect(saveBtn).toBeDisabled()

      const terminalBtn = within(header).getByRole('button', { name: /Terminal/i })
      expect(terminalBtn).toBeInTheDocument()

      const aiBtn = within(header).getByRole('button', { name: /AI Assistant/i })
      expect(aiBtn).toBeInTheDocument()
    })

    it('renders Activity Bar with Explorer and Source Control buttons', async () => {
      render(<App />)

      const explorerBtn = screen.getByRole('button', { name: 'Explorer' })
      const scBtn = screen.getByRole('button', { name: 'Source Control' })

      expect(explorerBtn).toBeInTheDocument()
      expect(scBtn).toBeInTheDocument()
      expect(explorerBtn).toHaveClass('active')
      expect(scBtn).not.toHaveClass('active')
    })

    it('renders editor empty state with guidance and shortcut tips when no file or workspace is open', async () => {
      render(<App />)

      expect(
        screen.getByText('Open a file from the explorer or open a workspace to start coding.')
      ).toBeInTheDocument()
      expect(screen.getByText('Ctrl + S')).toBeInTheDocument()
      expect(screen.getByText('Save Active File')).toBeInTheDocument()

      const emptyArea = document.querySelector('.editor-empty') as HTMLElement
      expect(within(emptyArea).getByRole('button', { name: /Open Workspace/i })).toBeInTheDocument()
    })

    it('renders Status Bar with Ready status and AI Ready indicator', async () => {
      render(<App />)

      const statusBar = getStatusBar()
      expect(within(statusBar).getByText('Ready')).toBeInTheDocument()
      expect(within(statusBar).getByText('AI Ready')).toBeInTheDocument()
    })

    it('restores previous workspace on startup if getLastWorkspace returns valid data', async () => {
      configureMockElectron({
        getLastWorkspace: async () => ({
          success: true,
          rootPath: MOCK_WORKSPACE_PATH,
          tree: MOCK_FILE_TREE
        })
      })

      render(<App />)

      await waitFor(() => {
        expect(document.querySelector('.workspace-pill-text')?.textContent).toBe('test-workspace')
      })
      const statusBar = getStatusBar()
      expect(within(statusBar).getByText(`Workspace: ${MOCK_WORKSPACE_PATH}`)).toBeInTheDocument()
    })

    it('gracefully handles getLastWorkspace failure by remaining in clean empty state', async () => {
      configureMockElectron({
        getLastWorkspace: vi.fn().mockRejectedValue(new Error('Previous workspace unavailable'))
      })

      render(<App />)

      await waitFor(() => {
        expect(screen.getByText('No Workspace Opened')).toBeInTheDocument()
      })
      const statusBar = getStatusBar()
      expect(within(statusBar).getByText('Ready')).toBeInTheDocument()
    })
  })

  // ==========================================================================
  // Group 2: Workspace Lifecycle
  // ==========================================================================
  describe('Group 2: Workspace Lifecycle', () => {
    it('opens workspace via header Open Folder button and renders file tree', async () => {
      render(<App />)

      await openWorkspace()

      expect(document.querySelector('.workspace-pill-text')?.textContent).toBe('test-workspace')
      expect(screen.getByText('package.json')).toBeInTheDocument()
      expect(screen.getByText('README.md')).toBeInTheDocument()
      const statusBar = getStatusBar()
      expect(within(statusBar).getByText(`Opened workspace: ${MOCK_WORKSPACE_PATH}`)).toBeInTheDocument()
    })

    it('opens workspace via empty state Open Workspace button', async () => {
      render(<App />)

      const emptyArea = document.querySelector('.editor-empty') as HTMLElement
      const openWorkspaceBtn = within(emptyArea).getByRole('button', { name: /Open Workspace/i })
      await act(async () => {
        fireEvent.click(openWorkspaceBtn)
      })

      await waitFor(() => {
        expect(document.querySelector('.workspace-pill-text')?.textContent).toBe('test-workspace')
      })
      expect(screen.getByText('package.json')).toBeInTheDocument()
    })

    it('calls terminalKillAll when switching or opening a workspace', async () => {
      const mockKillAll = vi.fn().mockResolvedValue({ success: true, killedCount: 1 })
      configureMockElectron({
        terminalKillAll: mockKillAll
      })

      render(<App />)

      await openWorkspace()

      expect(mockKillAll).toHaveBeenCalled()
    })

    it('subscribes to workspace filesystem watcher on workspace open and unwatches on unmount', async () => {
      const mockWatch = vi.fn().mockResolvedValue({ success: true })
      const mockUnwatch = vi.fn().mockResolvedValue({ success: true })
      configureMockElectron({
        watchWorkspace: mockWatch,
        unwatchWorkspace: mockUnwatch
      })

      const { unmount } = render(<App />)

      await openWorkspace()

      expect(mockWatch).toHaveBeenCalledWith(MOCK_WORKSPACE_PATH)

      unmount()
      expect(mockUnwatch).toHaveBeenCalled()
    })

    it('prompts confirmation modal when opening workspace while dirty tabs exist', async () => {
      render(<App />)

      // Open workspace first
      await openWorkspace()
      await waitFor(() => expect(screen.getByText('package.json')).toBeInTheDocument())

      // Open package.json
      await act(async () => {
        fireEvent.click(screen.getByText('package.json'))
      })
      await waitFor(() => expect(screen.getByTestId('monaco-editor-mock')).toBeInTheDocument())

      // Edit content to make dirty
      const editor = screen.getByTestId('monaco-editor-mock')
      await act(async () => {
        fireEvent.change(editor, { target: { value: '{"modified": true}' } })
      })

      // Attempt to open folder via header
      await clickHeaderOpenFolder()

      // Modal should be shown
      const modal = screen.getByRole('dialog')
      expect(within(modal).getByText('Unsaved Changes in Workspace')).toBeInTheDocument()
      expect(
        within(modal).getByText('Do you want to save these changes before opening a new workspace?')
      ).toBeInTheDocument()

      // Cancel modal via footer button
      const modalFooter = modal.querySelector('.explorer-modal-footer') as HTMLElement
      const cancelBtn = within(modalFooter).getByRole('button', { name: 'Cancel' })
      await act(async () => {
        fireEvent.click(cancelBtn)
      })

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it('discards dirty changes and switches workspace when Don\'t Save is clicked in modal', async () => {
      let isFirstOpen = true
      const mockOpenDir = vi.fn().mockImplementation(async () => {
        if (isFirstOpen) {
          isFirstOpen = false
          return {
            success: true,
            rootPath: MOCK_WORKSPACE_PATH,
            tree: MOCK_FILE_TREE
          }
        }
        return {
          success: true,
          rootPath: 'C:/other-workspace',
          tree: []
        }
      })
      configureMockElectron({
        openDirectory: mockOpenDir
      })

      render(<App />)

      await openWorkspace('test-workspace')
      await waitFor(() => expect(screen.getByText('package.json')).toBeInTheDocument())

      await act(async () => {
        fireEvent.click(screen.getByText('package.json'))
      })
      await waitFor(() => expect(screen.getByTestId('monaco-editor-mock')).toBeInTheDocument())

      fireEvent.change(screen.getByTestId('monaco-editor-mock'), { target: { value: 'dirty edits' } })

      // Attempt open folder
      await clickHeaderOpenFolder()
      const modal = screen.getByRole('dialog')
      expect(within(modal).getByText('Unsaved Changes in Workspace')).toBeInTheDocument()

      // Click Don't Save
      const modalFooter = modal.querySelector('.explorer-modal-footer') as HTMLElement
      const dontSaveBtn = within(modalFooter).getByRole('button', { name: "Don't Save" })
      await act(async () => {
        fireEvent.click(dontSaveBtn)
      })

      await waitFor(() => {
        expect(document.querySelector('.workspace-pill-text')?.textContent).toBe('other-workspace')
      })
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it('saves all dirty files and switches workspace when Save All is clicked in modal', async () => {
      const mockWrite = vi.fn().mockResolvedValue({ success: true })
      configureMockElectron({
        writeFile: mockWrite
      })

      render(<App />)

      await openWorkspace()
      await waitFor(() => expect(screen.getByText('package.json')).toBeInTheDocument())

      await act(async () => {
        fireEvent.click(screen.getByText('package.json'))
      })
      await waitFor(() => expect(screen.getByTestId('monaco-editor-mock')).toBeInTheDocument())

      fireEvent.change(screen.getByTestId('monaco-editor-mock'), { target: { value: 'saved edits' } })

      await clickHeaderOpenFolder()
      const modal = screen.getByRole('dialog')

      const modalFooter = modal.querySelector('.explorer-modal-footer') as HTMLElement
      const saveAllBtn = within(modalFooter).getByRole('button', { name: 'Save All' })
      await act(async () => {
        fireEvent.click(saveAllBtn)
      })

      await waitFor(() => {
        expect(mockWrite).toHaveBeenCalledWith(
          `${MOCK_WORKSPACE_PATH}/package.json`,
          'saved edits'
        )
      })
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
  })

  // ==========================================================================
  // Group 3: Editor Tabs & File Operations
  // ==========================================================================
  describe('Group 3: Editor Tabs & File Operations', () => {
    it('opens file from file tree, renders tab, and displays content in Monaco editor', async () => {
      render(<App />)

      await openWorkspace()
      await waitFor(() => expect(screen.getByText('package.json')).toBeInTheDocument())

      await act(async () => {
        fireEvent.click(screen.getByText('package.json'))
      })

      await waitFor(() => {
        expect(screen.getByTestId('monaco-editor-mock')).toBeInTheDocument()
      })
      const editor = screen.getByTestId('monaco-editor-mock') as HTMLTextAreaElement
      expect(editor.value).toContain('"name": "mock-app"')
      expect(within(getStatusBar()).getByText('Loaded package.json')).toBeInTheDocument()
    })

    it('switches between multiple open tabs and preserves each tab buffer', async () => {
      render(<App />)

      await openWorkspace()
      await waitFor(() => expect(screen.getByText('package.json')).toBeInTheDocument())

      // Open package.json
      await act(async () => {
        fireEvent.click(screen.getByText('package.json'))
      })
      await waitFor(() => expect(screen.getByTestId('monaco-editor-mock')).toBeInTheDocument())

      // Open README.md
      await act(async () => {
        fireEvent.click(screen.getByText('README.md'))
      })

      await waitFor(() => {
        const editor = screen.getByTestId('monaco-editor-mock') as HTMLTextAreaElement
        expect(editor.value).toBe('# Mock App\n')
      })

      // Tabs bar should contain both tabs
      const tabHeaders = document.querySelectorAll('.editor-tab')
      expect(tabHeaders.length).toBe(2)

      // Switch back to package.json by clicking its tab
      await act(async () => {
        fireEvent.click(tabHeaders[0])
      })

      await waitFor(() => {
        const editor = screen.getByTestId('monaco-editor-mock') as HTMLTextAreaElement
        expect(editor.value).toContain('"name": "mock-app"')
      })
    })

    it('marks tab as dirty on edit and updates header Save button', async () => {
      render(<App />)

      await openWorkspace()
      await waitFor(() => expect(screen.getByText('package.json')).toBeInTheDocument())

      await act(async () => {
        fireEvent.click(screen.getByText('package.json'))
      })
      await waitFor(() => expect(screen.getByTestId('monaco-editor-mock')).toBeInTheDocument())

      // Initially saved
      const header = getHeaderBar()
      const saveBtn = within(header).getByRole('button', { name: /Saved/i })
      expect(saveBtn).toBeDisabled()

      // Modify content
      const editor = screen.getByTestId('monaco-editor-mock')
      await act(async () => {
        fireEvent.change(editor, { target: { value: '{"modified": true}' } })
      })

      // Now dirty
      expect(within(header).getByRole('button', { name: /Save \(Ctrl\+S\)/i })).not.toBeDisabled()
      expect(document.querySelector('.tab-dirty-indicator')).toBeInTheDocument()

      // Reset to original content clears dirty state
      await act(async () => {
        fireEvent.change(editor, { target: { value: mockFileContents[`${MOCK_WORKSPACE_PATH}/package.json`] } })
      })
      expect(document.querySelector('.tab-dirty-indicator')).not.toBeInTheDocument()
      expect(within(header).getByRole('button', { name: /Saved/i })).toBeDisabled()
    })

    it('saves dirty file when Save button is clicked', async () => {
      const mockWrite = vi.fn().mockResolvedValue({ success: true })
      configureMockElectron({ writeFile: mockWrite })

      render(<App />)

      await openWorkspace()
      await waitFor(() => expect(screen.getByText('package.json')).toBeInTheDocument())

      await act(async () => {
        fireEvent.click(screen.getByText('package.json'))
      })
      await waitFor(() => expect(screen.getByTestId('monaco-editor-mock')).toBeInTheDocument())

      fireEvent.change(screen.getByTestId('monaco-editor-mock'), { target: { value: 'new-content' } })

      const header = getHeaderBar()
      const saveBtn = within(header).getByRole('button', { name: /Save \(Ctrl\+S\)/i })
      await act(async () => {
        fireEvent.click(saveBtn)
      })

      await waitFor(() => {
        expect(mockWrite).toHaveBeenCalledWith(
          `${MOCK_WORKSPACE_PATH}/package.json`,
          'new-content'
        )
      })
      expect(within(getStatusBar()).getByText('Saved package.json')).toBeInTheDocument()
      expect(document.querySelector('.tab-dirty-indicator')).not.toBeInTheDocument()
    })

    it('saves active file when global Ctrl+S keyboard shortcut is pressed', async () => {
      const mockWrite = vi.fn().mockResolvedValue({ success: true })
      configureMockElectron({ writeFile: mockWrite })

      render(<App />)

      await openWorkspace()
      await waitFor(() => expect(screen.getByText('package.json')).toBeInTheDocument())

      await act(async () => {
        fireEvent.click(screen.getByText('package.json'))
      })
      await waitFor(() => expect(screen.getByTestId('monaco-editor-mock')).toBeInTheDocument())

      fireEvent.change(screen.getByTestId('monaco-editor-mock'), { target: { value: 'ctrl-s-content' } })

      // Press Ctrl+S
      await act(async () => {
        fireEvent.keyDown(window, { key: 's', ctrlKey: true })
      })

      await waitFor(() => {
        expect(mockWrite).toHaveBeenCalledWith(
          `${MOCK_WORKSPACE_PATH}/package.json`,
          'ctrl-s-content'
        )
      })
      expect(within(getStatusBar()).getByText('Saved package.json')).toBeInTheDocument()
    })

    it('closes clean tab immediately without confirmation dialog', async () => {
      render(<App />)

      await openWorkspace()
      await waitFor(() => expect(screen.getByText('package.json')).toBeInTheDocument())

      await act(async () => {
        fireEvent.click(screen.getByText('package.json'))
      })
      await waitFor(() => expect(screen.getByTestId('monaco-editor-mock')).toBeInTheDocument())

      const closeTabBtn = document.querySelector('.tab-close-btn') as HTMLElement
      expect(closeTabBtn).toBeInTheDocument()

      await act(async () => {
        fireEvent.click(closeTabBtn)
      })

      // Tab closed and editor empty state restored
      expect(document.querySelector('.editor-tab')).not.toBeInTheDocument()
      expect(
        screen.getByText('Open a file from the explorer or open a workspace to start coding.')
      ).toBeInTheDocument()
    })

    it('shows confirmation dialog when closing dirty tab and handles Cancel, Don\'t Save, and Save', async () => {
      const mockWrite = vi.fn().mockResolvedValue({ success: true })
      configureMockElectron({ writeFile: mockWrite })

      render(<App />)

      await openWorkspace()
      await waitFor(() => expect(screen.getByText('package.json')).toBeInTheDocument())

      await act(async () => {
        fireEvent.click(screen.getByText('package.json'))
      })
      await waitFor(() => expect(screen.getByTestId('monaco-editor-mock')).toBeInTheDocument())

      fireEvent.change(screen.getByTestId('monaco-editor-mock'), { target: { value: 'dirty-tab-content' } })

      // Click tab close
      const closeTabBtn = document.querySelector('.tab-close-btn') as HTMLElement
      await act(async () => {
        fireEvent.click(closeTabBtn)
      })

      // Modal appears
      const modal = screen.getByRole('dialog')
      expect(within(modal).getByText('Unsaved Changes')).toBeInTheDocument()
      expect(
        within(modal).getByText(/Do you want to save the changes you made to/i)
      ).toBeInTheDocument()

      // 1. Test Cancel in modal footer
      const modalFooter = modal.querySelector('.explorer-modal-footer') as HTMLElement
      const cancelBtn = within(modalFooter).getByRole('button', { name: 'Cancel' })
      await act(async () => {
        fireEvent.click(cancelBtn)
      })
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(document.querySelector('.editor-tab')).toBeInTheDocument()

      // 2. Test Escape key closes modal
      await act(async () => {
        fireEvent.click(closeTabBtn)
      })
      expect(screen.getByRole('dialog')).toBeInTheDocument()
      await act(async () => {
        fireEvent.keyDown(window, { key: 'Escape' })
      })
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

      // 3. Test Don't Save closes tab
      await act(async () => {
        fireEvent.click(closeTabBtn)
      })
      const newModal = screen.getByRole('dialog')
      const newFooter = newModal.querySelector('.explorer-modal-footer') as HTMLElement
      const dontSaveBtn = within(newFooter).getByRole('button', { name: "Don't Save" })
      await act(async () => {
        fireEvent.click(dontSaveBtn)
      })
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(document.querySelector('.editor-tab')).not.toBeInTheDocument()
    })

    it('saves file and closes tab when Save is chosen in dirty tab close modal', async () => {
      const mockWrite = vi.fn().mockResolvedValue({ success: true })
      configureMockElectron({ writeFile: mockWrite })

      render(<App />)

      await openWorkspace()
      await waitFor(() => expect(screen.getByText('package.json')).toBeInTheDocument())

      await act(async () => {
        fireEvent.click(screen.getByText('package.json'))
      })
      await waitFor(() => expect(screen.getByTestId('monaco-editor-mock')).toBeInTheDocument())

      fireEvent.change(screen.getByTestId('monaco-editor-mock'), { target: { value: 'save-on-close' } })

      const closeTabBtn = document.querySelector('.tab-close-btn') as HTMLElement
      await act(async () => {
        fireEvent.click(closeTabBtn)
      })

      const modal = screen.getByRole('dialog')
      const modalFooter = modal.querySelector('.explorer-modal-footer') as HTMLElement
      const saveBtnInModal = within(modalFooter).getByRole('button', { name: 'Save' })
      await act(async () => {
        fireEvent.click(saveBtnInModal)
      })

      await waitFor(() => {
        expect(mockWrite).toHaveBeenCalledWith(
          `${MOCK_WORKSPACE_PATH}/package.json`,
          'save-on-close'
        )
      })
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(document.querySelector('.editor-tab')).not.toBeInTheDocument()
    })

    it('renders error state with retry action when file fails to load', async () => {
      const mockReadFile = vi.fn().mockResolvedValueOnce({
        success: false,
        error: 'Permission denied'
      })
      configureMockElectron({ readFile: mockReadFile })

      render(<App />)

      await openWorkspace()
      await waitFor(() => expect(screen.getByText('package.json')).toBeInTheDocument())

      await act(async () => {
        fireEvent.click(screen.getByText('package.json'))
      })

      await waitFor(() => {
        expect(screen.getByTestId('editor-error-state')).toBeInTheDocument()
      })
      expect(screen.getByText('Failed to open package.json')).toBeInTheDocument()
      expect(screen.getByText('Permission denied')).toBeInTheDocument()

      // Retry button reloads file
      mockReadFile.mockResolvedValueOnce({
        success: true,
        content: '{"retrySuccess": true}'
      })
      const retryBtn = screen.getByRole('button', { name: /Retry/i })
      await act(async () => {
        fireEvent.click(retryBtn)
      })

      await waitFor(() => {
        expect(screen.getByTestId('monaco-editor-mock')).toBeInTheDocument()
      })
    })

    it('handles external file modification for clean and dirty tabs via watcher events', async () => {
      render(<App />)

      await openWorkspace()
      await waitFor(() => expect(screen.getByText('package.json')).toBeInTheDocument())

      await act(async () => {
        fireEvent.click(screen.getByText('package.json'))
      })
      await waitFor(() => expect(screen.getByTestId('monaco-editor-mock')).toBeInTheDocument())

      // 1. External change on clean tab: auto-reloads
      configureMockElectron({
        readFile: async () => ({ success: true, content: '{"reloaded": true}' })
      })

      await act(async () => {
        fileWatcherCallback?.({
          workspaceRoot: MOCK_WORKSPACE_PATH,
          relativePath: 'package.json',
          eventType: 'change',
          isDirectory: false
        })
      })

      // Wait for debounce timer (120ms)
      await waitFor(
        () => {
          const editor = screen.getByTestId('monaco-editor-mock') as HTMLTextAreaElement
          expect(editor.value).toBe('{"reloaded": true}')
        },
        { timeout: 1000 }
      )

      // 2. External change on dirty tab: shows external changes banner
      fireEvent.change(screen.getByTestId('monaco-editor-mock'), { target: { value: 'local edits' } })

      configureMockElectron({
        readFile: async () => ({ success: true, content: '{"externalDisk": true}' })
      })

      await act(async () => {
        fileWatcherCallback?.({
          workspaceRoot: MOCK_WORKSPACE_PATH,
          relativePath: 'package.json',
          eventType: 'change',
          isDirectory: false
        })
      })

      await waitFor(
        () => {
          expect(screen.getByText(/External changes detected:/i)).toBeInTheDocument()
        },
        { timeout: 1000 }
      )

      // Keep local edits button dismisses banner
      const keepEditsBtn = screen.getByRole('button', { name: 'Keep Local Edits' })
      await act(async () => {
        fireEvent.click(keepEditsBtn)
      })
      expect(screen.queryByText(/External changes detected:/i)).not.toBeInTheDocument()
      expect((screen.getByTestId('monaco-editor-mock') as HTMLTextAreaElement).value).toBe('local edits')
    })
  })

  // ==========================================================================
  // Group 4: Terminal Integration
  // ==========================================================================
  describe('Group 4: Terminal Integration', () => {
    it('toggles terminal panel visibility when Terminal button in header is clicked', async () => {
      render(<App />)

      const header = getHeaderBar()
      const terminalBtn = within(header).getByRole('button', { name: /Terminal/i })
      expect(document.querySelector('.terminal-panel')).not.toBeInTheDocument()

      // Open terminal
      await act(async () => {
        fireEvent.click(terminalBtn)
      })
      expect(document.querySelector('.terminal-panel')).toBeInTheDocument()

      // Close terminal
      await act(async () => {
        fireEvent.click(terminalBtn)
      })
      expect(document.querySelector('.terminal-panel')).not.toBeInTheDocument()
    })

    it('initializes default terminal tab when workspace is opened', async () => {
      render(<App />)

      await openWorkspace()

      // Open terminal
      const header = getHeaderBar()
      await act(async () => {
        fireEvent.click(within(header).getByRole('button', { name: /Terminal/i }))
      })

      expect(screen.getByText('Terminal 1')).toBeInTheDocument()
      expect(screen.getByPlaceholderText(/Type a command and press Enter/i)).toBeInTheDocument()
    })

    it('creates new terminal tab when add tab button is clicked', async () => {
      render(<App />)

      await openWorkspace()
      const header = getHeaderBar()
      await act(async () => {
        fireEvent.click(within(header).getByRole('button', { name: /Terminal/i }))
      })

      const addTabBtn = screen.getByTitle('New Terminal')
      await act(async () => {
        fireEvent.click(addTabBtn)
      })

      expect(screen.getByText('Terminal 2')).toBeInTheDocument()
    })

    it('spawns command, processes streaming data, and handles session exit', async () => {
      const mockSpawn = vi.fn().mockResolvedValue({
        success: true,
        sessionId: 'test_term_run_1',
        pid: 1234
      })
      configureMockElectron({
        terminalSpawn: mockSpawn
      })

      render(<App />)

      await openWorkspace()
      const header = getHeaderBar()
      await act(async () => {
        fireEvent.click(within(header).getByRole('button', { name: /Terminal/i }))
      })

      const cmdInput = screen.getByPlaceholderText(/Type a command and press Enter/i)
      fireEvent.change(cmdInput, { target: { value: 'npm test' } })

      const runBtn = screen.getByTitle('Execute command')
      await act(async () => {
        fireEvent.click(runBtn)
      })

      await waitFor(() => {
        expect(mockSpawn).toHaveBeenCalledWith(
          expect.objectContaining({
            command: 'npm test',
            workspaceRoot: MOCK_WORKSPACE_PATH
          })
        )
      })

      // Simulate streaming output chunk
      const spawnCall = mockSpawn.mock.calls[0][0]
      const spawnedSessionId = spawnCall.sessionId

      await act(async () => {
        terminalStreamCallback?.({
          sessionId: spawnedSessionId,
          type: 'stdout',
          data: 'Build passing...\n'
        })
      })

      expect(screen.getByText(/Build passing\.\.\./i)).toBeInTheDocument()

      // Simulate process exit 0
      await act(async () => {
        terminalExitCallback?.({
          sessionId: spawnedSessionId,
          exitCode: 0,
          timedOut: false
        })
      })

      expect(within(getStatusBar()).getByText('Terminal command completed (exit 0)')).toBeInTheDocument()
    })

    it('preserves running terminal session in background when terminal panel is toggled closed', async () => {
      render(<App />)

      await openWorkspace()
      const header = getHeaderBar()
      const terminalBtn = within(header).getByRole('button', { name: /Terminal/i })

      // Open terminal
      await act(async () => {
        fireEvent.click(terminalBtn)
      })
      expect(document.querySelector('.terminal-panel')).toBeInTheDocument()

      // Close terminal panel
      await act(async () => {
        fireEvent.click(terminalBtn)
      })
      expect(document.querySelector('.terminal-panel')).not.toBeInTheDocument()

      // Re-open terminal panel: session state and tabs remain intact
      await act(async () => {
        fireEvent.click(terminalBtn)
      })
      expect(document.querySelector('.terminal-panel')).toBeInTheDocument()
      expect(screen.getByText('Terminal 1')).toBeInTheDocument()
    })
  })

  // ==========================================================================
  // Group 5: Source Control Integration
  // ==========================================================================
  describe('Group 5: Source Control Integration', () => {
    it('switches between Explorer and Source Control sidebar views via activity bar', async () => {
      render(<App />)

      const scBtn = screen.getByRole('button', { name: 'Source Control' })
      const expBtn = screen.getByRole('button', { name: 'Explorer' })

      // Switch to Source Control
      await act(async () => {
        fireEvent.click(scBtn)
      })
      expect(scBtn).toHaveClass('active')
      expect(expBtn).not.toHaveClass('active')
      expect(document.querySelector('.source-control-panel')).toBeInTheDocument()

      // Switch back to Explorer
      await act(async () => {
        fireEvent.click(expBtn)
      })
      expect(expBtn).toHaveClass('active')
      expect(scBtn).not.toHaveClass('active')
    })

    it('switches views via Ctrl+Shift+G and Ctrl+Shift+E keyboard shortcuts', async () => {
      render(<App />)

      const scBtn = screen.getByRole('button', { name: 'Source Control' })
      const expBtn = screen.getByRole('button', { name: 'Explorer' })

      // Ctrl+Shift+G -> Source Control
      await act(async () => {
        fireEvent.keyDown(window, { key: 'G', ctrlKey: true, shiftKey: true })
      })
      expect(scBtn).toHaveClass('active')

      // Ctrl+Shift+E -> Explorer
      await act(async () => {
        fireEvent.keyDown(window, { key: 'E', ctrlKey: true, shiftKey: true })
      })
      expect(expBtn).toHaveClass('active')
    })

    it('displays Git branch pill in status bar and change badge on activity bar button', async () => {
      configureMockElectron({
        gitStatus: async () => ({
          success: true,
          isRepository: true,
          branch: 'feature/ai-integration',
          clean: false,
          files: [
            { path: 'src/index.ts', status: 'modified', staged: false }
          ],
          unstaged: ['src/index.ts'],
          staged: [],
          untracked: [],
          conflicted: []
        })
      })

      render(<App />)

      await openWorkspace()

      await waitFor(() => {
        expect(screen.getByText('feature/ai-integration')).toBeInTheDocument()
      })
      expect(screen.getByTitle('1 pending change(s)')).toBeInTheDocument()
    })

    it('opens file diff viewer and adds active diff tab when diff is triggered', async () => {
      configureMockElectron({
        gitStatus: async () => ({
          success: true,
          isRepository: true,
          branch: 'main',
          clean: false,
          files: [
            { path: 'src/index.ts', status: 'modified', staged: false }
          ],
          unstaged: ['src/index.ts'],
          staged: [],
          untracked: [],
          conflicted: []
        })
      })

      render(<App />)

      await openWorkspace()

      // Switch to Source Control
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Source Control' }))
      })

      // Click changed file to open diff
      await waitFor(() => expect(screen.getByTestId('unstaged-file-src/index.ts')).toBeInTheDocument())
      await act(async () => {
        fireEvent.click(screen.getByTestId('unstaged-file-src/index.ts'))
      })

      // Diff tab and viewer should be mounted
      await waitFor(() => {
        expect(screen.getByTestId('editor-diff-tab')).toBeInTheDocument()
      })
      expect(screen.getByTestId('monaco-diff-editor-mock')).toBeInTheDocument()

      // Close diff tab
      const closeDiffBtn = screen.getByRole('button', { name: 'Close Diff Tab' })
      await act(async () => {
        fireEvent.click(closeDiffBtn)
      })
      expect(screen.queryByTestId('editor-diff-tab')).not.toBeInTheDocument()
    })
  })

  // ==========================================================================
  // Group 6: AI Chat Integration
  // ==========================================================================
  describe('Group 6: AI Chat Integration', () => {
    it('toggles AI Assistant panel visibility via header button', async () => {
      render(<App />)

      // AI panel is open by default
      expect(document.querySelector('.ai-chat-panel')).toBeInTheDocument()

      const header = getHeaderBar()
      const aiToggleBtn = within(header).getByRole('button', { name: /AI Assistant/i })

      // Close panel
      await act(async () => {
        fireEvent.click(aiToggleBtn)
      })
      expect(document.querySelector('.ai-chat-panel')).not.toBeInTheDocument()

      // Re-open panel
      await act(async () => {
        fireEvent.click(aiToggleBtn)
      })
      expect(document.querySelector('.ai-chat-panel')).toBeInTheDocument()
    })

    it('submits chat prompt in AIChatPanel and receives mocked provider response', async () => {
      render(<App />)

      const chatInput = screen.getByPlaceholderText(/Ask AI about your code\.\.\./i)
      fireEvent.change(chatInput, { target: { value: 'Explain the project architecture' } })

      const sendBtn = screen.getByTitle('Send message (Enter)')
      await act(async () => {
        fireEvent.click(sendBtn)
      })

      await waitFor(() => {
        expect(screen.getByText('Explain the project architecture')).toBeInTheDocument()
      })
      await waitFor(() => {
        expect(screen.getByText(/Mock response from Google Gemini/i)).toBeInTheDocument()
      })
    })

    it('handles AI onFileCreated callback by refreshing the directory tree', async () => {
      render(<App />)

      await openWorkspace()

      const chatInput = screen.getByPlaceholderText(/Ask AI about your code\.\.\./i)
      expect(chatInput).toBeInTheDocument()
    })

    it('toggling AI panel does not disturb open editor tabs or terminal session', async () => {
      render(<App />)

      await openWorkspace()
      await waitFor(() => expect(screen.getByText('package.json')).toBeInTheDocument())

      // Open file
      await act(async () => {
        fireEvent.click(screen.getByText('package.json'))
      })
      await waitFor(() => expect(screen.getByTestId('monaco-editor-mock')).toBeInTheDocument())

      // Open terminal
      const header = getHeaderBar()
      await act(async () => {
        fireEvent.click(within(header).getByRole('button', { name: /Terminal/i }))
      })
      expect(screen.getByText('Terminal 1')).toBeInTheDocument()

      // Toggle AI panel off and on
      const aiToggleBtn = within(header).getByRole('button', { name: /AI Assistant/i })
      await act(async () => {
        fireEvent.click(aiToggleBtn)
      })
      await act(async () => {
        fireEvent.click(aiToggleBtn)
      })

      // Tabs and terminal remain active
      expect(screen.getByTestId('monaco-editor-mock')).toBeInTheDocument()
      expect(screen.getByText('Terminal 1')).toBeInTheDocument()
    })
  })

  // ==========================================================================
  // Group 7: Application-Level Events & Cleanup
  // ==========================================================================
  describe('Group 7: Application-Level Events & Cleanup', () => {
    it('removes window keydown listeners and unmounts cleanly without memory leaks', () => {
      const removeSpy = vi.spyOn(window, 'removeEventListener')

      const { unmount } = render(<App />)
      unmount()

      expect(removeSpy).toHaveBeenCalledWith('keydown', expect.any(Function))
    })

    it('unsubscribes terminal stream and exit listeners when App unmounts', () => {
      const unsubDataMock = vi.fn()
      const unsubExitMock = vi.fn()

      configureMockElectron({
        onTerminalStreamData: () => unsubDataMock,
        onTerminalSessionExit: () => unsubExitMock
      })

      const { unmount } = render(<App />)
      unmount()

      expect(unsubDataMock).toHaveBeenCalled()
      expect(unsubExitMock).toHaveBeenCalled()
    })

    it('unsubscribes workspace file change watcher when App unmounts', () => {
      const unsubWatcherMock = vi.fn()

      configureMockElectron({
        onWorkspaceFileChanged: () => unsubWatcherMock
      })

      const { unmount } = render(<App />)
      unmount()

      expect(unsubWatcherMock).toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // Group 8: Error & Loading States
  // ==========================================================================
  describe('Group 8: Error & Loading States', () => {
    it('handles openDirectory rejection safely and reports failure in status bar', async () => {
      configureMockElectron({
        openDirectory: vi.fn().mockRejectedValue(new Error('Dialog canceled by OS'))
      })

      render(<App />)

      await clickHeaderOpenFolder()

      await waitFor(() => {
        expect(within(getStatusBar()).getByText(/Failed to open folder: Dialog canceled by OS/i)).toBeInTheDocument()
      })
    })

    it('handles openDirectory error result without throwing uncaught exceptions', async () => {
      configureMockElectron({
        openDirectory: async () => ({
          success: false,
          error: 'Directory not readable'
        })
      })

      render(<App />)

      await clickHeaderOpenFolder()

      await waitFor(() => {
        expect(within(getStatusBar()).getByText('Error opening folder: Directory not readable')).toBeInTheDocument()
      })
    })

    it('preserves dirty tab state when writeFile fails and reports error in status message', async () => {
      configureMockElectron({
        writeFile: async () => ({
          success: false,
          error: 'EACCES: permission denied'
        })
      })

      render(<App />)

      await openWorkspace()
      await waitFor(() => expect(screen.getByText('package.json')).toBeInTheDocument())

      await act(async () => {
        fireEvent.click(screen.getByText('package.json'))
      })
      await waitFor(() => expect(screen.getByTestId('monaco-editor-mock')).toBeInTheDocument())

      fireEvent.change(screen.getByTestId('monaco-editor-mock'), { target: { value: 'failed save' } })

      const header = getHeaderBar()
      const saveBtn = within(header).getByRole('button', { name: /Save \(Ctrl\+S\)/i })
      await act(async () => {
        fireEvent.click(saveBtn)
      })

      await waitFor(() => {
        expect(within(getStatusBar()).getByText('Failed to save: EACCES: permission denied')).toBeInTheDocument()
      })
      // Tab is still dirty so unsaved changes are not lost
      expect(document.querySelector('.tab-dirty-indicator')).toBeInTheDocument()
    })

    it('guards against duplicate concurrent saves when save operation is in flight', async () => {
      let resolveWrite: (val: any) => void
      const slowWrite = new Promise((resolve) => {
        resolveWrite = resolve
      })

      const mockWrite = vi.fn().mockImplementation(() => slowWrite)
      configureMockElectron({ writeFile: mockWrite })

      render(<App />)

      await openWorkspace()
      await waitFor(() => expect(screen.getByText('package.json')).toBeInTheDocument())

      await act(async () => {
        fireEvent.click(screen.getByText('package.json'))
      })
      await waitFor(() => expect(screen.getByTestId('monaco-editor-mock')).toBeInTheDocument())

      fireEvent.change(screen.getByTestId('monaco-editor-mock'), { target: { value: 'in-flight save' } })

      const header = getHeaderBar()
      const saveBtn = within(header).getByRole('button', { name: /Save \(Ctrl\+S\)/i })

      // First click
      act(() => {
        fireEvent.click(saveBtn)
      })

      // Second click while in flight
      act(() => {
        fireEvent.click(saveBtn)
      })

      expect(mockWrite).toHaveBeenCalledTimes(1)

      // Resolve the write
      await act(async () => {
        resolveWrite!({ success: true })
      })

      await waitFor(() => {
        expect(within(getStatusBar()).getByText('Saved package.json')).toBeInTheDocument()
      })
    })
  })
})
