import {
  MAX_SOURCE,
  MAX_ENVELOPE,
  type BackupV1,
  type WorkspaceSnapshot,
  type AppError,
} from './notes';
const bytes = (s: string) => new TextEncoder().encode(s).length;
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const fields = (o: Record<string, unknown>, keys: string[]) =>
  Object.keys(o).length === keys.length &&
  keys.every((k) => Object.hasOwn(o, k));
const integer = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const uuid = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export function validateBackup(text: string): BackupV1 | AppError {
  const invalid = (message: string): AppError => ({
    code: 'invalid_backup',
    message,
  });
  if (bytes(text) > MAX_ENVELOPE)
    return invalid('Backup exceeds the 10 MiB capacity.');
  let b: unknown;
  try {
    b = JSON.parse(text);
  } catch {
    return invalid('Backup must be valid JSON.');
  }
  if (
    !record(b) ||
    !fields(b, ['format', 'version', 'exportedAt', 'workspace']) ||
    b.format !== 'stashpad-alpha' ||
    b.version !== 1 ||
    typeof b.exportedAt !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(b.exportedAt) ||
    !Number.isFinite(Date.parse(b.exportedAt)) ||
    new Date(b.exportedAt).toISOString() !== b.exportedAt
  )
    return invalid(
      'Expected a complete version 1 Stashpad alpha backup with a UTC timestamp.',
    );
  const s = b.workspace;
  if (
    !record(s) ||
    !fields(s, ['notes', 'drafts', 'undoDeleteId']) ||
    !Array.isArray(s.notes) ||
    !Array.isArray(s.drafts) ||
    s.notes.length > 10000 ||
    s.drafts.length > 10001
  )
    return invalid('Invalid workspace fields or capacity.');
  const notes = new Map<string, Record<string, unknown>>();
  for (const n of s.notes) {
    if (
      !record(n) ||
      !fields(n, ['id', 'markdown', 'createdAt', 'updatedAt', 'deletedAt']) ||
      !uuid(n.id) ||
      notes.has(n.id.toLowerCase()) ||
      typeof n.markdown !== 'string' ||
      bytes(n.markdown) > MAX_SOURCE ||
      !integer(n.createdAt) ||
      !integer(n.updatedAt) ||
      n.updatedAt < n.createdAt ||
      (n.deletedAt !== null && !integer(n.deletedAt))
    )
      return invalid('Invalid or duplicate note.');
    notes.set(n.id.toLowerCase(), n);
  }
  const keys = new Set<string>();
  for (const d of s.drafts) {
    if (
      !record(d) ||
      !fields(d, ['key', 'markdown', 'revision', 'updatedAt']) ||
      typeof d.key !== 'string' ||
      (d.key !== 'compose' && !uuid(d.key)) ||
      keys.has(d.key.toLowerCase()) ||
      typeof d.markdown !== 'string' ||
      bytes(d.markdown) > MAX_SOURCE ||
      !integer(d.revision) ||
      !integer(d.updatedAt) ||
      (d.key !== 'compose' &&
        (notes.get(d.key.toLowerCase())?.id !== d.key ||
          notes.get(d.key.toLowerCase())?.deletedAt !== null))
    )
      return invalid('Invalid or dangling draft.');
    keys.add(d.key.toLowerCase());
  }
  if (
    s.undoDeleteId !== null &&
    (!uuid(s.undoDeleteId) ||
      notes.get(s.undoDeleteId.toLowerCase())?.id !== s.undoDeleteId ||
      notes.get(s.undoDeleteId.toLowerCase())?.deletedAt === null)
  )
    return invalid('Invalid Undo delete target.');
  return b as unknown as BackupV1;
}
export function encodeBackup(workspace: WorkspaceSnapshot): string {
  return JSON.stringify({
    format: 'stashpad-alpha',
    version: 1,
    exportedAt: new Date().toISOString(),
    workspace,
  });
}
