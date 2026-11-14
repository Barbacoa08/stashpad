import { captureMoveProof, captureUndoDelete } from '../domain/items';
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
  directEntries,
} from '../domain/hierarchy';
import { filterNotes } from '../domain/search';
import { subtreeIds } from '../domain/items';
import type {
  Repository,
  RemoteBuffer,
  RestorePreview,
  CaptureItem,
  CreateChildTree,
  ReorderItem,
  PurgeItem,
  PurgeResult,
  MoveItems,
  TransitionLocation,
} from '../platform/workspace';
/** Save acknowledgments allow editing; other in-flight mutations lock editors. */
export type WorkspaceOperation =
  | 'purge'
  | 'move'
  | 'navigate'
  | 'navigation-reconcile'
  | 'save'
  | 'completion'
  | 'create-tree'
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
  purgedItemIds: string[];
  cacheGeneration: number;
  ownerId: string | null;
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
    purgedItemIds: [],
    cacheGeneration: 0,
    ownerId: null,
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
  private pendingRemoteOrigin: string | undefined;
  private queryRevision = 0;
  private editIntentRevision = 0;
  private completionIntent = 0;
  private viewIntent = 0;
  private captureIntents = new Map<string, CaptureItem>();
  // In-memory acknowledgment state preserves a pending Save's original identity
  // after a structural command reconciles its committed write.
  private reconciledCaptures = new Set<string>();
  private creationIntent: CreateChildTree | null = null;
  private childIntents = new Map<string, CreateChildTree>();
  private storedRetryIntent: (() => Promise<boolean>) | null = null;
  private retryGenerations = new WeakMap<() => Promise<boolean>, number>();
  private completionGenerations = new WeakMap<object, number>();
  private get retryIntent() {
    return this.storedRetryIntent;
  }
  private set retryIntent(intent: (() => Promise<boolean>) | null) {
    this.storedRetryIntent = intent;
    if (intent && !this.retryGenerations.has(intent))
      this.retryGenerations.set(intent, this.state.cacheGeneration);
  }
  // Lost purge replies retain their exact reconciliation independently of newer
  // failed commands, which may need to checkpoint an already removed owner.
  private uncertainPurgeRetries = new Map<string, () => Promise<boolean>>();
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
  private run<T>(fn: () => Promise<T>, allowReplacement = false): Promise<T> {
    const generation = this.state.cacheGeneration;
    const task = this.queue.then(() => {
      if (!allowReplacement && generation !== this.state.cacheGeneration) {
        this.error(
          new Error(
            'The library was replaced. Captured work is retained for recovery.',
          ),
        );
        return false as T;
      }
      return fn();
    });
    this.queue = task.catch(() => {});
    return task;
  }
  private snapshot(s: WorkspaceSnapshot) {
    const current = this.state.location;
    if (
      current.itemId === null ||
      s.items.some((x) => x.id === current.itemId && x.kind === 'tree')
    ) {
      const location =
        current.itemId === null
          ? current
          : { ...current, scope: effectiveScope(s.items, current.itemId) };
      this.patch({ snapshot: s, location });
      return;
    }
    const prior = new Map(this.state.snapshot.items.map((x) => [x.id, x]));
    const index = new Map(s.items.map((x) => [x.id, x]));
    let parent =
      prior.get(current.itemId)?.parentId ??
      index.get(current.itemId)?.parentId ??
      null;
    while (parent !== null) {
      const candidate = index.get(parent);
      if (
        candidate?.kind === 'tree' &&
        effectiveScope(s.items, parent) === current.scope
      )
        break;
      parent = prior.get(parent)?.parentId ?? candidate?.parentId ?? null;
    }
    const location = { scope: current.scope, itemId: parent };
    this.patch({ snapshot: s, location, ownerId: parent });
    if (this.state.activeKey === composeKey(current))
      this.context(composeKey(location));
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
          ownerId: null,
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
  /** Invalidation carries no snapshot: read only after all older controller work. */
  refreshFromRepository() {
    return this.run(async () => {
      try {
        const prior = this.state.snapshot;
        let captured: RemoteBuffer[] = [];
        let originEpoch: string | undefined = this.pendingRemoteOrigin;
        const collect = () =>
          [...this.dirty].map((key) => ({
            key,
            markdown: this.state.buffers[key].source,
            revision: this.state.buffers[key].revision,
            ...(originEpoch ? { originEpoch } : {}),
          }));
        captured = collect();
        let refresh = this.repo.refreshFromRemote
          ? await this.repo.refreshFromRemote(captured)
          : null;
        if (refresh && this.pendingRemoteOrigin)
          refresh = {
            ...refresh,
            replaced: true,
            originEpoch: this.pendingRemoteOrigin,
          };
        let s = refresh?.workspace ?? (await this.repo.loadWorkspace());
        originEpoch = this.pendingRemoteOrigin ?? refresh?.originEpoch;
        if (refresh?.replaced) this.pendingRemoteOrigin = originEpoch;
        // Input remains editable during IO. Preserve each newer revision before losing
        // its owner, including a same-UUID item in a replacement epoch.
        while (
          (refresh &&
            captured.some(
              (b) => this.state.buffers[b.key]?.revision !== b.revision,
            )) ||
          (refresh &&
            [...this.dirty].some((key) => !captured.some((b) => b.key === key)))
        ) {
          captured = collect();
          const newer = await this.repo.refreshFromRemote!(captured);
          if (newer.replaced)
            this.pendingRemoteOrigin ??= originEpoch ?? newer.originEpoch;
          refresh = {
            ...newer,
            replaced: refresh!.replaced || newer.replaced,
            removedIds: [
              ...new Set([...refresh!.removedIds, ...newer.removedIds]),
            ],
          };
          s = newer.workspace;
        }
        if (this.disposed) return false;
        const ids = new Set(s.items.map((x) => x.id));
        const removed = refresh?.replaced
          ? prior.items.map((x) => x.id)
          : (refresh?.removedIds ??
            prior.items.filter((x) => !ids.has(x.id)).map((x) => x.id));
        const gone = (key: string) =>
          removed.includes(key) ||
          (key.startsWith('compose:') && removed.includes(key.slice(8)));
        const buffers = { ...this.state.buffers };
        for (const key of Object.keys(buffers)) {
          if (refresh?.replaced || gone(key)) {
            delete buffers[key];
            this.dirty.delete(key);
          } else if (!this.dirty.has(key)) {
            const item = s.items.find((x) => x.id === key),
              draft = s.drafts.find((x) => x.key === key);
            buffers[key] = {
              source: draft?.markdown ?? item?.markdown ?? '',
              revision: buffers[key].revision,
            };
          }
        }
        if (refresh?.replaced) {
          this.captureIntents.clear();
          this.reconciledCaptures.clear();
          this.childIntents.clear();
          this.creationIntent = null;
          for (const draft of s.drafts)
            buffers[draft.key] = {
              source: draft.markdown,
              revision: draft.revision,
            };
        } else
          for (const [key, intent] of this.captureIntents)
            if (gone(key) || removed.includes(intent.id))
              this.captureIntents.delete(key);
        this.patch({
          buffers,
          purgedItemIds: removed,
          operation: 'navigation-reconcile',
          ...(refresh?.replaced
            ? {
                cacheGeneration: this.state.cacheGeneration + 1,
                location: { scope: 'live', itemId: null },
                ownerId: null,
              }
            : {}),
        });
        this.snapshot(s);
        this.pendingRemoteOrigin = undefined;
        if (refresh?.replaced || gone(this.state.activeKey))
          this.context(composeKey(this.state.location));
        else {
          const key = this.state.activeKey;
          this.patch({
            source:
              buffers[key]?.source ??
              s.items.find((x) => x.id === key)?.markdown ??
              '',
            revision: buffers[key]?.revision ?? 0,
          });
        }
        return true;
      } catch (e) {
        this.error(e);
        return false;
      } finally {
        this.patch({ operation: null });
      }
    }, true);
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
    if (this.pendingRemoteOrigin) {
      this.error(
        new Error(
          'The replaced library needs recovery retry before editing can continue. Your input is retained.',
        ),
      );
      return false;
    }
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
            status: composeOwner(key) ? 'Draft saved' : 'Saved',
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
  private navigate(
    key: string,
    at: Location,
    clearQuery = false,
    promoteDestination = false,
  ) {
    const queryRevision = this.queryRevision,
      intent = ++this.viewIntent;
    const to = { ...at };
    const retry = () => this.navigate(key, to, clearQuery, promoteDestination);
    return this.run(async () => {
      // Prior queued acknowledgments can publish an intermediate location. Capture
      // this action's actual departure once, before awaits; its destination stays
      // the exact original intent and is never read from mutable selection.
      const from = { ...this.state.location };
      const request: TransitionLocation = { from, to, promoteDestination };
      try {
        if (
          to.itemId !== null &&
          !this.state.snapshot.items.some(
            (x) =>
              x.id === to.itemId &&
              (promoteDestination || x.kind === 'tree') &&
              effectiveScope(this.state.snapshot.items, x.id) === to.scope,
          )
        )
          throw new Error('This tree is unavailable.');
        if (!(await this.checkpoint())) {
          this.retryIntent = retry;
          this.patch({ mutationRetry: true });
          return false;
        }
        const leaving = from.scope !== to.scope || from.itemId !== to.itemId;
        if (leaving && !(await this.reconcileCreations())) {
          this.retryIntent = retry;
          this.patch({ mutationRetry: true });
          return false;
        }
        if (intent !== this.viewIntent) return false;
        // A checkpoint can accept newer typing until it has saved every revision.
        // Only the structural transition locks editing and publishes a visit cause.
        this.patch({ operation: promoteDestination ? 'promote' : 'navigate' });
        const snapshot =
          leaving || promoteDestination
            ? await this.repo.transitionLocation(request)
            : this.state.snapshot;
        // The queue prevents another successful navigation while awaiting storage.
        // Publish the valid destination with a demotion snapshot, even if a newer
        // queued view intent now owns the next location/focus continuation.
        const current = this.state.location;
        const mustLeave =
          current.scope === from.scope && current.itemId === from.itemId;
        const destination =
          intent === this.viewIntent || mustLeave ? to : current;
        this.patch({
          snapshot,
          ...(intent !== this.viewIntent
            ? { operation: 'navigation-reconcile' as const }
            : {}),
          ownerId: destination.itemId,
          location: destination,
          ...(intent === this.viewIntent &&
          clearQuery &&
          queryRevision === this.queryRevision
            ? { query: '' }
            : {}),
        });
        if (intent !== this.viewIntent) {
          if (this.state.activeKey === composeKey(from))
            this.context(composeKey(destination));
          return false;
        }
        this.context(key);
        // A newer successful visit does not discard an older captured failed action.
        // retryMutation clears that exact action only after its own acknowledgment.
        this.patch({
          error: '',
          status: 'Ready',
          mutationRetry: this.pendingMutationRetry !== null,
        });
        return true;
      } catch (e) {
        this.error(e);
        this.retryIntent = retry;
        this.patch({ mutationRetry: true });
        return false;
      } finally {
        this.patch({ operation: null });
      }
    });
  }
  newNote() {
    return this.navigate(composeKey(this.state.location), {
      ...this.state.location,
    });
  }
  openTree(id: string | null) {
    if (
      id !== null &&
      !this.state.snapshot.items.some((x) => x.id === id && x.kind === 'tree')
    ) {
      this.error(new Error('This tree is unavailable.'));
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
      this.error(new Error('This note is unavailable.'));
      return Promise.resolve(false);
    }
    const at = this.state.query.trim()
      ? { ...this.state.location }
      : itemLocation(this.state.snapshot.items, id);
    return this.navigate(id, at);
  }
  createTree(selectedId?: string, retry?: CreateChildTree) {
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
    const captured: CreateChildTree =
      retry ??
      (this.creationIntent &&
      this.creationIntent.parent.scope === parent.scope &&
      this.creationIntent.parent.itemId === parent.itemId
        ? this.creationIntent
        : {
            id: crypto.randomUUID(),
            parent,
            leave: { ...this.state.location },
          });
    this.creationIntent = captured;
    this.childIntents.set(captured.id, captured);
    const view = this.viewIntent,
      query = this.queryRevision;
    this.creating = this.run(async () => {
      // Exit cleanup follows the actual queued departure; UUID and parent remain
      // the immutable creation destination selected by the original command.
      const request: CreateChildTree = {
        ...captured,
        leave: { ...this.state.location },
      };
      this.creationIntent = request;
      this.childIntents.set(request.id, request);
      this.patch({ operation: 'create-tree', error: '' });
      try {
        if (!(await this.checkpoint())) {
          this.retryIntent = () => this.createTree(undefined, request);
          this.patch({ mutationRetry: true });
          return false;
        }
        if (!(await this.reconcileCreations(request.id))) {
          this.retryIntent = () => this.createTree(undefined, request);
          this.patch({ mutationRetry: true });
          return false;
        }
        const snapshot = await this.repo.createChildTree(request);
        this.creationIntent = null;
        this.childIntents.delete(request.id);
        this.retryIntent = null;
        this.patch({
          mutationRetry: this.uncertainPurgeRetries.size > 0,
          status: 'Tree created',
          error: '',
        });
        const departed =
          request.leave?.itemId !== null &&
          request.leave?.itemId !== undefined &&
          snapshot.items.find((x) => x.id === request.leave?.itemId)?.kind ===
            'note';
        if (
          view === this.viewIntent ||
          (departed && this.state.location.itemId === request.leave?.itemId)
        ) {
          const at = { scope: request.parent.scope, itemId: request.id };
          this.patch({
            snapshot,
            ...(view !== this.viewIntent
              ? { operation: 'navigation-reconcile' as const }
              : {}),
            ownerId: request.id,
            location: at,
            ...(query === this.queryRevision ? { query: '' } : {}),
          });
          this.context(composeKey(at));
        } else this.snapshot(snapshot);
        return true;
      } catch (e) {
        this.error(e);
        this.retryIntent = () => this.createTree(undefined, request);
        this.patch({ mutationRetry: true });
        return false;
      } finally {
        this.patch({ operation: null });
      }
    }).finally(() => (this.creating = null));
    return this.creating;
  }
  enterItem(id: string) {
    const item = this.state.snapshot.items.find((x) => x.id === id);
    if (!item) {
      this.error(new Error('This note is unavailable.'));
      return Promise.resolve(false);
    }
    const at: Location = {
      scope: effectiveScope(this.state.snapshot.items, id),
      itemId: id,
    };
    return this.navigate(composeKey(at), at, true, true);
  }
  private get pendingMutationRetry() {
    return this.uncertainPurgeRetries.values().next().value ?? this.retryIntent;
  }
  // The most recent command can retain its own UI context while an uncertain
  // purge takes priority. It becomes active only when these identities match.
  get commandRetryIdentity(): object | null {
    return this.retryIntent;
  }
  // Opaque identity lets UI continuations match a captured retry without invoking it.
  get mutationRetryIdentity(): object | null {
    return this.pendingMutationRetry;
  }
  async retryMutation() {
    const intent = this.pendingMutationRetry;
    if (!intent) return false;
    if (this.retryGenerations.get(intent) !== this.state.cacheGeneration) {
      this.error(
        new Error(
          'The library was replaced. Captured work is retained for recovery.',
        ),
      );
      return false;
    }
    const ok = await intent();
    if (ok && this.retryIntent === intent) {
      this.retryIntent = null;
      this.patch({ mutationRetry: this.uncertainPurgeRetries.size > 0 });
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
          : compose.ownerId === null
            ? { scope: 'live', itemId: null }
            : {
                scope: effectiveScope(
                  this.state.snapshot.items,
                  compose.ownerId,
                ),
                itemId: compose.ownerId,
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
        const known = this.reconciledCaptures.has(request.id);
        const s = known
          ? await this.repo.loadWorkspace()
          : await this.repo.captureItem(replay);
        if (known && !s.items.some((x) => x.id === request.id))
          throw new Error(
            'The saved capture is unavailable. Your newer draft is retained.',
          );
        this.captureIntents.delete(key);
        this.reconciledCaptures.delete(request.id);
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
    this.completionGenerations.set(intent, this.state.cacheGeneration);
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
    if (
      intent &&
      this.completionGenerations.get(intent) !== this.state.cacheGeneration
    ) {
      this.error(
        new Error(
          'The library was replaced. Captured work is retained for recovery.',
        ),
      );
      return Promise.resolve(false);
    }
    return intent
      ? this.setNoteDone(intent.id, intent.done)
      : Promise.resolve(false);
  }
  remove(id = this.state.activeKey) {
    if (composeOwner(id)) return Promise.resolve(false);
    const view = this.viewIntent;
    const origin = { ...this.state.location };
    const leave =
      origin.scope === 'live' &&
      origin.itemId !== null &&
      subtreeIds(this.state.snapshot, id).includes(origin.itemId)
        ? origin
        : undefined;
    return this.run(async () => {
      this.patch({ operation: 'delete' });
      try {
        if (!(await this.checkpoint())) {
          this.retryIntent = () => this.remove(id);
          this.patch({ mutationRetry: true });
          return false;
        }
        if (!(await this.reconcileCreations())) {
          this.retryIntent = () => this.remove(id);
          this.patch({ mutationRetry: true });
          return false;
        }
        const prior = this.state.snapshot;
        const current = this.state.location;
        const target = prior.items.find((x) => x.id === id);
        if (!target) throw new Error('This note is unavailable.');
        this.snapshot(await this.repo.deleteItem(id, leave));
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
          this.patch({ ownerId: at.itemId, location: at });
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
              ? 'This note is already in Trash. Restore is available.'
              : 'Deleted. Undo delete is available.',
          error: '',
          mutationRetry: this.uncertainPurgeRetries.size > 0,
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
  capturePurge(id: string): PurgeItem {
    if (effectiveScope(this.state.snapshot.items, id) !== 'trash')
      throw new Error('Only notes in Trash can be permanently deleted.');
    return {
      id,
      location: itemLocation(this.state.snapshot.items, id),
      expectedSubtreeIds: subtreeIds(this.state.snapshot, id),
    };
  }
  purgeItem(request: PurgeItem): Promise<boolean> {
    return this.runPurge(structuredClone(request), false);
  }
  private retainPurgeRetry(captured: PurgeItem, attempted: boolean) {
    const pending = this.uncertainPurgeRetries.get(captured.id);
    if (!pending) {
      const retry = () => this.runPurge(captured, attempted);
      if (attempted) this.uncertainPurgeRetries.set(captured.id, retry);
      this.retryIntent = retry;
    }
    // Repeated Delete/reconciliation reuses the exact pending purge, without
    // replacing a newer failed command that will become Retry after its ACK.
    this.patch({ mutationRetry: true });
  }
  private runPurge(captured: PurgeItem, replay: boolean): Promise<boolean> {
    return this.run(async () => {
      this.patch({ operation: 'purge' });
      let attempted = replay;
      try {
        let result: PurgeResult | undefined;
        const prior = this.state.snapshot;
        if (replay) {
          const current = await this.repo.loadWorkspace();
          if (!current.items.some((x) => x.id === captured.id)) {
            // This is an exact neutral postcondition acknowledgment, not a new
            // deletion. Removed-owner buffers cannot be flushed after a lost reply.
            result = await this.repo.purgeItem(captured);
          }
        }
        if (!result) {
          if (
            !(await this.checkpoint()) ||
            !(await this.reconcileCreations())
          ) {
            this.retainPurgeRetry(captured, replay);
            return false;
          }
          attempted = true;
          result = await this.repo.purgeItem(captured);
        }
        const removed = new Set(result.removedIds);
        const gone = (key: string) =>
          removed.has(key) ||
          (key.startsWith('compose:') && removed.has(key.slice(8)));
        const buffers = Object.fromEntries(
          Object.entries(this.state.buffers).filter(([key]) => !gone(key)),
        );
        for (const key of this.dirty) if (gone(key)) this.dirty.delete(key);
        for (const [key, pending] of this.captureIntents)
          if (gone(key) || removed.has(pending.id)) {
            this.captureIntents.delete(key);
            this.reconciledCaptures.delete(pending.id);
          }
        for (const [id, pending] of this.childIntents)
          if (
            removed.has(id) ||
            (pending.parent.itemId !== null &&
              removed.has(pending.parent.itemId))
          ) {
            this.childIntents.delete(id);
            if (this.creationIntent?.id === id) this.creationIntent = null;
          }
        let at = this.state.location;
        if (at.itemId !== null && removed.has(at.itemId)) {
          const index = new Map(prior.items.map((x) => [x.id, x]));
          let parent = index.get(at.itemId)?.parentId ?? null;
          while (
            parent !== null &&
            (removed.has(parent) ||
              !result.workspace.items.some(
                (x) => x.id === parent && x.kind === 'tree',
              ))
          )
            parent = index.get(parent)?.parentId ?? null;
          at = { scope: at.scope, itemId: parent };
        }
        const acknowledgedRetry = this.uncertainPurgeRetries.get(captured.id);
        this.uncertainPurgeRetries.delete(captured.id);
        if (this.retryIntent === acknowledgedRetry) this.retryIntent = null;
        if (
          this.state.completionRetry &&
          removed.has(this.state.completionRetry.id)
        )
          this.completionIntent++;
        this.patch({
          snapshot: result.workspace,
          location: at,
          ownerId: at.itemId,
          buffers,
          purgedItemIds: [
            ...new Set([...this.state.purgedItemIds, ...result.removedIds]),
          ],
          completionRetry:
            this.state.completionRetry &&
            removed.has(this.state.completionRetry.id)
              ? null
              : this.state.completionRetry,
          mutationRetry: this.pendingMutationRetry !== null,
          error: '',
          status: 'Permanently deleted',
        });
        if (gone(this.state.activeKey)) this.context(composeKey(at));
        return true;
      } catch (e) {
        this.error(e);
        this.retainPurgeRetry(captured, attempted);
        return false;
      } finally {
        this.patch({ operation: null });
      }
    });
  }
  private captureGroup(ids: string[]): {
    ids: string[];
    from: Location;
    order: string[];
  } {
    if (!ids.length || new Set(ids).size !== ids.length)
      throw new Error('Select unique sibling notes.');
    const from = itemLocation(this.state.snapshot.items, ids[0]);
    const order = directEntries(this.state.snapshot, from).map((x) => x.id),
      selected = new Set(ids);
    const members = new Set(order);
    if (ids.some((id) => !members.has(id)))
      throw new Error('Select notes from one sibling group.');
    return { ids: order.filter((id) => selected.has(id)), from, order };
  }
  captureMove(ids: string[], to: Location, toIndex: number): MoveItems {
    const source = this.captureGroup(ids),
      selected = new Set(source.ids),
      same = source.from.scope === to.scope && source.from.itemId === to.itemId;
    if (to.itemId !== null) {
      const target = this.state.snapshot.items.find((x) => x.id === to.itemId);
      if (
        !target ||
        target.kind !== 'tree' ||
        effectiveScope(this.state.snapshot.items, target.id) !== to.scope
      )
        throw new Error('This destination is unavailable.');
      const index = new Map(this.state.snapshot.items.map((x) => [x.id, x]));
      let parent: string | null = to.itemId;
      while (parent !== null) {
        if (selected.has(parent))
          throw new Error('A note cannot move inside itself.');
        parent = index.get(parent)?.parentId ?? null;
      }
    }
    const beforeTo = same
      ? source.order
      : directEntries(this.state.snapshot, to).map((x) => x.id);
    const remaining = beforeTo.filter((id) => !selected.has(id));
    if (
      !Number.isSafeInteger(toIndex) ||
      toIndex < 0 ||
      toIndex > remaining.length
    )
      throw new Error('Invalid insertion gap.');
    const afterTo = [
      ...remaining.slice(0, toIndex),
      ...source.ids,
      ...remaining.slice(toIndex),
    ];
    return captureMoveProof(this.state.snapshot, {
      ids: source.ids,
      from: { ...source.from },
      to: { ...to },
      beforeFrom: [...source.order],
      beforeTo: [...beforeTo],
      afterFrom: same
        ? [...afterTo]
        : source.order.filter((id) => !selected.has(id)),
      afterTo,
    });
  }
  captureReorder(ids: string[], finalOrder: string[]): MoveItems {
    const source = this.captureGroup(ids),
      selected = new Set(source.ids);
    const members = new Set(source.order);
    if (
      finalOrder.length !== source.order.length ||
      new Set(finalOrder).size !== finalOrder.length ||
      finalOrder.some((id) => !members.has(id)) ||
      finalOrder.filter((id) => selected.has(id)).join() !==
        source.ids.join() ||
      finalOrder.filter((id) => !selected.has(id)).join() !==
        source.order.filter((id) => !selected.has(id)).join()
    )
      throw new Error('Invalid sibling order.');
    return captureMoveProof(this.state.snapshot, {
      ids: source.ids,
      from: { ...source.from },
      to: { ...source.from },
      beforeFrom: [...source.order],
      beforeTo: [...source.order],
      afterFrom: [...finalOrder],
      afterTo: [...finalOrder],
    });
  }
  moveItems(request: MoveItems): Promise<boolean> {
    const captured = structuredClone(request);
    return this.itemMetadata(
      'move',
      () => this.repo.moveItems(captured),
      'Notes moved',
    );
  }
  private async reconcileCreations(skipChild?: string): Promise<boolean> {
    if (
      !this.captureIntents.size &&
      ![...this.childIntents.keys()].some((id) => id !== skipChild)
    )
      return true;
    try {
      let current = await this.repo.loadWorkspace();
      for (const [key, request] of this.captureIntents) {
        const existing = current.items.find(
          (x) => x.id.toLowerCase() === request.id.toLowerCase(),
        );
        if (existing) {
          if (!this.reconciledCaptures.has(request.id)) {
            const replay =
              existing.parentId === request.location.itemId &&
              existing.parentId !== null
                ? {
                    ...request,
                    location: {
                      ...request.location,
                      scope: effectiveScope(current.items, existing.parentId),
                    },
                  }
                : request;
            current = await this.repo.captureItem(replay);
            this.reconciledCaptures.add(request.id);
          }
        } else {
          this.captureIntents.delete(key);
          this.reconciledCaptures.delete(request.id);
        }
      }
      for (const [id, request] of this.childIntents) {
        if (id === skipChild) continue;
        if (current.items.some((x) => x.id.toLowerCase() === id.toLowerCase()))
          current = await this.repo.createChildTree(request);
        this.childIntents.delete(id);
        if (this.creationIntent?.id === id) this.creationIntent = null;
      }
      this.snapshot(current);
      return true;
    } catch (e) {
      this.error(e);
      return false;
    }
  }
  restoreItem(id: string) {
    return this.itemMetadata(
      'restore-item',
      () => this.repo.restoreItem(id),
      'Note restored',
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
        if (!(await this.reconcileCreations())) {
          this.retryIntent = () => this.itemMetadata(operation, fn, status);
          this.patch({ mutationRetry: true });
          return false;
        }
        this.snapshot(await fn());
        this.reconcileScope();
        this.retryIntent = null;
        this.patch({
          mutationRetry: this.uncertainPurgeRetries.size > 0,
          error: '',
          status,
        });
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
    let captured: ReturnType<typeof captureUndoDelete>;
    try {
      captured = captureUndoDelete(this.state.snapshot);
    } catch (e) {
      this.error(e);
      return Promise.resolve(false);
    }
    return this.itemMetadata(
      'restore-item',
      () => this.repo.undoDelete(captured),
      'Delete undone',
    );
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
            ownerId: null,
            location: { scope: 'live', itemId: null },
          });
          this.context(composeKey(null));
          this.completionIntent++;
          this.viewIntent++;
          this.creationIntent = null;
          this.childIntents.clear();
          this.captureIntents.clear();
          this.reconciledCaptures.clear();
          this.uncertainPurgeRetries.clear();
          this.patch({ purgedItemIds: [] });
          this.retryIntent = null;
          this.patch({ mutationRetry: this.uncertainPurgeRetries.size > 0 });
          this.patch({
            query: '',
            status: 'Library restored',
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
