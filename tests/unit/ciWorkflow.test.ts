import { describe, it, expect } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
// @ts-expect-error js-yaml lacks bundled type definitions
import yaml from 'js-yaml'

describe('CI Workflow Configuration Validation', () => {
  const rootDir = path.resolve(__dirname, '../..')
  const ciWorkflowPath = path.join(rootDir, '.github', 'workflows', 'ci.yml')

  it('verifies .github/workflows/ci.yml exists and has valid YAML syntax', async () => {
    const fileExists = await fs.access(ciWorkflowPath).then(() => true, () => false)
    expect(fileExists).toBe(true)

    const content = await fs.readFile(ciWorkflowPath, 'utf-8')
    expect(content.length).toBeGreaterThan(50)

    const parsed: any = yaml.load(content)
    expect(parsed).toBeDefined()
    expect(typeof parsed).toBe('object')
    expect(parsed.name).toBe('CI Quality Gate')
  })

  it('configures push, pull_request, and workflow_dispatch triggers on main and master', async () => {
    const content = await fs.readFile(ciWorkflowPath, 'utf-8')
    const parsed: any = yaml.load(content)

    expect(parsed.on).toBeDefined()
    expect(parsed.on.push).toBeDefined()
    expect(parsed.on.push.branches).toEqual(expect.arrayContaining(['main', 'master']))

    expect(parsed.on.pull_request).toBeDefined()
    expect(parsed.on.pull_request.branches).toEqual(expect.arrayContaining(['main', 'master']))

    expect(parsed.on.workflow_dispatch).toBeDefined()
  })

  it('configures concurrency with cancellation of redundant runs', async () => {
    const content = await fs.readFile(ciWorkflowPath, 'utf-8')
    const parsed: any = yaml.load(content)

    expect(parsed.concurrency).toBeDefined()
    expect(parsed.concurrency['cancel-in-progress']).toBe(true)
  })

  it('runs quality-gate job on windows-latest with Node 20 LTS and npm caching', async () => {
    const content = await fs.readFile(ciWorkflowPath, 'utf-8')
    const parsed: any = yaml.load(content)

    const jobs = parsed.jobs
    expect(jobs).toBeDefined()
    expect(jobs['quality-gate']).toBeDefined()

    const job = jobs['quality-gate']
    expect(job['runs-on']).toBe('windows-latest')
    expect(job['timeout-minutes']).toBe(15)

    const steps = job.steps
    expect(Array.isArray(steps)).toBe(true)
    expect(steps.length).toBeGreaterThanOrEqual(6)

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

    // 4. Test Suite
    const testStep = steps.find((s: any) => s.run && s.run.trim() === 'npm test')
    expect(testStep).toBeDefined()

    // 5. Typecheck
    const typecheckStep = steps.find((s: any) => s.run && s.run.includes('npm run typecheck'))
    expect(typecheckStep).toBeDefined()

    // 6. Build
    const buildStep = steps.find((s: any) => s.run && s.run.includes('npm run build'))
    expect(buildStep).toBeDefined()
  })

  it('does not contain any secrets, API keys, or live external service tokens', async () => {
    const content = await fs.readFile(ciWorkflowPath, 'utf-8')

    expect(content).not.toContain('GEMINI_API_KEY')
    expect(content).not.toContain('OPENROUTER_API_KEY')
    expect(content).not.toContain('NVIDIA_API_KEY')
    expect(content).not.toContain('OPENCODE_API_KEY')
    expect(content).not.toContain('CSC_LINK')
    expect(content).not.toContain('CSC_KEY_PASSWORD')
  })
})
