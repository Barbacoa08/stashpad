import { COLORS, MAX_SOURCE, type Item } from '../domain/notes';
import type { SharedItem, OrderRow, PurgeRow, ProjectionNotice } from './types';

const bytes = (value: string) => new TextEncoder().encode(value).length;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const fields = (value: unknown, keys: string[]): boolean =>
  record(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const uuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const integer = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const metadataId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && bytes(value) <= 128;
const nullableUuid = (value: unknown) => value === null || uuid(value);
const nullableInteger = (value: unknown) => value === null || integer(value);
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const groupKey = (parentId: string | null, scope: 'live' | 'trash') =>
  JSON.stringify([parentId, parentId === null ? scope : null]);
function invalid(): never {
  throw new Error('Invalid shared library rows.');
}
function unique(seen: Set<string>, key: string) {
  if (seen.has(key)) invalid();
  seen.add(key);
}

/** Pure deterministic view; raw rows remain available for recovery and reconciliation. */
export function projectLibrary(
  rows: readonly SharedItem[],
  orders: readonly OrderRow[],
  purges: readonly PurgeRow[],
  epoch: string,
): { items: Item[]; purgedIds: string[]; notices: ProjectionNotice[] } {
  if (
    !metadataId(epoch) ||
    !Array.isArray(rows) ||
    !Array.isArray(orders) ||
    !Array.isArray(purges)
  )
    invalid();
  const itemIdentities = new Set<string>(),
    purgeIdentities = new Set<string>(),
    orderIdentities = new Set<string>(),
    orderGroups = new Set<string>();
  const byId = new Map<string, Item>(),
    purgeTimes = new Map<string, number>(),
    groupOrders = new Map<string, OrderRow>();
  const notices: ProjectionNotice[] = [];
  for (const row of rows) {
    if (
      !fields(row, [
        'id',
        'epoch',
        'kind',
        'markdown',
        'done',
        'color',
        'createdAt',
        'updatedAt',
        'placement',
      ]) ||
      !uuid(row.id) ||
      !metadataId(row.epoch) ||
      (row.kind !== 'note' && row.kind !== 'tree') ||
      typeof row.markdown !== 'string' ||
      bytes(row.markdown) > MAX_SOURCE ||
      typeof row.done !== 'boolean' ||
      (row.color !== null && !COLORS.includes(row.color)) ||
      !integer(row.createdAt) ||
      !integer(row.updatedAt) ||
      row.updatedAt < row.createdAt ||
      !fields(row.placement, [
        'parentId',
        'deletedAt',
        'restoreParentId',
        'restoreIndex',
      ])
    )
      invalid();
    const placement = row.placement;
    if (
      !nullableUuid(placement.parentId) ||
      !nullableInteger(placement.deletedAt) ||
      !nullableUuid(placement.restoreParentId) ||
      !nullableInteger(placement.restoreIndex) ||
      (placement.restoreParentId !== null && placement.restoreIndex === null) ||
      (placement.deletedAt === null &&
        (placement.restoreParentId !== null || placement.restoreIndex !== null))
    )
      invalid();
    unique(itemIdentities, JSON.stringify([row.epoch, row.id.toLowerCase()]));
    if (row.epoch === epoch) {
      const { epoch: _epoch, placement: _placement, ...source } = row;
      byId.set(row.id, { ...source, ...placement, position: 0 });
    }
  }
  for (const row of purges) {
    if (
      !fields(row, ['id', 'epoch', 'purgedAt']) ||
      !uuid(row.id) ||
      !metadataId(row.epoch) ||
      !integer(row.purgedAt)
    )
      invalid();
    unique(purgeIdentities, JSON.stringify([row.epoch, row.id.toLowerCase()]));
    if (row.epoch === epoch) {
      purgeTimes.set(row.id, row.purgedAt);
      byId.delete(row.id);
    }
  }
  for (const row of orders) {
    if (
      !fields(row, ['id', 'epoch', 'parentId', 'scope', 'ids']) ||
      !metadataId(row.id) ||
      !metadataId(row.epoch) ||
      !nullableUuid(row.parentId) ||
      (row.scope !== 'live' && row.scope !== 'trash') ||
      !Array.isArray(row.ids) ||
      !Array.from(row.ids).every(uuid)
    )
      invalid();
    unique(orderIdentities, JSON.stringify([row.epoch, row.id]));
    const key = groupKey(row.parentId, row.scope);
    unique(orderGroups, JSON.stringify([row.epoch, key]));
    if (row.epoch === epoch) groupOrders.set(key, row);
  }
  if (byId.size > 20000) invalid();
  const items = [...byId.values()].sort((a, b) => compare(a.id, b.id));
  for (const item of items) {
    if (item.parentId !== null && !byId.has(item.parentId)) {
      item.deletedAt = purgeTimes.get(item.parentId) ?? item.updatedAt;
      item.parentId = null;
      notices.push({ kind: 'orphan', itemId: item.id });
    }
    if (item.restoreParentId !== null && !byId.has(item.restoreParentId)) {
      item.restoreParentId = null;
      notices.push({ kind: 'restore-parent', itemId: item.id });
    }
  }
  // Each path is visited once. Cycle repair never recurses, including deep chains.
  const visited = new Set<string>();
  for (const item of items) {
    const path: string[] = [],
      offsets = new Map<string, number>();
    let cursor: string | null = item.id;
    while (cursor !== null && !visited.has(cursor)) {
      const offset = offsets.get(cursor);
      if (offset !== undefined) {
        let greatest = path[offset];
        for (let i = offset + 1; i < path.length; i++)
          if (compare(path[i], greatest) > 0) greatest = path[i];
        byId.get(greatest)!.parentId = null;
        notices.push({ kind: 'cycle', itemId: greatest });
        break;
      }
      offsets.set(cursor, path.length);
      path.push(cursor);
      cursor = byId.get(cursor)!.parentId;
    }
    for (const id of path) visited.add(id);
  }
  const scopes = new Map<string, 'live' | 'trash'>();
  for (const item of items) {
    const path: Item[] = [];
    let cursor: Item | undefined = item;
    while (cursor && !scopes.has(cursor.id)) {
      path.push(cursor);
      if (cursor.deletedAt !== null) {
        scopes.set(cursor.id, 'trash');
        break;
      }
      cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId);
    }
    const scope = cursor ? scopes.get(cursor.id)! : 'live';
    for (const node of path) scopes.set(node.id, scope);
  }
  const groups = new Map<string, Item[]>();
  for (const item of items) {
    if (
      item.deletedAt !== null &&
      item.parentId !== null &&
      scopes.get(item.parentId) === 'live'
    ) {
      item.parentId = null;
      notices.push({ kind: 'trash-root', itemId: item.id });
    }
    if (item.parentId !== null) byId.get(item.parentId)!.kind = 'tree';
    const key = groupKey(item.parentId, scopes.get(item.id)!);
    const siblings = groups.get(key) ?? [];
    siblings.push(item);
    groups.set(key, siblings);
  }
  for (const [key, siblings] of groups) {
    const remaining = new Map(siblings.map((item) => [item.id, item]));
    let position = 0;
    for (const id of groupOrders.get(key)?.ids ?? []) {
      const item = remaining.get(id);
      if (item) {
        item.position = position++;
        remaining.delete(id);
      }
    }
    const appended = [...remaining.values()].sort(
      (a, b) => a.createdAt - b.createdAt || compare(a.id, b.id),
    );
    for (const item of appended) item.position = position++;
  }
  notices.sort(
    (a, b) => compare(a.itemId, b.itemId) || compare(a.kind, b.kind),
  );
  return { items, purgedIds: [...purgeTimes.keys()].sort(compare), notices };
}
