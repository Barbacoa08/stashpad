# Stashpad

An independent research project exploring a developer-oriented replacement for the original Stashpad Lists note-taking app.

**Status:** research and experiment planning. No application implementation has started. The next proposed comparison is SvelteKit with Tauri versus plain Svelte/Vite with Tauri, followed by the same maintenance task on both results. Implementation requires a separate go-ahead.

The editor must keep Markdown syntax visible and editable while styling the text live, especially emphasis, code blocks, and lists. Familiar editing and navigation shortcuts are central to the experience.

## Product scope

- **Alpha:** a local-only Mac desktop app with a flat note list, note editing, simple text search, and backup export/restore. It should read and save local data without waiting for a network connection.
- **MVP:** one account for the initial user, one shared API and backend database, and background synchronization between personal and work desktops. Device-local copies retain immediate access and offline editing. Simple last-write-wins conflicts are acceptable; ordering and recovery details still need design.
- **Later:** iPhone and Android companions, primarily for viewing, copying and pasting, and short Markdown capture. Tauri is the preferred runtime direction; Capacitor remains a fallback if mobile integration proves difficult. Mobile implementation is outside the alpha and initial desktop MVP.

The frontend remains undecided pending comparable experiments. Editor, storage, and toolchain choices made for controlled trials do not automatically become permanent product decisions. Backend technology, authentication, sync implementation, and styling dependencies remain unselected.

## Working on this project

- [AGENTS.md](AGENTS.md): scope, worktrees, development responsibilities, and evidence.
- [.projects/README.md](.projects/README.md): temporary research, plans, reviews, and worktree retirement.

Use isolated task worktrees for maintained guidance and future source changes. Keep temporary work in dated, ignored `.projects` folders; a fresh clone must remain understandable without private research. Supported behavior, setup commands, and verification guidance will be documented as they become real.

This repository is public. Use synthetic notes in tracked examples and tests, and keep private note contents, screenshots, exports, and credentials out of Git.

## Project identity and licensing

This project is independent of the original Stashpad team. Public implementation licensing and any reuse of original code, assets, or branding remain to be decided. No license has been selected yet.
