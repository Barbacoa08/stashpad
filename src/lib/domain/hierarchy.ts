import type { Note, Stash, WorkspaceSnapshot } from './notes';
export const composeKey = (stashId: string | null): string =>
  stashId === null ? 'compose' : `compose:${stashId}`;
export function composeOwner(key: string): { stashId: string | null } | null {
  if (key === 'compose') return { stashId: null };
  if (key.startsWith('compose:')) return { stashId: key.slice(8) };
  return null;
}
export function stashName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || Array.from(trimmed).length > 200)
    throw new Error('Use a stash name with 1 to 200 characters.');
  return trimmed;
}
/** Exact IDs and an iterative, linear walk reject dangling parents and cycles. */
export function hierarchyIndex(stashes: Stash[]): Map<string, Stash> {
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
      id = current.parentId;
    }
    for (const key of pending) done.add(key);
  }
  return byId;
}
export function stashPath(stashes: Stash[], id: string | null): Stash[] {
  const byId = hierarchyIndex(stashes),
    path: Stash[] = [];
  while (id !== null) {
    const stash = byId.get(id);
    if (!stash) throw new Error('Missing stash.');
    path.push(stash);
    id = stash.parentId;
  }
  return path.reverse();
}
/** Convenience for isolated calls; views reuse one presentation per stash snapshot. */
export const locationLabel = (stashes: Stash[], id: string | null): string =>
  createHierarchyPresentation(stashes).label(id).text;
export type StreamEntry =
  ({ kind: 'stash' } & Stash) | ({ kind: 'note' } & Note);
export function directEntries(
  s: WorkspaceSnapshot,
  parentId: string | null,
): StreamEntry[] {
  hierarchyIndex(s.stashes);
  return [
    ...s.stashes
      .filter((x) => x.parentId === parentId)
      .map((x) => ({ ...x, kind: 'stash' as const })),
    ...s.notes
      .filter((x) => x.stashId === parentId && x.deletedAt === null)
      .map((x) => ({ ...x, kind: 'note' as const })),
  ].sort(
    (a, b) =>
      a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}
export interface StashRow {
  stash: Stash;
  depth: number;
  hasChildren: boolean;
}
function stashChildren(stashes: Stash[]): Map<string | null, Stash[]> {
  const children = new Map<string | null, Stash[]>();
  for (const stash of stashes) {
    const list = children.get(stash.parentId) ?? [];
    list.push(stash);
    children.set(stash.parentId, list);
  }
  for (const list of children.values())
    list.sort(
      (a, b) =>
        a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  return children;
}
function visibleRows(
  children: Map<string | null, Stash[]>,
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
  stashes: Stash[],
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
  readonly index: ReadonlyMap<string, Stash>;
  path(id: string | null): Stash[];
  label(id: string | null): LocationLabel;
  rows(expanded: Set<string>): StashRow[];
}
/** Index once; cache only bounded labels, never every ancestor prefix/path string. */
export function createHierarchyPresentation(
  stashes: Stash[],
): HierarchyPresentation {
  const index = hierarchyIndex(stashes),
    children = stashChildren(stashes),
    depths = new Map<string, number>();
  for (const stash of stashes) {
    const pending: Stash[] = [];
    let current: Stash | undefined = stash;
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
    [null, { text: 'Home', abbreviated: false, depth: 0 }],
  ]);
  function lookup(id: string): Stash {
    const stash = index.get(id);
    if (!stash) throw new Error('Missing stash.');
    return stash;
  }
  return {
    index,
    path(id) {
      const result: Stash[] = [];
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
        const name = item.name,
          points = Array.from(name);
        if (points.length <= 32) return name;
        abbreviated = true;
        return points.slice(0, 31).join('') + '…';
      });
      const label = {
        text: ['Home', ...(depth > 2 ? ['…'] : []), ...names].join(' / '),
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
  for (const stash of s.stashes)
    counts.set(stash.parentId, (counts.get(stash.parentId) ?? 0) + 1);
  for (const note of s.notes)
    if (note.deletedAt === null)
      counts.set(note.stashId, (counts.get(note.stashId) ?? 0) + 1);
  return counts;
}
