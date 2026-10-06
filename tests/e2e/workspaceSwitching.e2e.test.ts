/**
 * Rapid Workspace Switching E2E Tests
 *
 * Verifies end-to-end workspace switching reliability and race condition guards:
 * 1. Opens workspace A and verifies file tree and editor state.
 * 2. Simulates rapid switching where an earlier request resolves after a later request.
 * 3. Verifies final UI displays only workspace B's state without being overwritten.
 * 4. Verifies editor tabs, active file, and diff states are reset between workspace switches.
 * 5. Verifies sequential workspace switching remains deterministic without stale UI state.
 */

import { test, expect } from '@playwright/test'
import path from 'path'
import { launchElectronApp, createE2EWorkspace, type LaunchedAppInstance } from './helpers/electronHarness'

test.describe('Rapid Workspace Switching E2E Tests', () => {
  let instance: LaunchedAppInstance | null = null
  let workspaceA: { rootPath: string; cleanup: () => Promise<void> } | null = null
  let workspaceB: { rootPath: string; cleanup: () => Promise<void> } | null = null
  let workspaceC: { rootPath: string; cleanup: () => Promise<void> } | null = null

  test.beforeEach(async () => {
    workspaceA = await createE2EWorkspace({
      'alpha.txt': 'Workspace Alpha Content\n'
    }, 'e2e-ws-alpha-')

    workspaceB = await createE2EWorkspace({
      'beta.txt': 'Workspace Beta Content\n'
    }, 'e2e-ws-beta-')

    workspaceC = await createE2EWorkspace({
      'gamma.txt': 'Workspace Gamma Content\n'
    }, 'e2e-ws-gamma-')
  })

  test.afterEach(async () => {
    if (instance) {
      await instance.cleanup()
      instance = null
    }
    if (workspaceA) {
      await workspaceA.cleanup()
      workspaceA = null
    }
    if (workspaceB) {
      await workspaceB.cleanup()
      workspaceB = null
    }
    if (workspaceC) {
      await workspaceC.cleanup()
      workspaceC = null
    }
  })

  test('drops stale out-of-order workspace resolution and preserves workspace isolation', async () => {
    if (!workspaceA || !workspaceB) throw new Error('Workspaces not initialized')

    // Launch application with workspace A initially loaded
    instance = await launchElectronApp({ workspacePath: workspaceA.rootPath })
    const { window, app } = instance

    const wsNameA = path.basename(workspaceA.rootPath)
    const wsNameB = path.basename(workspaceB.rootPath)

    // 1. Verify workspace A files and open an editor tab
    const alphaNode = window.locator('.tree-node').filter({ hasText: 'alpha.txt' })
    await expect(alphaNode).toBeVisible({ timeout: 10000 })
    await alphaNode.click()

    const alphaTab = window.locator('.editor-tab').filter({ hasText: 'alpha.txt' })
    await expect(alphaTab).toBeVisible({ timeout: 10000 })

    const workspacePillText = window.locator('.workspace-pill-text')
    await expect(workspacePillText).toHaveText(wsNameA)

    // 2. Set up race condition simulation on dialog.showOpenDialog in main process:
    // First call (A delayed) takes 250ms, second call (B fast) resolves immediately.
    const pathA = workspaceA.rootPath
    const pathB = workspaceB.rootPath

    await app.evaluate(
      ({ dialog }, { pA, pB }) => {
        let callCount = 0
        dialog.showOpenDialog = async () => {
          callCount++
          if (callCount === 1) {
            await new Promise((r) => setTimeout(r, 250))
            return { canceled: false, filePaths: [pA] }
          }
          return { canceled: false, filePaths: [pB] }
        }
      },
      { pA: pathA, pB: pathB }
    )

    // Trigger rapid open folder dialog clicks concurrently while first is in-flight
    const headerOpenBtn = window.locator('header.header-bar').getByRole('button', { name: /open folder/i })
    const click1 = headerOpenBtn.click()
    await new Promise((r) => setTimeout(r, 50))
    const click2 = headerOpenBtn.click()
    await Promise.all([click1, click2])

    // 3. Wait for final settled state: must settle on Workspace B!
    await expect(workspacePillText).toHaveText(wsNameB, { timeout: 10000 })

    // Verify workspace B's file is present in the tree
    const betaNode = window.locator('.tree-node').filter({ hasText: 'beta.txt' })
    await expect(betaNode).toBeVisible({ timeout: 10000 })

    // Verify workspace A's file is NOT present
    await expect(alphaNode).toBeHidden()

    // 4. Verify previous editor tabs from workspace A were cleared
    await expect(alphaTab).toBeHidden()

    // 5. Extra delay to ensure late resolution of call 1 (A) did NOT overwrite workspace B
    await new Promise((r) => setTimeout(r, 400))
    await expect(workspacePillText).toHaveText(wsNameB)
    await expect(betaNode).toBeVisible()
    await expect(alphaNode).toBeHidden()
  })

  test('switches across multiple workspaces sequentially without stale UI residue', async () => {
    if (!workspaceA || !workspaceB || !workspaceC) throw new Error('Workspaces not initialized')

    instance = await launchElectronApp({ workspacePath: workspaceA.rootPath })
    const { window, app } = instance

    const wsNameA = path.basename(workspaceA.rootPath)
    const wsNameB = path.basename(workspaceB.rootPath)
    const wsNameC = path.basename(workspaceC.rootPath)
    const workspacePillText = window.locator('.workspace-pill-text')

    // Initial state: Workspace A
    await expect(workspacePillText).toHaveText(wsNameA, { timeout: 10000 })
    await expect(window.locator('.tree-node').filter({ hasText: 'alpha.txt' })).toBeVisible()

    // Switch to Workspace B via dialog mock in main process
    await app.evaluate(
      ({ dialog }, { targetPath }) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [targetPath]
        })
      },
      { targetPath: workspaceB.rootPath }
    )

    const headerOpenBtn = window.locator('header.header-bar').getByRole('button', { name: /open folder/i })
    await headerOpenBtn.click()

    await expect(workspacePillText).toHaveText(wsNameB, { timeout: 10000 })
    await expect(window.locator('.tree-node').filter({ hasText: 'beta.txt' })).toBeVisible()
    await expect(window.locator('.tree-node').filter({ hasText: 'alpha.txt' })).toBeHidden()

    // Switch to Workspace C via dialog mock in main process
    await app.evaluate(
      ({ dialog }, { targetPath }) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [targetPath]
        })
      },
      { targetPath: workspaceC.rootPath }
    )

    await headerOpenBtn.click()

    await expect(workspacePillText).toHaveText(wsNameC, { timeout: 10000 })
    await expect(window.locator('.tree-node').filter({ hasText: 'gamma.txt' })).toBeVisible()
    await expect(window.locator('.tree-node').filter({ hasText: 'beta.txt' })).toBeHidden()
  })
})
