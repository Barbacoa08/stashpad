import { expect, it } from 'vitest';
import { MemoryRepository } from '../fixtures/memory';
import { encodeBackup, validateBackup } from '../../src/lib/domain/backup';
import { restoreItem } from '../../src/lib/domain/items';
import { WorkspaceController } from '../../src/lib/workspace/controller';
import type {
  Item,
  Location,
  WorkspaceSnapshot,
} from '../../src/lib/domain/notes';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const home: Location = { scope: 'live', itemId: null };
const trash: Location = { scope: 'trash', itemId: null };
const at = (n: number, scope: Location['scope'] = 'live'): Location => ({
  scope,
  itemId: id(n),
});
function item(
  n: number,
  parent: number | null,
  kind: Item['kind'],
  position: number,
): Item {
  return {
    id: id(n),
    parentId: parent === null ? null : id(parent),
    kind,
    position,
    markdown: '**exact**\r\n',
    done: true,
    color: 'purple',
    createdAt: 1,
    updatedAt: 2,
    deletedAt: null,
    restoreParentId: null,
    restoreIndex: null,
  };
}
function seed(): WorkspaceSnapshot {
  return {
    items: [
      item(1, null, 'stash', 0),
      item(2, null, 'stash', 1),
      item(3, 1, 'note', 0),
      item(4, 1, 'stash', 1),
      item(5, 1, 'note', 2),
      item(6, 4, 'note', 0),
    ],
    drafts: [],
    undoDeleteId: null,
  };
}
it('V5 retains independent note composer and restore references while V4 remains strict', () => {
  const s = seed();
  s.items = [
    item(1, null, 'note', 0),
    {
      ...item(2, null, 'note', 0),
      deletedAt: 3,
      restoreParentId: id(1),
      restoreIndex: 0,
    },
  ];
  s.drafts = [
    {
      key: `compose:${id(1)}`,
      markdown: 'capture\r\n',
      revision: 9,
      updatedAt: 4,
    },
  ];
  s.undoDeleteId = id(2);
  const text = encodeBackup(s);
  expect(JSON.parse(text).version).toBe(5);
  expect(validateBackup(text)).toHaveProperty('workspace', s);
  const old = JSON.parse(text);
  old.version = 4;
  expect(validateBackup(JSON.stringify(old))).toHaveProperty('code');
});
it('purge retains independent roots and unrelated Undo, repairs restore refs, and exactly replays', async () => {
  const r = new MemoryRepository();
  const s = seed();
  s.items[0].deletedAt = 3;
  s.items[1].deletedAt = 5;
  s.items[1].position = 1;
  s.items[1].restoreParentId = id(4);
  s.items[1].restoreIndex = 7;
  s.undoDeleteId = id(2);
  s.drafts = [
    { key: id(4), markdown: 'source', revision: 1, updatedAt: 2 },
    { key: `compose:${id(4)}`, markdown: 'capture', revision: 3, updatedAt: 4 },
    { key: 'compose:trash', markdown: 'keep', revision: 5, updatedAt: 6 },
  ];
  r.snapshot = s;
  const request = {
    id: id(4),
    location: at(1, 'trash'),
    expectedSubtreeIds: [id(4), id(6)],
  };
  const result = await r.purgeItem(request);
  expect(result.removedIds).toEqual([id(4), id(6)]);
  expect(result.workspace.items.map((x) => x.id)).toEqual([
    id(1),
    id(2),
    id(3),
    id(5),
  ]);
  expect(result.workspace.items[1]).toMatchObject({
    restoreParentId: null,
    restoreIndex: 7,
    updatedAt: 2,
  });
  expect(result.workspace.undoDeleteId).toBe(id(2));
  expect(result.workspace.drafts).toEqual([s.drafts[2]]);
  expect((await r.purgeItem(request)).workspace).toEqual(result.workspace);
  await expect(
    r.purgeItem({ id: id(2), location: home, expectedSubtreeIds: [id(2)] }),
  ).rejects.toBeDefined();
});
it('captured noncontiguous movement preserves source order, exact replay, and untouched timestamps', async () => {
  const r = new MemoryRepository();
  r.snapshot = seed();
  const c = new WorkspaceController(r);
  await c.start();
  const request = c.captureMove([id(5), id(3)], at(2), 0);
  expect(request.ids).toEqual([id(3), id(5)]);
  expect(await c.moveItems(request)).toBe(true);
  const after = structuredClone(r.snapshot);
  expect(
    after.items.filter((x) => x.parentId === id(2)).map((x) => x.id),
  ).toEqual([id(3), id(5)]);
  expect(await c.moveItems(request)).toBe(true);
  expect(r.snapshot).toEqual(after);
  for (const x of after.items)
    if (![id(3), id(5)].includes(x.id)) expect(x.updatedAt).toBe(2);
  c.dispose();
});
it('exit demotion preserves drafts and restore capability, and capture atomically reopens the note', async () => {
  const r = new MemoryRepository();
  r.snapshot = {
    items: [item(1, null, 'stash', 0)],
    drafts: [
      {
        key: `compose:${id(1)}`,
        markdown: 'capture\r\n',
        revision: 9,
        updatedAt: 4,
      },
    ],
    undoDeleteId: null,
  };
  const c = new WorkspaceController(r);
  await c.start();
  await c.openStash(id(1));
  const seen: Item['kind'][] = [];
  const unsubscribe = c.subscribe((s) => {
    if (s.location.itemId === id(1)) seen.push(s.snapshot.items[0].kind);
  });
  expect(await c.openStash(null)).toBe(true);
  expect(r.snapshot.items[0]).toEqual({ ...item(1, null, 'note', 0) });
  expect(seen).not.toContain('note');
  expect(c.sourceFor(`compose:${id(1)}`)).toBe('capture\r\n');
  await r.captureItem({
    id: id(2),
    location: at(1),
    markdown: 'new',
    draft: { key: `compose:${id(1)}`, revision: 8 },
  });
  expect(r.snapshot.items[0].kind).toBe('stash');
  expect(r.snapshot.drafts[0].revision).toBe(9);
  unsubscribe();
  c.dispose();
});
it('purge failure preserves exact buffers; acknowledged purge removes only target caches', async () => {
  const r = new MemoryRepository();
  r.snapshot = seed();
  r.snapshot.items[0].deletedAt = 3;
  const c = new WorkspaceController(r);
  await c.start();
  await c.openStash(id(4));
  c.editSource('owned composer');
  await c.selectNote(id(6));
  c.editSource('latest source');
  const request = c.capturePurge(id(4));
  r.fail = 'purge';
  expect(await c.purgeItem(request)).toBe(false);
  expect(c.sourceFor(id(6))).toBe('latest source');
  expect(c.state.buffers[`compose:${id(4)}`]).toBeDefined();
  r.fail = null;
  expect(await c.retryMutation()).toBe(true);
  expect(c.state.location).toEqual(at(1, 'trash'));
  expect(c.state.buffers[id(6)]).toBeUndefined();
  expect(c.state.buffers[`compose:${id(4)}`]).toBeUndefined();
  expect(c.state.purgedItemIds).toEqual([id(4), id(6)]);
  c.dispose();
});
it('Command-N atomically exits and demotes an unrelated empty current stash while keeping its composer', async () => {
  const r = new MemoryRepository();
  r.snapshot = {
    items: [item(1, null, 'stash', 0), item(2, null, 'note', 1)],
    drafts: [],
    undoDeleteId: null,
  };
  const c = new WorkspaceController(r);
  await c.start();
  await c.openStash(id(1));
  c.editSource('retained origin draft');
  c.setQuery('exact');
  const seen: boolean[] = [];
  const stop = c.subscribe((s) =>
    seen.push(
      s.location.itemId === id(1) && s.snapshot.items[0].kind === 'note',
    ),
  );
  expect(await c.createStash(id(2))).toBe(true);
  expect(r.snapshot.items[0].kind).toBe('note');
  expect(r.snapshot.items[1].kind).toBe('stash');
  expect(c.sourceFor(`compose:${id(1)}`)).toBe('retained origin draft');
  expect(seen).not.toContain(true);
  stop();
  c.dispose();
});
it('failed flush and same-location navigation never demote; successful captured Retry exits once', async () => {
  const r = new MemoryRepository();
  r.snapshot = {
    items: [item(1, null, 'stash', 0)],
    drafts: [],
    undoDeleteId: null,
  };
  const c = new WorkspaceController(r);
  await c.start();
  await c.openStash(id(1));
  expect(await c.newNote()).toBe(true);
  expect(r.snapshot.items[0].kind).toBe('stash');
  c.editSource('latest draft');
  r.fail = 'checkpoint';
  expect(await c.openStash(null)).toBe(false);
  expect(r.snapshot.items[0].kind).toBe('stash');
  expect(c.state.location).toEqual(at(1));
  r.fail = null;
  expect(await c.retryMutation()).toBe(true);
  expect(r.snapshot.items[0].kind).toBe('note');
  expect(c.sourceFor(`compose:${id(1)}`)).toBe('latest draft');
  c.dispose();
});
it('lost purge acknowledgment retains buffers until exact Retry and never recreates a purged capture', async () => {
  const r = new MemoryRepository();
  r.snapshot = {
    items: [{ ...item(1, null, 'stash', 0), deletedAt: 3 }],
    drafts: [],
    undoDeleteId: null,
  };
  const capture = r.captureItem.bind(r);
  let loseCapture = true;
  r.captureItem = async (request) => {
    const s = await capture(request);
    if (loseCapture) {
      loseCapture = false;
      throw Error('lost capture reply');
    }
    return s;
  };
  const c = new WorkspaceController(r);
  await c.start();
  await c.openStash(id(1));
  c.editSource('captured child');
  expect(await c.save()).toBe(false);
  const child = r.snapshot.items.find((x) => x.id !== id(1))!;
  // Authoritative reconciliation occurs before capturePurge to include uncertain children.
  await c.flush();
  await c.openLocation(trash);
  await c.openStash(id(1));
  const request = c.capturePurge(id(1));
  const purge = r.purgeItem.bind(r);
  let lost = true;
  r.purgeItem = async (request) => {
    const result = await purge(request);
    if (lost) {
      lost = false;
      throw Error('lost purge reply');
    }
    return result;
  };
  expect(await c.purgeItem(request)).toBe(false);
  expect(c.state.buffers[`compose:${id(1)}`]).toBeDefined();
  expect(await c.retryMutation()).toBe(true);
  expect(c.state.purgedItemIds).toContain(child.id);
  expect(r.snapshot.items).toEqual([]);
  expect(await c.save()).toBe(false);
  expect(r.snapshot.items).toEqual([]);
  c.dispose();
});
it('an uncertain capture is reconciled before moving it and its pending Save cannot duplicate newer source', async () => {
  const r = new MemoryRepository();
  r.snapshot = {
    items: [item(1, null, 'stash', 0), item(2, null, 'stash', 1)],
    drafts: [],
    undoDeleteId: null,
  };
  const capture = r.captureItem.bind(r);
  let lost = true;
  r.captureItem = async (request) => {
    const result = await capture(request);
    if (lost) {
      lost = false;
      throw Error('lost');
    }
    return result;
  };
  const c = new WorkspaceController(r);
  await c.start();
  await c.openStash(id(1));
  c.editSource('original');
  expect(await c.save()).toBe(false);
  await c.flush();
  await c.openLocation(home);
  await c.openStash(id(1));
  const child = r.snapshot.items.find((x) => x.id !== id(1) && x.id !== id(2))!;
  c.editSource('newer draft');
  expect(await c.moveItems(c.captureMove([child.id], at(2), 0))).toBe(true);
  expect(await c.save()).toBe(true);
  expect(
    r.snapshot.items.filter((x) => x.markdown === 'original'),
  ).toHaveLength(1);
  expect(c.state.source).toBe('newer draft');
  c.dispose();
});
it('stale purge membership rejects, and cross-scope, cycles, duplicate, and stale-order moves reject atomically', async () => {
  const r = new MemoryRepository();
  r.snapshot = seed();
  r.snapshot.items[0].deletedAt = 3;
  const before = structuredClone(r.snapshot);
  await expect(
    r.purgeItem({ id: id(1), location: trash, expectedSubtreeIds: [id(1)] }),
  ).rejects.toBeDefined();
  expect(r.snapshot).toEqual(before);
  const c = new WorkspaceController(r);
  await c.start();
  expect(() => c.captureMove([id(3)], at(2), 0)).toThrow();
  expect(() => c.captureMove([id(1)], at(4, 'trash'), 0)).toThrow();
  expect(() => c.captureMove([id(3), id(3)], trash, 0)).toThrow();
  const request = c.captureMove([id(3), id(5)], trash, 0);
  request.beforeFrom.reverse();
  expect(await c.moveItems(request)).toBe(false);
  expect(r.snapshot).toEqual(before);
  c.dispose();
});
it('20,000-deep purge is iterative and clears its Undo', async () => {
  const r = new MemoryRepository();
  r.snapshot = {
    items: Array.from({ length: 20000 }, (_, i) =>
      item(i + 1, i === 0 ? null : i, 'stash', 0),
    ),
    drafts: [],
    undoDeleteId: id(1),
  };
  r.snapshot.items[0].deletedAt = 3;
  const result = await r.purgeItem({
    id: id(1),
    location: trash,
    expectedSubtreeIds: r.snapshot.items.map((x) => x.id),
  });
  expect(result.workspace.items).toEqual([]);
  expect(result.workspace.undoDeleteId).toBeNull();
  expect(result.removedIds).toHaveLength(20000);
});
it('explicit same-ID reopen promotes a demoted note while preserving its separate composer', async () => {
  const r = new MemoryRepository();
  r.snapshot = {
    items: [item(1, null, 'note', 0)],
    drafts: [
      {
        key: `compose:${id(1)}`,
        markdown: 'separate',
        revision: 7,
        updatedAt: 4,
      },
    ],
    undoDeleteId: null,
  };
  const after = await r.transitionLocation({
    from: at(1),
    to: at(1),
    promoteDestination: true,
  });
  expect(after.items[0].kind).toBe('stash');
  expect(after.drafts[0].markdown).toBe('separate');
});
it('a successful newer visit preserves an older exact failed navigation Retry until acknowledgment', async () => {
  const r = new MemoryRepository();
  r.snapshot = seed();
  const c = new WorkspaceController(r);
  await c.start();
  await c.openStash(id(4));
  c.editSource('dirty');
  r.fail = 'checkpoint';
  expect(await c.openStash(id(1))).toBe(false);
  const retry = c.mutationRetryIdentity;
  expect(retry).not.toBeNull();
  r.fail = null;
  expect(await c.openStash(null)).toBe(true);
  expect(c.mutationRetryIdentity).toBe(retry);
  expect(c.state.mutationRetry).toBe(true);
  expect(await c.retryMutation()).toBe(true);
  expect(c.state.location).toEqual(at(1));
  expect(c.state.mutationRetry).toBe(false);
  c.dispose();
});
it('soft-deleting an open childless stash atomically demotes only the exited source while preserving its draft', async () => {
  const r = new MemoryRepository();
  r.snapshot = {
    items: [item(1, null, 'stash', 0)],
    drafts: [],
    undoDeleteId: null,
  };
  const c = new WorkspaceController(r);
  await c.start();
  await c.openStash(id(1));
  c.editSource('independent capture');
  expect(await c.remove(id(1))).toBe(true);
  expect(r.snapshot.items[0].kind).toBe('note');
  expect(c.state.location).toEqual(home);
  expect(c.sourceFor(`compose:${id(1)}`)).toBe('independent capture');
  expect(await c.undoRemove()).toBe(true);
  expect(r.snapshot.items[0].kind).toBe('note');
  c.dispose();
});
it('Retry acknowledges an already committed purge even when newer typing can no longer save its removed owner', async () => {
  const r = new MemoryRepository();
  r.snapshot = {
    items: [{ ...item(1, null, 'stash', 0), deletedAt: 3 }],
    drafts: [],
    undoDeleteId: null,
  };
  const c = new WorkspaceController(r);
  await c.start();
  await c.openStash(id(1));
  const request = c.capturePurge(id(1));
  const purge = r.purgeItem.bind(r);
  let lost = true;
  r.purgeItem = async (request) => {
    const result = await purge(request);
    if (lost) {
      lost = false;
      throw Error('lost reply');
    }
    return result;
  };
  expect(await c.purgeItem(request)).toBe(false);
  c.editSource('typed after the lost reply');
  expect(await c.retryMutation()).toBe(true);
  expect(c.state.location).toEqual(trash);
  expect(c.state.buffers[`compose:${id(1)}`]).toBeUndefined();
  expect(r.snapshot.items).toEqual([]);
  c.dispose();
});
it('queued newer navigation demotes every actually exited empty origin without publishing a note as current location', async () => {
  const r = new MemoryRepository();
  r.snapshot = {
    items: [
      item(1, null, 'stash', 0),
      item(2, null, 'stash', 1),
      item(3, null, 'stash', 2),
    ],
    drafts: [],
    undoDeleteId: null,
  };
  const c = new WorkspaceController(r);
  await c.start();
  await c.openStash(id(1));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let wrote!: () => void;
  const written = new Promise<void>((resolve) => (wrote = resolve));
  const transition = r.transitionLocation.bind(r);
  r.transitionLocation = async (request) => {
    const snapshot = await transition(request);
    if (request.to.itemId === id(2)) {
      wrote();
      await gate;
    }
    return snapshot;
  };
  const invalid: boolean[] = [];
  const visits: { id: string | null; op: string | null }[] = [];
  let previous: string | null = id(1);
  const stop = c.subscribe((s) => {
    if (s.location.itemId !== null)
      invalid.push(
        s.snapshot.items.find((x) => x.id === s.location.itemId)?.kind !==
          'stash',
      );
    if (s.location.itemId !== previous) {
      visits.push({ id: s.location.itemId, op: s.operation });
      previous = s.location.itemId;
    }
  });
  const first = c.openStash(id(2));
  await written;
  const second = c.openStash(id(3));
  c.setQuery('newer Search');
  release();
  expect(await first).toBe(false);
  expect(await second).toBe(true);
  expect(r.snapshot.items.map((x) => x.kind)).toEqual([
    'note',
    'note',
    'stash',
  ]);
  expect(c.state.location).toEqual(at(3));
  expect(c.state.query).toBe('newer Search');
  expect(invalid).not.toContain(true);
  expect(visits.find((x) => x.id === id(2))?.op).toBe('navigation-reconcile');
  stop();
  c.dispose();
});
it('neutral purge Retry preserves unrelated newer dirty root composers without attempting removed-owner writes', async () => {
  const r = new MemoryRepository();
  r.snapshot = {
    items: [{ ...item(1, null, 'stash', 0), deletedAt: 3 }],
    drafts: [],
    undoDeleteId: null,
  };
  const c = new WorkspaceController(r);
  await c.start();
  await c.openStash(id(1));
  const request = c.capturePurge(id(1));
  const purge = r.purgeItem.bind(r);
  let lost = true;
  r.purgeItem = async (request) => {
    const result = await purge(request);
    if (lost) {
      lost = false;
      throw Error('lost reply');
    }
    return result;
  };
  expect(await c.purgeItem(request)).toBe(false);
  c.editContext('compose', 'Home newer\r\n');
  c.editContext('compose:trash', 'Trash newer\r\n');
  c.editSource('removed newer');
  const checkpoints = r.checkpointCalls;
  expect(await c.retryMutation()).toBe(true);
  expect(r.checkpointCalls).toBe(checkpoints);
  expect(c.sourceFor('compose')).toBe('Home newer\r\n');
  expect(c.sourceFor('compose:trash')).toBe('Trash newer\r\n');
  expect(c.state.buffers[`compose:${id(1)}`]).toBeUndefined();
  expect(await c.flush()).toBe(true);
  expect(r.snapshot.drafts.map((x) => x.markdown).sort()).toEqual([
    'Home newer\r\n',
    'Trash newer\r\n',
  ]);
  expect(r.snapshot.items).toEqual([]);
  c.dispose();
});
it('Retry keeps its original destination but demotes the empty origin actually departed after newer navigation', async () => {
  const r = new MemoryRepository();
  r.snapshot = {
    items: [
      item(1, null, 'stash', 0),
      item(2, null, 'stash', 1),
      item(3, null, 'stash', 2),
    ],
    drafts: [],
    undoDeleteId: null,
  };
  const c = new WorkspaceController(r);
  await c.start();
  await c.openStash(id(1));
  r.fail = 'navigate';
  expect(await c.openStash(id(3))).toBe(false);
  r.fail = null;
  expect(await c.openStash(id(2))).toBe(true);
  expect(await c.retryMutation()).toBe(true);
  expect(r.snapshot.items.map((x) => x.kind)).toEqual([
    'note',
    'note',
    'stash',
  ]);
  expect(c.state.location).toEqual(at(3));
  c.dispose();
});
it('queued Command-N captures its actual exit origin after prior navigation ACK while preserving parent and creation identity', async () => {
  const r = new MemoryRepository();
  r.snapshot = {
    items: [
      item(1, null, 'stash', 0),
      item(2, null, 'stash', 1),
      item(3, null, 'note', 2),
    ],
    drafts: [],
    undoDeleteId: null,
  };
  const c = new WorkspaceController(r);
  await c.start();
  await c.openStash(id(1));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let wrote!: () => void;
  const written = new Promise<void>((resolve) => (wrote = resolve));
  const transition = r.transitionLocation.bind(r);
  r.transitionLocation = async (request) => {
    const result = await transition(request);
    if (request.to.itemId === id(2)) {
      wrote();
      await gate;
    }
    return result;
  };
  const calls: Parameters<MemoryRepository['createChildStash']>[0][] = [];
  const create = r.createChildStash.bind(r);
  r.createChildStash = async (request) => {
    calls.push(structuredClone(request));
    return create(request);
  };
  const visiting = c.openStash(id(2));
  await written;
  const creating = c.createStash(id(3));
  release();
  expect(await visiting).toBe(true);
  expect(await creating).toBe(true);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ parent: at(3), leave: at(2) });
  expect(r.snapshot.items.find((x) => x.id === id(1))?.kind).toBe('note');
  expect(r.snapshot.items.find((x) => x.id === id(2))?.kind).toBe('note');
  expect(r.snapshot.items.find((x) => x.id === calls[0].id)?.parentId).toBe(
    id(3),
  );
  expect(c.state.location).toEqual({ scope: 'live', itemId: calls[0].id });
  c.dispose();
});

for (const nextAction of ['Delete', 'Home', 'Home-clean'] as const)
  it(`a newer ${nextAction} failure preserves exact lost-purge reconciliation`, async () => {
    const r = new MemoryRepository();
    r.snapshot = {
      items: [{ ...item(1, null, 'stash', 0), deletedAt: 3 }],
      drafts: [],
      undoDeleteId: null,
    };
    const c = new WorkspaceController(r);
    await c.start();
    await c.openStash(id(1));
    const purge = r.purgeItem.bind(r);
    let lose = true;
    r.purgeItem = async (request) => {
      const result = await purge(request);
      if (lose) {
        lose = false;
        throw Error('lost purge reply');
      }
      return result;
    };
    expect(await c.purgeItem(c.capturePurge(id(1)))).toBe(false);
    expect(r.snapshot.items).toEqual([]);
    if (nextAction !== 'Home-clean')
      c.editSource('newer input for removed owner');
    expect(
      await (nextAction === 'Delete'
        ? c.purgeItem(c.capturePurge(id(1)))
        : c.openStash(null)),
    ).toBe(false);
    c.editContext('compose', 'surviving Home draft');
    expect(c.state.purgedItemIds).toEqual([]);
    expect(c.state.buffers[`compose:${id(1)}`]).toBeDefined();
    expect(await c.retryMutation()).toBe(true);
    expect(c.state.location).toEqual(trash);
    expect(c.state.buffers[`compose:${id(1)}`]).toBeUndefined();
    expect(c.sourceFor('compose')).toBe('surviving Home draft');
    expect(c.state.purgedItemIds).toEqual([id(1)]);
    if (nextAction !== 'Delete') {
      expect(c.state.mutationRetry).toBe(true);
      expect(await c.retryMutation()).toBe(true);
      expect(c.state.location).toEqual(home);
      expect(r.snapshot.drafts.find((x) => x.key === 'compose')?.markdown).toBe(
        'surviving Home draft',
      );
    } else expect(c.state.mutationRetry).toBe(false);
    c.dispose();
  });
it('a pending navigation checkpoint leaves editing available until the structural transition starts', async () => {
  const r = new MemoryRepository();
  const c = new WorkspaceController(r);
  await c.start();
  c.editSource('older');
  let release!: () => void;
  r.delayCheckpoint = new Promise<void>((resolve) => (release = resolve));
  const pending = c.newNote();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(r.checkpointCalls).toBe(1);
  expect(c.state.operation).toBeNull();
  c.editSource('latest');
  release();
  expect(await pending).toBe(true);
  expect(c.state.source).toBe('latest');
  expect(r.snapshot.drafts.find((x) => x.key === 'compose')?.markdown).toBe(
    'latest',
  );
  c.dispose();
});
function broadDeletedTree(width: number): WorkspaceSnapshot {
  const items: Item[] = [
    { ...item(1, null, 'stash', 0), deletedAt: 3 },
    { ...item(2, null, 'note', 1), deletedAt: 4 },
  ];
  // Interleave inherited siblings, topmost explicit roots, and deeper explicit records.
  for (let i = 0; i < width; i++) {
    const n = 3 + i * 4;
    items.push(item(n, 1, 'stash', i));
    items.push({
      ...item(n + 1, n, 'stash', 0),
      deletedAt: 5,
      restoreParentId: id(n),
      restoreIndex: 0,
    });
    items.push({
      ...item(n + 2, n + 1, 'note', 0),
      deletedAt: 6,
      restoreParentId: id(n + 1),
      restoreIndex: 0,
    });
    items.push(item(n + 3, n, 'note', 1));
  }
  return {
    items,
    drafts: [
      {
        key: `compose:${id(4)}`,
        markdown: 'retained\r\n',
        revision: 7,
        updatedAt: 8,
      },
    ],
    undoDeleteId: id(5),
  };
}
it('broad ancestor Restore keeps nearest explicit deletion roots, dense sibling order, drafts, and metadata', async () => {
  const r = new MemoryRepository();
  const before = broadDeletedTree(250);
  r.snapshot = structuredClone(before);
  const after = await r.restoreItem(id(1));
  const roots = after.items
    .filter((x) => x.parentId === null && x.deletedAt !== null)
    .sort((a, b) => a.position - b.position);
  expect(roots.map((x) => x.id)).toEqual([
    id(2),
    ...Array.from({ length: 250 }, (_, i) => id(4 + (249 - i) * 4)),
  ]);
  expect(roots.map((x) => x.position)).toEqual(roots.map((_, i) => i));
  const byId = new Map(after.items.map((x) => [x.id, x]));
  for (const original of before.items.slice(2)) {
    const x = byId.get(original.id)!;
    const detached = original.deletedAt === 5;
    expect(x).toEqual({
      ...original,
      parentId: detached ? null : original.parentId,
      position: detached
        ? roots.findIndex((y) => y.id === original.id)
        : original.parentId !== id(1) &&
            original.deletedAt === null &&
            original.position === 1
          ? 0
          : original.position,
    });
  }
  expect(after.drafts).toEqual(before.drafts);
  expect(after.undoDeleteId).toBe(before.undoDeleteId);
});
it('broad ancestor Restore has a bounded hierarchy-read budget at two widths', () => {
  for (const width of [100, 300]) {
    const s = broadDeletedTree(width);
    let reads = 0;
    for (const x of s.items) {
      let parent = x.parentId;
      Object.defineProperty(x, 'parentId', {
        enumerable: true,
        get() {
          reads++;
          return parent;
        },
        set(value) {
          parent = value;
        },
      });
    }
    const started = performance.now();
    restoreItem(s, id(1));
    console.info(
      `Restore ${s.items.length} items: ${reads} parent reads, ${(performance.now() - started).toFixed(2)} ms`,
    );
    expect(reads).toBeLessThan(100 * s.items.length);
    expect(s.items.filter((x) => x.parentId === null)).toHaveLength(width + 2);
  }
});

it('uncertain purge requires every captured ID absent and repository acknowledgment before retiring caches', async () => {
  const r = new MemoryRepository();
  const parent = { ...item(1, null, 'stash', 0), deletedAt: 3 };
  const child = item(2, 1, 'note', 0);
  r.snapshot = { items: [parent, child], drafts: [], undoDeleteId: null };
  const c = new WorkspaceController(r);
  await c.start();
  await c.openStash(id(1));
  c.editSource('parent composer');
  c.editContext(id(2), 'child source');
  const purge = r.purgeItem.bind(r);
  let lost = true;
  r.purgeItem = async (request) => {
    const result = await purge(request);
    if (lost) {
      lost = false;
      throw Error('lost purge reply');
    }
    return result;
  };
  expect(await c.purgeItem(c.capturePurge(id(1)))).toBe(false);
  // Simulate a surviving captured ID in a different valid authoritative tree.
  r.snapshot.items = [{ ...child, parentId: null, deletedAt: 3 }];
  expect(await c.retryMutation()).toBe(false);
  expect(c.state.buffers[`compose:${id(1)}`]).toBeDefined();
  expect(c.state.buffers[id(2)]).toBeDefined();
  expect(c.state.purgedItemIds).toEqual([]);
  r.snapshot.items = [];
  r.fail = 'purge';
  expect(await c.retryMutation()).toBe(false);
  expect(c.state.buffers[id(2)]).toBeDefined();
  expect(c.state.purgedItemIds).toEqual([]);
  r.fail = null;
  expect(await c.retryMutation()).toBe(true);
  expect(c.state.buffers[id(2)]).toBeUndefined();
  expect(c.state.buffers[`compose:${id(1)}`]).toBeUndefined();
  expect(c.state.purgedItemIds).toEqual([id(1), id(2)]);
  c.dispose();
});

it('prioritized purge reconciliation preserves the newer exact color retry and its separate identity', async () => {
  const r = new MemoryRepository();
  r.snapshot = {
    items: [
      { ...item(1, null, 'stash', 0), deletedAt: 3 },
      item(2, null, 'note', 0),
    ],
    drafts: [],
    undoDeleteId: null,
  };
  const c = new WorkspaceController(r);
  await c.start();
  await c.openStash(id(1));
  const purge = r.purgeItem.bind(r);
  let lost = true;
  r.purgeItem = async (request) => {
    const result = await purge(request);
    if (lost) {
      lost = false;
      throw Error('lost purge reply');
    }
    return result;
  };
  expect(await c.purgeItem(c.capturePurge(id(1)))).toBe(false);
  const purgeRetry = c.mutationRetryIdentity;
  r.fail = 'color';
  expect(await c.setItemColor(id(2), 'blue')).toBe(false);
  const colorRetry = c.commandRetryIdentity;
  expect(colorRetry).toBeTypeOf('function');
  expect(c.mutationRetryIdentity).toBe(purgeRetry);
  expect(colorRetry).not.toBe(purgeRetry);
  // Even a failed purge reconciliation may not replace the newer color closure.
  r.fail = 'purge';
  expect(await c.retryMutation()).toBe(false);
  expect(c.commandRetryIdentity).toBe(colorRetry);
  r.fail = null;
  expect(await c.retryMutation()).toBe(true);
  expect(c.state.location).toEqual(trash);
  expect(c.mutationRetryIdentity).toBe(colorRetry);
  expect(c.state.mutationRetry).toBe(true);
  expect(r.snapshot.items[0].color).toBe('purple');
  expect(await c.retryMutation()).toBe(true);
  expect(r.snapshot.items[0]).toMatchObject({ id: id(2), color: 'blue' });
  expect(c.mutationRetryIdentity).toBeNull();
  c.dispose();
});
