# Temporary project work

Use `.projects/YYYY-MM-DD-short-task-name/` for research, designs, plans, checklists, investigations, reviews, logs, screenshots, and temporary comparisons. Only this directory guide is tracked; task folders and their contents are ignored. This policy replaces default skill locations for committed plans, designs, and verification reports.

Keep a short `status.md` in each task folder with its purpose, active/completed state, accepted decisions, unresolved questions, related PR, completion date, and any reason to retain material. Distinguish accepted requirements from observations and proposals. A historical note or approval is not permission to run a new service operation.

## Worktrees and retention

- A task's scratch work normally lives until deliberate retirement of its worktree. Branch deletion alone does not delete local files, and switching branches in one checkout does not isolate ignored material.
- Before closing a task, preserve lasting supported requirements in code, reusable tests, or concise current guidance. Summarize the change, actual validation, and material limits in the PR. Do not create a permanent execution journal.
- Keep unresolved follow-ups in an explicitly active local backlog or a deliberately created issue. Record a destination for active material before retiring its worktree.
- Before removing or archiving a worktree, inspect its staged, unstaged, untracked, and ignored work. Transfer only needed material to an explicitly chosen local workspace, verify the copy, and record the destination before deleting the source. Worktree archive snapshots may omit ignored files.
- Stop task-owned processes, and remove only disposable material from the selected task/worktree. Do not blanket-delete `.projects`, use `git clean -fdx`, follow symlinks into other folders, or remove work merely because it is old.
- There is no automatic cleanup job or additional fixed retention period. Preserve active, unresolved, or explicitly retained material until its disposition is settled.

## Retained local notes

Completed worktree notes may be consolidated into the main checkout's `.projects` directory before the worktree is retired. When present, `.projects/LOCAL-NOTES.md` in that checkout indexes retained research and decisions. Use `git worktree list --porcelain` to locate the main checkout when working in a linked worktree; ignored notes are not shared or copied automatically between worktrees.

These files remain available to later local sessions while the main checkout is retained. They are not included in GitHub, fresh clones, or other machines. Keep durable product decisions and required contributor guidance in tracked files so a fresh clone remains usable without private research.

## What stays in Git

Application source, dependencies/configuration, lockfiles, reusable tests and synthetic fixtures, and concise current maintenance/test instructions stay tracked as they become applicable. A fresh clone must remain usable without local research. Do not require ignored notes to build, test, or understand supported recovery.

Never force-add ignored research to a commit. Inspect staged paths and content before committing. Credentials, real note contents, private exports, personal screenshots, and service captures must not be committed or copied into public PR/issue text. Ignoring a directory does not encrypt, back up, or share its contents. Keep required backups independent of disposable scratch work.
