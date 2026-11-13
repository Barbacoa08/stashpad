import { WorkspaceController } from '../../src/lib/workspace/controller';
import { MemoryRepository } from '../fixtures/memory';
import { it, expect } from 'vitest';
import { attachCloseGuard } from '../../src/lib/platform/lifecycle';
it('failed close retains window; retry hides, and late listener registration cleans once', async () => {
  let handler: any;
  let removed = 0,
    hidden = 0,
    failed = 0;
  let ok = false;
  const adapter = {
    onCloseRequested: async (fn: any) => {
      handler = fn;
      return () => removed++;
    },
    hide: async () => {
      hidden++;
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
  expect(hidden).toBe(0);
  ok = true;
  await handler({ preventDefault: () => prevented++ });
  expect(hidden).toBe(1);
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
      hide: async () => {},
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
    hide: async () => {},
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
  it(`window close waits for latest pending checkpoint; follow-up failure=${failFollowup}`, async () => {
    const repo = new MemoryRepository();
    const c = new WorkspaceController(repo);
    await c.start();
    c.editSource('older');
    let release!: () => void;
    repo.delayCheckpoint = new Promise<void>((resolve) => (release = resolve));
    if (failFollowup) repo.failCheckpointCall = 2;
    let handler!: (e: { preventDefault(): void }) => void | Promise<void>;
    let hiddenSource: string | undefined,
      failed = 0;
    const cleanup = attachCloseGuard(
      {
        onCloseRequested: async (fn) => {
          handler = fn;
          return () => {};
        },
        hide: async () => {
          hiddenSource = repo.snapshot.drafts.find(
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
        expect(hiddenSource).toBeUndefined();
        expect(failed).toBe(1);
        expect(c.state.source).toBe('latest');
      } else {
        expect(hiddenSource).toBe('latest');
        expect(failed).toBe(0);
      }
    } finally {
      cleanup();
      c.dispose();
    }
  });

it('hides only after the newest flush succeeds, never destroys, and deduplicates pending close', async () => {
  let handler!: (event: { preventDefault(): void }) => void | Promise<void>;
  let release!: (ok: boolean) => void;
  const operations: string[] = [];
  const adapter = {
    onCloseRequested: async (fn: typeof handler) => {
      handler = fn;
      return () => {};
    },
    hide: async () => {
      operations.push('hide');
    },
    destroy: async () => {
      operations.push('destroy');
    },
  };
  const cleanup = attachCloseGuard(
    adapter,
    () => {
      operations.push('flush');
      return new Promise<boolean>((resolve) => {
        release = resolve;
      });
    },
    () => operations.push('failed'),
  );
  await Promise.resolve();
  const closing = handler({ preventDefault() {} });
  await handler({ preventDefault() {} });
  expect(operations).toEqual(['flush']);
  release(true);
  await closing;
  expect(operations).toEqual(['flush', 'hide']);
  cleanup();
});

it('does not hide a disposed view when its pending flush completes', async () => {
  let handler!: (event: { preventDefault(): void }) => void | Promise<void>;
  let release!: (ok: boolean) => void;
  let hidden = 0,
    failed = 0;
  const cleanup = attachCloseGuard(
    {
      onCloseRequested: async (fn) => {
        handler = fn;
        return () => {};
      },
      hide: async () => {
        hidden++;
      },
    },
    () =>
      new Promise<boolean>((resolve) => {
        release = resolve;
      }),
    () => {
      failed++;
    },
  );
  await Promise.resolve();
  const closing = handler({ preventDefault() {} });
  cleanup();
  release(true);
  await closing;
  expect(hidden).toBe(0);
  expect(failed).toBe(0);
});

it('retains the view on hide failure and allows a subsequent close attempt', async () => {
  let handler!: (event: { preventDefault(): void }) => void | Promise<void>;
  let attempts = 0,
    failed = 0,
    flushed = 0;
  const cleanup = attachCloseGuard(
    {
      onCloseRequested: async (fn) => {
        handler = fn;
        return () => {};
      },
      hide: async () => {
        if (++attempts === 1) throw new Error('synthetic hide failure');
      },
    },
    async () => {
      flushed++;
      return true;
    },
    () => {
      failed++;
    },
  );
  await Promise.resolve();
  await handler({ preventDefault() {} });
  expect(attempts).toBe(1);
  expect(failed).toBe(1);
  await handler({ preventDefault() {} });
  expect(attempts).toBe(2);
  expect(flushed).toBe(2);
  expect(failed).toBe(1);
  cleanup();
});
