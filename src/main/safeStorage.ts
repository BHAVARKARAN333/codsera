import { safeStorage } from 'electron'

export const ENCRYPTED_PREFIX = 'encrypted:base64:'

/**
 * Checks whether Electron safeStorage encryption is supported and available on the current platform/session.
 */
export function isEncryptionAvailable(): boolean {
  try {
    return (
      typeof safeStorage !== 'undefined' &&
      typeof safeStorage.isEncryptionAvailable === 'function' &&
      safeStorage.isEncryptionAvailable()
    )
  } catch {
    return false
  }
}

/**
 * Encrypts a plaintext secret string using Electron safeStorage (DPAPI on Windows, Keychain on macOS).
 * Returns an encrypted payload with the prefix 'encrypted:base64:...'.
 * If safeStorage encryption is unavailable on the platform, falls back gracefully to plaintext.
 */
export function encryptSecret(plainText: string): string {
  if (!plainText || typeof plainText !== 'string') {
    return ''
  }

  // Already encrypted
  if (plainText.startsWith(ENCRYPTED_PREFIX)) {
    return plainText
  }

  if (isEncryptionAvailable()) {
    try {
      const buffer = safeStorage.encryptString(plainText)
      return `${ENCRYPTED_PREFIX}${buffer.toString('base64')}`
    } catch (err) {
      console.warn('[safeStorage] Failed to encrypt secret string, falling back to plaintext:', err)
      return plainText
    }
  }

  return plainText
}

/**
 * Decrypts a previously encrypted secret string.
 * Transparently supports legacy plaintext secrets (returns them directly for backward compatibility).
 * If decryption fails or encryption is unavailable, safely handles without throwing.
 */
export function decryptSecret(value: string): string {
  if (!value || typeof value !== 'string') {
    return ''
  }

  // Legacy plaintext backwards compatibility
  if (!value.startsWith(ENCRYPTED_PREFIX)) {
    return value
  }

  const base64Data = value.slice(ENCRYPTED_PREFIX.length)
  if (!base64Data) {
    return ''
  }

  if (isEncryptionAvailable()) {
    try {
      const buffer = Buffer.from(base64Data, 'base64')
      return safeStorage.decryptString(buffer)
    } catch (err) {
      console.warn('[safeStorage] Failed to decrypt secret string:', err)
      return ''
    }
  }

  console.warn('[safeStorage] Encryption unavailable on this platform; cannot decrypt stored secret.')
  return ''
}

/**
 * Checks whether a given value is an encrypted secret string.
 */
export function isEncryptedSecret(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(ENCRYPTED_PREFIX)
}
