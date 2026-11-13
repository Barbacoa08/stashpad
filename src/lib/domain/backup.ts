import {
  MAX_SOURCE,
  MAX_ENVELOPE,
  COLORS,
  type BackupV6,
  type V5Workspace,
  type V3Workspace,
  type WorkspaceSnapshot,
  type AppError,
  type Item,
} from './notes';
import { validateBackup as validateLegacy } from './legacy-backup';
import { hierarchyIndex, composeOwner, scopeIndex } from './hierarchy';
import { validateV4Backup } from './v4-backup';
import { validateV5Backup } from './v5-backup';
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
  message = 'Invalid workspace fields or references.',
): AppError => ({ code: 'invalid_backup', message });
const compare = (
  a: { createdAt: number; id: string },
  b: { createdAt: number; id: string },
) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
export function convertLegacy(s: V3Workspace): WorkspaceSnapshot {
  const items: Item[] = [
    ...s.stashes.map((x) => ({
      id: x.id,
      parentId: x.parentId,
      kind: 'stash' as const,
      markdown: x.name,
      done: false,
      color: null,
      position: 0,
      createdAt: x.createdAt,
      updatedAt: x.updatedAt,
      deletedAt: null,
      restoreParentId: null,
      restoreIndex: null,
    })),
    ...s.notes.map((x) => ({
      id: x.id,
      parentId: x.deletedAt === null ? x.stashId : null,
      kind: 'note' as const,
      markdown: x.markdown,
      done: x.done,
      color: null,
      position: 0,
      createdAt: x.createdAt,
      updatedAt: x.updatedAt,
      deletedAt: x.deletedAt,
      restoreParentId: x.deletedAt === null ? null : x.stashId,
      restoreIndex: x.deletedAt === null ? null : 0,
    })),
  ];
  const groups = new Map<string, Item[]>();
  for (const x of items) {
    const key = x.deletedAt !== null ? 'trash' : (x.parentId ?? 'home');
    const group = groups.get(key) ?? [];
    group.push(x);
    groups.set(key, group);
  }
  for (const group of groups.values())
    group.sort(compare).forEach((x, i) => (x.position = i));
  for (const old of s.notes.filter((x) => x.deletedAt !== null))
    items.find((x) => x.id === old.id)!.restoreIndex = items.filter(
      (x) =>
        x.deletedAt === null &&
        x.parentId === old.stashId &&
        compare(x, old) < 0,
    ).length;
  return {
    items,
    drafts: s.drafts,
    undoDeleteIds: s.undoDeleteId === null ? [] : [s.undoDeleteId],
  };
}
export function validateBackup(text: string): BackupV6 | AppError {
  if (bytes(text) > MAX_ENVELOPE)
    return invalid('Backup exceeds the 10 MiB capacity.');
  let b: unknown;
  try {
    b = JSON.parse(text);
  } catch {
    return invalid('Backup must be valid JSON.');
  }
  if (record(b) && (b.version === 4 || b.version === 5)) {
    const old =
      b.version === 4 ? validateV4Backup(text) : validateV5Backup(text);
    if ('code' in old) return old;
    b = { ...old, version: 6, workspace: convertV5(old.workspace) };
  } else if (record(b) && b.version !== 6) {
    const old = validateLegacy(text);
    if ('code' in old) return old;
    b = { ...old, version: 6, workspace: convertLegacy(old.workspace) };
  }
  if (
    !record(b) ||
    !fields(b, ['format', 'version', 'exportedAt', 'workspace']) ||
    b.format !== 'stashpad-alpha' ||
    b.version !== 6 ||
    typeof b.exportedAt !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(b.exportedAt) ||
    !Number.isFinite(Date.parse(b.exportedAt)) ||
    new Date(b.exportedAt).toISOString() !== b.exportedAt
  )
    return invalid();
  const s = b.workspace;
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
      !['note', 'stash'].includes(x.kind as string) ||
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
        ? owner.stashId !== null && !index.has(owner.stashId)
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
      'Converted backup exceeds the 10 MiB capacity. The original is retained.',
    );
  return b as unknown as BackupV6;
}
export function encodeBackup(workspace: WorkspaceSnapshot): string {
  return JSON.stringify({
    format: 'stashpad-alpha',
    version: 6,
    exportedAt: new Date().toISOString(),
    workspace,
  });
}

export function convertV5(s: V5Workspace): WorkspaceSnapshot {
  return {
    items: s.items,
    drafts: s.drafts,
    undoDeleteIds: s.undoDeleteId === null ? [] : [s.undoDeleteId],
  };
}
