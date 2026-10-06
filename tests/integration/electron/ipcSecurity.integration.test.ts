/**
 * IPC Security and Isolation Integration Tests
 *
 * Verifies that the Electron Main Process, Preload API, and IPC handlers enforce
 * strict defense-in-depth security boundaries:
 * 1. Path containment & directory traversal rejection across all filesystem & Git channels.
 * 2. Protection of workspace root directory (cannot delete or rename root).
 * 3. Null byte injection blocking in paths and inputs.
 * 4. Input payload length ceilings and boundary enforcement.
 * 5. Type safety & malformed argument handling.
 * 6. Branch name option-injection defense.
 * 7. Content Security Policy header generation & registration.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import path from 'path'
import { electronHarness, createTestWorkspace } from './harness'

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

import { registerIpcHandlers, setupContentSecurityPolicy, terminalSessionManager } from '../../../src/main/index'
import { api } from '../../../src/preload/index'

describe('7. IPC Security and Isolation Integration', () => {
  let workspace: { rootPath: string; cleanup: () => Promise<void> }

  beforeEach(async () => {
    registerIpcHandlers()
    electronHarness.state.rendererListeners.clear()
    terminalSessionManager.clearAllCompletedSessions()
    workspace = await createTestWorkspace('ai-ide-security-test-')
  })

  afterEach(async () => {
    try {
      await api.terminalKillAll?.()
      terminalSessionManager.clearAllCompletedSessions()
    } catch {}
    await workspace.cleanup()
  })

  it('rejects path traversal attempts across all workspace filesystem channels', async () => {
    const traversalPaths = [
      '../outside.txt',
      '../../secret.key',
      '..\\..\\windows\\system32\\cmd.exe',
      'subfolder/../../escaped.json'
    ]

    for (const badPath of traversalPaths) {
      // 1. readWorkspaceFile
      const readRes = await api.readWorkspaceFile(workspace.rootPath, badPath)
      expect(readRes.success).toBe(false)
      expect(readRes.error).toMatch(/outside the current workspace|invalid/i)

      // 2. createWorkspaceFile
      const createRes = await api.createWorkspaceFile(workspace.rootPath, badPath, 'malicious')
      expect(createRes.success).toBe(false)
      expect(createRes.error).toMatch(/outside the current workspace|invalid/i)

      // 3. editWorkspaceFile
      const editRes = await api.editWorkspaceFile(workspace.rootPath, badPath, 'malicious')
      expect(editRes.success).toBe(false)
      expect(editRes.error).toMatch(/outside the current workspace|invalid/i)

      // 4. deletePath
      const delRes = await api.deletePath(workspace.rootPath, badPath)
      expect(delRes.success).toBe(false)
      expect(delRes.error).toMatch(/outside (the current workspace|the workspace root)|invalid/i)

      // 5. listFiles
      const listRes = await api.listFiles(workspace.rootPath, { relativePath: badPath })
      expect(listRes.success).toBe(false)
      expect(listRes.error).toMatch(/outside (the current workspace|the workspace root)|invalid/i)
    }
  })

  it('rejects path traversal attempts across Git inspection channels', async () => {
    const badGitPaths = ['../config', '../../passwd', '..\\..\\repo']

    for (const badPath of badGitPaths) {
      // gitFileDiff
      const diffRes = await api.gitFileDiff(workspace.rootPath, badPath)
      expect(diffRes.success).toBe(false)
      expect(diffRes.error).toMatch(/outside (the current workspace|the workspace root)|invalid/i)

      // gitDiscardFile
      const discardRes = await api.gitDiscardFile(workspace.rootPath, badPath)
      expect(discardRes.success).toBe(false)
      expect(discardRes.error).toMatch(/outside (the current workspace|the workspace root)|invalid/i)
    }
  })

  it('strictly protects the workspace root directory from deletion, renaming, or wildcard discard', async () => {
    // 1. Attempting to delete the root directory
    const deleteRootRes = await api.deletePath(workspace.rootPath, '.')
    expect(deleteRootRes.success).toBe(false)
    expect(deleteRootRes.error).toMatch(/cannot delete the workspace root directory/i)

    const deleteEmptyRes = await api.deletePath(workspace.rootPath, '')
    expect(deleteEmptyRes.success).toBe(false)
    expect(deleteEmptyRes.error).toMatch(/invalid or missing target path/i)

    // 2. Attempting to rename the root directory
    const renameRootRes = await api.renamePath(workspace.rootPath, '.', 'new-root')
    expect(renameRootRes.success).toBe(false)
    expect(renameRootRes.error).toMatch(/cannot rename the workspace root directory/i)

    // 3. Attempting to discard with wildcard or root
    const discardRootRes = await api.gitDiscardFile(workspace.rootPath, '.')
    expect(discardRootRes.success).toBe(false)
    expect(discardRootRes.error).toMatch(/discarding all files is not permitted/i)

    const discardWildcardRes = await api.gitDiscardFile(workspace.rootPath, '*')
    expect(discardWildcardRes.success).toBe(false)
    expect(discardWildcardRes.error).toMatch(/discarding all files is not permitted/i)
  })

  it('blocks null byte injections across paths and terminal input', async () => {
    // 1. Filesystem null byte injection
    const nullByteFileRes = await api.readWorkspaceFile(workspace.rootPath, 'note.txt\0.exe')
    expect(nullByteFileRes.success).toBe(false)
    expect(nullByteFileRes.error).toMatch(/invalid/i)

    const nullByteWriteRes = await api.writeFile(
      path.join(workspace.rootPath, 'evil\0.js'),
      'console.log(1)'
    )
    expect(nullByteWriteRes.success).toBe(false)
    expect(nullByteWriteRes.error).toMatch(/invalid/i)

    // 2. Terminal input null byte injection
    const nullInputRes = await api.terminalWriteInput!('any-session', 'bad\0input')
    expect(nullInputRes.success).toBe(false)
    expect(nullInputRes.error).toMatch(/null byte/i)
  })

  it('enforces payload length limits on terminal inputs and commands', async () => {
    // 1. Oversized command (> 32KB)
    const giantCommand = 'echo ' + 'X'.repeat(33000)
    const giantSpawnRes = await api.terminalSpawn!({
      sessionId: 'session-oversized-cmd',
      command: giantCommand,
      cwd: workspace.rootPath,
      workspaceRoot: workspace.rootPath
    })
    expect(giantSpawnRes.success).toBe(false)
    expect(giantSpawnRes.error).toMatch(/32KB|invalid/i)

    // 2. Oversized stdin input (> 64KB)
    const giantInput = 'Y'.repeat(70000)
    const giantWriteRes = await api.terminalWriteInput!('any-session', giantInput)
    expect(giantWriteRes.success).toBe(false)
    expect(giantWriteRes.error).toMatch(/64KB|maximum permitted length/i)
  })

  it('safely handles invalid argument types and malformed payloads without crashing', async () => {
    // Passing non-string arguments to readFile
    const badReadRes = await api.readFile(null as any)
    expect(badReadRes.success).toBe(false)
    expect(badReadRes.error).toMatch(/invalid|missing/i)

    // Passing numbers as workspace roots
    const badRootRes = await api.readWorkspaceFile(12345 as any, 'file.txt')
    expect(badRootRes.success).toBe(false)
    expect(badRootRes.error).toMatch(/invalid|no workspace folder/i)

    // Git branch create with flag injection
    const flagInjectionRes = await api.gitBranchCreate(workspace.rootPath, '--help')
    expect(flagInjectionRes.success).toBe(false)
    expect(flagInjectionRes.error).toMatch(/branch name|hyphen/i)

    const optionInjectionRes = await api.gitBranchCreate(workspace.rootPath, '-b malicious')
    expect(optionInjectionRes.success).toBe(false)
    expect(optionInjectionRes.error).toMatch(/branch name|hyphen/i)

    // Discard file with undefined path
    const undefDiscardRes = await api.gitDiscardFile(workspace.rootPath, undefined as any)
    expect(undefDiscardRes.success).toBe(false)
    expect(undefDiscardRes.error).toMatch(/invalid|missing/i)
  })

  it('configures Content Security Policy with strict source isolation', () => {
    setupContentSecurityPolicy()

    const cb = electronHarness.getHeaderReceivedCallback()
    expect(cb).toBeTypeOf('function')

    let modifiedHeaders: Record<string, string[]> = {}
    cb(
      { responseHeaders: { 'X-Custom-Header': ['TestValue'] } },
      (result: { responseHeaders: Record<string, string[]> }) => {
        modifiedHeaders = result.responseHeaders
      }
    )

    expect(modifiedHeaders['Content-Security-Policy']).toBeDefined()
    const csp = modifiedHeaders['Content-Security-Policy'][0]

    // Verify vital directives exist
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("script-src 'self'")
    expect(csp).toContain("object-src 'none'")
  })
})
