import { expect, it, vi } from 'vitest';
import { MemoryRepository } from '../fixtures/memory';
import { WorkspaceController } from '../../src/lib/workspace/controller';
import { item } from '../fixtures/items';
import { encodeBackup, validateBackup } from '../../src/lib/domain/backup';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const trash = { scope: 'trash' as const, itemId: null };
it('M to Trash installs one ordered persistent action and one Undo restores noncontiguous siblings', async () => {
  const repo = new MemoryRepository();
  repo.snapshot.items = [1, 2, 3].map((n) =>
    item({ id: id(n), markdown: `**${n}**\r\n`, position: n - 1 }),
  );
  const c = new WorkspaceController(repo);
  await c.start();
  const move = c.captureMove([id(3), id(1)], trash, 0);
  expect(await c.moveItems(move)).toBe(true);
  expect(repo.snapshot.undoDeleteIds).toEqual([id(1), id(3)]);
  expect(JSON.parse(encodeBackup(repo.snapshot)).version).toBe(7);
  expect(validateBackup(encodeBackup(repo.snapshot))).toHaveProperty(
    'library.undoDeleteIds',
    [id(1), id(3)],
  );
  expect(await c.undoRemove()).toBe(true);
  expect(repo.snapshot.undoDeleteIds).toEqual([]);
  expect(
    repo.snapshot.items
      .filter((x) => x.deletedAt === null)
      .sort((a, b) => a.position - b.position)
      .map((x) => x.id),
  ).toEqual([id(1), id(2), id(3)]);
  expect(repo.snapshot.items[0].markdown).toBe('**1**\r\n');
});
it('version 7 rejects invalid ordered group fields', () => {
  const workspace = {
    items: [item({ id: id(1), deletedAt: 3 })],
    drafts: [],
    undoDeleteIds: [id(1)],
  };
  const backup = {
    format: 'scratchtree-alpha',
    version: 7,
    exportedAt: '2026-11-12T00:00:00.000Z',
    library: workspace,
  };
  expect(validateBackup(JSON.stringify(backup))).toHaveProperty(
    'library',
    workspace,
  );
  for (const undoDeleteIds of [null, id(1), [id(1), id(1)], [id(2)]])
    expect(
      validateBackup(
        JSON.stringify({
          ...backup,
          library: { ...workspace, undoDeleteIds },
        }),
      ),
    ).toHaveProperty('code');
});
it('lost move reply accepts an unrelated child deletion appended to Trash without replacing its marker', async () => {
  const repo = new MemoryRepository();
  repo.snapshot.items = [
    item({ id: id(1) }),
    item({ id: id(2), kind: 'tree', position: 1 }),
    item({ id: id(3), parentId: id(2) }),
  ];
  const c = new WorkspaceController(repo);
  await c.start();
  const request = c.captureMove([id(1)], trash, 0);
  await repo.moveItems(request);
  await repo.deleteItem(id(3));
  const before = structuredClone(repo.snapshot);
  await expect(repo.moveItems(request)).resolves.toEqual(before);
});
it('same millisecond re-delete cannot be consumed by an old captured Undo', async () => {
  const { captureUndoDelete } = await import('../../src/lib/domain/items');
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
  const repo = new MemoryRepository();
  repo.snapshot.items = [item({ id: id(1), updatedAt: Date.now() + 100000 })];
  await repo.deleteItem(id(1));
  const request = captureUndoDelete(repo.snapshot);
  await repo.undoDelete(request);
  await repo.deleteItem(id(1));
  const before = structuredClone(repo.snapshot);
  await expect(repo.undoDelete(request)).rejects.toBeDefined();
  expect(repo.snapshot).toEqual(before);
  clock.mockRestore();
});

it('group Undo rejects partial, stale, and altered proof while retaining newer source-only edits on replay', async () => {
  const { captureUndoDelete } = await import('../../src/lib/domain/items');
  const repo = new MemoryRepository();
  repo.snapshot.items = [
    item({ id: id(1), deletedAt: 3, restoreIndex: 0 }),
    item({ id: id(2), position: 1, deletedAt: 3, restoreIndex: 1 }),
  ];
  repo.snapshot.undoDeleteIds = [id(1), id(2)];
  const request = captureUndoDelete(repo.snapshot),
    before = structuredClone(repo.snapshot);
  const altered = structuredClone(request);
  altered.proof.after[0].position = 8;
  await expect(repo.undoDelete(altered)).rejects.toBeDefined();
  expect(repo.snapshot).toEqual(before);
  await repo.restoreItem(id(1));
  const partial = structuredClone(repo.snapshot);
  await expect(repo.undoDelete(request)).rejects.toBeDefined();
  expect(repo.snapshot).toEqual(partial);
  repo.snapshot = before;
  await repo.undoDelete(request);
  await repo.saveItemSource(id(1), 'newer **source**\r\n', {
    key: id(1),
    revision: 0,
  });
  const edited = structuredClone(repo.snapshot);
  await expect(repo.undoDelete(request)).resolves.toEqual(edited);
});
it('cross-area proof rejects changed subtree membership and deletion facts without touching saved bytes', async () => {
  const repo = new MemoryRepository();
  repo.snapshot.items = [
    item({ id: id(1), kind: 'tree' }),
    item({ id: id(2), parentId: id(1) }),
  ];
  const c = new WorkspaceController(repo);
  await c.start();
  const request = c.captureMove([id(1)], trash, 0);
  repo.snapshot.items.push(item({ id: id(3), parentId: id(1), position: 1 }));
  const before = structuredClone(repo.snapshot);
  await expect(repo.moveItems(request)).rejects.toBeDefined();
  expect(repo.snapshot).toEqual(before);
  repo.snapshot.items.pop();
  await repo.moveItems(request);
  repo.snapshot.items[0].deletedAt! += 1;
  const changed = structuredClone(repo.snapshot);
  await expect(repo.moveItems(request)).rejects.toBeDefined();
  expect(repo.snapshot).toEqual(changed);
});
it('partial Restore and purge filter only matching marker members, preserving order and independent descendants', async () => {
  const repo = new MemoryRepository();
  repo.snapshot.items = [
    item({ id: id(1), kind: 'tree', deletedAt: 3 }),
    item({ id: id(2), parentId: id(1), deletedAt: 4, restoreIndex: 0 }),
    item({ id: id(3), position: 1, deletedAt: 3 }),
    item({ id: id(4), position: 2, deletedAt: 3 }),
  ];
  repo.snapshot.undoDeleteIds = [id(1), id(2), id(3), id(4)];
  await repo.restoreItem(id(1));
  expect(repo.snapshot.undoDeleteIds).toEqual([id(2), id(3), id(4)]);
  expect(repo.snapshot.items.find((x) => x.id === id(2))!.parentId).toBe(null);
  await repo.purgeItem({
    id: id(3),
    location: trash,
    expectedSubtreeIds: [id(3)],
  });
  expect(repo.snapshot.undoDeleteIds).toEqual([id(2), id(4)]);
  await repo.deleteItem(id(1));
  expect(repo.snapshot.undoDeleteIds).toEqual([id(1)]);
});
it('Trash-to-live movement keeps nearest independent deletion trees and restores chosen owner exactly', async () => {
  const repo = new MemoryRepository();
  repo.snapshot.items = [
    item({ id: id(1), kind: 'tree', deletedAt: 3 }),
    item({
      id: id(2),
      parentId: id(1),
      kind: 'tree',
      deletedAt: 4,
      restoreIndex: 0,
    }),
    item({ id: id(3), parentId: id(2), deletedAt: 5, restoreIndex: 0 }),
    item({ id: id(4), kind: 'tree' }),
  ];
  repo.snapshot.undoDeleteIds = [id(1), id(2), id(3)];
  const c = new WorkspaceController(repo);
  await c.start();
  const request = c.captureMove([id(1)], { scope: 'live', itemId: id(4) }, 0);
  await repo.moveItems(request);
  expect(repo.snapshot.items.find((x) => x.id === id(1))!.parentId).toBe(id(4));
  expect(repo.snapshot.items.find((x) => x.id === id(2))!.parentId).toBe(null);
  expect(repo.snapshot.items.find((x) => x.id === id(3))!.parentId).toBe(id(2));
  expect(repo.snapshot.undoDeleteIds).toEqual([id(2), id(3)]);
  const before = structuredClone(repo.snapshot);
  await expect(repo.moveItems(request)).resolves.toEqual(before);
});
it('broad group Undo preserves all marker order and content in a bounded batched mutation', async () => {
  const { captureUndoDelete } = await import('../../src/lib/domain/items');
  for (const width of [1000, 4000]) {
    const repo = new MemoryRepository();
    repo.snapshot.items = Array.from({ length: width }, (_, i) =>
      item({
        id: id(i + 1),
        markdown: `**${i + 1}**\r\n`,
        position: i,
        deletedAt: 3,
        restoreIndex: i,
      }),
    );
    repo.snapshot.undoDeleteIds = repo.snapshot.items.map((x) => x.id);
    const start = performance.now();
    const request = captureUndoDelete(repo.snapshot);
    await repo.undoDelete(request);
    console.log(
      `group Undo width=${width}: ${(performance.now() - start).toFixed(1)}ms`,
    );
    expect(repo.snapshot.undoDeleteIds).toEqual([]);
    expect(
      repo.snapshot.items.map((x) => [x.position, x.markdown, x.deletedAt]),
    ).toEqual(
      Array.from({ length: width }, (_, i) => [i, `**${i + 1}**\r\n`, null]),
    );
  }
});
it('singleton Restore keeps manually reordered inherited siblings when detaching an independent record', async () => {
  const repo = new MemoryRepository();
  repo.snapshot.items = [
    item({ id: id(1), kind: 'tree', deletedAt: 3 }),
    item({ id: id(2), parentId: id(1), position: 2 }),
    item({ id: id(3), parentId: id(1), position: 0 }),
    item({ id: id(4), parentId: id(1), position: 1, deletedAt: 4 }),
  ];
  await repo.restoreItem(id(1));
  expect(
    repo.snapshot.items
      .filter((x) => x.parentId === id(1))
      .sort((a, b) => a.position - b.position)
      .map((x) => x.id),
  ).toEqual([id(3), id(2)]);
});
it('a filtered group retains a distinguishable deletion lifecycle when the shared stamp exceeded one root timestamp', async () => {
  const { captureUndoDelete } = await import('../../src/lib/domain/items');
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
  try {
    const repo = new MemoryRepository();
    repo.snapshot.items = [
      item({ id: id(1), updatedAt: 999 }),
      item({ id: id(2), position: 1, updatedAt: 1001 }),
    ];
    const c = new WorkspaceController(repo);
    await c.start();
    await repo.moveItems(c.captureMove([id(1), id(2)], trash, 0));
    await repo.restoreItem(id(2));
    const request = captureUndoDelete(repo.snapshot);
    await repo.undoDelete(request);
    await repo.deleteItem(id(1));
    const newer = structuredClone(repo.snapshot);
    await expect(repo.undoDelete(request)).rejects.toBeDefined();
    expect(repo.snapshot).toEqual(newer);
  } finally {
    clock.mockRestore();
  }
});
it('wide independent-deletion replay reads parent edges within a linear budget across distinct affected groups', async () => {
  const { captureMoveProof, moveItems } =
    await import('../../src/lib/domain/items');
  const width = 500;
  const s = {
    items: [
      item({ id: id(1), kind: 'tree', deletedAt: 3 }),
      ...Array.from({ length: width }, (_, i) => [
        item({
          id: id(i * 2 + 2),
          parentId: id(1),
          kind: 'tree',
          position: i,
        }),
        item({ id: id(i * 2 + 3), parentId: id(i * 2 + 2), deletedAt: 4 }),
      ]).flat(),
    ],
    drafts: [],
    undoDeleteIds: [],
  };
  const r = captureMoveProof(s, {
    ids: [id(1)],
    from: trash,
    to: { scope: 'live', itemId: null },
    beforeFrom: [id(1)],
    beforeTo: [],
    afterFrom: [],
    afterTo: [id(1)],
  });
  moveItems(s, r);
  let reads = 0;
  for (const x of s.items) {
    let parent = x.parentId;
    Object.defineProperty(x, 'parentId', {
      enumerable: true,
      configurable: true,
      get() {
        reads++;
        return parent;
      },
      set(value) {
        parent = value;
      },
    });
  }
  moveItems(s, r);
  expect(reads).toBeLessThan(s.items.length * 100);
});

it('singleton Undo derives the same historical exact-ID descendant order from an unsorted valid snapshot', async () => {
  const { captureUndoDelete } = await import('../../src/lib/domain/items');
  const repo = new MemoryRepository();
  repo.snapshot.items = [
    item({
      id: id(1),
      kind: 'tree',
      deletedAt: 3,
      markdown: '**parent**\r\n',
    }),
    item({
      id: id(3),
      parentId: id(1),
      position: 0,
      deletedAt: 4,
      markdown: '**three**\r\n',
    }),
    item({
      id: id(2),
      parentId: id(1),
      position: 1,
      deletedAt: 5,
      markdown: '**two**\r\n',
    }),
  ];
  repo.snapshot.drafts = [
    { key: id(3), markdown: 'draft\r\n', revision: 8, updatedAt: 9 },
  ];
  repo.snapshot.undoDeleteIds = [id(1)];
  const before = structuredClone(repo.snapshot);
  const request = captureUndoDelete(repo.snapshot);
  const after = await repo.undoDelete(request);
  expect(
    after.items
      .filter((x) => x.deletedAt !== null)
      .sort((a, b) => a.position - b.position)
      .map((x) => x.id),
  ).toEqual([id(3), id(2)]);
  expect(after.drafts).toEqual(before.drafts);
  for (const old of before.items.filter((x) => x.id !== id(1)))
    expect(after.items.find((x) => x.id === old.id)).toEqual({
      ...old,
      parentId: null,
      position: old.id === id(3) ? 0 : 1,
    });
  expect(after.items.find((x) => x.id === id(1))!.markdown).toBe(
    '**parent**\r\n',
  );
  expect(await repo.undoDelete(request)).toEqual(after);
});

it('Undo keeps an earlier lost-purge Retry visible until its exact acknowledgment prunes only captured caches', async () => {
  const repo = new MemoryRepository();
  repo.snapshot.items = [
    item({ id: id(1), deletedAt: 3 }),
    item({ id: id(2) }),
  ];
  const c = new WorkspaceController(repo);
  await c.start();
  c.editContext(id(1), 'retained cached source');
  const purge = repo.purgeItem.bind(repo);
  let lose = true;
  repo.purgeItem = async (request) => {
    const result = await purge(request);
    if (lose) {
      lose = false;
      throw Error('lost purge reply');
    }
    return result;
  };
  expect(await c.purgeItem(c.capturePurge(id(1)))).toBe(false);
  const purgeRetry = c.mutationRetryIdentity;
  expect(c.state.buffers[id(1)]).toBeDefined();
  expect(await c.remove(id(2))).toBe(true);
  const operations: unknown[] = [];
  const unsubscribe = c.subscribe((state) => operations.push(state.operation));
  expect(await c.undoRemove()).toBe(true);
  expect(c.mutationRetryIdentity).toBe(purgeRetry);
  expect(c.state.mutationRetry).toBe(true);
  expect(operations).toContain('restore-item');
  expect(c.state.purgedItemIds).toEqual([]);
  expect(await c.retryMutation()).toBe(true);
  expect(c.state.purgedItemIds).toEqual([id(1)]);
  expect(c.state.buffers[id(1)]).toBeUndefined();
  expect(repo.snapshot.items.map((x) => x.id)).toEqual([id(2)]);
  expect(repo.snapshot.items[0].deletedAt).toBe(null);
  expect(c.state.mutationRetry).toBe(false);
  unsubscribe();
  c.dispose();
});

it('Undo reconciles a known lost creation acknowledgment before rejecting stale structure without duplicating its identity', async () => {
  const repo = new MemoryRepository();
  repo.snapshot.items = [item({ id: id(1), deletedAt: 3 })];
  repo.snapshot.undoDeleteIds = [id(1)];
  const capture = repo.captureItem.bind(repo),
    requests: string[] = [];
  let lose = true;
  repo.captureItem = async (request) => {
    requests.push(request.id);
    const result = await capture(request);
    if (lose) {
      lose = false;
      throw Error('lost capture reply');
    }
    return result;
  };
  const c = new WorkspaceController(repo);
  await c.start();
  c.editSource('captured once\r\n');
  expect(await c.save()).toBe(false);
  const capturedId = requests[0];
  expect(c.state.snapshot.items.some((x) => x.id === capturedId)).toBe(false);
  expect(await c.undoRemove()).toBe(false);
  expect(requests).toEqual([capturedId, capturedId]);
  expect(c.state.snapshot.items.some((x) => x.id === capturedId)).toBe(true);
  expect(repo.snapshot.undoDeleteIds).toEqual([id(1)]);
  expect(await c.save()).toBe(true);
  expect(repo.snapshot.items.filter((x) => x.id === capturedId)).toHaveLength(
    1,
  );
  expect(new Set(requests)).toEqual(new Set([capturedId]));
  c.dispose();
});

it('a failed controller Undo retries its captured IDs and cannot consume a newer deletion marker', async () => {
  const repo = new MemoryRepository();
  repo.snapshot.items = [
    item({ id: id(1), deletedAt: 3 }),
    item({ id: id(2) }),
  ];
  repo.snapshot.undoDeleteIds = [id(1)];
  const undo = repo.undoDelete.bind(repo),
    requests: string[][] = [];
  repo.undoDelete = async (request) => {
    requests.push([...request.ids]);
    return undo(request);
  };
  const c = new WorkspaceController(repo);
  await c.start();
  repo.fail = 'undo';
  expect(await c.undoRemove()).toBe(false);
  repo.fail = null;
  await repo.deleteItem(id(2));
  const newer = structuredClone(repo.snapshot);
  expect(await c.retryMutation()).toBe(false);
  expect(requests).toEqual([[id(1)], [id(1)]]);
  expect(repo.snapshot).toEqual(newer);
  c.dispose();
});
