import type { Placement } from './types';
import type { BackupV8 } from './backup';
import type { ColorToken, Location, Item } from '../domain/notes';
import type {
  CaptureItem,
  CreateChildTree,
  DraftAck,
  MoveItems,
  PurgeItem,
  ReorderItem,
  TransitionLocation,
  UndoDeleteRequest,
  StructuralItem,
} from '../platform/workspace';
/** Captured caller input, never retargeted from newer selection or navigation. */
export type IntentCommand =
  | { kind: 'correctivePurge'; epoch: string; ids: string[] }
  | { kind: 'saveItemSource'; id: string; markdown: string; draft: DraftAck }
  | { kind: 'captureItem'; request: CaptureItem }
  | { kind: 'createChildTree'; request: CreateChildTree }
  | { kind: 'promoteItem'; id: string }
  | { kind: 'deleteItem'; id: string; leave?: Location }
  | { kind: 'purgeItem'; request: PurgeItem }
  | { kind: 'transitionLocation'; request: TransitionLocation }
  | { kind: 'moveItems'; request: MoveItems }
  | { kind: 'restoreItem'; id: string }
  | { kind: 'undoDelete'; request: UndoDeleteRequest }
  | { kind: 'setItemDone'; id: string; done: boolean }
  | { kind: 'setItemColor'; id: string; color: ColorToken | null }
  | { kind: 'reorderItem'; request: ReorderItem }
  | {
      kind: 'replaceLibrary';
      previousEpoch: string;
      newEpoch: string;
      backup: BackupV8;
    };
/** Only actual operation-owned changes are retained; unchanged Markdown is absent. */
export type ItemFieldDeltas = {
  [
    K in Exclude<keyof Item, 'id' | 'markdown' | 'createdAt' | keyof Placement>
  ]?: {
    before: Item[K];
    after: Item[K];
  };
};
interface OutcomeIdentity {
  id: string;
  /** Complete projected Item digest for auditing, not universal outcome equality. */
  digest: string;
}
export type ItemOutcome =
  | (OutcomeIdentity & {
      kind: 'create';
      structural: StructuralItem;
      item: Item;
    })
  | (OutcomeIdentity & {
      kind: 'update';
      structural: StructuralItem;
      fields: ItemFieldDeltas;
      /** One captured atomic parent/deletion/restore value, matching the wire write. */
      placement?: { before: Placement; after: Placement };
      /** Exact source remains in the captured command and device recovery. */
      source?: { beforeDigest: string; afterDigest: string };
    })
  | (OutcomeIdentity & {
      kind: 'purge';
      structural: null;
      before: StructuralItem;
    });
export interface ExpectedOutcome {
  items: ItemOutcome[];
  purgedIds: string[];
  orders: { group: Location; ids: string[] }[];
}
export interface PendingIntent {
  sequence: number;
  id: string;
  epoch: string;
  /** SHA-256 of {epoch, command}; stable while an unacknowledged local retry exists. */
  fingerprint: string;
  /** SHA-256 of {command, expected}; the replicated witness has this exact digest. */
  digest: string;
  /** Captured once before the preservation barrier; retry never refreshes it. */
  recordedAt: number;
  command: IntentCommand;
  expected: ExpectedOutcome;
  /** Local atomic application only; this never means server acceptance. */
  localApplied: boolean;
}
export interface IntentWitness {
  id: string;
  epoch: string;
  digest: string;
  recordedAt: number;
}
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry) =>
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.keys(entry)
            .sort()
            .map((key) => [key, entry[key]]),
        )
      : entry,
  );
}
export async function digest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalJson(value)),
  );
  return Array.from(new Uint8Array(bytes), (x) =>
    x.toString(16).padStart(2, '0'),
  ).join('');
}

/** Current-only local journal order, independent of wall clocks and UUID spelling. */
export function orderedIntents(rows: PendingIntent[]): PendingIntent[] {
  const seen = new Set<number>();
  for (const row of rows) {
    if (
      !Number.isSafeInteger(row.sequence) ||
      row.sequence < 1 ||
      seen.has(row.sequence)
    )
      throw new Error('Invalid pending journal sequence.');
    seen.add(row.sequence);
  }
  return [...rows].sort((a, b) => a.sequence - b.sequence);
}
/** Allocated atomically with pending durability; exact retries keep their sequence. */
export async function preservePendingIntent(
  db: import('./database').ScratchtreeDatabase,
  intent: PendingIntent,
): Promise<PendingIntent> {
  return db.transaction('rw', [db.pending, db.device], async () => {
    const rows = await db.pending.toArray(),
      existing = rows.find((row) => row.id === intent.id);
    orderedIntents(rows);
    const stored = (await db.device.get('intent-sequence'))?.value;
    if (
      stored !== undefined &&
      (!Number.isSafeInteger(stored) || (stored as number) < 0)
    )
      throw new Error('Invalid pending journal counter.');
    if (existing) {
      if (
        existing.fingerprint !== intent.fingerprint ||
        existing.digest !== intent.digest ||
        existing.epoch !== intent.epoch ||
        existing.recordedAt !== intent.recordedAt ||
        canonicalJson(existing.command) !== canonicalJson(intent.command) ||
        canonicalJson(existing.expected) !== canonicalJson(intent.expected)
      )
        throw new Error('Pending intent identity changed.');
      intent.sequence = existing.sequence;
      intent.localApplied = existing.localApplied || intent.localApplied;
    } else {
      if (
        stored !== undefined &&
        (!Number.isSafeInteger(stored) || (stored as number) < 0)
      )
        throw new Error('Invalid pending journal counter.');
      intent.sequence =
        Math.max(
          (stored as number | undefined) ?? 0,
          ...rows.map((row) => row.sequence),
        ) + 1;
      if (!Number.isSafeInteger(intent.sequence))
        throw new Error('Pending journal sequence exhausted.');
    }
    const next = [...rows.filter((row) => row.id !== intent.id), intent];
    const receipts = await db.device
      .where('key')
      .startsWith('resolved-witness:')
      .count();
    if (
      next.length + receipts > 1000 ||
      new TextEncoder().encode(JSON.stringify(next)).length > 10 * 1024 * 1024
    )
      throw new Error(
        'Pending recovery capacity reached. Export recovery before continuing.',
      );
    await db.pending.put(intent);
    const source = sourceOfIntent(intent);
    if (source) {
      const key = sourceHeadKey(intent.epoch, source.id),
        old = (await db.device.get(key))?.value as LatestSourceHead | undefined;
      if (old) {
        validateJournal(
          {
            sequence: Math.max(
              intent.sequence,
              (stored as number | undefined) ?? 0,
              ...rows.map((row) => row.sequence),
            ),
            sources: [old],
          },
          next,
          false,
        );
        if (sourceHeadKey(old.epoch, old.itemId) !== key)
          throw new Error('Invalid latest source key.');
      }
      const head: LatestSourceHead = {
        epoch: intent.epoch,
        itemId: source.id,
        sequence: intent.sequence,
        intentId: intent.id,
        digest: intent.digest,
      };
      if (
        old &&
        old.sequence === head.sequence &&
        canonicalJson(old) !== canonicalJson(head)
      )
        throw new Error('Latest source identity changed.');
      if (!old || old.sequence < head.sequence)
        await db.device.put({ key, value: head });
    }
    await db.device.put({
      key: 'intent-sequence',
      value: Math.max(
        intent.sequence,
        (stored as number | undefined) ?? 0,
        ...rows.map((row) => row.sequence),
      ),
    });
    return intent;
  });
}

export function sourceOfIntent(
  intent: PendingIntent,
): { id: string; markdown: string } | null {
  const command = intent.command;
  return command.kind === 'saveItemSource'
    ? { id: command.id, markdown: command.markdown }
    : command.kind === 'captureItem'
      ? { id: command.request.id, markdown: command.request.markdown }
      : command.kind === 'createChildTree'
        ? { id: command.request.id, markdown: 'Untitled' }
        : null;
}
export interface LatestSourceHead {
  epoch: string;
  itemId: string;
  sequence: number;
  intentId: string;
  digest: string;
}
export interface JournalMetadata {
  sequence: number;
  sources: LatestSourceHead[];
}
export const sourceHeadKey = (epoch: string, itemId: string) =>
  'source-head:' + canonicalJson([epoch, itemId]);
function validateJournal(
  value: unknown,
  pending: PendingIntent[],
  requirePending: boolean,
): asserts value is JournalMetadata {
  const object = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v);
  const uuid = (v: unknown) =>
    typeof v === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
  if (
    !object(value) ||
    Object.keys(value).sort().join(',') !== 'sequence,sources' ||
    !Number.isSafeInteger(value.sequence) ||
    (value.sequence as number) < 0 ||
    !Array.isArray(value.sources) ||
    value.sources.length > 1000
  )
    throw new Error('Invalid journal metadata.');
  orderedIntents(pending);
  if (
    pending.length > 1000 ||
    new TextEncoder().encode(JSON.stringify(pending)).length > 10 * 1024 * 1024
  )
    throw new Error('Pending transfer capacity exceeded.');
  const keys = new Set<string>(),
    sequences = new Set<number>(),
    identities = new Set<string>();
  for (const entry of value.sources) {
    if (
      !object(entry) ||
      Object.keys(entry).sort().join(',') !==
        'digest,epoch,intentId,itemId,sequence' ||
      typeof entry.epoch !== 'string' ||
      !entry.epoch.length ||
      new TextEncoder().encode(entry.epoch).length > 128 ||
      !uuid(entry.itemId) ||
      !uuid(entry.intentId) ||
      !Number.isSafeInteger(entry.sequence) ||
      (entry.sequence as number) < 1 ||
      (entry.sequence as number) > (value.sequence as number) ||
      typeof entry.digest !== 'string' ||
      !/^[0-9a-f]{64}$/.test(entry.digest)
    )
      throw new Error('Invalid latest source identity.');
    const head = entry as unknown as LatestSourceHead,
      key = sourceHeadKey(head.epoch, head.itemId.toLowerCase());
    if (
      keys.has(key) ||
      sequences.has(head.sequence) ||
      identities.has(head.intentId.toLowerCase())
    )
      throw new Error('Duplicate latest source identity.');
    keys.add(key);
    sequences.add(head.sequence);
    identities.add(head.intentId.toLowerCase());
    const related = pending.filter(
      (intent) =>
        intent.id === head.intentId || intent.sequence === head.sequence,
    );
    for (const intent of related)
      if (
        intent.id !== head.intentId ||
        intent.sequence !== head.sequence ||
        intent.epoch !== head.epoch ||
        intent.digest !== head.digest ||
        sourceOfIntent(intent)?.id !== head.itemId
      )
        throw new Error(
          'Journal source identity differs from its pending intent.',
        );
    if (requirePending) {
      const owned = pending.filter(
        (intent) =>
          intent.epoch === head.epoch &&
          sourceOfIntent(intent)?.id === head.itemId,
      );
      if (
        !owned.length ||
        owned.some((intent) => intent.sequence > head.sequence)
      )
        throw new Error('Unowned or stale latest source identity.');
    }
  }
  if (
    requirePending &&
    pending.some((intent) => {
      const source = sourceOfIntent(intent);
      return (
        source &&
        !(value.sources as LatestSourceHead[]).some(
          (head: LatestSourceHead) =>
            head.epoch === intent.epoch && head.itemId === source.id,
        )
      );
    })
  )
    throw new Error('Pending source lacks its ordering metadata.');
  if (pending.some((intent) => intent.sequence > (value.sequence as number)))
    throw new Error('Journal counter is behind pending work.');
}
/** Whitelist only ordering metadata; no auth, preferences, or source text. */
export async function readJournalMetadata(
  db: import('./database').ScratchtreeDatabase,
): Promise<JournalMetadata> {
  return db.transaction('r', [db.device, db.pending], async () => {
    const pending = await db.pending.toArray(),
      rows = await db.device.where('key').startsWith('source-head:').toArray();
    const result = {
      sequence: (await db.device.get('intent-sequence'))?.value ?? 0,
      sources: rows.map((row) => row.value),
    };
    validateJournal(result, pending, true);
    for (let i = 0; i < rows.length; i++)
      if (
        rows[i].key !==
        sourceHeadKey(result.sources[i].epoch, result.sources[i].itemId)
      )
        throw new Error('Journal key differs from its source identity.');
    return result;
  });
}
/** Install pending rows first, then merge this protected transfer in the same transaction. */
export async function installJournalMetadata(
  db: import('./database').ScratchtreeDatabase,
  metadata: JournalMetadata,
) {
  const captured = structuredClone(metadata);
  validateJournal(captured, [], false);
  await db.transaction('rw', [db.device, db.pending], async () => {
    const currentRows = await db.device
        .where('key')
        .startsWith('source-head:')
        .toArray(),
      stored = (await db.device.get('intent-sequence'))?.value ?? 0,
      pending = await db.pending.toArray();
    if (!Number.isSafeInteger(stored) || (stored as number) < 0)
      throw new Error('Invalid journal counter.');
    const heads = new Map<string, LatestSourceHead>();
    for (const row of currentRows) {
      const head = row.value as LatestSourceHead;
      heads.set(row.key, head);
    }
    for (const head of captured.sources) {
      const key = sourceHeadKey(head.epoch, head.itemId),
        old = heads.get(key);
      if (
        old &&
        old.sequence === head.sequence &&
        canonicalJson(old) !== canonicalJson(head)
      )
        throw new Error('Conflicting latest source identity.');
      if (!old || old.sequence < head.sequence) heads.set(key, head);
    }
    const merged = {
      sequence: Math.max(
        stored as number,
        captured.sequence,
        ...pending.map((intent) => intent.sequence),
      ),
      sources: [...heads.values()],
    };
    validateJournal(merged, pending, true);
    for (const [key, head] of heads) {
      if (key !== sourceHeadKey(head.epoch, head.itemId))
        throw new Error('Invalid journal source key.');
      await db.device.put({ key, value: head });
    }
    await db.device.put({ key: 'intent-sequence', value: merged.sequence });
  });
}
