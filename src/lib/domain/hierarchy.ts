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
export function composeOwner(key: string): { ownerId: string | null } | null {
  if (key === 'compose' || key === 'compose:trash') return { ownerId: null };
  if (key.startsWith('compose:')) return { ownerId: key.slice(8) };
  return null;
}
/** Exact IDs and an iterative, linear walk reject dangling parents and cycles. */
export function hierarchyIndex(items: Item[]): Map<string, Item> {
  const byId = new Map(items.map((s) => [s.id, s]));
  if (byId.size !== items.length) throw new Error('Duplicate note.');
  const done = new Set<string>();
  for (const item of items) {
    let id: string | null = item.id;
    const pending = new Set<string>();
    while (id !== null && !done.has(id)) {
      if (pending.has(id)) throw new Error('Note cycle.');
      const current = byId.get(id);
      if (!current) throw new Error('Missing parent note.');
      pending.add(id);
      if (
        current.parentId !== null &&
        byId.get(current.parentId)?.kind !== 'tree'
      )
        throw new Error('Invalid parent note.');
      id = current.parentId;
    }
    for (const key of pending) done.add(key);
  }
  return byId;
}
export function treePath(trees: Item[], id: string | null): Item[] {
  const byId = hierarchyIndex(trees),
    path: Item[] = [];
  while (id !== null) {
    const tree = byId.get(id);
    if (!tree) throw new Error('Missing tree.');
    path.push(tree);
    id = tree.parentId;
  }
  return path.reverse();
}
/** Convenience for isolated calls; views reuse one presentation per tree snapshot. */
export const locationLabel = (trees: Item[], id: string | null): string =>
  createHierarchyPresentation(trees).label(id).text;
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
  if (!scope) throw new Error('Missing note.');
  return scope;
}
export function itemLocation(items: Item[], id: string): Location {
  const item = items.find((x) => x.id === id);
  if (!item) throw new Error('Missing note.');
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
export interface TreeRow {
  tree: Item;
  depth: number;
  hasChildren: boolean;
}
function treeChildren(trees: Item[]): Map<string | null, Item[]> {
  const children = new Map<string | null, Item[]>();
  for (const tree of trees) {
    const list = children.get(tree.parentId) ?? [];
    list.push(tree);
    children.set(tree.parentId, list);
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
): TreeRow[] {
  const pending = (children.get(null) ?? [])
      .map((tree) => ({ tree, depth: 0 }))
      .reverse(),
    rows: TreeRow[] = [];
  while (pending.length) {
    const row = pending.pop()!;
    rows.push({ ...row, hasChildren: children.has(row.tree.id) });
    if (expanded.has(row.tree.id))
      for (const tree of [...(children.get(row.tree.id) ?? [])].reverse())
        pending.push({ tree, depth: row.depth + 1 });
  }
  return rows;
}
export function sidebarRows(trees: Item[], expanded: Set<string>): TreeRow[] {
  hierarchyIndex(trees);
  return visibleRows(treeChildren(trees), expanded);
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
  rows(expanded: Set<string>): TreeRow[];
}
/** Index once; cache only bounded labels, never every ancestor prefix/path string. */
export function createHierarchyPresentation(
  trees: Item[],
  rootLabel = 'Root',
): HierarchyPresentation {
  const index = hierarchyIndex(trees),
    children = treeChildren(trees),
    depths = new Map<string, number>();
  for (const tree of trees) {
    const pending: Item[] = [];
    let current: Item | undefined = tree;
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
    const tree = index.get(id);
    if (!tree) throw new Error('Missing tree.');
    return tree;
  }
  return {
    index,
    path(id) {
      const result: Item[] = [];
      while (id !== null) {
        const tree = lookup(id);
        result.push(tree);
        id = tree.parentId;
      }
      return result.reverse();
    },
    label(id) {
      const saved = labels.get(id);
      if (saved) return saved;
      const tree = lookup(id!),
        depth = depths.get(tree.id)!;
      let abbreviated = depth > 2;
      const tail =
        tree.parentId === null ? [tree] : [lookup(tree.parentId), tree];
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
/** One pass avoids rescanning the workspace for each visible tree card. */
export function entryCounts(s: WorkspaceSnapshot): Map<string | null, number> {
  const counts = new Map<string | null, number>();
  const scopes = scopeIndex(s.items);
  for (const item of s.items)
    if (scopes.get(item.id) === 'live')
      counts.set(item.parentId, (counts.get(item.parentId) ?? 0) + 1);
  return counts;
}
