import {
  preservePendingIntent,
  digest,
  type PendingIntent,
  installJournalMetadata,
  readJournalMetadata,
} from '../../src/lib/sync/intents';
import { ScratchtreeDatabase } from '../../src/lib/sync/database';
import { DexieRepository } from '../../src/lib/sync/repository';
import { SyncEngine } from '../../src/lib/sync/engine';
import {
  cleanupResolvedWitness,
  resolveIntent,
  rawRecovery,
} from '../../src/lib/sync/recovery';
const id = '00000000-0000-4000-8000-000000000001';
function serial() {
  let queue: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T>) => {
    const task = queue.then(work);
    queue = task.catch(() => {});
    return task;
  };
}
const files = {
  chooseRead: async () => null,
  chooseWrite: async () => null,
  writeSafety: async () => {},
};
function assert(v: unknown, m: string): asserts v {
  if (!v) throw new Error(m);
}
async function remoteHarness(db: ScratchtreeDatabase, repo: DexieRepository) {
  const server = {
    pointer: (await db.libraries.get(repo.libraryId))!,
    notes: await db.notes.toArray(),
    orders: await db.orders.toArray(),
    purges: await db.purges.toArray(),
    witnesses: new Map(
      (await db.witnesses.toArray()).map((row) => [row.id, row]),
    ),
  };
  Object.defineProperty(db, 'cloudEnabled', { value: true });
  Object.defineProperty(db, 'cloud', {
    value: {
      options: { databaseUrl: 'https://example.invalid' },
      currentUser: {
        getValue: () => ({
          isLoggedIn: true,
          accessToken: 'synthetic',
          accessTokenExpiration: new Date(Date.now() + 60000),
        }),
      },
    },
  });
  let before: (() => Promise<void>) | null = null,
    beforeExact: (() => Promise<void>) | null = null,
    clock = Date.now(),
    collections = 0;
  const fetcher: typeof fetch = async (input) => {
    if (before) {
      const hook = before;
      before = null;
      await hook();
    }
    const path = new URL(String(input)).pathname.split('/'),
      table = path[2],
      key = path[3] ? decodeURIComponent(path[3]) : null;
    if (table === 'notes' && key && beforeExact) {
      const hook = beforeExact;
      beforeExact = null;
      await hook();
    }
    if (['notes', 'orders', 'purges'].includes(table) && !key) collections++;
    let value: unknown;
    if (table === 'libraries') value = server.pointer;
    else if (table === 'witnesses') value = server.witnesses.get(key!);
    else {
      const rows =
        table === 'notes'
          ? server.notes
          : table === 'orders'
            ? server.orders
            : server.purges;
      value = key ? rows.find((row) => row.id === JSON.parse(key)[1]) : rows;
    }
    return value === undefined
      ? new Response('', { status: 404 })
      : new Response(JSON.stringify(value));
  };
  const engine = new SyncEngine({
    db,
    repository: repo,
    files,
    serialize: serial(),
    onInvalidation: () => {},
    fetch: fetcher,
    now: () => clock,
  });
  let state!: import('../../src/lib/sync/service-types').SyncState;
  engine.subscribe((next) => (state = next));
  return {
    server,
    engine,
    get collections() {
      return collections;
    },
    get state() {
      return state;
    },
    advance() {
      clock += 1000;
    },
    hook(work: () => Promise<void>) {
      before = work;
    },
    hookExact(work: () => Promise<void>) {
      beforeExact = work;
    },
    async publishWitnesses() {
      for (const row of await db.witnesses.toArray())
        server.witnesses.set(row.id, row);
    },
  };
}
export async function run(scenario: string) {
  const name = 'task3-' + crypto.randomUUID(),
    db = new ScratchtreeDatabase({ name }),
    repo = new DexieRepository(db, files);
  await repo.loadWorkspace();
  try {
    await repo.captureItem({
      id,
      location: { scope: 'live', itemId: null },
      markdown: 'original',
      draft: { key: 'compose', revision: 0 },
    });
    const epoch = await repo.getEpoch();
    if (
      scenario === 'fix2-mixed-source' ||
      scenario === 'fix2-mixed-unrelated'
    ) {
      const h = await remoteHarness(db, repo);
      try {
        await h.engine.retry();
        assert(
          h.state.state === 'up-to-date',
          'baseline exists before mixed structural batch',
        );
        const stamp = h.state.lastConfirmed;
        await repo.promoteItem(id);
        await repo.saveItemSource(id, 'local A', { key: id, revision: 1 });
        await h.publishWitnesses();
        h.server.notes = await db.notes.toArray();
        h.hookExact(async () => {
          if (scenario === 'fix2-mixed-source')
            h.server.notes[0].markdown = 'remote B';
          else h.server.notes[0].done = true;
        });
        h.advance();
        const collections = h.collections;
        await h.engine.retry();
        assert(
          (h.state.state as string) === 'needs-sync' &&
            h.state.lastConfirmed === stamp,
          'later contradictory exact evidence cannot revive earlier structural full view',
        );
        assert(
          h.collections >= collections + 6,
          'contradiction obtains full evidence after earlier structural read',
        );
        assert(
          (await db.notes.get([await repo.getEpoch(), id]))?.markdown ===
            'local A',
          'SDK delivery remains delayed',
        );
        await db.notes.put(h.server.notes[0]);
        await h.engine.retry();
        assert(
          h.state.state === 'up-to-date' && h.state.lastConfirmed !== stamp,
          'matching SDK delivery and fresh comparison restore status',
        );
      } finally {
        h.engine.close();
      }
    } else if (scenario === 'fix1-latest') {
      await resolveIntent(db, (await db.pending.toArray())[0], 'matching');
      await repo.saveItemSource(id, 'first', { key: id, revision: 1 });
      const first = (await db.pending.toArray())[0];
      await repo.saveItemSource(id, 'latest', { key: id, revision: 2 });
      const latest = (await db.pending.toArray()).find(
        (p) => p.id !== first.id,
      )!;
      await resolveIntent(db, latest, 'matching');
      const reopenedDb = new ScratchtreeDatabase({ name }),
        reopened = new DexieRepository(reopenedDb, files);
      try {
        await reopened.loadWorkspace();
        const transfer = await reopened.readTransfer();
        assert(
          transfer.journal.sequence === latest.sequence &&
            transfer.journal.sources.some(
              (head) =>
                head.sequence === latest.sequence &&
                head.intentId === latest.id,
            ),
          'resolved latest head included in protected transfer',
        );
        const detachedDb = new ScratchtreeDatabase({
            name: name + '-detached',
          }),
          detached = new DexieRepository(detachedDb, files);
        try {
          await detachedDb.open();
          await detachedDb.libraries.put({
            id: repo.libraryId,
            epoch: first.epoch,
          });
          await detachedDb.notes.bulkPut(await reopenedDb.notes.toArray());
          await detachedDb.orders.bulkPut(await reopenedDb.orders.toArray());
          await detachedDb.recovery.bulkPut(transfer.backup.device.recovery);
          await detachedDb.pending.bulkPut(transfer.pending);
          await installJournalMetadata(detachedDb, transfer.journal);
          await detached.loadWorkspace();
          assert(
            (await detached.readTransfer()).journal.sources[0].intentId ===
              latest.id,
            'protected metadata survives detached install',
          );
          for (const changed of [
            { ...transfer.journal.sources[0], epoch: 'wrong' },
            {
              ...transfer.journal.sources[0],
              itemId: '00000000-0000-4000-8000-000000000099',
            },
            { ...transfer.journal.sources[0], intentId: crypto.randomUUID() },
            { ...transfer.journal.sources[0], digest: 'a'.repeat(64) },
          ]) {
            let rejected = false;
            try {
              await installJournalMetadata(detachedDb, {
                sequence: transfer.journal.sequence,
                sources: [changed],
              });
            } catch {
              rejected = true;
            }
            assert(rejected, 'mismatched transfer metadata rejected');
          }
          await detached.saveItemSource(id, 'newest after transfer', {
            key: id,
            revision: 3,
          });
          const newer = (await detachedDb.pending.toArray()).find(
            (p) => p.sequence > latest.sequence,
          )!;
          await installJournalMetadata(detachedDb, transfer.journal);
          assert(
            (await readJournalMetadata(detachedDb)).sources[0].sequence ===
              newer.sequence,
            'older transfer cannot clobber newer target head',
          );
          await resolveIntent(detachedDb, first, 'superseded');
          assert(
            !(await detachedDb.recovery.toArray()).some(
              (r) => r.kind === 'source' && r.markdown === 'first',
            ),
            'detached old acknowledgment cannot add earlier version',
          );
          await resolveIntent(detachedDb, newer, 'matching');
          const clean = await detached.readTransfer();
          assert(
            clean.pending.length === 0 &&
              clean.journal.sequence === newer.sequence &&
              clean.journal.sources.length === 0,
            'clean transfer retains highwater and prunes unused heads',
          );
          const freshDb = new ScratchtreeDatabase({ name: name + '-clean' }),
            fresh = new DexieRepository(freshDb, files);
          try {
            await fresh.loadWorkspace();
            await installJournalMetadata(freshDb, clean.journal);
            await fresh.captureItem({
              id: '00000000-0000-4000-8000-000000000099',
              location: { scope: 'live', itemId: null },
              markdown: 'after clean transfer',
              draft: { key: 'compose', revision: 0 },
            });
            assert(
              (await freshDb.pending.toArray())[0].sequence ===
                newer.sequence + 1,
              'empty-pending transfer does not reset journal order',
            );
          } finally {
            fresh.close();
            await freshDb.delete();
          }
        } finally {
          detached.close();
          await detachedDb.delete();
        }
        await resolveIntent(reopenedDb, first, 'superseded');
        const recovery = await reopenedDb.recovery.toArray();
        assert(
          recovery.some((r) => r.kind === 'source' && r.markdown === 'latest'),
          'latest survives newer-first/reopen',
        );
        assert(
          !recovery.some((r) => r.kind === 'source' && r.markdown === 'first'),
          'resolved newer intent prevents older recovery version after reopen',
        );
        const child = '00000000-0000-4000-8000-000000000077';
        await reopened.createChildTree({
          id: child,
          parent: { scope: 'live', itemId: null },
        });
        const tree = (await reopenedDb.pending.toArray())[0];
        await reopened.saveItemSource(child, 'latest tree body', {
          key: child,
          revision: 1,
        });
        const source = (await reopenedDb.pending.toArray()).find(
          (intent) => intent.id !== tree.id,
        )!;
        await resolveIntent(reopenedDb, source, 'matching');
        assert(
          (await reopenedDb.recovery.toArray()).some(
            (r) =>
              r.kind === 'source' &&
              r.itemId === child &&
              r.markdown === 'latest tree body',
          ),
          'older tree creation keeps latest source recovery until resolution',
        );
        await resolveIntent(reopenedDb, tree, 'superseded');
        assert(
          !(await reopenedDb.recovery.toArray()).some(
            (r) =>
              r.kind === 'source' &&
              r.itemId === child &&
              r.markdown === 'Untitled',
          ),
          'older tree acknowledgment cannot recreate its initial source',
        );
      } finally {
        reopened.close();
      }
    } else if (scenario === 'fix1-baseline') {
      const h = await remoteHarness(db, repo);
      try {
        await h.engine.retry();
        const confirmed = h.state.lastConfirmed;
        assert(h.state.state === 'up-to-date', 'initial baseline established');
        const initialCollections = h.collections;
        await repo.saveItemSource(id, 'ordinary matching', {
          key: id,
          revision: 1,
        });
        await h.publishWitnesses();
        h.server.notes = await db.notes.toArray();
        await h.engine.retry();
        assert(
          h.state.state === 'up-to-date' &&
            h.collections === initialCollections,
          'exact observed target advances baseline without whole-library fetch',
        );
        await repo.saveItemSource(id, 'local A', { key: id, revision: 1 });
        await h.publishWitnesses();
        h.server.notes = await db.notes.toArray();
        h.server.notes[0].markdown = 'remote B';
        h.advance();
        await h.engine.retry();
        assert(
          (h.state.state as string) === 'needs-sync' &&
            h.state.lastConfirmed === confirmed,
          'known supersession before pull cannot reuse baseline',
        );
        await db.notes.put(h.server.notes[0]);
        await h.engine.retry();
        assert(
          h.state.state === 'up-to-date',
          'matching SDK delivery restores status',
        );
        const before = h.state.lastConfirmed;
        h.advance();
        h.hook(async () => {
          await db.notes.update([await repo.getEpoch(), id], {
            markdown: 'mutation during REST',
          });
        });
        await h.engine.retry();
        assert(
          (h.state.state as string) === 'needs-sync' &&
            h.state.lastConfirmed === before,
          'final shared view rather than early snapshot governs status',
        );
        h.server.notes = await db.notes.toArray();
        await h.engine.retry();
        assert(
          h.state.state === 'up-to-date',
          'fresh server evidence restores changed local view',
        );
        await repo.saveItemSource(id, 'matching source', {
          key: id,
          revision: 2,
        });
        await h.publishWitnesses();
        h.server.notes = await db.notes.toArray();
        h.server.notes[0].done = true;
        const stamp = h.state.lastConfirmed;
        h.advance();
        await h.engine.retry();
        assert(
          (h.state.state as string) === 'needs-sync' &&
            h.state.lastConfirmed === stamp,
          'matching desired source does not hide unrelated observed server mismatch',
        );
        await db.notes.put(h.server.notes[0]);
        await h.engine.retry();
        assert(
          h.state.state === 'up-to-date',
          'full canonical target matches after delayed unrelated pull',
        );
      } finally {
        h.engine.close();
      }
    } else if (scenario === 'fix1-neutral') {
      await resolveIntent(db, (await db.pending.toArray())[0], 'matching');
      await repo.captureItem({
        id,
        location: { scope: 'live', itemId: null },
        markdown: 'original',
        draft: { key: 'compose', revision: 0 },
      });
      const p = (await db.pending.toArray())[0];
      assert(p.expected.items.length === 0, 'real capture replay is neutral');
      const { classifyOutcome } =
        await import('../../src/lib/sync/confirmation');
      const result = await classifyOutcome(p, await db.witnesses.get(p.id), {
        epoch: await repo.getEpoch(),
        items: [],
        purgedIds: [],
      });
      assert(
        result === 'superseded',
        'neutral admitted capture missing remotely is not success',
      );
      await resolveIntent(db, p, result);
      assert(
        (await db.recovery.toArray()).some(
          (r) => r.kind === 'source' && r.markdown === 'original',
        ),
        'neutral creation alternative survives resolution',
      );
      const child = '00000000-0000-4000-8000-000000000002';
      await repo.createChildTree({
        id: child,
        parent: { scope: 'live', itemId: null },
      });
      await resolveIntent(db, (await db.pending.toArray())[0], 'matching');
      await repo.createChildTree({
        id: child,
        parent: { scope: 'live', itemId: null },
      });
      const tree = (await db.pending.toArray())[0];
      assert(tree.expected.items.length === 0, 'real child replay neutral');
      const outcome = await classifyOutcome(
        tree,
        await db.witnesses.get(tree.id),
        { epoch: tree.epoch, items: [], purgedIds: [] },
      );
      assert(outcome === 'superseded', 'neutral missing tree is not success');
      await resolveIntent(db, tree, outcome);
      assert(
        (await db.recovery.toArray()).some(
          (r) =>
            r.kind === 'source' &&
            r.itemId === child &&
            r.markdown === 'Untitled',
        ),
        'neutral tree exact source retained',
      );
    } else if (scenario === 'device-tables') {
      assert(
        [
          db.drafts.name,
          db.undo.name,
          db.recovery.name,
          db.pending.name,
          db.device.name,
        ].join(',') ===
          'deviceDrafts,deviceUndo,deviceRecovery,devicePending,deviceState',
        'device aliases have distinct physical tables',
      );
      assert(
        !db.tables.some((table) =>
          ['drafts', 'undo', 'recovery', 'pending', 'device'].includes(
            table.name,
          ),
        ),
        'no legacy physical device-table aliases',
      );
      const cloud = new ScratchtreeDatabase({
        name: name + '-configured',
        databaseUrl: 'https://example.invalid',
      });
      try {
        assert(
          cloud.cloud.options?.unsyncedTables?.join(',') ===
            'deviceDrafts,deviceUndo,deviceRecovery,devicePending,deviceState',
          'every physical device table unsynced',
        );
        assert(
          cloud.cloud.options?.largeStringThreshold === Infinity &&
            cloud.cloud.options.socialAuth === false,
          'source REST representation and explicit OTP configuration',
        );
      } finally {
        cloud.close();
      }
    } else if (scenario === 'overflow-input') {
      const template = (await db.notes.toArray())[0];
      await db.notes.bulkAdd(
        Array.from({ length: 20000 }, (_, n) => ({
          ...template,
          id: `00000000-0000-4000-8000-${String(n + 2).padStart(12, '0')}`,
          markdown: 'overflow',
        })),
      );
      let failed = false;
      try {
        await repo.refreshFromRemote([
          { key: id, markdown: 'latest overflow input 雪😀', revision: 7 },
        ]);
      } catch {
        failed = true;
      }
      assert(failed, 'overflow cannot replace last valid view');
      try {
        await repo.checkpointDraft(id, 'latest after overflow 雪😀', 8);
      } catch {}

      assert(
        (await rawRecovery(db, repo.libraryId)).buffers.some(
          (b) => b.key === id && b.markdown === 'latest after overflow 雪😀',
        ),
        'raw export durably retains latest dirty input',
      );
      const reopenedDb = new ScratchtreeDatabase({ name }),
        reopened = new DexieRepository(reopenedDb, files);
      await reopenedDb.open();
      assert(
        (await rawRecovery(reopenedDb, repo.libraryId)).buffers.some(
          (b) => b.revision === 8,
        ),
        'raw input survives reopen',
      );
      const engine = new SyncEngine({
        db: reopenedDb,
        repository: reopened,
        files,
        serialize: serial(),
        onInvalidation: () => {},
      });
      await engine.purgeOverflow({
        epoch,
        ids: ['00000000-0000-4000-8000-000000020001'],
      });
      const view = await reopened.loadWorkspace();
      assert(
        view.drafts.some(
          (d) => d.key === id && d.markdown === 'latest after overflow 雪😀',
        ),
        'valid resumption installs exact latest draft',
      );
      assert(
        (await rawRecovery(reopenedDb, repo.libraryId)).buffers.length === 0,
        'raw input clears only after strict adoption',
      );
      engine.close();
      reopened.close();
    } else if (scenario === 'latest-intent') {
      await repo.saveItemSource(id, 'first saved', { key: id, revision: 1 });
      const p = (await db.pending.toArray()).find(
        (x) => x.command.kind === 'saveItemSource',
      )!;
      await repo.saveItemSource(id, 'second saved', { key: id, revision: 2 });
      await repo.saveItemSource(id, 'newest during acknowledgment', {
        key: id,
        revision: 3,
      });
      await resolveIntent(db, p, 'superseded');
      const recoveries = await db.recovery.toArray();
      assert(
        !recoveries.some(
          (r) => r.kind === 'source' && r.markdown === 'first saved',
        ),
        'older local intermediate is not invented version history',
      );
      assert(
        recoveries.some(
          (r) =>
            r.kind === 'source' &&
            r.markdown === 'newest during acknowledgment',
        ),
        'latest in-flight local alternative retained',
      );
      assert(
        (await db.pending.toArray()).some(
          (x) =>
            x.command.kind === 'saveItemSource' &&
            x.command.markdown === 'newest during acknowledgment',
        ),
        'older acknowledgment does not clear newest intent',
      );
    } else if (
      scenario === 'engine-confirmation' ||
      scenario === 'engine-bounds'
    ) {
      if (scenario === 'engine-bounds')
        for (let i = 0; i < 18; i++)
          await repo.setItemColor(id, i % 2 ? 'red' : 'blue');
      const pointer = await db.libraries.get(repo.libraryId);
      const notes = await db.notes.toArray(),
        orders = await db.orders.toArray(),
        purges = await db.purges.toArray();
      let offline = false,
        invalidExpiration = false,
        fetches = 0;
      Object.defineProperty(db, 'cloudEnabled', { value: true });
      Object.defineProperty(db, 'cloud', {
        value: {
          options: { databaseUrl: 'https://example.invalid' },
          currentUser: {
            getValue: () => ({
              isLoggedIn: true,
              accessToken: 'synthetic-token',
              accessTokenExpiration: invalidExpiration
                ? new Date(NaN)
                : new Date(Date.now() + 60000),
            }),
          },
        },
      });
      const fetcher: typeof fetch = async (input) => {
        fetches++;
        if (offline) throw new Error('offline');
        const url = new URL(String(input)),
          parts = url.pathname.split('/'),
          table = parts[2];
        let value: unknown;
        if (table === 'libraries') value = pointer;
        else if (table === 'notes' && parts[3])
          value = notes.find(
            (row) => row.id === JSON.parse(decodeURIComponent(parts[3]))[1],
          );
        else if (table === 'purges' && parts[3])
          value = purges.find(
            (row) => row.id === JSON.parse(decodeURIComponent(parts[3]))[1],
          );
        else if (table === 'witnesses')
          value = await db.witnesses.get(decodeURIComponent(parts[3]));
        else
          value =
            table === 'notes' ? notes : table === 'orders' ? orders : purges;
        return value === undefined
          ? new Response('', { status: 404 })
          : new Response(JSON.stringify(value));
      };
      const queue = serial();
      const engine = new SyncEngine({
        db,
        repository: repo,
        files,
        serialize: queue,
        onInvalidation: () => {},
        fetch: fetcher,
        turnTimeoutMs: scenario === 'engine-bounds' ? 100 : undefined,
      });
      if (scenario === 'engine-bounds') {
        const before = await db.pending.count();
        const retry = engine.retry();
        const lifecycle = queue(async () => {
          assert(
            (await db.pending.count()) < before,
            'bounded turn makes real confirmation progress',
          );
          assert(
            (await db.pending.count()) >= before - 8,
            'lifecycle receives queue after bounded intent batch',
          );
        });
        await lifecycle;
        await retry;
        engine.close();
        const hung = new SyncEngine({
          db,
          repository: repo,
          files,
          serialize: queue,
          onInvalidation: () => {},
          turnTimeoutMs: 50,
          fetch: async () => new Promise<Response>(() => {}),
        });
        const retained = await db.pending.count();
        const blocked = hung.retry();
        const started = performance.now();
        await queue(async () => {});
        await blocked;
        assert(
          performance.now() - started < 1000,
          'hung HTTP/body does not starve lifecycle queue',
        );
        assert(
          (await db.pending.count()) === retained,
          'timed-out turn never prunes exact pending',
        );
        hung.close();
        const bodyHung = new SyncEngine({
          db,
          repository: repo,
          files,
          serialize: queue,
          onInvalidation: () => {},
          turnTimeoutMs: 100,
          fetch: async () => {
            const response = new Response('{}');
            response.json = () => new Promise(() => {});
            return response;
          },
        });
        await bodyHung.retry();
        assert(
          (await db.pending.count()) === retained,
          'hung JSON body retains exact pending',
        );
        bodyHung.close();
        let attempts = 0;
        const unknown = new SyncEngine({
          db,
          repository: repo,
          files,
          serialize: queue,
          onInvalidation: () => {},
          fetch: async (input, init) => {
            attempts++;
            return String(input).includes('/witnesses/')
              ? new Response('', { status: 404 })
              : fetcher(input, init);
          },
        });
        await unknown.retry();
        await new Promise((r) => setTimeout(r, 150));
        const afterPass = attempts;
        await new Promise((r) => setTimeout(r, 150));
        assert(
          attempts === afterPass,
          'no-progress unknown pass does not self-poll',
        );
        unknown.close();
        let entered!: () => void;
        const ready = new Promise<void>((resolve) => (entered = resolve));
        let observed: AbortSignal | undefined;
        const stopping = new SyncEngine({
          db,
          repository: repo,
          files,
          serialize: queue,
          onInvalidation: () => {},
          turnTimeoutMs: 1000,
          fetch: async (_input, init) => {
            observed = init?.signal ?? undefined;
            entered();
            return new Promise(() => {});
          },
        });
        const stoppingWork = stopping.retry();
        await ready;
        stopping.close();
        await queue(async () => {});
        await stoppingWork;
        assert(
          observed?.aborted && (await db.pending.count()) === retained,
          'close aborts active REST before lifecycle proceeds',
        );
        const captured = (await db.pending.toArray())[0];
        const abort = new AbortController();
        const hook = (key: unknown) => {
          if (key === captured.id) abort.abort();
        };
        db.pending.hook('deleting', hook);
        try {
          try {
            await resolveIntent(db, captured, 'matching', abort.signal);
          } catch {}
          assert(
            !!(await db.pending.get(captured.id)),
            'abort at acknowledgment transaction rolls back pending deletion',
          );
        } finally {
          db.pending.hook('deleting').unsubscribe(hook);
        }
        return 'ok';
      }
      let state = '';
      engine.subscribe((s) => (state = s.state));
      await engine.retry();
      assert(
        state === 'up-to-date',
        'admission and validated remote outcome confirm',
      );
      invalidExpiration = true;
      const beforeFetches = fetches;
      await engine.retry();
      assert(
        (state as string) === 'needs-sync' && fetches === beforeFetches,
        'invalid token expiration is unknown without sending credentials',
      );
      invalidExpiration = false;
      await engine.retry();
      offline = true;
      await engine.retry();
      assert(
        (state as string) === 'needs-sync',
        'a clean offline retry cannot invent a new confirmation',
      );
      engine.close();
    } else if (scenario === 'convergence') {
      const second = new ScratchtreeDatabase({ name: name + '-second' });
      const r2 = new DexieRepository(second, files);
      try {
        await second.open();
        await second.libraries.add({ id: repo.libraryId, epoch });
        await second.notes.bulkPut(await db.notes.toArray());
        await second.orders.bulkPut(await db.orders.toArray());
        await r2.loadWorkspace();
        const id2 = '00000000-0000-4000-8000-000000000002',
          id3 = '00000000-0000-4000-8000-000000000003';
        await repo.captureItem({
          id: id2,
          location: { scope: 'live', itemId: null },
          markdown: 'offline A',
          draft: { key: 'compose', revision: 1 },
        });
        await r2.captureItem({
          id: id3,
          location: { scope: 'live', itemId: null },
          markdown: 'offline B',
          draft: { key: 'compose', revision: 1 },
        });
        const left = await db.notes.toArray(),
          right = await second.notes.toArray(),
          winningOrder = await second.orders.toArray();
        await db.notes.bulkPut(right.filter((x) => x.id === id3));
        await second.notes.bulkPut(left.filter((x) => x.id === id2));
        await db.orders.bulkPut(winningOrder);
        assert(
          JSON.stringify((await repo.loadWorkspace()).items) ===
            JSON.stringify((await r2.loadWorkspace()).items),
          'actual clients converge concurrent inserts with lost order',
        );
        const rows = await db.notes.toArray();
        rows.find((x) => x.id === id)!.placement.parentId = id2;
        rows.find((x) => x.id === id2)!.placement.parentId = id;
        await db.notes.bulkPut(rows);
        await second.notes.bulkPut([...rows].reverse());
        assert(
          JSON.stringify((await repo.loadWorkspace()).items) ===
            JSON.stringify((await r2.loadWorkspace()).items),
          'cycle projection permutation convergence',
        );
        const tombstone = { id: id2, epoch, purgedAt: Date.now() };
        await db.purges.put(tombstone);
        await second.purges.put(tombstone);
        const a = await repo.loadWorkspace(),
          b = await r2.loadWorkspace();
        assert(
          JSON.stringify(a.items) === JSON.stringify(b.items),
          'purged-parent orphan source convergence',
        );
        assert(
          a.items.find((x) => x.id === id)?.markdown === 'original',
          'orphan source retained',
        );
      } finally {
        r2.close();
        await second.delete();
      }
    } else if (scenario === 'sequence') {
      const now = Date.now,
        base = now();
      try {
        Date.now = () => base + 1000;
        await repo.saveItemSource(id, 'second', { key: id, revision: 1 });
        await repo.setItemDone(id, true);
        Date.now = () => base + 500;
        await repo.setItemColor(id, 'red');
      } finally {
        Date.now = now;
      }
      const transfer = await repo.readTransfer();
      assert(
        transfer.pending.map((p) => p.sequence).join(',') === '1,2,3,4',
        'monotonic sequence despite same/back clock',
      );
      assert(
        transfer.pending.map((p) => p.command.kind).join(',') ===
          'captureItem,saveItemSource,setItemDone,setItemColor',
        'journal preserves dependent command order',
      );
      const reopenedDb = new ScratchtreeDatabase({ name });
      const reopened = new DexieRepository(reopenedDb, files);
      await reopened.loadWorkspace();
      assert(
        (await reopened.readTransfer()).pending
          .map((p) => p.sequence)
          .join(',') === '1,2,3,4',
        'ordered journal survives reopen',
      );
      await reopened.saveItemSource(id, 'after reopen', {
        key: id,
        revision: 2,
      });
      assert(
        (await reopened.readTransfer()).pending.at(-1)?.sequence === 5,
        'counter survives reopen',
      );
      reopened.close();
    } else if (scenario === 'overflow') {
      const template = (await db.notes.toArray())[0];
      const rows = Array.from({ length: 20000 }, (_, n) => ({
        ...template,
        id: `00000000-0000-4000-8000-${String(n + 2).padStart(12, '0')}`,
        markdown: `overflow ${n}`,
      }));
      await db.notes.bulkAdd(rows);
      const engine = new SyncEngine({
        db,
        repository: repo,
        files,
        serialize: serial(),
        onInvalidation: () => {},
      });
      const before = await engine.inspectOverflow();
      assert(
        before.overflow && before.rows.length === 20001,
        'all raw overflow rows available',
      );
      await engine.purgeOverflow({ epoch, ids: [id] });
      assert(
        !(await engine.inspectOverflow()).overflow,
        'exact corrective deletion returns valid',
      );
      assert((await db.notes.count()) === 20000, 'no unrelated source removed');
      assert(
        (await db.pending.toArray()).some(
          (p) =>
            p.command.kind === 'correctivePurge' &&
            p.expected.purgedIds.length === 1,
        ),
        'corrective intent exact',
      );
      engine.close();
    } else if (scenario === 'transfer') {
      const transfer = await repo.readTransfer();
      assert(
        transfer.epoch === epoch &&
          transfer.backup.library.items[0].id === id &&
          transfer.pending.length === 1,
        'consistent full transfer',
      );
    } else if (scenario === 'engine') {
      const engine = new SyncEngine({
        db,
        repository: repo,
        files,
        serialize: serial(),
        onInvalidation: () => {},
      });
      engine.start();
      await engine.retry();
      engine.close();
      assert(db.isOpen(), 'engine does not own database');
      assert((await db.pending.count()) === 1, 'local-only intent retained');
    } else if (scenario === 'refresh') {
      await db.libraries.put({ id: repo.libraryId, epoch: 'replacement' });
      let result = await repo.refreshFromRemote([
        { key: id, markdown: 'latest unsaved', revision: 2 },
      ]);
      assert(result.replaced, 'replacement reported');
      assert(result.workspace.items.length === 0, 'replacement empty');
      result = await repo.refreshFromRemote([
        {
          key: id,
          markdown: 'newer during IO',
          revision: 3,
          originEpoch: epoch,
        },
      ]);
      assert(
        (await db.recovery.toArray()).some(
          (r) =>
            r.kind === 'draft' &&
            r.markdown === 'newer during IO' &&
            r.originEpoch === epoch,
        ),
        'latest old-epoch input retained',
      );
    } else if (scenario === 'receipts') {
      const p = (await db.pending.toArray())[0];
      await repo.saveItemSource(id, 'newest', { key: id, revision: 1 });
      const newer = (await db.pending.toArray()).find((x) => x.id !== p.id)!;
      await resolveIntent(db, p, 'matching');
      assert(!(await db.pending.get(p.id)), 'exact accepted intent removed');
      const receipt = await db.witnesses.get(p.id);
      await cleanupResolvedWitness(db, p.id, receipt);
      assert(
        !!(await db.device.get(`resolved-witness:${p.id}`)),
        'cleanup retains receipt marker until server absence',
      );
      await cleanupResolvedWitness(db, p.id, null);
      assert(
        !(await db.device.get(`resolved-witness:${p.id}`)),
        'proven absent witness releases marker',
      );
      assert(!!(await db.pending.get(newer.id)), 'newer intent retained');
      await resolveIntent(db, newer, 'superseded');
      assert(
        !(await db.pending.get(newer.id)),
        'resolved superseded intent retired',
      );
      assert(
        (await db.recovery.toArray()).some(
          (r) => r.kind === 'source' && r.markdown === 'newest',
        ),
        'superseded source recoverable',
      );
    } else if (scenario === 'purge') {
      await db.purges.put({ id, epoch, purgedAt: 5 });
      const result = await repo.refreshFromRemote([
        { key: id, markdown: 'latest purged input', revision: 5 },
      ]);
      assert(result.removedIds.includes(id), 'exact removed owner');
      assert(
        (await db.recovery.toArray()).some(
          (r) => r.kind === 'draft' && r.markdown === 'latest purged input',
        ),
        'purged input durable',
      );
    } else throw new Error('Unknown Task3 scenario: ' + scenario);
    return 'ok';
  } finally {
    repo.close();
    await db.delete();
  }
}

export async function runHosted(config: {
  databaseUrl: string;
  demoEmail: string;
}) {
  if (
    config.databaseUrl !== 'https://zjf0aymuw.dexie.cloud' ||
    !config.demoEmail.endsWith('@demo.local')
  )
    throw new Error('Disposable synthetic database required.');
  const { readRemoteLibrary, readRemoteRow, classifyOutcome } =
    await import('../../src/lib/sync/confirmation');
  const name = 'task3-hosted-' + crypto.randomUUID(),
    libraryId = 'task3-' + crypto.randomUUID(),
    epoch = crypto.randomUUID();
  let db = new ScratchtreeDatabase({
    name,
    databaseUrl: config.databaseUrl,
    automaticSync: true,
  });
  const other = new ScratchtreeDatabase({
    name: name + '-other',
    databaseUrl: config.databaseUrl,
    automaticSync: true,
  });
  db.cloud.configure({ ...db.cloud.options!, largeStringThreshold: Infinity });
  other.cloud.configure({
    ...other.cloud.options!,
    largeStringThreshold: Infinity,
  });
  let repo = new DexieRepository(db, files, libraryId);
  const repo2 = new DexieRepository(other, files, libraryId);
  const step = async <T>(name: string, work: Promise<T>): Promise<T> =>
    Promise.race([
      work,
      new Promise<T>((_, reject) =>
        setTimeout(
          () => reject(new Error('Hosted step timed out: ' + name)),
          20000,
        ),
      ),
    ]);
  try {
    await step('first open', db.open());
    await step(
      'first login',
      db.cloud.login({ email: config.demoEmail, grant_type: 'demo' }),
    );
    await db.libraries.add({ id: libraryId, epoch });
    await repo.loadWorkspace();
    await repo.captureItem({
      id,
      location: { scope: 'live', itemId: null },
      markdown: 'synthetic ' + name,
      draft: { key: 'compose', revision: 0 },
    });
    await step('first push', db.cloud.sync({ purpose: 'push', wait: true }));
    const schemaKeys = () =>
      Object.fromEntries(
        ['notes', 'orders', 'purges', 'libraries', 'witnesses'].map((table) => [
          table,
          (
            db.cloud.schema as Record<string, { primaryKey?: unknown }> | null
          )?.[table]?.primaryKey ?? null,
        ]),
      );
    const schemaBefore = schemaKeys();
    db.close();
    db = new ScratchtreeDatabase({
      name,
      databaseUrl: config.databaseUrl,
      automaticSync: true,
    });
    db.cloud.configure({
      ...db.cloud.options!,
      largeStringThreshold: Infinity,
    });
    await step('reopened first client', db.open());
    const schemaAfter = schemaKeys();
    console.info(
      'task3-schema:' + JSON.stringify({ schemaBefore, schemaAfter }),
    );
    await step(
      'reopened schema push',
      db.cloud.sync({ purpose: 'push', wait: true }),
    );
    repo = new DexieRepository(db, files, libraryId);
    await repo.loadWorkspace();
    await repo.saveItemSource(id, 'synthetic reopened ' + name, {
      key: id,
      revision: 1,
    });
    await step(
      'forced enriched schema push',
      db.cloud.sync({ purpose: 'push', wait: true }),
    );

    await other.open();
    await step(
      'second login',
      other.cloud.login({ email: config.demoEmail, grant_type: 'demo' }),
    );
    await step(
      'second pull',
      other.cloud.sync({ purpose: 'pull', wait: true }),
    );
    await repo2.loadWorkspace();
    assert(
      (await repo2.loadWorkspace()).items.some((x) => x.id === id),
      'actual second client source',
    );
    const user = db.cloud.currentUser.getValue(),
      options = {
        databaseUrl: config.databaseUrl,
        automaticSync: true,
        token: user.accessToken!,
        libraryId,
        epoch,
      };
    const remote = await readRemoteLibrary(options);
    assert(
      remote.items.some((x) => x.id === id),
      'managed collection projection',
    );
    const pending = (await db.pending.toArray()).find(
        (p) => p.command.kind === 'saveItemSource',
      )!,
      witness = await readRemoteRow(options, 'witnesses', pending.id);
    assert(
      (await classifyOutcome(pending, witness, remote)) === 'matching',
      'actual witness admission and source',
    );
    const engine = new SyncEngine({
      db,
      repository: repo,
      files,
      serialize: serial(),
      onInvalidation: () => {},
    });
    await engine.retry();
    assert(
      (await db.pending.count()) === 0,
      'production engine confirmed admitted creation',
    );
    const source = 'Large synthetic exact 雪😀\r\n' + 'x'.repeat(40000);
    await repo.saveItemSource(id, source, { key: id, revision: 2 });
    await step('first push', db.cloud.sync({ purpose: 'push', wait: true }));
    await engine.retry();
    assert(
      (await db.pending.count()) === 0,
      'large source direct REST confirmed',
    );
    await step(
      'second pull',
      other.cloud.sync({ purpose: 'pull', wait: true }),
    );
    assert(
      (await repo2.loadWorkspace()).items.find((x) => x.id === id)?.markdown ===
        source,
      'large source second client exact',
    );
    await repo.saveItemSource(id, 'local alternative before external write', {
      key: id,
      revision: 3,
    });
    await step(
      'alternative push',
      db.cloud.sync({ purpose: 'push', wait: true }),
    );
    await step(
      'competing pull',
      other.cloud.sync({ purpose: 'pull', wait: true }),
    );
    await repo2.saveItemSource(id, 'remote canonical source', {
      key: id,
      revision: 1,
    });
    await step(
      'competing push',
      other.cloud.sync({ purpose: 'push', wait: true }),
    );
    await step(
      'local supersession pull',
      db.cloud.sync({ purpose: 'pull', wait: true }),
    );
    await engine.retry();
    assert(
      (await db.recovery.toArray()).some(
        (r) =>
          r.kind === 'source' &&
          r.markdown === 'local alternative before external write',
      ),
      'genuine superseded local alternative durable',
    );
    const missing = crypto.randomUUID(),
      command = {
        kind: 'saveItemSource' as const,
        id: missing,
        markdown: 'missing-target exact recovery',
        draft: { key: missing, revision: 1 },
      },
      expected = { items: [], orders: [], purgedIds: [] };
    const noop: PendingIntent = {
      id: crypto.randomUUID(),
      epoch,
      sequence: 0,
      recordedAt: Date.now(),
      command,
      expected,
      localApplied: false,
      fingerprint: await digest({ epoch, command }),
      digest: await digest({ command, expected }),
    };
    await preservePendingIntent(db, noop);
    await db.transaction(
      'rw',
      [db.notes, db.witnesses, db.pending],
      async () => {
        assert(
          (await db.notes.update([epoch, missing], {
            markdown: command.markdown,
          })) === 0,
          'actual missing-target update no-op',
        );
        await db.witnesses.add({
          id: noop.id,
          epoch,
          digest: noop.digest,
          recordedAt: noop.recordedAt,
        });
        await db.pending.update(noop.id, { localApplied: true });
      },
    );
    await step(
      'no-op witness push',
      db.cloud.sync({ purpose: 'push', wait: true }),
    );
    await engine.retry();
    assert(
      !(await db.pending.get(noop.id)) &&
        (await db.recovery.toArray()).some(
          (r) =>
            r.kind === 'source' &&
            r.itemId === missing &&
            r.markdown === command.markdown,
        ),
      'admitted no-op is recovered rather than acknowledged source',
    );
    await repo.saveItemSource(id, 'cleanup survives failure', {
      key: id,
      revision: 4,
    });
    const cleanup = (await db.pending.toArray()).find(
      (p) =>
        p.command.kind === 'saveItemSource' &&
        p.command.markdown === 'cleanup survives failure',
    )!;
    await step(
      'cleanup source push',
      db.cloud.sync({ purpose: 'push', wait: true }),
    );
    const originalDelete = db.witnesses.delete.bind(db.witnesses);
    db.witnesses.delete = () =>
      ScratchtreeDatabase.Promise.reject(
        new Error('synthetic cleanup IO failure'),
      );
    try {
      await engine.retry();
      assert(
        !(await db.pending.get(cleanup.id)),
        'cleanup failure cannot revoke acknowledged source',
      );
      assert(
        !!(await db.device.get('resolved-witness:' + cleanup.id)),
        'cleanup retry context retained',
      );
    } finally {
      db.witnesses.delete = originalDelete;
    }
    await engine.retry();
    await step(
      'cleanup deletion push',
      db.cloud.sync({ purpose: 'push', wait: true }),
    );
    await engine.retry();
    assert(
      !(await db.device.get('resolved-witness:' + cleanup.id)),
      'server witness absence completes exact cleanup',
    );
    await repo.saveItemSource(id, 'lost reply survives persistent reopen', {
      key: id,
      revision: 5,
    });
    const lost = (await db.pending.toArray()).find(
      (p) => p.command.kind === 'saveItemSource',
    )!;
    await step(
      'lost source push',
      db.cloud.sync({ purpose: 'push', wait: true }),
    );
    let drop = true;
    const lostEngine = new SyncEngine({
      db,
      repository: repo,
      files,
      serialize: serial(),
      onInvalidation: () => {},
      fetch: async (...args) => {
        const response = await fetch(...args);
        if (drop) {
          drop = false;
          throw new Error('synthetic lost REST reply');
        }
        return response;
      },
    });
    await lostEngine.retry();
    assert(
      !!(await db.pending.get(lost.id)),
      'lost reply retains exact intent',
    );
    lostEngine.close();
    engine.close();
    db.close();
    db = new ScratchtreeDatabase({
      name,
      databaseUrl: config.databaseUrl,
      automaticSync: true,
    });
    await step('persistent restart open', db.open());
    await step(
      'persistent restart pull',
      db.cloud.sync({ purpose: 'pull', wait: true }),
    );
    repo = new DexieRepository(db, files, libraryId);
    await repo.loadWorkspace();
    assert(
      db.cloud.currentUser.getValue().isLoggedIn,
      'public persistent user restored without login',
    );
    assert(
      !!(await db.pending.get(lost.id)),
      'restart retains unknown exact intent',
    );
    const resumed = new SyncEngine({
      db,
      repository: repo,
      files,
      serialize: serial(),
      onInvalidation: () => {},
    });
    await resumed.retry();
    assert(
      !(await db.pending.get(lost.id)),
      'restart confirms only exact admitted intent',
    );
    resumed.start();
    const liveSource = 'event-driven source ' + crypto.randomUUID();
    await repo.saveItemSource(id, liveSource, { key: id, revision: 6 });
    await step(
      'event-driven second client source',
      new Promise<void>((resolve, reject) => {
        const check = async () => {
          try {
            if ((await other.notes.get([epoch, id]))?.markdown === liveSource) {
              sub.unsubscribe();
              resolve();
            }
          } catch (error) {
            reject(error);
          }
        };
        const sub = other.cloud.events.syncComplete.subscribe(() => {
          void check();
        });
        void check();
      }),
    );
    await step(
      'event-driven confirmation',
      new Promise<void>((resolve, reject) => {
        let unsubscribe = () => {};
        unsubscribe = resumed.subscribe((state) => {
          void (async () => {
            try {
              if (
                state.state === 'up-to-date' &&
                (await db.pending.count()) === 0
              ) {
                unsubscribe();
                resolve();
              }
            } catch (error) {
              reject(error);
            }
          })();
        });
      }),
    );
    resumed.close();
    const deniedCommand = {
        kind: 'saveItemSource' as const,
        id,
        markdown: 'permission-rejected exact alternative',
        draft: { key: id, revision: 7 },
      },
      deniedExpected = { items: [], orders: [], purgedIds: [] };
    const denied: PendingIntent = {
      id: crypto.randomUUID(),
      epoch,
      sequence: 0,
      recordedAt: Date.now(),
      command: deniedCommand,
      expected: deniedExpected,
      localApplied: false,
      fingerprint: await digest({ epoch, command: deniedCommand }),
      digest: await digest({
        command: deniedCommand,
        expected: deniedExpected,
      }),
    };
    await preservePendingIntent(db, denied);
    await db.recovery.put({
      id: crypto.randomUUID(),
      kind: 'source',
      itemId: id,
      markdown: deniedCommand.markdown,
      originEpoch: epoch,
      recordedAt: Date.now(),
      reason: 'unknown',
    });
    await db.transaction(
      'rw',
      [db.notes, db.witnesses, db.pending],
      async () => {
        const current = (await db.notes.get([epoch, id]))!;
        await db.notes.update([epoch, id], {
          markdown: deniedCommand.markdown,
          updatedAt: Date.now(),
        });
        await db.witnesses.add({
          id: denied.id,
          epoch,
          digest: denied.digest,
          recordedAt: denied.recordedAt,
        });
        const deniedRow = {
          ...current,
          id: crypto.randomUUID(),
          markdown: 'synthetic denied realm marker',
          owner: null,
          realmId: 'denied-' + crypto.randomUUID(),
        };
        await db.notes.add(deniedRow);
        await db.pending.update(denied.id, { localApplied: true });
      },
    );
    await step(
      'actual permission rejection push',
      db.cloud.sync({ purpose: 'push', wait: true }),
    );
    const finalOptions = {
      databaseUrl: config.databaseUrl,
      token: db.cloud.currentUser.getValue().accessToken!,
    };
    assert(
      (await readRemoteRow(finalOptions, 'witnesses', denied.id)) === null,
      'forbidden realm transaction has no admitted witness',
    );
    assert(
      (
        (await readRemoteRow(finalOptions, 'notes', [epoch, id])) as {
          markdown: string;
        }
      ).markdown === liveSource,
      'server retains canonical source after actual permission rejection',
    );
    const rejectedEngine = new SyncEngine({
      db,
      repository: repo,
      files,
      serialize: serial(),
      onInvalidation: () => {},
    });
    await rejectedEngine.retry();
    assert(
      !!(await db.pending.get(denied.id)) &&
        (await db.recovery.toArray()).some(
          (r) => r.kind === 'source' && r.markdown === deniedCommand.markdown,
        ),
      'HTTP-successful SDK rejection preserves exact pending and source alternative',
    );
    rejectedEngine.close();
    return {
      collection: true,
      twoClients: true,
      largeSource: true,
      supersession: true,
      noop: true,
      cleanup: true,
      lostReplyRestart: true,
      eventDriven: true,
      rejection: true,
      schemaBefore,
      schemaAfter,
    };
  } finally {
    db.close();
    other.close();
  }
}
