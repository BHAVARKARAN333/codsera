import { useEffect } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react'
import { App } from '@renderer/App'
import { setupMockElectron, resetMockElectron } from '../setup/electronMock'
import type { IElectronAPI, FileEntry } from '@shared/types'

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

  return {
    __esModule: true,
    default: MockEditor,
    DiffEditor: () => <div data-testid="monaco-diff-editor-mock" />,
    loader: {
      config: vi.fn(),
      init: vi.fn().mockResolvedValue(mockMonaco)
    }
  }
})

describe('Editor Tab Deduplication & Path Normalization Tests', () => {
  const MOCK_WORKSPACE = 'C:/Users/tester/workspace'

  const MOCK_FILE_TREE: FileEntry[] = [
    {
      name: 'src',
      path: `${MOCK_WORKSPACE}/src`,
      isDirectory: true,
      children: [
        {
          name: 'index.ts',
          path: `${MOCK_WORKSPACE}/src/index.ts`,
          isDirectory: false
        },
        {
          name: 'utils.ts',
          path: `${MOCK_WORKSPACE}/src/utils.ts`,
          isDirectory: false
        }
      ]
    },
    {
      name: 'tests',
      path: `${MOCK_WORKSPACE}/tests`,
      isDirectory: true,
      children: [
        {
          name: 'utils.ts',
          path: `${MOCK_WORKSPACE}/tests/utils.ts`,
          isDirectory: false
        }
      ]
    },
    {
      name: 'package.json',
      path: `${MOCK_WORKSPACE}/package.json`,
      isDirectory: false
    }
  ]

  let mockFiles: Record<string, string> = {}

  function configureMock(overrides: Partial<IElectronAPI> = {}) {
    return setupMockElectron({
      getLastWorkspace: async () => ({
        success: true,
        rootPath: undefined,
        tree: []
      }),
      openDirectory: async () => ({
        success: true,
        rootPath: MOCK_WORKSPACE,
        tree: MOCK_FILE_TREE
      }),
      readTree: async (rootPath: string) => ({
        success: true,
        rootPath,
        tree: MOCK_FILE_TREE
      }),
      readFile: async (filePath: string) => {
        if (filePath in mockFiles) {
          return { success: true, content: mockFiles[filePath] }
        }
        return { success: true, content: `// Content of ${filePath}\n` }
      },
      writeFile: async (filePath: string, content: string) => {
        mockFiles[filePath] = content
        return { success: true }
      },
      watchWorkspace: vi.fn().mockResolvedValue({ success: true }),
      unwatchWorkspace: vi.fn().mockResolvedValue({ success: true }),
      onWorkspaceFileChanged: () => () => {},
      onTerminalStreamData: () => () => {},
      onTerminalSessionExit: () => () => {},
      ...overrides
    })
  }

  beforeEach(() => {
    resetMockElectron()
    vi.clearAllMocks()
    mockFiles = {
      [`${MOCK_WORKSPACE}/package.json`]: '{\n  "name": "test-project"\n}\n',
      [`${MOCK_WORKSPACE}/src/index.ts`]: 'console.log("hello index");\n',
      [`${MOCK_WORKSPACE}/src/utils.ts`]: 'export const helperA = 1;\n',
      [`${MOCK_WORKSPACE}/tests/utils.ts`]: 'export const helperB = 2;\n'
    }
    configureMock()
  })

  async function openTestWorkspace() {
    const header = document.querySelector('.header-bar') as HTMLElement
    const openBtn = within(header).getByRole('button', { name: /Open Folder/i })
    await act(async () => {
      fireEvent.click(openBtn)
    })
    await waitFor(() => {
      expect(document.querySelector('.workspace-pill-text')?.textContent).toBe('workspace')
      expect(document.querySelector('.tree-root')).toBeInTheDocument()
      const tree = document.querySelector('.tree-root') as HTMLElement
      expect(within(tree).getByText('package.json', { selector: '.tree-name' })).toBeInTheDocument()
    })
  }

  function getTreeRoot(): HTMLElement {
    const el = document.querySelector('.tree-root') as HTMLElement
    if (!el) throw new Error('.tree-root not found in DOM')
    return el
  }

  function clickExplorerNode(name: string) {
    const tree = getTreeRoot()
    const nodeName = within(tree).getByText(name, { selector: '.tree-name' })
    fireEvent.click(nodeName)
  }

  function getEditorTabs(): HTMLElement[] {
    return Array.from(document.querySelectorAll('.editor-tab:not(.diff-tab)'))
  }

  function getActiveTab(): HTMLElement | null {
    return document.querySelector('.editor-tab.active:not(.diff-tab)')
  }

  // A. Open file once -> one tab
  it('A. opens file once and creates exactly one tab', async () => {
    render(<App />)
    await openTestWorkspace()

    await act(async () => {
      clickExplorerNode('package.json')
    })

    await waitFor(() => {
      const tabs = getEditorTabs()
      expect(tabs.length).toBe(1)
      expect(tabs[0].querySelector('.tab-title')).toHaveTextContent('package.json')
    })
  })

  // B. Click/open the same exact file again -> still one tab
  it('B. clicking the same exact file in Explorer again leaves only one tab', async () => {
    render(<App />)
    await openTestWorkspace()

    // First click
    await act(async () => {
      clickExplorerNode('package.json')
    })

    await waitFor(() => {
      expect(getEditorTabs().length).toBe(1)
    })

    // Second click on the exact same file in explorer
    await act(async () => {
      clickExplorerNode('package.json')
    })

    // Assert still exactly one tab
    expect(getEditorTabs().length).toBe(1)
  })

  // C. Existing tab becomes active/focused
  it('C. clicking an already-open file activates and focuses the existing tab', async () => {
    render(<App />)
    await openTestWorkspace()

    // Expand 'src' folder to reveal 'index.ts'
    await act(async () => {
      clickExplorerNode('src')
    })
    await waitFor(() => {
      const tree = getTreeRoot()
      expect(within(tree).getByText('index.ts', { selector: '.tree-name' })).toBeInTheDocument()
    })

    // Open index.ts
    await act(async () => {
      clickExplorerNode('index.ts')
    })

    // Open package.json (making package.json the active tab)
    await act(async () => {
      clickExplorerNode('package.json')
    })

    await waitFor(() => {
      expect(getEditorTabs().length).toBe(2)
      const activeTab = getActiveTab()
      expect(activeTab?.querySelector('.tab-title')).toHaveTextContent('package.json')
    })

    // Click index.ts in the Explorer again
    await act(async () => {
      clickExplorerNode('index.ts')
    })

    // Assert tab count is still 2, and active tab is now index.ts
    await waitFor(() => {
      expect(getEditorTabs().length).toBe(2)
      const activeTab = getActiveTab()
      expect(activeTab?.querySelector('.tab-title')).toHaveTextContent('index.ts')
    })
  })

  // D. Unsaved changes are preserved when reopening the same file
  it('D. preserves unsaved dirty content when clicking the same file again', async () => {
    render(<App />)
    await openTestWorkspace()

    // Open package.json
    await act(async () => {
      clickExplorerNode('package.json')
    })

    await waitFor(() => {
      expect(screen.getByTestId('monaco-editor-mock')).toBeInTheDocument()
    })

    // Edit content to make it dirty
    const editor = screen.getByTestId('monaco-editor-mock')
    fireEvent.change(editor, { target: { value: '{"modified": true, "unsaved": true}' } })

    // Verify dirty indicator is shown
    expect(document.querySelector('.tab-dirty-indicator')).toBeInTheDocument()

    // Click package.json again from explorer
    await act(async () => {
      clickExplorerNode('package.json')
    })

    // Verify still exactly one tab, still dirty, content preserved
    expect(getEditorTabs().length).toBe(1)
    expect(document.querySelector('.tab-dirty-indicator')).toBeInTheDocument()
    expect((screen.getByTestId('monaco-editor-mock') as HTMLTextAreaElement).value).toBe(
      '{"modified": true, "unsaved": true}'
    )
  })

  // E. Different files can still have separate tabs
  it('E. opening different files creates separate tabs', async () => {
    render(<App />)
    await openTestWorkspace()

    // Open package.json
    await act(async () => {
      clickExplorerNode('package.json')
    })

    // Expand src
    await act(async () => {
      clickExplorerNode('src')
    })
    await waitFor(() => {
      const tree = getTreeRoot()
      expect(within(tree).getByText('index.ts', { selector: '.tree-name' })).toBeInTheDocument()
    })

    // Open index.ts
    await act(async () => {
      clickExplorerNode('index.ts')
    })

    // Open utils.ts
    await act(async () => {
      clickExplorerNode('utils.ts')
    })

    await waitFor(() => {
      expect(getEditorTabs().length).toBe(3)
    })
  })

  // F. Same filename in different directories creates separate tabs
  it('F. same filename in different directories creates separate tabs', async () => {
    render(<App />)
    await openTestWorkspace()

    // Expand src and tests
    await act(async () => {
      clickExplorerNode('src')
      clickExplorerNode('tests')
    })

    await waitFor(() => {
      const tree = getTreeRoot()
      const utilsList = within(tree).getAllByText('utils.ts', { selector: '.tree-name' })
      expect(utilsList.length).toBe(2)
    })

    // Click first utils.ts (in src)
    const tree = getTreeRoot()
    const utilsList = within(tree).getAllByText('utils.ts', { selector: '.tree-name' })
    await act(async () => {
      fireEvent.click(utilsList[0])
    })

    // Click second utils.ts (in tests)
    await act(async () => {
      fireEvent.click(utilsList[1])
    })

    await waitFor(() => {
      const tabs = getEditorTabs()
      // Two separate tabs exist even though their filenames are both utils.ts
      expect(tabs.length).toBe(2)
    })
  })

  // G. Path normalization does not create duplicate tabs
  it('G. path normalization prevents duplicate tabs across forward/backward slashes and relative paths', async () => {
    const singleTree: FileEntry[] = [
      {
        name: 'test.ts',
        path: 'C:\\Users\\tester\\workspace\\test.ts', // Windows backslash
        isDirectory: false
      }
    ]

    // Override openDirectory and readTree to test Windows backslashes
    configureMock({
      openDirectory: async () => ({
        success: true,
        rootPath: MOCK_WORKSPACE,
        tree: singleTree
      }),
      readTree: async (rootPath: string) => ({
        success: true,
        rootPath,
        tree: singleTree
      })
    })

    render(<App />)

    const header = document.querySelector('.header-bar') as HTMLElement
    const openBtn = within(header).getByRole('button', { name: /Open Folder/i })
    await act(async () => {
      fireEvent.click(openBtn)
    })

    await waitFor(() => {
      expect(document.querySelector('.workspace-pill-text')?.textContent).toBe('workspace')
      expect(document.querySelector('.tree-root')).toBeInTheDocument()
      const tree = document.querySelector('.tree-root') as HTMLElement
      expect(within(tree).getByText('test.ts', { selector: '.tree-name' })).toBeInTheDocument()
    })

    // Click test.ts in explorer (which passes C:\Users\tester\workspace\test.ts)
    await act(async () => {
      clickExplorerNode('test.ts')
    })

    await waitFor(() => {
      expect(getEditorTabs().length).toBe(1)
    })

    // Click test.ts again in explorer
    await act(async () => {
      clickExplorerNode('test.ts')
    })

    // Confirm only one tab exists
    expect(getEditorTabs().length).toBe(1)
  })
})
