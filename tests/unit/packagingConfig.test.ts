import { describe, it, expect } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import * as resedit from 'resedit'

describe('Packaging Configuration & Icon Assets Unit Tests', () => {
  const rootDir = path.resolve(__dirname, '../..')
  const packageJsonPath = path.join(rootDir, 'package.json')
  const buildDir = path.join(rootDir, 'build')
  const icoPath = path.join(buildDir, 'icon.ico')
  const pngPath = path.join(buildDir, 'icon.png')

  describe('1. package.json Packaging Scripts', () => {
    it('configures build pre-requisites for package:win and dist:win', async () => {
      const content = await fs.readFile(packageJsonPath, 'utf-8')
      const pkg = JSON.parse(content)

      // Scripts must chain npm run build to avoid packaging stale outputs
      expect(pkg.scripts['package:win']).toBe('npm run build && electron-builder --win --dir')
      expect(pkg.scripts['dist:win']).toBe('npm run build && electron-builder --win')

      // Independent dir packager and generator scripts
      expect(pkg.scripts['package:win:dir']).toBe('electron-builder --win --dir')
      expect(pkg.scripts['generate:icons']).toBe('node scripts/generateIcon.cjs')

      // Preserves existing test scripts
      expect(pkg.scripts['test:e2e']).toBe('playwright test -c playwright.config.ts')
      expect(pkg.scripts['test:e2e:packaged']).toBe('playwright test -c playwright.packaged.config.ts')
    })
  })

  describe('2. electron-builder Configuration', () => {
    it('configures app identity, build resources, and Windows icon', async () => {
      const content = await fs.readFile(packageJsonPath, 'utf-8')
      const pkg = JSON.parse(content)
      const build = pkg.build

      expect(build).toBeDefined()
      expect(build.appId).toBe('com.aiide.desktop')
      expect(build.productName).toBe('AI IDE')
      expect(build.asar).toBe(true)

      // Directories
      expect(build.directories).toBeDefined()
      expect(build.directories.output).toBe('dist')
      expect(build.directories.buildResources).toBe('build')

      // Windows target & icon
      expect(build.win).toBeDefined()
      expect(build.win.icon).toBe('build/icon.ico')
      expect(build.win.artifactName).toBe('${productName}-Setup-${version}.${ext}')

      const targets = build.win.target
      expect(Array.isArray(targets)).toBe(true)
      const nsisTarget = targets.find((t: any) => t.target === 'nsis')
      expect(nsisTarget).toBeDefined()
      expect(nsisTarget.arch).toContain('x64')

      // NSIS installer settings
      expect(build.nsis).toBeDefined()
      expect(build.nsis.oneClick).toBe(true)
      expect(build.nsis.perMachine).toBe(false)
      expect(build.nsis.deleteAppDataOnUninstall).toBe(false)
    })
  })

  describe('3. Windows Icon Assets Validation', () => {
    it('verifies build/icon.ico exists, has valid ICO header, and parses with resedit', async () => {
      const icoExists = await fs.access(icoPath).then(() => true, () => false)
      expect(icoExists).toBe(true)

      const icoBuffer = await fs.readFile(icoPath)
      expect(icoBuffer.length).toBeGreaterThan(1024)

      // Verify ICO header: reserved=0, type=1 (icon)
      expect(icoBuffer.readUInt16LE(0)).toBe(0)
      expect(icoBuffer.readUInt16LE(2)).toBe(1)
      const iconCount = icoBuffer.readUInt16LE(4)
      expect(iconCount).toBeGreaterThanOrEqual(4)

      // Parse with resedit (same library used by electron-builder for Windows PE resources)
      const parsed = resedit.Data.IconFile.from(icoBuffer)
      expect(parsed.icons.length).toBe(iconCount)
    })

    it('verifies build/icon.png exists and has valid 512x512 PNG header', async () => {
      const pngExists = await fs.access(pngPath).then(() => true, () => false)
      expect(pngExists).toBe(true)

      const pngBuffer = await fs.readFile(pngPath)
      expect(pngBuffer.length).toBeGreaterThan(1024)

      // Verify standard 8-byte PNG signature: 0x89 'P' 'N' 'G' '\r' '\n' 0x1A '\n'
      const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      expect(pngBuffer.subarray(0, 8)).toEqual(signature)

      // Verify IHDR dimensions (offset 16: width, offset 20: height)
      const width = pngBuffer.readUInt32BE(16)
      const height = pngBuffer.readUInt32BE(20)
      expect(width).toBe(512)
      expect(height).toBe(512)
    })
  })
})
