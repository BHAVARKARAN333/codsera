import React, { useState, useEffect, useRef, useCallback } from 'react'
import {
  FolderOpen,
  Save,
  Code2,
  X,
  CheckCircle2,
  AlertCircle,
  Sparkles,
  Layers,
  FileCode,
  FileText,
  FileJson,
  FileType,
  Bot,
  Terminal as TerminalIcon,
  GitBranch,
  AlertTriangle,
  Files,
  GitCompare,
  Loader2,
  RefreshCw
} from 'lucide-react'
import {
  FileEntry,
  WorkspaceFileChangeEvent,
  TerminalStreamDataEvent,
  TerminalSessionExitEvent,
  GitStatusResult
} from '../../shared/types'
import { FileExplorer } from './components/FileExplorer'
import { SourceControl } from './components/SourceControl'
import { EditorPane } from './components/EditorPane'
import { DiffViewer } from './components/DiffViewer'
import { parseUnifiedDiff } from '../../shared/diffUtils'
import { normalizeFilePath, arePathsEqual } from '../../shared/pathUtils'
import { ShadowBuffer } from './services/agent/shadowBuffer'
import { ShadowCheckpointManager } from './services/agent/shadowCheckpoint'
import { AIChatPanel } from './components/AIChatPanel'
import { Terminal, TerminalEntry, TerminalTab } from './components/Terminal'

export interface ActiveDiffState {
  filePath: string
  staged: boolean
  originalContent: string
  modifiedContent: string
  rawDiff: string
  isBinary: boolean
  isLoading: boolean
  error: string | null
  truncated?: boolean
  hasStagedChanges?: boolean
  hasUnstagedChanges?: boolean
}

interface OpenTab {
  path: string
  name: string
  content: string
  originalContent: string
  isDirty: boolean
  isLoading?: boolean
  error?: string | null
  hasExternalChange?: boolean
  externalContent?: string
  isMissingOnDisk?: boolean
}

interface DirtyConfirmModalState {
  isOpen: boolean
  mode: 'close-tab' | 'switch-workspace'
  targetTab?: OpenTab
  dirtyTabs?: OpenTab[]
  isSaving: boolean
  error?: string | null
}

interface PendingShadowApproval {
  filePath?: string
  fileName?: string
  files?: Array<{ path: string; name: string }>
  oldContent?: string
  newContent?: string
  resolve: (approved: boolean) => void
}

function getTabFileIcon(fileName: string) {
  const ext = fileName.split('.').pop()?.toLowerCase() || ''
  switch (ext) {
    case 'ts':
    case 'tsx':
      return <FileCode size={13} color="#60a5fa" />
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return <FileCode size={13} color="#facc15" />
    case 'json':
      return <FileJson size={13} color="#fb923c" />
    case 'css':
    case 'scss':
    case 'less':
      return <FileType size={13} color="#c084fc" />
    case 'html':
    case 'svg':
      return <FileCode size={13} color="#f97316" />
    case 'md':
    case 'markdown':
    case 'txt':
      return <FileText size={13} color="#38bdf8" />
    default:
      return <FileText size={13} color="#94a3b8" />
  }
}

export const App: React.FC = () => {
  const [rootPath, setRootPath] = useState<string | null>(null)
  const [tree, setTree] = useState<FileEntry[]>([])
  const [tabs, setTabs] = useState<OpenTab[]>([])
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null)
  const editorPositionRef = useRef<{
    cursorLine?: number | null
    cursorColumn?: number | null
    visibleRange?: { startLine: number; endLine: number } | null
  }>({})

  const [statusMessage, setStatusMessage] = useState<string>('Ready')
  const [isSaving, setIsSaving] = useState<boolean>(false)
  const [isAIPanelOpen, setIsAIPanelOpen] = useState<boolean>(true)
  const [isTerminalOpen, setIsTerminalOpen] = useState<boolean>(false)
  const [terminalTabs, setTerminalTabs] = useState<TerminalTab[]>([])
  const [activeTerminalTabId, setActiveTerminalTabId] = useState<string | null>(null)
  const terminalTabsRef = useRef<TerminalTab[]>([])
  const activeTerminalTabIdRef = useRef<string | null>(null)
  terminalTabsRef.current = terminalTabs
  activeTerminalTabIdRef.current = activeTerminalTabId

  const [activeSidebarView, setActiveSidebarView] = useState<'explorer' | 'source-control'>('explorer')
  const [gitChangeCount, setGitChangeCount] = useState<number>(0)
  const gitStatusRequestIdRef = useRef<number>(0)
  const fileReadRequestIdRef = useRef<number>(0)
  const openDirectoryRequestIdRef = useRef<number>(0)
  const rootPathRef = useRef<string | null>(rootPath)
  rootPathRef.current = rootPath
  const shadowBufferRef = useRef<ShadowBuffer>(new ShadowBuffer())
  const checkpointManagerRef = useRef<ShadowCheckpointManager>(
    new ShadowCheckpointManager(shadowBufferRef.current)
  )
  const [, setShadowVersion] = useState<number>(0)
  const [pendingShadowApproval, setPendingShadowApproval] = useState<PendingShadowApproval | null>(null)

  // Subscribe to ShadowBuffer and ShadowCheckpointManager changes to trigger reactive UI updates
  useEffect(() => {
    const unsubShadow = shadowBufferRef.current.subscribe(() => {
      setShadowVersion((v) => v + 1)
    })
    const unsubCheckpoint = checkpointManagerRef.current.subscribe(() => {
      setShadowVersion((v) => v + 1)
    })
    return () => {
      unsubShadow()
      unsubCheckpoint()
    }
  }, [])

  const activeTerminalTab =
    terminalTabs.find((t) => t.id === activeTerminalTabId) || terminalTabs[0] || null
  const isTerminalRunning = activeTerminalTab?.isRunning || false
  const activeTerminalSessionId = activeTerminalTab?.activeProcessSessionId || null
  const terminalEntries = activeTerminalTab?.entries || []
  const [gitBranch, setGitBranch] = useState<string | null>(null)
  const [dirtyConfirmModal, setDirtyConfirmModal] = useState<DirtyConfirmModalState>({
    isOpen: false,
    mode: 'close-tab',
    isSaving: false,
    error: null
  })

  const activeTab = tabs.find((t) => arePathsEqual(t.path, activeFilePath, rootPath)) || null
  const projectName = rootPath ? rootPath.split(/[\\/]/).pop() || 'Project' : null
  const dirtyShadowFiles = shadowBufferRef.current.listDirtyFiles()

  // Helper to compute total pending git changes
  const calculateGitChangesCount = useCallback((status: GitStatusResult | null): number => {
    if (!status || !status.isRepository) return 0
    if (status.clean) return 0
    if (status.files && status.files.length > 0) return status.files.length
    return (
      (status.staged?.length || 0) +
      (status.unstaged?.length || 0) +
      (status.untracked?.length || 0) +
      (status.conflicted?.length || 0)
    )
  }, [])

  // Active Git Diff Viewer state
  const [activeDiff, setActiveDiff] = useState<ActiveDiffState | null>(null)
  const diffRequestIdRef = useRef<number>(0)
  const activeDiffRef = useRef<ActiveDiffState | null>(activeDiff)
  useEffect(() => {
    activeDiffRef.current = activeDiff
  }, [activeDiff])

  // Handle opening a file diff from Source Control
  const handleOpenFileDiff = useCallback(
    async (relativePath: string, staged: boolean) => {
      if (!rootPath) return

      const currentReqId = ++diffRequestIdRef.current
      const requestedWorkspace = rootPathRef.current
      setActiveDiff({
        filePath: relativePath,
        staged,
        originalContent: '',
        modifiedContent: '',
        rawDiff: '',
        isBinary: false,
        isLoading: true,
        error: null
      })

      try {
        if (!window?.electronAPI || typeof window.electronAPI.gitFileDiff !== 'function') {
          throw new Error('Git diff API is not available in this window. Please restart the application.')
        }

        const res = await window.electronAPI.gitFileDiff(rootPath, relativePath)

        // Drop stale response if workspace changed or another file diff was requested
        if (rootPathRef.current !== requestedWorkspace || currentReqId !== diffRequestIdRef.current) {
          return
        }

        if (!res.success) {
          setActiveDiff((prev) =>
            prev && prev.filePath === relativePath
              ? { ...prev, isLoading: false, error: res.error || 'Failed to load file diff.' }
              : prev
          )
          return
        }

        const diffText = staged ? res.stagedDiff : res.unstagedDiff
        const parsed = parseUnifiedDiff(diffText)
        const hasStaged = Boolean(res.stagedDiff && res.stagedDiff.trim().length > 0)
        const hasUnstaged = Boolean(res.unstagedDiff && res.unstagedDiff.trim().length > 0)

        setActiveDiff({
          filePath: relativePath,
          staged,
          originalContent: parsed.original,
          modifiedContent: parsed.modified,
          rawDiff: diffText,
          isBinary: res.isBinary || false,
          isLoading: false,
          error: null,
          truncated: res.truncated,
          hasStagedChanges: hasStaged,
          hasUnstagedChanges: hasUnstaged
        })
      } catch (err: unknown) {
        if (rootPathRef.current !== requestedWorkspace || currentReqId !== diffRequestIdRef.current) return
        const msg = err instanceof Error ? err.message : String(err)
        setActiveDiff((prev) =>
          prev && prev.filePath === relativePath
            ? { ...prev, isLoading: false, error: msg }
            : prev
        )
      }
    },
    [rootPath]
  )

  const handleToggleDiffMode = useCallback(
    (newStaged: boolean) => {
      if (activeDiff) {
        handleOpenFileDiff(activeDiff.filePath, newStaged)
      }
    },
    [activeDiff, handleOpenFileDiff]
  )

  const handleRefreshActiveDiff = useCallback(() => {
    if (activeDiff) {
      handleOpenFileDiff(activeDiff.filePath, activeDiff.staged)
    }
  }, [activeDiff, handleOpenFileDiff])

  const handleCloseDiff = useCallback(() => {
    setActiveDiff(null)
  }, [])

  // Callback when SourceControl component updates status
  const handleGitStatusUpdated = useCallback((status: GitStatusResult) => {
    if (status.isRepository && status.branch) {
      setGitBranch(status.branch)
    } else {
      setGitBranch(null)
    }
    setGitChangeCount(calculateGitChangesCount(status))

    // Automatically refresh open diff if one is active
    if (activeDiffRef.current) {
      handleOpenFileDiff(activeDiffRef.current.filePath, activeDiffRef.current.staged)
    }
  }, [calculateGitChangesCount, handleOpenFileDiff])

  // Check Git branch and changes count whenever workspace changes
  React.useEffect(() => {
    if (rootPath) {
      const currentRequestId = ++gitStatusRequestIdRef.current
      window.electronAPI
        .gitStatus(rootPath)
        .then((res) => {
          if (currentRequestId !== gitStatusRequestIdRef.current) return
          if (res.success && res.isRepository) {
            setGitBranch(res.branch || null)
            setGitChangeCount(calculateGitChangesCount(res))
          } else {
            setGitBranch(null)
            setGitChangeCount(0)
          }
        })
        .catch(() => {
          if (currentRequestId !== gitStatusRequestIdRef.current) return
          setGitBranch(null)
          setGitChangeCount(0)
        })
    } else {
      setGitBranch(null)
      setGitChangeCount(0)
    }
  }, [rootPath, calculateGitChangesCount])

  // Refresh git status helper for file operations and watcher events
  const [gitRefreshCounter, setGitRefreshCounter] = useState<number>(0)
  const refreshGitStatus = useCallback(() => {
    const currentRoot = rootPathRef.current
    if (!currentRoot) {
      setGitBranch(null)
      setGitChangeCount(0)
      return
    }
    setGitRefreshCounter((c) => c + 1)
    const currentRequestId = ++gitStatusRequestIdRef.current
    window.electronAPI
      .gitStatus(currentRoot)
      .then((res) => {
        if (currentRequestId !== gitStatusRequestIdRef.current) return
        if (res.success && res.isRepository) {
          setGitBranch(res.branch || null)
          setGitChangeCount(calculateGitChangesCount(res))
        } else {
          setGitBranch(null)
          setGitChangeCount(0)
        }
      })
      .catch(() => {
        if (currentRequestId !== gitStatusRequestIdRef.current) return
        setGitBranch(null)
        setGitChangeCount(0)
      })
  }, [calculateGitChangesCount])

  // Restore previously opened workspace on startup if it still exists
  React.useEffect(() => {
    window.electronAPI.getLastWorkspace().then((result) => {
      if (result.success && result.rootPath && result.tree) {
        setRootPath(result.rootPath)
        setTree(result.tree)
        setStatusMessage(`Workspace: ${result.rootPath}`)
      }
    }).catch(() => {
      // Gracefully fall back to clean empty state if folder was moved/deleted
    })
  }, [])

  // Keep refs for current state to avoid stale closures in debounced watcher callbacks
  const tabsRef = useRef<OpenTab[]>(tabs)
  tabsRef.current = tabs
  rootPathRef.current = rootPath

  // Track recent self-initiated mutations to prevent reload loops
  const recentSelfMutations = useRef<Map<string, number>>(new Map())

  const recordSelfMutation = useCallback((targetPath: string) => {
    const norm = targetPath.replace(/\\/g, '/').toLowerCase()
    recentSelfMutations.current.set(norm, Date.now())
  }, [])

  const isSelfMutation = useCallback((targetPath: string): boolean => {
    const norm = targetPath.replace(/\\/g, '/').toLowerCase()
    const timestamp = recentSelfMutations.current.get(norm)
    if (!timestamp) return false
    if (Date.now() - timestamp < 2000) {
      return true
    }
    recentSelfMutations.current.delete(norm)
    return false
  }, [])

  // Start workspace filesystem watcher whenever workspace opens or switches
  React.useEffect(() => {
    if (rootPath) {
      window.electronAPI.watchWorkspace(rootPath).catch(() => {})
    } else {
      window.electronAPI.unwatchWorkspace().catch(() => {})
    }
    return () => {
      window.electronAPI.unwatchWorkspace().catch(() => {})
    }
  }, [rootPath])

  // Refresh directory tree
  const handleRefreshTree = useCallback(async () => {
    const currentRoot = rootPathRef.current
    if (!currentRoot) return
    try {
      const result = await window.electronAPI.readTree(currentRoot)
      if (result.success && result.tree) {
        setTree(result.tree)
      }
    } catch (err) {
      console.error('Failed to refresh explorer tree:', err)
    }
  }, [])

  // Debounced queue for external workspace file change events
  const pendingEventsRef = useRef<WorkspaceFileChangeEvent[]>([])
  const watcherDebounceTimerRef = useRef<NodeJS.Timeout | null>(null)

  const processWatcherBatch = useCallback(async () => {
    const events = pendingEventsRef.current.splice(0)
    if (events.length === 0) return

    const currentRoot = rootPathRef.current
    if (!currentRoot) return

    const normRoot = currentRoot.replace(/\\/g, '/').replace(/\/+$/, '')

    // Coalesce events per normalized path
    const pathEventMap = new Map<string, WorkspaceFileChangeEvent>()
    for (const evt of events) {
      const cleanRel = evt.relativePath.replace(/\\/g, '/').replace(/^\/+/, '')
      const fullPath = `${normRoot}/${cleanRel}`
      const normKey = fullPath.toLowerCase()

      const existing = pathEventMap.get(normKey)
      if (existing) {
        if (evt.eventType === 'unlink') {
          pathEventMap.set(normKey, evt)
        } else if (existing.eventType === 'add') {
          pathEventMap.set(normKey, { ...evt, eventType: 'add' })
        } else {
          pathEventMap.set(normKey, evt)
        }
      } else {
        pathEventMap.set(normKey, evt)
      }
    }

    // Determine if FileExplorer tree should refresh
    const shouldRefreshTree = Array.from(pathEventMap.values()).some(
      (e) => e.eventType === 'add' || e.eventType === 'unlink' || e.isDirectory
    )

    if (shouldRefreshTree) {
      handleRefreshTree()
    }

    // Invalidate/conflict shadow buffer entries for external disk modifications
    for (const [normKey, evt] of pathEventMap.entries()) {
      if (shadowBufferRef.current.hasSnapshot(normKey, currentRoot)) {
        shadowBufferRef.current.markConflicted(
          normKey,
          `External file ${evt.eventType} detected on disk.`
        )
      }
    }

    // Inspect open tabs
    const currentTabs = tabsRef.current
    for (const tab of currentTabs) {
      const normTab = tab.path.replace(/\\/g, '/').toLowerCase()
      const matchingEvent = pathEventMap.get(normTab)
      if (!matchingEvent) continue

      if (matchingEvent.eventType === 'unlink') {
        // File deleted externally
        setTabs((prev) =>
          prev.map((t) => {
            if (t.path.replace(/\\/g, '/').toLowerCase() === normTab) {
              return {
                ...t,
                isMissingOnDisk: true,
                hasExternalChange: false
              }
            }
            return t
          })
        )
        if (shadowBufferRef.current.hasSnapshot(tab.path, currentRoot)) {
          checkpointManagerRef.current.markFileConflicted(
            tab.path,
            'Workspace file was deleted externally on disk.',
            currentRoot
          )
        }
        setStatusMessage(
          tab.isDirty
            ? `"${tab.name}" was deleted externally. Unsaved buffer preserved.`
            : `"${tab.name}" is no longer available on disk.`
        )
      } else {
        // File modified externally (change or add)
        try {
          const result = await window.electronAPI.readFile(tab.path)
          if (result.success && result.content !== undefined) {
            const externalDiskContent = result.content
            setTabs((prev) =>
              prev.map((t) => {
                if (t.path.replace(/\\/g, '/').toLowerCase() === normTab) {
                  if (!t.isDirty) {
                    // Clean tab: reload immediately into Monaco
                    return {
                      ...t,
                      content: externalDiskContent,
                      originalContent: externalDiskContent,
                      isDirty: false,
                      hasExternalChange: false,
                      externalContent: undefined,
                      isMissingOnDisk: false
                    }
                  } else {
                    // Dirty tab
                    if (t.content === externalDiskContent) {
                      // External matches current local content!
                      return {
                        ...t,
                        originalContent: externalDiskContent,
                        isDirty: false,
                        hasExternalChange: false,
                        externalContent: undefined,
                        isMissingOnDisk: false
                      }
                    } else {
                      // Preserve local edits, show warning banner
                      return {
                        ...t,
                        hasExternalChange: true,
                        externalContent: externalDiskContent,
                        isMissingOnDisk: false
                      }
                    }
                  }
                }
                return t
              })
            )

            if (shadowBufferRef.current.hasSnapshot(tab.path, currentRoot)) {
              checkpointManagerRef.current.markFileConflicted(
                tab.path,
                'Workspace file changed externally on disk.',
                currentRoot
              )
            }

            if (!tab.isDirty) {
              setStatusMessage(`"${tab.name}" reloaded from disk.`)
            } else if (tab.content !== externalDiskContent) {
              setStatusMessage(`"${tab.name}" was modified externally. Local unsaved changes preserved.`)
            }
          }
        } catch (err) {
          console.error(`Failed to read external changes for "${tab.path}":`, err)
        }
      }
      refreshGitStatus()
    }
  }, [handleRefreshTree, refreshGitStatus])

  // Watcher subscription effect with workspace path validation, self-mutation filtering, and debouncing
  useEffect(() => {
    if (typeof window === 'undefined' || !window.electronAPI?.onWorkspaceFileChanged) return

    const unsubscribe = window.electronAPI.onWorkspaceFileChanged((event) => {
      const currentRoot = rootPathRef.current
      if (!currentRoot) return

      // Validate event workspace root
      const normRoot = currentRoot.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
      const eventRoot = (event.workspaceRoot || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
      if (eventRoot && eventRoot !== normRoot) {
        return // Ignore events from past or different workspace
      }

      // Validate relative path
      const cleanRel = (event.relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '')
      if (!cleanRel || cleanRel.startsWith('..') || cleanRel.includes('/../')) {
        return // Reject traversal
      }

      // Ignore cache and ignored directories
      const parts = cleanRel.split('/')
      const IGNORED = new Set(['.git', 'node_modules', 'dist', 'out', '.vscode', '.idea', '.cache', 'scratch'])
      if (parts.some((p) => IGNORED.has(p))) {
        return
      }

      const lowerRel = cleanRel.toLowerCase()
      if (lowerRel.endsWith('.tsbuildinfo') || lowerRel.endsWith('.tmp') || lowerRel.endsWith('~')) {
        return
      }

      // Check self-mutation for open tabs
      const fullAbs = `${currentRoot.replace(/\\/g, '/').replace(/\/+$/, '')}/${cleanRel}`
      if (isSelfMutation(fullAbs) || isSelfMutation(cleanRel)) {
        return // Self-initiated write, ignore
      }

      // Enqueue event
      pendingEventsRef.current.push(event)

      // Debounce burst events by 120ms
      if (watcherDebounceTimerRef.current) {
        clearTimeout(watcherDebounceTimerRef.current)
      }

      watcherDebounceTimerRef.current = setTimeout(async () => {
        watcherDebounceTimerRef.current = null
        await processWatcherBatch()
      }, 120)
    })

    return () => {
      unsubscribe()
      if (watcherDebounceTimerRef.current) {
        clearTimeout(watcherDebounceTimerRef.current)
        watcherDebounceTimerRef.current = null
      }
    }
  }, [rootPath, isSelfMutation, processWatcherBatch])

  // Dismiss external change warning, retaining local edits
  const handleDismissExternalChange = (filePath: string) => {
    const norm = filePath.replace(/\\/g, '/').toLowerCase()
    setTabs((prev) =>
      prev.map((t) =>
        t.path.replace(/\\/g, '/').toLowerCase() === norm
          ? { ...t, hasExternalChange: false, externalContent: undefined }
          : t
      )
    )
    setStatusMessage('Dismissed external change warning. Local edits kept.')
  }

  // Reload external version from disk into editor
  const handleReloadExternalChange = (filePath: string) => {
    const norm = filePath.replace(/\\/g, '/').toLowerCase()
    setTabs((prev) =>
      prev.map((t) => {
        if (t.path.replace(/\\/g, '/').toLowerCase() === norm) {
          const contentToLoad = t.externalContent !== undefined ? t.externalContent : t.content
          return {
            ...t,
            content: contentToLoad,
            originalContent: contentToLoad,
            isDirty: false,
            hasExternalChange: false,
            externalContent: undefined,
            isMissingOnDisk: false
          }
        }
        return t
      })
    )
    setStatusMessage('Reloaded file from disk.')
  }

  const handleFileCreated = async (createdPath: string) => {
    recordSelfMutation(createdPath)
    await handleRefreshTree()
    setStatusMessage(`Created file: ${createdPath}`)
  }

  const handleFileEdited = (editedPath: string, newContent: string) => {
    recordSelfMutation(editedPath)
    const cleanEdited = editedPath.replace(/^[/\\]+/, '').replace(/\\/g, '/')

    setTabs((prev) =>
      prev.map((t) => {
        const cleanTabPath = t.path.replace(/\\/g, '/')
        if (cleanTabPath.endsWith(cleanEdited) || cleanTabPath === cleanEdited) {
          return {
            ...t,
            content: newContent,
            originalContent: newContent,
            isDirty: false
          }
        }
        return t
      })
    )
    setStatusMessage(`Edited file: ${editedPath}`)
  }

  const handleShadowUpdated = useCallback(
    (editedPath: string, newContent: string, revision: number) => {
      const cleanEdited = editedPath.replace(/^[/\\]+/, '').replace(/\\/g, '/')

      setTabs((prev) =>
        prev.map((t) => {
          const cleanTabPath = t.path.replace(/\\/g, '/')
          if (cleanTabPath.endsWith(cleanEdited) || cleanTabPath === cleanEdited) {
            return {
              ...t,
              content: newContent,
              isDirty: true
            }
          }
          return t
        })
      )
      setStatusMessage(`AI shadow edit staged (rev ${revision}): ${editedPath}`)
    },
    []
  )

  // Accept & commit staged AI changes from ShadowBuffer to disk
  const handleAcceptShadowDiff = async (filePath: string) => {
    const currentRoot = rootPathRef.current
    if (!currentRoot) {
      setStatusMessage('Cannot apply changes: no workspace open.')
      return
    }

    const snapshot = shadowBufferRef.current.getSnapshot(filePath, currentRoot)
    if (!snapshot || !snapshot.dirty) {
      setStatusMessage('No active shadow changes to apply.')
      return
    }

    if (snapshot.isConflicted) {
      setStatusMessage(`Cannot apply changes: ${snapshot.conflictReason || 'file changed externally on disk.'}`)
      return
    }

    const fileName = filePath.split(/[\\/]/).pop() || filePath
    setPendingShadowApproval({
      filePath,
      fileName,
      oldContent: snapshot.originalContent,
      newContent: snapshot.shadowContent,
      resolve: async (approved: boolean) => {
        setPendingShadowApproval(null)
        if (!approved) {
          setStatusMessage('AI changes rejected by user.')
          return
        }

        setIsSaving(true)
        setStatusMessage(`Applying AI changes to ${fileName}...`)
        try {
          const commitResult = await shadowBufferRef.current.commit(filePath, {
            workspaceRoot: currentRoot,
            skipApproval: true,
            onFileEdited: handleFileEdited
          })

          if (commitResult.success) {
            setTabs((prevTabs) =>
              prevTabs.map((t) => {
                if (arePathsEqual(t.path, filePath, currentRoot)) {
                  return {
                    ...t,
                    content: commitResult.content || snapshot.shadowContent,
                    originalContent: commitResult.content || snapshot.shadowContent,
                    isDirty: false
                  }
                }
                return t
              })
            )
            setShadowVersion((v) => v + 1)
            setStatusMessage(`Applied AI changes to ${fileName}`)
            refreshGitStatus()
          } else {
            setShadowVersion((v) => v + 1)
            setStatusMessage(`Failed to apply changes: ${commitResult.error || 'Unknown error'}`)
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          setStatusMessage(`Error applying changes: ${msg}`)
        } finally {
          setIsSaving(false)
        }
      }
    })
  }

  // Reject & discard staged AI changes, restoring baseline
  const handleRejectShadowDiff = (filePath: string) => {
    const currentRoot = rootPathRef.current
    shadowBufferRef.current.reset(filePath, currentRoot)
    shadowBufferRef.current.remove(filePath, currentRoot)

    setTabs((prevTabs) =>
      prevTabs.map((t) => {
        if (arePathsEqual(t.path, filePath, currentRoot)) {
          return {
            ...t,
            content: t.originalContent,
            isDirty: false
          }
        }
        return t
      })
    )
    setShadowVersion((v) => v + 1)
    const fileName = filePath.split(/[\\/]/).pop() || filePath
    setStatusMessage(`Discarded AI shadow edits for ${fileName}`)
  }

  // Apply all staged AI changes across multiple files using transactional checkpoint (Phase 14.2)
  const handleApplyAllCheckpoints = async () => {
    const currentRoot = rootPathRef.current
    if (!currentRoot) {
      setStatusMessage('Cannot apply changes: no workspace open.')
      return
    }

    const dirtyFiles = shadowBufferRef.current.listDirtyFiles()
    if (dirtyFiles.length === 0) {
      setStatusMessage('No active shadow changes to apply.')
      return
    }

    const cp = checkpointManagerRef.current.createCheckpoint(currentRoot)
    const filesToApprove = dirtyFiles.map((p) => ({
      path: p,
      name: p.split(/[\\/]/).pop() || p
    }))

    setPendingShadowApproval({
      files: filesToApprove,
      resolve: async (approved: boolean) => {
        setPendingShadowApproval(null)
        if (!approved) {
          setStatusMessage('Multi-file AI changes rejected by user.')
          return
        }

        setIsSaving(true)
        setStatusMessage(`Applying AI changes across ${cp.fileCount} files...`)

        try {
          const commitRes = await checkpointManagerRef.current.commitCheckpoint(cp.checkpointId, {
            workspaceRoot: currentRoot,
            skipApproval: true,
            onFileCommitted: handleFileEdited
          })

          if (commitRes.success) {
            setTabs((prevTabs) =>
              prevTabs.map((t) => {
                const isCommitted = commitRes.committedFiles.some((p) =>
                  arePathsEqual(t.path, p, currentRoot)
                )
                if (isCommitted) {
                  const snap = shadowBufferRef.current.getSnapshot(t.path, currentRoot)
                  const newContent = snap?.shadowContent || t.content
                  return {
                    ...t,
                    content: newContent,
                    originalContent: newContent,
                    isDirty: false
                  }
                }
                return t
              })
            )
            setShadowVersion((v) => v + 1)
            setStatusMessage(`Applied AI changes to ${commitRes.committedFiles.length} file(s)`)
            refreshGitStatus()
          } else {
            setShadowVersion((v) => v + 1)
            setStatusMessage(
              `Failed to apply changes: ${commitRes.recoveryError || commitRes.error || 'Unknown error'}`
            )
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          setStatusMessage(`Error applying multi-file changes: ${msg}`)
        } finally {
          setIsSaving(false)
        }
      }
    })
  }

  // Discard all staged AI changes across all files (Phase 14.2)
  const handleDiscardAllCheckpoints = () => {
    const currentRoot = rootPathRef.current
    const dirtyFiles = shadowBufferRef.current.listDirtyFiles()
    checkpointManagerRef.current.discard(undefined, currentRoot)

    setTabs((prevTabs) =>
      prevTabs.map((t) => {
        const wasDirty = dirtyFiles.some((p) => arePathsEqual(t.path, p, currentRoot))
        if (wasDirty) {
          return {
            ...t,
            content: t.originalContent,
            isDirty: false
          }
        }
        return t
      })
    )

    setShadowVersion((v) => v + 1)
    setStatusMessage('Discarded all staged AI changes.')
  }

  // Handle file or folder renamed in explorer
  const handlePathRenamed = (oldFullPath: string, newFullPath: string, isDirectory: boolean) => {
    recordSelfMutation(oldFullPath)
    recordSelfMutation(newFullPath)
    const normOld = oldFullPath.replace(/\\/g, '/').toLowerCase()
    const normNew = newFullPath.replace(/\\/g, '/')
    const prefix = normOld.endsWith('/') ? normOld : normOld + '/'

    setTabs((prevTabs) =>
      prevTabs.map((tab) => {
        const normTab = tab.path.replace(/\\/g, '/').toLowerCase()
        if (!isDirectory) {
          if (normTab === normOld) {
            const newName = newFullPath.split(/[\\/]/).pop() || tab.name
            return {
              ...tab,
              path: newFullPath,
              name: newName
            }
          }
        } else {
          if (normTab.startsWith(prefix)) {
            const relativeSub = tab.path.replace(/\\/g, '/').slice(prefix.length)
            const updatedPath = `${normNew.replace(/\/$/, '')}/${relativeSub}`
            return {
              ...tab,
              path: updatedPath
            }
          }
        }
        return tab
      })
    )

    setActiveFilePath((prevActive) => {
      if (!prevActive) return null
      const normActive = prevActive.replace(/\\/g, '/').toLowerCase()
      if (!isDirectory) {
        if (normActive === normOld) {
          return newFullPath
        }
      } else {
        if (normActive.startsWith(prefix)) {
          const relativeSub = prevActive.replace(/\\/g, '/').slice(prefix.length)
          return `${normNew.replace(/\/$/, '')}/${relativeSub}`
        }
      }
      return prevActive
    })
  }

  // Handle file or folder deleted in explorer
  const handlePathDeleted = (deletedFullPath: string, isDirectory: boolean) => {
    recordSelfMutation(deletedFullPath)
    const normDeleted = deletedFullPath.replace(/\\/g, '/').toLowerCase()
    const prefix = normDeleted.endsWith('/') ? normDeleted : normDeleted + '/'

    const isTabAffected = (tabPath: string) => {
      const normTab = tabPath.replace(/\\/g, '/').toLowerCase()
      return !isDirectory ? normTab === normDeleted : normTab.startsWith(prefix)
    }

    setTabs((prevTabs) => {
      const updatedTabs: OpenTab[] = []
      let activeNeedsSwitch = false

      for (const tab of prevTabs) {
        if (isTabAffected(tab.path)) {
          if (tab.isDirty) {
            // Protect unsaved buffer from data loss: keep tab open with [deleted] indicator
            const cleanName = tab.name.replace(/\s*\[deleted\]$/, '')
            updatedTabs.push({
              ...tab,
              name: `${cleanName} [deleted]`
            })
          } else {
            // Clean tab is closed safely
            if (arePathsEqual(tab.path, activeFilePath, rootPath)) {
              activeNeedsSwitch = true
            }
          }
        } else {
          updatedTabs.push(tab)
        }
      }

      if (activeNeedsSwitch) {
        if (updatedTabs.length > 0) {
          setActiveFilePath(updatedTabs[updatedTabs.length - 1].path)
        } else {
          setActiveFilePath(null)
        }
      }

      return updatedTabs
    })
  }

  // Integrated Terminal Handlers & Multi-session Tabs Lifecycle
  // Auto-initialize initial terminal tab when workspace is loaded
  React.useEffect(() => {
    if (rootPath) {
      setTerminalTabs((prev) => {
        if (prev.length > 0) return prev
        const initialTabId = 'term_tab_' + Date.now()
        setActiveTerminalTabId(initialTabId)
        return [
          {
            id: initialTabId,
            title: 'Terminal 1',
            cwd: rootPath,
            entries: [],
            commandHistory: [],
            inputBuffer: '',
            isRunning: false,
            activeProcessSessionId: null,
            lastExitCode: null,
            status: 'idle',
            createdAt: Date.now()
          }
        ]
      })
    }
  }, [rootPath])

  // Listen for real-time terminal stdout/stderr chunks and session exit events
  React.useEffect(() => {
    if (!window?.electronAPI) return

    const unsubData = window.electronAPI.onTerminalStreamData?.((evt: TerminalStreamDataEvent) => {
      if (!evt || !evt.sessionId) return
      setTerminalTabs((prevTabs) => {
        const tabIdx = prevTabs.findIndex(
          (t) =>
            t.activeProcessSessionId === evt.sessionId ||
            t.entries.some((e: TerminalEntry) => e.sessionId === evt.sessionId || e.id === evt.sessionId)
        )
        if (tabIdx === -1) return prevTabs

        const targetTab = prevTabs[tabIdx]
        const entryIdx = targetTab.entries.findIndex(
          (e: TerminalEntry) => e.sessionId === evt.sessionId || e.id === evt.sessionId
        )
        if (entryIdx === -1) return prevTabs

        const targetEntry = targetTab.entries[entryIdx]
        const updatedEntry = {
          ...targetEntry,
          stdout: evt.type === 'stdout' ? targetEntry.stdout + evt.data : targetEntry.stdout,
          stderr: evt.type === 'stderr' ? targetEntry.stderr + evt.data : targetEntry.stderr
        }

        const nextEntries = [...targetTab.entries]
        nextEntries[entryIdx] = updatedEntry

        const nextTabs = [...prevTabs]
        nextTabs[tabIdx] = {
          ...targetTab,
          entries: nextEntries
        }
        return nextTabs
      })
    })

    const unsubExit = window.electronAPI.onTerminalSessionExit?.((evt: TerminalSessionExitEvent) => {
      if (!evt || !evt.sessionId) return
      setTerminalTabs((prevTabs) => {
        const tabIdx = prevTabs.findIndex(
          (t) =>
            t.activeProcessSessionId === evt.sessionId ||
            t.entries.some((e: TerminalEntry) => e.sessionId === evt.sessionId || e.id === evt.sessionId)
        )
        if (tabIdx === -1) return prevTabs

        const targetTab = prevTabs[tabIdx]
        const entryIdx = targetTab.entries.findIndex(
          (e: TerminalEntry) => e.sessionId === evt.sessionId || e.id === evt.sessionId
        )
        if (entryIdx === -1) return prevTabs

        const targetEntry = targetTab.entries[entryIdx]
        // Idempotency: avoid duplicate updates
        if (!targetEntry.running && targetEntry.exitCode !== null) return prevTabs

        const updatedEntry = {
          ...targetEntry,
          running: false,
          exitCode: evt.exitCode,
          timedOut: evt.timedOut,
          error: evt.error || targetEntry.error,
          stdout: targetEntry.stdout || evt.stdout || '',
          stderr: targetEntry.stderr || evt.stderr || ''
        }

        const nextEntries = [...targetTab.entries]
        nextEntries[entryIdx] = updatedEntry

        const isSuccess = evt.exitCode === 0 && !evt.timedOut
        const newStatus = evt.timedOut ? 'failed' : isSuccess ? 'completed' : 'failed'

        const nextTabs = [...prevTabs]
        nextTabs[tabIdx] = {
          ...targetTab,
          isRunning: false,
          activeProcessSessionId: null,
          lastExitCode: evt.exitCode,
          status: newStatus,
          entries: nextEntries
        }
        return nextTabs
      })

      const currentActiveTab = terminalTabsRef.current.find(
        (t) => t.id === activeTerminalTabIdRef.current
      )
      if (currentActiveTab && currentActiveTab.activeProcessSessionId === evt.sessionId) {
        if (evt.exitCode === 0 && !evt.timedOut) {
          setStatusMessage('Terminal command completed (exit 0)')
        } else if (evt.timedOut) {
          setStatusMessage('Terminal command timed out')
        } else {
          setStatusMessage(`Terminal command failed (exit ${evt.exitCode ?? 'err'})`)
        }
      }
    })

    return () => {
      unsubData?.()
      unsubExit?.()
    }
  }, [rootPath])

  const handleNewTerminalTab = () => {
    let nextNum = 1
    const titles = new Set(terminalTabsRef.current.map((t) => t.title))
    while (titles.has(`Terminal ${nextNum}`)) {
      nextNum++
    }
    const newTabId = 'term_tab_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6)
    const newTab: TerminalTab = {
      id: newTabId,
      title: `Terminal ${nextNum}`,
      cwd: rootPath || '',
      entries: [],
      commandHistory: [],
      inputBuffer: '',
      isRunning: false,
      activeProcessSessionId: null,
      lastExitCode: null,
      status: 'idle',
      createdAt: Date.now()
    }
    setTerminalTabs((prev) => [...prev, newTab])
    setActiveTerminalTabId(newTabId)
    setIsTerminalOpen(true)
    setStatusMessage(`Created new terminal tab: ${newTab.title}`)
  }

  const handleSelectTerminalTab = (tabId: string) => {
    setActiveTerminalTabId(tabId)
  }

  const handleCloseTerminalTab = async (tabId: string, force = false) => {
    const target = terminalTabsRef.current.find((t) => t.id === tabId)
    if (!target) return

    if (target.isRunning && target.activeProcessSessionId && force) {
      try {
        if (typeof window.electronAPI?.terminalKill === 'function') {
          await window.electronAPI.terminalKill(target.activeProcessSessionId)
        }
      } catch (err) {
        console.error('Error killing session on close:', err)
      }
    }

    setTerminalTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === tabId)
      if (idx === -1) return prev
      const nextTabs = prev.filter((t) => t.id !== tabId)

      if (activeTerminalTabIdRef.current === tabId) {
        if (nextTabs.length > 0) {
          const nextIdx = Math.min(idx, nextTabs.length - 1)
          setActiveTerminalTabId(nextTabs[nextIdx].id)
        } else {
          setActiveTerminalTabId(null)
        }
      }
      return nextTabs
    })
  }

  const handleUpdateTerminalInputBuffer = (tabId: string, input: string) => {
    setTerminalTabs((prev) =>
      prev.map((t) => (t.id === tabId ? { ...t, inputBuffer: input } : t))
    )
  }

  const handleRunTerminalCommand = async (command: string) => {
    if (!rootPath) return

    let currentTab = terminalTabsRef.current.find((t) => t.id === activeTerminalTabIdRef.current)
    if (!currentTab) {
      handleNewTerminalTab()
      return
    }

    if (currentTab.isRunning) return

    const targetTabId = currentTab.id
    const sessionId = 'term_' + crypto.randomUUID()
    const newEntry: TerminalEntry = {
      id: sessionId,
      sessionId,
      command,
      cwd: currentTab.cwd || rootPath,
      stdout: '',
      stderr: '',
      exitCode: null,
      running: true,
      timestamp: Date.now(),
      source: 'user'
    }

    setTerminalTabs((prev) =>
      prev.map((t) =>
        t.id === targetTabId
          ? {
              ...t,
              isRunning: true,
              activeProcessSessionId: sessionId,
              status: 'running',
              inputBuffer: '',
              commandHistory: t.commandHistory.includes(command)
                ? t.commandHistory
                : [...t.commandHistory, command],
              entries: [...t.entries, newEntry]
            }
          : t
      )
    )

    setStatusMessage(`Running: ${command}`)

    try {
      if (typeof window.electronAPI?.terminalSpawn === 'function') {
        const spawnRes = await window.electronAPI.terminalSpawn({
          sessionId,
          command,
          cwd: currentTab.cwd || rootPath,
          workspaceRoot: rootPath,
          source: 'user'
        })
        if (!spawnRes.success) {
          setTerminalTabs((prev) =>
            prev.map((t) =>
              t.id === targetTabId
                ? {
                    ...t,
                    isRunning: false,
                    activeProcessSessionId: null,
                    status: 'failed',
                    lastExitCode: -1,
                    entries: t.entries.map((e: TerminalEntry) =>
                      e.id === sessionId || e.sessionId === sessionId
                        ? {
                            ...e,
                            running: false,
                            error: spawnRes.error || 'Failed to spawn command',
                            exitCode: -1
                          }
                        : e
                    )
                  }
                : t
            )
          )
          setStatusMessage(`Command error: ${spawnRes.error || 'Failed to spawn'}`)
        }
      } else {
        // Fallback to legacy runCommand
        const result = await window.electronAPI.runCommand(command, currentTab.cwd || rootPath)
        setTerminalTabs((prev) =>
          prev.map((t) =>
            t.id === targetTabId
              ? {
                  ...t,
                  isRunning: false,
                  activeProcessSessionId: null,
                  status: result.success ? 'completed' : 'failed',
                  lastExitCode: result.exitCode,
                  entries: t.entries.map((e: TerminalEntry) =>
                    e.id === sessionId || e.sessionId === sessionId
                      ? {
                          ...e,
                          running: false,
                          stdout: result.stdout,
                          stderr: result.stderr,
                          exitCode: result.exitCode,
                          timedOut: result.timedOut,
                          error: result.error
                        }
                      : e
                  )
                }
              : t
          )
        )
        setStatusMessage(
          result.success
            ? `Finished: ${command} (exit 0)`
            : `Command failed: ${command} (exit ${result.exitCode ?? 'err'})`
        )
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setTerminalTabs((prev) =>
        prev.map((t) =>
          t.id === targetTabId
            ? {
                ...t,
                isRunning: false,
                activeProcessSessionId: null,
                status: 'failed',
                lastExitCode: -1,
                entries: t.entries.map((e: TerminalEntry) =>
                  e.id === sessionId || e.sessionId === sessionId
                    ? {
                        ...e,
                        running: false,
                        error: msg,
                        exitCode: -1
                      }
                    : e
                )
              }
            : t
        )
      )
      setStatusMessage(`Command error: ${msg}`)
    }
  }

  const handleSendTerminalInput = async (input: string): Promise<boolean> => {
    const currentTab = terminalTabsRef.current.find((t) => t.id === activeTerminalTabIdRef.current)
    if (!currentTab || !currentTab.isRunning || !currentTab.activeProcessSessionId) {
      setStatusMessage('No active running terminal session to receive input.')
      return false
    }

    const activeId = currentTab.activeProcessSessionId

    try {
      if (typeof window.electronAPI?.terminalWriteInput !== 'function') {
        setStatusMessage('Interactive terminal input is not supported in this environment.')
        return false
      }

      const payload = input.endsWith('\n') ? input : input + '\n'

      const result = await window.electronAPI.terminalWriteInput(activeId, payload)
      if (!result.success) {
        setStatusMessage(`Failed to send input: ${result.error || 'Unknown error'}`)
        return false
      }

      setTerminalTabs((prev) =>
        prev.map((t) =>
          t.id === currentTab.id
            ? {
                ...t,
                inputBuffer: '',
                entries: t.entries.map((e: TerminalEntry) =>
                  e.id === activeId || e.sessionId === activeId
                    ? {
                        ...e,
                        stdout: e.stdout + payload
                      }
                    : e
                )
              }
            : t
        )
      )

      return true
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setStatusMessage(`Error sending input: ${msg}`)
      return false
    }
  }

  const handleStopTerminalCommand = async () => {
    const currentTab = terminalTabsRef.current.find((t) => t.id === activeTerminalTabIdRef.current)
    if (!currentTab || !currentTab.isRunning || !currentTab.activeProcessSessionId) {
      return
    }

    try {
      const activeId = currentTab.activeProcessSessionId
      if (typeof window.electronAPI?.terminalKill === 'function') {
        await window.electronAPI.terminalKill(activeId)
      } else {
        await window.electronAPI.stopCommand(activeId)
      }
      setStatusMessage('Command stopped by user.')
    } catch (err) {
      console.error('Failed to stop command:', err)
    }
  }

  const handleClearTerminal = () => {
    const currentTabId = activeTerminalTabIdRef.current
    if (!currentTabId) return
    setTerminalTabs((prev) =>
      prev.map((t) => (t.id === currentTabId ? { ...t, entries: [] } : t))
    )
  }

  const handleAICommandExecuted = (
    command: string,
    result: { stdout: string; stderr: string; exitCode: number | null }
  ) => {
    const newEntry: TerminalEntry = {
      id: crypto.randomUUID(),
      command,
      cwd: rootPath || '',
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      running: false,
      timestamp: Date.now(),
      source: 'ai'
    }

    setTerminalTabs((prev) => {
      if (prev.length === 0) {
        const aiTabId = 'term_tab_' + Date.now()
        setActiveTerminalTabId(aiTabId)
        return [
          {
            id: aiTabId,
            title: 'Terminal 1',
            cwd: rootPath || '',
            entries: [newEntry],
            commandHistory: [],
            inputBuffer: '',
            isRunning: false,
            activeProcessSessionId: null,
            lastExitCode: result.exitCode,
            status: result.exitCode === 0 ? 'completed' : 'failed',
            createdAt: Date.now()
          }
        ]
      }

      const targetId = activeTerminalTabIdRef.current || prev[0].id
      return prev.map((t) =>
        t.id === targetId
          ? {
              ...t,
              entries: [...t.entries, newEntry]
            }
          : t
      )
    })

    setIsTerminalOpen(true)
    setStatusMessage(`AI executed: ${command}`)
  }

  // Perform directory open after dirty tabs check/save
  const performOpenFolderDialog = async () => {
    const reqId = ++openDirectoryRequestIdRef.current
    try {
      const result = await window.electronAPI.openDirectory()
      if (reqId !== openDirectoryRequestIdRef.current) {
        return
      }
      if (result.success && result.rootPath && result.tree) {
        setRootPath(result.rootPath)
        setTree(result.tree)
        setTabs([])
        setActiveFilePath(null)
        setActiveDiff(null)
        shadowBufferRef.current.clear()
        if (typeof window.electronAPI?.terminalKillAll === 'function') {
          window.electronAPI.terminalKillAll().catch(() => {})
        }
        const initialTabId = 'term_tab_' + Date.now()
        setTerminalTabs([
          {
            id: initialTabId,
            title: 'Terminal 1',
            cwd: result.rootPath,
            entries: [],
            commandHistory: [],
            inputBuffer: '',
            isRunning: false,
            activeProcessSessionId: null,
            lastExitCode: null,
            status: 'idle',
            createdAt: Date.now()
          }
        ])
        setActiveTerminalTabId(initialTabId)
        setStatusMessage(`Opened workspace: ${result.rootPath}`)
      } else if (result.error) {
        setStatusMessage(`Error opening folder: ${result.error}`)
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setStatusMessage(`Failed to open folder: ${msg}`)
    }
  }

  // Open directory via native dialog with dirty tab protection
  const handleOpenFolderDialog = async () => {
    const dirtyTabs = tabs.filter((t) => t.isDirty)
    if (dirtyTabs.length > 0) {
      setDirtyConfirmModal({
        isOpen: true,
        mode: 'switch-workspace',
        dirtyTabs,
        isSaving: false,
        error: null
      })
    } else {
      await performOpenFolderDialog()
    }
  }

  // Open and read file with loading, error, stale-response, and debounce protection
  const handleOpenFile = async (filePath: string, fileName?: string) => {
    setActiveDiff(null)

    const currentRoot = rootPathRef.current
    const canonicalPath = normalizeFilePath(filePath, currentRoot)
    const effectiveName = fileName || canonicalPath.split('/').pop() || 'Untitled'

    // Check if tab is already open and valid using tabsRef.current to avoid stale closures
    const existing = tabsRef.current.find((t) => arePathsEqual(t.path, canonicalPath, currentRoot))
    if (existing) {
      setActiveFilePath(existing.path)
      // If the tab already loaded without error, switch to it without re-fetching
      if (!existing.error && !existing.isLoading) {
        return
      }
    }

    const currentReqId = ++fileReadRequestIdRef.current
    const requestedWorkspace = rootPathRef.current

    // Add or update tab with loading state
    setTabs((prev) => {
      const idx = prev.findIndex((t) => arePathsEqual(t.path, canonicalPath, requestedWorkspace))
      if (idx !== -1) {
        const next = [...prev]
        next[idx] = { ...next[idx], isLoading: true, error: null }
        return next
      }
      const newTab: OpenTab = {
        path: canonicalPath,
        name: effectiveName,
        content: '',
        originalContent: '',
        isDirty: false,
        isLoading: true,
        error: null,
        hasExternalChange: false,
        isMissingOnDisk: false
      }
      return [...prev, newTab]
    })
    setActiveFilePath(canonicalPath)
    setStatusMessage(`Loading ${effectiveName}...`)

    try {
      const result = await window.electronAPI.readFile(canonicalPath)

      // Stale response guard: ignore if workspace changed while reading
      if (rootPathRef.current !== requestedWorkspace) {
        return
      }

      if (result.success && result.content !== undefined) {
        setTabs((prev) =>
          prev.map((t) =>
            arePathsEqual(t.path, canonicalPath, requestedWorkspace)
              ? {
                  ...t,
                  content: result.content ?? '',
                  originalContent: result.content ?? '',
                  isLoading: false,
                  error: null
                }
              : t
          )
        )
        // If this request is still the latest file-opening request, set status message
        if (currentReqId === fileReadRequestIdRef.current) {
          setActiveFilePath(canonicalPath)
          setStatusMessage(`Loaded ${effectiveName}`)
        }
      } else {
        const errorMsg = result.error || 'Failed to read file from disk.'
        setTabs((prev) =>
          prev.map((t) =>
            arePathsEqual(t.path, canonicalPath, requestedWorkspace)
              ? {
                  ...t,
                  isLoading: false,
                  error: errorMsg
                }
              : t
          )
        )
        setStatusMessage(`Failed to read file: ${errorMsg}`)
      }
    } catch (err: unknown) {
      if (rootPathRef.current !== requestedWorkspace) return
      const msg = err instanceof Error ? err.message : String(err)
      setTabs((prev) =>
        prev.map((t) =>
          arePathsEqual(t.path, canonicalPath, requestedWorkspace)
            ? {
                ...t,
                isLoading: false,
                error: msg
              }
            : t
        )
      )
      setStatusMessage(`Error reading file: ${msg}`)
    }
  }

  // Immediately close tab and update active tab
  const closeTabImmediately = (filePath: string) => {
    shadowBufferRef.current.remove(filePath, rootPathRef.current)
    setTabs((prevTabs) => {
      const newTabs = prevTabs.filter((t) => !arePathsEqual(t.path, filePath, rootPathRef.current))
      setActiveFilePath((prevActive) => {
        if (prevActive && arePathsEqual(prevActive, filePath, rootPathRef.current)) {
          return newTabs.length > 0 ? newTabs[newTabs.length - 1].path : null
        }
        return prevActive
      })
      return newTabs
    })
  }

  // Close tab with dirty check
  const handleCloseTab = (e: React.MouseEvent, filePath: string) => {
    e.stopPropagation()
    const target = tabs.find((t) => arePathsEqual(t.path, filePath, rootPath))
    if (!target) return

    if (target.isDirty) {
      setDirtyConfirmModal({
        isOpen: true,
        mode: 'close-tab',
        targetTab: target,
        isSaving: false,
        error: null
      })
    } else {
      closeTabImmediately(filePath)
    }
  }

  // Save specific tab content to disk
  const saveTabContent = async (
    tab: OpenTab,
    explicitContent?: string
  ): Promise<{ success: boolean; error?: string }> => {
    const contentToSave = explicitContent !== undefined ? explicitContent : tab.content
    recordSelfMutation(tab.path)
    try {
      const result = await window.electronAPI.writeFile(tab.path, contentToSave)
      if (result.success) {
        setTabs((prev) =>
          prev.map((t) => {
            if (arePathsEqual(t.path, tab.path, rootPathRef.current)) {
              return {
                ...t,
                content: contentToSave,
                originalContent: contentToSave,
                isDirty: false,
                hasExternalChange: false,
                externalContent: undefined,
                isMissingOnDisk: false
              }
            }
            return t
          })
        )
        return { success: true }
      } else {
        return { success: false, error: result.error || 'Failed to save file' }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return { success: false, error: msg }
    }
  }

  // Modal confirm handlers
  const handleConfirmCancel = () => {
    if (dirtyConfirmModal.isSaving) return
    setDirtyConfirmModal({
      isOpen: false,
      mode: 'close-tab',
      isSaving: false,
      error: null
    })
  }

  const handleConfirmDontSave = async () => {
    if (dirtyConfirmModal.isSaving) return

    if (dirtyConfirmModal.mode === 'close-tab') {
      const targetPath = dirtyConfirmModal.targetTab?.path
      setDirtyConfirmModal({
        isOpen: false,
        mode: 'close-tab',
        isSaving: false,
        error: null
      })
      if (targetPath) {
        closeTabImmediately(targetPath)
      }
    } else if (dirtyConfirmModal.mode === 'switch-workspace') {
      setDirtyConfirmModal({
        isOpen: false,
        mode: 'close-tab',
        isSaving: false,
        error: null
      })
      await performOpenFolderDialog()
    }
  }

  const handleConfirmSave = async () => {
    if (dirtyConfirmModal.isSaving) return

    if (dirtyConfirmModal.mode === 'close-tab') {
      const targetTab = dirtyConfirmModal.targetTab
      if (!targetTab) return

      setDirtyConfirmModal((prev) => ({ ...prev, isSaving: true, error: null }))
      const result = await saveTabContent(targetTab)

      if (result.success) {
        setDirtyConfirmModal({
          isOpen: false,
          mode: 'close-tab',
          isSaving: false,
          error: null
        })
        closeTabImmediately(targetTab.path)
        setStatusMessage(`Saved and closed ${targetTab.name}`)
      } else {
        setDirtyConfirmModal((prev) => ({
          ...prev,
          isSaving: false,
          error: result.error || 'Failed to save file before closing.'
        }))
        setStatusMessage(`Save failed: ${result.error}`)
      }
    } else if (dirtyConfirmModal.mode === 'switch-workspace') {
      const dirtyTabs = dirtyConfirmModal.dirtyTabs || tabs.filter((t) => t.isDirty)
      if (dirtyTabs.length === 0) {
        setDirtyConfirmModal({
          isOpen: false,
          mode: 'close-tab',
          isSaving: false,
          error: null
        })
        await performOpenFolderDialog()
        return
      }

      setDirtyConfirmModal((prev) => ({ ...prev, isSaving: true, error: null }))
      let failure: { file: string; error?: string } | null = null

      for (const tab of dirtyTabs) {
        const res = await saveTabContent(tab)
        if (!res.success) {
          failure = { file: tab.name, error: res.error }
          break
        }
      }

      if (failure) {
        setDirtyConfirmModal((prev) => ({
          ...prev,
          isSaving: false,
          error: `Failed to save ${failure.file}: ${failure.error || 'Unknown error'}. Workspace switch aborted.`
        }))
        setStatusMessage(`Save failed for ${failure.file}`)
      } else {
        setDirtyConfirmModal({
          isOpen: false,
          mode: 'close-tab',
          isSaving: false,
          error: null
        })
        setStatusMessage('All changes saved.')
        await performOpenFolderDialog()
      }
    }
  }

  // Escape key handler for dirty confirmation modal
  React.useEffect(() => {
    const handleModalKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (dirtyConfirmModal.isOpen && !dirtyConfirmModal.isSaving) {
          handleConfirmCancel()
        } else if (pendingShadowApproval) {
          pendingShadowApproval.resolve(false)
        }
      }
    }
    window.addEventListener('keydown', handleModalKeyDown)
    return () => window.removeEventListener('keydown', handleModalKeyDown)
  }, [dirtyConfirmModal.isOpen, dirtyConfirmModal.isSaving, pendingShadowApproval])

  // Change content in editor
  const handleContentChange = (newContent: string) => {
    if (!activeFilePath) return

    setTabs((prev) =>
      prev.map((t) => {
        if (arePathsEqual(t.path, activeFilePath, rootPath)) {
          return {
            ...t,
            content: newContent,
            isDirty: newContent !== t.originalContent
          }
        }
        return t
      })
    )
  }

  // Save changes to disk
  const handleSaveFile = async (explicitContent?: string) => {
    const currentActiveTab = tabs.find((t) => arePathsEqual(t.path, activeFilePath, rootPath))
    if (!currentActiveTab || isSaving) return

    setIsSaving(true)
    setStatusMessage(`Saving ${currentActiveTab.name}...`)

    try {
      const result = await saveTabContent(currentActiveTab, explicitContent)
      if (result.success) {
        setStatusMessage(`Saved ${currentActiveTab.name}`)
        refreshGitStatus()
      } else {
        setStatusMessage(`Failed to save: ${result.error || 'Unknown error'}`)
      }
    } finally {
      setIsSaving(false)
    }
  }

  // Global keyboard shortcuts (Ctrl+S, Ctrl+Shift+E, Ctrl+Shift+G)
  React.useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      // Sidebar switching shortcuts
      if ((e.ctrlKey || e.metaKey) && e.shiftKey) {
        if (e.key === 'E' || e.key === 'e') {
          e.preventDefault()
          setActiveSidebarView('explorer')
          return
        }
        if (e.key === 'G' || e.key === 'g') {
          e.preventDefault()
          setActiveSidebarView('source-control')
          return
        }
      }

      // Save active file
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 's' || e.key === 'S')) {
        e.preventDefault()
        handleSaveFile()
      }
    }
    window.addEventListener('keydown', handleGlobalKeyDown)
    return () => window.removeEventListener('keydown', handleGlobalKeyDown)
  }, [tabs, activeFilePath, isSaving])

  return (
    <div className="app-container">
      {/* Top Header Bar */}
      <header className="header-bar">
        <div className="header-left">
          <div className="app-logo-badge">
            <Code2 size={15} className="app-logo-icon" />
          </div>
          <div className="app-title-group">
            <span className="app-title">AI IDE</span>
            <span className="app-version-pill">PRO</span>
          </div>
        </div>

        {/* Center Workspace Project Pill */}
        <div className="header-center">
          {projectName ? (
            <div className="workspace-pill" title={rootPath || ''}>
              <Layers size={12} className="workspace-pill-icon" />
              <span className="workspace-pill-text">{projectName}</span>
            </div>
          ) : (
            <div className="workspace-pill empty">
              <span>No Workspace Opened</span>
            </div>
          )}
        </div>

        {/* Right Action Buttons */}
        <div className="header-actions">
          <button className="btn btn-secondary btn-header" onClick={handleOpenFolderDialog} title="Open Workspace Folder">
            <FolderOpen size={13} />
            <span>Open Folder</span>
          </button>
          <button
            className={`btn ${activeTab?.isDirty ? 'btn-primary' : 'btn-secondary'} btn-header`}
            onClick={() => handleSaveFile()}
            disabled={!activeTab || !activeTab.isDirty || isSaving}
            title="Save Active File (Ctrl+S)"
          >
            <Save size={13} />
            <span>{isSaving ? 'Saving...' : activeTab?.isDirty ? 'Save (Ctrl+S)' : 'Saved'}</span>
          </button>
          <button
            className={`btn ${isTerminalOpen ? 'btn-active-toggle' : 'btn-secondary'} btn-header`}
            onClick={() => setIsTerminalOpen(!isTerminalOpen)}
            title="Toggle Integrated Terminal"
          >
            <TerminalIcon size={13} className={isTerminalOpen ? 'active-sparkle' : ''} />
            <span>Terminal</span>
          </button>
          <button
            className={`btn ${isAIPanelOpen ? 'btn-active-toggle' : 'btn-secondary'} btn-header`}
            onClick={() => setIsAIPanelOpen(!isAIPanelOpen)}
            title="Toggle AI Assistant Panel"
          >
            <Sparkles size={13} className={isAIPanelOpen ? 'active-sparkle' : ''} />
            <span>AI Assistant</span>
          </button>
        </div>
      </header>

      {/* Main Body */}
      <div className="workspace-body">
        {/* Activity Bar */}
        <nav className="activity-bar" aria-label="Activity Bar">
          <div className="activity-bar-items">
            <button
              type="button"
              className={`activity-bar-btn ${activeSidebarView === 'explorer' ? 'active' : ''}`}
              onClick={() => setActiveSidebarView('explorer')}
              title="Explorer (Ctrl+Shift+E)"
              aria-label="Explorer"
            >
              <Files size={18} />
            </button>
            <button
              type="button"
              className={`activity-bar-btn ${activeSidebarView === 'source-control' ? 'active' : ''}`}
              onClick={() => setActiveSidebarView('source-control')}
              title="Source Control (Ctrl+Shift+G)"
              aria-label="Source Control"
            >
              <GitBranch size={18} />
              {gitChangeCount > 0 && (
                <span className="activity-bar-badge" title={`${gitChangeCount} pending change(s)`}>
                  {gitChangeCount > 99 ? '99+' : gitChangeCount}
                </span>
              )}
            </button>
          </div>
        </nav>

        {/* Primary Sidebar Panel */}
        {activeSidebarView === 'explorer' ? (
          <FileExplorer
            rootPath={rootPath}
            tree={tree}
            activeFilePath={activeFilePath}
            onOpenFile={handleOpenFile}
            onOpenFolderDialog={handleOpenFolderDialog}
            onRefresh={handleRefreshTree}
            onPathRenamed={handlePathRenamed}
            onPathDeleted={handlePathDeleted}
            onStatusMessage={setStatusMessage}
          />
        ) : (
          <SourceControl
            rootPath={rootPath}
            onStatusMessage={setStatusMessage}
            onGitStatusUpdated={handleGitStatusUpdated}
            onOpenFileDiff={handleOpenFileDiff}
            activeDiffPath={activeDiff?.filePath || null}
            activeDiffStaged={activeDiff?.staged || false}
            hasUnsavedChanges={tabs.some((t) => t.isDirty)}
            dirtyTabNames={tabs.filter((t) => t.isDirty).map((t) => t.name)}
            refreshTrigger={gitRefreshCounter}
          />
        )}

        {/* Editor Container */}
        <div className="editor-container">
          {/* Tabs Bar */}
          {(tabs.length > 0 || activeDiff) && (
            <div className="editor-tabs">
              {tabs.map((tab) => {
                const isActive = arePathsEqual(tab.path, activeFilePath, rootPath) && !activeDiff
                return (
                  <div
                    key={tab.path}
                    className={`editor-tab ${isActive ? 'active' : ''} ${tab.isMissingOnDisk ? 'missing' : ''}`}
                    onClick={() => {
                      setActiveDiff(null)
                      setActiveFilePath(tab.path)
                    }}
                    title={tab.path}
                  >
                    <span className="tab-icon">{getTabFileIcon(tab.name)}</span>
                    <span className="tab-title">
                      {tab.name}
                      {tab.isMissingOnDisk && <span className="tab-missing-tag"> [deleted]</span>}
                    </span>
                    {tab.hasExternalChange && (
                      <span className="tab-external-indicator" title="File modified externally">
                        <AlertTriangle size={11} color="#f59e0b" />
                      </span>
                    )}
                    {tab.isDirty && <span className="tab-dirty-indicator" title="Unsaved changes" />}
                    {shadowBufferRef.current.isDirty(tab.path, rootPath) && (
                      <span className="tab-ai-indicator" title="AI shadow edits staged" data-testid="tab-ai-indicator">
                        <Sparkles size={11} color="#38bdf8" />
                      </span>
                    )}
                    <button
                      className="tab-close-btn"
                      onClick={(e) => handleCloseTab(e, tab.path)}
                      title="Close Tab"
                      type="button"
                    >
                      <X size={11} />
                    </button>
                  </div>
                )
              })}

              {/* Active Git Diff Tab */}
              {activeDiff && (
                <div
                  className="editor-tab active diff-tab"
                  title={`${activeDiff.filePath} (${activeDiff.staged ? 'Index' : 'Working Tree'})`}
                  data-testid="editor-diff-tab"
                >
                  <span className="tab-icon">
                    <GitCompare size={12} color="#38bdf8" />
                  </span>
                  <span className="tab-title">
                    {activeDiff.filePath.split(/[\\/]/).pop()} ({activeDiff.staged ? 'Index' : 'Working Tree'})
                  </span>
                  <button
                    className="tab-close-btn"
                    onClick={(e) => {
                      e.stopPropagation()
                      handleCloseDiff()
                    }}
                    title="Close Diff (Esc)"
                    aria-label="Close Diff Tab"
                    type="button"
                  >
                    <X size={11} />
                  </button>
                </div>
              )}
            </div>
          )}

          {/* External Change Warning Banner */}
          {activeTab?.hasExternalChange && !activeDiff && (
            <div className="external-change-banner">
              <div className="external-change-info">
                <AlertTriangle size={14} style={{ color: '#f59e0b', flexShrink: 0 }} />
                <span>
                  <strong>External changes detected:</strong> This file was modified outside the editor.
                </span>
              </div>
              <div className="external-change-actions">
                <button
                  type="button"
                  className="btn btn-secondary btn-xs"
                  onClick={() => handleDismissExternalChange(activeTab.path)}
                  title="Keep your current unsaved edits in memory"
                >
                  Keep Local Edits
                </button>
                <button
                  type="button"
                  className="btn btn-primary btn-xs"
                  onClick={() => handleReloadExternalChange(activeTab.path)}
                  title="Reload external version from disk and overwrite local edits"
                >
                  Reload From Disk
                </button>
              </div>
            </div>
          )}

          {/* Missing on Disk Banner */}
          {activeTab?.isMissingOnDisk && !activeDiff && (
            <div className="external-change-banner missing">
              <div className="external-change-info">
                <AlertTriangle size={14} style={{ color: '#f87171', flexShrink: 0 }} />
                <span>
                  <strong>File missing on disk:</strong> This file was deleted or moved externally.
                </span>
              </div>
              <div className="external-change-actions">
                <button
                  type="button"
                  className="btn btn-primary btn-xs"
                  onClick={() => handleSaveFile()}
                  title="Save buffer and recreate file on disk"
                >
                  Recreate & Save
                </button>
              </div>
            </div>
          )}

          {/* Multi-file AI Checkpoint Review Banner */}
          {dirtyShadowFiles.length > 1 && !activeDiff && (
            <div className="multi-file-checkpoint-banner" data-testid="multi-file-checkpoint-banner">
              <div className="multi-file-checkpoint-info">
                <Sparkles size={14} color="#38bdf8" />
                <span className="multi-file-checkpoint-title">
                  AI Changes: {dirtyShadowFiles.length} files
                </span>
                <div className="multi-file-checkpoint-file-list">
                  {dirtyShadowFiles.map((f) => {
                    const fname = f.split(/[\\/]/).pop() || f
                    const isCurrent = arePathsEqual(f, activeFilePath, rootPath)
                    return (
                      <button
                        key={f}
                        type="button"
                        className={`multi-file-badge ${isCurrent ? 'active' : ''}`}
                        onClick={() => handleOpenFile(f)}
                        title={`Click to review ${f}`}
                        data-testid={`checkpoint-file-badge-${fname}`}
                      >
                        {fname}
                      </button>
                    )
                  })}
                </div>
              </div>
              <div className="multi-file-checkpoint-actions">
                <button
                  type="button"
                  className="btn btn-secondary btn-xs"
                  onClick={handleDiscardAllCheckpoints}
                  data-testid="checkpoint-discard-all-btn"
                >
                  Discard All
                </button>
                <button
                  type="button"
                  className="btn btn-primary btn-xs"
                  onClick={handleApplyAllCheckpoints}
                  data-testid="checkpoint-apply-all-btn"
                >
                  Apply All ({dirtyShadowFiles.length})
                </button>
              </div>
            </div>
          )}

          {/* Monaco Diff Viewer, Monaco Editor Pane, or Empty State */}
          {activeDiff ? (
            <DiffViewer
              filePath={activeDiff.filePath}
              staged={activeDiff.staged}
              originalContent={activeDiff.originalContent}
              modifiedContent={activeDiff.modifiedContent}
              rawDiff={activeDiff.rawDiff}
              isBinary={activeDiff.isBinary}
              isLoading={activeDiff.isLoading}
              error={activeDiff.error}
              truncated={activeDiff.truncated}
              hasStagedChanges={activeDiff.hasStagedChanges}
              hasUnstagedChanges={activeDiff.hasUnstagedChanges}
              onToggleMode={handleToggleDiffMode}
              onRefresh={handleRefreshActiveDiff}
              onClose={handleCloseDiff}
            />
          ) : activeTab ? (
            activeTab.isLoading ? (
              <div className="editor-loading-state" data-testid="editor-loading-state">
                <Loader2 size={24} className="spinning" color="#38bdf8" />
                <p className="editor-loading-text">Loading {activeTab.name}...</p>
              </div>
            ) : activeTab.error ? (
              <div className="editor-error-state" data-testid="editor-error-state">
                <div className="editor-error-icon-wrap">
                  <AlertCircle size={28} color="#f87171" />
                </div>
                <h3>Failed to open {activeTab.name}</h3>
                <p className="editor-error-message">{activeTab.error}</p>
                <div className="editor-error-actions">
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => handleOpenFile(activeTab.path, activeTab.name)}
                    title="Retry reading file"
                  >
                    <RefreshCw size={13} />
                    <span>Retry</span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={(e) => handleCloseTab(e, activeTab.path)}
                    title="Close Tab"
                  >
                    <X size={13} />
                    <span>Close Tab</span>
                  </button>
                </div>
              </div>
            ) : (
              <EditorPane
                key={activeTab.path}
                filePath={activeTab.path}
                content={activeTab.content}
                onChange={handleContentChange}
                onSave={handleSaveFile}
                onCursorChange={(info) => {
                  editorPositionRef.current = info
                }}
                shadowDiff={
                  (() => {
                    const snap = shadowBufferRef.current.getSnapshot(activeTab.path, rootPath)
                    return snap && snap.dirty
                      ? {
                          originalContent: snap.originalContent,
                          shadowContent: snap.shadowContent,
                          revision: snap.revision,
                          dirty: snap.dirty,
                          isConflicted: snap.isConflicted,
                          conflictReason: snap.conflictReason
                        }
                      : null
                  })()
                }
                multiFileDiffInfo={
                  dirtyShadowFiles.length > 1
                    ? {
                        dirtyFileCount: dirtyShadowFiles.length,
                        dirtyFiles: dirtyShadowFiles,
                        onApplyAll: handleApplyAllCheckpoints,
                        onDiscardAll: handleDiscardAllCheckpoints
                      }
                    : null
                }
                onAcceptShadowDiff={() => handleAcceptShadowDiff(activeTab.path)}
                onRejectShadowDiff={() => handleRejectShadowDiff(activeTab.path)}
              />
            )
          ) : (
            <div className="editor-empty">
              <div className="editor-empty-card">
                <div className="editor-empty-icon-wrap">
                  <Bot size={36} color="#38bdf8" />
                </div>
                <h3>AI IDE</h3>
                <p className="editor-empty-lead">
                  {activeSidebarView === 'source-control'
                    ? 'Select a changed file in Source Control to inspect its Git diff.'
                    : 'Open a file from the explorer or open a workspace to start coding.'}
                </p>
                <div className="editor-empty-shortcuts">
                  <div className="shortcut-row">
                    <span className="shortcut-key">Ctrl + S</span>
                    <span className="shortcut-label">Save Active File</span>
                  </div>
                  <div className="shortcut-row">
                    <span className="shortcut-key">Enter</span>
                    <span className="shortcut-label">Submit AI Prompt</span>
                  </div>
                  <div className="shortcut-row">
                    <span className="shortcut-key">Shift + Enter</span>
                    <span className="shortcut-label">New Line in Chat</span>
                  </div>
                </div>
                {!rootPath && (
                  <button className="btn btn-primary btn-sm" onClick={handleOpenFolderDialog}>
                    <FolderOpen size={13} />
                    <span>Open Workspace</span>
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Integrated Terminal Panel */}
          <Terminal
            workspaceRoot={rootPath}
            isOpen={isTerminalOpen}
            onClose={() => setIsTerminalOpen(false)}
            entries={terminalEntries}
            onClear={handleClearTerminal}
            onRunCommand={handleRunTerminalCommand}
            onStopCommand={handleStopTerminalCommand}
            isRunning={isTerminalRunning}
            activeSessionId={activeTerminalSessionId}
            onSendInput={handleSendTerminalInput}
            tabs={terminalTabs}
            activeTabId={activeTerminalTabId}
            onSelectTab={handleSelectTerminalTab}
            onNewTab={handleNewTerminalTab}
            onCloseTab={handleCloseTerminalTab}
            onUpdateInputBuffer={handleUpdateTerminalInputBuffer}
          />
        </div>

        {/* AI Chat Panel */}
        {isAIPanelOpen && (
          <AIChatPanel
            workspaceRoot={rootPath}
            currentBranch={gitBranch}
            activeEditorContext={() =>
              activeFilePath
                ? {
                    filePath: activeFilePath,
                    cursorLine: editorPositionRef.current.cursorLine,
                    cursorColumn: editorPositionRef.current.cursorColumn,
                    visibleRange: editorPositionRef.current.visibleRange
                  }
                : null
            }
            onFileCreated={handleFileCreated}
            onFileEdited={handleFileEdited}
            onCommandExecuted={handleAICommandExecuted}
            onClose={() => setIsAIPanelOpen(false)}
            shadowBuffer={shadowBufferRef.current}
            onShadowUpdated={handleShadowUpdated}
          />
        )}
      </div>

      {/* Bottom Status Bar */}
      <footer className="status-bar">
        <div className="status-left">
          <div className="status-pill">
            {activeTab?.isDirty ? (
              <AlertCircle size={11} color="#f59e0b" />
            ) : (
              <CheckCircle2 size={11} color="#10b981" />
            )}
            <span className="status-text">{statusMessage}</span>
          </div>
          {gitBranch && (
            <div className="status-pill git-branch-pill" title={`Git Branch: ${gitBranch}`}>
              <GitBranch size={11} color="#60a5fa" />
              <span className="status-text" style={{ color: '#93c5fd', fontWeight: 500 }}>
                {gitBranch}
              </span>
            </div>
          )}
        </div>
        <div className="status-right">
          {activeTab && (
            <>
              <span className="status-item file-path-item" title={activeTab.path}>
                {activeTab.name}
              </span>
              <span className="status-badge">
                {activeTab.path.split('.').pop()?.toUpperCase() || 'PLAIN'}
              </span>
              <span className="status-item">UTF-8</span>
            </>
          )}
          <span className="status-item provider-status">
            <span className="status-dot online" />
            <span>AI Ready</span>
          </span>
        </div>
      </footer>

      {/* Dirty Tab / Workspace Switch Confirmation Modal */}
      {dirtyConfirmModal.isOpen && (
        <div className="explorer-modal-backdrop" onClick={handleConfirmCancel}>
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
                <span>
                  {dirtyConfirmModal.mode === 'close-tab'
                    ? 'Unsaved Changes'
                    : 'Unsaved Changes in Workspace'}
                </span>
              </div>
              <button
                type="button"
                className="explorer-modal-close-btn"
                onClick={handleConfirmCancel}
                disabled={dirtyConfirmModal.isSaving}
                title="Cancel"
              >
                <X size={14} />
              </button>
            </div>

            <div className="explorer-modal-body">
              {dirtyConfirmModal.mode === 'close-tab' ? (
                <div className="explorer-modal-message">
                  <p>
                    Do you want to save the changes you made to{' '}
                    <strong>{dirtyConfirmModal.targetTab?.name}</strong>?
                  </p>
                  <p style={{ marginTop: '6px', fontSize: '11.5px', color: 'var(--text-muted)' }}>
                    Your changes will be lost if you don't save them.
                  </p>
                </div>
              ) : (
                <div>
                  <div className="explorer-modal-message">
                    <p>The following files have unsaved changes:</p>
                  </div>
                  <div className="dirty-tabs-list">
                    {(dirtyConfirmModal.dirtyTabs || []).map((t) => (
                      <div key={t.path} className="dirty-tab-item" title={t.path}>
                        <span className="dirty-dot" />
                        <span style={{ fontWeight: 500 }}>{t.name}</span>
                        <span style={{ fontSize: '10.5px', color: 'var(--text-muted)', marginLeft: 'auto' }}>
                          {t.path}
                        </span>
                      </div>
                    ))}
                  </div>
                  <p style={{ fontSize: '11.5px', color: 'var(--text-muted)', marginTop: '8px' }}>
                    Do you want to save these changes before opening a new workspace?
                  </p>
                </div>
              )}

              {dirtyConfirmModal.error && (
                <div className="explorer-modal-error">
                  {dirtyConfirmModal.error}
                </div>
              )}
            </div>

            <div className="explorer-modal-footer">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={handleConfirmCancel}
                disabled={dirtyConfirmModal.isSaving}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={handleConfirmDontSave}
                disabled={dirtyConfirmModal.isSaving}
                style={{ color: '#f87171' }}
              >
                Don't Save
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={handleConfirmSave}
                disabled={dirtyConfirmModal.isSaving}
              >
                {dirtyConfirmModal.isSaving
                  ? 'Saving...'
                  : dirtyConfirmModal.mode === 'close-tab'
                    ? 'Save'
                    : 'Save All'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* AI Shadow Diff Approval Modal */}
      {pendingShadowApproval && (
        <div
          className="explorer-modal-backdrop"
          onClick={() => pendingShadowApproval.resolve(false)}
          data-testid="shadow-approval-modal-backdrop"
        >
          <div
            className="explorer-modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            style={{ maxWidth: '460px' }}
            data-testid="shadow-approval-modal"
          >
            <div className="explorer-modal-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Sparkles size={15} color="#38bdf8" />
                <span>Confirm AI File Changes</span>
              </div>
              <button
                type="button"
                className="explorer-modal-close-btn"
                onClick={() => pendingShadowApproval.resolve(false)}
                title="Cancel"
                aria-label="Close"
              >
                <X size={14} />
              </button>
            </div>

            <div className="explorer-modal-body">
              {pendingShadowApproval.files ? (
                <div className="explorer-modal-message">
                  <p>
                    Apply staged AI changes across{' '}
                    <strong>{pendingShadowApproval.files.length} files</strong>?
                  </p>
                  <div className="multi-file-approval-list" style={{ marginTop: '8px', maxHeight: '160px', overflowY: 'auto' }}>
                    {pendingShadowApproval.files.map((f) => (
                      <div key={f.path} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', padding: '3px 0' }}>
                        <span className="dirty-dot" style={{ background: '#38bdf8', width: '6px', height: '6px', borderRadius: '50%' }} />
                        <strong>{f.name}</strong>
                        <span style={{ fontSize: '10.5px', color: 'var(--text-muted)', marginLeft: 'auto' }}>
                          {f.path}
                        </span>
                      </div>
                    ))}
                  </div>
                  <p style={{ marginTop: '8px', fontSize: '11.5px', color: 'var(--text-muted)' }}>
                    This will perform an atomic preflight check and commit all changes transactionally.
                  </p>
                </div>
              ) : (
                <div className="explorer-modal-message">
                  <p>
                    Apply staged AI changes to <strong>{pendingShadowApproval.fileName}</strong>?
                  </p>
                  <p style={{ marginTop: '6px', fontSize: '11.5px', color: 'var(--text-muted)' }}>
                    This will commit the in-memory shadow edits directly to the physical workspace file on disk.
                  </p>
                </div>
              )}
            </div>

            <div className="explorer-modal-footer">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => pendingShadowApproval.resolve(false)}
                data-testid="cancel-shadow-approval-btn"
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => pendingShadowApproval.resolve(true)}
                data-testid="confirm-shadow-approval-btn"
              >
                {pendingShadowApproval.files
                  ? `Apply All (${pendingShadowApproval.files.length})`
                  : 'Apply Changes'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
