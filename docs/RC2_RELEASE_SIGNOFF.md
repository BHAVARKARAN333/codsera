# RC2 Release Sign-Off

**Application:** AI IDE (`com.aiide.desktop`)  
**Version:** `v0.1.0-rc2` (`0.1.0-rc2`)  
**Target Platform:** Windows 10 (Build 1809+) & Windows 11 (x64)  
**Date:** October 2026  
**Document Status:** Final Sign-Off & Release Freeze  

---

## Final Release Status

```
APPROVED FOR RC2 FREEZE
```

**Meaning:**
- Local RC2 candidate is frozen.
- No public release is authorized by this task.
- GA promotion requires a separate decision.

---

## 1. Version Verification

- **Target Release Tag:** `v0.1.0-rc2`
- **`package.json` Version:** `0.1.0-rc2`
- **`package-lock.json` Root Version:** `0.1.0-rc2`
- **Version Verification Command:** `npm run verify:version v0.1.0-rc2`
- **Result:** **PASSED** (Exit Code: 0)
- **Validation Output:** `[SUCCESS] Release version verified: Git tag "v0.1.0-rc2" matches package.json version "0.1.0-rc2".`

---

## 2. Automated Quality Gate Results

All automated quality pipelines have been executed locally and verified:

| Quality Gate | Command | Result | Details / Pass Rate |
| :--- | :--- | :--- | :--- |
| **Vitest Full Test Suite** | `npm test` | **PASSED** | 622 / 622 tests across 42 test files (100% pass rate) |
| **TypeScript Typecheck** | `npm run typecheck` | **PASSED** | 0 errors across Node (`tsconfig.node.json`) and Web (`tsconfig.web.json`) |
| **Production Build** | `npm run build` | **PASSED** | Succeeded in 1m 17s (`out/main/`, `out/preload/`, `out/renderer/`) |
| **Packaged Application Smoke Test** | `npx vitest run tests/smoke/packagedApp.test.ts` | **PASSED** | 2 / 2 tests (size verification & clean launch/exit lifecycle) |
| **Packaged Playwright E2E Suite** | `npm run test:e2e:packaged` | **PASSED** | 4 / 4 tests against compiled `dist/win-unpacked/AI IDE.exe` (8.0s) |
| **Release Version Validator** | `npm run verify:version v0.1.0-rc2` | **PASSED** | Tag and package manifest match strictly |

---

## 3. RC2 Distribution Artifact Verification

The Windows distribution artifacts in `dist/` have been generated and cryptographically verified:

- **RC2 Installer Filename:** `AI IDE-Setup-0.1.0-rc2.exe`
- **Installer File Size:** 97,343,629 bytes (~92.8 MB)
- **SHA-256 Checksum:** `94cab4accce2cb4ef6c76bb3b4ca63f3fbd7fe03659bd3617b46cc14b5519235`
- **Checksum Verification Status:** **VERIFIED** (computed hash strictly matches record in `dist/SHA256SUMS.txt`)
- **Packaged Executable:** `dist/win-unpacked/AI IDE.exe`
- **ASAR Archive:** `dist/win-unpacked/resources/app.asar` present with bundled production bytecode, assets, and Monaco workers
- **Application Icon:** Embedded multi-resolution icon (`build/icon.ico`) compiled into PE headers and NSIS installer

---

## 4. Manual AI QA Record

The following manual AI reliability tests were verified during RC2 validation:

### A. list_files success
**Result: PASS**
- Actual workspace listing returned.
- No fabricated listing produced.

### B. read_file failure
**Result: PASS**
- Nonexistent file requested.
- `read_file` failed as expected.
- Assistant clearly reported file-not-found error.
- No fabricated content produced.

### C. Git branch accuracy
**Result: PASS**
- Actual workspace branch: `qa-test`.
- Assistant reported `qa-test`.
- No stale or fabricated `master`/`main` claim.

### D. create_file workflow
**Result: PASS**
- Permission confirmation displayed in UI before creation.
- `create_file` completed upon approval.
- File content was correct.
- QA file was deleted after testing.

---

## 5. Known Conditions

The following known conditions remain active for the RC2 pre-release candidate:

1. **Windows binary is unsigned:**
   - The installer is built without an Authenticode certificate.
   - Microsoft Defender SmartScreen may display an "Unknown Publisher" warning on fresh installations.
2. **Terminal emulation backend:**
   - Terminal uses Node.js `child_process.spawn` / standard I/O rather than `node-pty`.
   - Full-screen curses/TUI applications (e.g. `vim`, `nano`, `htop`, `less`) are unsupported.
3. **Local-only Git scope:**
   - Git remote operations (`push`, `pull`, `fetch`, remote credentials) remain out of scope for v0.1.0.
4. **Pre-release candidate scope:**
   - RC2 is still a pre-release candidate, not a General Availability (GA) production release.

---

## 6. Release Freeze Rule

After RC2 freeze:
- **No feature changes.**
- **No unrelated refactors.**
- **No dependency upgrades.**
- **No version changes.**
- **No installer modification.**

If a new bug is discovered, reopen the freeze and create RC3 if necessary.
