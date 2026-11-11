# Stashpad Preview

An independent, local-only Mac notes alpha using SvelteKit 3 static client assets, Svelte 5, CodeMirror 6, Tauri 2, and native SQLite. This is the accepted desktop stack. No original Stashpad code, assets, note data, or import behavior is included.

The adopted foundation currently uses a flat saved-note list and a separate Markdown editor. A compact rendered note stream, persistent composer, and inline editing are the next authorized increment; they are not yet supported. Accounts, synchronization, mobile, signing, distribution, and legacy import remain outside this increment.

## Run and verify

Use Node 24.21.0, pnpm 12.4.1, Rust 1.99.1, and the macOS Xcode command-line prerequisites. Direct package and crate versions are pinned; commit both lockfiles when deliberately updating them. Select the required Node and Rust toolchains in your shell before running commands, including Tauri's child commands.

```sh
pnpm install --frozen-lockfile
pnpm dev
pnpm tauri:dev
pnpm verify
pnpm tauri:build
```

`dev` opens a web development server; native storage requires `tauri:dev`. The browser-only synthetic workspace is available at `http://127.0.0.1:4511/?fixture` during development. It uses an in-memory test repository that resets on reload, not SQLite or a native profile. The ordinary browser URL does not provide a browser persistence fallback.

`check` runs Kit type generation, Svelte/TypeScript checks, and formatting. `test:unit` checks framework-neutral policy and controller ordering. `test:browser` starts a strict loopback fixture server at port 4611 and runs Chromium tests with an injected synthetic repository. Install Playwright's matching Chromium if absent. The normal development server uses strict loopback port 4511. `build:web` produces static `build/` assets with no runtime server; `tauri:build` produces an unsigned aarch64 Mac `.app` without a DMG, signing, or publication. Rust tests use disposable file databases and validate actual SQLite persistence and recovery. Browser tests establish browser behavior, not native WebKit, IME, or screen-reader acceptance.

Kit 3 config lives in `vite.config.ts`; `src/routes/+layout.ts` disables SSR. The sole root route mounts the workspace. Browser fixture code is behind a development-only branch and must not appear in production client assets. No server routes, remote functions, or application network service are present.

## Editing and recovery

The flat saved-note list supports deterministic case-insensitive substring search of saved Markdown. Select a note to edit its raw source. Markdown markers stay visible while emphasis, code, and list text are styled. Enter adds a line or continues a list; Command+Enter saves, Command+N opens compose, Command+F focuses search, and Escape from search clears it and returns to the editor. Standard copy, paste, selection, and undo use actual Markdown.

Saving is explicit. Drafts checkpoint after 300 ms idle and flush before deliberate navigation, export, restore, and normal close. “Saved” appears only after native acknowledgment. Input typed during a save remains an unfinished draft. Forced termination or power loss can lose input before its checkpoint; ordinary close failures keep the window open with retry or an explicit discard-and-close choice.

Delete is soft, with one persistent Undo delete target. Unsaved edits require explicit discard confirmation. Undo restores saved source. Older deleted rows remain in backups; there is no permanent-delete or trash browser control.

Native storage is `notes.sqlite3` under the isolated `tech.barbajoe.stashpad.preview` application data directory (`~/Library/Application Support/tech.barbajoe.stashpad.preview` on macOS). The product/window name is Stashpad Preview. New profiles start empty; no experimental or original-app data is migrated or seeded. Never point this app at the original Stashpad store. Database read failure offers Retry instead of silently loading an empty workspace.

Export uses a native destination dialog and atomic temporary-file replacement. BackupV1 contains `{format, version, exportedAt, workspace}`, with notes, drafts, and nullable `undoDeleteId` inside `workspace`. Restore validates the complete input, stages an immutable snapshot, shows replacement counts, and requires confirmation. Draft and Undo delete references must use the exact spelling of their note ID; uppercase UUIDs with matching references remain valid, and case-ambiguous duplicate IDs are rejected. It first writes a safety backup into the app data directory's `backups` folder, then replaces all rows transactionally. Failed backup writes or transactions retain the old workspace and allow retry. Cancelled dialogs are neutral.

Current alpha capacities are 10,000 notes, 10,001 drafts, 1 MiB UTF-8 per Markdown field, and 10 MiB for the complete compact backup envelope. Every prospective save/checkpoint/mutation checks these bounds and references before committing. Changes to these limits require explicit validation and recovery consideration.

## Native acceptance

Run the packaged `.app` without Vite. Use synthetic notes and native dialogs to check offline reopen, exact Markdown/caret behavior, commands, draft close/reopen, delete/undo, and backup/restore. Confirm keyboard focus, 800×600 reflow at 150% text, and actual IME input separately. Browser tests include a synthetic composition event, which does not establish native IME acceptance. Record source/build identity, environment, results, and omissions under an ignored dated `.projects/` folder.

Automated adoption verification does not establish packaged native behavior. Native builds and smoke checks are separate gates; record any unperformed steps explicitly. Use only the Preview profile and synthetic data. Do not access the installed original app, personal stores, or experimental profiles.

For debug-only native failure checks, set `STASHPAD_ALPHA_TEST_FAILURE_FILE` to a task-owned text file before launching the debug executable. File content `load`, `save`, or `checkpoint` rejects that operation before mutation; clear the file to retry. This environment seam is compiled out of release builds and has no product UI control. The historical environment variable name is retained for compatibility. Debug failure checks do not establish release acceptance.

## Boundaries

Domain/search/backup policy is in `src/lib/domain`; the framework-neutral controller owns editing/order in `src/lib/workspace`; the typed command boundary is in `src/lib/platform`; Svelte components own view/CodeMirror lifecycle. Rust model, store, backup, and narrow commands live in `src-tauri/src`. Later sync can operate behind the repository boundary, but revisions, ordering, conflicts, authentication, and recovery require a separate design. Mobile platform integration and editor/keyboard acceptance are also separate work. Accounts, network sync, phones, attachments, nesting, signing, distribution, and legacy import are outside this alpha.

See [AGENTS.md](AGENTS.md) for repository responsibilities and [.projects/README.md](.projects/README.md) for evidence retention. No public license is selected; the project is independent of the original Stashpad team.
