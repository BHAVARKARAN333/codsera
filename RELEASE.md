# AI IDE — Release & Packaging Guide

This document describes the production build, packaging, security architecture, automated CI quality gate, release verification, and code-signing process for the **AI IDE** desktop application on Windows.

---

## 1. Overview & System Requirements

### Application Profile
- **Application Name:** AI IDE
- **Application ID:** `com.aiide.desktop`
- **Current Version:** `0.1.0-rc1`
- **Framework:** Electron 31 + React 18 + TypeScript + Vite 5 (`electron-vite`)
- **Editor Core:** Monaco Editor with dedicated language web workers
- **Installer Engine:** NSIS (Nullsoft Scriptable Install System) via `electron-builder`

### Target Platform
- **Operating System:** Windows 10 (Build 1809+) or Windows 11 (64-bit / x64)
- **Runtime Dependencies:** None required (Electron runtime and Chromium are fully bundled)
- **Optional Dependencies:** Git (required for Source Control diffing, staging, branch management, and commit features)

---

## 2. Release & Build Commands

All packaging commands must be executed from the project root. Packaging scripts automatically compile production assets before building distributions.

| Command | Description | Artifact Output |
| :--- | :--- | :--- |
| `npm run typecheck` | Validates TypeScript types across Node (`tsconfig.node.json`) and Web (`tsconfig.web.json`) targets. | In-memory verification |
| `npm test` | Runs the full Vitest suite (unit, component, IPC integration, security, packaging, and smoke tests). | Console test report |
| `npm run test:e2e` | Launches the Playwright Electron development E2E suite across simulated workspaces. | Playwright test report |
| `npm run test:e2e:packaged` | Executes real E2E validation against the packaged binary (`dist/win-unpacked/AI IDE.exe`). | Playwright test report |
| `npm run build` | Compiles main process, preload script, renderer bundle, and Monaco workers. | `out/main/`, `out/preload/`, `out/renderer/` |
| `npm run generate:icons` | Generates multi-resolution `build/icon.ico` and 512x512 `build/icon.png`. | `build/icon.ico`, `build/icon.png` |
| `npm run verify:version` | Validates that Git release tags match `package.json` version before packaging. | Validation log & exit status |
| `npm run verify:signing` | Checks code signing readiness and validates credential configuration safely without logging secrets. | Verification log & exit status |
| `npm run package:win` | Builds production bundles and packages the unpacked Windows executable folder. | `dist/win-unpacked/` |
| `npm run package:win:dir` | Packages the unpacked Windows application directory directly without rebuilding. | `dist/win-unpacked/` |
| `npm run dist:win` | Builds production bundles and compiles the production one-click NSIS setup installer. | `dist/AI IDE-Setup-0.1.0-rc1.exe` |

---

## 3. Automated CI Quality Gate (`.github/workflows/ci.yml`)

The repository includes a GitHub Actions continuous integration quality gate running on `windows-latest` with Node 20 LTS.

### Quality Gate Pipeline

```
GitHub Push / PR (main, master)
       │
       ▼
[actions/checkout@v4] ────────► Checks out clean repository source
       │
       ▼
[actions/setup-node@v4] ──────► Configures Node.js 20 LTS with npm cache
       │
       ▼
[npm ci] ─────────────────────► Deterministic clean install from package-lock.json
       │
       ▼
[npm test] ───────────────────► Runs all 558 unit, component, IPC & security tests
       │
       ▼
[npm run typecheck] ──────────► Validates TypeScript types (Node & Web targets)
       │
       ▼
[npm run build] ──────────────► Compiles production bundles with Monaco workers
```

### Guarantees & Constraints
- **100% Deterministic & Headless:** All quality gate steps execute in a headless Windows environment without requiring an active graphical desktop session.
- **Zero External Secrets:** No API keys, credentials, or live AI provider connections are required; all provider responses are strictly mocked.
- **Fail-Fast Enforcement:** If any test, typecheck error, or build issue occurs, the workflow fails immediately, blocking broken code from merging.
- **Redundant Run Cancellation:** `concurrency` with `cancel-in-progress: true` automatically cancels obsolete CI runs when new commits are pushed to the same branch.

### Architectural Decision: CI Quality Gate vs. Packaging Verification
The project intentionally separates the **CI Quality Gate** from **Windows Packaging** (`dist:win` and `test:e2e:packaged`):
1. **CI Speed & Reliability:** Normal CI runs in ~1.5–2 minutes. Running full NSIS packaging and Playwright Electron window launches on every commit would add 5–8 minutes of execution time, require downloading remote Electron binaries, and consume significant runner resources.
2. **Environment & Security Isolation:** The CI quality gate does not require code-signing certificates (`CSC_LINK`), signing credentials, or Windows desktop GUI display sessions.
3. **Verification Tiering:**
   - **Tier 1 (CI Gate):** Continuous, automated code validation on every PR/push (`test`, `typecheck`, `build`).
   - **Tier 2 (Release Gate):** Local/release-time verification of packaged binaries, NSIS installers, and packaged E2E test runs (`package:win`, `dist:win`, `test:e2e:packaged`).

---

## 4. Windows Packaging & Verification CI (`.github/workflows/windows-package.yml`)

The repository includes a dedicated packaging and validation CI pipeline running on `windows-latest` with Node 20 LTS.

### Pipeline Execution Model & Triggers

To prevent heavy packaging jobs from slowing down regular development iterations and consuming runner quotas, this workflow is decoupled from standard pull requests:

| Trigger | Description | Use Case |
| :--- | :--- | :--- |
| **Manual Dispatch (`workflow_dispatch`)** | Triggered on-demand from the GitHub Actions UI or GitHub CLI (`gh workflow run windows-package.yml`). | Pre-release sanity checking, branch packaging validation, and on-demand installer generation. |
| **Tag Push (`v*`)** | Automatically triggered when any Git tag prefixed with `v` is pushed (e.g. `v0.1.0`, `v1.0.0-rc1`). | Official release candidate builds and distribution artifact generation. |

### Packaging CI Pipeline

```
Git Tag (v*) or Manual Dispatch
       │
       ▼
[actions/checkout@v4] ────────► Checks out repository source
       │
       ▼
[actions/setup-node@v4] ──────► Configures Node.js 20 LTS with npm cache
       │
       ▼
[npm ci] ─────────────────────► Clean deterministic dependency installation
       │
       ▼
[npm run dist:win] ───────────► Builds production bundle & compiles NSIS installer
       │
       ▼
[Verify Artifacts] ──────────► Asserts dist/win-unpacked/AI IDE.exe & installer exist
       │
       ▼
[npm run test:e2e:packaged] ──► Runs Playwright validation against packaged binary
       │
       ▼
[Upload Artifacts] ──────────► Uploads installer & portable unpacked zip (if success)
       │
       ▼ (if failure)
[Failure Diagnostics] ───────► Preserves test traces and electron-builder logs
```

### CI Tiering Comparison

| Attribute | Tier 1: CI Quality Gate (`ci.yml`) | Tier 2: Windows Packaging CI (`windows-package.yml`) |
| :--- | :--- | :--- |
| **Trigger** | `push` / `pull_request` on `main`/`master` | `push` tags (`v*`), manual `workflow_dispatch` |
| **Execution Time** | ~1.5 – 2 minutes | ~5 – 8 minutes |
| **Scope** | Code correctness (`test`, `typecheck`, `build`) | Full installer packaging & real packaged app launch |
| **Packaged Testing** | Skipped (no binary created) | Runs `npm run test:e2e:packaged` against `AI IDE.exe` |
| **Artifacts** | None (in-memory verification) | Windows Installer (`dist/AI IDE-Setup-*.exe`), Unpacked Portable |
| **Headless/GUI** | 100% headless node execution | Launches native Electron window in Windows runner desktop |
| **Target Audience** | Continuous developer validation | Release candidates, staging, release validation |

### Generated Artifacts & Retention Policy
- **Primary Installer:** `AI-IDE-Windows-Installer` artifact containing `dist/AI IDE-Setup-*.exe`, `.blockmap`, and `dist/SHA256SUMS.txt` (Retained for 14 days).
- **Portable Unpacked Directory:** `AI-IDE-Windows-Unpacked` artifact containing `dist/win-unpacked/` (Retained for 7 days).
- **Failure Diagnostics:** `packaging-failure-diagnostics` containing `test-results/` Playwright reports and `dist/builder-debug.yml` if packaging or tests fail.

### Release-Candidate Version & Tag Guardrails
To prevent releasing mismatched, mistagged, or corrupt release candidates, the pipeline runs deterministic pre-packaging validation via `scripts/verifyReleaseVersion.cjs` (`npm run verify:version`):

1. **Tag Matching Rule:**
   - Git release tags must strictly adhere to Semantic Versioning prefixed by `v`: `vX.Y.Z` or `vX.Y.Z-<prerelease>` (e.g., `v0.1.0` or `v1.0.0-rc1`).
   - The tag stripped of `v` must **exactly match** the `"version"` field in `package.json`.
   - *Example valid match:* Tag `v0.1.0` matches `package.json` version `0.1.0`.
   - *Example mismatch failure:* If a tag `v0.2.0` is pushed while `package.json` contains `"version": "0.1.0"`, the validation step halts the workflow immediately:
     ```
     [ERROR] Release version mismatch: Git tag "v0.2.0" implies version "0.2.0", but package.json version is "0.1.0". Packaging aborted to prevent inconsistent release artifacts.
     ```
   - This fail-fast barrier runs **before** `npm run dist:win`, preventing any compiler or installer generation when mismatched.
2. **Manual Dispatch Verification:**
   - In manual `workflow_dispatch` runs, users may optionally supply a `release_tag` input. If provided, it enforces the exact version match. If omitted, it validates that `package.json` contains a valid SemVer string before proceeding.
3. **Immutability Guarantee:**
   - The validation utility operates in strict read-only mode and never mutates `package.json` or any project files.

### Artifact Integrity & SHA-256 Checksums
Every Windows installer build produces a cryptographic SHA-256 checksum record saved to `dist/SHA256SUMS.txt` before upload:
- **Format:** `<64-hex-digest>  AI IDE-Setup-<version>.exe`
- **Verification on Windows:**
  - **PowerShell:**
    ```powershell
    Get-FileHash -Path ".\AI IDE-Setup-0.1.0-rc1.exe" -Algorithm SHA256
    ```
  - **Command Prompt (CMD):**
    ```cmd
    certutil -hashfile "AI IDE-Setup-0.1.0-rc1.exe" SHA256
    ```
  - Match the output against the hash listed in `SHA256SUMS.txt` to verify file integrity and detect any download corruption or transit tampering.

### Packaged E2E Verification
The workflow executes the full suite in `tests/e2e/packagedApp.packaged.test.ts` using Playwright:
1. Confirms executable launches from `dist/win-unpacked/AI IDE.exe` and loads renderer from `resources/app.asar`.
2. Validates workspace directory initialization, file tree population, and Monaco Editor editing and file saving (`Ctrl+S`).
3. Verifies packaged Preload IPC handlers (`getSettings`, `readTree`, `readFile`).
4. Confirms Monaco TypeScript/JavaScript language web workers instantiate without `file://` protocol or sandbox violations.
5. All live AI provider calls are completely disabled (empty credentials injected; mock responses only).

### Current Unsigned-Build Status & Limitations
- **Current Status (Unsigned / Ad-Hoc):** The current CI workflow produces **unsigned (ad-hoc signed)** release candidate artifacts. No private code-signing keys or certificates are stored in GitHub repository secrets at this stage.
- **SmartScreen Prompt:** When installing the unsigned setup executable on an external Windows machine, Windows SmartScreen will display an *"Unknown Publisher"* warning.
- **Future Signed Releases:** Authenticode code signing via an EV certificate or Azure Trusted Signing (`CSC_LINK` / `WIN_CSC_LINK`) is documented in Section 8 and will be introduced when production credentials and signing infrastructure are formally provisioned.
- **No Automatic Release Publishing:** The workflow deliberately produces downloadable CI workflow artifacts instead of publishing public GitHub Releases, ensuring that releases cannot be published prematurely without human sign-off.

---

## 5. Windows Application Icon Architecture

The application icon is configured in `package.json` under `"build.win.icon"` and built into `build/icon.ico`:

### Icon Assets
- **Location:** `build/icon.ico` (multi-resolution Windows icon) and `build/icon.png` (512x512 high-resolution source).
- **Embedded Resolutions:** 16x16, 24x24, 32x32, 48x48, 64x64, 128x128, and 256x256 pixels.
- **Design:** Custom dark slate background squircle with glowing cyan-to-violet border, cyan left chevron (`<`), violet right chevron (`>`), and an electric center neural spark.

### Integration with electron-builder
- Configured in `package.json`:
  ```json
  "build": {
    "directories": {
      "output": "dist",
      "buildResources": "build"
    },
    "win": {
      "icon": "build/icon.ico",
      "target": [{ "target": "nsis", "arch": ["x64"] }]
    }
  }
  ```
- **Windows Executable:** `electron-builder` embeds the icon into the PE header of `AI IDE.exe` using `resedit`.
- **NSIS Installer:** The icon is used as the installer icon, uninstaller icon, and default desktop/Start Menu shortcut icon.

---

## 6. Windows Installer Architecture

### Distribution Targets

1. **Unpacked Directory (`dist/win-unpacked/`):**
   - Directly executable without installation: `dist/win-unpacked/AI IDE.exe`.
   - Bundles all production bytecode and assets inside `resources/app.asar`.
   - Used for automated smoke tests, packaged E2E validation, and portable execution.

2. **NSIS Setup Installer (`dist/AI IDE-Setup-0.1.0-rc1.exe`):**
   - Single-executable self-extracting installer with LZMA solid compression.
   - **Per-User Scope (`perMachine: false`, `oneClick: true`):** Installs cleanly to `%LOCALAPPDATA%\Programs\AI IDE` without requiring Windows Administrator or UAC elevation.
   - **Shortcuts:** Automatically creates desktop and Start Menu shortcuts with the application icon.
   - **Data Retention (`deleteAppDataOnUninstall: false`):** Preserves user preferences (`settings.json`) and workspace indexes across application reinstalls or updates.

---

## 7. Security & Hardening Architecture

AI IDE implements defense-in-depth security principles across its desktop runtime:

### Runtime Security
- **Context Isolation:** `contextIsolation: true` is strictly enforced for all renderer windows.
- **Process Sandboxing:** `sandbox: true` restricts renderer execution to isolated processes.
- **Node Integration Disabled:** `nodeIntegration: false` ensures the DOM environment cannot access Node.js primitives directly.
- **Content Security Policy (CSP):** HTTP header and meta tag enforce strict source restrictions (`default-src 'self'`, `script-src 'self'`, `worker-src 'self' blob:`, `frame-src 'none'`, `object-src 'none'`).
- **External Navigation Restrictions:** The `will-navigate` event blocks arbitrary web navigation within the application window. Safe external links (`https://`, `http://`) open in the default system browser via `shell.openExternal`.
- **Window Open Prevention:** `webContents.setWindowOpenHandler` denies all unauthorized window popups (`action: 'deny'`).
- **Single-Instance Enforcement:** `app.requestSingleInstanceLock()` prevents concurrent conflicting IDE instances; secondary launches refocus the existing active window.
- **Production DevTools Lockdown:** When `app.isPackaged` is true, DevTools keyboard shortcuts (`F12`, `Ctrl+Shift+I`) are intercepted and disabled.

### Secrets Encryption (`safeStorage`)
- **DPAPI Encryption:** Provider API keys (`geminiApiKey`, `openRouterApiKey`, `nvidiaApiKey`, `opencodeApiKey`) are encrypted before persistence to disk (`settings.json`) using Electron's native `safeStorage` API backed by Windows DPAPI (`CryptProtectData`).
- **Storage Format:** Stored values use the prefix `encrypted:base64:<cipherTextBase64>`.
- **Backward Compatibility:** Legacy plaintext values are transparently detected and decrypted on read, then automatically migrated to encrypted format on the next save operation.
- **Graceful Degradation:** If OS-level encryption is unavailable (e.g. headless test environments), the system handles values safely without throwing exceptions or corrupting the configuration.

### Atomic Settings Persistence
- **Write-to-Temp-Then-Rename:** Writes settings to a temporary file (`.settings.<pid>.<time>.<rand>.tmp`) in the same directory (`%APPDATA%\AI IDE\`).
- **Disk Flush (`fileHandle.sync()`):** Commits data to physical disk before replacing the target file.
- **Handle Closure:** Explicitly closes file handles before renaming, adhering to Windows file locking semantics.
- **Transient Lock Resilience:** Automatically retries renames with exponential backoff on transient Windows locks (`EBUSY`, `EPERM`, `EACCES`).
- **Concurrency Serialization:** A promise-based queue serializes concurrent save requests, preventing race conditions and stale overwrites.
- **Failure Preservation:** If any write or rename fails, temporary files are cleaned up immediately without touching the pre-existing valid `settings.json`.
- **Orphan Cleanup:** Cleans up stale `.settings.*.tmp` files on startup.

---

## 8. Code Signing Architecture & Release Signing Readiness

Windows application distribution requires Authenticode digital signatures to prevent Microsoft Defender SmartScreen warnings ("Unknown Publisher") and establish trusted binary reputation.

### Operating Modes

The AI IDE build pipeline implements two distinct, mutually isolated operating modes:

| Mode | Trigger & Context | Behavior & Secrets |
| :--- | :--- | :--- |
| **1. Unsigned Developer / Release-Candidate Mode (Default)** | Standard local builds, tag pushes (`v*`), or manual workflow dispatches with `enable_signing: false`. | **100% Secret-Free:** Does not require, load, or expect any certificate secrets. Builds proceed using ad-hoc signing (`electron-builder` fallback). Produces fully functional release candidates and installers for testing. |
| **2. Signed Production Mode (Opt-In)** | Explicitly requested via manual `workflow_dispatch` (`enable_signing: true`) or CLI flag (`--require-signing`). | **Secret Enforced:** Requires valid Authenticode certificates (`CSC_LINK` / `WIN_CSC_LINK`) and passwords (`CSC_KEY_PASSWORD` / `WIN_CSC_KEY_PASSWORD`). Fails fast before build if secrets are missing or incomplete. |

### Supported Environment Variables & GitHub Actions Secrets

The pipeline integrates with standard `electron-builder` signing parameters:

| Variable Name | Type | Purpose |
| :--- | :--- | :--- |
| `WIN_CSC_LINK` | File path, HTTPS URL, or base64 string | Windows-specific PKCS#12 certificate (`.pfx` or `.p12`). Takes precedence over `CSC_LINK`. |
| `CSC_LINK` | File path, HTTPS URL, or base64 string | Fallback cross-platform PKCS#12 certificate. |
| `WIN_CSC_KEY_PASSWORD` | Secure string | Decryption password for the `WIN_CSC_LINK` certificate. |
| `CSC_KEY_PASSWORD` | Secure string | Fallback decryption password for the `CSC_LINK` certificate. |

> [!CAUTION]
> **Secret Safety Rule:** Never commit certificate files or secret passwords to Git. The project `.gitignore` strictly excludes `*.pfx`, `*.p12`, `*.cer`, `*.crt`, `*.pem`, `*.key`, `*.snk`, `*.keystore`, and `*.jks`.

### CI Readiness Validator (`scripts/verifySigningEnvironment.cjs`)

To guarantee secret safety and prevent accidental build failures or data leaks in CI logs, the packaging workflow executes `scripts/verifySigningEnvironment.cjs` (`npm run verify:signing`) before packaging:

1. **Redaction & Zero Leaks:** The script never prints, logs, or transmits certificate content, URLs, or passwords. It reports only presence indicators and variable names.
2. **Fail-Fast Error Handling:**
   - If signing was explicitly requested (`enable_signing: true`) but secrets are missing:
     ```
     [ERROR] Code signing was explicitly required (--require-signing / REQUIRE_SIGNING=true), but no signing credentials were found in the environment. Please configure WIN_CSC_LINK / CSC_LINK and WIN_CSC_KEY_PASSWORD / CSC_KEY_PASSWORD.
     ```
   - If a partial configuration is detected (e.g. certificate provided without password):
     ```
     [ERROR] Incomplete signing configuration: CSC_LINK is provided, but required certificate password (WIN_CSC_KEY_PASSWORD or CSC_KEY_PASSWORD) is missing.
     ```
3. **Graceful Fallback:** If signing is not requested and no variables are present, the validator cleanly reports:
   ```
   [INFO] Signing Status: Unsigned Release-Candidate Mode.
   [INFO] No signing credentials detected in environment (WIN_CSC_LINK / CSC_LINK unset).
   [INFO] Packaging will proceed in unsigned (ad-hoc) mode.
   ```

### Hardware Tokens and Azure Trusted Signing

If utilizing an EV (Extended Validation) hardware USB token or cloud-based signing service (such as Azure Trusted Signing):
1. **Azure Trusted Signing:** Install the `Azure.CodeSigning.Dlib` tool and configure custom signing in `electron-builder` via a `sign` hook pointing to `signtool.exe`.
2. **Hardware Tokens:** Ensure SafeNet / certificate middleware is active on the build agent, and reference the certificate thumbprint:
   ```json
   "win": {
     "certificateSha1": "YOUR_CERTIFICATE_THUMBPRINT_HEX",
     "rfc3161TimeStampServer": "http://timestamp.digicert.com"
   }
   ```
3. **Fallback Behavior:** If `CSC_LINK` and `WIN_CSC_LINK` are unset, `electron-builder` automatically falls back to local ad-hoc signing for rapid development and testing.

---

## 9. Packaged E2E Verification Workflow

The project includes two complementary layers of E2E verification:

1. **Development E2E Suite (`npm run test:e2e`):**
   - Runs against the development build via Playwright Electron.
   - Tests file explorer CRUD, multi-terminal workflows, Git staging/branching/diffing, dirty-tab guards, and AI panel interactions.

2. **Packaged Binary E2E Suite (`npm run test:e2e:packaged`):**
   - Launches the actual compiled Windows executable: `dist/win-unpacked/AI IDE.exe`.
   - Validates that the app renders from `app.asar` without packaging errors.
   - Tests workspace folder loading, tree rendering, and file editing in the packaged environment.
   - Confirms Monaco Editor web workers instantiate correctly under the `file://` protocol.
   - Tests real Electron Preload IPC channels (`getSettings`, `readTree`, `readFile`).
   - Asserts clean process teardown without orphaned background processes.

---

## 10. Release Verification Checklist

Perform these verification steps in order before distributing a release build:

- [ ] **Working Tree Check:** Ensure all intended changes are tracked and no sensitive test files or API keys reside in the working directory.
- [ ] **Version Consistency Check:** Run `npm run verify:version [tag]` (e.g. `npm run verify:version v0.1.0-rc1`) — must confirm tag matches `package.json`.
- [ ] **Signing Readiness Check:** Run `npm run verify:signing` — must confirm valid signing variables or confirm unsigned mode.
- [ ] **Typecheck:** Run `npm run typecheck` — must report 0 errors across Node and Web.
- [ ] **Vitest Suite:** Run `npm test` — all unit, component, IPC integration, security, CI workflow, version consistency, and signing readiness tests must pass.
- [ ] **Automated CI Quality Gate:** Verify `.github/workflows/ci.yml` passes on push/PR.
- [ ] **Windows Packaging CI:** Trigger `.github/workflows/windows-package.yml` via tag push (`v*`) or manual `workflow_dispatch`.
- [ ] **Development E2E Suite:** Run `npm run test:e2e` — all Playwright development tests must pass.
- [ ] **Production Build & Packaging:** Run `npm run package:win` — compiles assets and builds `dist/win-unpacked/`.
- [ ] **Packaged E2E Suite:** Run `npm run test:e2e:packaged` — all packaged validation tests must pass against `AI IDE.exe`.
- [ ] **Installer Generation:** Run `npm run dist:win` — generates `dist/AI IDE-Setup-0.1.0-rc1.exe`.
- [ ] **Artifact Integrity Verification:** Confirm `dist/SHA256SUMS.txt` is generated and verify installer checksum with `Get-FileHash`.
- [ ] **Installer Verification:** Confirm installer size (> 80 MB) and verify icon rendering in Windows File Explorer.

### Release Candidate 1 (v0.1.0-rc1) Checklist
- [x] Package version updated to `0.1.0-rc1` across `package.json` and `package-lock.json`.
- [x] Repository hygiene updated (`test-results/`, `playwright-report/`, `coverage/` added to `.gitignore`).
- [x] Version validation script `scripts/verifyReleaseVersion.cjs` tested and passing for `v0.1.0-rc1`.
- [x] Code signing readiness script `scripts/verifySigningEnvironment.cjs` audited and passing.
- [x] Full Vitest suite passing (unit, security, IPC, version consistency).
- [x] TypeScript compilation (`npm run typecheck`) cleanly passes with 0 errors.
- [x] Production build (`npm run build`) cleanly creates `out/` bundles.
- [x] Windows packaged executable and NSIS installer (`AI IDE-Setup-0.1.0-rc1.exe`) compiled in `dist/`.
- [x] Packaged E2E tests (`npm run test:e2e:packaged`) passing against unpacked binary.
- [x] Release notes prepared in `RELEASE_NOTES_v0.1.0-rc1.md` documenting verified features and explicit known limitations.

---

## 11. Troubleshooting & Operational Notes

### 1. Windows File Lock Errors (`EBUSY` or `EPERM` during build)
- **Symptom:** `electron-builder` fails with `EBUSY: resource busy or locked` when writing to `dist/win-unpacked/AI IDE.exe`.
- **Cause:** An instance of `AI IDE.exe` is still running in the background, or Windows Search Indexer / antivirus is scanning the folder.
- **Fix:** Open PowerShell and run `Stop-Process -Name "AI IDE" -Force -ErrorAction SilentlyContinue`, then retry the build command.

### 2. Windows SmartScreen Warning on First Install
- **Symptom:** Windows SmartScreen displays "Windows protected your PC: Unknown Publisher".
- **Cause:** Local development builds are signed with ad-hoc certificates.
- **Fix:** Click **More info** -> **Run anyway**. For public distribution, sign the binary with a trusted EV Authenticode certificate as described in Section 7.

### 3. Monaco Web Worker Initialization in Packaged Mode
- **Symptom:** Monaco Editor shows plaintext without syntax highlighting or throws `TypeError: Failed to fetch dynamically imported module`.
- **Cause:** Under the `file://` protocol in `app.asar`, Chromium blocks module workers using inline data URIs.
- **Fix:** Pre-configured in `src/renderer/src/monacoConfig.ts` via bundled `new Worker(new URL(..., import.meta.url), { type: 'module' })`. Verify that `npm run build` emitted `editor.worker-*.js` and `ts.worker-*.js` to `out/renderer/assets/`.

### 4. Preserved User Configuration Location
- On Windows, settings and workspace indexes reside at:
  - Settings: `%APPDATA%\AI IDE\settings.json`
  - Workspace Indexes: `%APPDATA%\AI IDE\workspace-indexes\*.json`
  - Program Installation: `%LOCALAPPDATA%\Programs\AI IDE\`
