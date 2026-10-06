/**
 * Electron E2E Testing Harness & Lifecycle Helper
 *
 * Provides isolated, leak-free launch and teardown of the built Electron application
 * using Playwright's native Electron automation API.
 */

import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import path from 'path'
import os from 'os'
import fs from 'fs/promises'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export interface LaunchedAppInstance {
  app: ElectronApplication
  window: Page
  userDataDir: string
  cleanup: () => Promise<void>
}

export interface LaunchOptions {
  workspacePath?: string
  initialSettings?: Record<string, any>
  userDataDir?: string
  preserveUserDataDir?: boolean
  executablePath?: string
}

/**
 * Creates an isolated temporary workspace directory for E2E tests.
 */
export async function createE2EWorkspace(
  files?: Record<string, string>,
  prefix = 'ai-ide-e2e-ws-'
): Promise<{ rootPath: string; cleanup: () => Promise<void> }> {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), prefix))

  if (files) {
    for (const [relativePath, content] of Object.entries(files)) {
      const fullPath = path.join(rootPath, relativePath)
      await fs.mkdir(path.dirname(fullPath), { recursive: true })
      await fs.writeFile(fullPath, content, 'utf-8')
    }
  }

  const cleanup = async () => {
    try {
      await fs.rm(rootPath, { recursive: true, force: true })
    } catch {
      // Retry after short delay for Windows handle release
      await new Promise((r) => setTimeout(r, 150))
      try {
        await fs.rm(rootPath, { recursive: true, force: true })
      } catch {
        // Ignore residual cleanup error on persistent busy lock
      }
    }
  }

  return { rootPath, cleanup }
}

/**
 * Creates an isolated temporary Git repository for E2E tests.
 */
export async function createE2EGitWorkspace(
  files?: Record<string, string>,
  initialCommit = true,
  prefix = 'ai-ide-e2e-git-'
): Promise<{ rootPath: string; cleanup: () => Promise<void> }> {
  const ws = await createE2EWorkspace(files, prefix)
  await execFileAsync('git', ['init'], { cwd: ws.rootPath })
  await execFileAsync('git', ['config', 'user.name', 'E2E Test Runner'], { cwd: ws.rootPath })
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: ws.rootPath })
  await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: ws.rootPath })

  if (initialCommit && files && Object.keys(files).length > 0) {
    await execFileAsync('git', ['add', '.'], { cwd: ws.rootPath })
    await execFileAsync('git', ['commit', '-m', 'Initial commit'], { cwd: ws.rootPath })
  }

  return ws
}

/**
 * Launches the built Electron application with an isolated profile and optional test workspace.
 */
export async function launchElectronApp(options: LaunchOptions = {}): Promise<LaunchedAppInstance> {
  const userDataDir = options.userDataDir || (await fs.mkdtemp(path.join(os.tmpdir(), 'ai-ide-e2e-user-')))

  // Pre-configure settings if requested (e.g. restoring lastWorkspaceRoot)
  const settings: Record<string, any> = { ...(options.initialSettings || {}) }
  if (options.workspacePath) {
    settings.lastWorkspaceRoot = options.workspacePath
  }

  if (Object.keys(settings).length > 0) {
    const settingsPath = path.join(userDataDir, 'settings.json')
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8')
  }

  const launchArgs = options.executablePath
    ? [`--user-data-dir=${userDataDir}`, '--no-sandbox']
    : ['.', `--user-data-dir=${userDataDir}`]

  const app = await electron.launch({
    executablePath: options.executablePath,
    args: launchArgs,
    cwd: options.executablePath ? path.dirname(options.executablePath) : process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      // Explicit credential isolation: prevent developer environment secrets from leaking into tests
      GEMINI_API_KEY: '',
      OPENROUTER_API_KEY: '',
      NVIDIA_NIM_API_KEY: '',
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: ''
    },
    timeout: 25000
  })

  let isCleanedUp = false

  const cleanup = async () => {
    if (isCleanedUp) return
    isCleanedUp = true

    try {
      await app.close()
    } catch {
      // Forcibly kill process if close hangs or fails
      try {
        const proc = app.process()
        if (proc && proc.pid) {
          process.kill(proc.pid)
        }
      } catch {}
    }

    // Small delay for OS process handles to release
    await new Promise((r) => setTimeout(r, 200))

    if (!options.preserveUserDataDir) {
      try {
        await fs.rm(userDataDir, { recursive: true, force: true })
      } catch {
        await new Promise((r) => setTimeout(r, 150))
        try {
          await fs.rm(userDataDir, { recursive: true, force: true })
        } catch {}
      }
    }
  }

  try {
    const window = await app.firstWindow({ timeout: 25000 })
    await window.waitForLoadState('domcontentloaded')
    return { app, window, userDataDir, cleanup }
  } catch (err) {
    await cleanup()
    throw err
  }
}

/**
 * Launches the packaged Electron application executable from dist/win-unpacked/
 */
export async function launchPackagedElectronApp(
  options: Omit<LaunchOptions, 'executablePath'> = {}
): Promise<LaunchedAppInstance> {
  const executablePath = path.resolve(__dirname, '../../../dist/win-unpacked/AI IDE.exe')
  return launchElectronApp({ ...options, executablePath })
}
