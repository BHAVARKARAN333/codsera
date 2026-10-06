/**
 * SourceControl Component Behavior Tests
 *
 * Verifies real React component rendering, user-visible Git workflows,
 * file staging/unstaging, discard dialogs, commit interactions, branch management,
 * and error/loading states using React Testing Library in happy-dom.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'
import { SourceControl } from '@renderer/components/SourceControl'
import { setupMockElectron, resetMockElectron } from '../setup/electronMock'
import type { GitStatusResult, GitBranchListResult } from '@shared/types'

// ============================================================================
// Test Fixtures & Helpers
// ============================================================================

const MOCK_WORKSPACE = '/workspace/test-project'

function createCleanStatus(branch = 'main'): GitStatusResult {
  return {
    success: true,
    isRepository: true,
    branch,
    clean: true,
    files: [],
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: []
  }
}

function createDirtyStatus(branch = 'main'): GitStatusResult {
  return {
    success: true,
    isRepository: true,
    branch,
    clean: false,
    files: [
      { path: 'src/index.ts', status: 'modified', staged: true },
      { path: 'src/newFeature.ts', status: 'added', staged: true },
      { path: 'src/app.tsx', status: 'modified', staged: false },
      { path: 'src/deprecated.ts', status: 'deleted', staged: false },
      { path: 'notes.txt', status: 'untracked', staged: false }
    ],
    staged: ['M src/index.ts', 'A src/newFeature.ts'],
    unstaged: ['M src/app.tsx', 'D src/deprecated.ts'],
    untracked: ['notes.txt'],
    conflicted: []
  }
}

function createBranchList(current?: string | null, branches = ['main', 'feature/login', 'develop']): GitBranchListResult {
  return {
    success: true,
    isRepository: true,
    currentBranch: current ?? null,
    branches
  }
}

// ============================================================================
// Test Suite
// ============================================================================

describe('SourceControl Component Tests', () => {
  let mockGitStatus: any
  let mockGitBranchList: any
  let mockGitStageFile: any
  let mockGitUnstageFile: any
  let mockGitStageAll: any
  let mockGitUnstageAll: any
  let mockGitCommit: any
  let mockGitDiscardFile: any
  let mockGitBranchCheckout: any
  let mockGitBranchCreate: any

  beforeEach(() => {
    mockGitStatus = vi.fn().mockResolvedValue(createCleanStatus())
    mockGitBranchList = vi.fn().mockResolvedValue(createBranchList())
    mockGitStageFile = vi.fn().mockResolvedValue({ success: true })
    mockGitUnstageFile = vi.fn().mockResolvedValue({ success: true })
    mockGitStageAll = vi.fn().mockResolvedValue({ success: true })
    mockGitUnstageAll = vi.fn().mockResolvedValue({ success: true })
    mockGitCommit = vi.fn().mockResolvedValue({ success: true, commitHash: 'abc1234', summary: 'test commit' })
    mockGitDiscardFile = vi.fn().mockResolvedValue({ success: true, path: 'src/app.tsx' })
    mockGitBranchCheckout = vi.fn().mockResolvedValue({ success: true, branch: 'develop' })
    mockGitBranchCreate = vi.fn().mockResolvedValue({ success: true, branch: 'feature/new-branch' })

    setupMockElectron({
      gitStatus: mockGitStatus,
      gitBranchList: mockGitBranchList,
      gitStageFile: mockGitStageFile,
      gitUnstageFile: mockGitUnstageFile,
      gitStageAll: mockGitStageAll,
      gitUnstageAll: mockGitUnstageAll,
      gitCommit: mockGitCommit,
      gitDiscardFile: mockGitDiscardFile,
      gitBranchCheckout: mockGitBranchCheckout,
      gitBranchCreate: mockGitBranchCreate
    })
  })

  afterEach(() => {
    cleanup()
    resetMockElectron()
    vi.clearAllMocks()
  })

  // ==========================================================================
  // Group 1: Rendering & Initial State
  // ==========================================================================
  describe('Group 1: Rendering & Initial State', () => {
    it('renders "No Workspace Open" empty state when rootPath is null', () => {
      render(<SourceControl rootPath={null} />)

      expect(screen.getByTestId('no-workspace-state')).toBeInTheDocument()
      expect(screen.getByText('No Workspace Open')).toBeInTheDocument()
      expect(
        screen.getByText('Open a folder or project to view source control and track changes.')
      ).toBeInTheDocument()
      expect(mockGitStatus).not.toHaveBeenCalled()
    })

    it('renders "No Git Repository" state when workspace is not a Git repo', async () => {
      mockGitStatus.mockResolvedValueOnce({
        success: true,
        isRepository: false,
        clean: true,
        files: [],
        staged: [],
        unstaged: [],
        untracked: [],
        conflicted: []
      })

      render(<SourceControl rootPath={MOCK_WORKSPACE} />)

      await waitFor(() => {
        expect(screen.getByTestId('non-repo-state')).toBeInTheDocument()
      })
      expect(screen.getByText('No Git Repository')).toBeInTheDocument()
      expect(
        screen.getByText('The currently opened workspace is not a Git repository.')
      ).toBeInTheDocument()
    })

    it('renders clean working tree state when there are no changes', async () => {
      mockGitStatus.mockResolvedValueOnce(createCleanStatus('main'))
      mockGitBranchList.mockResolvedValueOnce(createBranchList('main', ['main']))

      render(<SourceControl rootPath={MOCK_WORKSPACE} />)

      await waitFor(() => {
        expect(screen.getByTestId('clean-state')).toBeInTheDocument()
      })
      expect(screen.getByText('Working Tree Clean')).toBeInTheDocument()
      expect(screen.getByText('No uncommitted changes detected in this repository.')).toBeInTheDocument()
      expect(screen.getByText('main')).toBeInTheDocument()
    })

    it('renders current branch pill with correct branch name and attributes', async () => {
      mockGitStatus.mockResolvedValueOnce(createCleanStatus('feature/awesome-ui'))
      mockGitBranchList.mockResolvedValueOnce(createBranchList('feature/awesome-ui', ['feature/awesome-ui']))

      render(<SourceControl rootPath={MOCK_WORKSPACE} />)

      await waitFor(() => {
        expect(screen.getByText('feature/awesome-ui')).toBeInTheDocument()
      })

      const branchBtn = screen.getByRole('button', {
        name: /Branch: feature\/awesome-ui/i
      })
      expect(branchBtn).toBeInTheDocument()
      expect(branchBtn).toHaveAttribute('aria-haspopup', 'true')
      expect(branchBtn).toHaveAttribute('aria-expanded', 'false')
    })

    it('invokes onGitStatusUpdated callback with the fetched status', async () => {
      const onGitStatusUpdated = vi.fn()
      const dirty = createDirtyStatus('main')
      mockGitStatus.mockResolvedValueOnce(dirty)

      render(<SourceControl rootPath={MOCK_WORKSPACE} onGitStatusUpdated={onGitStatusUpdated} />)

      await waitFor(() => {
        expect(onGitStatusUpdated).toHaveBeenCalledWith(dirty)
      })
    })

    it('renders quick stat summary badges for staged, modified, and untracked counts', async () => {
      mockGitStatus.mockResolvedValueOnce(createDirtyStatus('main'))

      render(<SourceControl rootPath={MOCK_WORKSPACE} />)

      await waitFor(() => {
        expect(screen.getByTestId('changes-state')).toBeInTheDocument()
      })

      expect(screen.getByTitle('2 staged file(s)')).toBeInTheDocument()
      expect(screen.getByTitle('2 unstaged file(s)')).toBeInTheDocument()
      expect(screen.getByTitle('1 untracked file(s)')).toBeInTheDocument()
    })
  })

  // ==========================================================================
  // Group 2: Changed Files Display & Selection
  // ==========================================================================
  describe('Group 2: Changed Files Display & Selection', () => {
    beforeEach(() => {
      mockGitStatus.mockResolvedValue(createDirtyStatus('main'))
    })

    it('renders staged changes section and unstaged changes section', async () => {
      render(<SourceControl rootPath={MOCK_WORKSPACE} />)

      await waitFor(() => {
        expect(screen.getByTestId('staged-section')).toBeInTheDocument()
        expect(screen.getByTestId('unstaged-section')).toBeInTheDocument()
      })

      expect(screen.getByText('STAGED CHANGES (2)')).toBeInTheDocument()
      expect(screen.getByText('CHANGES (3)')).toBeInTheDocument()
    })

    it('renders correct file names, paths, and status badge letters', async () => {
      render(<SourceControl rootPath={MOCK_WORKSPACE} />)

      await waitFor(() => {
        expect(screen.getByTestId('staged-file-src/index.ts')).toBeInTheDocument()
      })

      // Staged file
      const stagedIndex = screen.getByTestId('staged-file-src/index.ts')
      expect(stagedIndex).toHaveTextContent('index.ts')
      expect(stagedIndex).toHaveTextContent('src')
      expect(stagedIndex).toHaveTextContent('INDEX')
      expect(stagedIndex).toHaveTextContent('M')

      // Unstaged files
      const unstagedApp = screen.getByTestId('unstaged-file-src/app.tsx')
      expect(unstagedApp).toHaveTextContent('app.tsx')
      expect(unstagedApp).toHaveTextContent('M')

      const unstagedDep = screen.getByTestId('unstaged-file-src/deprecated.ts')
      expect(unstagedDep).toHaveTextContent('deprecated.ts')
      expect(unstagedDep).toHaveTextContent('D')

      const untrackedNotes = screen.getByTestId('unstaged-file-notes.txt')
      expect(untrackedNotes).toHaveTextContent('notes.txt')
      expect(untrackedNotes).toHaveTextContent('U')
    })

    it('triggers onOpenFileDiff when clicking on a staged file row', async () => {
      const onOpenFileDiff = vi.fn()
      render(<SourceControl rootPath={MOCK_WORKSPACE} onOpenFileDiff={onOpenFileDiff} />)

      await waitFor(() => {
        expect(screen.getByTestId('staged-file-src/index.ts')).toBeInTheDocument()
      })

      fireEvent.click(screen.getByTestId('staged-file-src/index.ts'))
      expect(onOpenFileDiff).toHaveBeenCalledWith('src/index.ts', true)
    })

    it('triggers onOpenFileDiff when clicking on an unstaged file row', async () => {
      const onOpenFileDiff = vi.fn()
      render(<SourceControl rootPath={MOCK_WORKSPACE} onOpenFileDiff={onOpenFileDiff} />)

      await waitFor(() => {
        expect(screen.getByTestId('unstaged-file-src/app.tsx')).toBeInTheDocument()
      })

      fireEvent.click(screen.getByTestId('unstaged-file-src/app.tsx'))
      expect(onOpenFileDiff).toHaveBeenCalledWith('src/app.tsx', false)
    })

    it('triggers onOpenFileDiff when pressing Enter or Space on a focused file item', async () => {
      const onOpenFileDiff = vi.fn()
      render(<SourceControl rootPath={MOCK_WORKSPACE} onOpenFileDiff={onOpenFileDiff} />)

      await waitFor(() => {
        expect(screen.getByTestId('staged-file-src/newFeature.ts')).toBeInTheDocument()
      })

      const item = screen.getByTestId('staged-file-src/newFeature.ts')
      fireEvent.keyDown(item, { key: 'Enter' })
      expect(onOpenFileDiff).toHaveBeenCalledWith('src/newFeature.ts', true)

      fireEvent.keyDown(item, { key: ' ' })
      expect(onOpenFileDiff).toHaveBeenCalledTimes(2)
    })

    it('triggers onOpenFileDiff when clicking the diff button icon', async () => {
      const onOpenFileDiff = vi.fn()
      render(<SourceControl rootPath={MOCK_WORKSPACE} onOpenFileDiff={onOpenFileDiff} />)

      await waitFor(() => {
        expect(screen.getByLabelText('Open diff for src/index.ts')).toBeInTheDocument()
      })

      fireEvent.click(screen.getByLabelText('Open diff for src/index.ts'))
      expect(onOpenFileDiff).toHaveBeenCalledWith('src/index.ts', true)

      fireEvent.click(screen.getByLabelText('View diff for src/app.tsx'))
      expect(onOpenFileDiff).toHaveBeenCalledWith('src/app.tsx', false)
    })

    it('applies selected class to active diff file item', async () => {
      render(
        <SourceControl
          rootPath={MOCK_WORKSPACE}
          activeDiffPath="src/index.ts"
          activeDiffStaged={true}
        />
      )

      await waitFor(() => {
        expect(screen.getByTestId('staged-file-src/index.ts')).toHaveClass('selected')
      })

      expect(screen.getByTestId('staged-file-src/newFeature.ts')).not.toHaveClass('selected')
    })
  })

  // ==========================================================================
  // Group 3: Staging & Unstaging
  // ==========================================================================
  describe('Group 3: Staging & Unstaging', () => {
    beforeEach(() => {
      mockGitStatus.mockResolvedValue(createDirtyStatus('main'))
    })

    it('calls gitStageFile and notifies onStatusMessage when clicking stage button on a file', async () => {
      const onStatusMessage = vi.fn()
      render(<SourceControl rootPath={MOCK_WORKSPACE} onStatusMessage={onStatusMessage} />)

      await waitFor(() => {
        expect(screen.getByLabelText('Stage src/app.tsx')).toBeInTheDocument()
      })

      fireEvent.click(screen.getByLabelText('Stage src/app.tsx'))

      await waitFor(() => {
        expect(mockGitStageFile).toHaveBeenCalledWith(MOCK_WORKSPACE, 'src/app.tsx')
      })
      expect(onStatusMessage).toHaveBeenCalledWith('Staged src/app.tsx')
    })

    it('calls gitUnstageFile and notifies onStatusMessage when clicking unstage button on a file', async () => {
      const onStatusMessage = vi.fn()
      render(<SourceControl rootPath={MOCK_WORKSPACE} onStatusMessage={onStatusMessage} />)

      await waitFor(() => {
        expect(screen.getByLabelText('Unstage src/index.ts')).toBeInTheDocument()
      })

      fireEvent.click(screen.getByLabelText('Unstage src/index.ts'))

      await waitFor(() => {
        expect(mockGitUnstageFile).toHaveBeenCalledWith(MOCK_WORKSPACE, 'src/index.ts')
      })
      expect(onStatusMessage).toHaveBeenCalledWith('Unstaged src/index.ts')
    })

    it('calls gitStageAll when clicking "Stage All Changes" button', async () => {
      const onStatusMessage = vi.fn()
      render(<SourceControl rootPath={MOCK_WORKSPACE} onStatusMessage={onStatusMessage} />)

      await waitFor(() => {
        expect(screen.getByLabelText('Stage All Changes')).toBeInTheDocument()
      })

      fireEvent.click(screen.getByLabelText('Stage All Changes'))

      await waitFor(() => {
        expect(mockGitStageAll).toHaveBeenCalledWith(MOCK_WORKSPACE)
      })
      expect(onStatusMessage).toHaveBeenCalledWith('Staged all changes.')
    })

    it('calls gitUnstageAll when clicking "Unstage All Changes" button', async () => {
      const onStatusMessage = vi.fn()
      render(<SourceControl rootPath={MOCK_WORKSPACE} onStatusMessage={onStatusMessage} />)

      await waitFor(() => {
        expect(screen.getByLabelText('Unstage All Changes')).toBeInTheDocument()
      })

      fireEvent.click(screen.getByLabelText('Unstage All Changes'))

      await waitFor(() => {
        expect(mockGitUnstageAll).toHaveBeenCalledWith(MOCK_WORKSPACE)
      })
      expect(onStatusMessage).toHaveBeenCalledWith('Unstaged all changes.')
    })

    it('displays action error banner when staging operation fails', async () => {
      mockGitStageFile.mockResolvedValueOnce({
        success: false,
        error: 'Permission denied while accessing file'
      })

      render(<SourceControl rootPath={MOCK_WORKSPACE} />)

      await waitFor(() => {
        expect(screen.getByLabelText('Stage src/app.tsx')).toBeInTheDocument()
      })

      fireEvent.click(screen.getByLabelText('Stage src/app.tsx'))

      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeInTheDocument()
      })
      expect(screen.getByText(/Permission denied while accessing file/i)).toBeInTheDocument()
    })

    it('dismisses action error banner when close button is clicked', async () => {
      mockGitStageFile.mockResolvedValueOnce({
        success: false,
        error: 'Failed to stage file'
      })

      render(<SourceControl rootPath={MOCK_WORKSPACE} />)

      await waitFor(() => {
        expect(screen.getByLabelText('Stage src/app.tsx')).toBeInTheDocument()
      })

      fireEvent.click(screen.getByLabelText('Stage src/app.tsx'))

      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeInTheDocument()
      })

      fireEvent.click(screen.getByLabelText('Dismiss error'))

      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })

    it('retries status refresh when retry button in action error banner is clicked', async () => {
      mockGitStageFile.mockResolvedValueOnce({
        success: false,
        error: 'Failed to stage file'
      })

      render(<SourceControl rootPath={MOCK_WORKSPACE} />)

      await waitFor(() => {
        expect(screen.getByLabelText('Stage src/app.tsx')).toBeInTheDocument()
      })

      fireEvent.click(screen.getByLabelText('Stage src/app.tsx'))

      await waitFor(() => {
        expect(screen.getByLabelText('Refresh / Retry Git Status')).toBeInTheDocument()
      })

      const statusCallCount = mockGitStatus.mock.calls.length
      fireEvent.click(screen.getByLabelText('Refresh / Retry Git Status'))

      await waitFor(() => {
        expect(mockGitStatus.mock.calls.length).toBeGreaterThan(statusCallCount)
      })
    })
  })

  // ==========================================================================
  // Group 4: Discard Changes Modal
  // ==========================================================================
  describe('Group 4: Discard Changes Modal', () => {
    beforeEach(() => {
      mockGitStatus.mockResolvedValue(createDirtyStatus('main'))
    })

    it('opens discard confirmation dialog when discard button is clicked on an unstaged file', async () => {
      render(<SourceControl rootPath={MOCK_WORKSPACE} />)

      await waitFor(() => {
        expect(screen.getByLabelText('Discard changes in src/app.tsx')).toBeInTheDocument()
      })

      fireEvent.click(screen.getByLabelText('Discard changes in src/app.tsx'))

      const modal = screen.getByRole('dialog')
      expect(modal).toBeInTheDocument()
      expect(within(modal).getByRole('button', { name: 'Discard Changes' })).toBeInTheDocument()
      expect(within(modal).getByText(/Are you sure you want to discard changes in/i)).toBeInTheDocument()
      expect(within(modal).getByText('app.tsx')).toBeInTheDocument()
      expect(within(modal).getByText('src/app.tsx')).toBeInTheDocument()
      expect(within(modal).getByText(/All changes in this file will be permanently lost/i)).toBeInTheDocument()
    })

    it('closes discard modal on Cancel click without calling gitDiscardFile', async () => {
      render(<SourceControl rootPath={MOCK_WORKSPACE} />)

      await waitFor(() => {
        expect(screen.getByLabelText('Discard changes in src/app.tsx')).toBeInTheDocument()
      })

      fireEvent.click(screen.getByLabelText('Discard changes in src/app.tsx'))
      const modal = screen.getByRole('dialog')
      expect(modal).toBeInTheDocument()

      const cancelButtons = within(modal).getAllByRole('button', { name: 'Cancel' })
      fireEvent.click(cancelButtons[0])

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(mockGitDiscardFile).not.toHaveBeenCalled()
    })

    it('closes discard modal on Escape key press', async () => {
      render(<SourceControl rootPath={MOCK_WORKSPACE} />)

      await waitFor(() => {
        expect(screen.getByLabelText('Discard changes in src/app.tsx')).toBeInTheDocument()
      })

      fireEvent.click(screen.getByLabelText('Discard changes in src/app.tsx'))
      expect(screen.getByRole('dialog')).toBeInTheDocument()

      fireEvent.keyDown(window, { key: 'Escape' })

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(mockGitDiscardFile).not.toHaveBeenCalled()
    })

    it('calls gitDiscardFile on confirmation, closes modal, and refreshes status', async () => {
      const onStatusMessage = vi.fn()
      render(<SourceControl rootPath={MOCK_WORKSPACE} onStatusMessage={onStatusMessage} />)

      await waitFor(() => {
        expect(screen.getByLabelText('Discard changes in src/app.tsx')).toBeInTheDocument()
      })

      fireEvent.click(screen.getByLabelText('Discard changes in src/app.tsx'))

      const modal = screen.getByRole('dialog')
      const confirmBtn = within(modal).getByRole('button', { name: 'Discard Changes' })
      fireEvent.click(confirmBtn)

      await waitFor(() => {
        expect(mockGitDiscardFile).toHaveBeenCalledWith(MOCK_WORKSPACE, 'src/app.tsx')
      })
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(onStatusMessage).toHaveBeenCalledWith('Discarded changes in src/app.tsx')
    })

    it('displays error in modal if gitDiscardFile fails and keeps modal open', async () => {
      mockGitDiscardFile.mockResolvedValueOnce({
        success: false,
        error: 'File locked by another process'
      })

      render(<SourceControl rootPath={MOCK_WORKSPACE} />)

      await waitFor(() => {
        expect(screen.getByLabelText('Discard changes in src/app.tsx')).toBeInTheDocument()
      })

      fireEvent.click(screen.getByLabelText('Discard changes in src/app.tsx'))
      const modal = screen.getByRole('dialog')
      fireEvent.click(within(modal).getByRole('button', { name: 'Discard Changes' }))

      await waitFor(() => {
        expect(within(modal).getByText(/File locked by another process/i)).toBeInTheDocument()
      })
      expect(screen.getByRole('dialog')).toBeInTheDocument()
    })
  })

  // ==========================================================================
  // Group 5: Commit Workflow
  // ==========================================================================
  describe('Group 5: Commit Workflow', () => {
    it('disables commit button when message is empty even with staged changes', async () => {
      mockGitStatus.mockResolvedValue(createDirtyStatus('main'))
      render(<SourceControl rootPath={MOCK_WORKSPACE} />)

      await waitFor(() => {
        expect(screen.getByTestId('commit-button')).toBeInTheDocument()
      })

      expect(screen.getByTestId('commit-button')).toBeDisabled()
    })

    it('disables commit button when there are no staged changes even with a message', async () => {
      // Repository with only unstaged changes
      mockGitStatus.mockResolvedValue({
        success: true,
        isRepository: true,
        branch: 'main',
        clean: false,
        files: [{ path: 'src/app.tsx', status: 'modified', staged: false }],
        staged: [],
        unstaged: ['M src/app.tsx'],
        untracked: [],
        conflicted: []
      })

      render(<SourceControl rootPath={MOCK_WORKSPACE} />)

      await waitFor(() => {
        expect(screen.getByTestId('commit-message-input')).toBeInTheDocument()
      })

      const input = screen.getByTestId('commit-message-input')
      fireEvent.change(input, { target: { value: 'feat: add something' } })

      expect(screen.getByTestId('commit-button')).toBeDisabled()
      expect(
        screen.getByText('No staged changes to commit. Stage changes first.')
      ).toBeInTheDocument()
    })

    it('shows validation error when pressing Ctrl+Enter with empty message', async () => {
      mockGitStatus.mockResolvedValue(createDirtyStatus('main'))
      render(<SourceControl rootPath={MOCK_WORKSPACE} />)

      await waitFor(() => {
        expect(screen.getByTestId('commit-message-input')).toBeInTheDocument()
      })

      const input = screen.getByTestId('commit-message-input')
      fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })

      expect(screen.getByText('Commit message cannot be empty.')).toBeInTheDocument()
      expect(mockGitCommit).not.toHaveBeenCalled()
    })

    it('shows validation error when pressing Ctrl+Enter with message but no staged files', async () => {
      mockGitStatus.mockResolvedValue({
        success: true,
        isRepository: true,
        branch: 'main',
        clean: false,
        files: [{ path: 'src/app.tsx', status: 'modified', staged: false }],
        staged: [],
        unstaged: ['M src/app.tsx'],
        untracked: [],
        conflicted: []
      })

      render(<SourceControl rootPath={MOCK_WORKSPACE} />)

      await waitFor(() => {
        expect(screen.getByTestId('commit-message-input')).toBeInTheDocument()
      })

      const input = screen.getByTestId('commit-message-input')
      fireEvent.change(input, { target: { value: 'fix: something' } })
      fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })

      expect(
        screen.getByText('No staged changes to commit. Please stage changes first.')
      ).toBeInTheDocument()
      expect(mockGitCommit).not.toHaveBeenCalled()
    })

    it('enables commit button and calls gitCommit on click when message and staged files are present', async () => {
      mockGitStatus.mockResolvedValue(createDirtyStatus('main'))
      const onStatusMessage = vi.fn()

      render(<SourceControl rootPath={MOCK_WORKSPACE} onStatusMessage={onStatusMessage} />)

      await waitFor(() => {
        expect(screen.getByTestId('commit-message-input')).toBeInTheDocument()
      })

      const input = screen.getByTestId('commit-message-input')
      fireEvent.change(input, { target: { value: 'feat: new awesome feature' } })

      const commitBtn = screen.getByTestId('commit-button')
      expect(commitBtn).not.toBeDisabled()

      fireEvent.click(commitBtn)

      await waitFor(() => {
        expect(mockGitCommit).toHaveBeenCalledWith(MOCK_WORKSPACE, 'feat: new awesome feature')
      })
      // Successful commit clears message input
      expect(input).toHaveValue('')
      // Displays commit success notification
      expect(screen.getByRole('status')).toBeInTheDocument()
      expect(screen.getByText(/Commit abc1234 created/i)).toBeInTheDocument()
    })

    it('submits commit via Ctrl+Enter shortcut', async () => {
      mockGitStatus.mockResolvedValue(createDirtyStatus('main'))
      render(<SourceControl rootPath={MOCK_WORKSPACE} />)

      await waitFor(() => {
        expect(screen.getByTestId('commit-message-input')).toBeInTheDocument()
      })

      const input = screen.getByTestId('commit-message-input')
      fireEvent.change(input, { target: { value: 'refactor: clean up' } })
      fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })

      await waitFor(() => {
        expect(mockGitCommit).toHaveBeenCalledWith(MOCK_WORKSPACE, 'refactor: clean up')
      })
      expect(input).toHaveValue('')
    })

    it('submits commit via Meta+Enter (Cmd+Enter on macOS) shortcut', async () => {
      mockGitStatus.mockResolvedValue(createDirtyStatus('main'))
      render(<SourceControl rootPath={MOCK_WORKSPACE} />)

      await waitFor(() => {
        expect(screen.getByTestId('commit-message-input')).toBeInTheDocument()
      })

      const input = screen.getByTestId('commit-message-input')
      fireEvent.change(input, { target: { value: 'refactor: clean up via meta' } })
      fireEvent.keyDown(input, { key: 'Enter', metaKey: true })

      await waitFor(() => {
        expect(mockGitCommit).toHaveBeenCalledWith(MOCK_WORKSPACE, 'refactor: clean up via meta')
      })
      expect(input).toHaveValue('')
    })

    it('preserves commit message in textarea when commit fails', async () => {
      mockGitStatus.mockResolvedValue(createDirtyStatus('main'))
      mockGitCommit.mockResolvedValueOnce({
        success: false,
        error: 'Pre-commit hook failed: lint errors'
      })

      render(<SourceControl rootPath={MOCK_WORKSPACE} />)

      await waitFor(() => {
        expect(screen.getByTestId('commit-message-input')).toBeInTheDocument()
      })

      const input = screen.getByTestId('commit-message-input')
      fireEvent.change(input, { target: { value: 'feat: risky change' } })
      fireEvent.click(screen.getByTestId('commit-button'))

      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeInTheDocument()
      })
      expect(screen.getByText(/Pre-commit hook failed/i)).toBeInTheDocument()
      // Message must be preserved so user does not lose their typed message
      expect(input).toHaveValue('feat: risky change')
    })
  })

  // ==========================================================================
  // Group 6: Branch Management
  // ==========================================================================
  describe('Group 6: Branch Management', () => {
    beforeEach(() => {
      mockGitStatus.mockResolvedValue(createCleanStatus('main'))
      mockGitBranchList.mockResolvedValue(createBranchList('main', ['main', 'feature/login', 'develop']))
    })

    it('toggles branch dropdown menu when clicking branch pill', async () => {
      render(<SourceControl rootPath={MOCK_WORKSPACE} />)

      await waitFor(() => {
        expect(screen.getByText('main')).toBeInTheDocument()
      })

      const branchBtn = screen.getByRole('button', { name: /Branch: main/i })
      fireEvent.click(branchBtn)

      await waitFor(() => {
        expect(screen.getByRole('menu', { name: 'Git Branches' })).toBeInTheDocument()
        expect(screen.getByRole('menuitem', { name: /feature\/login/i })).toBeInTheDocument()
        expect(screen.getByRole('menuitem', { name: /develop/i })).toBeInTheDocument()
      })

      // Toggle closed
      fireEvent.click(branchBtn)
      expect(screen.queryByRole('menu', { name: 'Git Branches' })).not.toBeInTheDocument()
    })

    it('filters branches case-insensitively with the search input', async () => {
      render(<SourceControl rootPath={MOCK_WORKSPACE} />)

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Branch: main/i })).toBeInTheDocument()
      })

      fireEvent.click(screen.getByRole('button', { name: /Branch: main/i }))

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Filter branches...')).toBeInTheDocument()
      })

      const filterInput = screen.getByPlaceholderText('Filter branches...')
      fireEvent.change(filterInput, { target: { value: 'LOGIN' } })

      await waitFor(() => {
        expect(screen.getByRole('menuitem', { name: /feature\/login/i })).toBeInTheDocument()
        expect(screen.queryByRole('menuitem', { name: /develop/i })).not.toBeInTheDocument()
      })
    })

    it('shows empty message when branch search filter has no matches', async () => {
      render(<SourceControl rootPath={MOCK_WORKSPACE} />)

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Branch: main/i })).toBeInTheDocument()
      })

      fireEvent.click(screen.getByRole('button', { name: /Branch: main/i }))

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Filter branches...')).toBeInTheDocument()
      })

      const filterInput = screen.getByPlaceholderText('Filter branches...')
      fireEvent.change(filterInput, { target: { value: 'nonexistent-branch' } })

      await waitFor(() => {
        expect(screen.getByText('No branch matches "nonexistent-branch"')).toBeInTheDocument()
      })
    })

    it('clears branch search filter when clear button is clicked', async () => {
      render(<SourceControl rootPath={MOCK_WORKSPACE} />)

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Branch: main/i })).toBeInTheDocument()
      })

      fireEvent.click(screen.getByRole('button', { name: /Branch: main/i }))

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Filter branches...')).toBeInTheDocument()
      })

      const filterInput = screen.getByPlaceholderText('Filter branches...')
      fireEvent.change(filterInput, { target: { value: 'login' } })

      await waitFor(() => {
        expect(screen.getByLabelText('Clear branch search')).toBeInTheDocument()
      })

      fireEvent.click(screen.getByLabelText('Clear branch search'))
      expect(filterInput).toHaveValue('')

      await waitFor(() => {
        expect(screen.getByRole('menuitem', { name: /develop/i })).toBeInTheDocument()
      })
    })

    it('switches branch directly when hasUnsavedChanges is false', async () => {
      const onStatusMessage = vi.fn()
      render(
        <SourceControl
          rootPath={MOCK_WORKSPACE}
          hasUnsavedChanges={false}
          onStatusMessage={onStatusMessage}
        />
      )

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Branch: main/i })).toBeInTheDocument()
      })

      fireEvent.click(screen.getByRole('button', { name: /Branch: main/i }))

      await waitFor(() => {
        expect(screen.getByRole('menuitem', { name: /develop/i })).toBeInTheDocument()
      })

      fireEvent.click(screen.getByRole('menuitem', { name: /develop/i }))

      await waitFor(() => {
        expect(mockGitBranchCheckout).toHaveBeenCalledWith(MOCK_WORKSPACE, 'develop')
      })
      expect(onStatusMessage).toHaveBeenCalledWith("Switched to branch 'develop'.")
    })

    it('prompts confirmation modal when switching branch with hasUnsavedChanges true', async () => {
      render(
        <SourceControl
          rootPath={MOCK_WORKSPACE}
          hasUnsavedChanges={true}
          dirtyTabNames={['App.tsx', 'index.ts']}
        />
      )

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Branch: main/i })).toBeInTheDocument()
      })

      fireEvent.click(screen.getByRole('button', { name: /Branch: main/i }))

      await waitFor(() => {
        expect(screen.getByRole('menuitem', { name: /develop/i })).toBeInTheDocument()
      })

      fireEvent.click(screen.getByRole('menuitem', { name: /develop/i }))

      expect(screen.getByRole('dialog')).toBeInTheDocument()
      expect(screen.getByText('Switch Branch: Unsaved Changes')).toBeInTheDocument()
      expect(screen.getByText('App.tsx')).toBeInTheDocument()
      expect(screen.getByText('index.ts')).toBeInTheDocument()
      expect(mockGitBranchCheckout).not.toHaveBeenCalled()
    })

    it('cancels branch switch on modal Cancel click', async () => {
      render(
        <SourceControl
          rootPath={MOCK_WORKSPACE}
          hasUnsavedChanges={true}
          dirtyTabNames={['App.tsx']}
        />
      )

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Branch: main/i })).toBeInTheDocument()
      })

      fireEvent.click(screen.getByRole('button', { name: /Branch: main/i }))

      await waitFor(() => {
        expect(screen.getByRole('menuitem', { name: /develop/i })).toBeInTheDocument()
      })

      fireEvent.click(screen.getByRole('menuitem', { name: /develop/i }))

      const modal = screen.getByRole('dialog')
      const cancelBtn = within(modal).getAllByRole('button', { name: 'Cancel' })[0]
      fireEvent.click(cancelBtn)

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(mockGitBranchCheckout).not.toHaveBeenCalled()
    })

    it('proceeds with checkout on modal Confirm click', async () => {
      render(
        <SourceControl
          rootPath={MOCK_WORKSPACE}
          hasUnsavedChanges={true}
          dirtyTabNames={['App.tsx']}
        />
      )

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Branch: main/i })).toBeInTheDocument()
      })

      fireEvent.click(screen.getByRole('button', { name: /Branch: main/i }))

      await waitFor(() => {
        expect(screen.getByRole('menuitem', { name: /develop/i })).toBeInTheDocument()
      })

      fireEvent.click(screen.getByRole('menuitem', { name: /develop/i }))

      const confirmBtn = screen.getByRole('button', { name: 'Switch Branch' })
      fireEvent.click(confirmBtn)

      await waitFor(() => {
        expect(mockGitBranchCheckout).toHaveBeenCalledWith(MOCK_WORKSPACE, 'develop')
      })
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it('opens Create Branch modal from plus button and validates branch name', async () => {
      render(<SourceControl rootPath={MOCK_WORKSPACE} />)

      await waitFor(() => {
        expect(screen.getByLabelText('Create New Branch')).toBeInTheDocument()
      })

      fireEvent.click(screen.getByLabelText('Create New Branch'))

      expect(screen.getByRole('dialog')).toBeInTheDocument()
      expect(screen.getByText('Create New Branch')).toBeInTheDocument()

      const input = screen.getByPlaceholderText('e.g. feature/my-new-branch')

      // Empty branch name validation
      fireEvent.change(input, { target: { value: '   ' } })
      fireEvent.submit(input.closest('form')!)
      expect(screen.getByText('Branch name cannot be empty.')).toBeInTheDocument()
      expect(mockGitBranchCreate).not.toHaveBeenCalled()

      // Invalid branch name validation (contains consecutive dots)
      fireEvent.change(input, { target: { value: 'feature..branch' } })
      fireEvent.submit(input.closest('form')!)
      expect(
        screen.getByText('Branch name cannot contain consecutive dots (..).')
      ).toBeInTheDocument()
      expect(mockGitBranchCreate).not.toHaveBeenCalled()

      // Duplicate branch name validation
      fireEvent.change(input, { target: { value: 'develop' } })
      fireEvent.submit(input.closest('form')!)
      expect(screen.getByText('A branch named "develop" already exists.')).toBeInTheDocument()
      expect(mockGitBranchCreate).not.toHaveBeenCalled()

      // Valid branch creation
      fireEvent.change(input, { target: { value: 'feature/new-branch' } })
      fireEvent.submit(input.closest('form')!)

      await waitFor(() => {
        expect(mockGitBranchCreate).toHaveBeenCalledWith(MOCK_WORKSPACE, 'feature/new-branch')
      })
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
  })

  // ==========================================================================
  // Group 7: Refresh, Loading & Error States
  // ==========================================================================
  describe('Group 7: Refresh, Loading & Error States', () => {
    it('calls gitStatus and gitBranchList when clicking header refresh button', async () => {
      const onStatusMessage = vi.fn()
      render(<SourceControl rootPath={MOCK_WORKSPACE} onStatusMessage={onStatusMessage} />)

      await waitFor(() => {
        expect(screen.getByLabelText('Refresh Git Status')).toBeInTheDocument()
      })

      const statusCount = mockGitStatus.mock.calls.length
      const branchCount = mockGitBranchList.mock.calls.length

      fireEvent.click(screen.getByLabelText('Refresh Git Status'))

      await waitFor(() => {
        expect(mockGitStatus.mock.calls.length).toBeGreaterThan(statusCount)
        expect(mockGitBranchList.mock.calls.length).toBeGreaterThan(branchCount)
      })
      expect(onStatusMessage).toHaveBeenCalledWith('Refreshing Git status...')
    })

    it('does not re-trigger fetch when refreshTrigger is 0 or unassigned', async () => {
      render(<SourceControl rootPath={MOCK_WORKSPACE} refreshTrigger={0} />)

      await waitFor(() => {
        expect(mockGitStatus).toHaveBeenCalledTimes(1)
      })
      expect(mockGitStatus).toHaveBeenCalledTimes(1)
    })

    it('refreshes status and branches when a positive refreshTrigger value changes', async () => {
      const { rerender } = render(<SourceControl rootPath={MOCK_WORKSPACE} refreshTrigger={0} />)

      await waitFor(() => {
        expect(mockGitStatus).toHaveBeenCalledTimes(1)
      })

      const statusCallsBefore = mockGitStatus.mock.calls.length
      const branchCallsBefore = mockGitBranchList.mock.calls.length

      rerender(<SourceControl rootPath={MOCK_WORKSPACE} refreshTrigger={1} />)

      await waitFor(() => {
        expect(mockGitStatus.mock.calls.length).toBe(statusCallsBefore + 1)
        expect(mockGitBranchList.mock.calls.length).toBe(branchCallsBefore + 1)
      })
    })

    it('does not cause repeated refreshes when keeping the same positive trigger value', async () => {
      const { rerender } = render(<SourceControl rootPath={MOCK_WORKSPACE} refreshTrigger={0} />)

      await waitFor(() => {
        expect(mockGitStatus).toHaveBeenCalledTimes(1)
      })

      // Change trigger to 1
      rerender(<SourceControl rootPath={MOCK_WORKSPACE} refreshTrigger={1} />)

      await waitFor(() => {
        expect(mockGitStatus).toHaveBeenCalledTimes(2)
      })

      // Re-render multiple times with the same positive trigger (e.g. other prop changes)
      rerender(<SourceControl rootPath={MOCK_WORKSPACE} refreshTrigger={1} hasUnsavedChanges={true} />)
      rerender(<SourceControl rootPath={MOCK_WORKSPACE} refreshTrigger={1} hasUnsavedChanges={false} />)

      // Status calls should remain strictly at 2
      expect(mockGitStatus).toHaveBeenCalledTimes(2)
    })

    it('causes another refresh when incrementing the trigger value', async () => {
      const { rerender } = render(<SourceControl rootPath={MOCK_WORKSPACE} refreshTrigger={1} />)

      await waitFor(() => {
        expect(mockGitStatus).toHaveBeenCalledTimes(1)
      })

      rerender(<SourceControl rootPath={MOCK_WORKSPACE} refreshTrigger={2} />)

      await waitFor(() => {
        expect(mockGitStatus).toHaveBeenCalledTimes(2)
      })

      rerender(<SourceControl rootPath={MOCK_WORKSPACE} refreshTrigger={3} />)

      await waitFor(() => {
        expect(mockGitStatus).toHaveBeenCalledTimes(3)
      })
    })

    it('does not trigger a refresh loop when status loading completes with positive trigger', async () => {
      const { rerender } = render(<SourceControl rootPath={MOCK_WORKSPACE} refreshTrigger={0} />)

      await waitFor(() => {
        expect(mockGitStatus).toHaveBeenCalledTimes(1)
      })

      rerender(<SourceControl rootPath={MOCK_WORKSPACE} refreshTrigger={1} />)

      await waitFor(() => {
        expect(mockGitStatus).toHaveBeenCalledTimes(2)
      })

      // Allow microtasks and state updates to settle
      await new Promise((resolve) => setTimeout(resolve, 80))

      // Verify that mockGitStatus has not looped
      expect(mockGitStatus).toHaveBeenCalledTimes(2)
    })

    it('displays missing Git state when git is not installed', async () => {
      mockGitStatus.mockResolvedValueOnce({
        success: false,
        error: 'git: command not found (Git is not installed)'
      })

      render(<SourceControl rootPath={MOCK_WORKSPACE} />)

      await waitFor(() => {
        expect(screen.getByTestId('missing-git-state')).toBeInTheDocument()
      })
      expect(screen.getByText('Git Not Found')).toBeInTheDocument()
      expect(
        screen.getByText(/Git was not found on your system PATH/i)
      ).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /Check Again/i })).toBeInTheDocument()
    })

    it('displays general error state with retry button when Git status check fails', async () => {
      mockGitStatus.mockResolvedValueOnce({
        success: false,
        error: 'fatal: corrupt index file'
      })

      render(<SourceControl rootPath={MOCK_WORKSPACE} />)

      await waitFor(() => {
        expect(screen.getByTestId('error-state')).toBeInTheDocument()
      })
      expect(screen.getByText('Git Error')).toBeInTheDocument()
      expect(screen.getByText(/corrupt index file/i)).toBeInTheDocument()

      const retryBtn = screen.getByRole('button', { name: /Retry/i })
      expect(retryBtn).toBeInTheDocument()

      mockGitStatus.mockResolvedValueOnce(createCleanStatus())
      fireEvent.click(retryBtn)

      await waitFor(() => {
        expect(screen.getByTestId('clean-state')).toBeInTheDocument()
      })
    })

    it('drops stale responses when rootPath changes during an in-flight status request', async () => {
      mockGitBranchList.mockImplementation(async () => ({
        success: true,
        isRepository: true,
        branches: ['main']
      }))

      let resolveFirstCall: (val: any) => void = () => {}
      const firstPromise = new Promise((resolve) => {
        resolveFirstCall = resolve
      })

      mockGitStatus.mockImplementationOnce(() => firstPromise)
      mockGitStatus.mockResolvedValueOnce(createCleanStatus('second-branch'))

      const { rerender } = render(<SourceControl rootPath="/workspace/first" />)

      // Change workspace before first resolves
      rerender(<SourceControl rootPath="/workspace/second" />)

      // Resolve the first call with an older branch
      resolveFirstCall(createCleanStatus('first-branch'))

      await waitFor(() => {
        expect(screen.getByText('second-branch')).toBeInTheDocument()
      })
      expect(screen.queryByText('first-branch')).not.toBeInTheDocument()
    })
  })

  // ==========================================================================
  // Group 8: Cleanup & Subscriptions
  // ==========================================================================
  describe('Group 8: Cleanup & Subscriptions', () => {
    it('removes window keydown event listeners on unmount without error', async () => {
      const removeListenerSpy = vi.spyOn(window, 'removeEventListener')
      const { unmount } = render(<SourceControl rootPath={MOCK_WORKSPACE} />)

      await waitFor(() => {
        expect(screen.getByTestId('clean-state')).toBeInTheDocument()
      })

      unmount()
      expect(removeListenerSpy).toHaveBeenCalledWith('keydown', expect.any(Function))
      removeListenerSpy.mockRestore()
    })

    it('closes branch dropdown on document outside click and removes listener', async () => {
      const removeDocListenerSpy = vi.spyOn(document, 'removeEventListener')
      const { unmount } = render(<SourceControl rootPath={MOCK_WORKSPACE} />)

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Branch: main/i })).toBeInTheDocument()
      })

      fireEvent.click(screen.getByRole('button', { name: /Branch: main/i }))

      await waitFor(() => {
        expect(screen.getByRole('menu', { name: 'Git Branches' })).toBeInTheDocument()
      })

      // Click outside
      fireEvent.mouseDown(document.body)
      expect(screen.queryByRole('menu', { name: 'Git Branches' })).not.toBeInTheDocument()

      unmount()
      expect(removeDocListenerSpy).toHaveBeenCalledWith('mousedown', expect.any(Function))
      removeDocListenerSpy.mockRestore()
    })

    it('unmounts cleanly during in-flight operations without throwing errors', async () => {
      mockGitStatus.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(createCleanStatus()), 200))
      )

      const { unmount } = render(<SourceControl rootPath={MOCK_WORKSPACE} />)
      expect(() => unmount()).not.toThrow()
    })
  })
})
