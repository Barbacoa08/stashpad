import { WorkspaceController } from '../../src/lib/workspace/controller';
import { MemoryRepository } from '../fixtures/memory';
import { it, expect } from 'vitest';
import { attachCloseGuard } from '../../src/lib/platform/lifecycle';
it('failed close retains window; retry closes, and late listener registration cleans once', async () => {
  let handler: any;
  let removed = 0,
    destroyed = 0,
    failed = 0;
  let ok = false;
  const adapter = {
    onCloseRequested: async (fn: any) => {
      handler = fn;
      return () => removed++;
    },
    destroy: async () => {
      destroyed++;
    },
  };
  const cleanup = attachCloseGuard(
    adapter,
    async () => ok,
    () => failed++,
  );
  await Promise.resolve();
  let prevented = 0;
  await handler({ preventDefault: () => prevented++ });
  expect(prevented).toBe(1);
  expect(failed).toBe(1);
  expect(destroyed).toBe(0);
  ok = true;
  await handler({ preventDefault: () => prevented++ });
  expect(destroyed).toBe(1);
  cleanup();
  cleanup();
  expect(removed).toBe(1);
});
it('dispose before close listener resolves unregisters it', async () => {
  let resolve!: (fn: () => void) => void,
    removed = 0;
  const cleanup = attachCloseGuard(
    {
      onCloseRequested: () => new Promise((r) => (resolve = r)),
      destroy: async () => {},
    },
    async () => true,
    () => {},
  );
  cleanup();
  resolve(() => removed++);
  await Promise.resolve();
  expect(removed).toBe(1);
});

it('remount removes the first close listener before attaching another', async () => {
  const handlers = new Set<unknown>();
  const adapter = {
    onCloseRequested: async (fn: unknown) => {
      handlers.add(fn);
      return () => {
        handlers.delete(fn);
      };
    },
    destroy: async () => {},
  };
  const first = attachCloseGuard(
    adapter,
    async () => true,
    () => {},
  );
  await Promise.resolve();
  expect(handlers.size).toBe(1);
  first();
  const second = attachCloseGuard(
    adapter,
    async () => true,
    () => {},
  );
  await Promise.resolve();
  expect(handlers.size).toBe(1);
  second();
  expect(handlers.size).toBe(0);
});

for (const failFollowup of [false, true])
  it(`normal close waits for latest pending checkpoint; follow-up failure=${failFollowup}`, async () => {
    const repo = new MemoryRepository();
    const c = new WorkspaceController(repo);
    await c.start();
    c.editSource('older');
    let release!: () => void;
    repo.delayCheckpoint = new Promise<void>((resolve) => (release = resolve));
    if (failFollowup) repo.failCheckpointCall = 2;
    let handler!: (e: { preventDefault(): void }) => void | Promise<void>;
    let destroyedSource: string | undefined,
      failed = 0;
    const cleanup = attachCloseGuard(
      {
        onCloseRequested: async (fn) => {
          handler = fn;
          return () => {};
        },
        destroy: async () => {
          destroyedSource = repo.snapshot.drafts.find(
            (d) => d.key === 'compose',
          )?.markdown;
        },
      },
      () => c.flush(),
      () => failed++,
    );
    try {
      await Promise.resolve();
      const closing = handler({ preventDefault() {} });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(repo.checkpointCalls).toBe(1);
      c.editSource('latest');
      release();
      await closing;
      if (failFollowup) {
        expect(destroyedSource).toBeUndefined();
        expect(failed).toBe(1);
        expect(c.state.source).toBe('latest');
      } else {
        expect(destroyedSource).toBe('latest');
        expect(failed).toBe(0);
      }
    } finally {
      cleanup();
      c.dispose();
    }
  });
