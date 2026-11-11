import { emptyWorkspace, type WorkspaceSnapshot } from '../domain/notes';
import { composeKey, composeOwner, stashName } from '../domain/hierarchy';
import { filterNotes } from '../domain/search';
import type { Repository, RestorePreview } from '../platform/workspace';
/** Save acknowledgments allow editing; other in-flight mutations lock editors. */
export type WorkspaceOperation =
  | 'save'
  | 'create-stash'
  | 'rename-stash'
  | 'discard'
  | 'delete'
  | 'export'
  | 'preview-restore'
  | 'restore';
export interface ViewState {
  snapshot: WorkspaceSnapshot;
  stashId: string | null;
  activeKey: string;
  buffers: Record<string, { source: string; revision: number }>;
  source: string;
  revision: number;
  query: string;
  loaded: boolean;
  operation: WorkspaceOperation | null;
  status: string;
  error: string;
  preview: RestorePreview | null;
}
export class WorkspaceController {
  state: ViewState = {
    snapshot: emptyWorkspace(),
    stashId: null,
    activeKey: 'compose',
    buffers: { compose: { source: '', revision: 0 } },
    source: '',
    revision: 0,
    query: '',
    loaded: false,
    operation: null,
    status: 'Loading…',
    error: '',
    preview: null,
  };
  private listeners = new Set<(s: ViewState) => void>();
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private saving: Promise<boolean> | null = null;
  private dirty = new Set<string>();
  constructor(private repo: Repository) {}
  subscribe(fn: (s: ViewState) => void) {
    this.listeners.add(fn);
    fn(this.state);
    return () => {
      this.listeners.delete(fn);
    };
  }
  private patch(p: Partial<ViewState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...p };
    for (const fn of this.listeners) fn(this.state);
  }
  private error(e: unknown) {
    const safe =
      typeof e === 'object' && e && 'message' in e
        ? String(e.message)
        : 'The local operation failed. Your input is retained.';
    this.patch({ error: safe, status: 'Needs retry' });
  }
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.queue.then(fn);
    this.queue = task.catch(() => {});
    return task;
  }
  private snapshot(s: WorkspaceSnapshot) {
    this.patch({ snapshot: s });
  }
  get visibleNotes() {
    return filterNotes(this.state.snapshot.notes, this.state.query);
  }
  get hasUnsavedDraft() {
    const n = this.state.snapshot.notes.find(
      (n) => n.id === this.state.activeKey,
    );
    return (
      composeOwner(this.state.activeKey) === null &&
      this.state.source !== n?.markdown
    );
  }
  async start() {
    return this.run(async () => {
      try {
        const s = await this.repo.loadWorkspace();
        if (this.disposed) return false;
        this.snapshot(s);
        this.resetBuffers(s);
        this.patch({ stashId: null });
        this.context(composeKey(null));
        this.patch({ loaded: true, status: 'Ready', error: '' });
        return true;
      } catch (e) {
        this.error(e);
        return false;
      }
    });
  }
  private resetBuffers(snapshot: WorkspaceSnapshot) {
    this.dirty.clear();
    this.patch({
      buffers: Object.fromEntries(
        snapshot.drafts.map((d) => [
          d.key,
          { source: d.markdown, revision: d.revision },
        ]),
      ),
    });
  }
  private context(key: string) {
    const buffer = this.state.buffers[key];
    const note = this.state.snapshot.notes.find((n) => n.id === key);
    const source = buffer?.source ?? note?.markdown ?? '';
    const revision = buffer?.revision ?? 0;
    this.patch({
      activeKey: key,
      source,
      revision,
      buffers: { ...this.state.buffers, [key]: { source, revision } },
    });
  }
  sourceFor(key: string) {
    return (
      this.state.buffers[key]?.source ??
      this.state.snapshot.notes.find((n) => n.id === key)?.markdown ??
      ''
    );
  }
  editSource(source: string) {
    this.editContext(this.state.activeKey, source);
  }
  editContext(key: string, source: string) {
    if (this.disposed || !this.state.loaded) return;
    const revision = (this.state.buffers[key]?.revision ?? 0) + 1;
    this.dirty.add(key);
    this.patch({
      buffers: { ...this.state.buffers, [key]: { source, revision } },
      ...(key === this.state.activeKey ? { source, revision } : {}),
      status: 'Unsaved',
      error: '',
    });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.flush();
    }, 300);
  }
  private async checkpoint() {
    while (!this.disposed && this.dirty.size) {
      clearTimeout(this.timer);
      const key = this.dirty.values().next().value!;
      const { source, revision } = this.state.buffers[key];
      try {
        this.snapshot(await this.repo.checkpointDraft(key, source, revision));
        if (this.state.buffers[key]?.revision === revision) {
          this.dirty.delete(key);
          this.patch({ status: 'Draft checkpointed', error: '' });
        }
      } catch (e) {
        this.error(e);
        return false;
      }
    }
    return !this.disposed;
  }
  flush() {
    return this.run(() => this.checkpoint());
  }
  private navigate(key: string, stashId: string | null, clearQuery = false) {
    return this.run(async () => {
      if (
        stashId !== null &&
        !this.state.snapshot.stashes.some((s) => s.id === stashId)
      ) {
        this.error(new Error('This stash is unavailable.'));
        return false;
      }
      if (!(await this.checkpoint())) return false;
      this.patch({ stashId, ...(clearQuery ? { query: '' } : {}) });
      this.context(key);
      this.patch({ error: '', status: 'Ready' });
      return true;
    });
  }
  newNote() {
    return this.navigate(composeKey(this.state.stashId), this.state.stashId);
  }
  openStash(id: string | null) {
    return this.navigate(composeKey(id), id, true);
  }
  selectNote(id: string) {
    const note = this.state.snapshot.notes.find(
      (n) => n.id === id && n.deletedAt === null,
    );
    if (!note) {
      this.error(new Error('This note is unavailable.'));
      return Promise.resolve(false);
    }
    return this.navigate(id, note.stashId);
  }
  createStash(name: string) {
    const parentId = this.state.stashId;
    return this.run(async () => {
      this.patch({ operation: 'create-stash', error: '' });
      try {
        const normalized = stashName(name);
        if (!(await this.checkpoint())) return false;
        const known = new Set(this.state.snapshot.stashes.map((s) => s.id));
        const snapshot = await this.repo.createStash(normalized, parentId);
        const created = snapshot.stashes.find((s) => !known.has(s.id));
        if (!created)
          throw new Error('The new stash is unavailable. Retry loading.');
        this.snapshot(snapshot);
        this.patch({
          stashId: created.id,
          query: '',
          status: 'Stash created',
          error: '',
        });
        this.context(composeKey(created.id));
        return true;
      } catch (e) {
        this.error(e);
        return false;
      } finally {
        this.patch({ operation: null });
      }
    });
  }
  renameStash(id: string, name: string) {
    return this.run(async () => {
      this.patch({ operation: 'rename-stash', error: '' });
      try {
        this.snapshot(await this.repo.renameStash(id, stashName(name)));
        this.patch({ status: 'Stash renamed', error: '' });
        return true;
      } catch (e) {
        this.error(e);
        return false;
      } finally {
        this.patch({ operation: null });
      }
    });
  }
  feedback(status: string, error = '') {
    this.patch({ status, error });
  }
  setQuery(query: string) {
    this.patch({ query });
  }
  save(key = this.state.activeKey) {
    if (this.saving) return this.saving;
    const buffer = this.state.buffers[key];
    if (!this.state.loaded || !buffer?.source.trim()) {
      this.patch({
        error:
          'Enter non-whitespace text before saving. Your draft is retained.',
      });
      return Promise.resolve(false);
    }
    const captured = { ...buffer };
    const compose = composeOwner(key);
    const stashId = compose
      ? compose.stashId
      : (this.state.snapshot.notes.find((n) => n.id === key)?.stashId ?? null);
    this.saving = this.run(async () => {
      this.patch({ operation: 'save', error: '', status: 'Saving…' });
      try {
        const s = await this.repo.saveNote(
          compose ? null : key,
          captured.source,
          key,
          captured.revision,
          stashId,
        );
        this.snapshot(s);
        if (this.state.buffers[key]?.revision === captured.revision) {
          this.dirty.delete(key);
          const buffers = { ...this.state.buffers };
          // Advance the revision even when clearing to distinguish subsequent captures.
          buffers[key] = {
            source: compose ? '' : captured.source,
            revision: captured.revision + 1,
          };
          this.patch({ buffers });
          if (this.state.activeKey === key)
            this.context(composeKey(this.state.stashId));
          this.patch({ status: 'Saved', error: '' });
        } else this.patch({ status: 'Unsaved' });
        return true;
      } catch (e) {
        this.error(e);
        return false;
      } finally {
        this.patch({ operation: null });
      }
    }).finally(() => {
      this.saving = null;
    });
    return this.saving;
  }
  cancelEdit() {
    const key = this.state.activeKey;
    if (composeOwner(key)) return Promise.resolve(true);
    return this.run(async () => {
      this.patch({ operation: 'discard' });
      try {
        this.snapshot(await this.repo.discardDraft(key));
        this.dirty.delete(key);
        const buffers = { ...this.state.buffers };
        delete buffers[key];
        this.patch({ buffers });
        this.context(composeKey(this.state.stashId));
        this.patch({ status: 'Edit cancelled', error: '' });
        return true;
      } catch (e) {
        this.error(e);
        return false;
      } finally {
        this.patch({ operation: null });
      }
    });
  }
  remove(discard = false) {
    return this.run(async () => {
      if (composeOwner(this.state.activeKey)) return false;
      if (this.hasUnsavedDraft && !discard) {
        this.patch({
          error: 'Confirm discarding the unsaved edit before deleting.',
        });
        return false;
      }
      const key = this.state.activeKey;
      this.patch({ operation: 'delete' });
      try {
        this.snapshot(await this.repo.deleteNote(key));
        this.dirty.delete(key);
        const buffers = { ...this.state.buffers };
        delete buffers[key];
        this.patch({ buffers });
        this.context(composeKey(this.state.stashId));
        this.patch({ status: 'Deleted. Undo delete is available.', error: '' });
        return true;
      } catch (e) {
        this.error(e);
        return false;
      } finally {
        this.patch({ operation: null });
      }
    });
  }
  undoRemove() {
    return this.run(async () => {
      try {
        this.snapshot(await this.repo.undoDelete());
        this.patch({ status: 'Delete undone', error: '' });
        return true;
      } catch (e) {
        this.error(e);
        return false;
      }
    });
  }
  export() {
    return this.run(async () => {
      if (!(await this.checkpoint())) return false;
      this.patch({ operation: 'export' });
      try {
        const path = await this.repo.exportBackup();
        this.patch({
          status: path ? 'Backup exported' : 'Export cancelled',
          error: '',
        });
        return true;
      } catch (e) {
        this.error(e);
        return false;
      } finally {
        this.patch({ operation: null });
      }
    });
  }
  previewRestore() {
    return this.run(async () => {
      if (!(await this.checkpoint())) return false;
      this.patch({ operation: 'preview-restore' });
      try {
        const preview = await this.repo.previewRestore();
        this.patch({
          preview,
          status: preview ? 'Review replacement' : 'Restore cancelled',
          error: '',
        });
        return true;
      } catch (e) {
        this.error(e);
        return false;
      } finally {
        this.patch({ operation: null });
      }
    });
  }
  restore(confirm = true) {
    return this.run(async () => {
      const p = this.state.preview;
      if (!p) return false;
      if (confirm && !(await this.checkpoint())) return false;
      this.patch({ operation: 'restore' });
      try {
        const s = await this.repo.confirmRestore(p.token, confirm);
        if (s) {
          clearTimeout(this.timer);
          this.snapshot(s);
          this.resetBuffers(s);
          this.patch({ stashId: null });
          this.context(composeKey(null));
          this.patch({ query: '', status: 'Workspace restored', error: '' });
        } else this.patch({ status: 'Restore cancelled' });
        this.patch({ preview: null });
        return true;
      } catch (e) {
        this.error(e);
        return false;
      } finally {
        this.patch({ operation: null });
      }
    });
  }
  dispose() {
    clearTimeout(this.timer);
    this.disposed = true;
    this.listeners.clear();
  }
}
