import { describe, it, expect } from 'vitest'
import * as fsSync from 'fs'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { spawn } from 'child_process'

const projectRoot = path.resolve(__dirname, '../..')
const pkg = JSON.parse(fsSync.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8'))
const unpackedDir = path.join(projectRoot, 'dist', 'win-unpacked')
const executablePath = path.join(unpackedDir, 'AI IDE.exe')
const asarPath = path.join(unpackedDir, 'resources', 'app.asar')
const setupInstallerPath = path.join(projectRoot, 'dist', `AI IDE-Setup-${pkg.version}.exe`)

const hasPackagedBinary = fsSync.existsSync(executablePath)

describe.skipIf(!hasPackagedBinary)('Packaged Application Smoke Test', () => {

  it('verifies packaged artifacts exist with non-zero size', async () => {
    const exeStat = await fs.stat(executablePath)
    expect(exeStat.isFile()).toBe(true)
    expect(exeStat.size).toBeGreaterThan(10 * 1024 * 1024) // > 10MB

    const asarStat = await fs.stat(asarPath)
    expect(asarStat.isFile()).toBe(true)
    expect(asarStat.size).toBeGreaterThan(50 * 1024 * 1024) // > 50MB

    const installerStat = await fs.stat(setupInstallerPath)
    expect(installerStat.isFile()).toBe(true)
    expect(installerStat.size).toBeGreaterThan(50 * 1024 * 1024) // > 50MB
  })

  it('launches packaged AI IDE executable and shuts down cleanly', async () => {
    const tempUserData = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-ide-smoke-userdata-'))

    let childExited = false

    // Spawn the packaged executable with isolated user data directory
    const child = spawn(executablePath, [`--user-data-dir=${tempUserData}`, '--no-sandbox'], {
      cwd: unpackedDir,
      stdio: 'ignore',
      detached: false
    })

    expect(child.pid).toBeDefined()
    expect(typeof child.pid).toBe('number')

    child.on('exit', () => {
      childExited = true
    })

    // Allow application 3 seconds to boot up and initialize main process, single instance lock, etc.
    await new Promise((resolve) => setTimeout(resolve, 3000))

    // Ensure it did not crash prematurely
    expect(childExited).toBe(false)

    // Gracefully terminate the process
    child.kill('SIGTERM')

    // Wait for exit
    await new Promise<void>((resolve) => {
      if (childExited) {
        resolve()
      } else {
        child.on('exit', () => resolve())
        setTimeout(() => {
          try {
            child.kill('SIGKILL')
          } catch {}
          resolve()
        }, 3000)
      }
    })

    // Clean up temporary user data directory
    try {
      await fs.rm(tempUserData, { recursive: true, force: true })
    } catch {
      // Windows lock retry
      await new Promise((r) => setTimeout(r, 200))
      try {
        await fs.rm(tempUserData, { recursive: true, force: true })
      } catch {}
    }
  }, 15000)
})
