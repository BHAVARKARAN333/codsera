import { describe, it, expect } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
// @ts-expect-error js-yaml lacks bundled type definitions
import yaml from 'js-yaml'

describe('Windows Packaging Workflow Configuration Validation', () => {
  const rootDir = path.resolve(__dirname, '../..')
  const packageWorkflowPath = path.join(rootDir, '.github', 'workflows', 'windows-package.yml')

  it('verifies .github/workflows/windows-package.yml exists and has valid YAML syntax', async () => {
    const fileExists = await fs.access(packageWorkflowPath).then(() => true, () => false)
    expect(fileExists).toBe(true)

    const content = await fs.readFile(packageWorkflowPath, 'utf-8')
    expect(content.length).toBeGreaterThan(100)

    const parsed: any = yaml.load(content)
    expect(parsed).toBeDefined()
    expect(typeof parsed).toBe('object')
    expect(parsed.name).toBe('Windows Packaging & Release Verification')
  })

  it('configures tag-based (v*) and manual workflow_dispatch triggers with release_tag and enable_signing inputs', async () => {
    const content = await fs.readFile(packageWorkflowPath, 'utf-8')
    const parsed: any = yaml.load(content)

    expect(parsed.on).toBeDefined()
    // Should NOT trigger on general pull requests
    expect(parsed.on.pull_request).toBeUndefined()

    // Must trigger on push tags matching v*
    expect(parsed.on.push).toBeDefined()
    expect(parsed.on.push.tags).toEqual(['v*'])

    // Must trigger on manual dispatch with optional release_tag and enable_signing inputs
    expect(parsed.on.workflow_dispatch).toBeDefined()
    const inputs = parsed.on.workflow_dispatch.inputs
    expect(inputs).toBeDefined()

    expect(inputs.release_tag).toBeDefined()
    expect(inputs.release_tag.required).toBe(false)

    expect(inputs.enable_signing).toBeDefined()
    expect(inputs.enable_signing.type).toBe('boolean')
    expect(inputs.enable_signing.default).toBe(false)
  })

  it('configures concurrency with cancellation of redundant runs', async () => {
    const content = await fs.readFile(packageWorkflowPath, 'utf-8')
    const parsed: any = yaml.load(content)

    expect(parsed.concurrency).toBeDefined()
    expect(parsed.concurrency['cancel-in-progress']).toBe(true)
  })

  it('runs on windows-latest with Node 20 LTS, version validation, signing readiness check, packaging, checksums, and packaged E2E', async () => {
    const content = await fs.readFile(packageWorkflowPath, 'utf-8')
    const parsed: any = yaml.load(content)

    const jobs = parsed.jobs
    expect(jobs).toBeDefined()
    const jobKey = Object.keys(jobs)[0]
    const job = jobs[jobKey]
    expect(job['runs-on']).toBe('windows-latest')
    expect(job['timeout-minutes']).toBe(30)

    const steps = job.steps
    expect(Array.isArray(steps)).toBe(true)

    // 1. Checkout
    const checkoutStep = steps.find((s: any) => s.uses && s.uses.startsWith('actions/checkout'))
    expect(checkoutStep).toBeDefined()

    // 2. Setup Node
    const nodeStep = steps.find((s: any) => s.uses && s.uses.startsWith('actions/setup-node'))
    expect(nodeStep).toBeDefined()
    expect(nodeStep.with['node-version']).toBe(20)
    expect(nodeStep.with.cache).toBe('npm')

    // 3. Clean Install
    const installStep = steps.find((s: any) => s.run && s.run.includes('npm ci'))
    expect(installStep).toBeDefined()

    // 4. Version consistency guard (MUST be before packaging)
    const validateVersionStepIndex = steps.findIndex(
      (s: any) => s.run && s.run.includes('scripts/verifyReleaseVersion.cjs')
    )
    expect(validateVersionStepIndex).toBeGreaterThan(-1)

    // 5. Code signing environment readiness check (MUST be before packaging)
    const verifySigningStepIndex = steps.findIndex(
      (s: any) => s.run && s.run.includes('scripts/verifySigningEnvironment.cjs')
    )
    expect(verifySigningStepIndex).toBeGreaterThan(-1)

    // 6. Packaging
    const packageStepIndex = steps.findIndex((s: any) => s.run && s.run.includes('npm run dist:win'))
    expect(packageStepIndex).toBeGreaterThan(-1)

    // Ensure validation gates strictly precede packaging
    expect(validateVersionStepIndex).toBeLessThan(packageStepIndex)
    expect(verifySigningStepIndex).toBeLessThan(packageStepIndex)

    // 7. Verification step
    const verifyStep = steps.find(
      (s: any) => s.run && s.run.includes('AI IDE.exe') && s.run.includes('AI IDE-Setup-*.exe')
    )
    expect(verifyStep).toBeDefined()
    // Ensure installer is not executed interactively
    expect(verifyStep.run).not.toMatch(/Start-Process.*Setup/i)
    expect(verifyStep.run).not.toMatch(/&.*Setup/i)

    // 8. Checksum generation step
    const checksumStep = steps.find(
      (s: any) => s.run && s.run.includes('Get-FileHash') && s.run.includes('SHA256SUMS.txt')
    )
    expect(checksumStep).toBeDefined()

    // 9. Packaged E2E
    const e2eStep = steps.find((s: any) => s.run && s.run.includes('npm run test:e2e:packaged'))
    expect(e2eStep).toBeDefined()

    // 10. Installer upload (must include SHA256SUMS.txt)
    const installerUpload = steps.find(
      (s: any) =>
        s.uses &&
        s.uses.startsWith('actions/upload-artifact') &&
        s.with?.name === 'AI-IDE-Windows-Installer'
    )
    expect(installerUpload).toBeDefined()
    expect(installerUpload.with.path).toContain('dist/AI IDE-Setup-*.exe')
    expect(installerUpload.with.path).toContain('dist/SHA256SUMS.txt')

    // 11. Unpacked portable upload
    const unpackedUpload = steps.find(
      (s: any) =>
        s.uses &&
        s.uses.startsWith('actions/upload-artifact') &&
        s.with?.name === 'AI-IDE-Windows-Unpacked'
    )
    expect(unpackedUpload).toBeDefined()
    expect(unpackedUpload.with.path).toContain('dist/win-unpacked/')

    // 12. Failure diagnostics upload
    const failureUpload = steps.find(
      (s: any) => s.uses && s.uses.startsWith('actions/upload-artifact') && s.if === 'failure()'
    )
    expect(failureUpload).toBeDefined()
  })

  it('enforces secret safety, opt-in signing, credential isolation, and no auto-release publishing', async () => {
    const content = await fs.readFile(packageWorkflowPath, 'utf-8')

    // No release publishing actions
    expect(content).not.toContain('action-gh-release')
    expect(content).not.toContain('softprops/action-gh-release')
    expect(content).not.toContain('gh release create')

    // No hardcoded certificate paths or literal passwords
    expect(content).not.toMatch(/CSC_LINK:\s*['"][^$]/)
    expect(content).not.toMatch(/CSC_KEY_PASSWORD:\s*['"][^$]/)
    expect(content).not.toMatch(/WIN_CSC_LINK:\s*['"][^$]/)
    expect(content).not.toMatch(/WIN_CSC_KEY_PASSWORD:\s*['"][^$]/)

    // Code signing is strictly opt-in via enable_signing condition
    expect(content).toContain('inputs.enable_signing == true')

    // Explicitly zeroed environment credentials for AI providers
    expect(content).toContain("GEMINI_API_KEY: ''")
    expect(content).toContain("OPENROUTER_API_KEY: ''")
    expect(content).toContain("NVIDIA_NIM_API_KEY: ''")
  })
})
