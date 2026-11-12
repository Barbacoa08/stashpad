import {
  MAX_SOURCE,
  MAX_ENVELOPE,
  type BackupV3,
  type V3Workspace,
  type AppError,
} from './notes';
import { composeOwner, hierarchyIndex, stashName } from './legacy-hierarchy';
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
export function validateBackup(text: string): BackupV3 | AppError {
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
    (b.version !== 1 && b.version !== 2 && b.version !== 3) ||
    typeof b.exportedAt !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(b.exportedAt) ||
    !Number.isFinite(Date.parse(b.exportedAt)) ||
    new Date(b.exportedAt).toISOString() !== b.exportedAt
  )
    return invalid(
      'Expected a complete version 1, 2, or 3 Stashpad alpha backup with a UTC timestamp.',
    );
  const s = b.workspace;
  if (
    !record(s) ||
    !fields(
      s,
      b.version === 1
        ? ['notes', 'drafts', 'undoDeleteId']
        : ['stashes', 'notes', 'drafts', 'undoDeleteId'],
    ) ||
    !Array.isArray(s.notes) ||
    !Array.isArray(s.drafts) ||
    s.notes.length > 10000 ||
    s.drafts.length > (b.version === 1 ? 10001 : 20001)
  )
    return invalid('Invalid workspace fields or capacity.');
  if (b.version === 1) {
    if (
      s.notes.some(
        (n) =>
          !record(n) ||
          !fields(n, ['id', 'markdown', 'createdAt', 'updatedAt', 'deletedAt']),
      )
    )
      return invalid('Invalid legacy note.');
    s.stashes = [];
    s.notes = s.notes.map((n) => ({
      ...(n as Record<string, unknown>),
      stashId: null,
    }));
  }
  if (b.version !== 3) {
    if (
      (s.notes as unknown[]).some(
        (n) =>
          !record(n) ||
          !fields(n, [
            'id',
            'stashId',
            'markdown',
            'createdAt',
            'updatedAt',
            'deletedAt',
          ]),
      )
    )
      return invalid('Invalid legacy note fields.');
    s.notes = (s.notes as unknown[]).map((n) => ({
      ...(n as Record<string, unknown>),
      done: false,
    }));
  }
  if (!Array.isArray(s.stashes) || s.stashes.length > 10000)
    return invalid('Invalid stash capacity.');
  const stashes = new Map<string, Record<string, unknown>>();
  for (const stash of s.stashes) {
    if (
      !record(stash) ||
      !fields(stash, ['id', 'name', 'parentId', 'createdAt', 'updatedAt']) ||
      !uuid(stash.id) ||
      stashes.has(stash.id.toLowerCase()) ||
      typeof stash.name !== 'string' ||
      (stash.parentId !== null && !uuid(stash.parentId)) ||
      !integer(stash.createdAt) ||
      !integer(stash.updatedAt) ||
      stash.updatedAt < stash.createdAt
    )
      return invalid('Invalid stash.');
    try {
      if (stashName(stash.name) !== stash.name)
        return invalid('Invalid stash name.');
    } catch {
      return invalid('Invalid stash name.');
    }
    stashes.set(stash.id.toLowerCase(), stash);
  }
  try {
    hierarchyIndex(s.stashes as unknown as V3Workspace['stashes']);
  } catch {
    return invalid('Invalid stash hierarchy.');
  }
  const notes = new Map<string, Record<string, unknown>>();
  for (const n of s.notes as unknown[]) {
    if (
      !record(n) ||
      !fields(n, [
        'id',
        'stashId',
        'done',
        'markdown',
        'createdAt',
        'updatedAt',
        'deletedAt',
      ]) ||
      typeof n.done !== 'boolean' ||
      !uuid(n.id) ||
      notes.has(n.id.toLowerCase()) ||
      stashes.has(n.id.toLowerCase()) ||
      (n.stashId !== null &&
        (!uuid(n.stashId) ||
          stashes.get(n.stashId.toLowerCase())?.id !== n.stashId)) ||
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
      (composeOwner(d.key) === null && !uuid(d.key)) ||
      keys.has(d.key.toLowerCase()) ||
      typeof d.markdown !== 'string' ||
      bytes(d.markdown) > MAX_SOURCE ||
      !integer(d.revision) ||
      !integer(d.updatedAt) ||
      (composeOwner(d.key) === null &&
        (notes.get(d.key.toLowerCase())?.id !== d.key ||
          notes.get(d.key.toLowerCase())?.deletedAt !== null))
    )
      return invalid('Invalid or dangling draft.');
    const owner = composeOwner(d.key as string);
    if (
      owner?.stashId !== undefined &&
      owner.stashId !== null &&
      stashes.get(owner.stashId.toLowerCase())?.id !== owner.stashId
    )
      return invalid('Invalid compose destination.');
    keys.add((d.key as string).toLowerCase());
  }
  if (
    s.undoDeleteId !== null &&
    (!uuid(s.undoDeleteId) ||
      notes.get(s.undoDeleteId.toLowerCase())?.id !== s.undoDeleteId ||
      notes.get(s.undoDeleteId.toLowerCase())?.deletedAt === null)
  )
    return invalid('Invalid Undo delete target.');
  const normalized = { ...b, version: 3 } as unknown as BackupV3;
  if (bytes(JSON.stringify(normalized)) > MAX_ENVELOPE)
    return invalid(
      'Converted backup exceeds the 10 MiB capacity. The original backup is retained; recover using a compatible app or a verified smaller copy.',
    );
  return normalized;
}
export function encodeBackup(workspace: V3Workspace): string {
  return JSON.stringify({
    format: 'stashpad-alpha',
    version: 3,
    exportedAt: new Date().toISOString(),
    workspace,
  });
}
