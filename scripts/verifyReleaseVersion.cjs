/**
 * Release Version Consistency Validator
 *
 * Validates that Git release tags match the exact version defined in package.json.
 * Prevents packaging mismatched, corrupted, or mistagged release candidate artifacts.
 *
 * Usage:
 *   node scripts/verifyReleaseVersion.cjs [tag]
 *   node scripts/verifyReleaseVersion.cjs --tag=v0.1.0
 */

const fs = require('fs')
const path = require('path')

// Semantic Versioning specification: https://semver.org/
const SEMVER_REGEX =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

// Tag must begin with 'v' followed by valid SemVer
const TAG_REGEX =
  /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

/**
 * Validates consistency between package.json version and an optional Git tag.
 *
 * @param {string} packageVersion - Version string from package.json
 * @param {string} [rawTag] - Optional Git tag to validate against packageVersion
 * @returns {{ valid: boolean, version?: string, tag?: string, error?: string }}
 */
function validateVersionConsistency(packageVersion, rawTag) {
  if (!packageVersion || typeof packageVersion !== 'string') {
    return {
      valid: false,
      error: "Missing or invalid 'version' in package.json. Version must be a non-empty string."
    }
  }

  const cleanPackageVersion = packageVersion.trim()
  if (!SEMVER_REGEX.test(cleanPackageVersion)) {
    return {
      valid: false,
      error: `Invalid package.json version: "${packageVersion}". Must follow Semantic Versioning (e.g., '0.1.0' or '1.0.0-rc1').`
    }
  }

  // If a tag is supplied, validate tag format and exact version match
  if (rawTag !== undefined && rawTag !== null && String(rawTag).trim() !== '') {
    const cleanTag = String(rawTag).trim()

    if (!TAG_REGEX.test(cleanTag)) {
      return {
        valid: false,
        error: `Invalid release tag format: "${cleanTag}". Tags must start with 'v' followed by SemVer (e.g., 'v0.1.0' or 'v1.0.0-rc1').`
      }
    }

    const expectedVersion = cleanTag.slice(1)
    if (expectedVersion !== cleanPackageVersion) {
      return {
        valid: false,
        error: `Release version mismatch: Git tag "${cleanTag}" implies version "${expectedVersion}", but package.json version is "${cleanPackageVersion}". Packaging aborted to prevent inconsistent release artifacts.`
      }
    }

    return {
      valid: true,
      version: cleanPackageVersion,
      tag: cleanTag
    }
  }

  return {
    valid: true,
    version: cleanPackageVersion
  }
}

/**
 * Reads package.json and verifies version against an optional tag.
 *
 * @param {object} [options]
 * @param {string} [options.packageJsonPath] - Absolute or relative path to package.json
 * @param {string} [options.tag] - Optional tag string
 * @returns {{ valid: boolean, version?: string, tag?: string, error?: string }}
 */
function verifyReleaseVersion(options = {}) {
  const packageJsonPath = options.packageJsonPath || path.resolve(__dirname, '../package.json')

  let rawContent
  try {
    rawContent = fs.readFileSync(packageJsonPath, 'utf-8')
  } catch (err) {
    return {
      valid: false,
      error: `Cannot read package.json at ${packageJsonPath}: ${err.message}`
    }
  }

  let parsed
  try {
    parsed = JSON.parse(rawContent)
  } catch (err) {
    return {
      valid: false,
      error: `Failed to parse package.json at ${packageJsonPath}: ${err.message}`
    }
  }

  let tag = options.tag
  if (tag === undefined) {
    // Check CLI arguments
    const args = process.argv.slice(2)
    const tagFlag = args.find((a) => a.startsWith('--tag='))
    if (tagFlag) {
      tag = tagFlag.split('=')[1]
    } else if (args[0] && !args[0].startsWith('-')) {
      tag = args[0]
    }
  }

  return validateVersionConsistency(parsed.version, tag)
}

if (require.main === module) {
  const result = verifyReleaseVersion()
  if (!result.valid) {
    console.error(`\x1b[31m[ERROR]\x1b[0m ${result.error}`)
    process.exit(1)
  }

  if (result.tag) {
    console.log(
      `\x1b[32m[SUCCESS]\x1b[0m Release version verified: Git tag "${result.tag}" matches package.json version "${result.version}".`
    )
  } else {
    console.log(
      `\x1b[32m[SUCCESS]\x1b[0m Valid package.json version: "${result.version}" (no Git tag specified).`
    )
  }
  process.exit(0)
}

module.exports = {
  SEMVER_REGEX,
  TAG_REGEX,
  validateVersionConsistency,
  verifyReleaseVersion
}
