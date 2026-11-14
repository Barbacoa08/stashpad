import { liveQuery } from 'dexie';
import type {
  ColorToken,
  Draft,
  Item,
  Location,
  WorkspaceSnapshot,
} from '../domain/notes';
import { emptyWorkspace, MAX_ENVELOPE } from '../domain/notes';
import * as rules from '../domain/items';
import { scopeIndex, composeOwner } from '../domain/hierarchy';
import type { BackupFiles } from '../platform/backup-files';
import type {
  CaptureItem,
  CreateChildTree,
  DraftAck,
  MoveItems,
  PurgeItem,
  ReorderItem,
  Repository,
  RestorePreview,
  TransitionLocation,
  UndoDeleteRequest,
} from '../platform/workspace';
import { ScratchtreeDatabase } from './database';
import type { UndoRow } from './database';
import { projectLibrary } from './canonical';
import {
  encodeCloudBackup,
  validateCloudBackup,
  type BackupV8,
  type RecoveryRecord,
} from './backup';
import {
  digest,
  canonicalJson,
  type IntentCommand,
  type PendingIntent,
  type ExpectedOutcome,
  type ItemFieldDeltas,
} from './intents';
import type { SharedItem, OrderRow, Placement } from './types';
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const bytes = (x: unknown) =>
  new TextEncoder().encode(JSON.stringify(x)).length;
const providerFields = <T>(row: T): T => {
  const copy = { ...row } as T & { owner?: unknown; realmId?: unknown };
  delete copy.owner;
  delete copy.realmId;
  return copy;
};
const placement = (item: Item): Placement => ({
  parentId: item.parentId,
  deletedAt: item.deletedAt,
  restoreParentId: item.restoreParentId,
  restoreIndex: item.restoreIndex,
});
const share = (item: Item, epoch: string): SharedItem => {
  const {
    parentId,
    position: _position,
    deletedAt,
    restoreParentId,
    restoreIndex,
    ...source
  } = item;
  return {
    ...source,
    epoch,
    placement: { parentId, deletedAt, restoreParentId, restoreIndex },
  };
};
function orders(snapshot: WorkspaceSnapshot, epoch: string): OrderRow[] {
  const scopes = scopeIndex(snapshot.items),
    groups = new Map<string, OrderRow>();
  for (const item of snapshot.items) {
    const scope = item.parentId === null ? scopes.get(item.id)! : 'live';
    const id = item.parentId ?? `root:${scope}`;
    const row = groups.get(id) ?? {
      id,
      epoch,
      parentId: item.parentId,
      scope,
      ids: [],
    };
    row.ids.push(item.id);
    groups.set(id, row);
  }
  const positions = new Map(snapshot.items.map((x) => [x.id, x.position]));
  return [...groups.values()].map((x) => ({
    ...x,
    ids: x.ids.sort((a, b) => positions.get(a)! - positions.get(b)!),
  }));
}
interface State {
  epoch: string;
  snapshot: WorkspaceSnapshot;
  purgedIds: string[];
  recovery: RecoveryRecord[];
  undo?: UndoRow;
}
const unavailable = () =>
  Object.assign(
    new Error(
      'This note is unavailable. Your latest input is retained for recovery.',
    ),
    { code: 'target_unavailable' },
  );
const replaced = () =>
  Object.assign(
    new Error(
      'The shared library was replaced. Your captured work is retained for recovery.',
    ),
    { code: 'library_replaced' },
  );
const stale = () =>
  new Error(
    'The captured notes or library changed. Your content is retained for recovery.',
  );
/** Local acknowledgment is IndexedDB durability only, never server acceptance. */
export class DexieRepository implements Repository {
  private queue: Promise<unknown> = Promise.resolve();
  private staged: { token: string; backup: BackupV8; epoch: string } | null =
    null;
  private closed = false;
  private boundEpoch: string | null = null;
  private viewKey() {
    return `library-view:${this.libraryId}`;
  }
  private requireEpoch() {
    if (!this.boundEpoch) throw new Error('Load the workspace before editing.');
    return this.boundEpoch;
  }
  readonly libraryId: string;
  constructor(
    readonly db: ScratchtreeDatabase,
    private files: BackupFiles,
    libraryId?: string,
  ) {
    if (db.cloudEnabled && !libraryId)
      throw new Error('A cloud library identity is required.');
    this.libraryId = libraryId ?? 'local';
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(() => {
      if (this.closed) throw new Error('Repository is closed.');
      return fn();
    });
    this.queue = result.catch(() => {});
    return result;
  }
  private tables() {
    return [
      this.db.notes,
      this.db.orders,
      this.db.purges,
      this.db.libraries,
      this.db.witnesses,
      this.db.drafts,
      this.db.undo,
      this.db.recovery,
      this.db.pending,
      this.db.device,
    ];
  }
  private async initialize() {
    await this.db.open();
    await this.db.transaction('rw', this.db.libraries, async () => {
      if (!(await this.db.libraries.get(this.libraryId))) {
        if (this.db.cloudEnabled)
          throw new Error('The shared library has not been initialized.');
        await this.db.libraries.add({
          id: this.libraryId,
          epoch: crypto.randomUUID(),
        });
      }
    });
  }
  private async read(capturedEpoch?: string): Promise<State> {
    const library = await this.db.libraries.get(this.libraryId);
    if (!library) throw stale();
    const epoch = capturedEpoch ?? library.epoch;
    const [rows, orderRows, purges, drafts, undo, recovery] = await Promise.all(
      [
        this.db.notes.where('epoch').equals(epoch).toArray(),
        this.db.orders.where('epoch').equals(epoch).toArray(),
        this.db.purges.where('epoch').equals(epoch).toArray(),
        this.db.drafts.where('epoch').equals(epoch).toArray(),
        this.db.undo.get(epoch),
        this.db.recovery.toArray(),
      ],
    );
    const projected = projectLibrary(
      rows.map(providerFields),
      orderRows.map(providerFields),
      purges.map(providerFields),
      epoch,
    );
    const snapshot: WorkspaceSnapshot = {
      items: projected.items,
      drafts: drafts.map(({ epoch: _epoch, ...draft }) => draft),
      undoDeleteIds: undo?.ids ?? [],
    };
    // Remote purge/replacement must preserve orphaned checkpoints before pruning them.
    const ids = new Set(snapshot.items.map((x) => x.id));
    snapshot.drafts = snapshot.drafts.filter((d) => {
      const owner =
        d.key.startsWith('compose:') && d.key !== 'compose:trash'
          ? d.key.slice(8)
          : d.key === 'compose' || d.key === 'compose:trash'
            ? null
            : d.key;
      if (owner === null || ids.has(owner)) return true;
      const existing = recovery.find(
        (x) =>
          x.kind === 'draft' &&
          x.reason === 'purged' &&
          x.originEpoch === epoch &&
          x.draftKey === d.key,
      );
      if (existing && existing.kind === 'draft') existing.markdown = d.markdown;
      else
        recovery.push({
          id: crypto.randomUUID(),
          kind: 'draft',
          draftKey: d.key,
          markdown: d.markdown,
          reason: 'purged',
          originEpoch: epoch,
          recordedAt: Date.now(),
        });
      return false;
    });
    const facts = new Map(undo?.facts.map((x) => [x.id, x]) ?? []),
      actual = new Map(rules.structuralItems(snapshot).map((x) => [x.id, x]));
    snapshot.undoDeleteIds = snapshot.undoDeleteIds.filter((id) => {
      const item = actual.get(id),
        old = facts.get(id);
      return (
        item?.deletedAt != null &&
        (!old ||
          (item.deletedAt === old.deletedAt &&
            item.restoreParentId === old.restoreParentId &&
            item.restoreIndex === old.restoreIndex))
      );
    });
    const state = {
      epoch,
      snapshot,
      purgedIds: projected.purgedIds,
      recovery,
      undo,
    };
    this.encode(state);
    return state;
  }
  private encode(state: State) {
    return encodeCloudBackup({
      library: { items: state.snapshot.items, purgedIds: state.purgedIds },
      device: {
        drafts: state.snapshot.drafts,
        undoDeleteIds: state.snapshot.undoDeleteIds,
        recovery: state.recovery,
      },
    });
  }
  private async local(state: State, markView = true) {
    const existing = await this.db.drafts
        .where('epoch')
        .equals(state.epoch)
        .toArray(),
      wanted = new Map(state.snapshot.drafts.map((x) => [x.key, x]));
    for (const old of existing)
      if (!wanted.has(old.key))
        await this.db.drafts.delete([state.epoch, old.key]);
    const existingByKey = new Map(existing.map((x) => [x.key, x]));
    for (const d of state.snapshot.drafts) {
      const old = existingByKey.get(d.key);
      if (!old || !equal({ ...d, epoch: state.epoch }, old))
        await this.db.drafts.put({ ...d, epoch: state.epoch });
    }
    const facts = rules
      .structuralItems(state.snapshot)
      .filter((x) => state.snapshot.undoDeleteIds.includes(x.id));
    await this.db.undo.put({
      epoch: state.epoch,
      ids: state.snapshot.undoDeleteIds,
      facts,
    });
    for (const record of state.recovery) await this.db.recovery.put(record);
    if (markView)
      await this.db.device.put({
        key: this.viewKey(),
        value: { epoch: state.epoch, snapshot: state.snapshot },
      });
  }
  loadWorkspace() {
    return this.serial(async () => {
      await this.initialize();
      const state = await this.db.transaction('rw', this.tables(), async () => {
        const current = await this.read();
        const marker = (await this.db.device.get(this.viewKey()))?.value as
          { epoch: string; snapshot: WorkspaceSnapshot } | undefined;
        if (
          marker &&
          marker.epoch !== current.epoch &&
          !current.recovery.some(
            (x) => x.kind === 'library' && x.originEpoch === marker.epoch,
          )
        ) {
          let retired: WorkspaceSnapshot;
          try {
            retired = (await this.read(marker.epoch)).snapshot;
          } catch {
            retired = marker.snapshot;
          }
          if (
            retired.items.length ||
            retired.drafts.length ||
            (await this.db.pending.where('epoch').equals(marker.epoch).count())
          )
            current.recovery.push({
              id: crypto.randomUUID(),
              kind: 'library',
              snapshot: retired,
              reason: 'replaced',
              originEpoch: marker.epoch,
              recordedAt: Date.now(),
            });
        }
        this.encode(current);
        await this.local(current);
        return current;
      });
      this.boundEpoch = state.epoch;
      return state.snapshot;
    });
  }
  /** Epoch of the last acknowledged view; reading this never adopts a remote replacement. */
  getEpoch() {
    return this.serial(async () => this.requireEpoch());
  }
  /** Current raw pointer, for background detection only. */
  readCurrentEpoch() {
    return this.serial(async () => {
      await this.initialize();
      const row = await this.db.libraries.get(this.libraryId);
      if (!row) throw stale();
      return row.epoch;
    });
  }
  subscribeInvalidation(listener: () => void) {
    const subscription = liveQuery(async () => {
      const pointer = await this.db.libraries.get(this.libraryId);
      if (!pointer) return null;
      return Promise.all([
        this.db.notes.where('epoch').equals(pointer.epoch).toArray(),
        this.db.orders.where('epoch').equals(pointer.epoch).toArray(),
        this.db.purges.where('epoch').equals(pointer.epoch).toArray(),
        pointer,
      ]);
    }).subscribe({ next: () => listener() });
    return () => subscription.unsubscribe();
  }
  close() {
    this.closed = true;
    this.db.close();
  }
  private retainSource(
    state: State,
    source: { itemId: string; markdown: string },
    recordedAt: number,
    reason: RecoveryRecord['reason'] = 'unknown',
  ) {
    const existing = state.recovery.find(
      (record) =>
        record.kind === 'source' &&
        record.originEpoch === state.epoch &&
        record.itemId === source.itemId,
    );
    if (existing && existing.kind === 'source')
      Object.assign(existing, {
        markdown: source.markdown,
        recordedAt,
        reason,
      });
    else
      state.recovery.push({
        id: crypto.randomUUID(),
        kind: 'source',
        ...source,
        originEpoch: state.epoch,
        recordedAt,
        reason,
      });
  }
  private async retainRejectedSource(
    state: State,
    command: Extract<IntentCommand, { kind: 'saveItemSource' }>,
    recordedAt: number,
  ) {
    if (
      command.draft.key !== command.id ||
      !Number.isSafeInteger(command.draft.revision) ||
      command.draft.revision < 0
    )
      throw new Error('Invalid draft acknowledgment.');
    const key = `source-recovery:${canonicalJson([state.epoch, command.id, command.draft.key])}`;
    const marker = (await this.db.device.get(key))?.value as
      { id?: unknown; revision?: unknown } | undefined;
    const sources = state.recovery.filter(
      (record) =>
        record.kind === 'source' &&
        record.originEpoch === state.epoch &&
        record.itemId === command.id,
    );
    const existing =
      sources.find((record) => record.id === marker?.id) ?? sources[0];
    const candidate: RecoveryRecord = {
      id: existing?.id ?? crypto.randomUUID(),
      kind: 'source',
      itemId: command.id,
      markdown: command.markdown,
      originEpoch: state.epoch,
      recordedAt,
      reason: state.purgedIds.includes(command.id) ? 'purged' : 'rejected',
    };
    const recovery = existing
      ? state.recovery.map((record) =>
          record.id === existing.id ? candidate : record,
        )
      : [...state.recovery, candidate];
    // A stale request must still satisfy the strict source/envelope contract.
    this.encode({ ...state, recovery });
    if (
      existing &&
      marker?.id === existing.id &&
      Number.isSafeInteger(marker.revision) &&
      (marker.revision as number) >= command.draft.revision
    )
      return;
    state.recovery = recovery;
    await this.db.device.put({
      key,
      value: { id: candidate.id, revision: command.draft.revision },
    });
  }
  private async retainRejectedDraft(
    state: State,
    input: { key: string; markdown: string; revision: number },
    recordedAt: number,
  ) {
    const key = `draft-recovery:${canonicalJson([state.epoch, input.key])}`;
    const marker = (await this.db.device.get(key))?.value as
      { id?: unknown; revision?: unknown } | undefined;
    const existing =
      typeof marker?.id === 'string'
        ? state.recovery.find(
            (record) =>
              record.id === marker.id &&
              record.kind === 'draft' &&
              record.reason === 'rejected' &&
              record.originEpoch === state.epoch &&
              record.draftKey === input.key,
          )
        : undefined;
    const candidate: RecoveryRecord = {
      id: existing?.id ?? crypto.randomUUID(),
      kind: 'draft',
      draftKey: input.key,
      markdown: input.markdown,
      reason: 'rejected',
      originEpoch: state.epoch,
      recordedAt,
    };
    const recovery = existing
      ? state.recovery.map((record) =>
          record.id === existing.id ? candidate : record,
        )
      : [...state.recovery, candidate];
    // Validate every supplied payload, including stale requests, before writing.
    this.encode({ ...state, recovery });
    if (
      existing &&
      Number.isSafeInteger(marker?.revision) &&
      (marker!.revision as number) >= input.revision
    )
      return;
    state.recovery = recovery;
    await this.db.device.put({
      key,
      value: { id: candidate.id, revision: input.revision },
    });
  }
  private async persistRecovery(state: State) {
    this.encode(state);
    for (const record of state.recovery) await this.db.recovery.put(record);
  }
  private localMutation(
    fn: (s: WorkspaceSnapshot) => void,
    preserveCheckpoint?: { key: string; markdown: string; revision: number },
  ) {
    const capturedEpoch = this.boundEpoch;
    return this.serial(async () => {
      await this.initialize();
      const commandEpoch = capturedEpoch ?? this.requireEpoch();
      const result = await this.db.transaction(
        'rw',
        this.tables(),
        async () => {
          const pointer = await this.db.libraries.get(this.libraryId),
            changed = pointer?.epoch !== commandEpoch;
          if (changed && !preserveCheckpoint) throw replaced();
          const state = await this.read(commandEpoch);
          if (preserveCheckpoint) {
            if (
              !Number.isSafeInteger(preserveCheckpoint.revision) ||
              preserveCheckpoint.revision < 0
            )
              throw new Error('Invalid draft revision.');
            const owner = composeOwner(preserveCheckpoint.key),
              ownerId = owner ? owner.ownerId : preserveCheckpoint.key;
            if (
              ownerId !== null &&
              !state.snapshot.items.some((item) => item.id === ownerId)
            ) {
              await this.retainRejectedDraft(
                state,
                preserveCheckpoint,
                Date.now(),
              );
              await this.persistRecovery(state);
              return { snapshot: state.snapshot, changed, unavailable: true };
            }
          }
          fn(state.snapshot);
          if (changed)
            for (const draft of state.snapshot.drafts) {
              const existing = state.recovery.find(
                (x) =>
                  x.kind === 'draft' &&
                  x.originEpoch === commandEpoch &&
                  x.draftKey === draft.key,
              );
              if (existing && existing.kind === 'draft')
                existing.markdown = draft.markdown;
              else
                state.recovery.push({
                  id: crypto.randomUUID(),
                  kind: 'draft',
                  draftKey: draft.key,
                  markdown: draft.markdown,
                  reason: 'replaced',
                  originEpoch: commandEpoch,
                  recordedAt: Date.now(),
                });
            }
          this.encode(state);
          await this.local(state, !changed);
          return { snapshot: state.snapshot, changed, unavailable: false };
        },
      );
      if (result.changed) throw replaced();
      if (result.unavailable) throw unavailable();
      return result.snapshot;
    });
  }
  checkpointDraft(key: string, markdown: string, revision: number) {
    return this.localMutation(
      (s) => {
        const draft: Draft = { key, markdown, revision, updatedAt: Date.now() };
        const probe = structuredClone(s);
        probe.drafts = probe.drafts.filter((d) => d.key !== key);
        probe.drafts.push(draft);
        encodeCloudBackup({
          library: { items: probe.items, purgedIds: [] },
          device: {
            drafts: probe.drafts,
            undoDeleteIds: probe.undoDeleteIds,
            recovery: [],
          },
        });
        const old = s.drafts.find((d) => d.key === key);
        if (!old || revision > old.revision) {
          s.drafts = s.drafts.filter((d) => d.key !== key);
          s.drafts.push(draft);
        }
      },
      { key, markdown, revision },
    );
  }
  discardDraft(key: string) {
    return this.localMutation((s) => {
      s.drafts = s.drafts.filter((d) => d.key !== key);
    });
  }
  private apply(s: WorkspaceSnapshot, c: IntentCommand): string[] {
    switch (c.kind) {
      case 'replaceLibrary':
        throw new Error('Library replacement requires a staged restore.');
      case 'saveItemSource':
        rules.saveItemSource(s, c.id, c.markdown, c.draft);
        break;
      case 'captureItem':
        rules.captureItem(s, c.request);
        break;
      case 'createChildTree':
        rules.createChildTree(s, c.request);
        break;
      case 'promoteItem':
        rules.promoteItem(s, c.id);
        break;
      case 'deleteItem':
        rules.deleteItem(s, c.id, c.leave);
        break;
      case 'purgeItem':
        return rules.purgeItem(s, c.request);
      case 'transitionLocation':
        rules.transitionLocation(s, c.request);
        break;
      case 'moveItems':
        rules.moveItems(s, c.request);
        break;
      case 'restoreItem':
        rules.restoreItem(s, c.id);
        break;
      case 'undoDelete':
        rules.undoDelete(s, c.request);
        break;
      case 'setItemDone':
        rules.setItemDone(s, c.id, c.done);
        break;
      case 'setItemColor':
        rules.setItemColor(s, c.id, c.color);
        break;
      case 'reorderItem':
        rules.reorderItem(s, c.request);
        break;
    }
    return [];
  }
  private async expected(
    before: WorkspaceSnapshot,
    after: WorkspaceSnapshot,
    purgedIds: string[],
  ): Promise<ExpectedOutcome> {
    const old = new Map(before.items.map((x) => [x.id, x])),
      next = new Map(after.items.map((x) => [x.id, x]));
    const items: ExpectedOutcome['items'] = [];
    for (const id of new Set([...old.keys(), ...next.keys()])) {
      const previous = old.get(id),
        value = next.get(id);
      if (equal(previous, value)) continue;
      const structural = (item: Item) =>
        rules.structuralItems({
          items: [item],
          drafts: [],
          undoDeleteIds: [],
        })[0];
      const identity = { id, digest: await digest(value ?? null) };
      if (!previous && value)
        items.push({
          ...identity,
          kind: 'create',
          structural: structural(value),
          item: value,
        });
      else if (previous && !value)
        items.push({
          ...identity,
          kind: 'purge',
          structural: null,
          before: structural(previous),
        });
      else if (previous && value) {
        const fields: ItemFieldDeltas = {};
        for (const key of [
          'kind',
          'done',
          'color',
          'position',
          'updatedAt',
        ] as const)
          if (!equal(previous[key], value[key]))
            Object.assign(fields, {
              [key]: { before: previous[key], after: value[key] },
            });
        items.push({
          ...identity,
          kind: 'update',
          structural: structural(value),
          fields,
          ...(!equal(placement(previous), placement(value))
            ? {
                placement: {
                  before: placement(previous),
                  after: placement(value),
                },
              }
            : {}),
          ...(previous.markdown !== value.markdown
            ? {
                source: {
                  beforeDigest: await digest(previous.markdown),
                  afterDigest: await digest(value.markdown),
                },
              }
            : {}),
        });
      }
    }
    const priorOrders = new Map(orders(before, '').map((x) => [x.id, x]));
    const nextOrders = new Map(orders(after, '').map((x) => [x.id, x]));
    const expectedOrders = [
      ...new Set([...priorOrders.keys(), ...nextOrders.keys()]),
    ]
      .filter((id) => !equal(priorOrders.get(id), nextOrders.get(id)))
      .map((id) => {
        const row = nextOrders.get(id) ?? priorOrders.get(id)!;
        return {
          group: { scope: row.scope, itemId: row.parentId },
          ids: nextOrders.get(id)?.ids ?? [],
        };
      });
    return { items, purgedIds, orders: expectedOrders };
  }
  private outcomeMatches(
    state: State,
    expected: ExpectedOutcome,
    command: IntentCommand,
  ): boolean {
    const items = new Map(state.snapshot.items.map((item) => [item.id, item]));
    return (
      expected.purgedIds.every((id) => state.purgedIds.includes(id)) &&
      expected.items.every((outcome) => {
        const actual = items.get(outcome.id);
        if (outcome.kind === 'purge')
          return !actual && state.purgedIds.includes(outcome.id);
        if (!actual) return false;
        if (outcome.kind === 'create') return equal(actual, outcome.item);
        if (
          outcome.placement &&
          !equal(placement(actual), outcome.placement.after)
        )
          return false;
        if (
          outcome.source &&
          (command.kind !== 'saveItemSource' ||
            command.id !== outcome.id ||
            actual.markdown !== command.markdown)
        )
          return false;
        return (Object.keys(outcome.fields) as (keyof ItemFieldDeltas)[]).every(
          (key) =>
            key === 'updatedAt' ||
            equal(actual[key], outcome.fields[key]!.after),
        );
      })
    );
  }
  private async persist(before: State, after: State, capturedAt = Date.now()) {
    const previous = new Map(before.snapshot.items.map((x) => [x.id, x]));
    for (const item of after.snapshot.items) {
      const old = previous.get(item.id),
        key: [string, string] = [after.epoch, item.id];
      if (!old) {
        await this.db.notes.add(share(item, after.epoch));
        continue;
      }
      const from = share(old, after.epoch),
        to = share(item, after.epoch);
      const changes: Record<string, unknown> = {};
      for (const property of [
        'kind',
        'markdown',
        'done',
        'color',
        'createdAt',
        'updatedAt',
        'placement',
      ] as const)
        if (!equal(from[property], to[property]))
          changes[property] = to[property];
      if (Object.keys(changes).length) await this.db.notes.update(key, changes);
    }
    for (const id of after.purgedIds)
      if (!before.purgedIds.includes(id)) {
        await this.db.notes.delete([after.epoch, id]);
        await this.db.purges.put({
          id,
          epoch: after.epoch,
          purgedAt: capturedAt,
        });
      }
    const oldOrders = new Map(
        orders(before.snapshot, before.epoch).map((x) => [x.id, x]),
      ),
      newOrders = new Map(
        orders(after.snapshot, after.epoch).map((x) => [x.id, x]),
      );
    for (const id of new Set([...oldOrders.keys(), ...newOrders.keys()])) {
      const row = newOrders.get(id);
      if (!equal(row, oldOrders.get(id))) {
        if (row) await this.db.orders.put(row);
        else await this.db.orders.delete([after.epoch, id]);
      }
    }
    await this.local(after);
  }
  private mutate(
    command: IntentCommand,
  ): Promise<{ workspace: WorkspaceSnapshot; removedIds: string[] }> {
    command = structuredClone(command);
    const capturedEpoch = this.boundEpoch;
    return this.serial(async () => {
      await this.initialize();
      const commandEpoch = capturedEpoch ?? this.requireEpoch();
      const capturedAt = Date.now();
      const before = await this.db.transaction('r', this.tables(), () =>
        this.read(commandEpoch),
      );
      if (
        command.kind === 'saveItemSource' &&
        !before.snapshot.items.some((item) => item.id === command.id)
      ) {
        await this.db.transaction('rw', this.tables(), async () => {
          const rejected = await this.read(commandEpoch);
          await this.retainRejectedSource(rejected, command, capturedAt);
          await this.persistRecovery(rejected);
        });
        if (
          (await this.db.libraries.get(this.libraryId))?.epoch !== commandEpoch
        )
          throw replaced();
        throw unavailable();
      }
      const fingerprint = await digest({ epoch: before.epoch, command });
      const candidates = (
        await this.db.pending.where('fingerprint').equals(fingerprint).toArray()
      ).sort((a, b) => b.recordedAt - a.recordedAt);
      let pending = candidates.find((x) => !x.localApplied);
      const after = structuredClone(before),
        removedIds = this.apply(after.snapshot, command);
      if (
        (command.kind === 'captureItem' &&
          before.purgedIds.includes(command.request.id)) ||
        (command.kind === 'createChildTree' &&
          before.purgedIds.includes(command.request.id))
      )
        throw stale();
      after.purgedIds = [...new Set([...after.purgedIds, ...removedIds])];
      if (!pending && equal(before.snapshot.items, after.snapshot.items))
        pending = candidates.find((x) =>
          this.outcomeMatches(before, x.expected, x.command),
        );
      // Latest source is recovery material even before the shared transaction can run.
      const source =
        command.kind === 'saveItemSource'
          ? { itemId: command.id, markdown: command.markdown }
          : command.kind === 'captureItem'
            ? { itemId: command.request.id, markdown: command.request.markdown }
            : command.kind === 'createChildTree'
              ? { itemId: command.request.id, markdown: 'Untitled' }
              : null;
      if (source) this.retainSource(after, source, capturedAt);
      this.encode(after);
      if (!pending) {
        const expected = await this.expected(
          before.snapshot,
          after.snapshot,
          removedIds,
        );
        pending = {
          id: crypto.randomUUID(),
          epoch: before.epoch,
          fingerprint,
          digest: await digest({ command, expected }),
          recordedAt: capturedAt,
          command,
          expected,
          localApplied: false,
        };
      }
      const intent = pending;
      await this.db.transaction(
        'rw',
        this.db.pending,
        this.db.recovery,
        async () => {
          const current = await this.db.pending.toArray();
          if (
            (!current.some((x) => x.id === intent.id) &&
              current.length >= 1000) ||
            bytes([...current.filter((x) => x.id !== intent.id), intent]) >
              MAX_ENVELOPE
          )
            throw new Error(
              'Pending recovery capacity reached. Export recovery before continuing.',
            );
          await this.db.pending.put(intent);
          for (const record of after.recovery)
            await this.db.recovery.put(record);
        },
      );
      return this.db.transaction('rw', this.tables(), async () => {
        if (
          (await this.db.libraries.get(this.libraryId))?.epoch !== intent.epoch
        )
          throw replaced();
        const fresh = await this.read();
        if (fresh.epoch !== intent.epoch) throw replaced();
        const next = structuredClone(fresh);
        const acknowledgedReplay =
          intent.localApplied &&
          this.outcomeMatches(fresh, intent.expected, intent.command);
        const removed = this.apply(next.snapshot, intent.command);
        if (!acknowledgedReplay)
          for (const outcome of intent.expected.items) {
            const actual =
              fresh.snapshot.items.find((x) => x.id === outcome.id) ?? null;
            const at = next.snapshot.items.findIndex(
              (x) => x.id === outcome.id,
            );
            if (outcome.kind === 'create') {
              if (actual !== null && !equal(actual, outcome.item))
                throw stale();
              if (at >= 0)
                next.snapshot.items[at] = structuredClone(outcome.item);
            } else if (outcome.kind === 'update') {
              if (actual === null || at < 0) throw stale();
              const target = next.snapshot.items[at];
              if (outcome.placement) {
                const actualPlacement = placement(actual);
                if (
                  !equal(actualPlacement, outcome.placement.before) &&
                  !equal(actualPlacement, outcome.placement.after)
                )
                  throw stale();
                Object.assign(target, outcome.placement.after);
              }
              for (const key of ['kind', 'position'] as const) {
                const change = outcome.fields[key];
                if (
                  change &&
                  !equal(actual[key], change.before) &&
                  !equal(actual[key], change.after)
                )
                  throw stale();
              }
              for (const key of Object.keys(
                outcome.fields,
              ) as (keyof ItemFieldDeltas)[]) {
                const change = outcome.fields[key]!;
                Object.assign(target, {
                  [key]:
                    key === 'updatedAt'
                      ? Math.max(actual.updatedAt, change.after as number)
                      : change.after,
                });
              }
            }
          }
        next.purgedIds = [...new Set([...fresh.purgedIds, ...removed])];
        this.encode(next);
        await this.persist(fresh, next, intent.recordedAt);
        await this.db.witnesses.put({
          id: intent.id,
          epoch: intent.epoch,
          digest: intent.digest,
          recordedAt: intent.recordedAt,
        });
        await this.db.pending.update(intent.id, { localApplied: true });
        return { workspace: next.snapshot, removedIds: removed };
      });
    });
  }
  saveItemSource(id: string, markdown: string, draft: DraftAck) {
    return this.mutate({ kind: 'saveItemSource', id, markdown, draft }).then(
      (x) => x.workspace,
    );
  }
  captureItem(request: CaptureItem) {
    return this.mutate({ kind: 'captureItem', request }).then(
      (x) => x.workspace,
    );
  }
  createChildTree(request: CreateChildTree) {
    return this.mutate({ kind: 'createChildTree', request }).then(
      (x) => x.workspace,
    );
  }
  promoteItem(id: string) {
    return this.mutate({ kind: 'promoteItem', id }).then((x) => x.workspace);
  }
  deleteItem(id: string, leave?: Location) {
    return this.mutate({
      kind: 'deleteItem',
      id,
      ...(leave ? { leave } : {}),
    }).then((x) => x.workspace);
  }
  purgeItem(request: PurgeItem) {
    return this.mutate({ kind: 'purgeItem', request });
  }
  transitionLocation(request: TransitionLocation) {
    return this.mutate({ kind: 'transitionLocation', request }).then(
      (x) => x.workspace,
    );
  }
  moveItems(request: MoveItems) {
    return this.mutate({ kind: 'moveItems', request }).then((x) => x.workspace);
  }
  restoreItem(id: string) {
    return this.mutate({ kind: 'restoreItem', id }).then((x) => x.workspace);
  }
  undoDelete(request: UndoDeleteRequest) {
    return this.mutate({ kind: 'undoDelete', request }).then(
      (x) => x.workspace,
    );
  }
  setItemDone(id: string, done: boolean) {
    return this.mutate({ kind: 'setItemDone', id, done }).then(
      (x) => x.workspace,
    );
  }
  setItemColor(id: string, color: ColorToken | null) {
    return this.mutate({ kind: 'setItemColor', id, color }).then(
      (x) => x.workspace,
    );
  }
  reorderItem(request: ReorderItem) {
    return this.mutate({ kind: 'reorderItem', request }).then(
      (x) => x.workspace,
    );
  }
  exportBackup() {
    return this.serial(async () => {
      await this.initialize();
      const text = await this.db.transaction('r', this.tables(), async () =>
        this.encode(await this.read()),
      );
      return this.files.chooseWrite(text);
    });
  }
  previewRestore(): Promise<RestorePreview | null> {
    return this.serial(async () => {
      const text = await this.files.chooseRead();
      if (text === null) return null;
      const backup = validateCloudBackup(text);
      if ('code' in backup) throw new Error(backup.message);
      const token = crypto.randomUUID();
      this.staged = {
        token,
        backup: structuredClone(backup),
        epoch: crypto.randomUUID(),
      };
      return {
        token,
        notes: backup.library.items.filter((x) => x.kind === 'note').length,
        trees: backup.library.items.filter((x) => x.kind === 'tree').length,
        drafts: backup.device.drafts.length,
        warning:
          'This replaces the shared notes on every device. Current local work is retained for recovery.',
      };
    });
  }
  confirmRestore(
    token: string,
    confirm: boolean,
  ): Promise<WorkspaceSnapshot | null> {
    const capturedEpoch = this.boundEpoch;
    return this.serial(async () => {
      if (!this.staged || token !== this.staged.token)
        throw new Error('The restore preview expired.');
      if (!confirm) {
        this.staged = null;
        return null;
      }
      await this.initialize();
      const staged = structuredClone(this.staged.backup),
        old = await this.db.transaction('r', this.tables(), () => this.read());
      if (old.epoch !== (capturedEpoch ?? this.requireEpoch()))
        throw replaced();
      await this.files.writeSafety(this.encode(old));
      const newEpoch = this.staged.epoch;
      const command: IntentCommand = {
        kind: 'replaceLibrary',
        previousEpoch: old.epoch,
        newEpoch,
        backup: staged,
      };
      const fingerprint = await digest({ epoch: newEpoch, command });
      const existing = await this.db.pending
        .where('fingerprint')
        .equals(fingerprint)
        .first();
      const expected: ExpectedOutcome = {
        items: [],
        purgedIds: [...staged.library.purgedIds],
        orders: orders(
          { items: staged.library.items, drafts: [], undoDeleteIds: [] },
          newEpoch,
        ).map((x) => ({
          group: { scope: x.scope, itemId: x.parentId },
          ids: x.ids,
        })),
      };
      const intent: PendingIntent = existing ?? {
        id: crypto.randomUUID(),
        epoch: newEpoch,
        fingerprint,
        command,
        expected,
        digest: await digest({ command, expected }),
        recordedAt: Date.now(),
        localApplied: false,
      };
      await this.db.transaction('rw', this.db.pending, async () => {
        const rows = await this.db.pending.toArray();
        if (
          (!existing && rows.length >= 1000) ||
          bytes([...rows.filter((x) => x.id !== intent.id), intent]) >
            MAX_ENVELOPE
        )
          throw new Error('Pending recovery capacity reached.');
        await this.db.pending.put(intent);
      });
      const result = await this.db.transaction(
        'rw',
        this.tables(),
        async () => {
          const fresh = await this.read();
          if (fresh.epoch !== old.epoch || !equal(fresh, old)) throw stale();
          const recovery = [...fresh.recovery];
          const used = new Map(
            recovery.map((record) => [record.id.toLowerCase(), record]),
          );
          for (const record of staged.device.recovery) {
            const existing = used.get(record.id.toLowerCase());
            if (existing && equal(existing, record)) continue;
            // Internal recovery IDs have no incoming references. A collision
            // keeps both payloads, assigning only the imported record a new ID.
            const imported = existing
              ? { ...record, id: crypto.randomUUID() }
              : record;
            recovery.push(imported);
            used.set(imported.id.toLowerCase(), imported);
          }
          if (
            fresh.snapshot.items.length ||
            fresh.snapshot.drafts.length ||
            (await this.db.pending.where('epoch').equals(fresh.epoch).count())
          )
            recovery.push({
              id: crypto.randomUUID(),
              kind: 'library',
              snapshot: fresh.snapshot,
              reason: 'replaced',
              originEpoch: fresh.epoch,
              recordedAt: Date.now(),
            });
          const state: State = {
            epoch: newEpoch,
            snapshot: {
              items: staged.library.items,
              drafts: staged.device.drafts,
              undoDeleteIds: staged.device.undoDeleteIds,
            },
            purgedIds: staged.library.purgedIds,
            recovery,
          };
          this.encode(state);
          await this.db.libraries.put({
            id: this.libraryId,
            epoch: state.epoch,
          });
          await this.persist(
            {
              epoch: state.epoch,
              snapshot: emptyWorkspace(),
              purgedIds: [],
              recovery: [],
            },
            state,
            intent.recordedAt,
          );
          await this.db.witnesses.put({
            id: intent.id,
            epoch: newEpoch,
            digest: intent.digest,
            recordedAt: intent.recordedAt,
          });
          await this.db.pending.update(intent.id, { localApplied: true });
          return state.snapshot;
        },
      );
      this.staged = null;
      this.boundEpoch = newEpoch;
      return result;
    });
  }
}
