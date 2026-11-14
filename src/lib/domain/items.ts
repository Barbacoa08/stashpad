import type { Item, WorkspaceSnapshot, Location, ColorToken } from './notes';
import type {
  DraftAck,
  CaptureItem,
  CreateChildTree,
  ReorderItem,
  PurgeItem,
  TransitionLocation,
  MoveItems,
  UndoDeleteRequest,
  StructuralItem,
  StructuralProof,
} from '../platform/workspace';
import {
  composeKey,
  directEntries,
  effectiveScope,
  itemLocation,
} from './hierarchy';
import { uuid, validateSnapshot } from './validation';
const touch = (x: Item) =>
  (x.updatedAt = Math.max(Date.now(), x.updatedAt + 1));
function find(s: WorkspaceSnapshot, id: string): Item {
  const x = s.items.find((x) => x.id === id);
  if (!x) throw new Error('This note is unavailable. Your input is retained.');
  return x;
}
function location(s: WorkspaceSnapshot, at: Location, allowNote = false) {
  if (!at || !['live', 'trash'].includes(at.scope))
    throw new Error('Invalid location.');
  if (at.itemId !== null) {
    const x = find(s, at.itemId);
    if (
      (!allowNote && x.kind !== 'tree') ||
      effectiveScope(s.items, x.id) !== at.scope
    )
      throw new Error('Invalid location.');
  }
}
function ack(s: WorkspaceSnapshot, draft: DraftAck, key: string) {
  if (
    draft.key !== key ||
    !Number.isSafeInteger(draft.revision) ||
    draft.revision < 0
  )
    throw new Error('Invalid draft acknowledgment.');
  s.drafts = s.drafts.filter(
    (x) => x.key !== key || x.revision > draft.revision,
  );
}
function normalize(group: Item[]) {
  group.forEach((x, i) => (x.position = i));
}
export function saveItemSource(
  s: WorkspaceSnapshot,
  id: string,
  markdown: string,
  draft: DraftAck,
) {
  const x = find(s, id);
  ack(s, draft, id);
  if (x.markdown !== markdown) {
    x.markdown = markdown;
    touch(x);
  }
}
function creation(
  s: WorkspaceSnapshot,
  id: string,
  at: Location,
  kind: Item['kind'],
  markdown: string,
): boolean {
  if (!uuid(id)) throw new Error('Invalid creation identity.');
  location(s, at, true);
  const prior = s.items.find((x) => x.id.toLowerCase() === id.toLowerCase());
  if (prior) {
    if (
      prior.id !== id ||
      prior.parentId !== at.itemId ||
      prior.kind !== kind ||
      prior.markdown !== markdown ||
      prior.done ||
      prior.color !== null ||
      effectiveScope(s.items, id) !== at.scope
    )
      throw new Error(
        'Creation identity conflict. Prior content was retained.',
      );
    return false;
  }
  const time = Date.now();
  const group = directEntries(s, at);
  normalize(group);
  if (at.itemId !== null) {
    const parent = find(s, at.itemId);
    if (parent.kind === 'note') {
      parent.kind = 'tree';
      touch(parent);
    }
  }
  s.items.push({
    id,
    parentId: at.itemId,
    kind,
    markdown,
    done: false,
    color: null,
    position: group.length,
    createdAt: time,
    updatedAt: time,
    deletedAt: at.scope === 'trash' && at.itemId === null ? time : null,
    restoreParentId: null,
    restoreIndex: null,
  });
  return true;
}
export function captureItem(s: WorkspaceSnapshot, r: CaptureItem) {
  location(s, r.location, true);
  if (!r.markdown.trim())
    throw new Error(
      'Enter non-whitespace text before saving. Your draft is retained.',
    );
  ack(s, r.draft, composeKey(r.location));
  creation(s, r.id, r.location, 'note', r.markdown);
}
export function createChildTree(s: WorkspaceSnapshot, r: CreateChildTree) {
  creation(s, r.id, r.parent, 'tree', 'Untitled');
  if (r.leave)
    transitionLocation(s, {
      from: r.leave,
      to: { scope: r.parent.scope, itemId: r.id },
      promoteDestination: false,
    });
}
export function promoteItem(s: WorkspaceSnapshot, id: string) {
  const x = find(s, id);
  if (x.kind === 'note') {
    x.kind = 'tree';
    touch(x);
  }
}
export function deleteItem(s: WorkspaceSnapshot, id: string, leave?: Location) {
  const x = find(s, id);
  if (x.deletedAt !== null) return;
  if (leave) {
    location(s, leave, true);
    if (leave.itemId === null || !subtreeIds(s, id).includes(leave.itemId))
      throw stale();
  }
  const old = directEntries(s, itemLocation(s.items, id));
  const ordinal = old.findIndex((x) => x.id === id);
  x.restoreParentId = x.parentId;
  x.restoreIndex = ordinal;
  x.parentId = null;
  x.deletedAt = Math.max(Date.now(), x.updatedAt + 1);
  const trash = directEntries(s, { scope: 'trash', itemId: null }).filter(
    (y) => y.id !== id,
  );
  normalize(trash);
  x.position = trash.length;
  touch(x);
  normalize(old.filter((y) => y.id !== id));
  s.undoDeleteIds = [id];
  if (leave?.itemId && !s.items.some((x) => x.parentId === leave.itemId))
    find(s, leave.itemId).kind = 'note';
}
export function restoreItem(s: WorkspaceSnapshot, id: string) {
  if (effectiveScope(s.items, id) === 'live') return;
  restoreGroup(s, [id]);
}
export function setItemDone(s: WorkspaceSnapshot, id: string, done: boolean) {
  if (typeof done !== 'boolean') throw new Error('Invalid completion state.');
  const x = find(s, id);
  if (x.done !== done) {
    x.done = done;
    touch(x);
  }
}
export function setItemColor(
  s: WorkspaceSnapshot,
  id: string,
  color: ColorToken | null,
) {
  const x = find(s, id);
  if (x.color !== color) {
    x.color = color;
    touch(x);
  }
}
export function reorderItem(s: WorkspaceSnapshot, r: ReorderItem) {
  location(s, r.group);
  const x = find(s, r.id),
    actual = itemLocation(s.items, r.id);
  if (actual.scope !== r.group.scope || actual.itemId !== r.group.itemId)
    throw new Error('Notes can be reordered only within the same location.');
  const group = directEntries(s, r.group);
  if (
    !Number.isSafeInteger(r.toIndex) ||
    r.toIndex < 0 ||
    r.toIndex >= group.length
  )
    throw new Error('Invalid sibling index.');
  const index = group.findIndex((y) => y.id === r.id);
  if (index === r.toIndex) return;
  group.splice(index, 1);
  group.splice(r.toIndex, 0, x);
  normalize(group);
  touch(x);
}

const sameLocation = (a: Location, b: Location) =>
  a.scope === b.scope && a.itemId === b.itemId;
const sameIds = (a: string[], b: string[]) =>
  a.length === b.length && a.every((id, i) => id === b[i]);
const stale = () =>
  new Error(
    'The captured notes or destination changed. Review the action again; your content is retained.',
  );
function uniqueIds(ids: string[]) {
  if (
    !Array.isArray(ids) ||
    ids.some((id) => !uuid(id)) ||
    new Set(ids).size !== ids.length
  )
    throw stale();
  return new Set(ids);
}
/** Parent edges only; remembered restore links never imply ownership. */
export function subtreeIds(s: WorkspaceSnapshot, id: string): string[] {
  const children = new Map<string, string[]>();
  for (const x of s.items)
    if (x.parentId !== null) {
      const list = children.get(x.parentId) ?? [];
      list.push(x.id);
      children.set(x.parentId, list);
    }
  const result = new Set<string>(),
    pending = [id];
  while (pending.length) {
    const key = pending.pop()!;
    if (result.has(key)) continue;
    result.add(key);
    pending.push(...(children.get(key) ?? []));
  }
  return [...result].sort();
}
export function purgeItem(s: WorkspaceSnapshot, r: PurgeItem): string[] {
  const expected = uniqueIds(r.expectedSubtreeIds);
  if (!expected.has(r.id)) throw stale();
  const target = s.items.find((x) => x.id === r.id);
  if (!target) {
    const folded = new Set([...expected].map((id) => id.toLowerCase()));
    if (s.items.some((x) => folded.has(x.id.toLowerCase()))) throw stale();
    return [...expected].sort();
  }
  if (
    effectiveScope(s.items, r.id) !== 'trash' ||
    !sameLocation(itemLocation(s.items, r.id), r.location)
  )
    throw stale();
  const removed = subtreeIds(s, r.id);
  if (!sameIds(removed, [...expected].sort())) throw stale();
  const old = directEntries(s, r.location);
  s.items = s.items.filter((x) => !expected.has(x.id));
  for (const x of s.items)
    if (x.restoreParentId !== null && expected.has(x.restoreParentId))
      x.restoreParentId = null;
  s.drafts = s.drafts.filter(
    (d) =>
      !expected.has(d.key) &&
      !(d.key.startsWith('compose:') && expected.has(d.key.slice(8))),
  );
  s.undoDeleteIds = s.undoDeleteIds.filter((id) => !expected.has(id));
  normalize(old.filter((x) => !expected.has(x.id)));
  return removed;
}
export function transitionLocation(
  s: WorkspaceSnapshot,
  r: TransitionLocation,
) {
  location(s, r.from, true);
  location(s, r.to, r.promoteDestination);
  if (r.promoteDestination && r.to.itemId !== null) promoteItem(s, r.to.itemId);
  if (sameLocation(r.from, r.to)) return;
  if (
    r.from.itemId !== null &&
    !s.items.some((x) => x.parentId === r.from.itemId)
  )
    find(s, r.from.itemId).kind = 'note';
}
function deletionDates(s: WorkspaceSnapshot): Map<string, number | null> {
  const index = new Map(s.items.map((x) => [x.id, x])),
    dates = new Map<string, number | null>();
  for (const x of s.items) {
    let current: Item | undefined = x;
    const pending: string[] = [];
    while (current && !dates.has(current.id)) {
      pending.push(current.id);
      if (current.deletedAt !== null) {
        dates.set(current.id, current.deletedAt);
        break;
      }
      current =
        current.parentId === null ? undefined : index.get(current.parentId);
    }
    const date = current ? (dates.get(current.id) ?? null) : null;
    for (const id of pending) dates.set(id, date);
  }
  return dates;
}
function applyMove(s: WorkspaceSnapshot, r: MoveItems) {
  location(s, r.from);
  location(s, r.to);
  if (!r.ids.length) throw stale();
  const selected = uniqueIds(r.ids);
  for (const ids of [r.beforeFrom, r.beforeTo, r.afterFrom, r.afterTo])
    uniqueIds(ids);
  const without = (ids: string[]) => ids.filter((id) => !selected.has(id));
  const only = (ids: string[]) => ids.filter((id) => selected.has(id));
  if (!sameIds(only(r.beforeFrom), r.ids)) throw stale();
  if (sameLocation(r.from, r.to)) {
    if (
      !sameIds(r.beforeFrom, r.beforeTo) ||
      !sameIds(r.afterFrom, r.afterTo) ||
      r.beforeFrom.length !== r.afterFrom.length ||
      !sameIds(without(r.beforeFrom), without(r.afterFrom)) ||
      !sameIds(only(r.afterFrom), r.ids)
    )
      throw stale();
  } else {
    const start = r.afterTo.indexOf(r.ids[0]);
    if (
      r.beforeTo.some((id) => selected.has(id)) ||
      !sameIds(r.afterFrom, without(r.beforeFrom)) ||
      !sameIds(without(r.afterTo), r.beforeTo) ||
      r.afterTo.length !== r.beforeTo.length + r.ids.length ||
      start < 0 ||
      !sameIds(r.afterTo.slice(start, start + r.ids.length), r.ids)
    )
      throw stale();
  }
  // Walk one destination ancestry instead of rebuilding a subtree for each selected root.
  const index = new Map(s.items.map((x) => [x.id, x]));
  let parent = r.to.itemId;
  while (parent !== null) {
    if (selected.has(parent)) throw stale();
    parent = index.get(parent)?.parentId ?? null;
  }
  const from = directEntries(s, r.from).map((x) => x.id),
    to = directEntries(s, r.to).map((x) => x.id);
  if (sameIds(from, r.afterFrom) && sameIds(to, r.afterTo)) return;
  if (!sameIds(from, r.beforeFrom) || !sameIds(to, r.beforeTo)) throw stale();
  if (r.from.scope === 'trash' && r.to.scope === 'live') {
    detachGroupDeletedDescendants(s, r.ids);
    s.undoDeleteIds = s.undoDeleteIds.filter((id) => !selected.has(id));
  }
  const dates = deletionDates(s);
  const destinationDate =
    r.to.itemId === null ? null : (dates.get(r.to.itemId) ?? null);
  const oldPositions = new Map(r.beforeFrom.map((id, i) => [id, i])),
    newPositions = new Map(r.afterTo.map((id, i) => [id, i]));
  for (const id of r.ids) {
    const oldIndex = oldPositions.get(id)!,
      newIndex = newPositions.get(id)!;
    if (sameLocation(r.from, r.to) && oldIndex === newIndex) continue;
    const x = index.get(id)!,
      date = dates.get(id) ?? null;
    if (r.from.scope === 'live' && r.to.scope === 'trash') {
      if (!Number.isSafeInteger(r.deletedAt) || r.deletedAt! < 0) throw stale();
      x.deletedAt = r.deletedAt!;
      x.restoreParentId = x.parentId;
      x.restoreIndex = oldIndex;
    } else if (r.from.scope === 'trash' && r.to.scope === 'live') {
      x.deletedAt = null;
      x.restoreParentId = null;
      x.restoreIndex = null;
    }
    if (
      r.to.scope === 'trash' &&
      r.from.scope === 'trash' &&
      x.deletedAt === null &&
      (r.to.itemId === null || date !== destinationDate)
    ) {
      x.deletedAt = date;
      x.restoreParentId = x.parentId;
      x.restoreIndex = oldIndex;
    }
    x.parentId = r.to.itemId;
    touch(x);
    if (r.from.scope === 'live' && r.to.scope === 'trash')
      x.updatedAt = Math.max(x.updatedAt, r.deletedAt!);
  }
  if (r.from.scope === 'live' && r.to.scope === 'trash')
    s.undoDeleteIds = [...r.ids];
  normalize(r.afterFrom.map((id) => index.get(id)!));
  normalize(r.afterTo.map((id) => index.get(id)!));
  if (r.from.scope === 'trash' && r.to.scope === 'live')
    normalize(directEntries(s, { scope: 'trash', itemId: null }));
}
/** One children index and one normalization per affected group for the whole action. */
function detachGroupDeletedDescendants(
  s: WorkspaceSnapshot,
  ids: string[],
  historicalSingle = false,
) {
  const children = new Map<string, Item[]>();
  for (const x of s.items)
    if (x.parentId !== null) {
      const group = children.get(x.parentId) ?? [];
      group.push(x);
      children.set(x.parentId, group);
    }
  // Native reads are exact-ID ordered. Keep singleton traversal identical when
  // capture, proof derivation, or application receives another valid array order.
  for (const group of children.values())
    group.sort(
      historicalSingle
        ? (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
        : (a, b) => a.position - b.position,
    );
  const roots = directEntries(s, { scope: 'trash', itemId: null });
  const detached = new Set<string>(),
    affected = new Set<string>(),
    seen = new Set<string>();
  for (const id of ids) {
    const pending = [...(children.get(id) ?? [])];
    if (!historicalSingle) pending.reverse();
    while (pending.length) {
      const x = pending.pop()!;
      if (seen.has(x.id)) continue;
      seen.add(x.id);
      if (x.deletedAt !== null) {
        affected.add(x.parentId!);
        detached.add(x.id);
        x.parentId = null;
        roots.push(x);
      } else {
        const next = [...(children.get(x.id) ?? [])];
        if (!historicalSingle) next.reverse();
        pending.push(...next);
      }
    }
  }
  for (const parent of affected)
    normalize(
      children
        .get(parent)!
        .filter((x) => !detached.has(x.id))
        .sort((a, b) => a.position - b.position),
    );
  normalize(roots);
}
function restoreGroup(s: WorkspaceSnapshot, ids: string[]) {
  const index = new Map(s.items.map((x) => [x.id, x]));
  detachGroupDeletedDescendants(s, ids, ids.length === 1);
  const groups = new Map<string, Item[]>();
  const key = (x: Item) =>
    x.parentId ?? (x.deletedAt === null ? 'live' : 'trash');
  for (const x of s.items) {
    const group = groups.get(key(x)) ?? [];
    group.push(x);
    groups.set(key(x), group);
  }
  for (const group of groups.values())
    group.sort((a, b) => a.position - b.position);
  const live = (id: string): boolean => {
    let x = index.get(id);
    while (x) {
      if (x.deletedAt !== null) return false;
      x = x.parentId === null ? undefined : index.get(x.parentId);
    }
    return index.has(id);
  };
  const affected = new Set<string>();
  for (const id of ids) {
    const x = index.get(id);
    if (!x || live(id)) throw stale();
    const oldKey = key(x),
      old = groups.get(oldKey)!;
    old.splice(
      old.findIndex((y) => y.id === id),
      1,
    );
    affected.add(oldKey);
    const parent =
      x.restoreParentId !== null && live(x.restoreParentId)
        ? x.restoreParentId
        : null;
    if (parent !== null && index.get(parent)!.kind === 'note') {
      index.get(parent)!.kind = 'tree';
      touch(index.get(parent)!);
    }
    const newKey = parent ?? 'live',
      group = groups.get(newKey) ?? [];
    group.splice(Math.min(x.restoreIndex ?? group.length, group.length), 0, x);
    groups.set(newKey, group);
    affected.add(newKey);
    x.parentId = parent;
    x.deletedAt = null;
    x.restoreParentId = null;
    x.restoreIndex = null;
    touch(x);
  }
  for (const key of affected) normalize(groups.get(key)!);
  const restored = new Set(ids);
  s.undoDeleteIds = s.undoDeleteIds.filter((id) => !restored.has(id));
}
export function structuralItems(s: WorkspaceSnapshot): StructuralItem[] {
  return s.items
    .map(
      ({
        id,
        parentId,
        kind,
        position,
        deletedAt,
        restoreParentId,
        restoreIndex,
      }) => ({
        id,
        parentId,
        kind,
        position,
        deletedAt,
        restoreParentId,
        restoreIndex,
      }),
    )
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
function fromStructure(
  before: StructuralItem[],
  ids: string[],
): WorkspaceSnapshot {
  if (!Array.isArray(before) || before.length > 20000) throw stale();
  const s: WorkspaceSnapshot = {
    items: before.map((x) => ({
      ...x,
      markdown: '',
      done: false,
      color: null,
      createdAt: 0,
      updatedAt: 0,
    })),
    drafts: [],
    undoDeleteIds: [...ids],
  };
  if (!equal(structuralItems(s), before) || 'code' in validateSnapshot(s))
    throw stale();
  return s;
}
function proofFor(
  s: WorkspaceSnapshot,
  apply: (s: WorkspaceSnapshot) => void,
): StructuralProof {
  const before = structuralItems(s),
    after = structuredClone(s);
  apply(after);
  if ('code' in validateSnapshot(after)) throw stale();
  return { before, after: structuralItems(after) };
}
export function captureMoveProof(
  s: WorkspaceSnapshot,
  r: MoveItems,
): MoveItems {
  const index = new Map(s.items.map((x) => [x.id, x]));
  const request = {
    ...r,
    ...(r.from.scope === 'live' && r.to.scope === 'trash'
      ? {
          deletedAt: r.ids.reduce(
            (time, id) => Math.max(time, index.get(id)!.updatedAt + 1),
            Date.now(),
          ),
        }
      : {}),
  };
  return { ...request, proof: proofFor(s, (x) => applyMove(x, request)) };
}
export function captureUndoDelete(s: WorkspaceSnapshot): UndoDeleteRequest {
  const ids = [...s.undoDeleteIds];
  if (!ids.length) throw stale();
  return { ids, proof: proofFor(s, (x) => restoreGroup(x, ids)) };
}
/** State based replay: affected groups are exact; only unrelated appended Trash roots may coexist. */
function replayMatches(
  s: WorkspaceSnapshot,
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
  ids: string[],
): boolean {
  const old = new Map(structuralItems(before).map((x) => [x.id, x]));
  const expected = new Map(structuralItems(after).map((x) => [x.id, x]));
  const actual = new Map(structuralItems(s).map((x) => [x.id, x]));
  const groupKey = (x: StructuralItem) =>
    JSON.stringify([x.parentId, x.parentId === null && x.deletedAt !== null]);
  const groups = new Set<string>(),
    roots = new Set(ids);
  for (const [id, x] of expected)
    if (!equal(x, old.get(id))) {
      groups.add(groupKey(x));
      groups.add(groupKey(old.get(id)!));
      if (x.parentId !== old.get(id)!.parentId) roots.add(id);
    }
  for (const [id, x] of expected)
    if (groups.has(groupKey(x)) || roots.has(id)) {
      if (!equal(x, actual.get(id))) return false;
    }
  const orderedGroups = (records: Map<string, StructuralItem>) => {
    const result = new Map<string, StructuralItem[]>();
    for (const x of records.values()) {
      const key = groupKey(x),
        group = result.get(key) ?? [];
      group.push(x);
      result.set(key, group);
    }
    return new Map(
      [...result].map(([key, group]) => [
        key,
        group.sort((a, b) => a.position - b.position).map((x) => x.id),
      ]),
    );
  };
  const expectedGroups = orderedGroups(expected),
    actualGroups = orderedGroups(actual);
  for (const group of groups) {
    const wanted = expectedGroups.get(group) ?? [];
    const found = actualGroups.get(group) ?? [];
    const appendTrash = group === JSON.stringify([null, true]);
    if (
      appendTrash
        ? !sameIds(found.slice(0, wanted.length), wanted)
        : !sameIds(found, wanted)
    )
      return false;
  }
  // One traversal per workspace computes selected-subtree membership, including unchanged descendants.
  const subtreeSets = (workspace: WorkspaceSnapshot) => {
    const children = new Map<string, string[]>();
    for (const x of workspace.items)
      if (x.parentId !== null) {
        const list = children.get(x.parentId) ?? [];
        list.push(x.id);
        children.set(x.parentId, list);
      }
    const result = new Set<string>(),
      pending = [...roots];
    while (pending.length) {
      const id = pending.pop()!;
      if (result.has(id)) continue;
      result.add(id);
      pending.push(...(children.get(id) ?? []));
    }
    return [...result].sort();
  };
  const wanted = subtreeSets(after),
    found = subtreeSets(s);
  return (
    sameIds(wanted, found) &&
    wanted.every((id) => equal(expected.get(id), actual.get(id)))
  );
}
function structuralAction(
  s: WorkspaceSnapshot,
  ids: string[],
  proof: StructuralProof,
  undo: boolean,
  apply: (s: WorkspaceSnapshot) => void,
) {
  uniqueIds(ids);
  if (!ids.length || !proof || !Array.isArray(proof.after)) throw stale();
  const before = fromStructure(proof.before, undo ? ids : []),
    derived = structuredClone(before);
  apply(derived);
  if (!equal(structuralItems(derived), proof.after)) throw stale();
  if (
    equal(structuralItems(s), proof.before) &&
    (!undo || sameIds(s.undoDeleteIds, ids))
  ) {
    apply(s);
    return;
  }
  if (!replayMatches(s, before, derived, ids)) throw stale();
}
export function moveItems(s: WorkspaceSnapshot, r: MoveItems) {
  if (r.proof)
    structuralAction(s, r.ids, r.proof, false, (x) => applyMove(x, r));
  else {
    if (r.from.scope !== r.to.scope) throw stale();
    applyMove(s, r);
  }
}
export function undoDelete(s: WorkspaceSnapshot, r: UndoDeleteRequest) {
  structuralAction(s, r.ids, r.proof, true, (x) => restoreGroup(x, r.ids));
}
