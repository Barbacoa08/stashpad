import type { Item, Location, WorkspaceSnapshot } from './notes';
export const composeKey = (location: Location | string | null): string => {
  if (typeof location === 'object' && location !== null)
    return location.itemId === null
      ? location.scope === 'trash'
        ? 'compose:trash'
        : 'compose'
      : `compose:${location.itemId}`;
  return location === null ? 'compose' : `compose:${location}`;
};
export function composeOwner(key: string): { stashId: string | null } | null {
  if (key === 'compose' || key === 'compose:trash') return { stashId: null };
  if (key.startsWith('compose:')) return { stashId: key.slice(8) };
  return null;
}
/** Exact IDs and an iterative, linear walk reject dangling parents and cycles. */
export function hierarchyIndex(stashes: Item[]): Map<string, Item> {
  const byId = new Map(stashes.map((s) => [s.id, s]));
  if (byId.size !== stashes.length) throw new Error('Duplicate stash.');
  const done = new Set<string>();
  for (const stash of stashes) {
    let id: string | null = stash.id;
    const pending = new Set<string>();
    while (id !== null && !done.has(id)) {
      if (pending.has(id)) throw new Error('Stash cycle.');
      const current = byId.get(id);
      if (!current) throw new Error('Missing parent stash.');
      pending.add(id);
      if (
        current.parentId !== null &&
        byId.get(current.parentId)?.kind !== 'stash'
      )
        throw new Error('Invalid parent item.');
      id = current.parentId;
    }
    for (const key of pending) done.add(key);
  }
  return byId;
}
export function stashPath(stashes: Item[], id: string | null): Item[] {
  const byId = hierarchyIndex(stashes),
    path: Item[] = [];
  while (id !== null) {
    const stash = byId.get(id);
    if (!stash) throw new Error('Missing stash.');
    path.push(stash);
    id = stash.parentId;
  }
  return path.reverse();
}
/** Convenience for isolated calls; views reuse one presentation per stash snapshot. */
export const locationLabel = (stashes: Item[], id: string | null): string =>
  createHierarchyPresentation(stashes).label(id).text;
export type StreamEntry = Item;
export function itemLabel(item: Item): string {
  const line = item.markdown.split(/\r\n|\r|\n/, 1)[0].trim();
  const points = Array.from(line || 'Untitled');
  return points.length > 32
    ? points.slice(0, 31).join('') + '…'
    : points.join('');
}
export function scopeIndex(items: Item[]): Map<string, 'live' | 'trash'> {
  const index = hierarchyIndex(items),
    scopes = new Map<string, 'live' | 'trash'>();
  for (const item of items) {
    let x: Item | undefined = item;
    const pending: Item[] = [];
    while (x && !scopes.has(x.id)) {
      pending.push(x);
      if (x.deletedAt !== null) {
        scopes.set(x.id, 'trash');
        break;
      }
      x = x.parentId === null ? undefined : index.get(x.parentId);
    }
    const scope = x ? scopes.get(x.id)! : 'live';
    for (const node of pending) scopes.set(node.id, scope);
  }
  return scopes;
}
export function effectiveScope(items: Item[], id: string): 'live' | 'trash' {
  const scope = scopeIndex(items).get(id);
  if (!scope) throw new Error('Missing item.');
  return scope;
}
export function itemLocation(items: Item[], id: string): Location {
  const item = items.find((x) => x.id === id);
  if (!item) throw new Error('Missing item.');
  return { scope: effectiveScope(items, id), itemId: item.parentId };
}
export function directEntries(
  s: WorkspaceSnapshot,
  location: Location | string | null,
): Item[] {
  const at =
    typeof location === 'object' && location !== null
      ? location
      : { scope: 'live', itemId: location };
  return s.items
    .filter(
      (x) =>
        x.parentId === at.itemId &&
        (at.itemId !== null ||
          (x.deletedAt !== null ? 'trash' : 'live') === at.scope),
    )
    .sort(
      (a, b) =>
        a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
}
export interface StashRow {
  stash: Item;
  depth: number;
  hasChildren: boolean;
}
function stashChildren(stashes: Item[]): Map<string | null, Item[]> {
  const children = new Map<string | null, Item[]>();
  for (const stash of stashes) {
    const list = children.get(stash.parentId) ?? [];
    list.push(stash);
    children.set(stash.parentId, list);
  }
  for (const list of children.values())
    list.sort(
      (a, b) =>
        a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  return children;
}
function visibleRows(
  children: Map<string | null, Item[]>,
  expanded: Set<string>,
): StashRow[] {
  const pending = (children.get(null) ?? [])
      .map((stash) => ({ stash, depth: 0 }))
      .reverse(),
    rows: StashRow[] = [];
  while (pending.length) {
    const row = pending.pop()!;
    rows.push({ ...row, hasChildren: children.has(row.stash.id) });
    if (expanded.has(row.stash.id))
      for (const stash of [...(children.get(row.stash.id) ?? [])].reverse())
        pending.push({ stash, depth: row.depth + 1 });
  }
  return rows;
}
export function sidebarRows(
  stashes: Item[],
  expanded: Set<string>,
): StashRow[] {
  hierarchyIndex(stashes);
  return visibleRows(stashChildren(stashes), expanded);
}
export interface LocationLabel {
  text: string;
  abbreviated: boolean;
  depth: number;
}
export interface HierarchyPresentation {
  readonly index: ReadonlyMap<string, Item>;
  path(id: string | null): Item[];
  label(id: string | null): LocationLabel;
  rows(expanded: Set<string>): StashRow[];
}
/** Index once; cache only bounded labels, never every ancestor prefix/path string. */
export function createHierarchyPresentation(
  stashes: Item[],
  rootLabel = 'Home',
): HierarchyPresentation {
  const index = hierarchyIndex(stashes),
    children = stashChildren(stashes),
    depths = new Map<string, number>();
  for (const stash of stashes) {
    const pending: Item[] = [];
    let current: Item | undefined = stash;
    while (current && !depths.has(current.id)) {
      pending.push(current);
      current =
        current.parentId === null ? undefined : index.get(current.parentId);
    }
    let depth = current ? depths.get(current.id)! : 0;
    for (let i = pending.length - 1; i >= 0; i--)
      depths.set(pending[i].id, ++depth);
  }
  const labels = new Map<string | null, LocationLabel>([
    [null, { text: rootLabel, abbreviated: false, depth: 0 }],
  ]);
  function lookup(id: string): Item {
    const stash = index.get(id);
    if (!stash) throw new Error('Missing stash.');
    return stash;
  }
  return {
    index,
    path(id) {
      const result: Item[] = [];
      while (id !== null) {
        const stash = lookup(id);
        result.push(stash);
        id = stash.parentId;
      }
      return result.reverse();
    },
    label(id) {
      const saved = labels.get(id);
      if (saved) return saved;
      const stash = lookup(id!),
        depth = depths.get(stash.id)!;
      let abbreviated = depth > 2;
      const tail =
        stash.parentId === null ? [stash] : [lookup(stash.parentId), stash];
      const names = tail.map((item) => {
        const name = itemLabel(item),
          points = Array.from(name);
        if (points.length <= 32) return name;
        abbreviated = true;
        return points.slice(0, 31).join('') + '…';
      });
      const label = {
        text: [rootLabel, ...(depth > 2 ? ['…'] : []), ...names].join(' / '),
        abbreviated,
        depth,
      };
      labels.set(id, label);
      return label;
    },
    rows(expanded) {
      return visibleRows(children, expanded);
    },
  };
}
/** One pass avoids rescanning the workspace for each visible stash card. */
export function entryCounts(s: WorkspaceSnapshot): Map<string | null, number> {
  const counts = new Map<string | null, number>();
  const scopes = scopeIndex(s.items);
  for (const item of s.items)
    if (scopes.get(item.id) === 'live')
      counts.set(item.parentId, (counts.get(item.parentId) ?? 0) + 1);
  return counts;
}
