# AI IDE — Release Notes (v0.1.0-rc1)

**Release Candidate 1**  
**Version:** `0.1.0-rc1`  
**Target Platform:** Windows 10 (Build 1809+) & Windows 11 (x64)  
**Date:** October 2026  

---

## 1. Executive Summary

AI IDE `v0.1.0-rc1` represents the first comprehensive Release Candidate for the desktop AI-assisted software engineering environment. This milestone bundles the complete core developer toolchain — including multi-model AI orchestration, Monaco code editor, multi-session terminal, Git source control, and defense-in-depth desktop security — into a production-packaged Windows desktop application.

---

## 2. Core Features & Capabilities

### Multi-Provider AI Architecture
- **Provider Registry:** Unified orchestration layer supporting multiple AI providers:
  - **Google Gemini:** `gemini-1.5-pro`, `gemini-1.5-flash`
  - **OpenRouter:** Multi-model routing (`anthropic/claude-3.5-sonnet`, `deepseek/deepseek-coder`, `openai/gpt-4o`)
  - **OpenCode:** Developer-specialized open-source code models
  - **NVIDIA NIM:** High-throughput accelerated models (`meta/llama-3.1-70b-instruct`)
- **Streaming & Resilience:** Real-time token streaming with `AbortController` cancellation, exponential backoff retries, and strict provider isolation.
- **Mock-Ready Verification:** All tests operate deterministically with full provider mocks without requiring live API keys or incurring API costs.

### Editor & Workspace System
- **Monaco Editor Core:** Full-featured code editor with dedicated language web workers (`editor.worker`, `ts.worker`) operating cleanly under the `file://` protocol.
- **Multi-Tab & Dirty Guards:** Tabbed editing with unsaved modification indicators, dirty-tab closing guards, and external file modification detection and reload prompts.
- **Workspace Navigation:** Fast recursive tree rendering, file creation, renaming, and deletion with atomic file operations and path containment validation.
- **Diff Viewer:** Integrated side-by-side and inline visual diff viewer for side-by-side code review.

### Integrated Terminal & Shell
- **Multi-Session Terminal:** Tabbed terminal interface supporting multiple concurrent shell sessions (PowerShell / Command Prompt).
- **Process Management:** Session isolation with lifecycle cleanup on tab close and application exit.
- **Streaming I/O:** Real-time stdout/stderr streaming with interactive keyboard input support.

### Source Control Integration
- **Git Repository Detection:** Automatic discovery and tracking of local Git repositories.
- **Change Management:** View staged and unstaged file modifications with instant diff previews.
- **Branch Operations:** Real-time branch listing, branch switching, and current branch indicator.
- **Commit Workflow:** Staging/unstaging toggles and commit message creation with validation.

### Desktop Hardening & Security Architecture
- **Process Sandboxing:** Enforced `sandbox: true` across all renderer processes.
- **Context Isolation:** Enforced `contextIsolation: true` with zero direct Node.js access from DOM (`nodeIntegration: false`).
- **Strict Content Security Policy (CSP):** Restricted resource loading preventing inline scripts and unauthorized network origins.
- **Navigation & Popup Restrictions:** Denies unauthorized browser navigation and suppresses `window.open` popups (`action: 'deny'`).
- **Single-Instance Enforcement:** `app.requestSingleInstanceLock()` prevents concurrent instance collisions; secondary executions refocus the primary window.
- **Production DevTools Lockdown:** Intercepts and disables DevTools shortcuts (`F12`, `Ctrl+Shift+I`) when `app.isPackaged` is true.

### Secure & Atomic Settings Persistence
- **DPAPI Encryption (`safeStorage`):** Provider API keys are encrypted at rest using Windows DPAPI (`CryptProtectData`) before being saved to `%APPDATA%\AI IDE\settings.json`.
- **Atomic File Writes:** Settings write pipeline uses unique temporary files and atomic `rename` operations to prevent configuration corruption during power outages or process crashes.
- **Backward Compatibility:** Automatically detects and decrypts legacy plaintext keys, migrating them to DPAPI-encrypted format on the next save.

---

## 3. Packaging & Distribution Artifacts

- **Windows NSIS Installer:** `dist/AI IDE-Setup-0.1.0-rc1.exe`
  - Per-user installation (`perMachine: false`, `oneClick: true`) to `%LOCALAPPDATA%\Programs\AI IDE\`.
  - No Administrator or UAC elevation required.
  - Desktop and Start Menu shortcut creation.
  - User configuration retention across updates (`deleteAppDataOnUninstall: false`).
- **Unpacked Portable Executable:** `dist/win-unpacked/AI IDE.exe`
  - Executable directory with bytecode and assets packaged in `resources/app.asar`.
- **Cryptographic Integrity:** SHA-256 checksums recorded in `dist/SHA256SUMS.txt`.

---

## 4. Verification & Quality Gates

The `v0.1.0-rc1` release candidate has passed all automated quality gates:

| Verification Suite | Count | Result | Scope |
| :--- | :--- | :--- | :--- |
| **Vitest Test Suite** | 590+ tests | **PASSED** | Unit, component, IPC integration, security, CI, and packaging |
| **TypeScript Typecheck** | 2 targets | **PASSED** | Node (`tsconfig.node.json`) & Web (`tsconfig.web.json`) (0 errors) |
| **Vite Production Build** | 3 bundles | **PASSED** | Main process, preload script, renderer, and Monaco workers |
| **Development E2E Suite** | 28 tests | **PASSED** | File CRUD, multi-terminal, Git operations, dirty-tab guards |
| **Packaged E2E Suite** | 4 tests | **PASSED** | Real `AI IDE.exe` launch, `app.asar` loading, Monaco workers, Preload IPC |
| **Version Consistency** | Read-only | **PASSED** | Strict SemVer tag validation (`v0.1.0-rc1` matches `0.1.0-rc1`) |
| **Signing Readiness** | Read-only | **PASSED** | Environment check passes without credential leakage |

---

## 5. Known Limitations & Non-Production Items

1. **Unsigned Windows Binary (SmartScreen Warning):**
   - The RC1 binary is unsigned (built in ad-hoc local signing mode).
   - Windows Defender SmartScreen will show an "Unknown Publisher" prompt upon installation.
   - Users may proceed by selecting **More info** -> **Run anyway**.
   - Authenticode / Azure Trusted Signing certificate integration is planned for the final GA release (Phase 10.4 infrastructure is prepared).

2. **Terminal Emulation Implementation:**
   - The current terminal integration utilizes Node.js `child_process.spawn` with stdio streaming.
   - While effective for standard command execution, CLI builds, Git commands, and package scripts, full-screen curses TUIs (such as `vim` or `htop`) are not supported in this release. Migration to a native PTY backend (`node-pty`) is tracked for future milestones.

3. **Release Candidate Status:**
   - This release candidate (`v0.1.0-rc1`) is intended for verification, pre-release testing, and staging validation.
   - Production cloud deployment and public distribution will occur following final QA and Authenticode signing sign-off.
