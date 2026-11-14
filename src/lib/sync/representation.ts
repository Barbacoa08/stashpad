import type { Item, WorkspaceSnapshot } from '../domain/notes';
import { scopeIndex } from '../domain/hierarchy';
import type { SharedItem, OrderRow } from './types';
export const toSharedItem = (item: Item, epoch: string): SharedItem => {
  const {
    parentId,
    position: _position,
    deletedAt,
    restoreParentId,
    restoreIndex,
    ...source
  } = item;
  return {
    ...source,
    epoch,
    placement: { parentId, deletedAt, restoreParentId, restoreIndex },
  };
};
export function orderRows(
  snapshot: WorkspaceSnapshot,
  epoch: string,
): OrderRow[] {
  const scopes = scopeIndex(snapshot.items),
    groups = new Map<string, OrderRow>();
  for (const item of snapshot.items) {
    const scope = item.parentId === null ? scopes.get(item.id)! : 'live';
    const id = item.parentId ?? `root:${scope}`;
    const row = groups.get(id) ?? {
      id,
      epoch,
      parentId: item.parentId,
      scope,
      ids: [],
    };
    row.ids.push(item.id);
    groups.set(id, row);
  }
  const positions = new Map(snapshot.items.map((x) => [x.id, x.position]));
  return [...groups.values()].map((x) => ({
    ...x,
    ids: x.ids.sort((a, b) => positions.get(a)! - positions.get(b)!),
  }));
}
