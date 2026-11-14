import {
  MAX_ENVELOPE,
  MAX_SOURCE,
  type AppError,
  type Draft,
  type Item,
  type WorkspaceSnapshot,
} from '../domain/notes';
import { uuid, validateSnapshot } from '../domain/validation';

type RecoveryFacts = {
  id: string;
  reason: 'rejected' | 'purged' | 'replaced' | 'detached-conflict' | 'unknown';
  originEpoch: string;
  recordedAt: number;
};
/** Portable device-only recovery; each variant retains exactly its own identity and content. */
export type RecoveryRecord = RecoveryFacts &
  (
    | { kind: 'source'; itemId: string; markdown: string }
    | { kind: 'draft'; draftKey: string; markdown: string }
    | { kind: 'library'; snapshot: WorkspaceSnapshot }
  );
export interface BackupV8 {
  format: 'scratchtree';
  version: 8;
  exportedAt: string;
  library: { items: Item[]; purgedIds: string[] };
  device: {
    drafts: Draft[];
    undoDeleteIds: string[];
    recovery: RecoveryRecord[];
  };
}
const bytes = (value: string) => new TextEncoder().encode(value).length;
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const fields = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const invalid = (
  message = 'Invalid library fields or references.',
): AppError => ({ code: 'invalid_backup', message });
const markdown = (value: unknown): value is string =>
  typeof value === 'string' && bytes(value) <= MAX_SOURCE;
const draftKey = (value: unknown): value is string =>
  uuid(value) ||
  value === 'compose' ||
  value === 'compose:trash' ||
  (typeof value === 'string' &&
    value.startsWith('compose:') &&
    uuid(value.slice(8)));
function validRecovery(value: unknown): value is RecoveryRecord {
  if (
    !record(value) ||
    !uuid(value.id) ||
    ![
      'rejected',
      'purged',
      'replaced',
      'detached-conflict',
      'unknown',
    ].includes(value.reason as string) ||
    typeof value.originEpoch !== 'string' ||
    !value.originEpoch.length ||
    bytes(value.originEpoch) > 128 ||
    !Number.isSafeInteger(value.recordedAt) ||
    (value.recordedAt as number) < 0
  )
    return false;
  const common = ['id', 'reason', 'originEpoch', 'recordedAt', 'kind'];
  if (value.kind === 'source')
    return (
      fields(value, [...common, 'itemId', 'markdown']) &&
      uuid(value.itemId) &&
      markdown(value.markdown)
    );
  if (value.kind === 'draft')
    return (
      fields(value, [...common, 'draftKey', 'markdown']) &&
      draftKey(value.draftKey) &&
      markdown(value.markdown)
    );
  if (value.kind === 'library')
    return (
      fields(value, [...common, 'snapshot']) &&
      !('code' in validateSnapshot(value.snapshot))
    );
  return false;
}
export function validateCloudBackup(text: string): BackupV8 | AppError {
  if (bytes(text) > MAX_ENVELOPE)
    return invalid('Backup exceeds the 10 MiB capacity.');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return invalid('Backup must be valid JSON.');
  }
  if (
    !record(value) ||
    !fields(value, ['format', 'version', 'exportedAt', 'library', 'device']) ||
    value.format !== 'scratchtree' ||
    value.version !== 8 ||
    typeof value.exportedAt !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.exportedAt) ||
    !Number.isFinite(Date.parse(value.exportedAt)) ||
    new Date(value.exportedAt).toISOString() !== value.exportedAt
  )
    return invalid();
  const library = value.library,
    device = value.device;
  if (
    !record(library) ||
    !fields(library, ['items', 'purgedIds']) ||
    !record(device) ||
    !fields(device, ['drafts', 'undoDeleteIds', 'recovery']) ||
    !Array.isArray(library.purgedIds) ||
    !Array.isArray(device.recovery)
  )
    return invalid();
  const snapshot = validateSnapshot({
    items: library.items,
    drafts: device.drafts,
    undoDeleteIds: device.undoDeleteIds,
  });
  if ('code' in snapshot) return snapshot;
  const itemIds = new Set(snapshot.items.map((x) => x.id.toLowerCase()));
  const purged = new Set<string>();
  for (const id of library.purgedIds) {
    if (
      !uuid(id) ||
      itemIds.has(id.toLowerCase()) ||
      purged.has(id.toLowerCase())
    )
      return invalid();
    purged.add(id.toLowerCase());
  }
  const recovery = new Set<string>();
  for (const entry of device.recovery) {
    if (!validRecovery(entry) || recovery.has(entry.id.toLowerCase()))
      return invalid();
    recovery.add(entry.id.toLowerCase());
  }
  if (bytes(JSON.stringify(value)) > MAX_ENVELOPE)
    return invalid(
      'Backup exceeds the 10 MiB capacity. The original is retained.',
    );
  return value as unknown as BackupV8;
}
export function encodeCloudBackup(
  backup: Omit<BackupV8, 'format' | 'version' | 'exportedAt'>,
  exportedAt = new Date().toISOString(),
): string {
  const text = JSON.stringify({
    ...backup,
    format: 'scratchtree',
    version: 8,
    exportedAt,
  });
  const checked = validateCloudBackup(text);
  if ('code' in checked) throw new Error(checked.message);
  return text;
}
