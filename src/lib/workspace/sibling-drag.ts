import type { Location, WorkspaceSnapshot } from '../domain/notes';
import { directEntries, itemLocation } from '../domain/hierarchy';
export interface SiblingDrop {
  ids: string[];
  group: Location;
  toIndex: number;
}
export const siblingDragType = 'application/x-stashpad-sibling';
const sameGroup = (a: Location, b: Location) =>
  a.scope === b.scope && a.itemId === b.itemId;
/** A transfer string alone never grants movement: this workspace must own the drag. */
export class SiblingDrag {
  private owned: {
    ids: string[];
    group: Location;
    token: string;
    valid: boolean;
  } | null = null;
  begin(ids: string | readonly string[], group: Location) {
    const token = crypto.randomUUID();
    this.owned = {
      ids: typeof ids === 'string' ? [ids] : [...ids],
      group: { ...group },
      token,
      valid: true,
    };
    return token;
  }
  clear() {
    this.owned = null;
  }
  invalidate() {
    // Keep rejection feedback until this native drag ends, but never revive its authority.
    if (this.owned) this.owned.valid = false;
  }
  owns(types: readonly string[]) {
    return !!this.owned && types.length === 1 && types[0] === siblingDragType;
  }
  preview(
    snapshot: WorkspaceSnapshot,
    group: Location,
    query: string,
    target: string,
    edge: 'before' | 'after',
    types: readonly string[],
  ): SiblingDrop | null {
    const owned = this.owned;
    if (
      !owned?.valid ||
      !this.owns(types) ||
      query.trim() ||
      !sameGroup(owned.group, group)
    )
      return null;
    const selected = new Set(owned.ids);
    const siblings = directEntries(snapshot, group);
    const ordered = siblings.filter((item) => selected.has(item.id));
    if (
      !owned.ids.length ||
      selected.size !== owned.ids.length ||
      ordered.length !== owned.ids.length ||
      ordered.some((item, index) => item.id !== owned.ids[index]) ||
      selected.has(target) ||
      !siblings.some((item) => item.id === target) ||
      !sameGroup(itemLocation(snapshot.items, target), group)
    )
      return null;
    const remaining = siblings.filter((item) => !selected.has(item.id));
    const toIndex =
      remaining.findIndex((item) => item.id === target) +
      (edge === 'after' ? 1 : 0);
    const after = remaining.map((item) => item.id);
    after.splice(toIndex, 0, ...owned.ids);
    return after.every((id, index) => id === siblings[index].id)
      ? null
      : { ids: [...owned.ids], group: { ...owned.group }, toIndex };
  }
  drop(
    snapshot: WorkspaceSnapshot,
    group: Location,
    query: string,
    target: string,
    edge: 'before' | 'after',
    types: readonly string[],
    token: string,
  ) {
    const request =
      token === this.owned?.token
        ? this.preview(snapshot, group, query, target, edge, types)
        : null;
    this.clear();
    return request;
  }
}
