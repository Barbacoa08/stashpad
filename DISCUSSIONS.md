# Open discussions

These are product decisions for future discussion, not authorization to implement them. The accepted foundation remains local-first Markdown editing with visible syntax, SvelteKit, Svelte, CodeMirror, Tauri, and native SQLite. Current behavior and technical contracts live in [README.md](README.md) and [AGENTS.md](AGENTS.md). Technical defects and evidence limits should be tracked separately from these product choices.

When a topic becomes actionable, link its individual GitHub issue here. Record a decision in the appropriate current guidance and mark the topic resolved instead of duplicating accepted policy indefinitely.

## Branding, terminology, and identity

The app is independent of the original product and currently uses the Preview name and “stash” terminology. Decide its durable name, terms, icon, and logo after core interactions mature. Evaluate original, independently usable identity options.

## Styling experiment

The current interface uses locally authored CSS; no styling library is selected. Compare it with an experiment using `@barbajoe/css-lib`, including interaction fidelity and maintenance costs, before deciding whether adoption helps.

## Cross-parent movement

The accepted first increment uses M for a staged destination dialog and moves selected siblings together; dragging and Command-Up/Down rearrange siblings. Moves stay within the current live-library or Trash area, and Restore remains the way out of Trash. Revisit cross-area movement and cross-owner selection only after evaluating this bounded workflow.

## Keyboard selection and batch actions

Mouse Shift-range and Command-toggle selection are accepted. Research keyboard range expansion, contraction, anchor/focus behavior, and selection clearing before adding Shift-arrow selection. Decide batch edit/color/completion/copy/delete behavior separately; those actions currently use one primary item. Current selection conventions draw on [Apple’s selection guidance](https://support.apple.com/guide/mac-help/select-items-mchlp1378/mac) and [WAI-ARIA guidance distinguishing focus and selection](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/#kbd_focus_vs_selection). Interactive note cards retain their content/button semantics rather than becoming listbox options.

## Tabs

Home and Search have keyboard navigation hints; tabs and Command-number switching beyond Home are deferred. Decide whether tabs improve navigation and how their state and shortcuts should work.

## Pinning

The sidebar currently shows every live container, and no pin control is offered. Decide whether pinning has a useful purpose and, if so, its behavior and presentation.

## Dedicated to-dos

Completion is item metadata toggled with X, not a separate task system. Decide whether a dedicated to-do view is useful and how it relates to existing items and completion.

## Custom colors

The current picker offers nine fixed colors and Reset. Decide whether arbitrary colors are useful and how they would fit the storage contract and accessible picker.

## Trash purge

Manual Delete inside Trash permanently removes the selected item and its children, without Undo. Automatic permanent cleanup is not enabled. Decide any future 90-day cleanup schedule, retention exceptions, and recovery behavior separately; existing backups are not securely erased by logical item deletion.

## Accounts and synchronization

A later MVP is intended to use one shared API/backend database and device-local copies, with local-first loading, initially for a single user's library across devices. Simple last-write-wins is acceptable. Authentication, backend technology, ordering, conflict handling, and recovery remain to be designed and evaluated; the current app is local-only.

## Mobile companions

Mac comes first. Future iOS and Android companions are intended primarily for viewing, copy/paste, and short Markdown capture. Tauri is preferred, with Capacitor as a fallback if mobile friction warrants it. Decide the mobile scope and validate platform/editor constraints separately.

## Developer ID signing and notarization

The current Mac alpha is ad-hoc signed and is not notarized, so macOS can block its first launch. Decide whether and when to use Developer ID signing and notarization, including their distribution and maintenance implications. See [issue #6](https://github.com/Barbacoa08/stashpad/issues/6).

## Other repository decision

No public license has been selected. Choose one separately before representing the project as licensed for reuse.
