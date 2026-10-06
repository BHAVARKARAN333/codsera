import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockSafeStorage } = vi.hoisted(() => ({
  mockSafeStorage: {
    isEncryptionAvailable: vi.fn(),
    encryptString: vi.fn(),
    decryptString: vi.fn()
  }
}))

vi.mock('electron', () => ({
  safeStorage: mockSafeStorage
}))

import {
  isEncryptionAvailable,
  encryptSecret,
  decryptSecret,
  isEncryptedSecret,
  ENCRYPTED_PREFIX
} from '../../src/main/safeStorage'

describe('safeStorage credential security', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('isEncryptionAvailable', () => {
    it('returns true when Electron safeStorage reports encryption is available', () => {
      mockSafeStorage.isEncryptionAvailable.mockReturnValue(true)
      expect(isEncryptionAvailable()).toBe(true)
    })

    it('returns false when Electron safeStorage reports encryption is not available', () => {
      mockSafeStorage.isEncryptionAvailable.mockReturnValue(false)
      expect(isEncryptionAvailable()).toBe(false)
    })

    it('returns false when safeStorage throws', () => {
      mockSafeStorage.isEncryptionAvailable.mockImplementation(() => {
        throw new Error('DPAPI failure')
      })
      expect(isEncryptionAvailable()).toBe(false)
    })
  })

  describe('encryptSecret', () => {
    it('handles falsy or non-string values gracefully', () => {
      expect(encryptSecret('')).toBe('')
      // @ts-expect-error test invalid types
      expect(encryptSecret(null)).toBe('')
      // @ts-expect-error test invalid types
      expect(encryptSecret(undefined)).toBe('')
    })

    it('does not re-encrypt already encrypted secrets', () => {
      const alreadyEncrypted = `${ENCRYPTED_PREFIX}c29tZXNlY3JldA==`
      expect(encryptSecret(alreadyEncrypted)).toBe(alreadyEncrypted)
      expect(mockSafeStorage.encryptString).not.toHaveBeenCalled()
    })

    it('encrypts plaintext when encryption is available', () => {
      mockSafeStorage.isEncryptionAvailable.mockReturnValue(true)
      mockSafeStorage.encryptString.mockImplementation((str: string) => Buffer.from(`cipher_${str}`, 'utf-8'))

      const result = encryptSecret('my-secret-api-key')
      expect(mockSafeStorage.encryptString).toHaveBeenCalledWith('my-secret-api-key')
      expect(result.startsWith(ENCRYPTED_PREFIX)).toBe(true)
      const encoded = result.slice(ENCRYPTED_PREFIX.length)
      expect(Buffer.from(encoded, 'base64').toString('utf-8')).toBe('cipher_my-secret-api-key')
    })

    it('falls back gracefully to plaintext when encryption is unavailable', () => {
      mockSafeStorage.isEncryptionAvailable.mockReturnValue(false)
      const result = encryptSecret('my-fallback-key')
      expect(result).toBe('my-fallback-key')
      expect(mockSafeStorage.encryptString).not.toHaveBeenCalled()
    })

    it('falls back gracefully when encryptString throws an error', () => {
      mockSafeStorage.isEncryptionAvailable.mockReturnValue(true)
      mockSafeStorage.encryptString.mockImplementation(() => {
        throw new Error('Encryption error')
      })
      const result = encryptSecret('my-safe-key')
      expect(result).toBe('my-safe-key')
    })
  })

  describe('decryptSecret', () => {
    it('handles falsy or non-string inputs gracefully', () => {
      expect(decryptSecret('')).toBe('')
      // @ts-expect-error test invalid types
      expect(decryptSecret(null)).toBe('')
      // @ts-expect-error test invalid types
      expect(decryptSecret(undefined)).toBe('')
    })

    it('returns legacy plaintext values unchanged for backward compatibility', () => {
      expect(decryptSecret('legacy-plain-key-12345')).toBe('legacy-plain-key-12345')
      expect(mockSafeStorage.decryptString).not.toHaveBeenCalled()
    })

    it('decrypts encrypted secret when encryption is available', () => {
      mockSafeStorage.isEncryptionAvailable.mockReturnValue(true)
      const cipherBuffer = Buffer.from('ciphertext_bytes', 'utf-8')
      const encrypted = `${ENCRYPTED_PREFIX}${cipherBuffer.toString('base64')}`

      mockSafeStorage.decryptString.mockReturnValue('decrypted-plain-key')

      const result = decryptSecret(encrypted)
      expect(result).toBe('decrypted-plain-key')
      expect(mockSafeStorage.decryptString).toHaveBeenCalledWith(cipherBuffer)
    })

    it('returns empty string if base64 data is empty', () => {
      const result = decryptSecret(ENCRYPTED_PREFIX)
      expect(result).toBe('')
      expect(mockSafeStorage.decryptString).not.toHaveBeenCalled()
    })

    it('returns empty string when decryption is unavailable for encrypted string', () => {
      mockSafeStorage.isEncryptionAvailable.mockReturnValue(false)
      const encrypted = `${ENCRYPTED_PREFIX}c29tZWRhdGE=`
      const result = decryptSecret(encrypted)
      expect(result).toBe('')
    })

    it('returns empty string when decryptString throws an error', () => {
      mockSafeStorage.isEncryptionAvailable.mockReturnValue(true)
      mockSafeStorage.decryptString.mockImplementation(() => {
        throw new Error('Decryption corrupt')
      })
      const encrypted = `${ENCRYPTED_PREFIX}Y29ycnVwdA==`
      const result = decryptSecret(encrypted)
      expect(result).toBe('')
    })
  })

  describe('isEncryptedSecret', () => {
    it('returns true for strings starting with prefix', () => {
      expect(isEncryptedSecret(`${ENCRYPTED_PREFIX}abc`)).toBe(true)
    })

    it('returns false for plaintext strings or non-strings', () => {
      expect(isEncryptedSecret('plain-key')).toBe(false)
      expect(isEncryptedSecret('')).toBe(false)
      expect(isEncryptedSecret(12345)).toBe(false)
      expect(isEncryptedSecret(null)).toBe(false)
    })
  })
})
