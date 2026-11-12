import type { Item, WorkspaceSnapshot, Location, ColorToken } from './notes';
import type {
  DraftAck,
  CaptureItem,
  CreateChildStash,
  ReorderItem,
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
  location(s, at, kind === 'stash');
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
  location(s, r.location);
  if (!r.markdown.trim())
    throw new Error(
      'Enter non-whitespace text before saving. Your draft is retained.',
    );
  ack(s, r.draft, composeKey(r.location));
  creation(s, r.id, r.location, 'note', r.markdown);
}
export function createChildStash(s: WorkspaceSnapshot, r: CreateChildStash) {
  creation(s, r.id, r.parent, 'stash', 'Untitled');
}
export function promoteItem(s: WorkspaceSnapshot, id: string) {
  const x = find(s, id);
  if (x.kind === 'note') {
    x.kind = 'stash';
    touch(x);
  }
}
export function deleteItem(s: WorkspaceSnapshot, id: string) {
  const x = find(s, id);
  if (x.deletedAt !== null) return;
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
}
export function restoreItem(s: WorkspaceSnapshot, id: string) {
  const x = find(s, id);
  if (effectiveScope(s.items, id) === 'live') return;
  const old = directEntries(s, itemLocation(s.items, id));
  const parent =
    x.restoreParentId === null
      ? null
      : (s.items.find(
          (y) =>
            y.id === x.restoreParentId &&
            y.kind === 'stash' &&
            effectiveScope(s.items, y.id) === 'live',
        )?.id ?? null);
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
