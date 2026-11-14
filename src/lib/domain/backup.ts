import {
  MAX_ENVELOPE,
  type BackupV7,
  type WorkspaceSnapshot,
  type AppError,
} from './notes';
import { validateSnapshot } from './validation';
export { uuid } from './validation';
const bytes = (s: string) => new TextEncoder().encode(s).length;
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const fields = (v: Record<string, unknown>, keys: string[]) =>
  Object.keys(v).length === keys.length &&
  keys.every((k) => Object.hasOwn(v, k));
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
  const checked = validateSnapshot(b.library);
  if ('code' in checked) return checked;
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
