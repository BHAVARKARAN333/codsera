# RC1 Release Sign-Off

**Application:** AI IDE (`com.aiide.desktop`)  
**Version:** `v0.1.0-rc1` (`0.1.0-rc1`)  
**Target Platform:** Windows 10 (Build 1809+) & Windows 11 (x64)  
**Date:** October 2026  
**Document Status:** Final Sign-Off & Release Freeze  

---

## A. Release Candidate Status

- **Current Version:** `0.1.0-rc1` (Git tag target: `v0.1.0-rc1`)
- **Primary RC Artifact:** `dist/AI IDE-Setup-0.1.0-rc1.exe`
- **Portable Unpacked Artifact:** `dist/win-unpacked/AI IDE.exe`
- **Release Status:** Local RC1 frozen and approved for further release consideration. (This represents a frozen local Release Candidate, **not** a public General Availability / GA release.)

---

## B. Automated Verification Summary

All automated verification pipelines have been executed locally and verified:

| Verification Suite | Target / Command | Result | Pass Rate / Scope |
| :--- | :--- | :--- | :--- |
| **Vitest Full Test Suite** | `npm test` | **PASSED** | 612 / 612 tests across 41 test files (unit, component, IPC integration, security, packaging) |
| **Development E2E Suite** | `npm run test:e2e` | **PASSED** | 28 / 28 Playwright Electron development tests |
| **Packaged Binary E2E Suite** | `npm run test:e2e:packaged` | **PASSED** | 4 / 4 Playwright tests against compiled `dist/win-unpacked/AI IDE.exe` |
| **Packaged Application Smoke Test** | `tests/smoke/packagedApp.test.ts` | **PASSED** | 2 / 2 packaged process lifecycle and launch smoke tests |
| **TypeScript Typecheck** | `npm run typecheck` | **PASSED** | 0 errors across Node (`tsconfig.node.json`) and Web (`tsconfig.web.json`) |
| **Production Build** | `npm run build` | **PASSED** | Succeeded in 1m 21s (`out/main/`, `out/preload/`, `out/renderer/` bundles) |
| **Release Version Validation** | `npm run verify:version v0.1.0-rc1` | **PASSED** | Exact match between tag `v0.1.0-rc1` and `package.json` (`0.1.0-rc1`) |
| **Signing Readiness Audit** | `npm run verify:signing` | **PASSED** | Validated secret-free fallback mode without leaking credentials or variables |

---

## C. Artifact Verification

The Windows distribution artifacts in `dist/` have been generated and cryptographically verified:

- **Installer Filename:** `AI IDE-Setup-0.1.0-rc1.exe`
- **Installer File Size:** 97,342,268 bytes (~92.8 MB)
- **SHA-256 Checksum:** `3b1efe62fb96b4cabe1424e2bca408760013228136b276de7675d8025f6241e9`
- **Checksum Verification Status:** **VERIFIED** (computed hash strictly matches record in `dist/SHA256SUMS.txt`)
- **Packaged Executable:** `dist/win-unpacked/AI IDE.exe` (180,849,664 bytes ~ 172.5 MB)
- **ASAR Archive:** `dist/win-unpacked/resources/app.asar` present with bundled production bytecode, assets, and Monaco workers
- **Application Icon:** Embedded multi-resolution icon (`build/icon.ico`) compiled into PE headers and NSIS installer

---

## D. Manual QA & Defect Resolution

During preliminary manual verification of the RC1 build, one user experience issue was detected, addressed, and verified before freezing:

### Defect: Duplicate Editor Tabs & Buffer Overwrite on Explorer Re-Click
- **Observation:** In the Monaco editor tab subsystem, clicking an already-open file from the File Explorer opened a duplicate tab for the same file and re-read file content from disk, discarding unsaved edits.
- **Root Cause:** Path representation divergence between Windows native backslashes (`C:\workspace\file.ts`) and renderer forward slashes (`C:/workspace/file.ts`), paired with raw string equality tab lookup in `App.tsx`.
- **Pre-Freeze Resolution:**
  - Implemented pure TypeScript path normalization and canonical comparison utilities in `src/shared/pathUtils.ts` (`normalizeFilePath`, `arePathsEqual`).
  - Updated `App.tsx` tab lookup and handlers to canonicalize paths, immediately activate existing open tabs, and skip disk reads when a tab is already loaded.
  - Preserved unsaved buffer contents, dirty flags, and cursor state upon re-clicking open files.
  - Ensured distinct files with identical basenames in different directories remain separate tabs.
- **Manual Retest Result:** **PASS**
  - Repeated clicking of open files in File Explorer focuses the existing tab without creating duplicate tabs.
  - Unsaved dirty modifications are completely preserved without disk overwrite.
- **Automated Regression Suite:** 15 unit tests in `tests/unit/shared/pathUtils.test.ts` and 7 component integration tests in `tests/components/EditorDuplicateTabs.test.tsx` pass.

---

## E. Known Conditions & Non-Production Items

Only verified and documented project conditions are listed below:

1. **Unsigned Windows Binary (SmartScreen Unknown Publisher):**
   - The RC1 installer is unsigned (built with `electron-builder` ad-hoc local signing).
   - Microsoft Defender SmartScreen displays an "Unknown Publisher" prompt on fresh Windows installations. Users must click **More info** $\to$ **Run anyway**.
   - Authenticode / Azure Trusted Signing is architecturally prepared (`Phase 10.4`) and will be applied prior to GA.
2. **Terminal Backend Architecture:**
   - Terminal emulation uses Node.js `child_process.spawn` with streaming standard I/O.
   - Standard build tools, scripts, batch commands, and shell utilities execute properly.
   - Full-screen curses/TUI applications (e.g. `vim`, `nano`, `htop`, `less`) are unsupported. Migration to a native pseudo-terminal (`node-pty`) is tracked for post-v0.1.0 milestones.
3. **Local-Only Git Integration:**
   - Source control features support local Git repositories (status, diffs, stage/unstage, commit, branch switching). Remote operations (`push`, `pull`, `fetch`, remote credentials) are out of scope for v0.1.0.
4. **Pre-Release Candidate Scope:**
   - `v0.1.0-rc1` is an engineering Release Candidate intended for staging, verification, and human QA. It is not yet a General Availability (GA) production release.

---

## F. Release Freeze Rules

Effective immediately upon sign-off:

1. **Strict Code & Feature Freeze:**
   - **No product feature additions.**
   - **No source code modifications or refactoring.**
   - **No dependency additions, removals, or version upgrades.**
2. **Version & Packaging Immutability:**
   - **No modifications to `package.json` or `package-lock.json` versions.**
   - **No regeneration or rebuilding of the RC1 installer artifact.**
   - **No changes to CI/CD workflows (`ci.yml`, `windows-package.yml`).**
3. **Breach Protocol:**
   - Any further modification to application source, dependencies, or packaging configuration invalidates this sign-off and requires either the creation of a subsequent release candidate (`v0.1.0-rc2`) or explicit stakeholder authorization to reopen the release cycle.

---

## G. Final Decision

### Verdict: **APPROVED FOR RC1 FREEZE**

**Classification Statement:**  
Local Release Candidate 1 (`v0.1.0-rc1`) is formally frozen and approved for further release consideration and human QA testing on target Windows environments. This decision certifies local readiness and artifact integrity; it does **not** constitute a public General Availability (GA) release or authorization to publish.

---

## H. Future GA Promotion Requirements

To promote `v0.1.0-rc1` to a final `v0.1.0` General Availability (GA) production release, the following steps must be independently completed and authorized:

1. **Authenticode Digital Code Signing:**
   - Provision trusted production code-signing certificates (EV Hardware Token or Azure Trusted Signing).
   - Execute signed release packaging via `npm run dist:win` with `WIN_CSC_LINK` / `CSC_LINK` configured, eliminating the Windows SmartScreen "Unknown Publisher" warning.
2. **Full Human QA Acceptance on Target Machines:**
   - Execute the remaining manual test matrix in `docs/RC1_HUMAN_QA_CHECKLIST.md` across clean target Windows 10 and Windows 11 customer installations.
   - Obtain completed tester sign-offs across all checklist sections.
3. **Formal GA Promotion Decision:**
   - Explicit project stakeholder sign-off to finalize the version from `0.1.0-rc1` to `0.1.0`.
   - Update release documentation and tag `v0.1.0`.
4. **Authorized Publishing Pipeline:**
   - Formal authorization to upload installer artifacts to public release channels or GitHub Releases.

---

*Sign-Off Document Generated: October 2026*  
*AI IDE Engineering Team*
