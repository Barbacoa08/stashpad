import { afterEach, beforeEach, expect, it, vi } from 'vitest';

let stored: string | null;
let writes: number;
afterEach(() => vi.unstubAllGlobals());
beforeEach(() => {
  vi.resetModules();
  stored = null;
  writes = 0;
  vi.stubGlobal('location', {
    origin: 'http://localhost',
    href: 'http://localhost/',
  });
  vi.stubGlobal('performance', {
    now: () => 0,
    getEntriesByType: () => [
      { name: 'http://localhost/_app/immutable/chunks/DclECHGd.js' },
    ],
  });
  vi.stubGlobal('localStorage', {
    getItem: () => stored,
    setItem: (_key: string, value: string) => {
      writes++;
      stored = value;
    },
  });
});

it('retains useful allowlisted locations while excluding source-bearing messages, URLs, and paths', async () => {
  const { captureDiagnostic, diagnosticText } =
    await import('../../src/lib/platform/diagnostics');
  const record = captureDiagnostic(
    {
      name: 'TypeError',
      message:
        'PRIVATE_NOTE_TEXT query secret 11111111-1111-4111-8111-111111111111',
      stack: [
        'TypeError: PRIVATE_NOTE_TEXT /Users/private/notes',
        '    at PRIVATE_FUNCTION (http://localhost/src/lib/components/Workspace.svelte?query=PRIVATE_QUERY#secret:40:5)',
        'PRIVATE_FUNCTION@http://localhost/_app/immutable/chunks/DclECHGd.js?note=PRIVATE_QUERY:12:9',
        '    at /Users/private/PRIVATE_PATH.ts:3:4',
        '    at http://localhost/src/lib/PRIVATE_SOURCE.ts:3:4',
        '    at http://localhost/_app/immutable/chunks/PRIVATE1.js:3:4',
        '    at https://other.invalid/_app/immutable/chunks/DclECHGd.js:3:4',
      ].join('\n'),
    },
    500,
  );
  expect(record).toMatchObject({
    version: '0.1.0',
    name: 'TypeError',
    status: 500,
    locations: [
      'src/lib/components/Workspace.svelte:40:5',
      '_app/immutable/chunks/DclECHGd.js:12:9',
    ],
  });
  expect(record.reference).toMatch(/^ST-[A-F0-9]{16}$/);
  expect(record.time).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  expect(diagnosticText()).toContain(record.reference);
  for (const secret of [
    'PRIVATE_',
    '11111111-',
    'localhost',
    'other.invalid',
    '/Users/',
    '?',
    '#',
  ]) {
    expect(JSON.stringify(record)).not.toContain(secret);
    expect(stored).not.toContain(secret);
  }
});

it('caps locations, record bytes, retained records, and storage writes during repeated faults', async () => {
  const { captureDiagnostic } =
    await import('../../src/lib/platform/diagnostics');
  const stack = [
    'Error: PRIVATE_NOTE_TEXT',
    ...Array.from(
      { length: 100 },
      (_, index) =>
        `at http://localhost/src/lib/components/Workspace.svelte:${index + 1}:1`,
    ),
  ].join('\n');
  for (let index = 0; index < 12; index++) {
    const record = captureDiagnostic({ name: 'PRIVATE_ERROR', stack }, 999);
    expect(record.name).toBe('Error');
    expect(record.status).toBe(500);
    expect(record.locations).toHaveLength(5);
    expect(JSON.stringify(record).length).toBeLessThanOrEqual(1024);
  }
  expect(writes).toBe(3);
  const records = JSON.parse(stored!);
  expect(records).toHaveLength(3);
  expect(stored!.length).toBeLessThanOrEqual(4096);
  expect(stored).not.toContain('PRIVATE_');
});

it('retains only sanitized prior records, never a corrupted local-storage payload', async () => {
  const { captureDiagnostic } =
    await import('../../src/lib/platform/diagnostics');
  const first = captureDiagnostic(
    {
      name: 'Error',
      stack:
        'Error: PRIVATE_MESSAGE\n    at http://localhost/_app/immutable/chunks/DclECHGd.js:12:9',
    },
    500,
  );
  stored = JSON.stringify([
    { ...first, message: 'PRIVATE_STORED_CONTENT' },
    { ...first, reference: 'PRIVATE_NOTE_ID', locations: ['PRIVATE_PATH'] },
  ]);
  captureDiagnostic(new RangeError('PRIVATE_MESSAGE'), 404);
  expect(JSON.parse(stored!)).toHaveLength(2);
  expect(JSON.parse(stored!)[0].locations).toEqual([
    '_app/immutable/chunks/DclECHGd.js:12:9',
  ]);
  expect(stored).not.toContain('PRIVATE_');
});

it('survives unavailable/full storage and hostile error properties without losing the current diagnostic', async () => {
  const { captureDiagnostic, diagnosticText } =
    await import('../../src/lib/platform/diagnostics');
  vi.stubGlobal('localStorage', {
    getItem() {
      throw new Error('PRIVATE_STORAGE');
    },
    setItem() {
      throw new Error('PRIVATE_STORAGE');
    },
  });
  const hostile = new Proxy(
    {},
    {
      get() {
        throw new Error('PRIVATE_GETTER');
      },
    },
  );
  expect(() => captureDiagnostic(hostile, 500)).not.toThrow();
  expect(diagnosticText()).toContain('ST-');
  expect(diagnosticText()).not.toContain('PRIVATE_');
});
