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
    expect(repo.snapshot.notes).toHaveLength(1);
    c.dispose();
  });
  it('retains selection/source outside filtered results and query through save', async () => {
    const repo = new MemoryRepository();
    const c = new WorkspaceController(repo);
    await c.start();
    c.editSource('alpha');
    await c.save();
    c.setQuery('alpha');
    c.editSource('beta');
    await c.save();
    expect(c.state.source).toBe('beta');
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
  expect(repo.snapshot.notes).toHaveLength(1);
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
it('note selection waits for the latest checkpoint and restores that draft on return', async () => {
  const repo = new MemoryRepository();
  const c = new WorkspaceController(repo);
  try {
    await c.start();
    c.editSource('saved');
    await c.save();
    const id = c.state.activeKey;
    c.editSource('older edit');
    let release!: () => void;
    repo.delayCheckpoint = new Promise<void>((resolve) => (release = resolve));
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
