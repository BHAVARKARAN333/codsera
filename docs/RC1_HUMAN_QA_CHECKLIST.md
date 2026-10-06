# AI IDE — Release Candidate 1 (v0.1.0-rc1) Human QA Checklist

**Document Version:** 1.0.0  
**Target Release Candidate:** `v0.1.0-rc1`  
**Application Name:** AI IDE (`com.aiide.desktop`)  
**Package Artifact:** `dist/AI IDE-Setup-0.1.0-rc1.exe`  
**Target OS Platform:** Windows 10 (Build 1809+) / Windows 11 (64-bit / x64)  
**Date Created:** October 2026  

---

> [!IMPORTANT]
> ### Critical QA Testing Constraints & Safety Rules
> 1. **DO NOT enter real API keys or credentials.** Under no circumstances should real production API keys (Gemini, OpenRouter, OpenAI, Anthropic, NVIDIA) be input or used during this QA cycle. All testing must be conducted with mock providers, empty keys, or invalid dummy keys to verify graceful error handling.
> 2. **NO live AI API calls.** No network calls to production AI endpoints should be made.
> 3. **Unsigned Binary (Windows SmartScreen):** The RC1 installer is unsigned (built with ad-hoc signing). Windows SmartScreen will display an "Unknown Publisher" prompt. This is expected behavior for RC1. Click **More info** -> **Run anyway** to proceed.
> 4. **Terminal Architecture Limitations:** Terminal emulation uses Node.js `child_process.spawn` with stdio streaming. Full-screen curses/TUI applications (e.g., `vim`, `nano`, `htop`, `less`) are **NOT supported** in this release.
> 5. **Git Remote Operations:** Remote Git operations (`git push`, `git fetch`, `git pull`) are **not implemented** in the UI and must not be tested as required RC features. Only local Git operations (status, diff, stage, unstage, commit, branch switching) are supported.

---

## A. QA Environment & Pre-Flight Verification

| Field | Tester Entry |
| :--- | :--- |
| **Tester Name** | |
| **Test Date & Time** | |
| **Windows OS Version & Build** | |
| **Hardware Architecture** | x64 (64-bit) |
| **Installer File Name** | `AI IDE-Setup-0.1.0-rc1.exe` |
| **Expected SHA-256 Checksum** | `3b1efe62fb96b4cabe1424e2bca408760013228136b276de7675d8025f6241e9` |
| **Computed SHA-256 Checksum** | |
| **Checksum Verification Command** | `Get-FileHash -Path ".\AI IDE-Setup-0.1.0-rc1.exe" -Algorithm SHA256` |

---

## B. Installer & Installation Verification

### Test B.1: Checksum & File Integrity Pre-Check
- **Procedure:**
  1. Open PowerShell in the directory containing `AI IDE-Setup-0.1.0-rc1.exe`.
  2. Run: `(Get-FileHash -Path ".\AI IDE-Setup-0.1.0-rc1.exe" -Algorithm SHA256).Hash.ToLower()`
  3. Compare output with `dist/SHA256SUMS.txt`.
- **Expected:** Computed hash matches `3b1efe62fb96b4cabe1424e2bca408760013228136b276de7675d8025f6241e9` exactly.
- **Status:** `[ ] PASS` &nbsp; `[ ] FAIL` &nbsp; `[ ] BLOCKED` &nbsp; `[ ] NOT APPLICABLE`
- **Actual:**
- **Evidence / Hash:**
- **Severity (if fail):** `[ ] Critical` `[ ] High` `[ ] Medium` `[ ] Low`
- **Notes:**

---

### Test B.2: Installer Launch & Windows SmartScreen Behavior
- **Procedure:**
  1. Double-click `AI IDE-Setup-0.1.0-rc1.exe`.
  2. Observe the Windows Defender SmartScreen banner.
  3. Verify the prompt displays "Windows protected your PC" with publisher "Unknown Publisher".
  4. Click **More info**, then click **Run anyway**.
- **Expected:** SmartScreen warns about Unknown Publisher as expected for unsigned RC1; clicking **Run anyway** immediately starts the installer process without crashing.
- **Status:** `[ ] PASS` &nbsp; `[ ] FAIL` &nbsp; `[ ] BLOCKED` &nbsp; `[ ] NOT APPLICABLE`
- **Actual:**
- **Evidence:**
- **Severity (if fail):** `[ ] Critical` `[ ] High` `[ ] Medium` `[ ] Low`
- **Notes:**

---

### Test B.3: Silent Per-User NSIS Installation
- **Procedure:**
  1. Observe the NSIS progress dialog.
  2. Verify that no Windows UAC (User Account Control) Administrator prompt is shown.
  3. Verify installation target is `%LOCALAPPDATA%\Programs\AI IDE\`.
- **Expected:** Installation completes in under 30 seconds without requiring Windows administrator privileges.
- **Status:** `[ ] PASS` &nbsp; `[ ] FAIL` &nbsp; `[ ] BLOCKED` &nbsp; `[ ] NOT APPLICABLE`
- **Actual:**
- **Evidence:**
- **Severity (if fail):** `[ ] Critical` `[ ] High` `[ ] Medium` `[ ] Low`
- **Notes:**

---

### Test B.4: Desktop & Start Menu Shortcuts
- **Procedure:**
  1. Inspect the Windows Desktop for the "AI IDE" shortcut icon.
  2. Open the Windows Start Menu and search for "AI IDE".
  3. Verify the custom application icon (dark blue gradient with glowing cyan AI chip) renders cleanly on both shortcuts.
- **Expected:** Shortcuts exist on both Desktop and Start Menu, featuring the high-resolution AI IDE application icon.
- **Status:** `[ ] PASS` &nbsp; `[ ] FAIL` &nbsp; `[ ] BLOCKED` &nbsp; `[ ] NOT APPLICABLE`
- **Actual:**
- **Evidence:**
- **Severity (if fail):** `[ ] Critical` `[ ] High` `[ ] Medium` `[ ] Low`
- **Notes:**

---

## C. First Launch & Application Shell

### Test C.1: Clean Startup & Window Initialization
- **Procedure:**
  1. Launch AI IDE from the Desktop shortcut or Start Menu.
  2. Observe application launch and window appearance.
- **Expected:**
  - The main application window opens centered with dimensions ~1280x800 or remembered state.
  - Window title displays "AI IDE".
  - Header bar renders with "AI IDE" logo, "PRO" badge, and empty workspace prompt.
  - No blank white screens, crash dialogs, or unhandled exceptions occur.
- **Status:** `[ ] PASS` &nbsp; `[ ] FAIL` &nbsp; `[ ] BLOCKED` &nbsp; `[ ] NOT APPLICABLE`
- **Actual:**
- **Evidence:**
- **Severity (if fail):** `[ ] Critical` `[ ] High` `[ ] Medium` `[ ] Low`
- **Notes:**

---

### Test C.2: Single-Instance Lock Enforcement
- **Procedure:**
  1. While AI IDE is running, launch a secondary instance by double-clicking the shortcut or executable again.
  2. Observe window behavior.
- **Expected:** No duplicate window or second instance is created. The existing AI IDE window is restored and brought to focus.
- **Status:** `[ ] PASS` &nbsp; `[ ] FAIL` &nbsp; `[ ] BLOCKED` &nbsp; `[ ] NOT APPLICABLE`
- **Actual:**
- **Evidence:**
- **Severity (if fail):** `[ ] Critical` `[ ] High` `[ ] Medium` `[ ] Low`
- **Notes:**

---

### Test C.3: Production DevTools Lockdown
- **Procedure:**
  1. Press `F12` on the keyboard.
  2. Press `Ctrl+Shift+I` on the keyboard.
- **Expected:** DevTools window does NOT open (disabled in packaged production builds).
- **Status:** `[ ] PASS` &nbsp; `[ ] FAIL` &nbsp; `[ ] BLOCKED` &nbsp; `[ ] NOT APPLICABLE`
- **Actual:**
- **Evidence:**
- **Severity (if fail):** `[ ] Critical` `[ ] High` `[ ] Medium` `[ ] Low`
- **Notes:**

---

## D. Workspace & File Explorer

### Test D.1: Open Workspace Directory
- **Procedure:**
  1. Click **Open Workspace** in the header or in the empty state view.
  2. Select a valid test folder containing code files and subfolders (e.g., a sample project).
- **Expected:**
  - Folder opens successfully.
  - Header displays the active workspace folder name.
  - File Explorer tree populates with all top-level files and folders.
- **Status:** `[ ] PASS` &nbsp; `[ ] FAIL` &nbsp; `[ ] BLOCKED` &nbsp; `[ ] NOT APPLICABLE`
- **Actual:**
- **Evidence:**
- **Severity (if fail):** `[ ] Critical` `[ ] High` `[ ] Medium` `[ ] Low`
- **Notes:**

---

### Test D.2: Folder Expansion & Directory Navigation
- **Procedure:**
  1. Click on a folder row in the File Explorer tree to expand it.
  2. Verify subfolders and nested files display with appropriate indentations and file icons.
  3. Click the folder again to collapse it.
- **Expected:** Folder expands and collapses smoothly, revealing nested file tree items.
- **Status:** `[ ] PASS` &nbsp; `[ ] FAIL` &nbsp; `[ ] BLOCKED` &nbsp; `[ ] NOT APPLICABLE`
- **Actual:**
- **Evidence:**
- **Severity (if fail):** `[ ] Critical` `[ ] High` `[ ] Medium` `[ ] Low`
- **Notes:**

---

### Test D.3: Create New File & New Folder
- **Procedure:**
  1. Hover over the File Explorer header and click the **New File** icon (`+` document).
  2. Enter `qa_test_file.ts` and press Enter.
  3. Click the **New Folder** icon (`+` folder).
  4. Enter `qa_test_dir` and press Enter.
- **Expected:** Both file and directory are created immediately on disk in the workspace and appear in the tree.
- **Status:** `[ ] PASS` &nbsp; `[ ] FAIL` &nbsp; `[ ] BLOCKED` &nbsp; `[ ] NOT APPLICABLE`
- **Actual:**
- **Evidence:**
- **Severity (if fail):** `[ ] Critical` `[ ] High` `[ ] Medium` `[ ] Low`
- **Notes:**

---

### Test D.4: Rename & Delete Operations
- **Procedure:**
  1. Hover over `qa_test_file.ts` and click the **Rename** action button.
  2. Change name to `qa_renamed_file.ts` and press Enter.
  3. Verify file updates in the tree.
  4. Click the **Delete** action button on `qa_renamed_file.ts` and confirm the deletion dialog.
  5. Delete `qa_test_dir`.
- **Expected:** Rename updates the tree and filesystem. Delete removes the file/folder from tree and disk.
- **Status:** `[ ] PASS` &nbsp; `[ ] FAIL` &nbsp; `[ ] BLOCKED` &nbsp; `[ ] NOT APPLICABLE`
- **Actual:**
- **Evidence:**
- **Severity (if fail):** `[ ] Critical` `[ ] High` `[ ] Medium` `[ ] Low`
- **Notes:**

---

### Test D.5: File Explorer Refresh
- **Procedure:**
  1. Create a file externally using PowerShell in the workspace: `Set-Content -Path "external.txt" -Value "hello"`.
  2. Click the **Refresh** button in the File Explorer header.
- **Expected:** The newly created file appears immediately in the file tree.
- **Status:** `[ ] PASS` &nbsp; `[ ] FAIL` &nbsp; `[ ] BLOCKED` &nbsp; `[ ] NOT APPLICABLE`
- **Actual:**
- **Evidence:**
- **Severity (if fail):** `[ ] Critical` `[ ] High` `[ ] Medium` `[ ] Low`
- **Notes:**

---

## E. Monaco Editor & Multi-Tab Workflow

### Test E.1: Open File in Monaco Editor
- **Procedure:**
  1. Click any TypeScript/JavaScript/JSON file in the File Explorer.
  2. Observe the editor pane.
- **Expected:**
  - A new editor tab opens with the file name.
  - Monaco Editor mounts without error.
  - Syntax highlighting renders cleanly (Monaco web workers functional under `file://`).
- **Status:** `[ ] PASS` &nbsp; `[ ] FAIL` &nbsp; `[ ] BLOCKED` &nbsp; `[ ] NOT APPLICABLE`
- **Actual:**
- **Evidence:**
- **Severity (if fail):** `[ ] Critical` `[ ] High` `[ ] Medium` `[ ] Low`
- **Notes:**

---

### Test E.2: Edit Content & Dirty State Indicator
- **Procedure:**
  1. In the open editor tab, type modifications into the document.
  2. Inspect the editor tab header.
- **Expected:** A dirty state dot (`•`) indicator appears on the tab header next to the file name.
- **Status:** `[ ] PASS` &nbsp; `[ ] FAIL` &nbsp; `[ ] BLOCKED` &nbsp; `[ ] NOT APPLICABLE`
- **Actual:**
- **Evidence:**
- **Severity (if fail):** `[ ] Critical` `[ ] High` `[ ] Medium` `[ ] Low`
- **Notes:**

---

### Test E.3: Save Changes (`Ctrl+S`)
- **Procedure:**
  1. Press `Ctrl+S` on the keyboard while editing the dirty file.
  2. Check the tab header indicator.
  3. Verify the file content on disk using an external viewer or terminal.
- **Expected:**
  - The dirty indicator disappears immediately.
  - File is persisted atomically to disk without data corruption.
- **Status:** `[ ] PASS` &nbsp; `[ ] FAIL` &nbsp; `[ ] BLOCKED` &nbsp; `[ ] NOT APPLICABLE`
- **Actual:**
- **Evidence:**
- **Severity (if fail):** `[ ] Critical` `[ ] High` `[ ] Medium` `[ ] Low`
- **Notes:**

---

### Test E.4: Multi-Tab Switching & Dirty Tab Protection Guard
- **Procedure:**
  1. Open a second file from the explorer (two tabs now open).
  2. Make an unsaved edit in the second file (dirty indicator appears).
  3. Switch back to the first tab, then back to the second tab.
  4. Attempt to close the dirty tab by clicking its `x` icon.
  5. Observe the confirmation modal.
  6. Click **Cancel** -> Tab remains open and dirty.
  7. Click `x` again and click **Don't Save** -> Tab closes and changes are discarded.
- **Expected:** Unsaved buffer contents are preserved across tab switching. Close confirmation modal guards against accidental data loss.
- **Status:** `[ ] PASS` &nbsp; `[ ] FAIL` &nbsp; `[ ] BLOCKED` &nbsp; `[ ] NOT APPLICABLE`
- **Actual:**
- **Evidence:**
- **Severity (if fail):** `[ ] Critical` `[ ] High` `[ ] Medium` `[ ] Low`
- **Notes:**

---

### Test E.5: External File Modification Sync Prompt
- **Procedure:**
  1. Open a clean file in the editor.
  2. Modify the file externally on disk via PowerShell: `Add-Content -Path "test.txt" -Value "external change"`.
  3. Return to the AI IDE window.
- **Expected:** The editor detects external file modification via filesystem watcher and updates/prompts cleanly without crashing.
- **Status:** `[ ] PASS` &nbsp; `[ ] FAIL` &nbsp; `[ ] BLOCKED` &nbsp; `[ ] NOT APPLICABLE`
- **Actual:**
- **Evidence:**
- **Severity (if fail):** `[ ] Critical` `[ ] High` `[ ] Medium` `[ ] Low`
- **Notes:**

---

### Test E.6: File Re-Click Deduplication & Unsaved Content Preservation
- **Procedure:**
  1. Open a workspace folder.
  2. Click a file (e.g. `package.json` or `test.ts`) in the File Explorer to open it in an editor tab.
  3. Modify content in the editor to make it dirty (unsaved edits).
  4. Open a second file from Explorer (two tabs open).
  5. Click the first (dirty) file again in File Explorer.
- **Expected:**
  - Only ONE tab exists for the file (no duplicate tabs created).
  - The existing tab is activated and focused.
  - Current editor state, cursor, and unsaved dirty modifications are preserved without reloading from disk.
- **Status:** `[x] PASS` &nbsp; `[ ] FAIL` &nbsp; `[ ] BLOCKED` &nbsp; `[ ] NOT APPLICABLE`
- **Actual:** Verified: clicking an already-open file in Explorer reuses and focuses the existing tab, does NOT create duplicate tabs, and preserves unsaved dirty buffer content.
- **Evidence:** Verified manually in interactive QA pass + verified across 7 automated integration tests in `tests/components/EditorDuplicateTabs.test.tsx` and 15 unit tests in `tests/unit/shared/pathUtils.test.ts`.
- **Severity (if fail):** N/A (Fixed and verified before release freeze)
- **Notes:** Bug identified during initial manual QA pass (raw string vs Windows path normalization); resolved via `normalizeFilePath` and `arePathsEqual` before release freeze.


---

## F. Terminal Subsystem

> [!NOTE]
> The terminal subsystem uses Node.js `child_process.spawn` with stdio streaming. Standard CLI commands, package scripts, and batch commands are fully supported. Curses-based full-screen TUI apps (e.g. `vim`, `htop`) are **unsupported**.

### Test F.1: Open Terminal Panel & Spawn Shell
- **Procedure:**
  1. Click the Terminal toggle icon in the activity bar or bottom bar.
  2. Observe the terminal pane appearance.
- **Expected:** Terminal panel opens at the bottom with a default shell session (PowerShell / Command Prompt). Command prompt is visible.
- **Status:** `[ ] PASS` &nbsp; `[ ] FAIL` &nbsp; `[ ] BLOCKED` &nbsp; `[ ] NOT APPLICABLE`
- **Actual:**
- **Evidence:**
- **Severity (if fail):** `[ ] Critical` `[ ] High` `[ ] Medium` `[ ] Low`
- **Notes:**

---

### Test F.2: Command Execution & Stdout Streaming
- **Procedure:**
  1. Type `dir` (or `Get-ChildItem`) into the terminal input and press Enter.
  2. Observe output streaming.
  3. Type `echo "AI IDE terminal verification"` and press Enter.
- **Expected:** Commands execute in the workspace directory. Stdout streams in real-time with proper line breaks and exits cleanly.
- **Status:** `[ ] PASS` &nbsp; `[ ] FAIL` &nbsp; `[ ] BLOCKED` &nbsp; `[ ] NOT APPLICABLE`
- **Actual:**
- **Evidence:**
- **Severity (if fail):** `[ ] Critical` `[ ] High` `[ ] Medium` `[ ] Low`
- **Notes:**

---

### Test F.3: Multi-Session Terminal Tabs
- **Procedure:**
  1. In the terminal header, click the **`+`** (New Terminal) button.
  2. Verify a second terminal tab (e.g., `Terminal 2`) opens.
  3. Run `echo "Session 1"` in Terminal 1.
  4. Switch to Terminal 2 and run `echo "Session 2"`.
  5. Close Terminal 2 using its `x` icon.
- **Expected:** Multiple concurrent terminal sessions maintain independent process lifecycles and isolated outputs. Closing a tab terminates the corresponding child process without leaking resources.
- **Status:** `[ ] PASS` &nbsp; `[ ] FAIL` &nbsp; `[ ] BLOCKED` &nbsp; `[ ] NOT APPLICABLE`
- **Actual:**
- **Evidence:**
- **Severity (if fail):** `[ ] Critical` `[ ] High` `[ ] Medium` `[ ] Low`
- **Notes:**

---

## G. Source Control & Git Integration

> [!NOTE]
> Testing requires opening a workspace that is an initialized local Git repository. Only local Git operations are supported. Remote operations (`push`/`pull`) are intentionally out of scope.

### Test G.1: Repository Detection & Branch Indicator
- **Procedure:**
  1. Open a workspace folder that contains a `.git` repository.
  2. Open the Source Control panel from the activity bar (branch icon).
- **Expected:** Git repository is recognized. The current branch name (e.g., `main` or `master`) is displayed in the panel header and status bar.
- **Status:** `[ ] PASS` &nbsp; `[ ] FAIL` &nbsp; `[ ] BLOCKED` &nbsp; `[ ] NOT APPLICABLE`
- **Actual:**
- **Evidence:**
- **Severity (if fail):** `[ ] Critical` `[ ] High` `[ ] Medium` `[ ] Low`
- **Notes:**

---

### Test G.2: Changed-File Detection & Visual Diff Inspection
- **Procedure:**
  1. Modify a tracked file in the editor.
  2. Create a new untracked file in the workspace.
  3. Inspect the Source Control panel.
  4. Click the modified file to trigger the Diff Viewer.
- **Expected:**
  - Modified file appears under "Changes" (unstaged).
  - Untracked file appears under "Changes" or untracked section.
  - Clicking the file opens the side-by-side / inline Diff Viewer highlighting additions and deletions.
- **Status:** `[ ] PASS` &nbsp; `[ ] FAIL` &nbsp; `[ ] BLOCKED` &nbsp; `[ ] NOT APPLICABLE`
- **Actual:**
- **Evidence:**
- **Severity (if fail):** `[ ] Critical` `[ ] High` `[ ] Medium` `[ ] Low`
- **Notes:**

---

### Test G.3: Stage, Unstage & Discard Changes
- **Procedure:**
  1. Click the **`+`** (Stage) button next to the modified file -> Moves to "Staged Changes".
  2. Click the **`-`** (Unstage) button -> Moves back to "Changes".
  3. Click **Stage All** -> All modified files move to "Staged Changes".
  4. Make an unwanted edit to another file and click **Discard Changes** (undo icon) -> Confirm dialog -> File reverts to `HEAD`.
- **Expected:** Staging and unstaging operate responsively. Discarding cleanly reverts modified file content to HEAD.
- **Status:** `[ ] PASS` &nbsp; `[ ] FAIL` &nbsp; `[ ] BLOCKED` &nbsp; `[ ] NOT APPLICABLE`
- **Actual:**
- **Evidence:**
- **Severity (if fail):** `[ ] Critical` `[ ] High` `[ ] Medium` `[ ] Low`
- **Notes:**

---

### Test G.4: Local Commit Creation
- **Procedure:**
  1. Stage at least one file.
  2. Attempt to click **Commit** without entering a message -> Commit is blocked.
  3. Enter commit message: `test: verified rc1 source control commit`.
  4. Click **Commit**.
- **Expected:** Commit succeeds. Staged changes clear. The working tree reflects the clean state.
- **Status:** `[ ] PASS` &nbsp; `[ ] FAIL` &nbsp; `[ ] BLOCKED` &nbsp; `[ ] NOT APPLICABLE`
- **Actual:**
- **Evidence:**
- **Severity (if fail):** `[ ] Critical` `[ ] High` `[ ] Medium` `[ ] Low`
- **Notes:**

---

### Test G.5: Local Branch Operations
- **Procedure:**
  1. Click the branch selector dropdown / button.
  2. Create a new branch named `rc1-qa-branch`.
  3. Verify the active branch updates to `rc1-qa-branch`.
  4. Switch back to `main` (or previous branch).
- **Expected:** Branch creates and switches cleanly without data loss.
- **Status:** `[ ] PASS` &nbsp; `[ ] FAIL` &nbsp; `[ ] BLOCKED` &nbsp; `[ ] NOT APPLICABLE`
- **Actual:**
- **Evidence:**
- **Severity (if fail):** `[ ] Critical` `[ ] High` `[ ] Medium` `[ ] Low`
- **Notes:**

---

## H. AI & Provider UI (Safe Mock Validation Only)

> [!CAUTION]
> **DO NOT enter real API keys. DO NOT invoke live AI APIs.**

### Test H.1: AI Chat Panel Open & UI Shell
- **Procedure:**
  1. Click the AI Chat toggle button in the activity bar (sparkles icon).
  2. Observe the AI Chat panel.
- **Expected:** Panel opens with welcome state, model selection dropdown, chat history area, and prompt input box with Send button.
- **Status:** `[ ] PASS` &nbsp; `[ ] FAIL` &nbsp; `[ ] BLOCKED` &nbsp; `[ ] NOT APPLICABLE`
- **Actual:**
- **Evidence:**
- **Severity (if fail):** `[ ] Critical` `[ ] High` `[ ] Medium` `[ ] Low`
- **Notes:**

---

### Test H.2: Missing / Unconfigured API Key Graceful Handling
- **Procedure:**
  1. Ensure no API key is entered in Settings.
  2. Type `Hello AI IDE` in the prompt input and click Send.
  3. Observe error handling behavior.
- **Expected:**
  - Application does NOT crash or freeze.
  - A friendly error banner appears explaining that no API key is configured and directing the user to Settings.
- **Status:** `[ ] PASS` &nbsp; `[ ] FAIL` &nbsp; `[ ] BLOCKED` &nbsp; `[ ] NOT APPLICABLE`
- **Actual:**
- **Evidence:**
- **Severity (if fail):** `[ ] Critical` `[ ] High` `[ ] Medium` `[ ] Low`
- **Notes:**

---

### Test H.3: Invalid Dummy Key Error Containment
- **Procedure:**
  1. In Settings, enter a dummy key: `dummy-test-key-not-real`.
  2. Save settings.
  3. Attempt to submit a prompt.
- **Expected:** Application catches the authentication error gracefully, renders an error message in the chat panel, and leaves the editor and terminal completely operational.
- **Status:** `[ ] PASS` &nbsp; `[ ] FAIL` &nbsp; `[ ] BLOCKED` &nbsp; `[ ] NOT APPLICABLE`
- **Actual:**
- **Evidence:**
- **Severity (if fail):** `[ ] Critical` `[ ] High` `[ ] Medium` `[ ] Low`
- **Notes:**

---

## I. Settings, Encryption & Security Architecture

### Test I.1: Settings Modal Access & Input Masking
- **Procedure:**
  1. Click the Settings gear icon in the lower activity bar.
  2. Verify modal opens with fields for:
     - Google Gemini API Key
     - OpenRouter API Key
     - NVIDIA NIM API Key
     - OpenCode API Key
  3. Type test characters into an API key input.
- **Expected:** Modal renders cleanly. Key input fields are masked (`type="password"` or bullet masked) to prevent shoulder-surfing.
- **Status:** `[ ] PASS` &nbsp; `[ ] FAIL` &nbsp; `[ ] BLOCKED` &nbsp; `[ ] NOT APPLICABLE`
- **Actual:**
- **Evidence:**
- **Severity (if fail):** `[ ] Critical` `[ ] High` `[ ] Medium` `[ ] Low`
- **Notes:**

---

### Test I.2: DPAPI Encryption at Rest (`safeStorage`)
- **Procedure:**
  1. In Settings, enter a test dummy string `test-encryption-key-12345` into the Gemini Key field and click **Save**.
  2. Close AI IDE.
  3. Open `%APPDATA%\AI IDE\settings.json` in Notepad or PowerShell.
  4. Inspect the saved value for `geminiApiKey`.
- **Expected:** The stored value is encrypted with the DPAPI prefix: `encrypted:base64:...`. The plaintext string `test-encryption-key-12345` is **nowhere visible** in `settings.json`.
- **Status:** `[ ] PASS` &nbsp; `[ ] FAIL` &nbsp; `[ ] BLOCKED` &nbsp; `[ ] NOT APPLICABLE`
- **Actual:**
- **Evidence:**
- **Severity (if fail):** `[ ] Critical` `[ ] High` `[ ] Medium` `[ ] Low`
- **Notes:**

---

### Test I.3: External URL Link Security Handling
- **Procedure:**
  1. If any documentation, release note, or external link is clicked in the UI.
  2. Observe window behavior.
- **Expected:** External links open in the default system browser (e.g. Edge/Chrome) via `shell.openExternal`. No in-app browser navigation occurs within the Electron window.
- **Status:** `[ ] PASS` &nbsp; `[ ] FAIL` &nbsp; `[ ] BLOCKED` &nbsp; `[ ] NOT APPLICABLE`
- **Actual:**
- **Evidence:**
- **Severity (if fail):** `[ ] Critical` `[ ] High` `[ ] Medium` `[ ] Low`
- **Notes:**

---

## J. Packaging, Persistence & Clean Uninstallation

### Test J.1: State Persistence Across Application Restart
- **Procedure:**
  1. With a workspace open and a file open in the editor, close AI IDE (`Alt+F4` or window `X`).
  2. Relaunch AI IDE from the Desktop shortcut.
  3. Observe initial state.
- **Expected:** AI IDE restores the previously opened workspace automatically.
- **Status:** `[ ] PASS` &nbsp; `[ ] FAIL` &nbsp; `[ ] BLOCKED` &nbsp; `[ ] NOT APPLICABLE`
- **Actual:**
- **Evidence:**
- **Severity (if fail):** `[ ] Critical` `[ ] High` `[ ] Medium` `[ ] Low`
- **Notes:**

---

### Test J.2: Clean Uninstallation via Windows Settings / Control Panel
- **Procedure:**
  1. Open Windows **Settings** -> **Apps** -> **Installed apps** (or **Add/Remove Programs** in Control Panel).
  2. Locate **AI IDE** (version `0.1.0-rc1`).
  3. Click **Uninstall** and confirm.
  4. Observe uninstallation process.
- **Expected:**
  - Uninstaller runs without error.
  - Program directory `%LOCALAPPDATA%\Programs\AI IDE\` is completely removed.
  - Desktop and Start Menu shortcuts are deleted.
- **Status:** `[ ] PASS` &nbsp; `[ ] FAIL` &nbsp; `[ ] BLOCKED` &nbsp; `[ ] NOT APPLICABLE`
- **Actual:**
- **Evidence:**
- **Severity (if fail):** `[ ] Critical` `[ ] High` `[ ] Medium` `[ ] Low`
- **Notes:**

---

### Test J.3: User Configuration Retention on Uninstall
- **Procedure:**
  1. After uninstallation completes, inspect `%APPDATA%\AI IDE\`.
  2. Check whether `settings.json` is preserved.
- **Expected:** Per `deleteAppDataOnUninstall: false` in NSIS configuration, user preferences (`settings.json`) remain intact for future updates and reinstalls.
- **Status:** `[ ] PASS` &nbsp; `[ ] FAIL` &nbsp; `[ ] BLOCKED` &nbsp; `[ ] NOT APPLICABLE`
- **Actual:**
- **Evidence:**
- **Severity (if fail):** `[ ] Critical` `[ ] High` `[ ] Medium` `[ ] Low`
- **Notes:**

---

## K. End-to-End Realistic Stability Workflow

Execute the following continuous developer workflow sequence in a single session:

```
[Launch App] ──► [Open Workspace] ──► [Edit File] ──► [Save Ctrl+S]
      │
      ▼
[Open Terminal] ──► [Run Build/Test Command] ──► [Inspect Output]
      │
      ▼
[Open Source Control] ──► [Inspect Diff] ──► [Stage] ──► [Commit]
      │
      ▼
[Close App] ──► [Relaunch App] ──► [Verify Restored State]
```

### Stability Observations & Incident Log:
- **Crashes:** `[ ] NONE` &nbsp; `[ ] OBSERVED (Describe below)`
- **Freezes / UI Locks:** `[ ] NONE` &nbsp; `[ ] OBSERVED (Describe below)`
- **Blank Windows / Renderer Crashes:** `[ ] NONE` &nbsp; `[ ] OBSERVED (Describe below)`
- **IPC Communication Failures:** `[ ] NONE` &nbsp; `[ ] OBSERVED (Describe below)`
- **Data Loss / Unsaved Buffer Loss:** `[ ] NONE` &nbsp; `[ ] OBSERVED (Describe below)`
- **Memory / Performance Anomalies:** `[ ] NONE` &nbsp; `[ ] OBSERVED (Describe below)`

**Detailed Incident Notes (if any):**

---

## RC1 Human QA Summary & Release Sign-Off

### Verification Breakdown & Current Status

#### 1. Automated Verification (Fully Executed & Passed)
All automated quality gates for `v0.1.0-rc1` have completed with 100% pass rates:
- **Vitest Full Suite:** 612/612 passed across 41 test files (unit, component, IPC integration, security, packaging)
- **Development E2E Suite:** 28/28 passed (Playwright Electron)
- **Packaged Binary E2E Suite:** 4/4 passed (Real `AI IDE.exe` packaged binary execution)
- **Packaged Smoke Test:** 2/2 passed
- **TypeScript Compilation:** 0 errors across Node (`tsconfig.node.json`) and Web (`tsconfig.web.json`)
- **Production Bundle Build:** Succeeded cleanly (`electron-vite build`)
- **Release Version Validation:** Passed (`v0.1.0-rc1` strictly matches `0.1.0-rc1`)
- **Signing Readiness Verification:** Passed (safe unsigned release-candidate mode)
- **Artifact Integrity:** SHA-256 verified for `AI IDE-Setup-0.1.0-rc1.exe` (`3b1efe62fb96b4cabe1424e2bca408760013228136b276de7675d8025f6241e9`)

#### 2. Completed Manual Verification
- **Test E.6 (Duplicate Editor Tab & Unsaved Content Preservation): `PASS`**
  - **Issue Identified:** In preliminary manual testing, clicking an already-open file from the File Explorer opened duplicate editor tabs and clobbered unsaved edits due to Windows path slash mismatches (`/` vs `\`).
  - **Resolution:** Root cause resolved using canonical path normalization (`normalizeFilePath` and `arePathsEqual`) before release freeze.
  - **Manual Retest Result:** **PASS** — clicking an already-open file in File Explorer activates and focuses the existing tab without creating duplicate tabs, and completely preserves unsaved dirty edits, buffer contents, and cursor position.
  - **Automated Regression Coverage:** Verified by 7 dedicated integration tests in `tests/components/EditorDuplicateTabs.test.tsx` and 15 unit tests in `tests/unit/shared/pathUtils.test.ts`.

#### 3. Remaining Manual Verification (Target-Machine Matrix)
The remaining manual test cases in this checklist (Sections B, C, D, F, G, H, I, J, K) represent the target-machine validation matrix (SmartScreen UX on fresh machines, Start Menu shortcut integration on different Windows versions, edge-case uninstallation cycles). These are designated for final manual acceptance testing on target Windows machines prior to promoting RC1 to General Availability (GA).

### Summary Metrics
| Metric | Count |
| :--- | :--- |
| **Total Test Cases In Checklist** | 28 |
| **Automated Tests Passed** | 612 (Vitest) + 32 (E2E/Smoke) |
| **Manual Test Cases Verified (RC1 Freeze Gate)** | 1 (Test E.6: Duplicate Tab & Dirty Preservation) |
| **Manual Test Cases Pending Target-Machine QA** | 27 |
| **Active Blocking Regressions** | 0 |
| **Critical Severity Issues** | 0 |
| **High Severity Issues** | 0 |
| **Medium Severity Issues** | 0 |
| **Low Severity Issues** | 0 |

---

### Final Release Decision

Choose exactly one verdict:

- `[ ]` **APPROVE RC1 (Unconditional)** — All mandatory test cases passed; zero Critical or High issues.
- `[ ]` **APPROVE RC1 WITH CONDITIONS** — Release Candidate is approved for pre-release validation and staging; known limitations (unsigned binary SmartScreen prompt, child_process terminal) documented.
- `[ ]` **REJECT RC1** — Blocking regressions, crash on launch, or data loss encountered.

---

### Sign-Off Approvals

| Role | Name | Signature / Sign-Off | Date |
| :--- | :--- | :--- | :--- |
| **QA Lead / Tester** | | | |
| **Release Engineer** | | | |
| **Product / Project Lead** | | | |

---

## Appendix: Summary of Known RC1 Conditions & Limitations

1. **Unsigned Windows Binary:** The installer `AI IDE-Setup-0.1.0-rc1.exe` is unsigned. Windows SmartScreen displays "Unknown Publisher" upon execution. Click **More info** -> **Run anyway**.
2. **Terminal Emulation Architecture:** Terminal uses Node.js `child_process.spawn` with stdio streaming. Standard batch, shell, and build CLI commands are supported; curses-based interactive full-screen TUIs (`vim`, `htop`, `less`) are unsupported.
3. **Local-Only Git:** Remote Git operations (`push`, `pull`, `fetch`, remote credentials) are not implemented in the UI.
4. **Mocked AI Evaluation:** Real API credentials and live external AI API calls must not be used during testing.
5. **Release Candidate Status:** `v0.1.0-rc1` is an engineering release candidate intended for stabilization, pre-flight verification, and packaging validation prior to General Availability (GA).
