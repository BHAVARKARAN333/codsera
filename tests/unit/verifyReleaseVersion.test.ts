import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { execFile } from 'child_process'
import { promisify } from 'util'

// @ts-expect-error CommonJS script import without TypeScript declaration
import { validateVersionConsistency, verifyReleaseVersion } from '../../scripts/verifyReleaseVersion.cjs'

const execFileAsync = promisify(execFile)

describe('Release Version Consistency Validator', () => {
  const rootDir = path.resolve(__dirname, '../..')
  const packageJsonPath = path.join(rootDir, 'package.json')
  const scriptPath = path.join(rootDir, 'scripts', 'verifyReleaseVersion.cjs')

  describe('validateVersionConsistency (Core Logic)', () => {
    it('succeeds for matching version and tag', () => {
      const result = validateVersionConsistency('0.1.0', 'v0.1.0')
      expect(result.valid).toBe(true)
      expect(result.version).toBe('0.1.0')
      expect(result.tag).toBe('v0.1.0')
      expect(result.error).toBeUndefined()
    })

    it('succeeds when version is valid and tag is omitted or empty', () => {
      expect(validateVersionConsistency('0.1.0')).toEqual({
        valid: true,
        version: '0.1.0'
      })

      expect(validateVersionConsistency('0.1.0', '')).toEqual({
        valid: true,
        version: '0.1.0'
      })

      expect(validateVersionConsistency('0.1.0', '   ')).toEqual({
        valid: true,
        version: '0.1.0'
      })
    })

    it('supports valid prerelease tags when matching package version', () => {
      const rc1 = validateVersionConsistency('1.0.0-rc1', 'v1.0.0-rc1')
      expect(rc1.valid).toBe(true)
      expect(rc1.version).toBe('1.0.0-rc1')
      expect(rc1.tag).toBe('v1.0.0-rc1')

      const beta = validateVersionConsistency('0.2.0-beta.2', 'v0.2.0-beta.2')
      expect(beta.valid).toBe(true)
      expect(beta.version).toBe('0.2.0-beta.2')
      expect(beta.tag).toBe('v0.2.0-beta.2')
    })

    it('fails when tag does not match package version', () => {
      const result = validateVersionConsistency('0.1.0', 'v0.2.0')
      expect(result.valid).toBe(false)
      expect(result.error).toContain('Release version mismatch')
      expect(result.error).toContain('v0.2.0')
      expect(result.error).toContain('0.1.0')
    })

    it('fails when tag has prerelease identifier but package.json does not', () => {
      const result = validateVersionConsistency('1.0.0', 'v1.0.0-rc1')
      expect(result.valid).toBe(false)
      expect(result.error).toContain('Release version mismatch')
    })

    it('fails when package.json has prerelease identifier but tag does not', () => {
      const result = validateVersionConsistency('1.0.0-rc1', 'v1.0.0')
      expect(result.valid).toBe(false)
      expect(result.error).toContain('Release version mismatch')
    })

    it('rejects invalid tag formats', () => {
      // Missing 'v' prefix
      const missingV = validateVersionConsistency('0.1.0', '0.1.0')
      expect(missingV.valid).toBe(false)
      expect(missingV.error).toContain('Invalid release tag format')

      // Prefix other than 'v'
      const wrongPrefix = validateVersionConsistency('0.1.0', 'release-0.1.0')
      expect(wrongPrefix.valid).toBe(false)
      expect(wrongPrefix.error).toContain('Invalid release tag format')

      // Missing patch version
      const missingPatch = validateVersionConsistency('0.1.0', 'v0.1')
      expect(missingPatch.valid).toBe(false)
      expect(missingPatch.error).toContain('Invalid release tag format')

      // 4 version segments
      const fourSegments = validateVersionConsistency('0.1.0', 'v0.1.0.1')
      expect(fourSegments.valid).toBe(false)
      expect(fourSegments.error).toContain('Invalid release tag format')

      // Bare 'v'
      const bareV = validateVersionConsistency('0.1.0', 'v')
      expect(bareV.valid).toBe(false)
      expect(bareV.error).toContain('Invalid release tag format')

      // Arbitrary non-numeric text
      const textTag = validateVersionConsistency('0.1.0', 'vlatest')
      expect(textTag.valid).toBe(false)
      expect(textTag.error).toContain('Invalid release tag format')
    })

    it('rejects missing or invalid package.json versions', () => {
      // Empty string
      const empty = validateVersionConsistency('', 'v0.1.0')
      expect(empty.valid).toBe(false)
      expect(empty.error).toContain("Missing or invalid 'version'")

      // Non-string
      const nonString = validateVersionConsistency(null as any, 'v0.1.0')
      expect(nonString.valid).toBe(false)
      expect(nonString.error).toContain("Missing or invalid 'version'")

      // Malformed SemVer in package.json
      const malformed = validateVersionConsistency('not-a-version', 'v0.1.0')
      expect(malformed.valid).toBe(false)
      expect(malformed.error).toContain('Invalid package.json version')

      // Incomplete SemVer in package.json
      const incomplete = validateVersionConsistency('1.0', 'v1.0.0')
      expect(incomplete.valid).toBe(false)
      expect(incomplete.error).toContain('Invalid package.json version')
    })
  })

  describe('verifyReleaseVersion (File & Environment Integration)', () => {
    it('verifies the actual project package.json against matching tag v0.1.0-rc2', () => {
      const result = verifyReleaseVersion({
        packageJsonPath,
        tag: 'v0.1.0-rc2'
      })
      expect(result.valid).toBe(true)
      expect(result.version).toBe('0.1.0-rc2')
      expect(result.tag).toBe('v0.1.0-rc2')
    })

    it('reports error when package.json does not exist', () => {
      const nonExistentPath = path.join(rootDir, 'non-existent-package.json')
      const result = verifyReleaseVersion({
        packageJsonPath: nonExistentPath,
        tag: 'v0.1.0-rc1'
      })
      expect(result.valid).toBe(false)
      expect(result.error).toContain('Cannot read package.json')
    })

    it('reports error when package.json contains invalid JSON syntax', () => {
      const tempCorruptPath = path.join(rootDir, 'temp-corrupt-package.json')
      fs.writeFileSync(tempCorruptPath, '{ version: "0.1.0" invalid json }', 'utf-8')
      try {
        const result = verifyReleaseVersion({
          packageJsonPath: tempCorruptPath,
          tag: 'v0.1.0'
        })
        expect(result.valid).toBe(false)
        expect(result.error).toContain('Failed to parse package.json')
      } finally {
        fs.unlinkSync(tempCorruptPath)
      }
    })

    it('guarantees that package.json is NEVER modified during validation', () => {
      const beforeContent = fs.readFileSync(packageJsonPath, 'utf-8')
      const beforeHash = crypto.createHash('sha256').update(beforeContent).digest('hex')
      const beforeStat = fs.statSync(packageJsonPath)

      // Run multiple validation calls (matching, mismatch, invalid tag)
      verifyReleaseVersion({ packageJsonPath, tag: 'v0.1.0-rc2' })
      verifyReleaseVersion({ packageJsonPath, tag: 'v0.2.0' })
      verifyReleaseVersion({ packageJsonPath, tag: 'invalid' })

      const afterContent = fs.readFileSync(packageJsonPath, 'utf-8')
      const afterHash = crypto.createHash('sha256').update(afterContent).digest('hex')
      const afterStat = fs.statSync(packageJsonPath)

      expect(afterHash).toBe(beforeHash)
      expect(afterContent).toBe(beforeContent)
      expect(afterStat.size).toBe(beforeStat.size)
    })
  })

  describe('CLI Process Execution', () => {
    it('exits with code 0 on matching tag argument', async () => {
      const { stdout } = await execFileAsync('node', [scriptPath, 'v0.1.0-rc2'], { cwd: rootDir })
      expect(stdout).toContain('[SUCCESS]')
      expect(stdout).toContain('matches package.json version "0.1.0-rc2"')
    })

    it('exits with code 0 when tag is omitted', async () => {
      const { stdout } = await execFileAsync('node', [scriptPath], { cwd: rootDir })
      expect(stdout).toContain('[SUCCESS]')
      expect(stdout).toContain('Valid package.json version: "0.1.0-rc2"')
    })

    it('exits with code 1 and descriptive error on version mismatch', async () => {
      await expect(
        execFileAsync('node', [scriptPath, 'v0.9.9'], { cwd: rootDir })
      ).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('Release version mismatch')
      })
    })

    it('exits with code 1 and descriptive error on malformed tag format', async () => {
      await expect(
        execFileAsync('node', [scriptPath, 'release-0.1.0'], { cwd: rootDir })
      ).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('Invalid release tag format')
      })
    })
  })
})
