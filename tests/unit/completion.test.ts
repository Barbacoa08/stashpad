import { it, expect } from 'vitest';
import { WorkspaceController } from '../../src/lib/workspace/controller';
import { MemoryRepository } from '../fixtures/memory';
const tick = () => new Promise((r) => setTimeout(r, 0));
async function setup() {
  const repo = new MemoryRepository();
  const c = new WorkspaceController(repo);
  await c.start();
  c.editSource('saved');
  await c.save();
  const id = repo.snapshot.notes[0].id;
  await c.selectNote(id);
  return { repo, c, id };
}
it('serializes exact desired completion after the latest visible source and preserves newer UI intent', async () => {
  const { repo, c, id } = await setup();
  try {
    c.editSource('first');
    let release!: () => void;
    repo.delaySave = new Promise<void>((r) => (release = r));
    const completion = c.setNoteDone(id, true);
    await tick();
    c.editSource('latest\r\n**source**');
    c.setQuery('latest');
    const nav = c.newNote();
    release();
    await completion;
    await nav;
    expect(repo.snapshot.notes[0]).toMatchObject({
      id,
      markdown: 'latest\r\n**source**',
      done: true,
      stashId: null,
    });
    expect(c.state.activeKey).toBe('compose');
    expect(c.state.query).toBe('latest');
    const time = repo.snapshot.notes[0].updatedAt;
    await c.setNoteDone(id, true);
    expect(repo.snapshot.notes[0].updatedAt).toBe(time);
  } finally {
    c.dispose();
  }
});
it.each(['save', 'completion'])(
  'completion-specific retry retains intent and never submits capture after %s failure',
  async (failure) => {
    const { repo, c, id } = await setup();
    try {
      c.editSource('retained');
      repo.fail = failure;
      expect(await c.setNoteDone(id, true)).toBe(false);
      expect(c.state.completionRetry).toEqual({ id, done: true });
      expect(repo.snapshot.notes[0].done).toBe(false);
      expect(c.state.source).toBe('retained');
      repo.fail = null;
      await c.newNote();
      c.editSource('capture pending');
      expect(await c.retryCompletion()).toBe(true);
      expect(repo.snapshot.notes).toHaveLength(1);
      expect(repo.snapshot.notes[0]).toMatchObject({
        id,
        done: true,
        markdown: 'retained',
      });
      expect(c.state.source).toBe('capture pending');
      expect(c.state.completionRetry).toBeNull();
      await c.selectNote(id);
      await c.remove();
      await c.undoRemove();
      expect(repo.snapshot.notes[0].done).toBe(true);
    } finally {
      c.dispose();
    }
  },
);
it('newer completion intent supersedes a failed older retry without reviving a deleted target', async () => {
  const { repo, c, id } = await setup();
  try {
    repo.fail = 'completion';
    await c.setNoteDone(id, true);
    repo.fail = null;
    await c.setNoteDone(id, false);
    expect(c.state.completionRetry).toBeNull();
    expect(repo.snapshot.notes[0].done).toBe(false);
    await c.remove();
    const before = structuredClone(repo.snapshot);
    expect(await c.setNoteDone(id, true)).toBe(false);
    expect(repo.snapshot).toEqual(before);
  } finally {
    c.dispose();
  }
});
it('completion preserves exact target ownership after a queued navigation', async () => {
  const repo = new MemoryRepository();
  const c = new WorkspaceController(repo);
  try {
    await c.start();
    await c.createStash('Owner');
    const owner = c.state.stashId;
    c.editSource('owned');
    await c.save();
    const id = repo.snapshot.notes[0].id;
    await c.selectNote(id);
    c.editSource('latest owned');
    const navigation = c.openStash(null);
    const completion = c.setNoteDone(id, true);
    await navigation;
    await completion;
    expect(c.state.stashId).toBeNull();
    expect(c.state.activeKey).toBe('compose');
    expect(repo.snapshot.notes[0]).toMatchObject({
      id,
      stashId: owner,
      markdown: 'latest owned',
      done: true,
    });
  } finally {
    c.dispose();
  }
});
