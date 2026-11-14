import type { SharedItem, OrderRow, PurgeRow } from './types';
import type { Item } from '../domain/notes';
import { validateSnapshot } from '../domain/validation';
import { directEntries, effectiveScope } from '../domain/hierarchy';
import { canonicalJson, digest, type PendingIntent } from './intents';
import { projectLibrary } from './canonical';
import { encodeCloudBackup } from './backup';
export interface SharedEnvelope {
  epoch: string;
  notes: SharedItem[];
  orders: OrderRow[];
  purges: PurgeRow[];
}
export const sharedKey = (shared: SharedEnvelope) =>
  canonicalJson({
    ...shared,
    notes: [...shared.notes].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    ),
    orders: [...shared.orders].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    ),
    purges: [...shared.purges].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    ),
  });
export interface RemoteLibrary {
  shared?: SharedEnvelope;
  observed?: { id: string; note: unknown | null; purge: unknown | null };
  epoch: string;
  items: Item[];
  purgedIds: string[];
}
export type Confirmation = 'unknown' | 'matching' | 'superseded';
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
/** The cloud adds ownership metadata; all application fields remain strictly validated. */
export function applicationFields(value: unknown): unknown {
  if (!record(value)) throw new Error('Invalid server row.');
  const { owner: _owner, realmId: _realm, ...fields } = value;
  return fields;
}
export async function classifyOutcome(
  p: PendingIntent,
  witness: unknown,
  remote: RemoteLibrary,
): Promise<Confirmation> {
  if (!record(witness)) return 'unknown';
  const w = applicationFields(witness) as Record<string, unknown>;
  if (
    Object.keys(w).length !== 4 ||
    w.id !== p.id ||
    w.epoch !== p.epoch ||
    w.digest !== p.digest ||
    w.recordedAt !== p.recordedAt
  )
    return 'unknown';
  const validated = validateSnapshot({
    items: remote.items,
    drafts: [],
    undoDeleteIds: [],
  });
  if ('code' in validated) return 'unknown';
  if (remote.epoch !== p.epoch) return 'superseded';
  const items = new Map(remote.items.map((x) => [x.id, x]));
  for (const id of p.expected.purgedIds)
    if (!remote.purgedIds.includes(id)) return 'superseded';
  for (const outcome of p.expected.items) {
    const actual = items.get(outcome.id);
    if (outcome.kind === 'purge') {
      if (actual || !remote.purgedIds.includes(outcome.id)) return 'superseded';
      continue;
    }
    if (!actual) return 'superseded';
    if (outcome.kind === 'create') {
      if (actual.markdown !== outcome.item.markdown) return 'superseded';
    } else {
      if (
        outcome.source &&
        (await digest(actual.markdown)) !== outcome.source.afterDigest
      )
        return 'superseded';
      if (
        outcome.placement &&
        !equal(placement(actual), outcome.placement.after)
      )
        return 'superseded';
      for (const [key, delta] of Object.entries(outcome.fields))
        if (
          key !== 'updatedAt' &&
          key !== 'position' &&
          !equal(actual[key as keyof Item], delta.after)
        )
          return 'superseded';
    }
  }
  for (const order of p.expected.orders) {
    const known = new Set(order.ids),
      actual = directEntries(
        { items: remote.items, drafts: [], undoDeleteIds: [] },
        order.group,
      )
        .map((x) => x.id)
        .filter((x) => known.has(x));
    if (!equal(actual, order.ids)) return 'superseded';
  }
  // Desired command outcomes apply even when the local replay had no deltas.
  const command = p.command;
  const inLocation = (id: string, at: import('../domain/notes').Location) => {
    const item = items.get(id);
    return (
      !!item &&
      item.parentId === at.itemId &&
      effectiveScope(remote.items, id) === at.scope
    );
  };
  const purged = (ids: string[]) =>
    ids.every((id) => !items.has(id) && remote.purgedIds.includes(id));
  switch (command.kind) {
    case 'saveItemSource':
      if (items.get(command.id)?.markdown !== command.markdown)
        return 'superseded';
      break;
    case 'captureItem':
      if (items.get(command.request.id)?.markdown !== command.request.markdown)
        return 'superseded';
      break;
    case 'createChildTree':
      if (items.get(command.request.id)?.markdown !== 'Untitled')
        return 'superseded';
      break;
    case 'setItemDone':
      if (items.get(command.id)?.done !== command.done) return 'superseded';
      break;
    case 'setItemColor':
      if (
        !items.has(command.id) ||
        items.get(command.id)!.color !== command.color
      )
        return 'superseded';
      break;
    case 'promoteItem':
      if (items.get(command.id)?.kind !== 'tree') return 'superseded';
      break;
    case 'transitionLocation':
      if (
        command.request.to.itemId !== null &&
        (items.get(command.request.to.itemId)?.kind !== 'tree' ||
          effectiveScope(remote.items, command.request.to.itemId) !==
            command.request.to.scope)
      )
        return 'superseded';
      break;
    case 'deleteItem':
      if (!items.has(command.id) || items.get(command.id)!.deletedAt === null)
        return 'superseded';
      break;
    case 'restoreItem':
      if (
        !items.has(command.id) ||
        effectiveScope(remote.items, command.id) !== 'live'
      )
        return 'superseded';
      break;
    case 'purgeItem':
      if (!purged(command.request.expectedSubtreeIds)) return 'superseded';
      break;
    case 'correctivePurge':
      if (remote.epoch !== command.epoch || !purged(command.ids))
        return 'superseded';
      break;
    case 'undoDelete':
      for (const id of command.request.ids) {
        const desired = command.request.proof.after.find(
            (item) => item.id === id,
          ),
          actual = items.get(id);
        if (
          !actual ||
          !desired ||
          effectiveScope(remote.items, id) !== 'live' ||
          !equal(placement(actual), placement(desired))
        )
          return 'superseded';
      }
      break;
    case 'reorderItem':
      if (!inLocation(command.request.id, command.request.group))
        return 'superseded';
      if (
        !p.expected.orders.length &&
        directEntries(
          { items: remote.items, drafts: [], undoDeleteIds: [] },
          command.request.group,
        )[command.request.toIndex]?.id !== command.request.id
      )
        return 'superseded';
      break;
    case 'moveItems': {
      const request = command.request;
      if (request.ids.some((id) => !inLocation(id, request.to)))
        return 'superseded';
      for (const [group, ids] of [
        [request.from, request.afterFrom],
        [request.to, request.afterTo],
      ] as const) {
        const known = new Set(ids),
          actual = directEntries(
            { items: remote.items, drafts: [], undoDeleteIds: [] },
            group,
          )
            .map((item) => item.id)
            .filter((id) => known.has(id));
        if (!equal(actual, ids)) return 'superseded';
      }
      break;
    }
    case 'replaceLibrary':
      if (
        remote.epoch !== command.newEpoch ||
        command.backup.library.items.some(
          (item) => items.get(item.id)?.markdown !== item.markdown,
        ) ||
        !purged(command.backup.library.purgedIds)
      )
        return 'superseded';
      break;
  }
  return 'matching';
}
function placement(
  item: Pick<
    Item,
    'parentId' | 'deletedAt' | 'restoreParentId' | 'restoreIndex'
  >,
) {
  return {
    parentId: item.parentId,
    deletedAt: item.deletedAt,
    restoreParentId: item.restoreParentId,
    restoreIndex: item.restoreIndex,
  };
}
export interface RemoteReadOptions {
  databaseUrl: string;
  token: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}
async function withRemoteAbort<T>(
  options: RemoteReadOptions,
  work: (send: typeof fetch) => Promise<T>,
): Promise<T> {
  const own = options.signal ? null : new AbortController(),
    signal = options.signal ?? own!.signal;
  if (signal.aborted) throw new Error('Server confirmation was stopped.');
  const timer = own ? setTimeout(() => own.abort(), 10000) : undefined;
  let rejectAbort: (error: Error) => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () =>
    rejectAbort(new Error('Server confirmation was stopped.'));
  signal.addEventListener('abort', onAbort, { once: true });
  const send: typeof fetch = async (input, init) => {
    if (signal.aborted) throw new Error('Server confirmation was stopped.');
    const response = await (options.fetch ?? fetch)(input, { ...init, signal });
    if (signal.aborted) throw new Error('Server confirmation was stopped.');
    return response;
  };
  try {
    return await Promise.race([work(send), aborted]);
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}
export async function readRemoteRow(
  options: RemoteReadOptions,
  table: string,
  key: string | [string, string],
): Promise<unknown | null> {
  return withRemoteAbort(options, async (send) => {
    const response = await send(
      `${options.databaseUrl.replace(/\/$/, '')}/my/${table}/${encodeURIComponent(typeof key === 'string' ? key : JSON.stringify(key))}`,
      {
        cache: 'no-store',
        headers: { Authorization: `Bearer ${options.token}` },
      },
    );
    if (response.status === 404) return null;
    const exact = (value: unknown) =>
      record(value) &&
      value.id === (typeof key === 'string' ? key : key[1]) &&
      (typeof key === 'string' || value.epoch === key[0]);
    if (response.status === 422) {
      const query = new URLSearchParams(
        typeof key === 'string' ? { id: key } : { epoch: key[0], id: key[1] },
      );
      const filtered = await send(
        `${options.databaseUrl.replace(/\/$/, '')}/my/${table}?${query}`,
        {
          cache: 'no-store',
          headers: { Authorization: `Bearer ${options.token}` },
        },
      );
      if (filtered.status !== 200)
        throw new Error('Server confirmation is unavailable.');
      const rows: unknown = await filtered.json();
      if (
        !Array.isArray(rows) ||
        rows.length > 1 ||
        (rows.length === 1 && !exact(rows[0]))
      )
        throw new Error('Ambiguous server confirmation.');
      return rows[0] ?? null;
    }
    if (response.status !== 200)
      throw new Error('Server confirmation is unavailable.');
    const value: unknown = await response.json();
    if (!exact(value)) throw new Error('Invalid server row identity.');
    return value;
  });
}
/** A fresh user-scoped view is validated in full; malformed/overflow data never acknowledges writes. */
export async function readRemoteLibrary(
  options: RemoteReadOptions & { libraryId: string; epoch: string },
): Promise<RemoteLibrary> {
  const pointer = applicationFields(
    await readRemoteRow(options, 'libraries', options.libraryId),
  );
  if (
    !record(pointer) ||
    Object.keys(pointer).length !== 2 ||
    pointer.id !== options.libraryId ||
    typeof pointer.epoch !== 'string' ||
    !pointer.epoch.length ||
    new TextEncoder().encode(pointer.epoch).length > 128
  )
    throw new Error('Invalid server library.');
  const epoch = pointer.epoch;
  const rows: unknown[][] = [];
  for (const table of ['notes', 'orders', 'purges']) {
    const values: unknown = await withRemoteAbort(options, async (send) => {
      const response = await send(
        `${options.databaseUrl.replace(/\/$/, '')}/my/${table}?epoch=${encodeURIComponent(epoch)}`,
        {
          cache: 'no-store',
          headers: { Authorization: `Bearer ${options.token}` },
        },
      );
      if (
        response.status !== 200 ||
        response.headers.has('content-range') ||
        response.headers.has('link')
      )
        throw new Error('Incomplete server confirmation.');
      return response.json();
    });
    if (!Array.isArray(values)) throw new Error('Invalid server library.');
    if (values.some((value) => !record(value) || value.epoch !== epoch))
      throw new Error('Invalid server epoch filter.');
    rows.push(values.map(applicationFields));
  }
  // projectLibrary checks every raw field before any checked cast below can escape.
  const projected = projectLibrary(
    rows[0] as Parameters<typeof projectLibrary>[0],
    rows[1] as Parameters<typeof projectLibrary>[1],
    rows[2] as Parameters<typeof projectLibrary>[2],
    epoch,
  );
  encodeCloudBackup({
    library: { items: projected.items, purgedIds: projected.purgedIds },
    device: { drafts: [], undoDeleteIds: [], recovery: [] },
  });
  const after = applicationFields(
    await readRemoteRow(options, 'libraries', options.libraryId),
  );
  if (!equal(pointer, after))
    throw new Error('The server library changed during confirmation.');
  return {
    epoch,
    items: projected.items,
    purgedIds: projected.purgedIds,
    shared: {
      epoch,
      notes: rows[0] as SharedItem[],
      orders: rows[1] as OrderRow[],
      purges: rows[2] as PurgeRow[],
    },
  };
}
/** Source, completion, and color confirmation read only the captured exact item. */
export async function readRemoteOutcome(
  options: RemoteReadOptions & { libraryId: string; epoch: string },
  p: PendingIntent,
): Promise<RemoteLibrary> {
  if (
    !['saveItemSource', 'setItemDone', 'setItemColor'].includes(p.command.kind)
  )
    return readRemoteLibrary(options);
  const command = p.command as Extract<
    PendingIntent['command'],
    { id: string }
  >;
  const pointer = applicationFields(
    await readRemoteRow(options, 'libraries', options.libraryId),
  );
  if (
    !record(pointer) ||
    Object.keys(pointer).length !== 2 ||
    pointer.id !== options.libraryId ||
    typeof pointer.epoch !== 'string' ||
    !pointer.epoch.length ||
    new TextEncoder().encode(pointer.epoch).length > 128
  )
    throw new Error('Invalid server library.');
  if (pointer.epoch !== p.epoch)
    return { epoch: pointer.epoch, items: [], purgedIds: [] };
  const raw = await readRemoteRow(options, 'notes', [p.epoch, command.id]);
  const tombstone = await readRemoteRow(options, 'purges', [
    p.epoch,
    command.id,
  ]);
  const note = raw === null ? null : applicationFields(raw),
    purge = tombstone === null ? null : applicationFields(tombstone);
  const projected = projectLibrary(
    raw === null
      ? []
      : ([applicationFields(raw)] as Parameters<typeof projectLibrary>[0]),
    [],
    tombstone === null
      ? []
      : ([applicationFields(tombstone)] as Parameters<
          typeof projectLibrary
        >[2]),
    p.epoch,
  );
  const after = applicationFields(
    await readRemoteRow(options, 'libraries', options.libraryId),
  );
  if (!equal(pointer, after))
    throw new Error('The server library changed during confirmation.');
  return {
    epoch: p.epoch,
    items: projected.items,
    purgedIds: projected.purgedIds,
    observed: { id: command.id, note, purge },
  };
}

/** Lightweight fresh server evidence also governs clean Retry and connection events. */
export async function readRemoteEpoch(
  options: RemoteReadOptions,
  libraryId: string,
): Promise<string> {
  const pointer = applicationFields(
    await readRemoteRow(options, 'libraries', libraryId),
  );
  if (
    !record(pointer) ||
    Object.keys(pointer).length !== 2 ||
    pointer.id !== libraryId ||
    typeof pointer.epoch !== 'string' ||
    !pointer.epoch.length ||
    new TextEncoder().encode(pointer.epoch).length > 128
  )
    throw new Error('Invalid server library.');
  return pointer.epoch;
}
