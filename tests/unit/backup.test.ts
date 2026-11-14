import { WorkspaceController } from '../../src/lib/workspace/controller';
import { MemoryRepository } from '../fixtures/memory';
import { item } from '../fixtures/items';
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { validateBackup, encodeBackup } from '../../src/lib/domain/backup';
import {
  MAX_SOURCE,
  MAX_ENVELOPE,
  type WorkspaceSnapshot,
} from '../../src/lib/domain/notes';
const id = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
  deleted = 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB';
const snapshot = (): WorkspaceSnapshot => ({
  items: [
    item({
      id,
      kind: 'tree',
      markdown: 'α **source**  \r\n```json\n{"a":1}\r\n```\n',
      createdAt: 1,
      updatedAt: 2,
    }),
    item({ id: deleted, markdown: 'deleted', done: true, deletedAt: 3 }),
  ],
  drafts: [
    { key: id, markdown: 'unfinished  \r\n', revision: 4, updatedAt: 5 },
    { key: 'compose', markdown: 'capture', revision: 1, updatedAt: 2 },
  ],
  undoDeleteIds: [deleted],
});
const valid = () => JSON.parse(encodeBackup(snapshot()));
describe('strict version-7 library backup', () => {
  it('exports only the new library envelope and roundtrips every source-bearing tree field', () => {
    const b = valid();
    expect(b).toEqual({
      format: 'scratchtree-alpha',
      version: 7,
      exportedAt: expect.any(String),
      library: snapshot(),
    });
    expect(validateBackup(JSON.stringify(b))).toEqual(b);
  });
  it.each([
    'format',
    'version',
    'kind',
    'duplicate',
    'draftDuplicate',
    'dangling',
    'parent',
    'cycle',
    'rank',
    'restore',
    'missing',
    'type',
    'timestamp',
    'extra',
    'oversizeField',
    'undoActive',
    'undoDuplicate',
    'undoCase',
    'draftCase',
    'duplicateCase',
  ])('rejects %s without normalizing', (kind) => {
    const b = valid(),
      s = b.library;
    if (kind === 'format') b.format = 'unrecognized-alpha';
    if (kind === 'version') b.version = 8;
    if (kind === 'kind') s.items[0].kind = 'branch';
    if (kind === 'duplicate') s.items.push(s.items[0]);
    if (kind === 'draftDuplicate') s.drafts.push(s.drafts[0]);
    if (kind === 'dangling')
      s.drafts[0].key = '33333333-3333-4333-8333-333333333333';
    if (kind === 'parent')
      s.items[0].parentId = '33333333-3333-4333-8333-333333333333';
    if (kind === 'cycle') s.items[0].parentId = id;
    if (kind === 'rank')
      s.items.push(item({ id: '33333333-3333-4333-8333-333333333333' }));
    if (kind === 'restore') s.items[1].restoreParentId = id;
    if (kind === 'missing') delete s.undoDeleteIds;
    if (kind === 'type') s.items[0].createdAt = '1';
    if (kind === 'timestamp') b.exportedAt = '2026-02-30T00:00:00.000Z';
    if (kind === 'extra') b.machinePath = '/private';
    if (kind === 'oversizeField')
      s.items[0].markdown = 'x'.repeat(MAX_SOURCE + 1);
    if (kind === 'undoActive') s.undoDeleteIds = [id];
    if (kind === 'undoDuplicate') s.undoDeleteIds.push(deleted);
    if (kind === 'undoCase') s.undoDeleteIds = [deleted.toLowerCase()];
    if (kind === 'draftCase') s.drafts[0].key = id.toLowerCase();
    if (kind === 'duplicateCase')
      s.items.push({ ...s.items[0], id: id.toLowerCase() });
    expect(validateBackup(JSON.stringify(b))).toHaveProperty(
      'code',
      'invalid_backup',
    );
  });
  it('rejects malformed and over-envelope input', () => {
    expect(validateBackup('{')).toHaveProperty('code');
    expect(validateBackup(' '.repeat(MAX_ENVELOPE + 1))).toHaveProperty('code');
  });
  it('shares exact synthetic source, independent Trash descendants, and ordered group Undo with Rust', () => {
    const text = readFileSync(
      new URL('../fixtures/valid-v7.json', import.meta.url),
      'utf8',
    );
    expect(validateBackup(text)).toEqual(JSON.parse(text));
  });
});
it('restores exact uppercase IDs, times, source, and draft, and undoes completion-bearing deletion', async () => {
  const repo = new MemoryRepository(),
    c = new WorkspaceController(repo);
  try {
    await c.start();
    repo.restoreText = encodeBackup(snapshot());
    expect(await c.previewRestore()).toBe(true);
    expect(await c.restore()).toBe(true);
    expect(repo.snapshot).toEqual(snapshot());
    await c.selectNote(id);
    expect(c.state.source).toBe('unfinished  \r\n');
    await c.undoRemove();
    expect(repo.snapshot.items.find((x) => x.id === deleted)).toMatchObject({
      deletedAt: null,
      done: true,
    });
  } finally {
    c.dispose();
  }
});
it('rejected replacement retains the existing library and source buffer', async () => {
  const repo = new MemoryRepository(),
    c = new WorkspaceController(repo);
  repo.snapshot = snapshot();
  await c.start();
  c.editSource('retained input');
  await c.flush();
  const before = structuredClone(repo.snapshot),
    changed = valid();
  changed.library.items[0].kind = 'branch';
  repo.restoreText = JSON.stringify(changed);
  expect(await c.previewRestore()).toBe(false);
  expect(repo.snapshot).toEqual(before);
  expect(c.state.source).toBe('retained input');
  c.dispose();
});

it('uses the last repeated envelope and nested field before strict validation', () => {
  const text =
    '{"format":"discarded","format":"scratchtree-alpha","version":0,"version":7,"exportedAt":"2026-11-13T00:00:00.000Z","library":{"items":[{"id":"11111111-1111-4111-8111-111111111111","parentId":null,"kind":"note","kind":"tree","markdown":"discarded","markdown":"kept","done":false,"done":true,"color":null,"position":0,"createdAt":1,"updatedAt":2,"deletedAt":null,"restoreParentId":null,"restoreIndex":null}],"drafts":[],"undoDeleteIds":[]}}';
  expect(validateBackup(text)).toEqual({
    format: 'scratchtree-alpha',
    version: 7,
    exportedAt: '2026-11-13T00:00:00.000Z',
    library: {
      items: [
        item({
          id: '11111111-1111-4111-8111-111111111111',
          kind: 'tree',
          markdown: 'kept',
          done: true,
          createdAt: 1,
          updatedAt: 2,
        }),
      ],
      drafts: [],
      undoDeleteIds: [],
    },
  });
  expect(
    validateBackup(
      text.replace('"done":false,"done":true', '"done":true,"done":0'),
    ),
  ).toHaveProperty('code', 'invalid_backup');
});

// A tree is also a source-bearing note; Trash is part of the complete library.
it('previews every saved note exactly once with trees as an included subtotal', async () => {
  const repo = new MemoryRepository();
  repo.restoreText = encodeBackup(snapshot());
  expect(await repo.previewRestore()).toMatchObject({
    notes: 2,
    trees: 1,
    drafts: 2,
  });
  expect(repo.snapshot.items).toHaveLength(0);
});

describe('raw JSON input parity with native backup validation', () => {
  const text = readFileSync(
    new URL('../fixtures/valid-v7.json', import.meta.url),
    'utf8',
  );
  it.each([
    '2026-+1-01T00:00:00.000Z',
    '+026-01-01T00:00:00.000Z',
    '2026-01-01T+0:00:00.000Z',
    '2026-01-01T00:00:00.+00Z',
  ])('rejects signed timestamp components: %s', (date) => {
    expect(
      validateBackup(text.replace('2026-11-13T00:00:00.000Z', date)),
    ).toHaveProperty('code', 'invalid_backup');
  });
  it.each(['7.0', '7e0'])(
    'accepts integral version %s without changing source',
    (version) => {
      expect(
        validateBackup(text.replace('"version": 7', `"version": ${version}`)),
      ).toEqual(JSON.parse(text));
    },
  );
  it('accepts safe integral decimal/exponent metadata and preserves source separators', () => {
    const raw = text
      .replaceAll('"position": 0', '"position": -0.0')
      .replaceAll('"createdAt": 1', '"createdAt": 1.0')
      .replaceAll('"updatedAt": 2', '"updatedAt": 2e0')
      .replaceAll('"deletedAt": 3', '"deletedAt": 3.0')
      .replaceAll('"restoreIndex": 1', '"restoreIndex": 1e0')
      .replace('"revision": 4', '"revision": 9.007199254740991e15');
    const checked = validateBackup(raw);
    expect(checked).toEqual(JSON.parse(raw));
    if ('code' in checked) throw new Error(checked.code);
    expect(checked.library.items[0].markdown).toBe('**note 1**\r\nline\n');
    expect(checked.library.drafts[0]).toMatchObject({
      markdown: 'unsaved\r\n',
      revision: 9007199254740991,
    });
  });
  it.each(['1.5', '9.007199254740992e15', '-1.0', '"1.0"', 'true', 'null'])(
    'rejects invalid integer metadata %s',
    (value) => {
      expect(
        validateBackup(text.replace('"revision": 4', `"revision": ${value}`)),
      ).toHaveProperty('code', 'invalid_backup');
    },
  );
  it('keeps unknown-field rejection after numeric normalization', () => {
    expect(
      validateBackup(
        text.replace('"revision": 4', '"revision": 4.0, "unknown": 1e0'),
      ),
    ).toHaveProperty('code', 'invalid_backup');
  });
});
