import {
  emptyWorkspace,
  type WorkspaceSnapshot,
  type Location,
  type ColorToken,
} from '../domain/notes';
import {
  composeKey,
  composeOwner,
  effectiveScope,
  itemLocation,
} from '../domain/hierarchy';
import { filterNotes } from '../domain/search';
import type {
  Repository,
  RestorePreview,
  CaptureItem,
  CreateChildStash,
  ReorderItem,
} from '../platform/workspace';
/** Save acknowledgments allow editing; other in-flight mutations lock editors. */
export type WorkspaceOperation =
  | 'save'
  | 'completion'
  | 'create-stash'
  | 'promote'
  | 'restore-item'
  | 'color'
  | 'reorder'
  | 'delete'
  | 'export'
  | 'preview-restore'
  | 'restore';
export interface ViewState {
  snapshot: WorkspaceSnapshot;
  stashId: string | null;
  location: Location;
  mutationRetry: boolean;
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
  completionRetry: { id: string; done: boolean } | null;
}
export class WorkspaceController {
  state: ViewState = {
    snapshot: emptyWorkspace(),
    stashId: null,
    location: { scope: 'live', itemId: null },
    mutationRetry: false,
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
    completionRetry: null,
  };
  private listeners = new Set<(s: ViewState) => void>();
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private saving: Promise<boolean> | null = null;
  private creating: Promise<boolean> | null = null;
  private dirty = new Set<string>();
  private queryRevision = 0;
  private editIntentRevision = 0;
  private completionIntent = 0;
  private viewIntent = 0;
  private captureIntents = new Map<string, CaptureItem>();
  private creationIntent: CreateChildStash | null = null;
  private retryIntent: (() => Promise<boolean>) | null = null;
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
    return filterNotes(
      this.state.snapshot.items,
      this.state.query,
      this.state.location.scope,
    );
  }
  async start() {
    return this.run(async () => {
      try {
        const s = await this.repo.loadWorkspace();
        if (this.disposed) return false;
        this.snapshot(s);
        this.resetBuffers(s);
        this.patch({
          stashId: null,
          location: { scope: 'live', itemId: null },
        });
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
    const note = this.state.snapshot.items.find((n) => n.id === key);
    const source = buffer?.source ?? note?.markdown ?? '';
    const revision = buffer?.revision ?? 0;
    if (note && source !== note.markdown) this.dirty.add(key);
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
      this.state.snapshot.items.find((n) => n.id === key)?.markdown ??
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
  // Called only inside the repository queue. Captures checkpoint; existing notes commit.
  private async checkpoint() {
    while (!this.disposed && this.dirty.size) {
      clearTimeout(this.timer);
      const key = this.dirty.values().next().value!;
      const { source, revision } = this.state.buffers[key];
      try {
        if (composeOwner(key)) {
          this.snapshot(await this.repo.checkpointDraft(key, source, revision));
        } else {
          const note = this.state.snapshot.items.find((n) => n.id === key);
          if (!note)
            throw new Error(
              'This note is unavailable. Your source is retained.',
            );
          this.patch({ status: 'Saving…' });
          this.snapshot(
            await this.repo.saveItemSource(key, source, { key, revision }),
          );
        }
        if (this.state.buffers[key]?.revision === revision) {
          this.dirty.delete(key);
          this.patch({
            status: composeOwner(key) ? 'Draft checkpointed' : 'Saved',
            error: '',
          });
        }
      } catch (e) {
        // Preserve a recoverable draft when committing the note failed. A checkpoint
        // failure must not replace the original useful save error or clear dirty state.
        if (!composeOwner(key)) {
          const latest = this.state.buffers[key];
          try {
            this.snapshot(
              await this.repo.checkpointDraft(
                key,
                latest.source,
                latest.revision,
              ),
            );
          } catch {
            /* Visible source remains in the buffer for retry. */
          }
        }
        this.error(e);
        return false;
      }
    }
    return !this.disposed;
  }
  flush() {
    return this.run(() => this.checkpoint());
  }
  private navigate(key: string, at: Location, clearQuery = false) {
    const queryRevision = this.queryRevision,
      intent = ++this.viewIntent;
    const retry = () => this.navigate(key, at, clearQuery);
    return this.run(async () => {
      try {
        if (
          at.itemId !== null &&
          !this.state.snapshot.items.some(
            (x) =>
              x.id === at.itemId &&
              x.kind === 'stash' &&
              effectiveScope(this.state.snapshot.items, x.id) === at.scope,
          )
        )
          throw new Error('This stash is unavailable.');
        if (!(await this.checkpoint())) {
          if (clearQuery) {
            this.retryIntent = retry;
            this.patch({ mutationRetry: true });
          }
          return false;
        }
        if (intent !== this.viewIntent) return false;
        this.patch({
          stashId: at.itemId,
          location: at,
          ...(clearQuery && queryRevision === this.queryRevision
            ? { query: '' }
            : {}),
        });
        this.context(key);
        this.patch({ error: '', status: 'Ready' });
        return true;
      } catch (e) {
        this.error(e);
        return false;
      }
    });
  }
  newNote() {
    return this.navigate(composeKey(this.state.location), {
      ...this.state.location,
    });
  }
  openStash(id: string | null) {
    if (
      id !== null &&
      !this.state.snapshot.items.some((x) => x.id === id && x.kind === 'stash')
    ) {
      this.error(new Error('This stash is unavailable.'));
      return Promise.resolve(false);
    }
    const at: Location = {
      scope:
        id === null ? 'live' : effectiveScope(this.state.snapshot.items, id),
      itemId: id,
    };
    return this.navigate(composeKey(at), at, true);
  }
  openLocation(at: Location) {
    const captured = { ...at };
    return this.navigate(composeKey(captured), captured, true);
  }
  selectNote(id: string) {
    const item = this.state.snapshot.items.find((x) => x.id === id);
    if (!item) {
      this.error(new Error('This item is unavailable.'));
      return Promise.resolve(false);
    }
    const at = this.state.query.trim()
      ? { ...this.state.location }
      : itemLocation(this.state.snapshot.items, id);
    return this.navigate(id, at);
  }
  createStash(selectedId?: string, retry?: CreateChildStash) {
    if (this.creating) return this.creating;
    const selected = selectedId
      ? this.state.snapshot.items.find((x) => x.id === selectedId)
      : undefined;
    const parent: Location = selected
      ? {
          scope: effectiveScope(this.state.snapshot.items, selected.id),
          itemId: selected.id,
        }
      : { ...this.state.location };
    const request: CreateChildStash =
      retry ??
      (this.creationIntent &&
      this.creationIntent.parent.scope === parent.scope &&
      this.creationIntent.parent.itemId === parent.itemId
        ? this.creationIntent
        : { id: crypto.randomUUID(), parent });
    this.creationIntent = request;
    const view = this.viewIntent,
      query = this.queryRevision;
    this.creating = this.run(async () => {
      this.patch({ operation: 'create-stash', error: '' });
      try {
        if (!(await this.checkpoint())) {
          this.retryIntent = () => this.createStash(undefined, request);
          this.patch({ mutationRetry: true });
          return false;
        }
        const snapshot = await this.repo.createChildStash(request);
        this.snapshot(snapshot);
        this.creationIntent = null;
        this.retryIntent = null;
        this.patch({
          mutationRetry: false,
          status: 'Stash created',
          error: '',
        });
        if (view === this.viewIntent) {
          const at = { scope: request.parent.scope, itemId: request.id };
          this.patch({
            stashId: request.id,
            location: at,
            ...(query === this.queryRevision ? { query: '' } : {}),
          });
          this.context(composeKey(at));
        }
        return true;
      } catch (e) {
        this.error(e);
        this.retryIntent = () => this.createStash(undefined, request);
        this.patch({ mutationRetry: true });
        return false;
      } finally {
        this.patch({ operation: null });
      }
    }).finally(() => (this.creating = null));
    return this.creating;
  }
  enterItem(id: string) {
    const intent = ++this.viewIntent,
      query = this.queryRevision;
    return this.run(async () => {
      this.patch({ operation: 'promote' });
      try {
        if (!(await this.checkpoint())) {
          this.retryIntent = () => this.enterItem(id);
          this.patch({ mutationRetry: true });
          return false;
        }
        this.snapshot(await this.repo.promoteItem(id));
        if (intent !== this.viewIntent) return false;
        const at: Location = {
          scope: effectiveScope(this.state.snapshot.items, id),
          itemId: id,
        };
        this.patch({
          stashId: id,
          location: at,
          ...(query === this.queryRevision ? { query: '' } : {}),
        });
        this.context(composeKey(at));
        this.retryIntent = null;
        this.patch({ error: '', status: 'Ready', mutationRetry: false });
        return true;
      } catch (e) {
        this.error(e);
        this.retryIntent = () => this.enterItem(id);
        this.patch({ mutationRetry: true });
        return false;
      } finally {
        this.patch({ operation: null });
      }
    });
  }
  async retryMutation() {
    const intent = this.retryIntent;
    if (!intent) return false;
    const ok = await intent();
    if (ok && this.retryIntent === intent) {
      this.retryIntent = null;
      this.patch({ mutationRetry: false });
    }
    return ok;
  }
  feedback(status: string, error = '') {
    this.patch({ status, error });
  }
  setQuery(query: string) {
    this.queryRevision++;
    this.patch({ query });
  }
  save(key = this.state.activeKey) {
    const compose = composeOwner(key);
    if (!compose) return this.finishEdit(key);
    if (this.saving) return this.saving;
    const pending = this.captureIntents.get(key);
    const buffer = this.state.buffers[key];
    if (!this.state.loaded || (!pending && !buffer?.source.trim())) {
      this.patch({
        error:
          'Enter non-whitespace text before saving. Your draft is retained.',
      });
      return Promise.resolve(false);
    }
    // Reconcile the immutable creation request before accepting another capture
    // from this composer, even when newer typing has changed or emptied its buffer.
    const request: CaptureItem = pending ?? {
      id: crypto.randomUUID(),
      location:
        key === 'compose:trash'
          ? { scope: 'trash', itemId: null }
          : compose.stashId === null
            ? { scope: 'live', itemId: null }
            : {
                scope: effectiveScope(
                  this.state.snapshot.items,
                  compose.stashId,
                ),
                itemId: compose.stashId,
              },
      markdown: buffer.source,
      draft: { key, revision: buffer.revision },
    };
    this.captureIntents.set(key, request);
    this.saving = this.run(async () => {
      this.patch({ operation: 'save', error: '', status: 'Saving…' });
      try {
        // A committed child can travel with its owner across scopes before a
        // lost reply is retried. Reconcile only that existing exact child;
        // an absent creation must retain its original destination contract.
        const existing = this.state.snapshot.items.find(
          (x) => x.id === request.id,
        );
        const replay =
          existing &&
          request.location.itemId !== null &&
          existing.parentId === request.location.itemId
            ? {
                ...request,
                location: {
                  ...request.location,
                  scope: effectiveScope(
                    this.state.snapshot.items,
                    existing.parentId!,
                  ),
                },
              }
            : request;
        const s = await this.repo.captureItem(replay);
        this.captureIntents.delete(key);
        this.snapshot(s);
        if (this.state.buffers[key]?.revision === request.draft.revision) {
          this.dirty.delete(key);
          const buffers = { ...this.state.buffers };
          // Advance the revision even when clearing to distinguish subsequent captures.
          buffers[key] = {
            source: '',
            revision: request.draft.revision + 1,
          };
          this.patch({ buffers });
          if (this.state.activeKey === key)
            this.context(composeKey(this.state.location));
          this.patch({ status: 'Saved', error: '' });
        } else this.patch({ status: 'Unsaved' });
        return true;
      } catch (e) {
        // A successful authoritative read can prove this creation never committed.
        // Otherwise keep its immutable request: generic failure codes alone do not
        // distinguish a rejected write from a committed write with a lost reply.
        try {
          const current = await this.repo.loadWorkspace();
          if (
            !current.items.some(
              (item) => item.id.toLowerCase() === request.id.toLowerCase(),
            )
          )
            this.captureIntents.delete(key);
        } catch {
          // Unavailable reconciliation leaves the original request retryable.
        }
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
  // Continuing the same active edit supersedes an older blur-owned exit.
  retainEdit(key: string) {
    if (this.state.activeKey === key && !composeOwner(key))
      this.editIntentRevision++;
  }
  finishEdit(
    key = this.state.activeKey,
    reason: 'explicit' | 'blur' = 'explicit',
  ) {
    const intentRevision = this.editIntentRevision;
    return this.run(async () => {
      if (!(await this.checkpoint())) return false;
      if (
        this.state.activeKey === key &&
        !composeOwner(key) &&
        (reason === 'explicit' || intentRevision === this.editIntentRevision)
      )
        this.context(composeKey(this.state.location));
      return true;
    });
  }
  setNoteDone(id: string, done: boolean) {
    const intent = { id, done },
      revision = ++this.completionIntent;
    return this.run(async () => {
      this.patch({ operation: 'completion', error: '' });
      try {
        if (!(await this.checkpoint())) {
          if (revision === this.completionIntent)
            this.patch({
              completionRetry: intent,
              status: 'Completion needs retry',
            });
          return false;
        }
        this.snapshot(await this.repo.setItemDone(intent.id, intent.done));
        if (revision === this.completionIntent)
          this.patch({
            completionRetry: null,
            error: '',
            status: intent.done ? 'Marked done' : 'Marked not done',
          });
        return true;
      } catch (e) {
        this.error(e);
        if (revision === this.completionIntent)
          this.patch({
            completionRetry: intent,
            status: 'Completion needs retry',
          });
        return false;
      } finally {
        this.patch({ operation: null });
      }
    });
  }
  retryCompletion() {
    const intent = this.state.completionRetry;
    return intent
      ? this.setNoteDone(intent.id, intent.done)
      : Promise.resolve(false);
  }
  remove(id = this.state.activeKey) {
    if (composeOwner(id)) return Promise.resolve(false);
    const view = this.viewIntent;
    return this.run(async () => {
      this.patch({ operation: 'delete' });
      try {
        if (!(await this.checkpoint())) {
          this.retryIntent = () => this.remove(id);
          this.patch({ mutationRetry: true });
          return false;
        }
        const prior = this.state.snapshot;
        const current = this.state.location;
        const target = prior.items.find((x) => x.id === id);
        if (!target) throw new Error('This item is unavailable.');
        this.snapshot(await this.repo.deleteItem(id));
        if (view === this.viewIntent) {
          let at = current;
          if (
            current.itemId !== null &&
            effectiveScope(this.state.snapshot.items, current.itemId) !==
              current.scope
          ) {
            let parent = target.parentId;
            while (
              parent !== null &&
              effectiveScope(this.state.snapshot.items, parent) !==
                current.scope
            )
              parent =
                this.state.snapshot.items.find((x) => x.id === parent)
                  ?.parentId ?? null;
            at = { scope: current.scope, itemId: parent };
          }
          this.patch({ stashId: at.itemId, location: at });
          if (
            this.state.activeKey === id ||
            at !== current ||
            (!composeOwner(this.state.activeKey) &&
              effectiveScope(
                this.state.snapshot.items,
                this.state.activeKey,
              ) !== at.scope)
          )
            this.context(composeKey(at));
        }
        this.retryIntent = null;
        this.patch({
          status:
            target.deletedAt !== null
              ? 'This item is already in Trash. Restore is available.'
              : 'Deleted. Undo delete is available.',
          error: '',
          mutationRetry: false,
        });
        return true;
      } catch (e) {
        this.error(e);
        this.retryIntent = () => this.remove(id);
        this.patch({ mutationRetry: true });
        return false;
      } finally {
        this.patch({ operation: null });
      }
    });
  }
  restoreItem(id: string) {
    return this.itemMetadata(
      'restore-item',
      () => this.repo.restoreItem(id),
      'Item restored',
    );
  }
  setItemColor(id: string, color: ColorToken | null) {
    return this.itemMetadata(
      'color',
      () => this.repo.setItemColor(id, color),
      'Color updated',
    );
  }
  reorderItem(request: ReorderItem) {
    const captured = structuredClone(request);
    return this.itemMetadata(
      'reorder',
      () => this.repo.reorderItem(captured),
      'Order updated',
    );
  }
  private itemMetadata(
    operation: WorkspaceOperation,
    fn: () => Promise<WorkspaceSnapshot>,
    status: string,
  ) {
    return this.run(async () => {
      this.patch({ operation });
      try {
        if (!(await this.checkpoint())) {
          this.retryIntent = () => this.itemMetadata(operation, fn, status);
          this.patch({ mutationRetry: true });
          return false;
        }
        this.snapshot(await fn());
        this.reconcileScope();
        this.retryIntent = null;
        this.patch({ mutationRetry: false, error: '', status });
        return true;
      } catch (e) {
        this.error(e);
        this.retryIntent = () => this.itemMetadata(operation, fn, status);
        this.patch({ mutationRetry: true });
        return false;
      } finally {
        this.patch({ operation: null });
      }
    });
  }
  private reconcileScope() {
    const current = this.state.location;
    const at =
      current.itemId === null
        ? current
        : {
            ...current,
            scope: effectiveScope(this.state.snapshot.items, current.itemId),
          };
    if (at.scope !== current.scope) this.patch({ location: at });
    if (
      !composeOwner(this.state.activeKey) &&
      effectiveScope(this.state.snapshot.items, this.state.activeKey) !==
        at.scope
    )
      this.context(composeKey(at));
  }
  undoRemove() {
    return this.run(async () => {
      if (!(await this.checkpoint())) return false;
      try {
        this.snapshot(await this.repo.undoDelete());
        this.reconcileScope();
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
          this.patch({
            stashId: null,
            location: { scope: 'live', itemId: null },
          });
          this.context(composeKey(null));
          this.completionIntent++;
          this.viewIntent++;
          this.creationIntent = null;
          this.captureIntents.clear();
          this.retryIntent = null;
          this.patch({ mutationRetry: false });
          this.patch({
            query: '',
            status: 'Workspace restored',
            error: '',
            completionRetry: null,
          });
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
