import { describe, it, expect } from 'vitest';
import { MemoryRepository } from '../fixtures/memory';
import { validateBackup, encodeBackup } from '../../src/lib/domain/backup';
const a = '00000000-0000-4000-8000-000000000001';
const b = '00000000-0000-4000-8000-000000000002';
const home = { scope: 'live' as const, itemId: null };
describe('unified source-bearing items', () => {
  it('atomically promotes and creates with caller identity, preserving source and buffers', async () => {
    const r = new MemoryRepository();
    await r.captureItem({
      id: a,
      location: home,
      markdown: '**source**\r\n',
      draft: { key: 'compose', revision: 0 },
    });
    await r.checkpointDraft(a, 'buffer', 3);
    await r.createChildStash({ id: b, parent: { scope: 'live', itemId: a } });
    expect(r.snapshot.items.find((x) => x.id === a)).toMatchObject({
      kind: 'stash',
      markdown: '**source**\r\n',
      position: 0,
    });
    expect(r.snapshot.drafts[0]).toMatchObject({ key: a, markdown: 'buffer' });
    const before = structuredClone(r.snapshot);
    await r.createChildStash({ id: b, parent: { scope: 'live', itemId: a } });
    expect(r.snapshot).toEqual(before);
  });
  it('retains deleted trees, drafts, and one-step Undo across neutral deletion', async () => {
    const r = new MemoryRepository();
    await r.createChildStash({ id: a, parent: home });
    await r.captureItem({
      id: b,
      location: { scope: 'live', itemId: a },
      markdown: 'child',
      draft: { key: `compose:${a}`, revision: 0 },
    });
    await r.checkpointDraft(b, 'retained', 2);
    await r.deleteItem(a);
    const before = structuredClone(r.snapshot);
    await r.deleteItem(a);
    expect(r.snapshot).toEqual(before);
    await r.undoDelete();
    expect(r.snapshot.items).toHaveLength(2);
    expect(r.snapshot.items.find((x) => x.id === b)?.parentId).toBe(a);
    expect(r.snapshot.drafts[0].markdown).toBe('retained');
  });
  it('exports strict version 5 and rejects duplicate sibling ranks', async () => {
    const r = new MemoryRepository();
    await r.createChildStash({ id: a, parent: home });
    await r.createChildStash({ id: b, parent: home });
    expect(JSON.parse(encodeBackup(r.snapshot)).version).toBe(5);
    r.snapshot.items[1].position = 0;
    expect(validateBackup(encodeBackup(r.snapshot))).toHaveProperty('code');
  });
});

import { WorkspaceController } from '../../src/lib/workspace/controller';
it('controller Command-N captures selected note parent and retries its same creation identity', async () => {
  const r = new MemoryRepository();
  const c = new WorkspaceController(r);
  await c.start();
  c.editSource('parent');
  await c.save();
  const id = r.snapshot.items[0].id;
  await c.selectNote(id);
  c.editSource('latest\r\n');
  r.fail = 'create';
  expect(await c.createStash(id)).toBe(false);
  expect(r.snapshot.items[0].kind).toBe('note');
  r.fail = null;
  expect(await c.retryMutation()).toBe(true);
  expect(r.snapshot.items).toHaveLength(2);
  expect(r.snapshot.items.find((x) => x.id === id)).toMatchObject({
    kind: 'stash',
    markdown: 'latest\r\n',
  });
  expect(c.state.stashId).toBe(r.snapshot.items.find((x) => x.id !== id)?.id);
  c.dispose();
});

it('normalizes sparse imported ranks before insertion without changing sibling content times', async () => {
  const r = new MemoryRepository();
  await r.createChildStash({ id: a, parent: home });
  await r.createChildStash({ id: b, parent: home });
  r.snapshot.items[0].position = 2;
  r.snapshot.items[1].position = 9;
  const times = r.snapshot.items.map((x) => x.updatedAt);
  await r.createChildStash({
    id: '00000000-0000-4000-8000-000000000003',
    parent: home,
  });
  expect(r.snapshot.items.map((x) => x.position)).toEqual([0, 1, 2]);
  expect(r.snapshot.items.slice(0, 2).map((x) => x.updatedAt)).toEqual(times);
});
it('stale malformed checkpoints reject just like native requests', async () => {
  const r = new MemoryRepository();
  await r.checkpointDraft('compose', 'saved', 2);
  const before = structuredClone(r.snapshot);
  await expect(r.checkpointDraft('compose', 'x', -1)).rejects.toBeTruthy();
  expect(r.snapshot).toEqual(before);
});

it('failed latest-source flush leaves a structural action retry rather than requiring capture', async () => {
  const r = new MemoryRepository(),
    c = new WorkspaceController(r);
  await c.start();
  c.editSource('target');
  await c.save();
  const id = r.snapshot.items[0].id;
  await c.selectNote(id);
  c.editSource('retained');
  r.fail = 'save';
  expect(await c.remove(id)).toBe(false);
  expect(c.state.mutationRetry).toBe(true);
  r.fail = null;
  expect(await c.retryMutation()).toBe(true);
  expect(r.snapshot.items).toHaveLength(1);
  expect(r.snapshot.items[0]).toMatchObject({ markdown: 'retained' });
  expect(r.snapshot.items[0].deletedAt).not.toBeNull();
  c.dispose();
});

import { item } from '../fixtures/items';
import {
  directEntries,
  scopeIndex,
  itemLabel,
  createHierarchyPresentation,
} from '../../src/lib/domain/hierarchy';
import { filterNotes } from '../../src/lib/domain/search';
import { readFileSync } from 'node:fs';
it('converts frozen legacy fixtures only after strict old validation, retaining every source/draft field', () => {
  for (const version of [1, 2, 3]) {
    const text = readFileSync(`tests/fixtures/valid-v${version}.json`, 'utf8');
    const b = validateBackup(text);
    expect(b).toHaveProperty('version', 5);
    if ('code' in b) throw b;
    const old = JSON.parse(text).workspace;
    for (const n of old.notes) {
      expect(b.workspace.items.find((x) => x.id === n.id)).toMatchObject({
        id: n.id,
        markdown: n.markdown,
        createdAt: n.createdAt,
        updatedAt: n.updatedAt,
        deletedAt: n.deletedAt,
        done: n.done ?? false,
      });
    }
    expect(b.workspace.drafts).toEqual(old.drafts);
    expect(b.workspace.undoDeleteId).toBe(old.undoDeleteId);
    const bad = JSON.parse(text);
    bad.workspace.notes[0].color = null;
    expect(validateBackup(JSON.stringify(bad))).toHaveProperty('code');
  }
});
it('validates current graph, exact case references, metadata, duplicate positions, and draft keys strictly', () => {
  const valid = {
    items: [item({ id: a, kind: 'stash' }), item({ id: b, parentId: a })],
    drafts: [],
    undoDeleteId: null,
  };
  expect(validateBackup(encodeBackup(valid))).toHaveProperty('version', 5);
  for (const mutate of [
    (s: any) => (s.items[0].parentId = b),
    (s: any) => (s.items[1].parentId = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'),
    (s: any) => (s.items[0].color = 3),
    (s: any) => (s.items[0].restoreIndex = 0),
    (s: any) => (s.items[1].deletedAt = 0),
    (s: any) => (s.items[1].id = a.toUpperCase()),
    (s: any) =>
      s.drafts.push({
        key: 'compose:00000000-0000-4000-8000-999999999999',
        markdown: '',
        revision: 0,
        updatedAt: 0,
      }),
    (s: any) => (s.undoDeleteId = b),
  ]) {
    const s = structuredClone(valid);
    mutate(s);
    expect(validateBackup(encodeBackup(s))).toHaveProperty('code');
  }
});
it('keeps global saved-source search separate from manual order and excludes inherited Trash', () => {
  const items = [
    item({
      id: a,
      kind: 'stash',
      markdown: 'shared stash',
      position: 8,
      createdAt: 1,
      updatedAt: 1,
    }),
    item({
      id: b,
      markdown: 'shared note',
      position: 0,
      createdAt: 2,
      updatedAt: 2,
    }),
  ];
  expect(
    directEntries({ items, drafts: [], undoDeleteId: null }, home).map(
      (x) => x.id,
    ),
  ).toEqual([b, a]);
  expect(filterNotes(items, 'shared').map((x) => x.id)).toEqual([a, b]);
  items[0].deletedAt = 0;
  items[1].parentId = a;
  expect(filterNotes(items, 'shared')).toEqual([]);
  expect(filterNotes(items, 'shared', 'trash')).toHaveLength(2);
});
it('bounds current source previews and handles a deep 20000-item tree without recursive graph walks', () => {
  const items = Array.from({ length: 20000 }, (_, i) =>
    item({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      kind: 'stash',
      markdown: '😀'.repeat(60),
      parentId:
        i === 0
          ? null
          : `00000000-0000-4000-8000-${String(i - 1).padStart(12, '0')}`,
    }),
  );
  expect(scopeIndex(items).size).toBe(20000);
  expect(Array.from(itemLabel(items[0]))).toHaveLength(32);
  const presentation = createHierarchyPresentation(items);
  expect(presentation.label(items.at(-1)!.id).depth).toBe(20000);
  expect(
    Array.from(presentation.label(items.at(-1)!.id).text).length,
  ).toBeLessThanOrEqual(96);
  expect(
    validateBackup(encodeBackup({ items, drafts: [], undoDeleteId: null })),
  ).toHaveProperty('version', 5);
});
it('keeps a failed capacity-limited atomic promotion/create unchanged, including drafts and metadata', async () => {
  const r = new MemoryRepository();
  r.snapshot.items = Array.from({ length: 20000 }, (_, i) =>
    item({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      position: i,
    }),
  );
  r.snapshot.drafts = [
    {
      key: r.snapshot.items[0].id,
      markdown: 'recovery',
      revision: 1,
      updatedAt: 0,
    },
  ];
  const before = structuredClone(r.snapshot);
  await expect(
    r.createChildStash({
      id: '00000000-0000-4001-8000-000000000000',
      parent: { scope: 'live', itemId: r.snapshot.items[0].id },
    }),
  ).rejects.toBeTruthy();
  expect(r.snapshot).toEqual(before);
});
it('accepts the 20000-item and 40002 canonical draft ceilings when their complete envelope fits', () => {
  const items = Array.from({ length: 20000 }, (_, i) =>
    item({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      kind: 'stash',
      position: i,
    }),
  );
  const drafts = items
    .flatMap((x) => [x.id, `compose:${x.id}`])
    .concat(['compose', 'compose:trash'])
    .map((key) => ({ key, markdown: '', revision: 0, updatedAt: 0 }));
  const workspace = { items, drafts, undoDeleteId: null };
  expect(validateBackup(encodeBackup(workspace))).toHaveProperty(
    'workspace.drafts.length',
    40002,
  );
  workspace.drafts.push({
    key: 'overflow',
    markdown: '',
    revision: 0,
    updatedAt: 0,
  });
  expect(validateBackup(encodeBackup(workspace))).toHaveProperty('code');
});

it('capture retries a lost acknowledgment with the same identity instead of duplicating saved content', async () => {
  class LostAck extends MemoryRepository {
    lost = true;
    override async captureItem(
      request: Parameters<MemoryRepository['captureItem']>[0],
    ) {
      const result = await super.captureItem(request);
      if (this.lost) {
        this.lost = false;
        throw new Error('Synthetic lost acknowledgment');
      }
      return result;
    }
  }
  const r = new LostAck(),
    c = new WorkspaceController(r);
  await c.start();
  c.editSource('single intent');
  expect(await c.save()).toBe(false);
  const id = r.snapshot.items[0].id;
  expect(c.state.source).toBe('single intent');
  expect(await c.save()).toBe(true);
  expect(r.snapshot.items).toHaveLength(1);
  expect(r.snapshot.items[0].id).toBe(id);
  expect(c.state.source).toBe('');
  c.dispose();
});
it('child creation retries a lost acknowledgment without another promotion or child', async () => {
  class LostAck extends MemoryRepository {
    lost = true;
    override async createChildStash(
      request: Parameters<MemoryRepository['createChildStash']>[0],
    ) {
      const result = await super.createChildStash(request);
      if (this.lost) {
        this.lost = false;
        throw new Error('Synthetic lost acknowledgment');
      }
      return result;
    }
  }
  const r = new LostAck(),
    c = new WorkspaceController(r);
  await c.start();
  c.editSource('parent');
  await c.save();
  const id = r.snapshot.items[0].id;
  expect(await c.createStash(id)).toBe(false);
  const before = structuredClone(r.snapshot);
  expect(await c.retryMutation()).toBe(true);
  expect(r.snapshot).toEqual(before);
  expect(r.snapshot.items).toHaveLength(2);
  c.dispose();
});
it('deleting an ancestor from global search returns to the surviving parent and preserves scoped buffers', async () => {
  const r = new MemoryRepository(),
    c = new WorkspaceController(r);
  await c.start();
  await c.createStash();
  const parent = c.state.stashId!;
  await c.createStash();
  const child = c.state.stashId!;
  c.editSource('child draft');
  await c.flush();
  c.setQuery('Untitled');
  expect(await c.remove(parent)).toBe(true);
  expect(c.state.location).toEqual(home);
  expect(c.sourceFor(`compose:${child}`)).toBe('child draft');
  expect(r.snapshot.items.find((x) => x.id === child)?.parentId).toBe(parent);
  await c.undoRemove();
  // Deleting its ancestor exited this childless stash; explicitly reopening the
  // retained note promotes the same owner and restores its independent composer.
  await c.enterItem(child);
  expect(c.state.source).toBe('child draft');
  c.dispose();
});
it('newer navigation during delayed deletion retains its requested context', async () => {
  const r = new MemoryRepository(),
    c = new WorkspaceController(r);
  await c.start();
  await c.createStash();
  const parent = c.state.stashId!;
  c.editSource('target');
  await c.save();
  const target = r.snapshot.items.find((x) => x.kind === 'note')!.id;
  await c.selectNote(target);
  c.editSource('latest');
  let release!: () => void;
  r.delaySave = new Promise<void>((resolve) => (release = resolve));
  const deletion = c.remove(target);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const navigation = c.openStash(null);
  release();
  expect(await deletion).toBe(true);
  expect(await navigation).toBe(true);
  expect(c.state.location).toEqual(home);
  expect(c.sourceFor(target)).toBe('latest');
  expect(r.snapshot.items.find((x) => x.id === target)?.restoreParentId).toBe(
    parent,
  );
  c.dispose();
});
it('capture whitespace agrees with native ECMAScript trimming and preserves nonblank Unicode source', async () => {
  const r = new MemoryRepository();
  for (const markdown of ['', ' \r\n\t', '\ufeff'])
    await expect(
      r.captureItem({
        id: a,
        location: home,
        markdown,
        draft: { key: 'compose', revision: 0 },
      }),
    ).rejects.toBeTruthy();
  await r.captureItem({
    id: a,
    location: home,
    markdown: '\u0085',
    draft: { key: 'compose', revision: 0 },
  });
  expect(r.snapshot.items[0].markdown).toBe('\u0085');
});
it('accepts the shared synthetic V4 fixture exactly, including color and Trash draft scopes', () => {
  const text = readFileSync('tests/fixtures/valid-v4.json', 'utf8');
  expect(validateBackup(text)).toEqual({ ...JSON.parse(text), version: 5 });
});

for (const later of ['single intent!', 'single intent', ''])
  it(`reconciles an immutable lost-ack capture while retaining newer composer revision: ${JSON.stringify(later)}`, async () => {
    class LostAck extends MemoryRepository {
      lost = true;
      override async captureItem(
        request: Parameters<MemoryRepository['captureItem']>[0],
      ) {
        const result = await super.captureItem(request);
        if (this.lost) {
          this.lost = false;
          throw new Error('Synthetic lost acknowledgment');
        }
        return result;
      }
    }
    const r = new LostAck(),
      c = new WorkspaceController(r);
    try {
      await c.start();
      c.editSource('single intent');
      expect(await c.save()).toBe(false);
      const original = structuredClone(r.snapshot.items[0]);
      c.editSource('temporary changed source');
      c.editSource(later);
      const revision = c.state.revision;
      await c.flush();
      expect(await c.save()).toBe(true);
      expect(r.snapshot.items).toEqual([original]);
      expect(c.state.buffers.compose).toEqual({ source: later, revision });
      expect(c.state.source).toBe(later);
      expect(r.snapshot.drafts.find((d) => d.key === 'compose')).toMatchObject({
        markdown: later,
        revision,
      });
    } finally {
      c.dispose();
    }
  });
it('retains an unresolved Home capture while another composer captures, then reconciles Home without duplicating or clearing newer source', async () => {
  class LostAck extends MemoryRepository {
    lost = true;
    override async captureItem(
      request: Parameters<MemoryRepository['captureItem']>[0],
    ) {
      const result = await super.captureItem(request);
      if (this.lost) {
        this.lost = false;
        throw new Error('Synthetic lost acknowledgment');
      }
      return result;
    }
  }
  const r = new LostAck(),
    c = new WorkspaceController(r);
  try {
    await c.start();
    c.editSource('Home original');
    expect(await c.save()).toBe(false);
    const original = structuredClone(r.snapshot.items[0]);
    c.editSource('Home later');
    const revision = c.state.revision;
    await c.createStash();
    const owner = c.state.stashId!;
    c.editSource('Other capture');
    expect(await c.save()).toBe(true);
    await c.openStash(null);
    expect(await c.save()).toBe(true);
    expect(r.snapshot.items.filter((x) => x.kind === 'note')).toHaveLength(2);
    expect(r.snapshot.items.find((x) => x.id === original.id)).toEqual(
      original,
    );
    expect(
      r.snapshot.items.find((x) => x.markdown === 'Other capture')?.parentId,
    ).toBe(owner);
    expect(c.state.buffers.compose).toEqual({ source: 'Home later', revision });
    expect(r.snapshot.drafts.find((d) => d.key === 'compose')).toMatchObject({
      markdown: 'Home later',
      revision,
    });
  } finally {
    c.dispose();
  }
});

it('recovers from definitively rejected oversized capture after editing to valid source', async () => {
  const r = new MemoryRepository(),
    c = new WorkspaceController(r);
  try {
    await c.start();
    c.editSource('x'.repeat(1024 * 1024 + 1));
    expect(await c.save()).toBe(false);
    expect(r.snapshot.items).toHaveLength(0);
    c.editSource('valid replacement');
    expect(await c.save()).toBe(true);
    expect(r.snapshot.items).toHaveLength(1);
    expect(r.snapshot.items[0].markdown).toBe('valid replacement');
    expect(c.state.source).toBe('');
  } finally {
    c.dispose();
  }
});
it('recovers from definitively rejected complete-envelope capacity after reducing an individually legal capture', async () => {
  const { MAX_SOURCE, MAX_ENVELOPE } =
    await import('../../src/lib/domain/notes');
  const r = new MemoryRepository();
  r.snapshot.items = Array.from({ length: 9 }, (_, i) =>
    item({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      markdown: 'x'.repeat(MAX_SOURCE),
      position: i,
    }),
  );
  r.snapshot.drafts = [
    { key: r.snapshot.items[0].id, markdown: '', revision: 1, updatedAt: 0 },
  ];
  r.snapshot.drafts[0].markdown = 'x'.repeat(
    MAX_ENVELOPE -
      2048 -
      new TextEncoder().encode(encodeBackup(r.snapshot)).length,
  );
  expect(validateBackup(encodeBackup(r.snapshot))).toHaveProperty('version', 5);
  const before = structuredClone(r.snapshot),
    c = new WorkspaceController(r);
  try {
    await c.start();
    c.editSource('y'.repeat(4096));
    expect(await c.save()).toBe(false);
    expect(r.snapshot).toEqual(before);
    c.editSource('valid reduced source');
    expect(await c.save()).toBe(true);
    expect(r.snapshot.items).toHaveLength(10);
    expect(
      r.snapshot.items.find((x) => !before.items.some((old) => old.id === x.id))
        ?.markdown,
    ).toBe('valid reduced source');
    expect(r.snapshot.drafts).toEqual(before.drafts);
    expect(c.state.source).toBe('');
  } finally {
    c.dispose();
  }
});
it('retains an uncertain capture when post-failure reconciliation cannot read, then retries the original source and identity', async () => {
  class Uncertain extends MemoryRepository {
    unreadable = false;
    lost = true;
    override async loadWorkspace() {
      if (this.unreadable)
        throw new Error('Synthetic unavailable reconciliation');
      return super.loadWorkspace();
    }
    override async captureItem(
      request: Parameters<MemoryRepository['captureItem']>[0],
    ) {
      const result = await super.captureItem(request);
      if (this.lost) {
        this.lost = false;
        this.unreadable = true;
        throw new Error('Synthetic transport failure');
      }
      return result;
    }
  }
  const r = new Uncertain(),
    c = new WorkspaceController(r);
  try {
    await c.start();
    c.editSource('original uncertain source');
    expect(await c.save()).toBe(false);
    const original = structuredClone(r.snapshot.items[0]);
    c.editSource('newer source');
    r.unreadable = false;
    expect(await c.save()).toBe(true);
    expect(r.snapshot.items).toEqual([original]);
    expect(c.state.source).toBe('newer source');
  } finally {
    c.dispose();
  }
});
