import type { ScratchtreeDatabase } from './database';
import type { PendingIntent } from './intents';
import {
  canonicalJson,
  sourceOfIntent,
  sourceHeadKey,
  readJournalMetadata,
} from './intents';
import { encodeCloudBackup, type RecoveryRecord } from './backup';
import type { Confirmation, SharedEnvelope } from './confirmation';
import { projectLibrary } from './canonical';
import { applicationFields } from './confirmation';
/** Resolve only an unchanged captured intent, atomically retaining a rejected alternative. */
export async function resolveIntent(
  db: ScratchtreeDatabase,
  p: PendingIntent,
  result: Confirmation,
  signal?: AbortSignal,
) {
  if (result === 'unknown' || signal?.aborted) return false;
  let abortTransaction = () => {};
  const onAbort = () => abortTransaction();
  return db
    .transaction(
      'rw',
      [
        db.pending,
        db.recovery,
        db.device,
        db.notes,
        db.orders,
        db.purges,
        db.drafts,
        db.undo,
      ],
      async (transaction) => {
        abortTransaction = () => transaction.abort();
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) return false;
        const current = await db.pending.get(p.id);
        if (!current || canonicalJson(current) !== canonicalJson(p))
          return false;
        const all = await db.pending.toArray(),
          recovery = await db.recovery.toArray();
        const capturedSource = sourceOfIntent(p);
        const newer = capturedSource
          ? all
              .filter(
                (other) =>
                  other.epoch === p.epoch &&
                  other.sequence > p.sequence &&
                  sourceOfIntent(other)?.id === capturedSource.id,
              )
              .sort((a, b) => b.sequence - a.sequence)[0]
          : undefined;
        const head = capturedSource
          ? (await readJournalMetadata(db)).sources.find(
              (head) =>
                head.epoch === p.epoch && head.itemId === capturedSource.id,
            )
          : undefined;
        const resolvedNewer =
          head &&
          head.sequence > p.sequence &&
          (!newer || head.sequence > newer.sequence);
        const source =
          result === 'superseded'
            ? resolvedNewer
              ? null
              : newer
                ? sourceOfIntent(newer)
                : capturedSource
            : capturedSource;
        if (
          source &&
          result === 'superseded' &&
          !recovery.some(
            (r) =>
              r.kind === 'source' &&
              r.originEpoch === p.epoch &&
              r.itemId === source.id &&
              r.markdown === source.markdown,
          )
        )
          recovery.push({
            id: crypto.randomUUID(),
            kind: 'source',
            itemId: source.id,
            markdown: source.markdown,
            originEpoch: p.epoch,
            recordedAt: Date.now(),
            reason: 'rejected',
          });
        if (result === 'superseded' && !capturedSource) {
          const snapshot =
            p.command.kind === 'replaceLibrary'
              ? {
                  items: p.command.backup.library.items,
                  drafts: p.command.backup.device.drafts,
                  undoDeleteIds: p.command.backup.device.undoDeleteIds,
                }
              : ((
                  (
                    await db.device
                      .where('key')
                      .startsWith('library-view:')
                      .toArray()
                  )
                    .map((row) => row.value)
                    .find(
                      (value) =>
                        value &&
                        typeof value === 'object' &&
                        'epoch' in value &&
                        'snapshot' in value &&
                        value.epoch === p.epoch,
                    ) as
                    | { snapshot: import('../domain/notes').WorkspaceSnapshot }
                    | undefined
                )?.snapshot ??
                recovery.find(
                  (r): r is Extract<RecoveryRecord, { kind: 'library' }> =>
                    r.kind === 'library' && r.originEpoch === p.epoch,
                )?.snapshot);
          if (!snapshot) return false;
          if (
            snapshot &&
            !recovery.some(
              (r) =>
                r.kind === 'library' &&
                r.reason === 'rejected' &&
                r.originEpoch === p.epoch &&
                canonicalJson(r.snapshot) === canonicalJson(snapshot),
            )
          )
            recovery.push({
              id: crypto.randomUUID(),
              kind: 'library',
              snapshot,
              reason: 'rejected',
              originEpoch: p.epoch,
              recordedAt: Date.now(),
            });
        }
        // Do not prune a recovery alternative needed by a different unresolved operation.
        const remove =
          result === 'matching' &&
          source &&
          !all.some(
            (other) =>
              other.id !== p.id &&
              other.epoch === p.epoch &&
              sourceOfIntent(other)?.id === source.id,
          )
            ? recovery.filter(
                (r) =>
                  r.kind === 'source' &&
                  r.originEpoch === p.epoch &&
                  r.itemId === source.id &&
                  r.markdown === source.markdown,
              )
            : [];
        const next = recovery.filter((r) => !remove.includes(r));
        // Use the last acknowledged valid view even when raw cloud rows overflow.
        const marker = (
          await db.device.where('key').startsWith('library-view:').toArray()
        )
          .map((row) => row.value)
          .find(
            (value) =>
              value &&
              typeof value === 'object' &&
              'epoch' in value &&
              'snapshot' in value &&
              value.epoch === p.epoch,
          ) as
          { snapshot: import('../domain/notes').WorkspaceSnapshot } | undefined;
        const snapshot = marker?.snapshot ?? {
          items: [],
          drafts: [],
          undoDeleteIds: [],
        };
        encodeCloudBackup({
          library: { items: snapshot.items, purgedIds: [] },
          device: {
            drafts: snapshot.drafts,
            undoDeleteIds: snapshot.undoDeleteIds,
            recovery: next,
          },
        });
        for (const r of next) await db.recovery.put(r);
        for (const r of remove) await db.recovery.delete(r.id);
        await db.pending.delete(p.id);
        if (
          capturedSource &&
          !all.some(
            (other) =>
              other.id !== p.id &&
              other.epoch === p.epoch &&
              sourceOfIntent(other)?.id === capturedSource.id,
          )
        )
          await db.device.delete(sourceHeadKey(p.epoch, capturedSource.id));
        await db.device.put({
          key: `resolved-witness:${p.id}`,
          value: {
            id: p.id,
            epoch: p.epoch,
            digest: p.digest,
            recordedAt: p.recordedAt,
          },
        });
        if (signal?.aborted) throw new Error('Confirmation was stopped.');
        return true;
      },
    )
    .finally(() => signal?.removeEventListener('abort', onAbort));
}
export interface RawRecovery {
  format: 'scratchtree-raw-recovery';
  version: 1;
  exportedAt: string;
  libraryId: string;
  epoch: string;
  notes: unknown[];
  orders: unknown[];
  purges: unknown[];
  drafts: unknown[];
  pending: PendingIntent[];
  recovery: RecoveryRecord[];
  buffers: RawBuffer[];
  journal: import('./intents').JournalMetadata;
}
/** Deliberately distinct from a normal backup; raw source is never truncated. */
export async function rawRecovery(
  db: ScratchtreeDatabase,
  libraryId: string,
): Promise<RawRecovery> {
  return db.transaction(
    'r',
    [
      db.libraries,
      db.notes,
      db.orders,
      db.purges,
      db.drafts,
      db.pending,
      db.recovery,
      db.device,
    ],
    async () => {
      const pointer = await db.libraries.get(libraryId);
      if (!pointer) throw new Error('The library is unavailable.');
      const epoch = pointer.epoch;
      return {
        format: 'scratchtree-raw-recovery',
        version: 1,
        exportedAt: new Date().toISOString(),
        libraryId,
        epoch,
        notes: (await db.notes.where('epoch').equals(epoch).toArray()).map(
          applicationFields,
        ),
        orders: (await db.orders.where('epoch').equals(epoch).toArray()).map(
          applicationFields,
        ),
        purges: (await db.purges.where('epoch').equals(epoch).toArray()).map(
          applicationFields,
        ),
        drafts: await db.drafts.toArray(),
        pending: await db.pending.toArray(),
        recovery: await db.recovery.toArray(),
        buffers: await readRawBuffers(db),
        journal: await readJournalMetadata(db),
      };
    },
  );
}
export async function rawViewValid(db: ScratchtreeDatabase, libraryId: string) {
  const raw = await rawRecovery(db, libraryId);
  if (raw.buffers.length) throw new Error('Raw input needs recovery adoption.');
  const view = projectLibrary(
    raw.notes as Parameters<typeof projectLibrary>[0],
    raw.orders as Parameters<typeof projectLibrary>[1],
    raw.purges as Parameters<typeof projectLibrary>[2],
    raw.epoch,
  );
  encodeCloudBackup({
    library: { items: view.items, purgedIds: view.purgedIds },
    device: { drafts: [], undoDeleteIds: [], recovery: [] },
  });
  return {
    ...view,
    shared: {
      epoch: raw.epoch,
      notes: raw.notes,
      orders: raw.orders,
      purges: raw.purges,
    } as SharedEnvelope,
    pendingCount: raw.pending.length,
    recoveries: raw.recovery.length,
  };
}

/** Shared deletion is requested once; only server absence releases its local retry marker. */
export async function cleanupResolvedWitness(
  db: ScratchtreeDatabase,
  id: string,
  remote: unknown | null,
  signal?: AbortSignal,
) {
  if (signal?.aborted) return false;
  let abortTransaction = () => {};
  const onAbort = () => abortTransaction();
  return db
    .transaction(
      'rw',
      [db.pending, db.witnesses, db.device],
      async (transaction) => {
        abortTransaction = () => transaction.abort();
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) return false;
        const key = `resolved-witness:${id}`,
          row = await db.device.get(key);
        if (!row || (await db.pending.get(id))) return false;
        const marker = row.value as {
          id: string;
          epoch: string;
          digest: string;
          recordedAt: number;
        };
        if (marker.id !== id) return false;
        if (remote === null) {
          await db.device.delete(key);
          return true;
        }
        const value = applicationFields(remote) as Record<string, unknown>;
        if (
          Object.keys(value).length !== 4 ||
          value.id !== id ||
          value.epoch !== marker.epoch ||
          value.digest !== marker.digest ||
          value.recordedAt !== marker.recordedAt
        )
          return false;
        await db.witnesses.delete(id);
        return false;
      },
    )
    .finally(() => signal?.removeEventListener('abort', onAbort));
}

/** Row-wise JSON keeps native IPC chunks bounded, including supplementary Unicode. */
export async function* recoveryChunks(
  raw: RawRecovery,
): AsyncGenerator<string> {
  function* fragments() {
    yield '{';
    let first = true;
    for (const [key, value] of Object.entries(raw)) {
      if (!first) yield ',';
      first = false;
      yield JSON.stringify(key) + ':';
      if (Array.isArray(value)) {
        yield '[';
        for (let i = 0; i < value.length; i++) {
          if (i) yield ',';
          yield JSON.stringify(value[i]);
        }
        yield ']';
      } else yield JSON.stringify(value);
    }
    yield '}';
  }
  const limit = 1024 * 1024;
  let parts: string[] = [],
    bytes = 0;
  for (const fragment of fragments()) {
    let start = 0,
      index = 0;
    for (const character of fragment) {
      const code = character.codePointAt(0)!;
      const size =
        code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
      if (bytes + size > limit) {
        parts.push(fragment.slice(start, index));
        yield parts.join('');
        parts = [];
        bytes = 0;
        start = index;
      }
      bytes += size;
      index += character.length;
    }
    if (start < fragment.length) parts.push(fragment.slice(start));
  }
  if (parts.length) yield parts.join('');
}

export interface RawBuffer {
  epoch: string;
  key: string;
  markdown: string;
  revision: number;
  recordedAt: number;
}
export const RAW_BUFFER_PREFIX = 'raw-buffer:';
export const rawBufferKey = (epoch: string, key: string) =>
  RAW_BUFFER_PREFIX + canonicalJson([epoch, key]);
function validateRawBuffer(value: unknown): asserts value is RawBuffer {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid raw recovery input.');
  const row = value as RawBuffer;
  if (
    Object.keys(row).sort().join(',') !==
      'epoch,key,markdown,recordedAt,revision' ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 0
  )
    throw new Error('Invalid raw recovery input.');
  encodeCloudBackup({
    library: { items: [], purgedIds: [] },
    device: {
      drafts: [],
      undoDeleteIds: [],
      recovery: [
        {
          id: '00000000-0000-4000-8000-000000000000',
          kind: 'draft',
          draftKey: row.key,
          markdown: row.markdown,
          originEpoch: row.epoch,
          recordedAt: row.recordedAt,
          reason: 'unknown',
        },
      ],
    },
  });
}
export async function readRawBuffers(
  db: ScratchtreeDatabase,
): Promise<RawBuffer[]> {
  const rows = await db.device
    .where('key')
    .startsWith(RAW_BUFFER_PREFIX)
    .toArray();
  return rows.map((row) => {
    validateRawBuffer(row.value);
    if (row.key !== rawBufferKey(row.value.epoch, row.value.key))
      throw new Error('Invalid raw recovery identity.');
    return row.value;
  });
}
/** Device-only emergency input; never writes source into an invalid shared library. */
export async function retainRawBuffers(
  db: ScratchtreeDatabase,
  inputs: import('../platform/workspace').RemoteBuffer[],
  originEpoch: string,
) {
  if (!inputs.length) return;
  await db.transaction('rw', db.device, async () => {
    const current = await readRawBuffers(db),
      next = new Map(
        current.map((row) => [rawBufferKey(row.epoch, row.key), row]),
      );
    for (const input of inputs) {
      const candidate: RawBuffer = {
        epoch: input.originEpoch ?? originEpoch,
        key: input.key,
        markdown: input.markdown,
        revision: input.revision,
        recordedAt: Date.now(),
      };
      validateRawBuffer(candidate);
      const key = rawBufferKey(candidate.epoch, candidate.key),
        old = next.get(key);
      if (!old || old.revision < candidate.revision) next.set(key, candidate);
    }
    if (
      next.size > 40002 ||
      new TextEncoder().encode(JSON.stringify([...next.values()])).length >
        10 * 1024 * 1024
    )
      throw new Error(
        'Raw input recovery capacity reached. Your visible input is retained.',
      );
    for (const row of next.values())
      await db.device.put({
        key: rawBufferKey(row.epoch, row.key),
        value: row,
      });
  });
}
