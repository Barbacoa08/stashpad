import { expect, it } from 'vitest';
import { WorkspaceController } from '../../src/lib/workspace/controller';
import { MemoryRepository } from '../fixtures/memory';
const id = '00000000-0000-4000-8000-000000000001';
async function setup() {
  const repo = new MemoryRepository();
  await repo.captureItem({
    id,
    location: { scope: 'live', itemId: null },
    markdown: 'original',
    draft: { key: 'compose', revision: 0 },
  });
  const c = new WorkspaceController(repo);
  await c.start();
  await c.selectNote(id);
  return { c, repo };
}
it('refreshes clean cached source, but preserves dirty source and current context', async () => {
  const { c, repo } = await setup();
  repo.snapshot.items[0].markdown = 'remote';
  expect(await c.refreshFromRepository()).toBe(true);
  expect(c.state.source).toBe('remote');
  c.editSource('dirty');
  repo.snapshot.items[0].markdown = 'remote2';
  await c.refreshFromRepository();
  expect(c.state.source).toBe('dirty');
  expect(c.state.activeKey).toBe(id);
  c.dispose();
});
it('reads remote snapshot inside the existing command queue', async () => {
  const { c, repo } = await setup();
  c.editSource('saved');
  let release!: () => void;
  repo.delaySave = new Promise<void>((r) => (release = r));
  const saving = c.flush();
  await Promise.resolve();
  const refreshing = c.refreshFromRepository();
  release();
  await saving;
  await refreshing;
  expect(c.state.snapshot.items[0].markdown).toBe('saved');
  expect(c.state.source).toBe('saved');
  c.dispose();
});
it('remote purge retains newest typing during asynchronous preservation before pruning', async () => {
  const { c, repo } = await setup();
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((r) => (entered = r)),
    gate = new Promise<void>((r) => (release = r));
  const retained: string[] = [];
  Object.assign(repo, {
    refreshFromRemote: async (
      buffers: { key: string; markdown: string; revision: number }[],
    ) => {
      retained.push(...buffers.map((b) => b.markdown));
      entered();
      await gate;
      return {
        workspace: { items: [], drafts: [], undoDeleteIds: [] },
        replaced: false,
        removedIds: [id],
        originEpoch: 'old',
      };
    },
  });
  c.editSource('first');
  const refreshing = c.refreshFromRepository();
  await ready;
  c.editSource('newest');
  release();
  expect(await refreshing).toBe(true);
  expect(retained).toContain('newest');
  expect(c.state.buffers[id]).toBeUndefined();
  expect(c.state.purgedItemIds).toContain(id);
  c.dispose();
});
it('a retained Retry cannot retarget a same-UUID item after epoch replacement', async () => {
  const { c, repo } = await setup();
  repo.fail = 'color';
  expect(await c.setItemColor(id, 'red')).toBe(false);
  const retry = c.mutationRetryIdentity;
  repo.fail = null;
  Object.assign(repo, {
    refreshFromRemote: async () => ({
      workspace: structuredClone(repo.snapshot),
      replaced: true,
      removedIds: [],
      originEpoch: 'old',
    }),
  });
  await c.refreshFromRepository();
  expect(c.mutationRetryIdentity).toBe(retry);
  expect(await c.retryMutation()).toBe(false);
  expect(repo.snapshot.items[0].color).toBe(null);
  c.dispose();
});
it('failed preservation after remote replacement fences autosave from the new same-UUID owner', async () => {
  const { c, repo } = await setup();
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((r) => (enter = r)),
    gate = new Promise<void>((r) => (release = r));
  let calls = 0;
  Object.assign(repo, {
    refreshFromRemote: async () => {
      calls++;
      if (calls > 1) throw new Error('preservation failed');
      enter();
      await gate;
      repo.snapshot.items[0].markdown = 'replacement';
      return {
        workspace: structuredClone(repo.snapshot),
        replaced: true,
        removedIds: [],
        originEpoch: 'old',
      };
    },
  });
  c.editSource('first');
  const pending = c.refreshFromRepository();
  await entered;
  c.editSource('latest');
  release();
  expect(await pending).toBe(false);
  expect(await c.flush()).toBe(false);
  expect(repo.snapshot.items[0].markdown).toBe('replacement');
  expect(c.state.source).toBe('latest');
  c.dispose();
});
it('a replacement first discovered in a later preservation pass fences subsequent autosave and Retry after failure', async () => {
  const { c, repo } = await setup();
  repo.fail = 'color';
  await c.setItemColor(id, 'red');
  const retry = c.mutationRetryIdentity;
  repo.fail = null;
  let calls = 0;
  Object.assign(repo, {
    refreshFromRemote: async () => {
      calls++;
      if (calls === 1) {
        c.editSource('second');
        return {
          workspace: structuredClone(repo.snapshot),
          replaced: false,
          removedIds: [],
          originEpoch: 'A',
        };
      }
      if (calls === 2) {
        c.editSource('third');
        repo.snapshot.items[0].markdown = 'replacement B';
        return {
          workspace: structuredClone(repo.snapshot),
          replaced: true,
          removedIds: [],
          originEpoch: 'A',
        };
      }
      throw new Error('all preservation storage unavailable');
    },
  });
  c.editSource('first');
  expect(await c.refreshFromRepository()).toBe(false);
  expect(calls).toBe(3);
  expect(c.state.source).toBe('third');
  expect(c.mutationRetryIdentity).toBe(retry);
  expect(await c.flush()).toBe(false);
  expect(await c.retryMutation()).toBe(false);
  expect(repo.snapshot.items[0].markdown).toBe('replacement B');
  expect(repo.snapshot.items[0].color).toBe(null);
  c.dispose();
});
