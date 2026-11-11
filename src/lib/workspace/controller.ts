import { emptyWorkspace, type WorkspaceSnapshot } from '../domain/notes';
import { filterNotes } from '../domain/search';
import type { Repository, RestorePreview } from '../platform/workspace';
export interface ViewState {
  snapshot: WorkspaceSnapshot;
  activeKey: string;
  source: string;
  revision: number;
  query: string;
  loaded: boolean;
  pending: boolean;
  status: string;
  error: string;
  preview: RestorePreview | null;
}
export class WorkspaceController {
  state: ViewState = {
    snapshot: emptyWorkspace(),
    activeKey: 'compose',
    source: '',
    revision: 0,
    query: '',
    loaded: false,
    pending: false,
    status: 'Loading…',
    error: '',
    preview: null,
  };
  private listeners = new Set<(s: ViewState) => void>();
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private saving: Promise<boolean> | null = null;
  private dirty = false;
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
      this.state.activeKey !== 'compose' && this.state.source !== n?.markdown
    );
  }
  async start() {
    return this.run(async () => {
      try {
        const s = await this.repo.loadWorkspace();
        if (this.disposed) return false;
        this.snapshot(s);
        this.context('compose');
        this.patch({ loaded: true, status: 'Ready', error: '' });
        return true;
      } catch (e) {
        this.error(e);
        return false;
      }
    });
  }
  private context(key: string) {
    const draft = this.state.snapshot.drafts.find((d) => d.key === key);
    const note = this.state.snapshot.notes.find((n) => n.id === key);
    this.dirty = false;
    this.patch({
      activeKey: key,
      source: draft?.markdown ?? note?.markdown ?? '',
      revision: (draft?.revision ?? 0) + 1,
    });
  }
  editSource(source: string) {
    if (this.disposed || !this.state.loaded) return;
    this.dirty = true;
    this.patch({
      source,
      revision: this.state.revision + 1,
      status: 'Unsaved',
      error: '',
    });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.flush();
    }, 300);
  }
  private async checkpoint() {
    // A flush acknowledges the latest editor revision, including input that
    // arrives while an older checkpoint is awaiting persistence.
    while (!this.disposed && this.dirty) {
      clearTimeout(this.timer);
      const { activeKey: key, source, revision } = this.state;
      try {
        const s = await this.repo.checkpointDraft(key, source, revision);
        this.snapshot(s);
        if (this.state.activeKey === key && this.state.revision === revision) {
          this.dirty = false;
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
  private navigate(key: string) {
    return this.run(async () => {
      if (!(await this.checkpoint())) return false;
      this.context(key);
      this.patch({ error: '', status: 'Ready' });
      return true;
    });
  }
  newNote() {
    return this.navigate('compose');
  }
  selectNote(id: string) {
    return this.navigate(id);
  }
  setQuery(query: string) {
    this.patch({ query });
  }
  save() {
    if (this.saving) return this.saving;
    const captured = { ...this.state };
    this.saving = this.run(async () => {
      if (!captured.loaded) return false;
      this.patch({ pending: true, error: '', status: 'Saving…' });
      try {
        const s = await this.repo.saveNote(
          captured.activeKey === 'compose' ? null : captured.activeKey,
          captured.source,
          captured.activeKey,
          captured.revision,
        );
        this.snapshot(s);
        if (
          this.state.activeKey === captured.activeKey &&
          this.state.revision === captured.revision
        ) {
          const newId = s.notes.find(
            (n) => !captured.snapshot.notes.some((old) => old.id === n.id),
          )?.id;
          this.context(newId ?? captured.activeKey);
          this.patch({ status: 'Saved', error: '' });
        } else this.patch({ status: 'Unsaved' });
        return true;
      } catch (e) {
        this.error(e);
        return false;
      } finally {
        this.patch({ pending: false });
      }
    }).finally(() => {
      this.saving = null;
    });
    return this.saving;
  }
  remove(discard = false) {
    return this.run(async () => {
      if (this.state.activeKey === 'compose') return false;
      if (this.hasUnsavedDraft && !discard) {
        this.patch({
          error: 'Confirm discarding the unsaved edit before deleting.',
        });
        return false;
      }
      const key = this.state.activeKey;
      this.patch({ pending: true });
      try {
        this.snapshot(await this.repo.deleteNote(key));
        clearTimeout(this.timer);
        this.context('compose');
        this.patch({ status: 'Deleted. Undo delete is available.', error: '' });
        return true;
      } catch (e) {
        this.error(e);
        return false;
      } finally {
        this.patch({ pending: false });
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
      this.patch({ pending: true });
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
        this.patch({ pending: false });
      }
    });
  }
  previewRestore() {
    return this.run(async () => {
      if (!(await this.checkpoint())) return false;
      this.patch({ pending: true });
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
        this.patch({ pending: false });
      }
    });
  }
  restore(confirm = true) {
    return this.run(async () => {
      const p = this.state.preview;
      if (!p) return false;
      if (confirm && !(await this.checkpoint())) return false;
      this.patch({ pending: true });
      try {
        const s = await this.repo.confirmRestore(p.token, confirm);
        if (s) {
          clearTimeout(this.timer);
          this.snapshot(s);
          this.context('compose');
          this.patch({ query: '', status: 'Workspace restored', error: '' });
        } else this.patch({ status: 'Restore cancelled' });
        this.patch({ preview: null });
        return true;
      } catch (e) {
        this.error(e);
        return false;
      } finally {
        this.patch({ pending: false });
      }
    });
  }
  dispose() {
    clearTimeout(this.timer);
    this.disposed = true;
    this.listeners.clear();
  }
}
