/** Local diagnostics exclude messages and arbitrary stack text. */
const storageKey = 'scratchtree.preview.client-errors.v1';
const names = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'URIError',
  'EvalError',
  'AggregateError',
]);
const sourceModules = new Set([
  'src/routes/+page.svelte',
  'src/routes/+error.svelte',
  'src/hooks.client.ts',
  'src/lib/components/Workspace.svelte',
  'src/lib/components/MarkdownEditor.svelte',
  'src/lib/components/MarkdownView.svelte',
  'src/lib/workspace/controller.ts',
  'src/lib/editor/source.ts',
  'src/lib/domain/markdown.ts',
  'src/lib/domain/notes.ts',
  'src/lib/domain/search.ts',
  'src/lib/domain/timestamps.ts',
  'src/lib/domain/backup.ts',
  'src/lib/platform/workspace.ts',
  'src/lib/platform/actions.ts',
  'src/lib/platform/lifecycle.ts',
  'src/lib/platform/diagnostics.ts',
]);
const productionModule =
  /^_app\/immutable\/(?:chunks\/[A-Za-z0-9_-]{8}|nodes\/\d+\.[A-Za-z0-9_-]{8}|entry\/(?:app|start|payload)\.[A-Za-z0-9_-]{8})\.js$/;
export interface ClientDiagnostic {
  readonly version: '0.1.0';
  readonly reference: string;
  readonly time: string;
  readonly name: string;
  readonly status: number;
  readonly locations: readonly string[];
}
let current: ClientDiagnostic | undefined;
let writeAttempts = 0;

function property(value: unknown, key: string): unknown {
  try {
    return value !== null && typeof value === 'object'
      ? (value as Record<string, unknown>)[key]
      : undefined;
  } catch {
    return undefined;
  }
}
function modulePath(value: string): string | undefined {
  try {
    const app = new URL(globalThis.location.href);
    const url = new URL(value, app);
    if (url.protocol !== app.protocol || url.host !== app.host) return;
    return url.pathname.replace(/^\//, '');
  } catch {
    return undefined;
  }
}
function loadedModules(): Set<string> {
  const result = new Set<string>();
  try {
    for (const entry of performance
      .getEntriesByType('resource')
      .slice(0, 200)) {
      const path = modulePath(entry.name);
      if (path && productionModule.test(path)) result.add(path);
    }
  } catch {
    /* Missing resource timing means uncertain locations are omitted. */
  }
  return result;
}
function frame(value: string, loaded: Set<string>): string | undefined {
  const match = value.match(
    /((?:https?|tauri):\/\/[^\s()]+|\/?(?:src\/|_app\/immutable\/)[^\s()]+):([1-9]\d{0,6}):([1-9]\d{0,6})\)?$/,
  );
  if (!match) return;
  const path = modulePath(match[1]);
  if (!path || (!sourceModules.has(path) && !loaded.has(path))) return;
  return `${path}:${match[2]}:${match[3]}`;
}
function locations(error: unknown, loaded: Set<string>): string[] {
  const stack = property(error, 'stack');
  if (typeof stack !== 'string') return [];
  const result: string[] = [];
  // The first stack line commonly contains the message; never retain it.
  for (const line of stack.slice(0, 8192).split('\n').slice(1, 31)) {
    const location = frame(line, loaded);
    if (location && !result.includes(location)) result.push(location);
    if (result.length === 5) break;
  }
  return result;
}
function previous(
  value: unknown,
  loaded: Set<string>,
): ClientDiagnostic | undefined {
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  if (
    record.version !== '0.1.0' ||
    typeof record.reference !== 'string' ||
    !/^ST-[A-F0-9]{16}$/.test(record.reference) ||
    typeof record.time !== 'string' ||
    !/^(?:\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z|unavailable)$/.test(
      record.time,
    ) ||
    typeof record.name !== 'string' ||
    !names.has(record.name) ||
    typeof record.status !== 'number' ||
    !Number.isInteger(record.status) ||
    record.status < 400 ||
    record.status > 599 ||
    !Array.isArray(record.locations)
  )
    return;
  return {
    version: '0.1.0',
    reference: record.reference,
    time: record.time,
    name: record.name,
    status: record.status,
    locations: record.locations.slice(0, 5).flatMap((value) => {
      if (typeof value !== 'string' || value.length > 160) return [];
      const safe = frame(value, loaded);
      return safe ? [safe] : [];
    }),
  };
}
function remember(record: ClientDiagnostic, loaded: Set<string>) {
  // Three bounded write attempts per page lifetime, at most three retained records.
  if (writeAttempts >= 3) return;
  writeAttempts++;
  try {
    const storage = globalThis.localStorage;
    let records: ClientDiagnostic[] = [];
    try {
      const text = storage.getItem(storageKey);
      if (text && text.length <= 4096) {
        const values: unknown = JSON.parse(text);
        if (Array.isArray(values))
          records = values.slice(-2).flatMap((value) => {
            const safe = previous(value, loaded);
            return safe ? [safe] : [];
          });
      }
    } catch {
      /* A denied read or malformed old record must not block the view. */
    }
    const text = JSON.stringify([...records, record]);
    if (text.length <= 4096) storage.setItem(storageKey, text);
  } catch {
    /* Unavailable/full diagnostic storage is neutral. */
  }
}
export function captureDiagnostic(
  error: unknown,
  status: number,
): ClientDiagnostic {
  let reference = 'ST-0000000000000000';
  let time = 'unavailable';
  try {
    reference =
      'ST-' +
      Array.from(crypto.getRandomValues(new Uint32Array(2)), (value) =>
        value.toString(16).padStart(8, '0').toUpperCase(),
      ).join('');
  } catch {
    /* The fixed fallback reference carries no user data. */
  }
  try {
    time = new Date().toISOString();
  } catch {
    /* Optional timestamp. */
  }
  const loaded = loadedModules();
  const name = property(error, 'name');
  const record: ClientDiagnostic = {
    version: '0.1.0',
    reference,
    time,
    name: typeof name === 'string' && names.has(name) ? name : 'Error',
    status:
      Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500,
    locations: locations(error, loaded),
  };
  current = record;
  if (JSON.stringify(record).length <= 1024) remember(record, loaded);
  return record;
}
export function diagnosticText(): string {
  return current ? JSON.stringify(current, null, 2) : '';
}
