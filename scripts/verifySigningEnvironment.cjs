/**
 * Release Code Signing Environment Readiness Validator
 *
 * Checks whether Authenticode code signing credentials (WIN_CSC_LINK / CSC_LINK,
 * WIN_CSC_KEY_PASSWORD / CSC_KEY_PASSWORD) are configured in the environment.
 *
 * Modes:
 * 1. Unsigned / Release-Candidate Mode (Default):
 *    - Allows builds to proceed without signing credentials.
 *    - Clearly documents that the build will remain unsigned.
 *    - Fails if a partial/corrupted signing configuration is detected (e.g., certificate without password).
 *
 * 2. Signing-Enabled Mode (--require-signing or REQUIRE_SIGNING=true):
 *    - Enforces presence of both certificate link and certificate password.
 *    - Fails if required variables are missing or incomplete.
 *
 * SECRET SAFETY GUARANTEE:
 * - NEVER prints or logs secret values, passwords, or certificate payloads.
 * - Only reports presence, variable names, and readiness status.
 *
 * Usage:
 *   node scripts/verifySigningEnvironment.cjs
 *   node scripts/verifySigningEnvironment.cjs --require-signing
 */

const SUPPORTED_SIGNING_VARS = {
  certLinks: ['WIN_CSC_LINK', 'CSC_LINK'],
  certPasswords: ['WIN_CSC_KEY_PASSWORD', 'CSC_KEY_PASSWORD']
}

/**
 * Evaluates the signing environment without exposing secret values.
 *
 * @param {Record<string, string | undefined>} [env=process.env]
 * @param {object} [options={}]
 * @param {boolean} [options.requireSigning]
 * @returns {{
 *   valid: boolean,
 *   mode: 'unsigned' | 'signed' | 'missing' | 'incomplete',
 *   requiresSigning: boolean,
 *   detectedVars: string[],
 *   messages: string[],
 *   error?: string
 * }}
 */
function evaluateSigningEnvironment(env = process.env, options = {}) {
  const requireSigning =
    options.requireSigning ??
    (process.argv.includes('--require-signing') || env.REQUIRE_SIGNING === 'true')

  // Identify which specific variables are configured (names only)
  const certVar = SUPPORTED_SIGNING_VARS.certLinks.find(
    (name) => typeof env[name] === 'string' && env[name].trim() !== ''
  )
  const passVar = SUPPORTED_SIGNING_VARS.certPasswords.find(
    (name) => typeof env[name] === 'string' && env[name].trim() !== ''
  )

  const detectedVars = [certVar, passVar].filter(Boolean)
  const hasCert = Boolean(certVar)
  const hasPass = Boolean(passVar)

  const messages = []

  // Case 1: Full signing configuration present
  if (hasCert && hasPass) {
    messages.push(`Code signing credentials detected: ${certVar} and ${passVar} are configured.`)
    messages.push('Environment is ready for signed production packaging.')
    return {
      valid: true,
      mode: 'signed',
      requiresSigning: requireSigning,
      detectedVars,
      messages
    }
  }

  // Case 2: Partial configuration (certificate without password, or password without certificate)
  if (hasCert !== hasPass) {
    const missingType = hasCert
      ? 'certificate password (WIN_CSC_KEY_PASSWORD or CSC_KEY_PASSWORD)'
      : 'certificate link (WIN_CSC_LINK or CSC_LINK)'
    const presentVar = certVar || passVar

    const errorMsg = `Incomplete signing configuration: ${presentVar} is provided, but required ${missingType} is missing.`
    return {
      valid: false,
      mode: 'incomplete',
      requiresSigning: requireSigning,
      detectedVars,
      messages,
      error: errorMsg
    }
  }

  // Case 3: Neither variable is present
  if (requireSigning) {
    const errorMsg =
      'Code signing was explicitly required (--require-signing / REQUIRE_SIGNING=true), but no signing credentials were found in the environment. Please configure WIN_CSC_LINK / CSC_LINK and WIN_CSC_KEY_PASSWORD / CSC_KEY_PASSWORD.'
    return {
      valid: false,
      mode: 'missing',
      requiresSigning: true,
      detectedVars: [],
      messages,
      error: errorMsg
    }
  }

  // Case 4: Default unsigned release-candidate mode
  messages.push('Signing Status: Unsigned Release-Candidate Mode.')
  messages.push('No signing credentials detected in environment (WIN_CSC_LINK / CSC_LINK unset).')
  messages.push('Packaging will proceed in unsigned (ad-hoc) mode.')

  return {
    valid: true,
    mode: 'unsigned',
    requiresSigning: false,
    detectedVars: [],
    messages
  }
}

/**
 * CLI execution handler
 */
function run() {
  const result = evaluateSigningEnvironment()

  if (!result.valid) {
    console.error(`\x1b[31m[ERROR]\x1b[0m ${result.error}`)
    process.exit(1)
  }

  for (const msg of result.messages) {
    if (result.mode === 'signed') {
      console.log(`\x1b[32m[SUCCESS]\x1b[0m ${msg}`)
    } else {
      console.log(`\x1b[36m[INFO]\x1b[0m ${msg}`)
    }
  }

  process.exit(0)
}

if (require.main === module) {
  run()
}

module.exports = {
  SUPPORTED_SIGNING_VARS,
  evaluateSigningEnvironment
}
