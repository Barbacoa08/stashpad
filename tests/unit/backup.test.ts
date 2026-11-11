import { WorkspaceController } from '../../src/lib/workspace/controller';
import { MemoryRepository } from '../fixtures/memory';
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { validateBackup, encodeBackup } from '../../src/lib/domain/backup';
import {
  MAX_SOURCE,
  MAX_ENVELOPE,
  type WorkspaceSnapshot,
} from '../../src/lib/domain/notes';
const id = '11111111-1111-4111-8111-111111111111',
  deleted = '22222222-2222-4222-8222-222222222222';
const snapshot = (): WorkspaceSnapshot => ({
  stashes: [],
  notes: [
    {
      id,
      markdown: 'α **source**  \n```json\n{"a":1}\n```\n',
      createdAt: 1,
      updatedAt: 2,
      stashId: null,
      deletedAt: null,
    },
    {
      id: deleted,
      markdown: 'deleted',
      createdAt: 0,
      updatedAt: 3,
      stashId: null,
      deletedAt: 3,
    },
  ],
  drafts: [
    { key: id, markdown: 'unfinished  \n', revision: 4, updatedAt: 5 },
    { key: 'compose', markdown: 'capture', revision: 1, updatedAt: 2 },
  ],
  undoDeleteId: deleted,
});
const valid = () => JSON.parse(encodeBackup(snapshot()));
describe('strict whole-envelope backup validation', () => {
  it('preserves all exact fields', () => {
    const b = validateBackup(encodeBackup(snapshot()));
    expect('code' in b).toBe(false);
    if (!('code' in b)) expect(b.workspace).toEqual(snapshot());
  });
  it.each([
    'future',
    'duplicate',
    'draftDuplicate',
    'dangling',
    'missing',
    'type',
    'timestamp',
    'extra',
    'oversizeField',
    'undoActive',
  ])('rejects %s without normalizing', (kind) => {
    const b = valid();
    if (kind === 'future') b.version = 3;
    if (kind === 'duplicate') b.workspace.notes.push(b.workspace.notes[0]);
    if (kind === 'draftDuplicate')
      b.workspace.drafts.push(b.workspace.drafts[0]);
    if (kind === 'dangling')
      b.workspace.drafts[0].key = '33333333-3333-4333-8333-333333333333';
    if (kind === 'missing') delete b.workspace.undoDeleteId;
    if (kind === 'type') b.workspace.notes[0].createdAt = '1';
    if (kind === 'timestamp') b.exportedAt = '2026-02-30T00:00:00.000Z';
    if (kind === 'extra') b.machinePath = '/private';
    if (kind === 'oversizeField')
      b.workspace.notes[0].markdown = 'x'.repeat(MAX_SOURCE + 1);
    if (kind === 'undoActive') b.workspace.undoDeleteId = id;
    expect(validateBackup(JSON.stringify(b))).toHaveProperty(
      'code',
      'invalid_backup',
    );
  });
  it('rejects malformed and over-envelope input', () => {
    expect(validateBackup('{')).toHaveProperty('code');
    expect(validateBackup(' '.repeat(MAX_ENVELOPE + 1))).toHaveProperty('code');
  });
});

it('validates public reusable fixtures', () => {
  expect(
    validateBackup(
      readFileSync(
        new URL('../fixtures/valid-v1.json', import.meta.url),
        'utf8',
      ),
    ),
  ).toHaveProperty('version', 2);
  expect(
    validateBackup(
      readFileSync(
        new URL('../fixtures/invalid-future.json', import.meta.url),
        'utf8',
      ),
    ),
  ).toHaveProperty('code', 'invalid_backup');
});

const upperActive = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
  upperDeleted = 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB';
const upperWorkspace = (): WorkspaceSnapshot => ({
  stashes: [],
  notes: [
    {
      id: upperActive,
      markdown: 'saved uppercase',
      createdAt: 1,
      updatedAt: 2,
      stashId: null,
      deletedAt: null,
    },
    {
      id: upperDeleted,
      markdown: 'deleted uppercase',
      createdAt: 1,
      updatedAt: 2,
      stashId: null,
      deletedAt: 3,
    },
  ],
  drafts: [
    {
      key: upperActive,
      markdown: 'unfinished uppercase',
      revision: 4,
      updatedAt: 5,
    },
  ],
  undoDeleteId: upperDeleted,
});
it.each(['draft', 'undo', 'duplicate'])(
  'rejects UUID reference spelling mismatch or ambiguous identity: %s',
  (kind) => {
    const s = upperWorkspace();
    if (kind === 'draft') s.drafts[0].key = upperActive.toLowerCase();
    if (kind === 'undo') s.undoDeleteId = upperDeleted.toLowerCase();
    if (kind === 'duplicate')
      s.notes.push({ ...s.notes[0], id: upperActive.toLowerCase() });
    expect(validateBackup(encodeBackup(s))).toHaveProperty(
      'code',
      'invalid_backup',
    );
  },
);
it('restores and selects an uppercase exact-reference draft and preserves original IDs/times/source', async () => {
  const repo = new MemoryRepository();
  const c = new WorkspaceController(repo);
  try {
    await c.start();
    repo.restoreText = encodeBackup(upperWorkspace());
    expect(await c.previewRestore()).toBe(true);
    expect(await c.restore()).toBe(true);
    expect(repo.snapshot).toEqual(upperWorkspace());
    await c.selectNote(upperActive);
    expect(c.state.source).toBe('unfinished uppercase');
    await c.undoRemove();
    expect(
      repo.snapshot.notes.find((n) => n.id === upperDeleted)?.deletedAt,
    ).toBeNull();
  } finally {
    c.dispose();
  }
});
