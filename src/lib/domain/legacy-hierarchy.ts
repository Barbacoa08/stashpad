import type { LegacyStash } from './notes';
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
export function hierarchyIndex(
  stashes: LegacyStash[],
): Map<string, LegacyStash> {
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
