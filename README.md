# Stashpad Preview

An independent, local-only Mac notes alpha using SvelteKit 3 static client assets, Svelte 5, CodeMirror 6, Tauri 2, and native SQLite. This is the accepted desktop stack. No original Stashpad code, assets, note data, or import behavior is included.

Capture notes in a persistent bottom composer, then read full saved Markdown in a scrollable stream. Select a card to edit its raw source inline, copy its Markdown, or delete it. New captures append; editing keeps cards in place. Accounts, synchronization, mobile, signing, distribution, and legacy import remain outside this increment.

## Capture and edit

Enter saves, Shift+Enter adds a line or continues a list, and Command+Enter also saves. Empty captures are rejected, and the composer clears only after acknowledgment. Markdown delimiters remain visible while emphasis, headings, lists, and code are styled. Standard copy, paste, selection, and undo operate on the actual source. LF, CRLF, and mixed source separators remain intact through edits and undo. New typed line breaks use the existing first separator, or LF when the document has none. Raw paste/input separators are retained when the browser exposes them; OS clipboard conversion remains a platform limit.

Single click selects a card. Double click, Edit note, or E opens inline editing; Enter/Save edit commits, and Escape/Cancel edit discards that note's unfinished edit. Switching to New note retains an edit for resuming. Composer and inline drafts are independent; Escape from the composer preserves its text and focuses the stream. Search filters saved source case-insensitively, keeps capture available, and labels any active edit outside the results.

Command+N or Space outside controls focuses capture. Command+F or / focuses search; Escape clears search and focuses the stream. Up/Down selects cards, E edits, C copies exact saved Markdown (or the visible active edit), and Command+Backspace deletes the selection. Single-letter shortcuts leave text inputs, selection, composition, and confirmations alone. Copy failure is shown without changing source.

Saved rendering uses markdown-it with raw HTML disabled. Images become descriptive text and never fetch. JS/TS/JSON fences use Lezer highlighting; other code is escaped. Only explicit HTTP(S)/mailto link activation may open an external application; native validation repeats the frontend scheme/length checks. The narrow native clipboard command writes text only. Neither plugin grants frontend file-opening, shell, clipboard-reading, or general opener permissions.

## Run and verify

Use Node 24.21.0, pnpm 12.4.1, Rust 1.99.1, and the macOS Xcode command-line prerequisites. Direct package and crate versions are pinned; commit both lockfiles when deliberately updating them. Select the required Node and Rust toolchains in your shell before running commands, including Tauri's child commands.

```sh
pnpm install --frozen-lockfile
pnpm dev
pnpm tauri:dev
pnpm verify
pnpm tauri:build
```

`dev` opens a web development server; native storage requires `tauri:dev`. The browser-only synthetic workspace is available at `http://127.0.0.1:4511/?fixture` during development; add `&visual` for fixed public Markdown examples. It uses an in-memory test repository that resets on reload, not SQLite or a native profile. The ordinary browser URL does not provide a browser persistence fallback.

`check` runs Kit type generation, Svelte/TypeScript checks, and formatting. `test:unit` checks framework-neutral policy and controller ordering. `test:browser` starts a strict loopback fixture server at port 4611 and runs Chromium tests with an injected synthetic repository. Install Playwright's matching Chromium if absent. The normal development server uses strict loopback port 4511. `build:web` produces static `build/` assets with no runtime server; `tauri:build` produces an unsigned aarch64 Mac `.app` without a DMG, signing, or publication. Rust tests use disposable file databases and validate actual SQLite persistence and recovery. Browser tests establish browser behavior, not native WebKit, IME, or screen-reader acceptance.

Kit 3 config lives in `vite.config.ts`; `src/routes/+layout.ts` disables SSR. The sole root route mounts the workspace. Browser fixture code is behind a development-only branch and must not appear in production client assets. No server routes, remote functions, or application network service are present.

## Persistence and backups

Saving is explicit. Drafts checkpoint after 300 ms idle and flush before deliberate navigation, export, restore, and normal close. “Saved” appears only after native acknowledgment. Input typed during a save remains an unfinished draft. Forced termination or power loss can lose input before its checkpoint; ordinary close failures keep the window open with retry or an explicit discard-and-close choice.

Delete is soft, with one persistent Undo delete target. Unsaved edits require explicit discard confirmation. Undo restores saved source. Older deleted rows remain in backups; there is no permanent-delete or trash browser control.

Native storage is `notes.sqlite3` under the isolated `tech.barbajoe.stashpad.preview` application data directory (`~/Library/Application Support/tech.barbajoe.stashpad.preview` on macOS). The product/window name is Stashpad Preview. New profiles start empty; no experimental or original-app data is migrated or seeded. Never point this app at the original Stashpad store. Database read failure offers Retry instead of silently loading an empty workspace.

Export uses a native destination dialog and atomic temporary-file replacement. BackupV1 contains `{format, version, exportedAt, workspace}`, with notes, drafts, and nullable `undoDeleteId` inside `workspace`. Restore validates the complete input, stages an immutable snapshot, shows replacement counts, and requires confirmation. Draft and Undo delete references must use the exact spelling of their note ID; uppercase UUIDs with matching references remain valid, and case-ambiguous duplicate IDs are rejected. It first writes a safety backup into the app data directory's `backups` folder, then replaces all rows transactionally. Failed backup writes or transactions retain the old workspace and allow retry. Cancelled dialogs are neutral.

Current alpha capacities are 10,000 notes, 10,001 drafts, 1 MiB UTF-8 per Markdown field, and 10 MiB for the complete compact backup envelope. Every prospective save/checkpoint/mutation checks these bounds and references before committing. Changes to these limits require explicit validation and recovery consideration.

Client rendering errors show a readable diagnostic panel and an explicit Reload view control. Submitted notes may already be saved; uncheckpointed input may be lost on reload. Diagnostics retain only a reference, app version, time, error class/status, and sanitized app-module locations. At most three small records stay in browser local storage, with three write attempts per page load; storage failure does not block the panel. Select the displayed details to copy them when reporting a problem. Note contents, raw error messages, arbitrary paths, and query strings are excluded, and nothing is sent to a service.

## Native acceptance

Run the packaged `.app` without Vite. Use synthetic notes and native dialogs to check offline reopen, exact Markdown/caret behavior, commands, draft close/reopen, delete/undo, and backup/restore. Confirm keyboard focus, 800×600 reflow at 150% text, and actual IME input separately. Browser tests include a synthetic composition event, which does not establish native IME acceptance. Record source/build identity, environment, results, and omissions under an ignored dated `.projects/` folder.

Automated adoption verification does not establish packaged native behavior. Native builds and smoke checks are separate gates; record any unperformed steps explicitly. Use only the Preview profile and synthetic data. Do not access the installed original app, personal stores, or experimental profiles.

For debug-only native failure checks, set `STASHPAD_ALPHA_TEST_FAILURE_FILE` to a task-owned text file before launching the debug executable. File content `load`, `save`, or `checkpoint` rejects that operation before mutation; clear the file to retry. This environment seam is compiled out of release builds and has no product UI control. The historical environment variable name is retained for compatibility. Debug failure checks do not establish release acceptance.

## Boundaries

Domain/search/backup/rendering policy is in `src/lib/domain`; the framework-neutral controller owns keyed edit buffers, draft revisions, and serialized persistence in `src/lib/workspace`; successful save/cancel/delete affects only its buffer, while successful restore replaces all buffers; the typed command boundary is in `src/lib/platform`; Svelte components own view/CodeMirror lifecycle. Rust model, store, backup, and narrow commands live in `src-tauri/src`. Later sync can operate behind the repository boundary, but revisions, ordering, conflicts, authentication, and recovery require a separate design. Mobile platform integration and editor/keyboard acceptance are also separate work. Accounts, network sync, phones, attachments, nesting, signing, distribution, and legacy import are outside this alpha.

See [AGENTS.md](AGENTS.md) for repository responsibilities and [.projects/README.md](.projects/README.md) for evidence retention. No public license is selected; the project is independent of the original Stashpad team.
