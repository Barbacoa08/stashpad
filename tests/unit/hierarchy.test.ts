import { it, expect } from 'vitest';
import { validateBackup, encodeBackup } from '../../src/lib/domain/backup';
import { item } from '../fixtures/items';
import {
  composeKey,
  treePath,
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
  items: [
    item({ id: a, kind: 'tree', markdown: 'Parent' }),
    item({
      id: b,
      kind: 'tree',
      parentId: a,
      markdown: 'Child',
      createdAt: 1,
      updatedAt: 1,
    }),
    item({
      id: n,
      parentId: b,
      markdown: 'nested',
      createdAt: 2,
      updatedAt: 2,
    }),
  ],
  drafts: [
    { key: composeKey(b), markdown: 'draft', revision: 1, updatedAt: 1 },
  ],
});
it('roundtrips nested ownership and resolves a flat hierarchy and exact compose keys', () => {
  const s = workspace();
  const checked = validateBackup(encodeBackup(s));
  expect(checked).toHaveProperty('version', 7);
  expect(checked).toHaveProperty('library', s);
  expect(
    treePath(
      s.items.filter((x) => x.kind === 'tree'),
      b,
    ).map((x) => x.markdown),
  ).toEqual(['Parent', 'Child']);
  expect(directEntries(s, a).map((x) => x.id)).toEqual([b]);
  expect(
    sidebarRows(
      s.items.filter((x) => x.kind === 'tree'),
      new Set([a]),
    ).map((x) => [x.tree.id, x.depth]),
  ).toEqual([
    [a, 0],
    [b, 1],
  ]);
});
it('validates a 10000 deep chain without recursion or quadratic ancestor scans', () => {
  const s = emptyWorkspace();
  for (let i = 0; i < 10000; i++) {
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    s.items.push(
      item({
        id,
        kind: 'tree',
        markdown: 'tree',
        parentId: s.items.at(-1)?.id ?? null,
        createdAt: i,
        updatedAt: i,
      }),
    );
  }
  expect(validateBackup(encodeBackup(s))).toHaveProperty('version', 7);
  expect(
    treePath(
      s.items.filter((x) => x.kind === 'tree'),
      s.items.at(-1)!.id,
    ),
  ).toHaveLength(10000);
});
it('counts direct active entries once for tree cards, including deletion timestamp zero', async () => {
  const policy = await import('../../src/lib/domain/hierarchy');
  expect(policy).toHaveProperty('entryCounts');
  const s = workspace();
  s.items.push(
    item({
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      deletedAt: 0,
      position: 0,
    }),
  );
  expect(policy.entryCounts(s).get(b)).toBe(1);
  expect(policy.entryCounts(s).get(a)).toBe(1);
});

it('accepts 200 Unicode code points and all 20001 legal draft contexts', () => {
  const s = emptyWorkspace();
  for (let i = 0; i < 10000; i++) {
    const ownerId = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    const noteId = `00000000-0000-4001-8000-${String(i).padStart(12, '0')}`;
    s.items.push(
      item({
        id: ownerId,
        kind: 'tree',
        markdown: i === 0 ? '😀'.repeat(200) : 'x',
        position: i,
      }),
      item({ id: noteId, parentId: ownerId, markdown: 'x' }),
    );
    s.drafts.push(
      { key: composeKey(ownerId), markdown: '', revision: 0, updatedAt: 0 },
      { key: noteId, markdown: '', revision: 0, updatedAt: 0 },
    );
  }
  s.drafts.push({ key: 'compose', markdown: '', revision: 0, updatedAt: 0 });
  expect(validateBackup(encodeBackup(s))).toHaveProperty(
    'library.drafts.length',
    20001,
  );
});
