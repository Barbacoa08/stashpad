import type { Item } from './notes';
import { scopeIndex } from './hierarchy';
export function filterNotes(
  items: Item[],
  query: string,
  scope: 'live' | 'trash' = 'live',
): Item[] {
  const q = query.trim().toLowerCase();
  const scopes = scopeIndex(items);
  return items
    .filter(
      (x) =>
        scopes.get(x.id) === scope &&
        (!q || x.markdown.toLowerCase().includes(q)),
    )
    .sort(
      (a, b) =>
        a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
}
