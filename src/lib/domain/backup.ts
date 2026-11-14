import {
  MAX_SOURCE,
  MAX_ENVELOPE,
  COLORS,
  type BackupV7,
  type WorkspaceSnapshot,
  type AppError,
  type Item,
} from './notes';
import { hierarchyIndex, composeOwner, scopeIndex } from './hierarchy';
const bytes = (s: string) => new TextEncoder().encode(s).length;
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const fields = (v: Record<string, unknown>, keys: string[]) =>
  Object.keys(v).length === keys.length &&
  keys.every((k) => Object.hasOwn(v, k));
const integer = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
export const uuid = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const invalid = (
  message = 'Invalid library fields or references.',
): AppError => ({ code: 'invalid_backup', message });
export function validateBackup(text: string): BackupV7 | AppError {
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
    !fields(b, ['format', 'version', 'exportedAt', 'library']) ||
    b.format !== 'scratchtree-alpha' ||
    b.version !== 7 ||
    typeof b.exportedAt !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(b.exportedAt) ||
    !Number.isFinite(Date.parse(b.exportedAt)) ||
    new Date(b.exportedAt).toISOString() !== b.exportedAt
  )
    return invalid();
  const s = b.library;
  if (
    !record(s) ||
    !fields(s, ['items', 'drafts', 'undoDeleteIds']) ||
    !Array.isArray(s.items) ||
    !Array.isArray(s.drafts) ||
    s.items.length > 20000 ||
    s.drafts.length > 40002
  )
    return invalid();
  const ids = new Set<string>();
  for (const x of s.items) {
    if (
      !record(x) ||
      !fields(x, [
        'id',
        'parentId',
        'kind',
        'markdown',
        'done',
        'color',
        'position',
        'createdAt',
        'updatedAt',
        'deletedAt',
        'restoreParentId',
        'restoreIndex',
      ]) ||
      !uuid(x.id) ||
      ids.has(x.id.toLowerCase()) ||
      (x.parentId !== null && !uuid(x.parentId)) ||
      !['note', 'tree'].includes(x.kind as string) ||
      typeof x.markdown !== 'string' ||
      bytes(x.markdown) > MAX_SOURCE ||
      typeof x.done !== 'boolean' ||
      (x.color !== null &&
        !COLORS.includes(x.color as (typeof COLORS)[number])) ||
      !integer(x.position) ||
      !integer(x.createdAt) ||
      !integer(x.updatedAt) ||
      x.updatedAt < x.createdAt ||
      (x.deletedAt !== null && !integer(x.deletedAt)) ||
      (x.restoreParentId !== null && !uuid(x.restoreParentId)) ||
      (x.restoreIndex !== null && !integer(x.restoreIndex))
    )
      return invalid();
    ids.add(x.id.toLowerCase());
  }
  const items = s.items as Item[];
  let index: Map<string, Item>;
  try {
    index = hierarchyIndex(items);
  } catch {
    return invalid();
  }
  const scopes = scopeIndex(items);
  const ranks = new Set<string>();
  for (const x of items) {
    if (
      x.deletedAt !== null
        ? x.parentId !== null && scopes.get(x.parentId) !== 'trash'
        : x.restoreParentId !== null || x.restoreIndex !== null
    )
      return invalid();
    if (
      x.restoreParentId !== null &&
      (x.restoreIndex === null || !index.has(x.restoreParentId))
    )
      return invalid();
    const rank = JSON.stringify([
      x.parentId,
      x.parentId === null ? (x.deletedAt !== null ? 'trash' : 'live') : null,
      x.position,
    ]);
    if (ranks.has(rank)) return invalid();
    ranks.add(rank);
  }
  const keys = new Set<string>();
  for (const d of s.drafts) {
    if (
      !record(d) ||
      !fields(d, ['key', 'markdown', 'revision', 'updatedAt']) ||
      typeof d.key !== 'string' ||
      keys.has(d.key.toLowerCase()) ||
      typeof d.markdown !== 'string' ||
      bytes(d.markdown) > MAX_SOURCE ||
      !integer(d.revision) ||
      !integer(d.updatedAt)
    )
      return invalid();
    const owner = composeOwner(d.key);
    if (
      owner
        ? owner.ownerId !== null && !index.has(owner.ownerId)
        : !uuid(d.key) || !index.has(d.key)
    )
      return invalid();
    keys.add(d.key.toLowerCase());
  }
  if (
    !Array.isArray(s.undoDeleteIds) ||
    s.undoDeleteIds.length > items.length ||
    new Set(s.undoDeleteIds).size !== s.undoDeleteIds.length ||
    s.undoDeleteIds.some((id) => !uuid(id) || index.get(id)?.deletedAt == null)
  )
    return invalid();
  if (bytes(JSON.stringify(b)) > MAX_ENVELOPE)
    return invalid(
      'Backup exceeds the 10 MiB capacity. The original is retained.',
    );
  return b as unknown as BackupV7;
}
export function encodeBackup(library: WorkspaceSnapshot): string {
  return JSON.stringify({
    format: 'scratchtree-alpha',
    version: 7,
    exportedAt: new Date().toISOString(),
    library,
  });
}
