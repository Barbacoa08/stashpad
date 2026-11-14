# Open discussions

These are product decisions for future discussion, not authorization to implement them. The accepted foundation remains local-first Markdown editing with visible syntax, SvelteKit, Svelte, CodeMirror, Tauri, and native SQLite. Current behavior and technical contracts live in [README.md](README.md) and [AGENTS.md](AGENTS.md). Technical defects and evidence limits should be tracked separately from these product choices.

When a topic becomes actionable, link its individual GitHub issue here. Record a decision in the appropriate current guidance and mark the topic resolved instead of duplicating accepted policy indefinitely.

## Branding, terminology, and identity

**Scratchtree** is the accepted name, with “Fast Markdown notes, organized into note trees” as its description. Use note, note tree / tree, parent, sibling, and child note. Root is the top navigation destination. Library refers to all stored data; use notes, Root, or editor in their specific contexts. The [branding record](docs/branding/README.md) preserves the terminology and selected icon family.

The rename uses a new native identity and current-only storage/backup contracts. Alpha compatibility is not promised; actual notes still need a deliberate private backup and transfer. Historical alpha releases can be removed once the new package and private recovery path are verified. Remaining discussion concerns light/dark treatments, platform containers, and future icon/style refinements, rather than the accepted name and vocabulary.

## Styling experiment

The current interface uses locally authored CSS; no styling library is selected. Compare it with an experiment using `@barbajoe/css-lib`, including interaction fidelity and maintenance costs, before deciding whether adoption helps.

## Cross-parent movement

M uses a staged destination dialog for moving selected siblings together within or between the live library and Trash. A live-to-Trash move creates one persistent group Undo action. Dragging and Command-Up/Down rearrange siblings. Decide whether dragging should also move items between parents, and discuss cross-owner selection separately.

## Keyboard selection and batch actions

Mouse Shift-range and Command-toggle selection are accepted. Research keyboard range expansion, contraction, anchor/focus behavior, and selection clearing before adding Shift-arrow selection. Decide batch edit/color/completion/copy/delete behavior separately; those actions currently use one primary item. Current selection conventions draw on [Apple’s selection guidance](https://support.apple.com/guide/mac-help/select-items-mchlp1378/mac) and [WAI-ARIA guidance distinguishing focus and selection](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/#kbd_focus_vs_selection). Interactive note cards retain their content/button semantics rather than becoming listbox options.

## Tabs

Root and Search have keyboard navigation hints; tabs and Command-number switching beyond Root are deferred. Decide whether tabs improve navigation and how their state and shortcuts should work.

## Pinning

The sidebar currently shows every live container, and no pin control is offered. Decide whether pinning has a useful purpose and, if so, its behavior and presentation.

## Dedicated to-dos

Completion is item metadata toggled with X, not a separate task system. Decide whether a dedicated to-do view is useful and how it relates to existing items and completion.

## Custom colors

The current picker offers nine fixed colors and Reset. Decide whether arbitrary colors are useful and how they would fit the storage contract and accessible picker.

## Trash purge

Manual Delete inside Trash permanently removes the selected item and its children, without Undo. Automatic permanent cleanup is not enabled. Decide any future 90-day cleanup schedule, retention exceptions, and recovery behavior separately; existing backups are not securely erased by logical item deletion.

## Accounts and synchronization

**Dexie Cloud is selected for the next synchronization implementation.** Start with one personal library across Macs, local-first access, and no signup or login screens. Devices still need private authorization. Unfinished composer drafts stay on each Mac; submitted notes, tree structure, colors, completion, and Trash sync. Deletion Undo stays local to the Mac where deletion occurred; either Mac can restore from shared Trash. Full backup restore replaces the shared library on all Macs; older offline edits must remain recoverable rather than automatically reappearing. An acknowledged current library on the server is sufficient initially; version history is deferred. Simple last-write-wins for note source is acceptable.

The current released app remains local-only and uses native SQLite. **The accepted sync architecture replaces SQLite with Dexie persistent IndexedDB behind the Repository boundary; no SQLite-to-Dexie bridge is planned.** The new release need not support older storage or backup formats. Keep backup conversion in a separate local-only tool, with an unchanged source backup, validated output, and synthetic round-trip tests against the latest published pre-sync release. The Dexie experiment is a starting point, not a complete Repository implementation or a verified native storage replacement. The converter is not implemented yet; its output contract will follow the new synchronized model. Validate managed-cloud behavior, local backup conversion/import from the latest published pre-sync release, native Dexie persistence, concurrent hierarchy/ordering, rejected-edit recovery, Trash/purge/restore, and Undo before integrating. Initial device setup, precise concurrency rules, and the mechanisms for safe shared replacement and recovery remain design decisions. The right panel should present concise sync status, distinguish local saves from server acknowledgment, and expose offline/error details without implying success from connectivity alone.

## Mobile companions

Mac comes first. Future iOS and Android companions are intended primarily for viewing, copy/paste, and short Markdown capture. Tauri is preferred, with Capacitor as a fallback if mobile friction warrants it. Decide the mobile scope and validate platform/editor constraints separately.

## Developer ID signing and notarization

**Deferred, likely until after MVP (2026-11-13).** Sharing with friends does not currently justify adding Developer ID signing and notarization. Continue distributing the ad-hoc signed, unnotarized DMG, with the existing first-launch instructions and managed-Mac limitations. Signing and notarization remain intended future work; their exact timing is not committed. This decision does not authorize enrollment, credential access, signing changes, or publication.

When revisited, use Apple Developer ID signing, notarization, and a stapled ticket for the GitHub DMG. Start with local signing and Keychain-held credentials, and verify the downloaded package and first-launch experience. The [Apple Developer Program](https://developer.apple.com/programs/) currently costs $99 USD per year, with regional pricing and applicable taxes; an existing suitable membership can cover Scratchtree. Recheck pricing and [Tauri's signing requirements](https://v2.tauri.app/distribute/sign/macos/) before implementation. Signing does not override employer application restrictions. See [issue #6](https://github.com/Barbacoa08/scratchtree/issues/6) and [the release guide](docs/RELEASING.md).

## Other repository decision

No public license has been selected. Choose one separately before representing the project as licensed for reuse.
