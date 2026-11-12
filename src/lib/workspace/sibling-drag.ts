import type { Location, WorkspaceSnapshot } from '../domain/notes';
import type { ReorderItem } from '../platform/workspace';
import { directEntries, itemLocation } from '../domain/hierarchy';
export const siblingDragType = 'application/x-stashpad-sibling';
const sameGroup = (a: Location, b: Location) =>
  a.scope === b.scope && a.itemId === b.itemId;
/** A transfer string alone never grants movement: this workspace must own the drag. */
export class SiblingDrag {
  private owned: {
    id: string;
    group: Location;
    token: string;
    valid: boolean;
  } | null = null;
  begin(id: string, group: Location) {
    const token = crypto.randomUUID();
    this.owned = { id, group: { ...group }, token, valid: true };
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
  ): ReorderItem | null {
    const owned = this.owned;
    if (
      !owned?.valid ||
      !this.owns(types) ||
      query.trim() ||
      !sameGroup(owned.group, group)
    )
      return null;
    const source = snapshot.items.find((x) => x.id === owned.id),
      destination = snapshot.items.find((x) => x.id === target);
    if (
      !source ||
      !destination ||
      source.id === target ||
      !sameGroup(itemLocation(snapshot.items, source.id), group) ||
      !sameGroup(itemLocation(snapshot.items, target), group)
    )
      return null;
    const siblings = directEntries(snapshot, group),
      from = siblings.findIndex((x) => x.id === source.id);
    const remaining = siblings.filter((x) => x.id !== source.id);
    const toIndex =
      remaining.findIndex((x) => x.id === target) + (edge === 'after' ? 1 : 0);
    return toIndex === from
      ? null
      : { id: source.id, group: { ...owned.group }, toIndex };
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
