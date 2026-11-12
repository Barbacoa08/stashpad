import type { Item, Location } from '../domain/notes';
import { itemLabel, scopeIndex } from '../domain/hierarchy';
const sameLocation = (a: Location, b: Location) =>
  a.scope === b.scope && a.itemId === b.itemId;
interface Visit {
  index: number;
  location: Location;
}
/** Session-only visits. Starting a traversal never commits its cursor. */
export class NavigationHistory {
  entries: Location[] = [];
  cursor = -1;
  private pending: Visit | null = null;
  reset(at: Location) {
    this.entries = [{ ...at }];
    this.cursor = 0;
    this.cancel();
  }
  cancel() {
    this.pending = null;
  }
  visit(at: Location) {
    this.cancel();
    if (
      this.entries[this.cursor] &&
      sameLocation(this.entries[this.cursor], at)
    )
      return;
    this.entries = [...this.entries.slice(0, this.cursor + 1), { ...at }].slice(
      -100,
    );
    this.cursor = this.entries.length - 1;
  }
  reconcile(at: Location) {
    this.cancel();
    if (this.cursor < 0) this.reset(at);
    else this.entries[this.cursor] = { ...at };
  }
  target(direction: -1 | 1, valid: (at: Location) => boolean): Visit | null {
    for (
      let index = this.cursor + direction;
      index >= 0 && index < this.entries.length;
      index += direction
    ) {
      if (valid(this.entries[index]))
        return { index, location: { ...this.entries[index] } };
    }
    return null;
  }
  begin(direction: -1 | 1, valid: (at: Location) => boolean) {
    this.pending = this.target(direction, valid);
    return this.pending;
  }
  acknowledge(at: Location) {
    if (!this.pending || !sameLocation(this.pending.location, at)) return false;
    this.cursor = this.pending.index;
    this.cancel();
    return true;
  }
}
export function historyLocationValidator(
  items: Item[],
  scopes: ReadonlyMap<string, Location['scope']> = scopeIndex(items),
): (at: Location) => boolean {
  const stashes = new Set(
    items.filter((x) => x.kind === 'stash').map((x) => x.id),
  );
  return (at) =>
    at.itemId === null ||
    (stashes.has(at.itemId) && scopes.get(at.itemId) === at.scope);
}
export interface Breadcrumb {
  label: string;
  location?: Location;
  current?: boolean;
}
/** At most root, omission, parent, and current; stop at an explicit Trash root. */
export function breadcrumbs(items: Item[], at: Location): Breadcrumb[] {
  const root: Breadcrumb = {
    label: at.scope === 'trash' ? 'Trash' : 'Home',
    location: { scope: at.scope, itemId: null },
    current: at.itemId === null,
  };
  if (at.itemId === null) return [root];
  const index = new Map(items.map((x) => [x.id, x]));
  const path: Item[] = [];
  let current = index.get(at.itemId);
  while (current) {
    path.push(current);
    if (at.scope === 'trash' && current.deletedAt !== null) break;
    current =
      current.parentId === null ? undefined : index.get(current.parentId);
  }
  path.reverse();
  return [
    root,
    ...(path.length > 2
      ? [{ label: `${path.length - 2} ancestors omitted` }]
      : []),
    ...path.slice(-2).map((x) => ({
      label: itemLabel(x),
      location: { ...at, itemId: x.id },
      current: x.id === at.itemId,
    })),
  ];
}
