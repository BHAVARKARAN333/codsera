import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import path from 'path'
import fs from 'fs/promises'
import os from 'os'

const { mockSafeStorage, mockApp } = vi.hoisted(() => ({
  mockSafeStorage: {
    isEncryptionAvailable: vi.fn().mockReturnValue(true),
    encryptString: vi.fn((str: string) => Buffer.from(`cipher_${str}`, 'utf-8')),
    decryptString: vi.fn((buf: Buffer) => {
      const str = buf.toString('utf-8')
      return str.startsWith('cipher_') ? str.slice(7) : str
    })
  },
  mockApp: {
    getPath: vi.fn()
  }
}))

vi.mock('electron', () => ({
  safeStorage: mockSafeStorage,
  app: mockApp
}))

import {
  atomicWriteFile,
  renameWithRetry,
  loadSettings,
  saveSettings,
  cleanupOrphanSettingsTempFiles,
  setSettingsPathResolver,
  resetSettingsQueueForTesting
} from '../../src/main/settingsPersistence'
import { ENCRYPTED_PREFIX } from '../../src/main/safeStorage'

describe('Atomic Settings Persistence Unit Tests', () => {
  let tempDir: string
  let settingsFile: string

  beforeEach(async () => {
    vi.clearAllMocks()
    mockSafeStorage.isEncryptionAvailable.mockReturnValue(true)
    mockSafeStorage.encryptString.mockImplementation((str: string) =>
      Buffer.from(`cipher_${str}`, 'utf-8')
    )
    mockSafeStorage.decryptString.mockImplementation((buf: Buffer) => {
      const str = buf.toString('utf-8')
      return str.startsWith('cipher_') ? str.slice(7) : str
    })

    resetSettingsQueueForTesting()

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'settings-persist-test-'))
    settingsFile = path.join(tempDir, 'settings.json')
    mockApp.getPath.mockReturnValue(tempDir)
    setSettingsPathResolver(() => settingsFile)
  })

  afterEach(async () => {
    setSettingsPathResolver(null)
    resetSettingsQueueForTesting()
    try {
      await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch {
      // Ignore cleanup error
    }
  })

  describe('1. Successful Writes and Formatting', () => {
    it('creates settings.json with formatted JSON and cleans up any temp files', async () => {
      await saveSettings({
        selectedProvider: 'openrouter',
        nvidiaModelId: 'meta/llama3-70b-instruct'
      })

      // Destination file should exist
      const fileExists = await fs.access(settingsFile).then(() => true, () => false)
      expect(fileExists).toBe(true)

      // Raw content should be formatted JSON with indentation
      const rawContent = await fs.readFile(settingsFile, 'utf-8')
      expect(rawContent).toContain('  "selectedProvider": "openrouter"')
      expect(rawContent).toContain('  "nvidiaModelId": "meta/llama3-70b-instruct"')

      // Verify no temporary files were left behind
      const dirFiles = await fs.readdir(tempDir)
      const tempFiles = dirFiles.filter((f) => f.startsWith('.settings.') && f.endsWith('.tmp'))
      expect(tempFiles).toHaveLength(0)

      // Load settings should read it back accurately
      const loaded = await loadSettings()
      expect(loaded.selectedProvider).toBe('openrouter')
      expect(loaded.nvidiaModelId).toBe('meta/llama3-70b-instruct')
    })

    it('atomicWriteFile directly writes and syncs file to disk atomically', async () => {
      const target = path.join(tempDir, 'direct-atomic.json')
      await atomicWriteFile(target, JSON.stringify({ direct: true }, null, 2))
      const content = await fs.readFile(target, 'utf-8')
      expect(JSON.parse(content)).toEqual({ direct: true })
    })
  })

  describe('2. Write Failure Resilience & Temp File Cleanup', () => {
    it('cleans up temp file and preserves existing valid settings when writeFile fails', async () => {
      // 1. Establish an initial valid settings file
      await saveSettings({
        selectedProvider: 'gemini',
        geminiApiKey: 'initial-gemini-key'
      })

      const originalRaw = await fs.readFile(settingsFile, 'utf-8')

      // 2. Mock fs.open to return a handle whose writeFile throws ENOSPC
      const realOpen = fs.open.bind(fs)
      const openSpy = vi.spyOn(fs, 'open').mockImplementation(async (targetPath, flags) => {
        const handle = await realOpen(targetPath, flags)
        if (typeof targetPath === 'string' && targetPath.includes('.settings.')) {
          vi.spyOn(handle, 'writeFile').mockRejectedValue(new Error('ENOSPC: no space left on device'))
        }
        return handle
      })

      // 3. Attempt to save new settings
      await expect(
        saveSettings({ selectedProvider: 'nvidia' })
      ).rejects.toThrow(/ENOSPC/)

      openSpy.mockRestore()

      // 4. Assert no temp files were leaked
      const dirFiles = await fs.readdir(tempDir)
      const tempFiles = dirFiles.filter((f) => f.startsWith('.settings.') && f.endsWith('.tmp'))
      expect(tempFiles).toHaveLength(0)

      // 5. Assert the original settings file was preserved intact
      const afterRaw = await fs.readFile(settingsFile, 'utf-8')
      expect(afterRaw).toBe(originalRaw)

      const loaded = await loadSettings()
      expect(loaded.selectedProvider).toBe('gemini')
      expect(loaded.geminiApiKey).toBe('initial-gemini-key')
    })
  })

  describe('3. Replacement Failure Resilience & Preservation of Previous File', () => {
    it('cleans up temp file and preserves previous valid settings when rename fails permanently', async () => {
      // 1. Establish initial valid settings
      await saveSettings({
        selectedProvider: 'opencode',
        opencodeModelId: 'deepseek-coder'
      })

      const initialRaw = await fs.readFile(settingsFile, 'utf-8')

      // 2. Mock fs.rename to permanently fail with EPERM
      const renameSpy = vi.spyOn(fs, 'rename').mockRejectedValue(
        Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
      )

      // 3. Attempt save
      await expect(
        saveSettings({ selectedProvider: 'nvidia' })
      ).rejects.toThrow(/EPERM/)

      renameSpy.mockRestore()

      // 4. Assert temp file was deleted
      const dirFiles = await fs.readdir(tempDir)
      const tempFiles = dirFiles.filter((f) => f.startsWith('.settings.') && f.endsWith('.tmp'))
      expect(tempFiles).toHaveLength(0)

      // 5. Assert existing valid settings file was NOT corrupted or altered
      const preservedRaw = await fs.readFile(settingsFile, 'utf-8')
      expect(preservedRaw).toBe(initialRaw)

      const loaded = await loadSettings()
      expect(loaded.selectedProvider).toBe('opencode')
      expect(loaded.opencodeModelId).toBe('deepseek-coder')
    })
  })

  describe('4. Windows Transient Lock Retry Recovery', () => {
    it('recovers from transient Windows EBUSY/EPERM lock on rename and completes write', async () => {
      const realRename = fs.rename.bind(fs)
      let renameAttempts = 0

      const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (src, dest) => {
        renameAttempts++
        if (renameAttempts === 1) {
          // Transient lock simulation
          const err = Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
          throw err
        }
        return await realRename(src, dest)
      })

      await saveSettings({ selectedProvider: 'nvidia' })

      expect(renameAttempts).toBe(2)
      renameSpy.mockRestore()

      const loaded = await loadSettings()
      expect(loaded.selectedProvider).toBe('nvidia')
    })

    it('renameWithRetry throws after exceeding maxRetries on persistent transient error', async () => {
      let attempts = 0
      const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async () => {
        attempts++
        throw Object.assign(new Error('EBUSY: resource locked'), { code: 'EBUSY' })
      })

      await expect(
        renameWithRetry('dummy-src', 'dummy-dest', 3, 5)
      ).rejects.toThrow(/EBUSY/)

      expect(attempts).toBe(3)
      renameSpy.mockRestore()
    })
  })

  describe('5. Concurrent & Repeated Saves Serialization', () => {
    it('serializes concurrent save operations without temp file collision or lost updates', async () => {
      // Trigger 5 concurrent partial updates
      const p1 = saveSettings({ selectedProvider: 'nvidia' })
      const p2 = saveSettings({ nvidiaModelId: 'meta/llama3-70b-instruct' })
      const p3 = saveSettings({ lastWorkspaceRoot: 'C:/Test/Workspace' })
      const p4 = saveSettings({ geminiApiKey: 'gemini-secret-token' })
      const p5 = saveSettings({ opencodeModelId: 'claude-3-5-sonnet' })

      await Promise.all([p1, p2, p3, p4, p5])

      // Verify no temporary files remain
      const dirFiles = await fs.readdir(tempDir)
      const tempFiles = dirFiles.filter((f) => f.startsWith('.settings.') && f.endsWith('.tmp'))
      expect(tempFiles).toHaveLength(0)

      // Verify all partial updates were safely merged without overwriting each other
      const finalSettings = await loadSettings()
      expect(finalSettings.selectedProvider).toBe('nvidia')
      expect(finalSettings.nvidiaModelId).toBe('meta/llama3-70b-instruct')
      expect(finalSettings.lastWorkspaceRoot).toBe('C:/Test/Workspace')
      expect(finalSettings.geminiApiKey).toBe('gemini-secret-token')
      expect(finalSettings.opencodeModelId).toBe('claude-3-5-sonnet')
    })

    it('subsequent queued saves continue even if an earlier save fails', async () => {
      const realOpen = fs.open.bind(fs)
      let shouldFail = true

      const openSpy = vi.spyOn(fs, 'open').mockImplementation(async (targetPath, flags) => {
        const handle = await realOpen(targetPath, flags)
        if (shouldFail && typeof targetPath === 'string' && targetPath.includes('.settings.')) {
          shouldFail = false // only fail the first write
          vi.spyOn(handle, 'writeFile').mockRejectedValue(new Error('Simulated write crash'))
        }
        return handle
      })

      const pFail = saveSettings({ selectedProvider: 'openrouter' })
      const pSuccess = saveSettings({ selectedProvider: 'gemini' })

      await expect(pFail).rejects.toThrow('Simulated write crash')
      await expect(pSuccess).resolves.toBeUndefined()

      openSpy.mockRestore()

      const loaded = await loadSettings()
      expect(loaded.selectedProvider).toBe('gemini')
    })
  })

  describe('6. SafeStorage Encryption and Legacy Plaintext Migration', () => {
    it('encrypts API keys using safeStorage when writing to disk and decrypts on load', async () => {
      await saveSettings({
        geminiApiKey: 'secret-gemini-key',
        openRouterApiKey: 'secret-openrouter-key',
        nvidiaApiKey: 'secret-nvidia-key',
        opencodeApiKey: 'secret-opencode-key'
      })

      // Raw content in file should have ENCRYPTED_PREFIX for all secret fields
      const raw = await fs.readFile(settingsFile, 'utf-8')
      const parsed = JSON.parse(raw)

      expect(parsed.geminiApiKey.startsWith(ENCRYPTED_PREFIX)).toBe(true)
      expect(parsed.openRouterApiKey.startsWith(ENCRYPTED_PREFIX)).toBe(true)
      expect(parsed.nvidiaApiKey.startsWith(ENCRYPTED_PREFIX)).toBe(true)
      expect(parsed.opencodeApiKey.startsWith(ENCRYPTED_PREFIX)).toBe(true)

      // Plaintext should NOT appear anywhere in the raw file
      expect(raw).not.toContain('secret-gemini-key')
      expect(raw).not.toContain('secret-openrouter-key')

      // loadSettings should decrypt them seamlessly
      const loaded = await loadSettings()
      expect(loaded.geminiApiKey).toBe('secret-gemini-key')
      expect(loaded.openRouterApiKey).toBe('secret-openrouter-key')
      expect(loaded.nvidiaApiKey).toBe('secret-nvidia-key')
      expect(loaded.opencodeApiKey).toBe('secret-opencode-key')
    })

    it('reads legacy plaintext keys transparently and re-encrypts them on next save', async () => {
      // Simulate existing legacy settings.json with unencrypted plaintext keys
      const legacySettings = {
        selectedProvider: 'openrouter',
        openRouterApiKey: 'legacy-plaintext-key-12345'
      }
      await fs.writeFile(settingsFile, JSON.stringify(legacySettings, null, 2), 'utf-8')

      // 1. loadSettings should read the legacy key transparently
      const loadedLegacy = await loadSettings()
      expect(loadedLegacy.openRouterApiKey).toBe('legacy-plaintext-key-12345')

      // 2. Saving another setting should trigger encryption of the legacy key
      await saveSettings({ selectedProvider: 'gemini' })

      const rawAfterMigration = await fs.readFile(settingsFile, 'utf-8')
      const parsedAfter = JSON.parse(rawAfterMigration)

      expect(parsedAfter.selectedProvider).toBe('gemini')
      expect(parsedAfter.openRouterApiKey.startsWith(ENCRYPTED_PREFIX)).toBe(true)
      expect(rawAfterMigration).not.toContain('legacy-plaintext-key-12345')

      // 3. Subsequent load should still yield the decrypted key
      const finalLoaded = await loadSettings()
      expect(finalLoaded.openRouterApiKey).toBe('legacy-plaintext-key-12345')
    })
  })

  describe('7. Corrupted Settings File Fallback & Automatic Repair', () => {
    it('returns empty object when settings.json has invalid JSON syntax and repairs it on save', async () => {
      await fs.writeFile(settingsFile, '{ INVALID_JSON_DATA %%% 999', 'utf-8')

      // loadSettings should return {} without throwing
      const loaded = await loadSettings()
      expect(loaded).toEqual({})

      // Subsequent saveSettings should repair the file with valid JSON
      await saveSettings({ selectedProvider: 'opencode' })

      const raw = await fs.readFile(settingsFile, 'utf-8')
      const parsed = JSON.parse(raw)
      expect(parsed.selectedProvider).toBe('opencode')
    })
  })

  describe('8. Orphan Temporary Files Cleanup', () => {
    it('cleans up orphaned .settings.*.tmp files while leaving other files intact', async () => {
      // Create some orphan temp files
      const orphan1 = path.join(tempDir, '.settings.1234.1111.abc.tmp')
      const orphan2 = path.join(tempDir, '.settings.5678.2222.xyz.tmp')
      const normalFile = path.join(tempDir, 'settings.json')
      const otherFile = path.join(tempDir, 'other-file.txt')

      await fs.writeFile(orphan1, 'orphan data 1')
      await fs.writeFile(orphan2, 'orphan data 2')
      await fs.writeFile(normalFile, '{"valid": true}')
      await fs.writeFile(otherFile, 'other content')

      const cleanedCount = await cleanupOrphanSettingsTempFiles(tempDir)
      expect(cleanedCount).toBe(2)

      const remainingFiles = await fs.readdir(tempDir)
      expect(remainingFiles).toContain('settings.json')
      expect(remainingFiles).toContain('other-file.txt')
      expect(remainingFiles).not.toContain('.settings.1234.1111.abc.tmp')
      expect(remainingFiles).not.toContain('.settings.5678.2222.xyz.tmp')
    })
  })
})
