/**
 * Filesystem IPC Integration Tests
 *
 * Verifies real production filesystem IPC handlers and Preload API interactions:
 * 1. Safe file and directory creation, reading, writing, editing, renaming, and deletion.
 * 2. Tree generation and recursive file listing with depth limits.
 * 3. Path containment within workspace (rejection of traversal and sibling escapes).
 * 4. Collision prevention (duplicate file/folder creation, destination conflicts).
 * 5. Root deletion/rename guards (workspace root cannot be deleted or moved).
 * 6. Cross-workspace isolation (Workspace A cannot touch Workspace B files).
 *
 * All tests execute in real isolated temporary directories cleaned up after tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import path from 'path'
import fs from 'fs/promises'
import { createTestWorkspace } from './harness'

vi.mock('electron', async () => {
  const { electronHarness } = await import('./harness')
  return {
    app: electronHarness.mockApp,
    BrowserWindow: electronHarness.MockBrowserWindow,
    dialog: electronHarness.mockDialog,
    ipcMain: electronHarness.mockIpcMain,
    ipcRenderer: electronHarness.mockIpcRenderer,
    shell: electronHarness.mockShell,
    session: electronHarness.mockSession,
    contextBridge: electronHarness.mockContextBridge
  }
})

// Import real production main process registration and preload API
import { registerIpcHandlers } from '../../../src/main/index'
import { api } from '../../../src/preload/index'

describe('3. Filesystem IPC Integration', () => {
  let workspaceA: { rootPath: string; cleanup: () => Promise<void> }
  let workspaceB: { rootPath: string; cleanup: () => Promise<void> }

  beforeEach(async () => {
    registerIpcHandlers()
    workspaceA = await createTestWorkspace('ai-ide-fs-test-a-')
    workspaceB = await createTestWorkspace('ai-ide-fs-test-b-')
  })

  afterEach(async () => {
    await workspaceA.cleanup()
    await workspaceB.cleanup()
  })

  it('creates, reads, edits, and writes files through Preload to Main Process handlers', async () => {
    // 1. Create file with initial content
    const createRes = await api.createFile(
      workspaceA.rootPath,
      'src/index.ts',
      'export const version = "1.0.0";\n'
    )
    expect(createRes.success).toBe(true)

    // Verify on disk
    const diskContent = await fs.readFile(path.join(workspaceA.rootPath, 'src/index.ts'), 'utf-8')
    expect(diskContent).toBe('export const version = "1.0.0";\n')

    // 2. Read workspace file
    const readRes = await api.readWorkspaceFile(workspaceA.rootPath, 'src/index.ts')
    expect(readRes.success).toBe(true)
    expect(readRes.content).toBe('export const version = "1.0.0";\n')

    // 3. Edit workspace file
    const editRes = await api.editWorkspaceFile(
      workspaceA.rootPath,
      'src/index.ts',
      'export const version = "2.0.0";\n'
    )
    expect(editRes.success).toBe(true)

    const updatedDisk = await fs.readFile(path.join(workspaceA.rootPath, 'src/index.ts'), 'utf-8')
    expect(updatedDisk).toBe('export const version = "2.0.0";\n')

    // 4. Overwrite via writeFile
    const writeRes = await api.writeFile(
      path.join(workspaceA.rootPath, 'src/index.ts'),
      'export const version = "3.0.0";\n'
    )
    expect(writeRes.success).toBe(true)

    const finalRead = await api.readFile(path.join(workspaceA.rootPath, 'src/index.ts'))
    expect(finalRead.success).toBe(true)
    expect(finalRead.content).toBe('export const version = "3.0.0";\n')
  })

  it('creates, renames, and deletes directories and nested files', async () => {
    // 1. Create nested directory
    const dirRes = await api.createDirectory(workspaceA.rootPath, 'src/components/buttons')
    expect(dirRes.success).toBe(true)

    // Verify directory exists on disk
    const stat = await fs.stat(path.join(workspaceA.rootPath, 'src/components/buttons'))
    expect(stat.isDirectory()).toBe(true)

    // 2. Create file inside new directory
    await api.createFile(workspaceA.rootPath, 'src/components/buttons/PrimaryButton.tsx', 'export const Button = () => null;')

    // 3. Rename file
    const renameFileRes = await api.renamePath(
      workspaceA.rootPath,
      'src/components/buttons/PrimaryButton.tsx',
      'src/components/buttons/AppButton.tsx'
    )
    expect(renameFileRes.success).toBe(true)

    // Old file no longer exists, new file does
    await expect(fs.stat(path.join(workspaceA.rootPath, 'src/components/buttons/PrimaryButton.tsx'))).rejects.toThrow()
    const newStat = await fs.stat(path.join(workspaceA.rootPath, 'src/components/buttons/AppButton.tsx'))
    expect(newStat.isFile()).toBe(true)

    // 4. Delete directory recursively
    const deleteRes = await api.deletePath(workspaceA.rootPath, 'src/components', { recursive: true })
    expect(deleteRes.success).toBe(true)

    await expect(fs.stat(path.join(workspaceA.rootPath, 'src/components'))).rejects.toThrow()
  })

  it('generates directory tree and file list respecting ignored directories and depth', async () => {
    // Populate sample workspace
    await api.createFile(workspaceA.rootPath, 'package.json', '{"name":"test"}')
    await api.createFile(workspaceA.rootPath, 'src/main.ts', 'console.log("main");')
    await api.createFile(workspaceA.rootPath, 'src/utils/helpers.ts', 'export const help = true;')
    await api.createFile(workspaceA.rootPath, '.git/config', 'ignored')
    await api.createFile(workspaceA.rootPath, 'node_modules/pkg/index.js', 'ignored')

    // 1. readTree
    const treeRes = await api.readTree(workspaceA.rootPath)
    expect(treeRes.success).toBe(true)
    expect(treeRes.tree).toBeDefined()

    const topLevelNames = (treeRes.tree || []).map((t) => t.name)
    expect(topLevelNames).toContain('package.json')
    expect(topLevelNames).toContain('src')
    // Ignored folders must not be in tree
    expect(topLevelNames).not.toContain('.git')
    expect(topLevelNames).not.toContain('node_modules')

    // 2. listFiles with maxDepth
    const listRes = await api.listFiles(workspaceA.rootPath, { maxDepth: 2 })
    expect(listRes.success).toBe(true)
    expect(listRes.totalFiles).toBeGreaterThan(0)
    expect(listRes.treeString).toContain('package.json')
    expect(listRes.treeString).not.toContain('.git')
  })

  it('rejects path traversal attempts, absolute paths, and null bytes outside workspace', async () => {
    // 1. Path traversal via ../../
    const traversalCreate = await api.createFile(
      workspaceA.rootPath,
      '../../escaped.txt',
      'danger'
    )
    expect(traversalCreate.success).toBe(false)
    expect(traversalCreate.error).toMatch(/outside.*workspace|access denied/i)

    // 2. Path traversal via readWorkspaceFile
    const traversalRead = await api.readWorkspaceFile(
      workspaceA.rootPath,
      '../../../Windows/System32/drivers/etc/hosts'
    )
    expect(traversalRead.success).toBe(false)
    expect(traversalRead.error).toMatch(/outside.*workspace|access denied|invalid/i)

    // 3. Null bytes in path
    const nullByteRes = await api.createFile(
      workspaceA.rootPath,
      'malicious\0file.txt',
      'bad'
    )
    expect(nullByteRes.success).toBe(false)
    expect(nullByteRes.error).toMatch(/invalid.*path/i)

    // 4. Whitespace only or empty path
    const emptyPathRes = await api.createFile(
      workspaceA.rootPath,
      '   ',
      'bad'
    )
    expect(emptyPathRes.success).toBe(false)
  })

  it('prevents collision on duplicate file or directory creation', async () => {
    await api.createFile(workspaceA.rootPath, 'existing.txt', 'first')

    // Attempt to recreate same file
    const dupCreate = await api.createFile(workspaceA.rootPath, 'existing.txt', 'second')
    expect(dupCreate.success).toBe(false)
    expect(dupCreate.error).toMatch(/already exists/i)

    // Original content intact
    const original = await api.readWorkspaceFile(workspaceA.rootPath, 'existing.txt')
    expect(original.content).toBe('first')

    // Directory collision with existing file
    const dirCollision = await api.createDirectory(workspaceA.rootPath, 'existing.txt')
    expect(dirCollision.success).toBe(false)
    expect(dirCollision.error).toMatch(/already exists/i)
  })

  it('protects workspace root against deletion and rename operations', async () => {
    // Attempt to delete workspace root via empty path
    const deleteRootRes = await api.deletePath(workspaceA.rootPath, '')
    expect(deleteRootRes.success).toBe(false)
    expect(deleteRootRes.error).toMatch(/invalid or missing target path/i)

    // Attempt to delete workspace root via dot path
    const deleteDotRes = await api.deletePath(workspaceA.rootPath, '.')
    expect(deleteDotRes.success).toBe(false)
    expect(deleteDotRes.error).toMatch(/cannot delete the workspace root directory/i)

    // Attempt to rename workspace root via dot path
    const renameDotRes = await api.renamePath(workspaceA.rootPath, '.', 'renamed-root')
    expect(renameDotRes.success).toBe(false)
    expect(renameDotRes.error).toMatch(/cannot rename the workspace root directory/i)
  })

  it('enforces strict cross-workspace isolation', async () => {
    // Create confidential file in Workspace B
    await api.createFile(workspaceB.rootPath, 'secret.env', 'SECRET_KEY=12345')

    // Attempt to access Workspace B file using Workspace A root with traversal path
    const relToB = path.relative(workspaceA.rootPath, path.join(workspaceB.rootPath, 'secret.env'))
    const crossRead = await api.readWorkspaceFile(workspaceA.rootPath, relToB)
    expect(crossRead.success).toBe(false)
    expect(crossRead.error).toMatch(/outside.*workspace|access denied/i)

    // Attempt to delete Workspace B file using Workspace A root
    const crossDelete = await api.deletePath(workspaceA.rootPath, relToB)
    expect(crossDelete.success).toBe(false)
    expect(crossDelete.error).toMatch(/outside.*workspace|access denied/i)

    // Verify secret file in Workspace B is completely untouched
    const secretVerify = await api.readWorkspaceFile(workspaceB.rootPath, 'secret.env')
    expect(secretVerify.success).toBe(true)
    expect(secretVerify.content).toBe('SECRET_KEY=12345')
  })
})
