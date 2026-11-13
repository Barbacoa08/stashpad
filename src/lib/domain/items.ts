import type { Item, WorkspaceSnapshot, Location, ColorToken } from './notes';
import type {
  DraftAck,
  CaptureItem,
  CreateChildStash,
  ReorderItem,
  PurgeItem,
  TransitionLocation,
  MoveItems,
} from '../platform/workspace';
import {
  composeKey,
  directEntries,
  effectiveScope,
  itemLocation,
} from './hierarchy';
import { uuid } from './backup';
const touch = (x: Item) =>
  (x.updatedAt = Math.max(Date.now(), x.updatedAt + 1));
function find(s: WorkspaceSnapshot, id: string): Item {
  const x = s.items.find((x) => x.id === id);
  if (!x) throw new Error('This item is unavailable. Your input is retained.');
  return x;
}
function location(s: WorkspaceSnapshot, at: Location, allowNote = false) {
  if (!at || !['live', 'trash'].includes(at.scope))
    throw new Error('Invalid location.');
  if (at.itemId !== null) {
    const x = find(s, at.itemId);
    if (
      (!allowNote && x.kind !== 'stash') ||
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
      parent.kind = 'stash';
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
export function createChildStash(s: WorkspaceSnapshot, r: CreateChildStash) {
  creation(s, r.id, r.parent, 'stash', 'Untitled');
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
    x.kind = 'stash';
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
  x.deletedAt = Date.now();
  const trash = directEntries(s, { scope: 'trash', itemId: null }).filter(
    (y) => y.id !== id,
  );
  normalize(trash);
  x.position = trash.length;
  touch(x);
  normalize(old.filter((y) => y.id !== id));
  s.undoDeleteId = id;
  if (leave?.itemId && !s.items.some((x) => x.parentId === leave.itemId))
    find(s, leave.itemId).kind = 'note';
}
export function restoreItem(s: WorkspaceSnapshot, id: string) {
  const x = find(s, id);
  if (effectiveScope(s.items, id) === 'live') return;
  const oldLocation = itemLocation(s.items, id);
  const parent =
    x.restoreParentId === null
      ? null
      : (s.items.find(
          (y) =>
            y.id === x.restoreParentId &&
            effectiveScope(s.items, y.id) === 'live',
        )?.id ?? null);
  const roots = detachDeletedDescendants(s, id);
  const old =
    oldLocation.itemId === null ? roots : directEntries(s, oldLocation);
  if (oldLocation.itemId !== null) normalize(roots);
  if (parent !== null) promoteItem(s, parent);
  const group = directEntries(s, { scope: 'live', itemId: parent });
  const index = Math.min(x.restoreIndex ?? group.length, group.length);
  x.parentId = parent;
  x.deletedAt = null;
  x.restoreParentId = null;
  x.restoreIndex = null;
  group.splice(index, 0, x);
  normalize(old.filter((y) => y.id !== id));
  normalize(group);
  touch(x);
  if (s.undoDeleteId === id) s.undoDeleteId = null;
}
export function undoDelete(s: WorkspaceSnapshot) {
  if (s.undoDeleteId !== null) restoreItem(s, s.undoDeleteId);
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
    throw new Error('Items can be reordered only within the same location.');
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
    'The captured items or destination changed. Review the action again; your content is retained.',
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
  if (s.undoDeleteId !== null && expected.has(s.undoDeleteId))
    s.undoDeleteId = null;
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
export function moveItems(s: WorkspaceSnapshot, r: MoveItems) {
  location(s, r.from);
  location(s, r.to);
  if (r.from.scope !== r.to.scope || !r.ids.length) throw stale();
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
    if (
      r.to.scope === 'trash' &&
      x.deletedAt === null &&
      (r.to.itemId === null || date !== destinationDate)
    ) {
      x.deletedAt = date;
      x.restoreParentId = x.parentId;
      x.restoreIndex = oldIndex;
    }
    x.parentId = r.to.itemId;
    touch(x);
  }
  normalize(r.afterFrom.map((id) => index.get(id)!));
  normalize(r.afterTo.map((id) => index.get(id)!));
}
/** Restoring an ancestor does not restore independently deleted nested records. */
function detachDeletedDescendants(s: WorkspaceSnapshot, id: string): Item[] {
  const children = new Map<string, Item[]>();
  for (const x of s.items)
    if (x.parentId !== null) {
      const list = children.get(x.parentId) ?? [];
      list.push(x);
      children.set(x.parentId, list);
    }
  const pending = [...(children.get(id) ?? [])],
    roots = directEntries(s, { scope: 'trash', itemId: null }),
    detached = new Set<string>(),
    affected = new Set<string>();
  while (pending.length) {
    const x = pending.pop()!;
    if (x.deletedAt !== null) {
      affected.add(x.parentId!);
      detached.add(x.id);
      x.parentId = null;
      roots.push(x);
    } else pending.push(...(children.get(x.id) ?? []));
  }
  // Stop at each nearest explicit deletion root. Its descendants keep their own
  // parent edges and deletion facts; each original sibling group is ranked once.
  for (const parent of affected)
    normalize(
      children
        .get(parent)!
        .filter((x) => !detached.has(x.id))
        .sort((a, b) => a.position - b.position),
    );
  // The caller removes the restored root and normalizes the final Trash group once.
  return roots;
}
