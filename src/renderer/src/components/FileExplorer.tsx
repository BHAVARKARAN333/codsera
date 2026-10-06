import React, { useState, useEffect, useRef, useCallback } from 'react'
import {
  Folder,
  FolderOpen,
  FileCode,
  FileText,
  FileJson,
  FileType,
  Image as ImageIcon,
  ChevronRight,
  ChevronDown,
  FolderPlus,
  FilePlus,
  RefreshCw,
  Folders,
  Trash2,
  Edit2,
  Copy,
  X,
  AlertTriangle
} from 'lucide-react'
import { FileEntry } from '../../../shared/types'
import { arePathsEqual, normalizeFilePath } from '../../../shared/pathUtils'

interface FileExplorerProps {
  rootPath: string | null
  tree: FileEntry[]
  activeFilePath: string | null
  onOpenFile: (filePath: string, fileName: string) => void
  onOpenFolderDialog: () => void
  onRefresh?: () => void
  onPathRenamed?: (oldPath: string, newPath: string, isDirectory: boolean) => void
  onPathDeleted?: (deletedPath: string, isDirectory: boolean) => void
  onStatusMessage?: (message: string) => void
}

interface TreeNodeProps {
  entry: FileEntry
  depth: number
  activeFilePath: string | null
  selectedPath: string | null
  expandedPaths: Set<string>
  onToggleExpand: (path: string) => void
  onOpenFile: (filePath: string, fileName: string) => void
  onSelectNode: (entry: FileEntry) => void
  onContextMenu: (e: React.MouseEvent, entry: FileEntry) => void
  rootPath?: string | null
}

type ModalType = 'create-file' | 'create-folder' | 'rename' | 'delete' | null

interface ModalState {
  type: ModalType
  targetEntry: FileEntry | null
  targetFolder: string
  inputValue: string
  error: string | null
  isSubmitting: boolean
}

interface ContextMenuState {
  visible: boolean
  x: number
  y: number
  targetEntry: FileEntry | null
}

function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, '/')
}

function pathBasename(p: string): string {
  const norm = normalizeSlashes(p).replace(/\/+$/, '')
  return norm.split('/').pop() || ''
}

function pathDirname(p: string): string {
  const norm = normalizeSlashes(p).replace(/\/+$/, '')
  const lastSlash = norm.lastIndexOf('/')
  if (lastSlash === -1) return ''
  return norm.slice(0, lastSlash)
}

function getRelativePath(root: string, target: string): string {
  const normRoot = normalizeSlashes(root).replace(/\/+$/, '').toLowerCase()
  const normTarget = normalizeSlashes(target).replace(/\/+$/, '')
  const normTargetLower = normTarget.toLowerCase()

  if (normTargetLower === normRoot) return ''
  if (normTargetLower.startsWith(normRoot + '/')) {
    return normTarget.slice(normRoot.length + 1)
  }
  return normTarget.replace(/^[/\\]+/, '')
}

function getFileIcon(fileName: string) {
  const ext = fileName.split('.').pop()?.toLowerCase() || ''
  switch (ext) {
    case 'ts':
    case 'tsx':
      return <FileCode size={14} color="#60a5fa" />
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return <FileCode size={14} color="#facc15" />
    case 'json':
      return <FileJson size={14} color="#fb923c" />
    case 'css':
    case 'scss':
    case 'less':
      return <FileType size={14} color="#c084fc" />
    case 'html':
    case 'svg':
      return <FileCode size={14} color="#f97316" />
    case 'md':
    case 'markdown':
    case 'txt':
      return <FileText size={14} color="#38bdf8" />
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'ico':
    case 'webp':
      return <ImageIcon size={14} color="#a78bfa" />
    case 'py':
      return <FileCode size={14} color="#38bdf8" />
    case 'rs':
    case 'go':
    case 'java':
    case 'c':
    case 'cpp':
      return <FileCode size={14} color="#f43f5e" />
    default:
      return <FileText size={14} color="#94a3b8" />
  }
}

const TreeNode: React.FC<TreeNodeProps> = ({
  entry,
  depth,
  activeFilePath,
  selectedPath,
  expandedPaths,
  onToggleExpand,
  onOpenFile,
  onSelectNode,
  onContextMenu,
  rootPath
}) => {
  const normPath = normalizeSlashes(entry.path).toLowerCase()
  const isOpen = expandedPaths.has(normPath)

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    onSelectNode(entry)
    if (entry.isDirectory) {
      onToggleExpand(entry.path)
    } else {
      onOpenFile(entry.path, entry.name)
    }
  }

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    onSelectNode(entry)
    onContextMenu(e, entry)
  }

  const isSelected =
    arePathsEqual(selectedPath, entry.path, rootPath) ||
    arePathsEqual(activeFilePath, entry.path, rootPath)

  return (
    <div className="tree-node-group">
      <div
        className={`tree-node ${isSelected ? 'active' : ''}`}
        style={{ paddingLeft: `${depth * 14 + 10}px` }}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        title={entry.path}
      >
        <span className="tree-icon">
          {entry.isDirectory ? (
            <>
              <span className="chevron-toggle">
                {isOpen ? (
                  <ChevronDown size={13} className="tree-chevron" />
                ) : (
                  <ChevronRight size={13} className="tree-chevron" />
                )}
              </span>
              {isOpen ? (
                <FolderOpen size={14} color="#fbbf24" className="folder-icon" />
              ) : (
                <Folder size={14} color="#f59e0b" className="folder-icon" />
              )}
            </>
          ) : (
            <>
              <span className="file-indent-spacer" />
              {getFileIcon(entry.name)}
            </>
          )}
        </span>
        <span className="tree-name">{entry.name}</span>
      </div>

      {entry.isDirectory && isOpen && entry.children && (
        <div className="tree-children-container">
          {entry.children.map((child) => (
            <TreeNode
              key={child.path}
              entry={child}
              depth={depth + 1}
              activeFilePath={activeFilePath}
              selectedPath={selectedPath}
              expandedPaths={expandedPaths}
              onToggleExpand={onToggleExpand}
              onOpenFile={onOpenFile}
              onSelectNode={onSelectNode}
              onContextMenu={onContextMenu}
              rootPath={rootPath}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export const FileExplorer: React.FC<FileExplorerProps> = ({
  rootPath,
  tree,
  activeFilePath,
  onOpenFile,
  onOpenFolderDialog,
  onRefresh,
  onPathRenamed,
  onPathDeleted,
  onStatusMessage
}) => {
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [selectedEntry, setSelectedEntry] = useState<FileEntry | null>(null)
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set())

  // Reset expanded folders when workspace changes
  useEffect(() => {
    setExpandedPaths(new Set())
    setSelectedEntry(null)
  }, [rootPath])

  const handleToggleExpand = useCallback((folderPath: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev)
      const norm = normalizeSlashes(folderPath).toLowerCase()
      if (next.has(norm)) {
        next.delete(norm)
      } else {
        next.add(norm)
      }
      return next
    })
  }, [])

  // Context Menu State
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    targetEntry: null
  })

  // Modal State for Create / Rename / Delete
  const [modalState, setModalState] = useState<ModalState>({
    type: null,
    targetEntry: null,
    targetFolder: '',
    inputValue: '',
    error: null,
    isSubmitting: false
  })

  const inputRef = useRef<HTMLInputElement | null>(null)
  const contextMenuRef = useRef<HTMLDivElement | null>(null)

  const folderName = rootPath ? pathBasename(rootPath) || 'Workspace' : 'No Folder Open'

  // Close context menu handler
  const closeContextMenu = useCallback(() => {
    setContextMenu((prev) => (prev.visible ? { ...prev, visible: false } : prev))
  }, [])

  // Close modal handler
  const closeModal = useCallback(() => {
    setModalState({
      type: null,
      targetEntry: null,
      targetFolder: '',
      inputValue: '',
      error: null,
      isSubmitting: false
    })
  }, [])

  // Auto-focus input when modal opens
  useEffect(() => {
    if (modalState.type && modalState.type !== 'delete') {
      const timer = setTimeout(() => {
        if (inputRef.current) {
          inputRef.current.focus()
          // For rename, pre-select filename before extension if applicable
          if (modalState.type === 'rename') {
            const val = inputRef.current.value
            const dotIndex = val.lastIndexOf('.')
            if (dotIndex > 0 && !modalState.targetEntry?.isDirectory) {
              inputRef.current.setSelectionRange(0, dotIndex)
            } else {
              inputRef.current.select()
            }
          } else {
            inputRef.current.select()
          }
        }
      }, 50)
      return () => clearTimeout(timer)
    }
  }, [modalState.type, modalState.targetEntry])

  // Global listeners for closing context menu on outside click or escape
  useEffect(() => {
    const handleGlobalClick = (e: MouseEvent) => {
      if (contextMenu.visible && contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        closeContextMenu()
      }
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (contextMenu.visible) {
          closeContextMenu()
        } else if (modalState.type) {
          closeModal()
        }
      }
    }

    window.addEventListener('click', handleGlobalClick)
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('resize', closeContextMenu)

    return () => {
      window.removeEventListener('click', handleGlobalClick)
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('resize', closeContextMenu)
    }
  }, [contextMenu.visible, modalState.type, closeContextMenu, closeModal])

  const handleRefresh = async (e?: React.MouseEvent) => {
    e?.stopPropagation()
    if (!onRefresh || isRefreshing) return
    setIsRefreshing(true)
    await onRefresh()
    setTimeout(() => setIsRefreshing(false), 400)
  }

  // Node selection handler
  const handleSelectNode = (entry: FileEntry) => {
    setSelectedEntry(entry)
  }

  // Context menu on node
  const handleNodeContextMenu = (e: React.MouseEvent, entry: FileEntry) => {
    if (!rootPath) return
    const menuWidth = 180
    const menuHeight = entry.isDirectory ? 210 : 140
    const x = Math.min(e.clientX, window.innerWidth - menuWidth)
    const y = Math.min(e.clientY, window.innerHeight - menuHeight)

    setContextMenu({
      visible: true,
      x: Math.max(10, x),
      y: Math.max(10, y),
      targetEntry: entry
    })
  }

  // Context menu on sidebar empty area (workspace root)
  const handleSidebarContextMenu = (e: React.MouseEvent) => {
    if (!rootPath) return
    // Only trigger if click was directly on background, not on a node
    if ((e.target as HTMLElement).closest('.tree-node')) return

    e.preventDefault()
    const menuWidth = 180
    const menuHeight = 130
    const x = Math.min(e.clientX, window.innerWidth - menuWidth)
    const y = Math.min(e.clientY, window.innerHeight - menuHeight)

    setContextMenu({
      visible: true,
      x: Math.max(10, x),
      y: Math.max(10, y),
      targetEntry: null
    })
  }

  // Determine target directory for file/folder creation
  const getCreationTargetFolder = (explicitTarget?: FileEntry | null): string => {
    if (!rootPath) return ''
    if (explicitTarget) {
      return explicitTarget.isDirectory ? explicitTarget.path : pathDirname(explicitTarget.path) || rootPath
    }
    if (selectedEntry) {
      return selectedEntry.isDirectory ? selectedEntry.path : pathDirname(selectedEntry.path) || rootPath
    }
    return rootPath
  }

  // Trigger Create File modal
  const openCreateFileModal = (target?: FileEntry | null) => {
    closeContextMenu()
    const folder = getCreationTargetFolder(target)
    setModalState({
      type: 'create-file',
      targetEntry: null,
      targetFolder: folder,
      inputValue: '',
      error: null,
      isSubmitting: false
    })
  }

  // Trigger Create Folder modal
  const openCreateFolderModal = (target?: FileEntry | null) => {
    closeContextMenu()
    const folder = getCreationTargetFolder(target)
    setModalState({
      type: 'create-folder',
      targetEntry: null,
      targetFolder: folder,
      inputValue: '',
      error: null,
      isSubmitting: false
    })
  }

  // Trigger Rename modal
  const openRenameModal = (target: FileEntry) => {
    closeContextMenu()
    setModalState({
      type: 'rename',
      targetEntry: target,
      targetFolder: pathDirname(target.path) || rootPath || '',
      inputValue: target.name,
      error: null,
      isSubmitting: false
    })
  }

  // Trigger Delete modal
  const openDeleteModal = (target: FileEntry) => {
    closeContextMenu()
    setModalState({
      type: 'delete',
      targetEntry: target,
      targetFolder: '',
      inputValue: '',
      error: null,
      isSubmitting: false
    })
  }

  // Copy Relative Path to clipboard
  const handleCopyRelativePath = async (entry: FileEntry) => {
    closeContextMenu()
    if (!rootPath) return
    const rel = getRelativePath(rootPath, entry.path) || entry.name
    try {
      await navigator.clipboard.writeText(rel)
      onStatusMessage?.(`Copied relative path: ${rel}`)
    } catch {
      onStatusMessage?.('Failed to copy to clipboard')
    }
  }

  // Header button triggers
  const handleHeaderNewFile = (e: React.MouseEvent) => {
    e.stopPropagation()
    openCreateFileModal()
  }

  const handleHeaderNewFolder = (e: React.MouseEvent) => {
    e.stopPropagation()
    openCreateFolderModal()
  }

  // Validate filename or foldername
  const validateName = (name: string): string | null => {
    const trimmed = name.trim()
    if (!trimmed) {
      return 'Name cannot be empty.'
    }
    if (/[<>:"|?*\0]/.test(trimmed)) {
      return 'Name contains invalid characters: < > : " | ? *'
    }
    return null
  }

  // Modal Submit Handlers
  const handleModalSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!rootPath || modalState.isSubmitting) return

    setModalState((prev) => ({ ...prev, isSubmitting: true, error: null }))

    try {
      if (modalState.type === 'create-file') {
        const validationError = validateName(modalState.inputValue)
        if (validationError) {
          setModalState((prev) => ({ ...prev, error: validationError, isSubmitting: false }))
          return
        }

        const cleanName = modalState.inputValue.trim().replace(/^[/\\]+/, '')
        const folderRel = getRelativePath(rootPath, modalState.targetFolder)
        const fileRel = folderRel ? `${folderRel}/${cleanName}` : cleanName

        const result = await window.electronAPI.createFile(rootPath, fileRel, '')
        if (result.success && result.path) {
          if (modalState.targetFolder) {
            setExpandedPaths((prev) => new Set(prev).add(normalizeSlashes(modalState.targetFolder).toLowerCase()))
          }
          await onRefresh?.()
          const fullCreatedPath = normalizeFilePath(`${rootPath}/${result.path}`, rootPath)
          onOpenFile(fullCreatedPath, pathBasename(result.path))
          onStatusMessage?.(`Created file: ${result.path}`)
          closeModal()
        } else {
          setModalState((prev) => ({
            ...prev,
            error: result.error || 'Failed to create file.',
            isSubmitting: false
          }))
        }
      } else if (modalState.type === 'create-folder') {
        const validationError = validateName(modalState.inputValue)
        if (validationError) {
          setModalState((prev) => ({ ...prev, error: validationError, isSubmitting: false }))
          return
        }

        const cleanName = modalState.inputValue.trim().replace(/^[/\\]+/, '')
        const folderRel = getRelativePath(rootPath, modalState.targetFolder)
        const dirRel = folderRel ? `${folderRel}/${cleanName}` : cleanName

        const result = await window.electronAPI.createDirectory(rootPath, dirRel)
        if (result.success && result.path) {
          if (modalState.targetFolder) {
            setExpandedPaths((prev) => new Set(prev).add(normalizeSlashes(modalState.targetFolder).toLowerCase()))
          }
          await onRefresh?.()
          onStatusMessage?.(`Created directory: ${result.path}`)
          closeModal()
        } else {
          setModalState((prev) => ({
            ...prev,
            error: result.error || 'Failed to create directory.',
            isSubmitting: false
          }))
        }
      } else if (modalState.type === 'rename') {
        const target = modalState.targetEntry
        if (!target) return

        const validationError = validateName(modalState.inputValue)
        if (validationError) {
          setModalState((prev) => ({ ...prev, error: validationError, isSubmitting: false }))
          return
        }

        const cleanNewName = modalState.inputValue.trim()
        if (cleanNewName === target.name) {
          closeModal()
          return
        }

        const oldRel = getRelativePath(rootPath, target.path)
        const parentRel = pathDirname(oldRel)
        const newRel = parentRel ? `${parentRel}/${cleanNewName}` : cleanNewName
        const newFullPath = `${normalizeSlashes(rootPath).replace(/\/+$/, '')}/${newRel}`

        const result = await window.electronAPI.renamePath(rootPath, oldRel, newRel)
        if (result.success) {
          if (target.isDirectory) {
            const normOld = normalizeSlashes(target.path).toLowerCase()
            const normNew = normalizeSlashes(newFullPath).toLowerCase()
            setExpandedPaths((prev) => {
              const next = new Set<string>()
              for (const p of prev) {
                if (p === normOld || p.startsWith(normOld + '/')) {
                  next.add(normNew + p.slice(normOld.length))
                } else {
                  next.add(p)
                }
              }
              return next
            })
          }
          await onRefresh?.()
          onPathRenamed?.(target.path, newFullPath, target.isDirectory)
          onStatusMessage?.(`Renamed: ${target.name} → ${cleanNewName}`)
          closeModal()
        } else {
          setModalState((prev) => ({
            ...prev,
            error: result.error || 'Failed to rename path.',
            isSubmitting: false
          }))
        }
      } else if (modalState.type === 'delete') {
        const target = modalState.targetEntry
        if (!target) return

        const relPath = getRelativePath(rootPath, target.path)
        const result = await window.electronAPI.deletePath(rootPath, relPath, {
          recursive: target.isDirectory
        })

        if (result.success) {
          if (target.isDirectory) {
            const normDeleted = normalizeSlashes(target.path).toLowerCase()
            setExpandedPaths((prev) => {
              const next = new Set<string>()
              for (const p of prev) {
                if (p !== normDeleted && !p.startsWith(normDeleted + '/')) {
                  next.add(p)
                }
              }
              return next
            })
          }
          await onRefresh?.()
          onPathDeleted?.(target.path, target.isDirectory)
          onStatusMessage?.(`Deleted: ${target.name}`)
          closeModal()
        } else {
          setModalState((prev) => ({
            ...prev,
            error: result.error || 'Failed to delete path.',
            isSubmitting: false
          }))
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setModalState((prev) => ({
        ...prev,
        error: `Unexpected error: ${msg}`,
        isSubmitting: false
      }))
    }
  }

  // Display target folder for create modal
  const targetFolderDisplay = rootPath
    ? getRelativePath(rootPath, modalState.targetFolder) || '/'
    : '/'

  return (
    <div className="sidebar" onContextMenu={handleSidebarContextMenu}>
      {/* Sidebar Header */}
      <div className="sidebar-header">
        <div className="sidebar-header-title" title={rootPath || undefined}>
          <Folders size={13} className="sidebar-header-icon" />
          <span>{folderName}</span>
        </div>
        <div className="sidebar-header-actions">
          {rootPath && (
            <>
              <button
                className="sidebar-icon-btn"
                onClick={handleHeaderNewFile}
                title="New File (in selected folder or root)"
                aria-label="New File"
                type="button"
              >
                <FilePlus size={13} />
              </button>
              <button
                className="sidebar-icon-btn"
                onClick={handleHeaderNewFolder}
                title="New Folder (in selected folder or root)"
                aria-label="New Folder"
                type="button"
              >
                <FolderPlus size={13} />
              </button>
              {onRefresh && (
                <button
                  className={`sidebar-icon-btn ${isRefreshing ? 'spin' : ''}`}
                  onClick={() => handleRefresh()}
                  title="Refresh Explorer"
                  aria-label="Refresh Explorer"
                  type="button"
                >
                  <RefreshCw size={12} />
                </button>
              )}
            </>
          )}
          <button
            className="sidebar-icon-btn"
            onClick={onOpenFolderDialog}
            title="Open Workspace Folder"
            aria-label="Open Workspace Folder"
            type="button"
          >
            <FolderOpen size={13} />
          </button>
        </div>
      </div>

      {/* Sidebar Content Tree */}
      <div className="sidebar-content">
        {!rootPath || tree.length === 0 ? (
          <div className="sidebar-empty">
            <div className="sidebar-empty-icon-wrap">
              <FolderPlus size={24} color="#64748b" />
            </div>
            <p className="sidebar-empty-title">No Folder Opened</p>
            <p className="sidebar-empty-desc">Open a project workspace to inspect files and use AI tools.</p>
            <button className="btn btn-primary btn-sm" onClick={onOpenFolderDialog}>
              <FolderOpen size={13} />
              <span>Open Folder</span>
            </button>
          </div>
        ) : (
          <div className="tree-root">
            {tree.map((entry) => (
              <TreeNode
                key={entry.path}
                entry={entry}
                depth={0}
                activeFilePath={activeFilePath}
                selectedPath={selectedEntry?.path || null}
                expandedPaths={expandedPaths}
                onToggleExpand={handleToggleExpand}
                onOpenFile={onOpenFile}
                onSelectNode={handleSelectNode}
                onContextMenu={handleNodeContextMenu}
                rootPath={rootPath}
              />
            ))}
          </div>
        )}
      </div>

      {/* Custom Context Menu */}
      {contextMenu.visible && (
        <div
          ref={contextMenuRef}
          className="explorer-context-menu"
          style={{ top: `${contextMenu.y}px`, left: `${contextMenu.x}px` }}
          onClick={(e) => e.stopPropagation()}
        >
          {contextMenu.targetEntry === null || contextMenu.targetEntry.isDirectory ? (
            <>
              <button
                className="context-menu-item"
                onClick={() => openCreateFileModal(contextMenu.targetEntry)}
                type="button"
              >
                <FilePlus size={13} />
                <span>New File...</span>
              </button>
              <button
                className="context-menu-item"
                onClick={() => openCreateFolderModal(contextMenu.targetEntry)}
                type="button"
              >
                <FolderPlus size={13} />
                <span>New Folder...</span>
              </button>
              <div className="context-menu-separator" />
              {contextMenu.targetEntry && (
                <>
                  <button
                    className="context-menu-item"
                    onClick={() => openRenameModal(contextMenu.targetEntry!)}
                    type="button"
                  >
                    <Edit2 size={13} />
                    <span>Rename...</span>
                  </button>
                  <button
                    className="context-menu-item danger"
                    onClick={() => openDeleteModal(contextMenu.targetEntry!)}
                    type="button"
                  >
                    <Trash2 size={13} />
                    <span>Delete...</span>
                  </button>
                  <div className="context-menu-separator" />
                  <button
                    className="context-menu-item"
                    onClick={() => handleCopyRelativePath(contextMenu.targetEntry!)}
                    type="button"
                  >
                    <Copy size={13} />
                    <span>Copy Relative Path</span>
                  </button>
                </>
              )}
            </>
          ) : (
            <>
              <button
                className="context-menu-item"
                onClick={() => openRenameModal(contextMenu.targetEntry!)}
                type="button"
              >
                <Edit2 size={13} />
                <span>Rename...</span>
              </button>
              <button
                className="context-menu-item danger"
                onClick={() => openDeleteModal(contextMenu.targetEntry!)}
                type="button"
              >
                <Trash2 size={13} />
                <span>Delete...</span>
              </button>
              <div className="context-menu-separator" />
              <button
                className="context-menu-item"
                onClick={() => handleCopyRelativePath(contextMenu.targetEntry!)}
                type="button"
              >
                <Copy size={13} />
                <span>Copy Relative Path</span>
              </button>
            </>
          )}
        </div>
      )}

      {/* CRUD Action Modal Dialog */}
      {modalState.type && (
        <div className="explorer-modal-backdrop" onClick={closeModal}>
          <div className="explorer-modal" onClick={(e) => e.stopPropagation()}>
            <div className="explorer-modal-header">
              <span>
                {modalState.type === 'create-file' && 'New File'}
                {modalState.type === 'create-folder' && 'New Folder'}
                {modalState.type === 'rename' &&
                  `Rename ${modalState.targetEntry?.isDirectory ? 'Folder' : 'File'}`}
                {modalState.type === 'delete' &&
                  `Delete ${modalState.targetEntry?.isDirectory ? 'Folder' : 'File'}`}
              </span>
              <button
                className="explorer-modal-close-btn"
                onClick={closeModal}
                title="Cancel"
                type="button"
              >
                <X size={14} />
              </button>
            </div>

            <form onSubmit={handleModalSubmit}>
              <div className="explorer-modal-body">
                {/* Target folder indication for creation */}
                {(modalState.type === 'create-file' || modalState.type === 'create-folder') && (
                  <div className="explorer-modal-target">
                    <span className="explorer-modal-target-label">Inside:</span>
                    <span>{targetFolderDisplay}</span>
                  </div>
                )}

                {/* Input for create / rename */}
                {modalState.type !== 'delete' ? (
                  <input
                    ref={inputRef}
                    className="explorer-modal-input"
                    type="text"
                    value={modalState.inputValue}
                    onChange={(e) =>
                      setModalState((prev) => ({ ...prev, inputValue: e.target.value, error: null }))
                    }
                    placeholder={
                      modalState.type === 'create-file'
                        ? 'e.g. index.ts or components/Card.tsx'
                        : modalState.type === 'create-folder'
                          ? 'e.g. utils or styles'
                          : 'Enter new name'
                    }
                    disabled={modalState.isSubmitting}
                  />
                ) : (
                  <div className="explorer-modal-message">
                    <p>
                      Are you sure you want to delete{' '}
                      <strong>{modalState.targetEntry?.name}</strong>?
                    </p>
                    {modalState.targetEntry?.isDirectory && (
                      <div className="explorer-modal-warning" style={{ marginTop: '10px' }}>
                        <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: '2px' }} />
                        <span>
                          This folder and all its contents will be permanently deleted from the workspace.
                        </span>
                      </div>
                    )}
                  </div>
                )}

                {/* Inline Error display */}
                {modalState.error && (
                  <div className="explorer-modal-error">
                    {modalState.error}
                  </div>
                )}
              </div>

              <div className="explorer-modal-footer">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={closeModal}
                  disabled={modalState.isSubmitting}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className={`btn ${modalState.type === 'delete' ? 'btn-danger' : 'btn-primary'} btn-sm`}
                  disabled={modalState.isSubmitting}
                >
                  {modalState.isSubmitting ? (
                    'Processing...'
                  ) : modalState.type === 'delete' ? (
                    'Delete'
                  ) : modalState.type === 'rename' ? (
                    'Rename'
                  ) : (
                    'Create'
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
