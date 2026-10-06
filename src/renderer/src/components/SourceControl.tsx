import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import {
  GitBranch,
  RefreshCw,
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  FolderGit2,
  Loader2,
  RotateCcw,
  FileCode,
  Plus,
  Minus,
  X,
  Check,
  GitCompare,
  ChevronDown,
  Search
} from 'lucide-react'
import { GitStatusResult, GitFileStatus } from '../../../shared/types'
import { isValidBranchName, formatGitErrorMessage } from '../../../shared/securityUtils'

interface SourceControlProps {
  rootPath: string | null
  onStatusMessage?: (message: string) => void
  onGitStatusUpdated?: (status: GitStatusResult) => void
  onOpenFileDiff?: (filePath: string, staged: boolean) => void
  activeDiffPath?: string | null
  activeDiffStaged?: boolean
  hasUnsavedChanges?: boolean
  dirtyTabNames?: string[]
  refreshTrigger?: number
}

interface DiscardModalState {
  isOpen: boolean
  filePath: string | null
  fileName: string | null
  isDiscarding: boolean
  error: string | null
}

export const SourceControl: React.FC<SourceControlProps> = ({
  rootPath,
  onStatusMessage,
  onGitStatusUpdated,
  onOpenFileDiff,
  activeDiffPath,
  activeDiffStaged,
  hasUnsavedChanges = false,
  dirtyTabNames = [],
  refreshTrigger = 0
}) => {
  const [isLoading, setIsLoading] = useState<boolean>(false)
  const [statusData, setStatusData] = useState<GitStatusResult | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isMissingGit, setIsMissingGit] = useState<boolean>(false)
  const [busyOperation, setBusyOperation] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [commitMessage, setCommitMessage] = useState<string>('')
  const [validationError, setValidationError] = useState<string | null>(null)
  const [commitSuccess, setCommitSuccess] = useState<{ hash?: string; summary?: string } | null>(null)

  // Branch management state
  const [branchList, setBranchList] = useState<string[]>([])
  const [currentBranch, setCurrentBranch] = useState<string | null>(null)
  const [isBranchMenuOpen, setIsBranchMenuOpen] = useState<boolean>(false)
  const [isLoadingBranches, setIsLoadingBranches] = useState<boolean>(false)
  const [branchSearchFilter, setBranchSearchFilter] = useState<string>('')
  const [isCreateBranchModalOpen, setIsCreateBranchModalOpen] = useState<boolean>(false)
  const [newBranchName, setNewBranchName] = useState<string>('')
  const [branchValidationError, setBranchValidationError] = useState<string | null>(null)
  const [isCreatingBranch, setIsCreatingBranch] = useState<boolean>(false)
  const [switchConfirmModal, setSwitchConfirmModal] = useState<{
    isOpen: boolean
    targetBranch: string | null
  }>({
    isOpen: false,
    targetBranch: null
  })

  const branchBarRef = useRef<HTMLDivElement | null>(null)
  const branchRequestIdRef = useRef<number>(0)
  const branchInputRef = useRef<HTMLInputElement | null>(null)
  const prevRefreshTriggerRef = useRef<number>(refreshTrigger)

  const rootPathRef = useRef<string | null>(rootPath)
  useEffect(() => {
    rootPathRef.current = rootPath
    prevRefreshTriggerRef.current = refreshTrigger
    // Reset commit message, errors, and success state when workspace changes
    setCommitMessage('')
    setValidationError(null)
    setActionError(null)
    setCommitSuccess(null)
    setBranchList([])
    setCurrentBranch(null)
    setIsBranchMenuOpen(false)
    setIsCreateBranchModalOpen(false)
    setNewBranchName('')
    setBranchValidationError(null)
    setBranchSearchFilter('')
    setSwitchConfirmModal({ isOpen: false, targetBranch: null })
  }, [rootPath])

  // Auto-focus branch name input when modal opens
  useEffect(() => {
    if (isCreateBranchModalOpen) {
      const timer = setTimeout(() => {
        branchInputRef.current?.focus()
      }, 50)
      return () => clearTimeout(timer)
    }
  }, [isCreateBranchModalOpen])

  // Dismiss branch menu on outside click
  useEffect(() => {
    if (!isBranchMenuOpen) return
    const handleClickOutside = (e: MouseEvent) => {
      if (branchBarRef.current && !branchBarRef.current.contains(e.target as Node)) {
        setIsBranchMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isBranchMenuOpen])

  // Escape key handler for branch popover and modals
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (isCreateBranchModalOpen && !isCreatingBranch) {
          setIsCreateBranchModalOpen(false)
        } else if (switchConfirmModal.isOpen) {
          setSwitchConfirmModal({ isOpen: false, targetBranch: null })
        } else if (isBranchMenuOpen) {
          setIsBranchMenuOpen(false)
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isCreateBranchModalOpen, isCreatingBranch, switchConfirmModal.isOpen, isBranchMenuOpen])

  const commitSuccessTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  useEffect(() => {
    return () => {
      if (commitSuccessTimeoutRef.current) {
        clearTimeout(commitSuccessTimeoutRef.current)
      }
    }
  }, [])

  const [discardModal, setDiscardModal] = useState<DiscardModalState>({
    isOpen: false,
    filePath: null,
    fileName: null,
    isDiscarding: false,
    error: null
  })

  // Request counter to guard against stale asynchronous responses
  const requestIdRef = useRef<number>(0)

  const fetchBranches = useCallback(async () => {
    if (!rootPath) {
      setBranchList([])
      setCurrentBranch(null)
      return
    }

    const currentReqId = ++branchRequestIdRef.current
    setIsLoadingBranches(true)

    try {
      if (!window?.electronAPI || typeof window.electronAPI.gitBranchList !== 'function') {
        throw new Error('Git branch listing API is not available in this window.')
      }

      const res = await window.electronAPI.gitBranchList(rootPath)

      // Guard: drop stale responses from outdated requests or previous workspaces
      if (currentReqId !== branchRequestIdRef.current || rootPathRef.current !== rootPath) {
        return
      }

      setIsLoadingBranches(false)

      if (res.success) {
        setBranchList(res.branches || [])
        if (res.currentBranch) {
          setCurrentBranch(res.currentBranch)
        }
      }
    } catch {
      if (currentReqId !== branchRequestIdRef.current || rootPathRef.current !== rootPath) {
        return
      }
      setIsLoadingBranches(false)
    }
  }, [rootPath])

  const fetchStatus = useCallback(async () => {
    if (!rootPath) {
      setStatusData(null)
      setErrorMessage(null)
      setIsMissingGit(false)
      setIsLoading(false)
      return
    }

    const currentRequestId = ++requestIdRef.current
    setIsLoading(true)
    setErrorMessage(null)
    setIsMissingGit(false)

    try {
      if (!window?.electronAPI || typeof window.electronAPI.gitStatus !== 'function') {
        throw new Error('Git API is not available in this window.')
      }

      const result = await window.electronAPI.gitStatus(rootPath)

      // Guard: drop stale responses from outdated requests or previous workspaces
      if (currentRequestId !== requestIdRef.current || rootPathRef.current !== rootPath) {
        return
      }

      setIsLoading(false)

      if (!result.success) {
        const err = result.error || 'Failed to check Git status.'
        if (err.toLowerCase().includes('git is not installed') || err.toLowerCase().includes('not found')) {
          setIsMissingGit(true)
        }
        setErrorMessage(formatGitErrorMessage(err, rootPath))
        return
      }

      setStatusData(result)
      if (result.branch) {
        setCurrentBranch(result.branch)
      }
      if (onGitStatusUpdated) {
        onGitStatusUpdated(result)
      }
      if (result.isRepository) {
        fetchBranches()
      }
    } catch (err: unknown) {
      if (currentRequestId !== requestIdRef.current || rootPathRef.current !== rootPath) {
        return
      }
      setIsLoading(false)
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.toLowerCase().includes('git is not installed') || msg.toLowerCase().includes('enoent')) {
        setIsMissingGit(true)
      }
      setErrorMessage(formatGitErrorMessage(msg, rootPath))
    }
  }, [rootPath, onGitStatusUpdated, fetchBranches])

  // Automatically fetch status when workspace rootPath changes
  useEffect(() => {
    fetchStatus()
  }, [fetchStatus])

  const handleRefresh = useCallback(async () => {
    if (isLoading || Boolean(busyOperation) || !rootPath) return
    if (onStatusMessage) {
      onStatusMessage('Refreshing Git status...')
    }
    await Promise.all([fetchStatus(), fetchBranches()])
  }, [isLoading, busyOperation, rootPath, onStatusMessage, fetchStatus, fetchBranches])

  // Synchronize when external refresh trigger fires
  useEffect(() => {
    const prevTrigger = prevRefreshTriggerRef.current
    prevRefreshTriggerRef.current = refreshTrigger

    if (
      typeof refreshTrigger === 'number' &&
      refreshTrigger > 0 &&
      refreshTrigger !== prevTrigger &&
      rootPath &&
      !busyOperation
    ) {
      fetchStatus()
      fetchBranches()
    }
  }, [refreshTrigger, rootPath, busyOperation, fetchStatus, fetchBranches])

  // File-level Stage action
  const handleStageFile = async (filePath: string) => {
    if (!rootPath || busyOperation) return
    setBusyOperation(`stage:${filePath}`)
    setActionError(null)

    try {
      if (!window?.electronAPI || typeof window.electronAPI.gitStageFile !== 'function') {
        throw new Error('Git staging API is not available in this window. Please restart the application.')
      }
      const res = await window.electronAPI.gitStageFile(rootPath, filePath)
      if (!res.success) {
        const err = formatGitErrorMessage(res.error || `Failed to stage ${filePath}`, rootPath)
        setActionError(err)
        if (onStatusMessage) onStatusMessage(err)
      } else {
        if (onStatusMessage) onStatusMessage(`Staged ${filePath}`)
        await fetchStatus()
      }
    } catch (err: unknown) {
      const msg = formatGitErrorMessage(err, rootPath)
      setActionError(msg)
      if (onStatusMessage) onStatusMessage(`Failed to stage ${filePath}: ${msg}`)
    } finally {
      setBusyOperation(null)
    }
  }

  // File-level Unstage action
  const handleUnstageFile = async (filePath: string) => {
    if (!rootPath || busyOperation) return
    setBusyOperation(`unstage:${filePath}`)
    setActionError(null)

    try {
      if (!window?.electronAPI || typeof window.electronAPI.gitUnstageFile !== 'function') {
        throw new Error('Git unstaging API is not available in this window. Please restart the application.')
      }
      const res = await window.electronAPI.gitUnstageFile(rootPath, filePath)
      if (!res.success) {
        const err = formatGitErrorMessage(res.error || `Failed to unstage ${filePath}`, rootPath)
        setActionError(err)
        if (onStatusMessage) onStatusMessage(err)
      } else {
        if (onStatusMessage) onStatusMessage(`Unstaged ${filePath}`)
        await fetchStatus()
      }
    } catch (err: unknown) {
      const msg = formatGitErrorMessage(err, rootPath)
      setActionError(msg)
      if (onStatusMessage) onStatusMessage(`Failed to unstage ${filePath}: ${msg}`)
    } finally {
      setBusyOperation(null)
    }
  }

  // Stage All action
  const handleStageAll = async () => {
    if (!rootPath || busyOperation) return
    setBusyOperation('stage-all')
    setActionError(null)

    try {
      if (!window?.electronAPI || typeof window.electronAPI.gitStageAll !== 'function') {
        throw new Error('Git stage all API is not available in this window. Please restart the application.')
      }
      const res = await window.electronAPI.gitStageAll(rootPath)
      if (!res.success) {
        const err = formatGitErrorMessage(res.error || 'Failed to stage all changes.', rootPath)
        setActionError(err)
        if (onStatusMessage) onStatusMessage(err)
      } else {
        if (onStatusMessage) onStatusMessage('Staged all changes.')
        await fetchStatus()
      }
    } catch (err: unknown) {
      const msg = formatGitErrorMessage(err, rootPath)
      setActionError(msg)
      if (onStatusMessage) onStatusMessage(`Failed to stage all changes: ${msg}`)
    } finally {
      setBusyOperation(null)
    }
  }

  // Unstage All action
  const handleUnstageAll = async () => {
    if (!rootPath || busyOperation) return
    setBusyOperation('unstage-all')
    setActionError(null)

    try {
      if (!window?.electronAPI || typeof window.electronAPI.gitUnstageAll !== 'function') {
        throw new Error('Git unstage all API is not available in this window. Please restart the application.')
      }
      const res = await window.electronAPI.gitUnstageAll(rootPath)
      if (!res.success) {
        const err = formatGitErrorMessage(res.error || 'Failed to unstage all changes.', rootPath)
        setActionError(err)
        if (onStatusMessage) onStatusMessage(err)
      } else {
        if (onStatusMessage) onStatusMessage('Unstaged all changes.')
        await fetchStatus()
      }
    } catch (err: unknown) {
      const msg = formatGitErrorMessage(err, rootPath)
      setActionError(msg)
      if (onStatusMessage) onStatusMessage(`Failed to unstage all changes: ${msg}`)
    } finally {
      setBusyOperation(null)
    }
  }

  // Discard Changes Modal triggers
  const handleOpenDiscardModal = (filePath: string) => {
    if (busyOperation) return
    const fileName = filePath.split(/[\\/]/).pop() || filePath
    setDiscardModal({
      isOpen: true,
      filePath,
      fileName,
      isDiscarding: false,
      error: null
    })
  }

  const handleCancelDiscard = () => {
    if (discardModal.isDiscarding) return
    setDiscardModal({
      isOpen: false,
      filePath: null,
      fileName: null,
      isDiscarding: false,
      error: null
    })
  }

  const handleConfirmDiscard = async () => {
    if (!rootPath || !discardModal.filePath || discardModal.isDiscarding) return
    setDiscardModal((prev) => ({ ...prev, isDiscarding: true, error: null }))
    const targetFile = discardModal.filePath

    try {
      if (!window?.electronAPI || typeof window.electronAPI.gitDiscardFile !== 'function') {
        throw new Error('Git discard API is not available in this window. Please restart the application.')
      }

      const res = await window.electronAPI.gitDiscardFile(rootPath, targetFile)
      if (!res.success) {
        setDiscardModal((prev) => ({
          ...prev,
          isDiscarding: false,
          error: formatGitErrorMessage(res.error || `Failed to discard changes for ${targetFile}`, rootPath)
        }))
      } else {
        setDiscardModal({
          isOpen: false,
          filePath: null,
          fileName: null,
          isDiscarding: false,
          error: null
        })
        if (onStatusMessage) onStatusMessage(`Discarded changes in ${targetFile}`)
        await fetchStatus()
      }
    } catch (err: unknown) {
      const msg = formatGitErrorMessage(err, rootPath)
      setDiscardModal((prev) => ({
        ...prev,
        isDiscarding: false,
        error: msg
      }))
    }
  }

  // Modal escape key listener
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && discardModal.isOpen && !discardModal.isDiscarding) {
        handleCancelDiscard()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [discardModal.isOpen, discardModal.isDiscarding])

  // Resolve staged and unstaged file lists cleanly
  const stagedFiles: GitFileStatus[] = useMemo(() => {
    if (statusData?.files && statusData.files.length > 0) {
      return statusData.files.filter((f) => f.staged)
    }
    if (statusData?.staged && statusData.staged.length > 0) {
      return statusData.staged.map((s) => ({
        path: s.slice(2).trim(),
        status: s[0] === 'A' ? 'added' : s[0] === 'D' ? 'deleted' : 'modified',
        staged: true
      }))
    }
    return []
  }, [statusData])

  const unstagedFiles: GitFileStatus[] = useMemo(() => {
    if (statusData?.files && statusData.files.length > 0) {
      return statusData.files.filter((f) => !f.staged)
    }
    const result: GitFileStatus[] = []
    if (statusData?.unstaged) {
      for (const u of statusData.unstaged) {
        result.push({
          path: u.slice(2).trim(),
          status: u[0] === 'D' ? 'deleted' : 'modified',
          staged: false
        })
      }
    }
    if (statusData?.untracked) {
      for (const ut of statusData.untracked) {
        result.push({
          path: ut.trim(),
          status: 'untracked',
          staged: false
        })
      }
    }
    return result
  }, [statusData])

  // Change counts
  const stagedCount = statusData?.staged?.length || stagedFiles.length
  const unstagedCount = statusData?.unstaged?.length || 0
  const untrackedCount = statusData?.untracked?.length || 0
  const conflictedCount = statusData?.conflicted?.length || 0
  const totalChanges = stagedFiles.length + unstagedFiles.length

  // Helper for status badge letter and color
  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'added':
        return <span className="source-control-badge added">A</span>
      case 'deleted':
        return <span className="source-control-badge deleted">D</span>
      case 'modified':
        return <span className="source-control-badge modified">M</span>
      case 'untracked':
        return <span className="source-control-badge untracked">U</span>
      case 'conflicted':
        return <span className="source-control-badge conflicted">C</span>
      default:
        return <span className="source-control-badge modified">M</span>
    }
  }

  // Commit capability flags
  const hasStagedChanges = stagedFiles.length > 0
  const hasCommitMessage = commitMessage.trim().length > 0
  const isCommitting = busyOperation === 'commit'
  const canCommit = hasStagedChanges && hasCommitMessage && !busyOperation

  // Handle Git Commit
  const handleCommit = async () => {
    if (!rootPath || busyOperation) return

    const trimmed = commitMessage.trim()
    if (!trimmed) {
      setValidationError('Commit message cannot be empty.')
      return
    }

    if (stagedFiles.length === 0) {
      setValidationError('No staged changes to commit. Please stage changes first.')
      return
    }

    const currentRoot = rootPath
    setBusyOperation('commit')
    setActionError(null)
    setValidationError(null)
    setCommitSuccess(null)

    try {
      if (!window?.electronAPI || typeof window.electronAPI.gitCommit !== 'function') {
        throw new Error('Git commit API is not available in this window. Please restart the application.')
      }

      const res = await window.electronAPI.gitCommit(currentRoot, trimmed)

      // Guard: drop response if workspace changed while committing
      if (rootPathRef.current !== currentRoot) {
        return
      }

      if (!res.success) {
        const rawErr = res.error || 'Commit failed.'
        const friendlyErr = formatGitErrorMessage(rawErr, currentRoot)
        setActionError(friendlyErr)
        if (onStatusMessage) {
          onStatusMessage(friendlyErr.split('\n')[0])
        }
        return
      }

      // Successful commit: clear message, set success feedback, and refresh status
      setCommitMessage('')
      setValidationError(null)
      const successData = { hash: res.commitHash, summary: res.summary }
      setCommitSuccess(successData)

      if (commitSuccessTimeoutRef.current) {
        clearTimeout(commitSuccessTimeoutRef.current)
      }
      commitSuccessTimeoutRef.current = setTimeout(() => {
        setCommitSuccess(null)
      }, 4000)

      const successSummary = res.commitHash
        ? `Committed ${res.commitHash}${res.summary ? `: ${res.summary}` : ''}`
        : 'Changes committed successfully.'
      if (onStatusMessage) {
        onStatusMessage(successSummary)
      }

      await Promise.all([fetchStatus(), fetchBranches()])
    } catch (err: unknown) {
      if (rootPathRef.current !== currentRoot) return
      const msg = formatGitErrorMessage(err, currentRoot)
      setActionError(msg)
      if (onStatusMessage) {
        onStatusMessage(`Commit failed: ${msg}`)
      }
    } finally {
      if (rootPathRef.current === currentRoot) {
        setBusyOperation(null)
      }
    }
  }

  // Filtered branches for dropdown search
  const filteredBranches = useMemo(() => {
    if (!branchSearchFilter.trim()) {
      return branchList
    }
    const query = branchSearchFilter.trim().toLowerCase()
    return branchList.filter((b) => b.toLowerCase().includes(query))
  }, [branchList, branchSearchFilter])

  const handleToggleBranchMenu = () => {
    if (busyOperation) return
    const next = !isBranchMenuOpen
    setIsBranchMenuOpen(next)
    if (next) {
      setBranchSearchFilter('')
      fetchBranches()
    }
  }

  const handleOpenCreateBranchModal = () => {
    if (busyOperation) return
    setIsBranchMenuOpen(false)
    setNewBranchName('')
    setBranchValidationError(null)
    setIsCreateBranchModalOpen(true)
  }

  const handleCloseCreateBranchModal = () => {
    if (isCreatingBranch) return
    setIsCreateBranchModalOpen(false)
    setNewBranchName('')
    setBranchValidationError(null)
  }

  const handleCreateBranchSubmit = async (e?: React.FormEvent) => {
    if (e) {
      e.preventDefault()
    }
    if (!rootPath || isCreatingBranch || busyOperation) return

    const trimmed = newBranchName.trim()
    if (!trimmed) {
      setBranchValidationError('Branch name cannot be empty.')
      return
    }

    const validation = isValidBranchName(trimmed)
    if (!validation.valid) {
      setBranchValidationError(validation.error || 'Invalid branch name.')
      return
    }

    const isDuplicate = branchList.some(
      (b) => b.toLowerCase() === trimmed.toLowerCase()
    )
    if (isDuplicate) {
      setBranchValidationError(`A branch named "${trimmed}" already exists.`)
      return
    }

    const currentRoot = rootPath
    setIsCreatingBranch(true)
    setBranchValidationError(null)
    setBusyOperation(`create-branch:${trimmed}`)

    try {
      if (!window?.electronAPI || typeof window.electronAPI.gitBranchCreate !== 'function') {
        throw new Error('Git branch creation API is not available in this window.')
      }

      if (onStatusMessage) {
        onStatusMessage(`Creating and switching to branch '${trimmed}'...`)
      }

      const res = await window.electronAPI.gitBranchCreate(rootPath, trimmed)

      if (rootPathRef.current !== currentRoot) {
        return
      }

      if (!res.success) {
        const err = formatGitErrorMessage(res.error || `Failed to create branch '${trimmed}'.`, currentRoot)
        setBranchValidationError(err)
        if (onStatusMessage) {
          onStatusMessage(err)
        }
        return
      }

      // Success
      setIsCreateBranchModalOpen(false)
      setNewBranchName('')
      setBranchValidationError(null)
      setCurrentBranch(trimmed)

      if (onStatusMessage) {
        onStatusMessage(`Created and switched to branch '${trimmed}'.`)
      }

      await Promise.all([fetchStatus(), fetchBranches()])
    } catch (err: unknown) {
      if (rootPathRef.current !== currentRoot) return
      const msg = formatGitErrorMessage(err, currentRoot)
      setBranchValidationError(msg)
      if (onStatusMessage) {
        onStatusMessage(`Branch creation error: ${msg}`)
      }
    } finally {
      if (rootPathRef.current === currentRoot) {
        setIsCreatingBranch(false)
        setBusyOperation(null)
      }
    }
  }

  const handleBranchSelect = (targetBranch: string) => {
    if (busyOperation) return
    const active = currentBranch || statusData?.branch
    if (targetBranch === active) {
      setIsBranchMenuOpen(false)
      return
    }

    if (hasUnsavedChanges) {
      setIsBranchMenuOpen(false)
      setSwitchConfirmModal({
        isOpen: true,
        targetBranch
      })
      return
    }

    setIsBranchMenuOpen(false)
    executeCheckoutBranch(targetBranch)
  }

  const handleCancelSwitchConfirm = () => {
    if (busyOperation?.startsWith('checkout:')) return
    setSwitchConfirmModal({ isOpen: false, targetBranch: null })
  }

  const handleConfirmSwitchBranch = () => {
    if (!switchConfirmModal.targetBranch || busyOperation) return
    executeCheckoutBranch(switchConfirmModal.targetBranch)
  }

  const executeCheckoutBranch = async (targetBranch: string) => {
    if (!rootPath || busyOperation) return
    const currentRoot = rootPath
    setBusyOperation(`checkout:${targetBranch}`)
    setActionError(null)

    try {
      if (!window?.electronAPI || typeof window.electronAPI.gitBranchCheckout !== 'function') {
        throw new Error('Git branch checkout API is not available in this window.')
      }

      if (onStatusMessage) {
        onStatusMessage(`Switching to branch '${targetBranch}'...`)
      }

      const res = await window.electronAPI.gitBranchCheckout(rootPath, targetBranch)

      if (rootPathRef.current !== currentRoot) {
        return
      }

      if (!res.success) {
        const err = formatGitErrorMessage(res.error || `Failed to switch to branch '${targetBranch}'.`, currentRoot)
        setActionError(err)
        setSwitchConfirmModal({ isOpen: false, targetBranch: null })
        if (onStatusMessage) {
          onStatusMessage(err)
        }
        return
      }

      // Success
      setCurrentBranch(targetBranch)
      setSwitchConfirmModal({ isOpen: false, targetBranch: null })
      if (onStatusMessage) {
        onStatusMessage(`Switched to branch '${targetBranch}'.`)
      }

      await Promise.all([fetchStatus(), fetchBranches()])
    } catch (err: unknown) {
      if (rootPathRef.current !== currentRoot) return
      const msg = formatGitErrorMessage(err, currentRoot)
      setActionError(msg)
      setSwitchConfirmModal({ isOpen: false, targetBranch: null })
      if (onStatusMessage) {
        onStatusMessage(`Failed to switch to branch '${targetBranch}': ${msg}`)
      }
    } finally {
      if (rootPathRef.current === currentRoot) {
        setBusyOperation(null)
      }
    }
  }

  return (
    <aside className="sidebar source-control-panel" aria-label="Source Control">
      {/* Panel Header */}
      <div className="sidebar-header">
        <div className="sidebar-header-title">
          <GitBranch size={13} className="sidebar-header-icon" />
          <span>SOURCE CONTROL</span>
        </div>
        <div className="sidebar-header-actions">
          <button
            type="button"
            className={`sidebar-icon-btn ${isLoading ? 'spin' : ''}`}
            onClick={handleRefresh}
            title={isLoading ? 'Refreshing Git status...' : 'Refresh Git Status'}
            disabled={isLoading || Boolean(busyOperation) || !rootPath}
            aria-label="Refresh Git Status"
          >
            <RefreshCw size={13} />
          </button>
        </div>
      </div>

      {/* Branch Bar & Selector */}
      {statusData?.isRepository && (statusData.branch || currentBranch) && (
        <div className="source-control-branch-bar" ref={branchBarRef}>
          <div className="source-control-branch-bar-main">
            <span className="source-control-branch-label">Branch:</span>
            <button
              type="button"
              className={`source-control-branch-selector-btn source-control-branch-pill ${isBranchMenuOpen ? 'active' : ''}`}
              onClick={handleToggleBranchMenu}
              disabled={Boolean(busyOperation)}
              title="Click to switch or create branches"
              aria-expanded={isBranchMenuOpen}
              aria-haspopup="true"
              aria-label={`Branch: ${currentBranch || statusData.branch}. Click to switch or create branches.`}
            >
              <GitBranch size={11} color="#60a5fa" className="branch-btn-icon" />
              <span className="source-control-branch-name">{currentBranch || statusData.branch}</span>
              <ChevronDown size={11} className={`branch-chevron ${isBranchMenuOpen ? 'rotated' : ''}`} />
            </button>
          </div>

          <button
            type="button"
            className="source-control-new-branch-btn"
            onClick={handleOpenCreateBranchModal}
            disabled={Boolean(busyOperation)}
            title="Create New Branch"
            aria-label="Create New Branch"
          >
            <Plus size={12} />
          </button>

          {/* Branch Dropdown Popover */}
          {isBranchMenuOpen && (
            <div className="source-control-branch-dropdown" role="menu" aria-label="Git Branches">
              <div className="branch-dropdown-header">
                <div className="branch-search-box">
                  <Search size={12} className="branch-search-icon" />
                  <input
                    type="text"
                    className="branch-search-input"
                    placeholder="Filter branches..."
                    value={branchSearchFilter}
                    onChange={(e) => setBranchSearchFilter(e.target.value)}
                    autoFocus
                    aria-label="Filter branches"
                  />
                  {branchSearchFilter && (
                    <button
                      type="button"
                      className="branch-search-clear"
                      onClick={() => setBranchSearchFilter('')}
                      aria-label="Clear branch search"
                    >
                      <X size={10} />
                    </button>
                  )}
                </div>
                <button
                  type="button"
                  className="branch-dropdown-create-btn"
                  onClick={handleOpenCreateBranchModal}
                  title="Create new branch"
                  aria-label="Create new branch"
                >
                  <Plus size={11} />
                  <span>New Branch</span>
                </button>
              </div>

              <div className="branch-dropdown-list" role="group">
                {isLoadingBranches ? (
                  <div className="branch-dropdown-loading">
                    <Loader2 size={13} className="spin" />
                    <span>Loading branches...</span>
                  </div>
                ) : filteredBranches.length === 0 ? (
                  <div className="branch-dropdown-empty">
                    <span>
                      {branchSearchFilter ? `No branch matches "${branchSearchFilter}"` : 'No branches found'}
                    </span>
                  </div>
                ) : (
                  filteredBranches.map((branchName) => {
                    const isCurrent = branchName === (currentBranch || statusData.branch)
                    const isSwitchingThis = busyOperation === `checkout:${branchName}`
                    return (
                      <button
                        key={branchName}
                        type="button"
                        className={`branch-item-btn ${isCurrent ? 'current' : ''}`}
                        onClick={() => handleBranchSelect(branchName)}
                        disabled={Boolean(busyOperation) || isCurrent}
                        title={isCurrent ? `${branchName} (current branch)` : `Switch to ${branchName}`}
                        role="menuitem"
                        aria-current={isCurrent ? 'true' : undefined}
                      >
                        <div className="branch-item-left">
                          <GitBranch
                            size={12}
                            className={isCurrent ? 'branch-item-icon-current' : 'branch-item-icon'}
                          />
                          <span className="branch-item-name">{branchName}</span>
                        </div>
                        {isCurrent && (
                          <span className="branch-item-badge">
                            <Check size={11} />
                            <span>current</span>
                          </span>
                        )}
                        {isSwitchingThis && (
                          <Loader2 size={11} className="spin" />
                        )}
                      </button>
                    )
                  })
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Action Error Banner */}
      {actionError && (
        <div className="source-control-action-error" role="alert">
          <div className="source-control-action-error-content">
            <AlertCircle size={13} color="#f87171" style={{ flexShrink: 0 }} />
            <span className="source-control-action-error-text" title={actionError}>
              {actionError}
            </span>
          </div>
          <div className="source-control-action-error-actions">
            <button
              type="button"
              className="source-control-error-retry-btn"
              onClick={handleRefresh}
              title="Refresh / Retry Git Status"
              aria-label="Refresh / Retry Git Status"
              disabled={isLoading || Boolean(busyOperation)}
            >
              <RotateCcw size={11} />
            </button>
            <button
              type="button"
              className="source-control-error-close"
              onClick={() => setActionError(null)}
              title="Dismiss error"
              aria-label="Dismiss error"
            >
              <X size={12} />
            </button>
          </div>
        </div>
      )}

      {/* Commit Success Banner */}
      {commitSuccess && (
        <div className="source-control-commit-success" role="status">
          <div className="source-control-commit-success-content">
            <CheckCircle2 size={13} color="#34d399" style={{ flexShrink: 0 }} />
            <span className="source-control-commit-success-text" title={commitSuccess.summary || commitSuccess.hash}>
              {commitSuccess.hash
                ? `Commit ${commitSuccess.hash} created${commitSuccess.summary ? ` (${commitSuccess.summary})` : ''}`
                : 'Changes committed successfully.'}
            </span>
          </div>
          <button
            type="button"
            className="source-control-error-close"
            onClick={() => setCommitSuccess(null)}
            title="Dismiss notification"
            aria-label="Dismiss notification"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* Content Area */}
      <div className="sidebar-content">
        {/* 1. No Workspace Open */}
        {!rootPath ? (
          <div className="source-control-state" data-testid="no-workspace-state">
            <div className="source-control-state-icon">
              <FolderGit2 size={24} color="#64748b" />
            </div>
            <div className="source-control-state-title">No Workspace Open</div>
            <div className="source-control-state-desc">
              Open a folder or project to view source control and track changes.
            </div>
          </div>
        ) : isLoading && !statusData ? (
          /* 2. Initial Loading State */
          <div className="source-control-state loading" data-testid="loading-state">
            <div className="source-control-state-icon spin">
              <Loader2 size={24} color="#38bdf8" />
            </div>
            <div className="source-control-state-title">Checking Git Status</div>
            <div className="source-control-state-desc">Scanning repository for changes...</div>
          </div>
        ) : isMissingGit ? (
          /* 3. Missing Git Installation */
          <div className="source-control-state error" data-testid="missing-git-state">
            <div className="source-control-state-icon">
              <AlertTriangle size={24} color="#f59e0b" />
            </div>
            <div className="source-control-state-title">Git Not Found</div>
            <div className="source-control-state-desc">
              Git was not found on your system PATH. Please install Git to enable source control
              features.
            </div>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={handleRefresh}
              disabled={isLoading}
            >
              <RotateCcw size={12} />
              <span>Check Again</span>
            </button>
          </div>
        ) : errorMessage ? (
          /* 4. General Error State */
          <div className="source-control-state error" data-testid="error-state">
            <div className="source-control-state-icon">
              <AlertCircle size={24} color="#ef4444" />
            </div>
            <div className="source-control-state-title">Git Error</div>
            <div className="source-control-state-desc">{errorMessage}</div>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={handleRefresh}
              disabled={isLoading}
            >
              <RotateCcw size={12} />
              <span>Retry</span>
            </button>
          </div>
        ) : statusData && !statusData.isRepository ? (
          /* 5. Non-Git Repository */
          <div className="source-control-state" data-testid="non-repo-state">
            <div className="source-control-state-icon">
              <FolderGit2 size={24} color="#64748b" />
            </div>
            <div className="source-control-state-title">No Git Repository</div>
            <div className="source-control-state-desc">
              The currently opened workspace is not a Git repository.
            </div>
          </div>
        ) : statusData ? (
          <div className="source-control-repo-wrap">
            {/* Commit Message & Action Section */}
            <div className="source-control-commit-section" data-testid="commit-section">
              <div className="source-control-commit-input-wrap">
                <textarea
                  className="source-control-commit-input"
                  data-testid="commit-message-input"
                  placeholder="Message (required, Ctrl+Enter to commit)"
                  value={commitMessage}
                  onChange={(e) => {
                    setCommitMessage(e.target.value)
                    if (validationError) setValidationError(null)
                  }}
                  onKeyDown={(e) => {
                    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                      e.preventDefault()
                      if (canCommit) {
                        handleCommit()
                      } else if (!commitMessage.trim()) {
                        setValidationError('Commit message cannot be empty.')
                      } else if (stagedFiles.length === 0) {
                        setValidationError('No staged changes to commit. Please stage changes first.')
                      }
                    }
                  }}
                  disabled={isCommitting || busyOperation !== null}
                  rows={3}
                  aria-label="Commit message (required)"
                />
              </div>

              {/* Inline Validation / Hint */}
              {validationError ? (
                <div className="source-control-commit-hint error" role="alert">
                  <AlertCircle size={11} color="#f87171" style={{ flexShrink: 0 }} />
                  <span>{validationError}</span>
                </div>
              ) : !hasStagedChanges && hasCommitMessage ? (
                <div className="source-control-commit-hint warning">
                  <span>No staged changes to commit. Stage changes first.</span>
                </div>
              ) : null}

              {/* Commit Button */}
              <button
                type="button"
                className="btn btn-primary source-control-commit-btn"
                data-testid="commit-button"
                onClick={handleCommit}
                disabled={!canCommit || isCommitting || busyOperation !== null}
                title={
                  isCommitting
                    ? 'Committing changes...'
                    : !hasStagedChanges
                    ? 'No staged changes to commit. Please stage changes first.'
                    : !hasCommitMessage
                    ? 'Commit message is required.'
                    : 'Commit staged changes (Ctrl+Enter)'
                }
                aria-label="Commit staged changes"
              >
                {isCommitting ? (
                  <>
                    <Loader2 size={13} className="spin" />
                    <span>Committing...</span>
                  </>
                ) : (
                  <>
                    <Check size={13} />
                    <span>Commit</span>
                  </>
                )}
              </button>
            </div>

            {/* Changes or Clean State */}
            {statusData.clean || totalChanges === 0 ? (
              /* 6. Clean Working Tree / No Changes */
              <div className="source-control-state clean" data-testid="clean-state">
                <div className="source-control-state-icon">
                  <CheckCircle2 size={24} color="#10b981" />
                </div>
                <div className="source-control-state-title">Working Tree Clean</div>
                <div className="source-control-state-desc">
                  No uncommitted changes detected in this repository.
                </div>
              </div>
            ) : (
              /* 7. Changes View with Staging & Discard Controls */
              <div className="source-control-changes-wrap" data-testid="changes-state">
            {/* Quick Stat Summary Cards */}
            <div className="source-control-summary-grid">
              <div className="source-control-summary-pill staged" title={`${stagedCount} staged file(s)`}>
                <span className="summary-label">Staged</span>
                <span className="summary-count">{stagedCount}</span>
              </div>
              <div className="source-control-summary-pill unstaged" title={`${unstagedCount} unstaged file(s)`}>
                <span className="summary-label">Modified</span>
                <span className="summary-count">{unstagedCount}</span>
              </div>
              <div className="source-control-summary-pill untracked" title={`${untrackedCount} untracked file(s)`}>
                <span className="summary-label">Untracked</span>
                <span className="summary-count">{untrackedCount}</span>
              </div>
              {conflictedCount > 0 && (
                <div className="source-control-summary-pill conflicted" title={`${conflictedCount} conflict(s)`}>
                  <span className="summary-label">Conflicts</span>
                  <span className="summary-count">{conflictedCount}</span>
                </div>
              )}
            </div>

            {/* STAGED CHANGES Section */}
            {stagedFiles.length > 0 && (
              <div className="source-control-group" data-testid="staged-section">
                <div className="source-control-section-header">
                  <span className="source-control-section-title">
                    STAGED CHANGES ({stagedFiles.length})
                  </span>
                  <div className="source-control-section-actions">
                    <button
                      type="button"
                      className="source-control-section-btn"
                      onClick={handleUnstageAll}
                      title="Unstage All Changes"
                      aria-label="Unstage All Changes"
                      disabled={busyOperation !== null}
                    >
                      {busyOperation === 'unstage-all' ? (
                        <Loader2 size={12} className="spin" />
                      ) : (
                        <Minus size={12} />
                      )}
                    </button>
                  </div>
                </div>

                <div className="source-control-file-list">
                  {stagedFiles.map((file, idx) => {
                    const isDiffSelected = activeDiffPath === file.path && activeDiffStaged === true
                    return (
                      <div
                        key={`staged-${file.path}-${idx}`}
                        className={`source-control-file-item ${isDiffSelected ? 'selected' : ''}`}
                        tabIndex={0}
                        onClick={() => onOpenFileDiff && onOpenFileDiff(file.path, true)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            onOpenFileDiff && onOpenFileDiff(file.path, true)
                          }
                        }}
                        title={`Click to view diff for ${file.path} (Index)`}
                        data-testid={`staged-file-${file.path}`}
                      >
                        <span className="source-control-file-icon">
                          <FileCode size={13} color="#94a3b8" />
                        </span>
                        <span className="source-control-file-name" title={file.path}>
                          {file.path.split(/[\\/]/).pop()}
                        </span>
                        <span className="source-control-file-path" title={file.path}>
                          {file.path.includes('/') || file.path.includes('\\')
                            ? file.path.substring(0, Math.max(file.path.lastIndexOf('/'), file.path.lastIndexOf('\\')))
                            : ''}
                        </span>
                        <span className="source-control-file-badge-wrap">
                          <span className="staged-tag" title="Staged in Index">INDEX</span>
                          {getStatusBadge(file.status)}
                        </span>
                        <div className="source-control-file-actions" onClick={(e) => e.stopPropagation()}>
                          <button
                            type="button"
                            className="source-control-action-btn diff-btn"
                            onClick={() => onOpenFileDiff && onOpenFileDiff(file.path, true)}
                            title="Open Diff"
                            aria-label={`Open diff for ${file.path}`}
                          >
                            <GitCompare size={11} />
                          </button>
                          <button
                            type="button"
                            className="source-control-action-btn unstage"
                            onClick={() => handleUnstageFile(file.path)}
                            title="Unstage Changes"
                            aria-label={`Unstage ${file.path}`}
                            disabled={busyOperation !== null}
                          >
                            {busyOperation === `unstage:${file.path}` ? (
                              <Loader2 size={12} className="spin" />
                            ) : (
                              <Minus size={12} />
                            )}
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* CHANGES (Unstaged) Section */}
            {unstagedFiles.length > 0 && (
              <div className="source-control-group" data-testid="unstaged-section">
                <div className="source-control-section-header">
                  <span className="source-control-section-title">
                    CHANGES ({unstagedFiles.length})
                  </span>
                  <div className="source-control-section-actions">
                    <button
                      type="button"
                      className="source-control-section-btn"
                      onClick={handleStageAll}
                      title="Stage All Changes"
                      aria-label="Stage All Changes"
                      disabled={busyOperation !== null}
                    >
                      {busyOperation === 'stage-all' ? (
                        <Loader2 size={12} className="spin" />
                      ) : (
                        <Plus size={12} />
                      )}
                    </button>
                  </div>
                </div>

                <div className="source-control-file-list">
                  {unstagedFiles.map((file, idx) => {
                    const isDiffSelected = activeDiffPath === file.path && activeDiffStaged === false
                    return (
                      <div
                        key={`unstaged-${file.path}-${idx}`}
                        className={`source-control-file-item ${isDiffSelected ? 'selected' : ''}`}
                        tabIndex={0}
                        onClick={() => onOpenFileDiff && onOpenFileDiff(file.path, false)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            onOpenFileDiff && onOpenFileDiff(file.path, false)
                          }
                        }}
                        title={`Click to view diff for ${file.path} (Working Tree)`}
                        data-testid={`unstaged-file-${file.path}`}
                      >
                        <span className="source-control-file-icon">
                          <FileCode size={13} color="#94a3b8" />
                        </span>
                        <span className="source-control-file-name" title={file.path}>
                          {file.path.split(/[\\/]/).pop()}
                        </span>
                        <span className="source-control-file-path" title={file.path}>
                          {file.path.includes('/') || file.path.includes('\\')
                            ? file.path.substring(0, Math.max(file.path.lastIndexOf('/'), file.path.lastIndexOf('\\')))
                            : ''}
                        </span>
                        <span className="source-control-file-badge-wrap">
                          {getStatusBadge(file.status)}
                        </span>
                        <div className="source-control-file-actions" onClick={(e) => e.stopPropagation()}>
                          <button
                            type="button"
                            className="source-control-action-btn diff-btn"
                            onClick={() => onOpenFileDiff && onOpenFileDiff(file.path, false)}
                            title="View Diff"
                            aria-label={`View diff for ${file.path}`}
                          >
                            <GitCompare size={11} />
                          </button>
                          {/* Discard button */}
                          <button
                            type="button"
                            className="source-control-action-btn discard"
                            onClick={() => handleOpenDiscardModal(file.path)}
                            title="Discard Changes..."
                            aria-label={`Discard changes in ${file.path}`}
                            disabled={busyOperation !== null}
                          >
                            <RotateCcw size={11} />
                          </button>
                          {/* Stage button */}
                          <button
                            type="button"
                            className="source-control-action-btn stage"
                            onClick={() => handleStageFile(file.path)}
                            title="Stage Changes"
                            aria-label={`Stage ${file.path}`}
                            disabled={busyOperation !== null}
                          >
                            {busyOperation === `stage:${file.path}` ? (
                              <Loader2 size={12} className="spin" />
                            ) : (
                              <Plus size={12} />
                            )}
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    ) : null}
      </div>

      {/* Discard Confirmation Modal */}
      {discardModal.isOpen && (
        <div className="explorer-modal-backdrop" onClick={handleCancelDiscard}>
          <div
            className="explorer-modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            style={{ maxWidth: '440px' }}
          >
            <div className="explorer-modal-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <AlertTriangle size={15} color="#f59e0b" />
                <span>Discard Changes</span>
              </div>
              <button
                type="button"
                className="explorer-modal-close-btn"
                onClick={handleCancelDiscard}
                disabled={discardModal.isDiscarding}
                title="Cancel"
                aria-label="Cancel"
              >
                <X size={14} />
              </button>
            </div>

            <div className="explorer-modal-body">
              <div className="explorer-modal-message">
                <p>
                  Are you sure you want to discard changes in{' '}
                  <strong>{discardModal.fileName}</strong>?
                </p>
                <p style={{ marginTop: '6px', fontSize: '11.5px', color: 'var(--text-muted)' }}>
                  Path: <code style={{ color: '#93c5fd', fontFamily: 'var(--font-mono)' }}>{discardModal.filePath}</code>
                </p>
                <p style={{ marginTop: '8px', fontSize: '11.5px', color: '#f87171' }}>
                  This action cannot be undone. All changes in this file will be permanently lost.
                </p>
              </div>

              {discardModal.error && (
                <div className="explorer-modal-error">
                  {discardModal.error}
                </div>
              )}
            </div>

            <div className="explorer-modal-footer">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={handleCancelDiscard}
                disabled={discardModal.isDiscarding}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={handleConfirmDiscard}
                disabled={discardModal.isDiscarding}
              >
                {discardModal.isDiscarding ? 'Discarding...' : 'Discard Changes'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create Branch Modal */}
      {isCreateBranchModalOpen && (
        <div className="explorer-modal-backdrop" onClick={handleCloseCreateBranchModal}>
          <div
            className="explorer-modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-branch-modal-title"
            style={{ maxWidth: '440px' }}
          >
            <div className="explorer-modal-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <GitBranch size={15} color="#60a5fa" />
                <span id="create-branch-modal-title">Create New Branch</span>
              </div>
              <button
                type="button"
                className="explorer-modal-close-btn"
                onClick={handleCloseCreateBranchModal}
                disabled={isCreatingBranch}
                title="Cancel"
                aria-label="Cancel"
              >
                <X size={14} />
              </button>
            </div>

            <form onSubmit={handleCreateBranchSubmit}>
              <div className="explorer-modal-body">
                <div className="explorer-modal-field">
                  <label htmlFor="new-branch-name-input" className="explorer-modal-label">
                    Branch Name
                  </label>
                  <input
                    id="new-branch-name-input"
                    ref={branchInputRef}
                    type="text"
                    className={`explorer-modal-input ${branchValidationError ? 'input-error' : ''}`}
                    placeholder="e.g. feature/my-new-branch"
                    value={newBranchName}
                    onChange={(e) => {
                      setNewBranchName(e.target.value)
                      if (branchValidationError) setBranchValidationError(null)
                    }}
                    disabled={isCreatingBranch}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <div className="branch-input-hint">
                    Based on current branch: <strong>{currentBranch || statusData?.branch || 'HEAD'}</strong>
                  </div>
                </div>

                {branchValidationError && (
                  <div className="explorer-modal-error" role="alert" style={{ marginTop: '8px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <AlertCircle size={13} style={{ flexShrink: 0 }} />
                      <span>{branchValidationError}</span>
                    </div>
                  </div>
                )}
              </div>

              <div className="explorer-modal-footer">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={handleCloseCreateBranchModal}
                  disabled={isCreatingBranch}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-primary btn-sm"
                  disabled={isCreatingBranch || !newBranchName.trim()}
                >
                  {isCreatingBranch ? (
                    <>
                      <Loader2 size={12} className="spin" />
                      <span>Creating...</span>
                    </>
                  ) : (
                    'Create Branch'
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Switch Branch Unsaved Changes Confirmation Modal */}
      {switchConfirmModal.isOpen && switchConfirmModal.targetBranch && (
        <div className="explorer-modal-backdrop" onClick={handleCancelSwitchConfirm}>
          <div
            className="explorer-modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="switch-branch-confirm-title"
            style={{ maxWidth: '460px' }}
          >
            <div className="explorer-modal-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <AlertTriangle size={15} color="#f59e0b" />
                <span id="switch-branch-confirm-title">Switch Branch: Unsaved Changes</span>
              </div>
              <button
                type="button"
                className="explorer-modal-close-btn"
                onClick={handleCancelSwitchConfirm}
                disabled={Boolean(busyOperation?.startsWith('checkout:'))}
                title="Cancel"
                aria-label="Cancel"
              >
                <X size={14} />
              </button>
            </div>

            <div className="explorer-modal-body">
              <div className="explorer-modal-message">
                <p>
                  You have unsaved changes in your open editor tabs. Switching to branch{' '}
                  <strong style={{ color: '#60a5fa' }}>{switchConfirmModal.targetBranch}</strong>{' '}
                  may conflict with or overwrite these changes.
                </p>
                {dirtyTabNames && dirtyTabNames.length > 0 && (
                  <div style={{ marginTop: '8px', fontSize: '11.5px', color: 'var(--text-muted)' }}>
                    <div>Modified files:</div>
                    <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                      {dirtyTabNames.slice(0, 5).map((name) => (
                        <li key={name} style={{ color: '#fbbf24', fontFamily: 'var(--font-mono)' }}>
                          {name}
                        </li>
                      ))}
                      {dirtyTabNames.length > 5 && (
                        <li>...and {dirtyTabNames.length - 5} more</li>
                      )}
                    </ul>
                  </div>
                )}
                <p style={{ marginTop: '8px', fontSize: '11.5px', color: '#f87171' }}>
                  Are you sure you want to proceed with switching branches?
                </p>
              </div>
            </div>

            <div className="explorer-modal-footer">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={handleCancelSwitchConfirm}
                disabled={Boolean(busyOperation?.startsWith('checkout:'))}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={handleConfirmSwitchBranch}
                disabled={Boolean(busyOperation?.startsWith('checkout:'))}
              >
                {busyOperation?.startsWith('checkout:') ? (
                  <>
                    <Loader2 size={12} className="spin" />
                    <span>Switching...</span>
                  </>
                ) : (
                  'Switch Branch'
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  )
}
