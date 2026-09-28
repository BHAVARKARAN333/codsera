import React, { useState } from 'react'
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
  RefreshCw,
  Folders
} from 'lucide-react'
import { FileEntry } from '../../../shared/types'

interface FileExplorerProps {
  rootPath: string | null
  tree: FileEntry[]
  activeFilePath: string | null
  onOpenFile: (filePath: string, fileName: string) => void
  onOpenFolderDialog: () => void
  onRefresh?: () => void
}

interface TreeNodeProps {
  entry: FileEntry
  depth: number
  activeFilePath: string | null
  onOpenFile: (filePath: string, fileName: string) => void
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
  onOpenFile
}) => {
  const [isOpen, setIsOpen] = useState(false)

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (entry.isDirectory) {
      setIsOpen(!isOpen)
    } else {
      onOpenFile(entry.path, entry.name)
    }
  }

  const isSelected = activeFilePath === entry.path

  return (
    <div className="tree-node-group">
      <div
        className={`tree-node ${isSelected ? 'active' : ''}`}
        style={{ paddingLeft: `${depth * 14 + 10}px` }}
        onClick={handleClick}
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
              onOpenFile={onOpenFile}
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
  onRefresh
}) => {
  const [isRefreshing, setIsRefreshing] = useState(false)
  const folderName = rootPath ? rootPath.split(/[\\/]/).pop() || 'Workspace' : 'No Folder Open'

  const handleRefresh = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!onRefresh || isRefreshing) return
    setIsRefreshing(true)
    await onRefresh()
    setTimeout(() => setIsRefreshing(false), 400)
  }

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-header-title" title={rootPath || undefined}>
          <Folders size={13} className="sidebar-header-icon" />
          <span>{folderName}</span>
        </div>
        <div className="sidebar-header-actions">
          {rootPath && onRefresh && (
            <button
              className={`sidebar-icon-btn ${isRefreshing ? 'spin' : ''}`}
              onClick={handleRefresh}
              title="Refresh Explorer"
              type="button"
            >
              <RefreshCw size={12} />
            </button>
          )}
          <button
            className="sidebar-icon-btn"
            onClick={onOpenFolderDialog}
            title="Open Folder"
            type="button"
          >
            <FolderPlus size={12} />
          </button>
        </div>
      </div>

      <div className="sidebar-content">
        {!rootPath || tree.length === 0 ? (
          <div className="sidebar-empty">
            <div className="sidebar-empty-icon-wrap">
              <FolderPlus size={24} color="#64748b" />
            </div>
            <p className="sidebar-empty-title">No Folder Opened</p>
            <p className="sidebar-empty-desc">Open a project workspace to inspect files and use AI tools.</p>
            <button className="btn btn-primary btn-sm" onClick={onOpenFolderDialog}>
              <FolderPlus size={13} />
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
                onOpenFile={onOpenFile}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
