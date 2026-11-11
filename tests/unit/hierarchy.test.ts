import { it, expect } from 'vitest';
import { validateBackup, encodeBackup } from '../../src/lib/domain/backup';
import {
  composeKey,
  stashPath,
  directEntries,
  sidebarRows,
} from '../../src/lib/domain/hierarchy';
import {
  emptyWorkspace,
  type WorkspaceSnapshot,
} from '../../src/lib/domain/notes';
const a = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
  b = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  n = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const workspace = (): WorkspaceSnapshot => ({
  ...emptyWorkspace(),
  stashes: [
    { id: a, name: 'Parent', parentId: null, createdAt: 0, updatedAt: 0 },
    { id: b, name: 'Child', parentId: a, createdAt: 1, updatedAt: 1 },
  ],
  notes: [
    {
      id: n,
      stashId: b,
      markdown: 'nested',
      createdAt: 2,
      updatedAt: 2,
      deletedAt: null,
    },
  ],
  drafts: [
    { key: composeKey(b), markdown: 'draft', revision: 1, updatedAt: 1 },
  ],
});
it('roundtrips nested ownership and resolves a flat hierarchy and exact compose keys', () => {
  const s = workspace();
  const checked = validateBackup(encodeBackup(s));
  expect(checked).toHaveProperty('version', 2);
  expect(checked).toHaveProperty('workspace', s);
  expect(stashPath(s.stashes, b).map((x) => x.name)).toEqual([
    'Parent',
    'Child',
  ]);
  expect(directEntries(s, a).map((x) => x.id)).toEqual([b]);
  expect(
    sidebarRows(s.stashes, new Set([a])).map((x) => [x.stash.id, x.depth]),
  ).toEqual([
    [a, 0],
    [b, 1],
  ]);
});
it.each([
  'cycle',
  'parent',
  'owner',
  'case',
  'compose',
  'composeCase',
  'crossType',
  'name',
  'future',
])('rejects invalid hierarchy %s', (kind) => {
  const v = JSON.parse(encodeBackup(workspace()));
  if (kind === 'cycle') v.workspace.stashes[0].parentId = b;
  if (kind === 'parent') v.workspace.stashes[1].parentId = n;
  if (kind === 'owner') v.workspace.notes[0].stashId = n;
  if (kind === 'case') v.workspace.stashes[1].parentId = a.toLowerCase();
  if (kind === 'composeCase')
    v.workspace.drafts[0].key = composeKey(a.toLowerCase());
  if (kind === 'compose') v.workspace.drafts[0].key = composeKey(n);
  if (kind === 'crossType') v.workspace.notes[0].id = a.toLowerCase();
  if (kind === 'name') v.workspace.stashes[0].name = '😀'.repeat(201);
  if (kind === 'future') v.version = 3;
  expect(validateBackup(JSON.stringify(v))).toHaveProperty(
    'code',
    'invalid_backup',
  );
});
it('imports strict version1 as Home and retains a zero deletion Undo target', () => {
  const v = {
    format: 'stashpad-alpha',
    version: 1,
    exportedAt: '2026-11-11T00:00:00.000Z',
    workspace: {
      notes: [
        {
          id: n,
          markdown: 'exact\r\n',
          createdAt: 0,
          updatedAt: 0,
          deletedAt: 0,
        },
      ],
      drafts: [],
      undoDeleteId: n,
    },
  };
  const result = validateBackup(JSON.stringify(v));
  expect(result).toHaveProperty('workspace.stashes', []);
  expect(result).toHaveProperty('workspace.notes.0.stashId', null);
  expect(result).toHaveProperty('workspace.notes.0.markdown', 'exact\r\n');
});
it('validates a 10000 deep chain without recursion or quadratic ancestor scans', () => {
  const s = emptyWorkspace();
  for (let i = 0; i < 10000; i++) {
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    s.stashes.push({
      id,
      name: 'stash',
      parentId: s.stashes.at(-1)?.id ?? null,
      createdAt: i,
      updatedAt: i,
    });
  }
  expect(validateBackup(encodeBackup(s))).toHaveProperty('version', 2);
  expect(stashPath(s.stashes, s.stashes.at(-1)!.id)).toHaveLength(10000);
});
it('counts direct active entries once for stash cards, including deletion timestamp zero', async () => {
  const policy = await import('../../src/lib/domain/hierarchy');
  expect(policy).toHaveProperty('entryCounts');
  const s = workspace();
  s.notes.push({
    ...s.notes[0],
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    deletedAt: 0,
  });
  expect(policy.entryCounts(s).get(b)).toBe(1);
  expect(policy.entryCounts(s).get(a)).toBe(1);
});

it('accepts 200 Unicode code points and all 20001 legal draft contexts', () => {
  const s = emptyWorkspace();
  for (let i = 0; i < 10000; i++) {
    const stashId = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    const noteId = `00000000-0000-4001-8000-${String(i).padStart(12, '0')}`;
    s.stashes.push({
      id: stashId,
      name: i === 0 ? '😀'.repeat(200) : 'x',
      parentId: null,
      createdAt: 0,
      updatedAt: 0,
    });
    s.notes.push({
      id: noteId,
      stashId,
      markdown: 'x',
      createdAt: 0,
      updatedAt: 0,
      deletedAt: null,
    });
    s.drafts.push(
      { key: composeKey(stashId), markdown: '', revision: 0, updatedAt: 0 },
      { key: noteId, markdown: '', revision: 0, updatedAt: 0 },
    );
  }
  s.drafts.push({ key: 'compose', markdown: '', revision: 0, updatedAt: 0 });
  expect(validateBackup(encodeBackup(s))).toHaveProperty(
    'workspace.drafts.length',
    20001,
  );
});
