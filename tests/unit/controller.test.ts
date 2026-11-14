import { describe, it, expect } from 'vitest';
import { WorkspaceController } from '../../src/lib/workspace/controller';
import { MemoryRepository } from '../fixtures/memory';
const tick = () => new Promise((r) => setTimeout(r, 0));
describe('ordered workspace', () => {
  it('retains newer compose input during a delayed save and checkpoints after acknowledgment', async () => {
    const repo = new MemoryRepository();
    const c = new WorkspaceController(repo);
    await c.start();
    c.editSource('first');
    let release!: () => void;
    repo.delaySave = new Promise<void>((r) => (release = r));
    const saving = c.save();
    await tick();
    c.editSource('newer');
    release();
    await saving;
    expect(c.state.source).toBe('newer');
    await c.flush();
    expect(
      repo.snapshot.drafts.find((d) => d.key === c.state.activeKey)?.markdown,
    ).toBe('newer');
    c.dispose();
  });
  it('failed flush prevents navigation, then retry saves once', async () => {
    const repo = new MemoryRepository();
    const c = new WorkspaceController(repo);
    await c.start();
    c.editSource('retained');
    repo.fail = 'checkpoint';
    expect(await c.newNote()).toBe(false);
    expect(c.state.source).toBe('retained');
    repo.fail = null;
    await c.save();
    expect(repo.snapshot.items.filter((x) => x.kind === 'note')).toHaveLength(
      1,
    );
    c.dispose();
  });
  it('retains selection/source outside filtered results and query through save', async () => {
    const repo = new MemoryRepository();
    const c = new WorkspaceController(repo);
    await c.start();
    c.editSource('alpha');
    await c.save();
    await c.selectNote(
      repo.snapshot.items.filter((x) => x.kind === 'note')[0].id,
    );
    c.setQuery('alpha');
    c.editSource('beta');
    await c.save();
    expect(
      repo.snapshot.items.filter((x) => x.kind === 'note')[0].markdown,
    ).toBe('beta');
    expect(c.state.query).toBe('alpha');
    expect(c.visibleNotes).toHaveLength(0);
    c.dispose();
  });
  it('load failure offers retry, and disposal rejects late view changes', async () => {
    const repo = new MemoryRepository();
    repo.fail = 'load';
    const c = new WorkspaceController(repo);
    expect(await c.start()).toBe(false);
    expect(c.state.loaded).toBe(false);
    repo.fail = null;
    await c.start();
    expect(c.state.loaded).toBe(true);
    c.dispose();
    const before = c.state;
    c.editSource('ignored');
    expect(c.state).toEqual(before);
  });
});

it('queued context transition after delayed save never loses later typing', async () => {
  const repo = new MemoryRepository();
  const c = new WorkspaceController(repo);
  await c.start();
  c.editSource('captured');
  let release!: () => void;
  repo.delaySave = new Promise<void>((r) => (release = r));
  const saving = c.save();
  await tick();
  c.editSource('continued capture');
  const navigate = c.newNote();
  release();
  await saving;
  await navigate;
  expect(c.state.source).toBe('continued capture');
  expect(repo.snapshot.drafts[0].markdown).toBe('continued capture');
  c.dispose();
});
it('save retry and rapid repeated submission create exactly one note', async () => {
  const repo = new MemoryRepository();
  const c = new WorkspaceController(repo);
  await c.start();
  c.editSource('one');
  repo.fail = 'save';
  expect(await c.save()).toBe(false);
  expect(c.state.source).toBe('one');
  repo.fail = null;
  await Promise.all([c.save(), c.save()]);
  expect(repo.snapshot.items.filter((x) => x.kind === 'note')).toHaveLength(1);
  c.dispose();
});
it('disposal during delayed save emits no late state', async () => {
  const repo = new MemoryRepository();
  const c = new WorkspaceController(repo);
  await c.start();
  c.editSource('saved');
  let release!: () => void;
  repo.delaySave = new Promise<void>((r) => (release = r));
  const saving = c.save();
  await tick();
  c.dispose();
  const before = c.state;
  release();
  await saving;
  expect(c.state).toEqual(before);
});

for (const operation of ['newNote', 'flush'] as const) {
  it(`drains actual pending checkpoint through latest input before ${operation} succeeds`, async () => {
    const repo = new MemoryRepository();
    const c = new WorkspaceController(repo);
    try {
      await c.start();
      c.editSource('older');
      let release!: () => void;
      repo.delayCheckpoint = new Promise<void>(
        (resolve) => (release = resolve),
      );
      const p = c[operation]();
      await tick();
      expect(repo.checkpointCalls).toBe(1);
      c.editSource('latest');
      release();
      expect(await p).toBe(true);
      expect(c.state.source).toBe('latest');
      expect(
        repo.snapshot.drafts.find((d) => d.key === 'compose')?.markdown,
      ).toBe('latest');
      expect(repo.checkpointCalls).toBe(2);
    } finally {
      c.dispose();
    }
  });
  it(`failed latest follow-up checkpoint prevents ${operation} completion and retains input`, async () => {
    const repo = new MemoryRepository();
    const c = new WorkspaceController(repo);
    try {
      await c.start();
      c.editSource('older');
      let release!: () => void;
      repo.delayCheckpoint = new Promise<void>(
        (resolve) => (release = resolve),
      );
      repo.failCheckpointCall = 2;
      const p = c[operation]();
      await tick();
      c.editSource('latest');
      release();
      expect(await p).toBe(false);
      expect(c.state.source).toBe('latest');
      expect(c.state.error).toContain('failure');
      expect(repo.snapshot.drafts[0].markdown).toBe('older');
      repo.failCheckpointCall = null;
      expect(await c.flush()).toBe(true);
      expect(repo.snapshot.drafts[0].markdown).toBe('latest');
    } finally {
      c.dispose();
    }
  });
}
it('note selection waits for the latest save and restores that source on return', async () => {
  const repo = new MemoryRepository();
  const c = new WorkspaceController(repo);
  try {
    await c.start();
    c.editSource('saved');
    await c.save();
    const id = repo.snapshot.items.filter((x) => x.kind === 'note')[0].id;
    await c.selectNote(id);
    c.editSource('older edit');
    let release!: () => void;
    repo.delaySave = new Promise<void>((resolve) => (release = resolve));
    const navigate = c.newNote();
    await tick();
    c.editSource('latest edit');
    release();
    expect(await navigate).toBe(true);
    expect(c.state.activeKey).toBe('compose');
    await c.selectNote(id);
    expect(c.state.source).toBe('latest edit');
  } finally {
    c.dispose();
  }
});

it('capture clears only after success and stays in compose; whitespace is retained without a save', async () => {
  const repo = new MemoryRepository();
  const c = new WorkspaceController(repo);
  await c.start();
  c.editSource(' **capture** ');
  await c.save();
  expect(c.state.activeKey).toBe('compose');
  expect(c.state.source).toBe('');
  expect(repo.snapshot.items.filter((x) => x.kind === 'note')[0].markdown).toBe(
    ' **capture** ',
  );
  c.editSource('  \n');
  expect(await c.save()).toBe(false);
  expect(c.state.source).toBe('  \n');
  expect(repo.snapshot.items.filter((x) => x.kind === 'note')).toHaveLength(1);
  c.dispose();
});
it('inline finish saves edits while composer and resumable contexts remain independent', async () => {
  const repo = new MemoryRepository();
  const c = new WorkspaceController(repo);
  await c.start();
  c.editSource('saved');
  await c.save();
  const id = repo.snapshot.items.filter((x) => x.kind === 'note')[0].id;
  c.editSource('capture draft');
  await c.selectNote(id);
  c.editSource('unfinished');
  await c.newNote();
  expect(c.state.source).toBe('capture draft');
  await c.selectNote(id);
  expect(c.state.source).toBe('unfinished');
  expect(await c.finishEdit()).toBe(true);
  expect(repo.snapshot.drafts.some((d) => d.key === id)).toBe(false);
  expect(repo.snapshot.items.filter((x) => x.kind === 'note')[0].markdown).toBe(
    'unfinished',
  );
  expect(c.state.source).toBe('capture draft');
  c.dispose();
});
it('persists composer typing independently during an inline save and retains a later inline revision', async () => {
  const repo = new MemoryRepository();
  const c = new WorkspaceController(repo);
  await c.start();
  c.editSource('saved');
  await c.save();
  const id = repo.snapshot.items.filter((x) => x.kind === 'note')[0].id;
  await c.selectNote(id);
  c.editSource('captured edit');
  let release!: () => void;
  repo.delaySave = new Promise<void>((r) => (release = r));
  const saving = c.flush();
  await tick();
  c.editSource('later edit');
  c.editContext('compose', 'new capture');
  release();
  expect(await saving).toBe(true);
  expect(c.state.activeKey).toBe(id);
  expect(c.state.source).toBe('later edit');
  expect(repo.snapshot.items.filter((x) => x.kind === 'note')[0].markdown).toBe(
    'later edit',
  );
  await c.flush();
  expect(repo.snapshot.drafts.some((d) => d.key === id)).toBe(false);
  expect(repo.snapshot.drafts.find((d) => d.key === 'compose')?.markdown).toBe(
    'new capture',
  );
  c.dispose();
});
it('failed finish retains the editable source and retry saves only that note', async () => {
  const repo = new MemoryRepository();
  const c = new WorkspaceController(repo);
  await c.start();
  c.editSource('saved');
  await c.save();
  const id = repo.snapshot.items.filter((x) => x.kind === 'note')[0].id;
  await c.selectNote(id);
  c.editSource('unfinished');
  repo.fail = 'save';
  expect(await c.finishEdit()).toBe(false);
  expect(c.state.activeKey).toBe(id);
  expect(c.state.source).toBe('unfinished');
  repo.fail = null;
  expect(await c.finishEdit()).toBe(true);
  expect(repo.snapshot.drafts).toEqual([]);
  c.dispose();
});

it('nested captures retain independent drafts, checkpoint failures block navigation, and edits retain ownership', async () => {
  const repo = new MemoryRepository(),
    c = new WorkspaceController(repo);
  try {
    await c.start();
    c.editSource('Home draft');
    expect(await c.createTree()).toBe(true);
    const parent = c.state.ownerId!;
    expect(
      repo.snapshot.items.filter((x) => x.kind === 'tree')[0].parentId,
    ).toBeNull();
    c.editSource('Parent draft');
    expect(await c.createTree()).toBe(true);
    const child = c.state.ownerId!;
    expect(
      repo.snapshot.items
        .filter((x) => x.kind === 'tree')
        .find((s) => s.id === child)?.parentId,
    ).toBe(parent);
    c.editSource('nested source');
    await c.save();
    expect(
      repo.snapshot.items.filter((x) => x.kind === 'note')[0].parentId,
    ).toBe(child);
    const id = repo.snapshot.items.filter((x) => x.kind === 'note')[0].id;
    await c.openTree(null);
    expect(c.state.source).toBe('Home draft');
    await c.openTree(parent);
    expect(c.state.source).toBe('Parent draft');
    repo.fail = 'checkpoint';
    c.editSource('retained parent');
    expect(await c.openTree(child)).toBe(false);
    expect(c.state.ownerId).toBe(parent);
    expect(c.state.source).toBe('retained parent');
    repo.fail = null;
    await c.selectNote(id);
    expect(c.state.ownerId).toBe(child);
    c.editSource('edited nested');
    await c.save();
    expect(
      repo.snapshot.items.filter((x) => x.kind === 'note')[0].parentId,
    ).toBe(child);
    expect(c.state.activeKey).toBe(`compose:${child}`);
    expect(await c.openTree('missing')).toBe(false);
    expect(c.state.ownerId).toBe(child);
  } finally {
    c.dispose();
  }
});
it('delayed nested save captures its destination and later typing before queued Home navigation', async () => {
  const repo = new MemoryRepository(),
    c = new WorkspaceController(repo);
  try {
    await c.start();
    await c.createTree();
    const id = c.state.ownerId!;
    c.editSource('submitted');
    let release!: () => void;
    repo.delaySave = new Promise<void>((r) => (release = r));
    const save = c.save();
    await tick();
    c.editSource('later');
    const navigation = c.openTree(null);
    release();
    expect(await save).toBe(true);
    expect(await navigation).toBe(true);
    expect(
      repo.snapshot.items.filter((x) => x.kind === 'note')[0],
    ).toMatchObject({
      markdown: 'submitted',
      parentId: id,
    });
    expect(
      repo.snapshot.drafts.find((d) => d.key === `compose:${id}`)?.markdown,
    ).toBe('later');
    await c.openTree(id);
    expect(c.state.source).toBe('later');
  } finally {
    c.dispose();
  }
});
it('create captures parent before queueing and tree source edits preserve current context', async () => {
  const repo = new MemoryRepository(),
    c = new WorkspaceController(repo);
  try {
    await c.start();
    await c.createTree();
    const parent = c.state.ownerId!;
    const navigation = c.openTree(null),
      creation = c.createTree();
    await navigation;
    await creation;
    expect(repo.snapshot.items.find((x) => x.id !== parent)?.parentId).toBe(
      parent,
    );
    await c.selectNote(parent);
    c.editSource(' Renamed **source** ');
    await c.finishEdit();
    expect(repo.snapshot.items.find((x) => x.id === parent)?.markdown).toBe(
      ' Renamed **source** ',
    );
  } finally {
    c.dispose();
  }
});
it('library restore replaces stale contexts and reopens scoped capture drafts at their exact destinations', async () => {
  const repo = new MemoryRepository(),
    c = new WorkspaceController(repo);
  try {
    await c.start();
    await c.createTree();
    const previousId = c.state.ownerId;
    c.editSource('stale');
    const restored = new MemoryRepository();
    const id = crypto.randomUUID();
    await restored.createChildTree({
      id,
      parent: { scope: 'live', itemId: null },
    });
    await restored.checkpointDraft(
      `compose:${id}`,
      'restored tree source\r\n',
      9,
    );
    const { encodeBackup } = await import('../../src/lib/domain/backup');
    repo.restoreText = encodeBackup(restored.snapshot);
    await c.previewRestore();
    expect(c.state.preview?.trees).toBe(1);
    expect(await c.restore()).toBe(true);
    expect(c.state.ownerId).toBeNull();
    expect(c.state.buffers).not.toHaveProperty(`compose:${previousId}`);
    await c.openTree(id);
    expect(c.state.source).toBe('restored tree source\r\n');
    expect(c.state.revision).toBe(9);
  } finally {
    c.dispose();
  }
});

it('delayed tree creation opens only on success and retains later typing in the captured parent', async () => {
  const repo = new MemoryRepository(),
    c = new WorkspaceController(repo);
  try {
    await c.start();
    await c.createTree();
    const parent = c.state.ownerId!;
    c.editSource('before create');
    let release!: () => void;
    repo.delayCreate = new Promise<void>((resolve) => (release = resolve));
    const creating = c.createTree();
    await tick();
    expect(c.state.ownerId).toBe(parent);
    c.editSource('later parent input');
    release();
    expect(await creating).toBe(true);
    const child = c.state.ownerId!;
    expect(
      repo.snapshot.items
        .filter((x) => x.kind === 'tree')
        .find((s) => s.id === child)?.parentId,
    ).toBe(parent);
    await c.flush();
    expect(
      repo.snapshot.drafts.find((d) => d.key === `compose:${parent}`)?.markdown,
    ).toBe('later parent input');
    await c.openTree(parent);
    expect(c.state.source).toBe('later parent input');
    repo.fail = 'create';
    expect(await c.createTree()).toBe(false);
    expect(c.state.ownerId).toBe(parent);
  } finally {
    c.dispose();
  }
});

it('saving a capture draft retains its source without submitting a note', async () => {
  const repo = new MemoryRepository();
  const c = new WorkspaceController(repo);
  try {
    await c.start();
    c.editSource('unfinished Markdown **');
    expect(await c.flush()).toBe(true);
    expect(c.state.status).toBe('Draft saved');
    expect(repo.snapshot.items).toHaveLength(0);
    expect(repo.snapshot.drafts).toMatchObject([
      { key: 'compose', markdown: 'unfinished Markdown **' },
    ]);
    expect(c.state.source).toBe('unfinished Markdown **');
  } finally {
    c.dispose();
  }
});
