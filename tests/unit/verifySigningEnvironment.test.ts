import { describe, it, expect } from 'vitest'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'

// @ts-expect-error CommonJS module import without TypeScript declaration
import { evaluateSigningEnvironment, SUPPORTED_SIGNING_VARS } from '../../scripts/verifySigningEnvironment.cjs'

const execFileAsync = promisify(execFile)

describe('Release Signing Environment Readiness Validator', () => {
  const rootDir = path.resolve(__dirname, '../..')
  const scriptPath = path.join(rootDir, 'scripts', 'verifySigningEnvironment.cjs')

  describe('evaluateSigningEnvironment (Core Logic)', () => {
    it('succeeds in unsigned release-candidate mode when no signing variables are present', () => {
      const result = evaluateSigningEnvironment({}, { requireSigning: false })

      expect(result.valid).toBe(true)
      expect(result.mode).toBe('unsigned')
      expect(result.requiresSigning).toBe(false)
      expect(result.detectedVars).toEqual([])
      expect(result.messages.join(' ')).toContain('Unsigned Release-Candidate Mode')
    })

    it('fails when signing is explicitly required but variables are missing', () => {
      const result = evaluateSigningEnvironment({}, { requireSigning: true })

      expect(result.valid).toBe(false)
      expect(result.mode).toBe('missing')
      expect(result.requiresSigning).toBe(true)
      expect(result.error).toContain('Code signing was explicitly required')
      expect(result.error).toContain('WIN_CSC_LINK / CSC_LINK')
    })

    it('detects WIN_CSC_LINK and WIN_CSC_KEY_PASSWORD without exposing secret values', () => {
      const dummySecret = 'super-secret-cert-data-12345'
      const dummyPassword = 'super-secret-password-67890'

      const result = evaluateSigningEnvironment(
        {
          WIN_CSC_LINK: dummySecret,
          WIN_CSC_KEY_PASSWORD: dummyPassword
        },
        { requireSigning: true }
      )

      expect(result.valid).toBe(true)
      expect(result.mode).toBe('signed')
      expect(result.detectedVars).toEqual(['WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD'])

      // Secret Safety Assertions: values must NEVER appear in output messages
      const serialized = JSON.stringify(result)
      expect(serialized).not.toContain(dummySecret)
      expect(serialized).not.toContain(dummyPassword)
    })

    it('detects cross-platform CSC_LINK and CSC_KEY_PASSWORD', () => {
      const dummySecret = 'cert-content-alpha-123'
      const dummyPassword = 'password-bravo-456'

      const result = evaluateSigningEnvironment(
        {
          CSC_LINK: dummySecret,
          CSC_KEY_PASSWORD: dummyPassword
        },
        { requireSigning: true }
      )

      expect(result.valid).toBe(true)
      expect(result.mode).toBe('signed')
      expect(result.detectedVars).toEqual(['CSC_LINK', 'CSC_KEY_PASSWORD'])
    })

    it('rejects partial signing configuration: certificate provided without password', () => {
      const result = evaluateSigningEnvironment(
        {
          CSC_LINK: 'some-dummy-cert'
        },
        { requireSigning: false }
      )

      expect(result.valid).toBe(false)
      expect(result.mode).toBe('incomplete')
      expect(result.error).toContain('Incomplete signing configuration')
      expect(result.error).toContain('CSC_LINK')
      expect(result.error).toContain('certificate password')
    })

    it('rejects partial signing configuration: password provided without certificate', () => {
      const result = evaluateSigningEnvironment(
        {
          WIN_CSC_KEY_PASSWORD: 'some-dummy-password'
        },
        { requireSigning: false }
      )

      expect(result.valid).toBe(false)
      expect(result.mode).toBe('incomplete')
      expect(result.error).toContain('Incomplete signing configuration')
      expect(result.error).toContain('WIN_CSC_KEY_PASSWORD')
      expect(result.error).toContain('certificate link')
    })

    it('verifies supported signing variable names match electron-builder requirements', () => {
      expect(SUPPORTED_SIGNING_VARS.certLinks).toEqual(['WIN_CSC_LINK', 'CSC_LINK'])
      expect(SUPPORTED_SIGNING_VARS.certPasswords).toEqual(['WIN_CSC_KEY_PASSWORD', 'CSC_KEY_PASSWORD'])
    })
  })

  describe('CLI Process Execution & Output Redaction', () => {
    it('exits 0 with informational message in unsigned mode', async () => {
      const { stdout } = await execFileAsync('node', [scriptPath], {
        cwd: rootDir,
        env: { ...process.env, WIN_CSC_LINK: '', CSC_LINK: '', WIN_CSC_KEY_PASSWORD: '', CSC_KEY_PASSWORD: '' }
      })

      expect(stdout).toContain('[INFO]')
      expect(stdout).toContain('Unsigned Release-Candidate Mode')
    })

    it('exits 1 when signing is required via CLI flag and credentials are missing', async () => {
      await expect(
        execFileAsync('node', [scriptPath, '--require-signing'], {
          cwd: rootDir,
          env: { ...process.env, WIN_CSC_LINK: '', CSC_LINK: '', WIN_CSC_KEY_PASSWORD: '', CSC_KEY_PASSWORD: '' }
        })
      ).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('Code signing was explicitly required')
      })
    })

    it('exits 1 when signing is required via REQUIRE_SIGNING env var', async () => {
      await expect(
        execFileAsync('node', [scriptPath], {
          cwd: rootDir,
          env: {
            ...process.env,
            REQUIRE_SIGNING: 'true',
            WIN_CSC_LINK: '',
            CSC_LINK: '',
            WIN_CSC_KEY_PASSWORD: '',
            CSC_KEY_PASSWORD: ''
          }
        })
      ).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('Code signing was explicitly required')
      })
    })

    it('never leaks secret values in stdout or stderr when credentials are present', async () => {
      const dummyCert = 'SECRET_CERT_CONTENT_DUMMY_VALUE_999'
      const dummyPass = 'SECRET_PASS_CONTENT_DUMMY_VALUE_888'

      const { stdout, stderr } = await execFileAsync('node', [scriptPath, '--require-signing'], {
        cwd: rootDir,
        env: {
          ...process.env,
          CSC_LINK: dummyCert,
          CSC_KEY_PASSWORD: dummyPass
        }
      })

      expect(stdout).toContain('[SUCCESS]')
      expect(stdout).toContain('CSC_LINK')
      expect(stdout).toContain('CSC_KEY_PASSWORD')

      // Absolute safety check: ensure the literal secret values NEVER appear in process output
      expect(stdout).not.toContain(dummyCert)
      expect(stdout).not.toContain(dummyPass)
      expect(stderr).not.toContain(dummyCert)
      expect(stderr).not.toContain(dummyPass)
    })
  })
})
