import { digest } from '../../src/lib/sync/intents';
import { ScratchtreeDatabase } from '../../src/lib/sync/database';
import { DexieRepository } from '../../src/lib/sync/repository';
import {
  captureMoveProof,
  captureUndoDelete,
  subtreeIds,
} from '../../src/lib/domain/items';
import {
  encodeCloudBackup,
  validateCloudBackup,
} from '../../src/lib/sync/backup';
import type { Location } from '../../src/lib/domain/notes';
import { MAX_SOURCE } from '../../src/lib/domain/notes';
const root = { scope: 'live', itemId: null } as const;
const trash = { scope: 'trash', itemId: null } as const;
const id = (n: number) =>
  `ABCDEF00-0000-4000-8000-${String(n).padStart(12, '0')}`;
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function rejects(fn: () => Promise<unknown>) {
  let failed = false;
  try {
    await fn();
  } catch {
    failed = true;
  }
  assert(failed, 'expected rejection');
}
export async function run(scenario: string) {
  const name = `scratchtree-test-${crypto.randomUUID()}`;
  let db = new ScratchtreeDatabase({ name });
  let read: string | null = null,
    written: string | null = null,
    safetyFails = false;
  const files = {
    chooseRead: async () => read,
    chooseWrite: async (text: string) => {
      written = text;
      return 'synthetic.json';
    },
    writeSafety: async () => {
      if (safetyFails) throw new Error('safety failed');
    },
  };
  let repo = new DexieRepository(db, files);
  const capture = (
    n: number,
    markdown = `note${n}`,
    location: Location = root,
  ) =>
    repo.captureItem({
      id: id(n),
      location,
      markdown,
      draft: {
        key: location.itemId
          ? `compose:${location.itemId}`
          : location.scope === 'trash'
            ? 'compose:trash'
            : 'compose',
        revision: 0,
      },
    });
  try {
    assert((await repo.loadWorkspace()).items.length === 0, 'new empty');
    if (scenario === 'durability') {
      const source = '# 雪😀\r\n- list\r\n```ts\r\nλ\r\n```';
      await capture(1, source);
      const epoch = await repo.getEpoch();
      await db.device.put({ key: 'unknown-setting', value: { keep: true } });
      repo.close();
      db = new ScratchtreeDatabase({ name });
      repo = new DexieRepository(db, files);
      assert(
        (await repo.loadWorkspace()).items[0].markdown === source,
        'source bytes preserved',
      );
      assert((await repo.getEpoch()) === epoch, 'epoch durable');
      assert(
        (await db.device.get('unknown-setting'))?.value != null,
        'unknown settings retained',
      );
      assert(
        (await db.pending.count()) === 1 && (await db.witnesses.count()) === 1,
        'durable pending and witness',
      );
    } else if (scenario === 'commands') {
      await capture(1);
      await capture(2);
      await repo.promoteItem(id(1));
      await repo.setItemDone(id(1), true);
      await repo.setItemColor(id(1), 'blue');
      const prior = (await repo.loadWorkspace()).items.find(
        (x) => x.id === id(1),
      )!;
      await repo.setItemDone(id(1), true);
      await repo.reorderItem({ id: id(2), group: root, toIndex: 0 });
      let s = await repo.loadWorkspace();
      assert(
        s.items.find((x) => x.id === id(1))!.updatedAt === prior.updatedAt,
        'neighbor timestamp',
      );
      await repo.transitionLocation({
        from: { scope: 'live', itemId: id(1) },
        to: root,
        promoteDestination: false,
      });
      s = await repo.loadWorkspace();
      assert(s.items.find((x) => x.id === id(1))!.kind === 'note', 'demote');
      await repo.createChildTree({
        id: id(3),
        parent: { scope: 'live', itemId: id(1) },
      });
      s = await repo.loadWorkspace();
      assert(
        s.items.find((x) => x.id === id(1))!.kind === 'tree' &&
          s.items.find((x) => x.id === id(3))!.markdown === 'Untitled',
        'atomic child promotion',
      );
      await rejects(() =>
        repo.createChildTree({
          id: id(2),
          parent: { scope: 'live', itemId: id(3) },
        }),
      );
      assert(
        (await repo.loadWorkspace()).items.find((x) => x.id === id(3))!.kind ===
          'tree',
        'failure rollback',
      );
    } else if (scenario === 'drafts') {
      await repo.checkpointDraft('compose', 'new', 3);
      await repo.checkpointDraft('compose', 'stale', 1);
      assert(
        (await repo.loadWorkspace()).drafts[0].markdown === 'new',
        'stale revision',
      );
      await capture(1);
      assert(
        (await repo.loadWorkspace()).drafts[0].revision === 3,
        'newer checkpoint survives capture ack',
      );
      await repo.checkpointDraft(id(1), 'dirty', 4);
      await repo.saveItemSource(id(1), 'saved', { key: id(1), revision: 3 });
      assert(
        (await repo.loadWorkspace()).drafts.some((d) => d.key === id(1)),
        'newer source draft survives',
      );
      await repo.saveItemSource(id(1), 'saved', { key: id(1), revision: 4 });
      await repo.discardDraft('compose');
      assert(
        (await repo.loadWorkspace()).drafts.length === 0,
        'ack and discard',
      );
    } else if (scenario === 'structure') {
      await capture(1);
      await capture(2);
      await repo.createChildTree({ id: id(3), parent: root });
      let s = await repo.loadWorkspace();
      const r = captureMoveProof(s, {
        ids: [id(1), id(2)],
        from: root,
        to: { scope: 'live', itemId: id(3) },
        beforeFrom: [id(1), id(2), id(3)],
        beforeTo: [],
        afterFrom: [id(3)],
        afterTo: [id(1), id(2)],
      });
      await repo.moveItems(r);
      await repo.moveItems(r);
      s = await repo.loadWorkspace();
      assert(
        s.items.filter((x) => x.parentId === id(3)).length === 2,
        'move exact replay',
      );
      await rejects(() =>
        repo.moveItems({
          ...r,
          ids: [id(3)],
          from: root,
          to: { scope: 'live', itemId: id(3) },
        }),
      );
      await repo.reorderItem({
        id: id(2),
        group: { scope: 'live', itemId: id(3) },
        toIndex: 0,
      });
      await rejects(() => repo.moveItems(r));
    } else if (scenario === 'trash') {
      await repo.createChildTree({ id: id(1), parent: root });
      await repo.captureItem({
        id: id(2),
        location: { scope: 'live', itemId: id(1) },
        markdown: 'child',
        draft: { key: `compose:${id(1)}`, revision: 0 },
      });
      await capture(3);
      await repo.deleteItem(id(2));
      await repo.deleteItem(id(1));
      await repo.restoreItem(id(1));
      let s = await repo.loadWorkspace();
      assert(
        s.items.find((x) => x.id === id(2))!.deletedAt !== null,
        'independent deletion retained',
      );
      const r = captureMoveProof(s, {
        ids: [id(1), id(3)],
        from: root,
        to: trash,
        beforeFrom: [id(1), id(3)],
        beforeTo: [id(2)],
        afterFrom: [],
        afterTo: [id(2), id(1), id(3)],
      });
      await repo.moveItems(r);
      s = await repo.loadWorkspace();
      assert(s.undoDeleteIds.length === 2, 'group Undo');
      await repo.undoDelete(captureUndoDelete(s));
      await repo.deleteItem(id(1));
      s = await repo.loadWorkspace();
      const purged = await repo.purgeItem({
        id: id(1),
        location: trash,
        expectedSubtreeIds: subtreeIds(s, id(1)),
      });
      assert(
        purged.removedIds.includes(id(1)) &&
          purged.workspace.items.some((x) => x.id === id(2)),
        'purge exact subtree',
      );
      assert(
        !(await db.notes.get([await repo.getEpoch(), id(1)])),
        'acknowledged purge removes the raw payload while keeping its tombstone',
      );
      await rejects(() => capture(1, 'resurrection'));
    } else if (scenario === 'barriers') {
      await capture(1);
      const old = await repo.loadWorkspace();
      const off = () => {
        throw new Error('barrier failed');
      };
      db.pending.hook('creating', off);
      await rejects(() =>
        repo.saveItemSource(id(1), 'retained', { key: id(1), revision: 0 }),
      );
      db.pending.hook('creating').unsubscribe(off);
      assert(
        (await repo.loadWorkspace()).items[0].markdown ===
          old.items[0].markdown,
        'barrier prevents shared write',
      );
      let fail = true;
      const hook = () => {
        if (fail) throw new Error('uncertain');
      };
      db.notes.hook('updating', hook);
      await rejects(() =>
        repo.saveItemSource(id(1), 'retained', { key: id(1), revision: 0 }),
      );
      const pending = (await db.pending.toArray()).find(
        (x) => x.command.kind === 'saveItemSource',
      )!;
      assert(pending, 'durable intent survives shared failure');
      fail = false;
      await repo.saveItemSource(id(1), 'retained', { key: id(1), revision: 0 });
      assert(
        (await db.pending.toArray()).filter(
          (x) => x.fingerprint === pending.fingerprint,
        ).length === 1,
        'retry stable identity',
      );
      assert(await db.witnesses.get(pending.id), 'exact retry witness');
      db.notes.hook('updating').unsubscribe(hook);
    } else if (scenario === 'backup') {
      await capture(1);
      await repo.exportBackup();
      assert(written, 'export IO');
      const b = validateCloudBackup(written);
      assert(!('code' in b), 'valid V8');
      assert(
        b.device.recovery.some(
          (x) => x.kind === 'source' && x.markdown === 'note1',
        ),
        'pending recovery exported',
      );
      read = encodeCloudBackup({
        library: { items: [], purgedIds: [] },
        device: { drafts: [], undoDeleteIds: [], recovery: [] },
      });
      let preview = await repo.previewRestore();
      assert(preview, 'preview');
      assert(
        (await repo.confirmRestore(preview.token, false)) === null,
        'cancel',
      );
      assert(
        (await repo.loadWorkspace()).items.length === 1,
        'cancel preserves',
      );
      preview = await repo.previewRestore();
      assert(preview, 'preview2');
      safetyFails = true;
      await rejects(() => repo.confirmRestore(preview!.token, true));
      assert(
        (await repo.loadWorkspace()).items.length === 1,
        'safety failure preserves',
      );
      const oldEpoch = await repo.getEpoch();
      safetyFails = false;
      await repo.confirmRestore(preview.token, true);
      assert(
        (await repo.loadWorkspace()).items.length === 0 &&
          (await repo.getEpoch()) !== oldEpoch,
        'fresh epoch replacement',
      );
      await repo.exportBackup();
      const after = validateCloudBackup(written!);
      assert(
        !('code' in after) &&
          after.device.recovery.some((x) => x.kind === 'library'),
        'retired work recovery',
      );
    } else if (scenario === 'atomicity') {
      await capture(1);
      const epoch = await repo.getEpoch();
      let fail = true;
      const hook = () => {
        if (fail) throw new Error('atomic child failure');
      };
      db.notes.hook('creating', hook);
      await rejects(() =>
        repo.createChildTree({
          id: id(2),
          parent: { scope: 'live', itemId: id(1) },
        }),
      );
      assert(
        (await repo.loadWorkspace()).items[0].kind === 'note' &&
          !(await db.notes.get([epoch, id(2)])),
        'no partial promotion or insertion',
      );
      const intent = (await db.pending.toArray()).find(
        (x) => x.command.kind === 'createChildTree',
      )!;
      repo.close();
      db = new ScratchtreeDatabase({ name });
      repo = new DexieRepository(db, files);
      await repo.loadWorkspace();
      await repo.createChildTree({
        id: id(2),
        parent: { scope: 'live', itemId: id(1) },
      });
      assert(
        (await repo.loadWorkspace()).items.length === 2 &&
          (await db.witnesses.get(intent.id)),
        'reopened exact child intent',
      );
    } else if (scenario === 'epoch-isolation') {
      await capture(1, 'old');
      const oldEpoch = await repo.getEpoch();
      const snapshot = await repo.loadWorkspace();
      snapshot.items[0].markdown = 'replacement';
      read = encodeCloudBackup({
        library: { items: snapshot.items, purgedIds: [] },
        device: { drafts: [], undoDeleteIds: [], recovery: [] },
      });
      const preview = await repo.previewRestore();
      assert(preview, 'preview');
      await repo.confirmRestore(preview.token, true);
      const newEpoch = await repo.getEpoch();
      assert(
        oldEpoch !== newEpoch &&
          (await db.notes.get([oldEpoch, id(1)]))?.markdown === 'old' &&
          (await db.notes.get([newEpoch, id(1)]))?.markdown === 'replacement',
        'same exact UUID retains separate epoch rows',
      );
      await repo.saveItemSource(id(1), 'new edit', { key: id(1), revision: 0 });
      assert(
        (await db.notes.get([oldEpoch, id(1)]))?.markdown === 'old',
        'no retired epoch crosswrite',
      );
      await db.notes.update([newEpoch, id(1)], {
        owner: 'provider',
        realmId: 'realm',
      } as never);
      assert(
        (await repo.loadWorkspace()).items[0].markdown === 'new edit',
        'only provider-owned extras stripped',
      );
    } else if (scenario === 'lost-ack') {
      await capture(1);
      const first = (await db.pending.toArray())[0];
      repo.close();
      db = new ScratchtreeDatabase({ name });
      repo = new DexieRepository(db, files);
      await repo.loadWorkspace();
      await capture(1);
      assert(
        (await db.pending.count()) === 1 && (await db.witnesses.get(first.id)),
        'lost acknowledgment exact replay identity',
      );
      await repo.saveItemSource(id(1), 'second', { key: id(1), revision: 0 });
      await repo.saveItemSource(id(1), 'note1', { key: id(1), revision: 0 });
      assert(
        (await repo.loadWorkspace()).items[0].markdown === 'note1',
        'intentional later revert allowed',
      );
    } else if (scenario === 'undo-facts') {
      await capture(1);
      await capture(2);
      let s = await repo.loadWorkspace();
      await repo.moveItems(
        captureMoveProof(s, {
          ids: [id(1), id(2)],
          from: root,
          to: trash,
          beforeFrom: [id(1), id(2)],
          beforeTo: [],
          afterFrom: [],
          afterTo: [id(1), id(2)],
        }),
      );
      const epoch = await repo.getEpoch(),
        row = await db.notes.get([epoch, id(1)]);
      assert(row, 'row');
      await db.notes.update([epoch, id(1)], {
        placement: {
          ...row.placement,
          deletedAt: row.placement.deletedAt! + 100,
        },
      });
      s = await repo.loadWorkspace();
      assert(
        s.undoDeleteIds.length === 1 && s.undoDeleteIds[0] === id(2),
        'remote redelete removes only original deletion fact',
      );
      await repo.undoDelete(captureUndoDelete(s));
      s = await repo.loadWorkspace();
      assert(
        s.items.find((x) => x.id === id(1))!.deletedAt !== null &&
          s.items.find((x) => x.id === id(2))!.deletedAt === null,
        'Undo cannot consume redelete',
      );
    } else if (scenario === 'backup-failures') {
      await capture(1);
      await db.device.put({ key: 'unknown-setting', value: 'retained' });
      assert((await repo.previewRestore()) === null, 'cancel read');
      read = '{"version":7}';
      await rejects(() => repo.previewRestore());
      read = encodeCloudBackup({
        library: { items: [], purgedIds: [] },
        device: { drafts: [], undoDeleteIds: [], recovery: [] },
      });
      const preview = await repo.previewRestore();
      assert(preview, 'preview');
      const hook = () => {
        throw new Error('replacement transaction failure');
      };
      db.libraries.hook('updating', hook);
      await rejects(() => repo.confirmRestore(preview.token, true));
      db.libraries.hook('updating').unsubscribe(hook);
      assert(
        (await repo.loadWorkspace()).items.length === 1,
        'replacement failure rollback',
      );
      await repo.confirmRestore(preview.token, true);
      assert(
        (await repo.loadWorkspace()).items.length === 0,
        'same restore token retries',
      );
      assert(
        (await db.device.get('unknown-setting'))?.value === 'retained',
        'replacement preserves unknown settings',
      );
    } else if (scenario === 'invalidations') {
      let calls = 0;
      const unsubscribe = repo.subscribeInvalidation(() => calls++);
      for (let i = 0; i < 40 && calls === 0; i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      const initial = calls;
      await capture(1);
      for (let i = 0; i < 40 && calls <= initial; i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert(calls > initial, 'mutation emits an observable invalidation');
      unsubscribe();
      const before = calls;
      await repo.setItemDone(id(1), true);
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert(calls === before, 'unsubscribe');
    } else if (scenario === 'remote-epoch') {
      await capture(1, 'old');
      await repo.checkpointDraft(`compose:${id(1)}`, 'old composer', 2);
      await repo.checkpointDraft(id(1), 'old inline', 4);
      const oldEpoch = await repo.getEpoch();
      const otherDb = new ScratchtreeDatabase({ name }),
        other = new DexieRepository(otherDb, files);
      await other.loadWorkspace();
      const old = await other.loadWorkspace();
      old.items[0].markdown = 'replacement';
      read = encodeCloudBackup({
        library: { items: old.items, purgedIds: [] },
        device: { drafts: [], undoDeleteIds: [], recovery: [] },
      });
      const preview = await other.previewRestore();
      assert(preview, 'remote preview');
      await other.confirmRestore(preview.token, true);
      const newEpoch = await other.getEpoch();
      assert(
        (await repo.getEpoch()) === oldEpoch &&
          (await repo.readCurrentEpoch()) === newEpoch,
        'pointer reads never adopt a replacement',
      );
      const queued = repo.saveItemSource(id(1), 'retired latest', {
        key: id(1),
        revision: 4,
      });
      await rejects(() => queued);
      assert(
        (await db.notes.get([newEpoch, id(1)]))?.markdown === 'replacement',
        'oldeditor source cannot cross sameUUID epoch',
      );
      await rejects(() =>
        repo.checkpointDraft(`compose:${id(1)}`, 'newest retired draft', 5),
      );
      await repo.loadWorkspace();
      assert(
        (await repo.getEpoch()) === newEpoch,
        'explicit load adopts acknowledged view',
      );
      await repo.exportBackup();
      const exported = validateCloudBackup(written!);
      assert(!('code' in exported), 'recovery export');
      assert(
        exported.device.recovery.some(
          (x) =>
            x.kind === 'source' &&
            x.originEpoch === oldEpoch &&
            x.markdown === 'retired latest',
        ),
        'retired pending source exported',
      );
      assert(
        exported.device.recovery.some(
          (x) =>
            x.kind === 'draft' &&
            x.originEpoch === oldEpoch &&
            x.markdown === 'newest retired draft',
        ) ||
          exported.device.recovery.some(
            (x) =>
              x.kind === 'library' &&
              x.originEpoch === oldEpoch &&
              x.snapshot.drafts.some(
                (d) => d.markdown === 'newest retired draft',
              ),
          ),
        'retired checkpoint exported',
      );
      other.close();
    } else if (scenario === 'captured-outcome-clock') {
      const originalNow = Date.now;
      let clock = 100000;
      Date.now = () => clock;
      try {
        await capture(1, 'original');
        const advance = () => {
          clock += 10000;
        };
        db.pending.hook('creating', advance);
        const operations = [
          {
            kind: 'saveItemSource',
            run: () =>
              repo.saveItemSource(id(1), 'captured source', {
                key: id(1),
                revision: 1,
              }),
          },
          { kind: 'setItemDone', run: () => repo.setItemDone(id(1), true) },
          { kind: 'setItemColor', run: () => repo.setItemColor(id(1), 'blue') },
          { kind: 'promoteItem', run: () => repo.promoteItem(id(1)) },
        ];
        for (const operation of operations) {
          clock += 1000;
          const committed = await operation.run();
          const intent = (await db.pending.toArray()).find(
            (x) => x.command.kind === operation.kind,
          )!;
          assert(intent, 'captured intent');
          const outcome = intent.expected.items.find((x) => x.id === id(1));
          assert(outcome, 'captured outcome');
          const item = committed.items.find((x) => x.id === id(1))!;
          assert(
            (await digest(item)) === outcome.digest,
            'committed existing-item outcome uses the captured timestamp across the barrier',
          );
          const counts = {
            pending: await db.pending.count(),
            witnesses: await db.witnesses.count(),
          };
          const snapshot = JSON.stringify(committed.items);
          repo.close();
          db = new ScratchtreeDatabase({ name });
          repo = new DexieRepository(db, files);
          await repo.loadWorkspace();
          clock += 100000;
          const replay = await operation.run();
          assert(
            (await db.pending.count()) === counts.pending &&
              (await db.witnesses.count()) === counts.witnesses &&
              (await db.witnesses.get(intent.id)),
            'existing-item reopen replay reuses exact intent and witness',
          );
          assert(
            JSON.stringify(replay.items) === snapshot,
            'existing-item acknowledged replay does not touch timestamps',
          );
          db.pending.hook('creating', advance);
        }
        // A newer unrelated field/time is retained, but it cannot manufacture a new source intent.
        const sourceIntent = (await db.pending.toArray()).find(
          (x) => x.command.kind === 'saveItemSource',
        )!;
        const epoch = await repo.getEpoch();
        clock += 1000;
        await db.notes.update([epoch, id(1)], {
          color: 'pink',
          updatedAt: clock,
        });
        const count = await db.pending.count();
        await repo.saveItemSource(id(1), 'captured source', {
          key: id(1),
          revision: 1,
        });
        const item = (await repo.loadWorkspace()).items[0];
        assert(
          item.color === 'pink' &&
            item.updatedAt === clock &&
            (await db.pending.count()) === count &&
            (await db.witnesses.get(sourceIntent.id)),
          'unrelated newer metadata preserves source retry identity and timestamp',
        );
      } finally {
        Date.now = originalNow;
      }
    } else if (scenario === 'purged-latest-input') {
      await capture(1, 'original');
      await repo.checkpointDraft(id(1), 'older inline', 2);
      await repo.checkpointDraft(`compose:${id(1)}`, 'older composer', 2);
      const epoch = await repo.getEpoch();
      await db.purges.put({ id: id(1), epoch, purgedAt: Date.now() });
      const pendingCount = await db.pending.count(),
        witnessCount = await db.witnesses.count();
      await rejects(() =>
        repo.saveItemSource(id(1), 'latest supplied source\r\n雪😀', {
          key: id(1),
          revision: 4,
        }),
      );
      const newestSource = (await db.recovery.toArray()).find(
        (x) =>
          x.kind === 'source' && x.itemId === id(1) && x.originEpoch === epoch,
      )!;
      await rejects(() =>
        repo.saveItemSource(id(1), 'older captured source retry', {
          key: id(1),
          revision: 3,
        }),
      );
      assert(
        JSON.stringify(await db.recovery.get(newestSource.id)) ===
          JSON.stringify(newestSource),
        'older rejected source revision cannot replace the newest exact recovery record',
      );
      assert(
        (await db.drafts.get([epoch, id(1)]))?.revision === 2,
        'rejected source does not acknowledge its draft',
      );
      await rejects(() =>
        repo.checkpointDraft(id(1), 'latest supplied inline', 5),
      );
      await rejects(() =>
        repo.checkpointDraft(`compose:${id(1)}`, 'latest supplied composer', 5),
      );
      await rejects(() =>
        repo.checkpointDraft(id(1), 'stale inline must not replace latest', 4),
      );
      await rejects(() =>
        repo.checkpointDraft(
          `compose:${id(1)}`,
          'stale composer must not replace latest',
          4,
        ),
      );
      assert(
        (await db.pending.count()) === pendingCount &&
          (await db.witnesses.count()) === witnessCount,
        'missing targets do not acquire admission witnesses or successful pending writes',
      );
      repo.close();
      db = new ScratchtreeDatabase({ name });
      repo = new DexieRepository(db, files);
      assert(
        (await repo.loadWorkspace()).items.length === 0,
        'latest input never resurrects a purged note',
      );
      await rejects(() =>
        repo.saveItemSource(id(1), 'older source after reopen', {
          key: id(1),
          revision: 3,
        }),
      );
      await rejects(() =>
        repo.saveItemSource(id(1), 'x'.repeat(MAX_SOURCE + 1), {
          key: id(1),
          revision: 3,
        }),
      );
      await rejects(() =>
        repo.checkpointDraft(id(1), 'older checkpoint after source/reopen', 4),
      );
      assert(
        JSON.stringify(await db.recovery.get(newestSource.id)) ===
          JSON.stringify(newestSource),
        'source recovery identity and newest revision survive stale retries after reopen',
      );
      assert(
        (await db.pending.count()) === pendingCount &&
          (await db.witnesses.count()) === witnessCount,
        'cross checkpoint/source rejection never admits a shared command',
      );
      await repo.exportBackup();
      const exported = validateCloudBackup(written!);
      assert(!('code' in exported), 'strict recovery export');
      assert(
        exported.device.recovery.some(
          (x) =>
            x.kind === 'source' &&
            x.itemId === id(1) &&
            x.originEpoch === epoch &&
            x.markdown === 'latest supplied source\r\n雪😀',
        ),
        'latest source after purge is durably exported',
      );
      assert(
        exported.device.recovery.some(
          (x) =>
            x.kind === 'draft' &&
            x.draftKey === id(1) &&
            x.originEpoch === epoch &&
            x.markdown === 'latest supplied inline',
        ),
        'latest inline checkpoint after purge survives reopen',
      );
      assert(
        exported.device.recovery.some(
          (x) =>
            x.kind === 'draft' &&
            x.draftKey === `compose:${id(1)}` &&
            x.originEpoch === epoch &&
            x.markdown === 'latest supplied composer',
        ),
        'latest scoped composer checkpoint after purge survives reopen',
      );
    } else if (scenario === 'large-reorder-intent') {
      const epoch = await repo.getEpoch();
      const notes = Array.from({ length: 6 }, (_, n) => ({
        id: id(n + 1),
        epoch,
        kind: 'note' as const,
        markdown: String(n) + '\n' + 'x'.repeat(MAX_SOURCE - 2),
        done: false,
        color: null,
        createdAt: n,
        updatedAt: n,
        placement: {
          parentId: null,
          deletedAt: null,
          restoreParentId: null,
          restoreIndex: null,
        },
      }));
      await db.notes.bulkAdd(notes);
      await repo.loadWorkspace();
      assert(
        (await db.pending.count()) === 0,
        'valid 6 MiB library starts without unresolved intents',
      );
      await repo.exportBackup();
      assert(
        written && new TextEncoder().encode(written).length < 10 * 1024 * 1024,
        'library fits current complete backup limit',
      );
      const result = await repo.reorderItem({
        id: id(6),
        group: root,
        toIndex: 0,
      });
      assert(
        result.items.find((x) => x.id === id(6))!.position === 0,
        'long reorder commits for a valid multi-megabyte library',
      );
      const intent = (await db.pending.toArray())[0];
      assert(
        new TextEncoder().encode(JSON.stringify(intent)).length < 64000,
        'structural intent excludes unchanged Markdown',
      );
      const timestamp = result.items.find((x) => x.id === id(6))!.updatedAt;
      repo.close();
      db = new ScratchtreeDatabase({ name });
      repo = new DexieRepository(db, files);
      await repo.loadWorkspace();
      await repo.reorderItem({ id: id(6), group: root, toIndex: 0 });
      const replay = await repo.loadWorkspace();
      assert(
        (await db.pending.count()) === 1 &&
          (await db.witnesses.count()) === 1 &&
          (await db.witnesses.get(intent.id)),
        'large reorder reopen replay keeps exact witness',
      );
      assert(
        replay.items.find((x) => x.id === id(6))!.updatedAt === timestamp &&
          replay.items.every(
            (x) => x.markdown === notes.find((n) => n.id === x.id)!.markdown,
          ),
        'replay preserves source bytes and captured metadata',
      );
    } else if (scenario === 'recovery-collision') {
      await capture(1);
      await repo.exportBackup();
      const exported = validateCloudBackup(written!);
      assert(!('code' in exported), 'backup');
      const record = exported.device.recovery.find((x) => x.kind === 'source');
      assert(record && record.kind === 'source', 'source recovery');
      record.markdown = 'different imported recovery';
      read = encodeCloudBackup({
        library: exported.library,
        device: exported.device,
      });
      const preview = await repo.previewRestore();
      assert(preview, 'preview');
      const epoch = await repo.getEpoch();
      await repo.confirmRestore(preview.token, true);
      assert(
        read ===
          encodeCloudBackup(
            { library: exported.library, device: exported.device },
            JSON.parse(read!).exportedAt,
          ),
        'restore leaves the captured input unchanged',
      );
      const recoveries = await db.recovery.toArray();
      assert(
        (await repo.getEpoch()) !== epoch &&
          recoveries.some(
            (x) => x.kind === 'source' && x.markdown === 'note1',
          ) &&
          recoveries.some(
            (x) =>
              x.kind === 'source' &&
              x.markdown === 'different imported recovery',
          ),
        'collision retains both exact source alternatives',
      );
    } else if (scenario === 'field-merge-retry') {
      await capture(1);
      const epoch = await repo.getEpoch();
      const fail = () => {
        throw new Error('source transaction failure');
      };
      db.notes.hook('updating', fail);
      await rejects(() =>
        repo.saveItemSource(id(1), 'retry source', { key: id(1), revision: 1 }),
      );
      db.notes.hook('updating').unsubscribe(fail);
      await db.notes.update([epoch, id(1)], {
        color: 'blue',
        owner: 'provider',
        realmId: 'private',
      } as never);
      await repo.saveItemSource(id(1), 'retry source', {
        key: id(1),
        revision: 1,
      });
      const item = (await db.notes.get([epoch, id(1)])) as
        | { markdown: string; color: string; owner: string; realmId: string }
        | undefined;
      assert(
        item &&
          item.markdown === 'retry source' &&
          item.color === 'blue' &&
          item.owner === 'provider' &&
          item.realmId === 'private',
        'source retry updates only its own properties',
      );
    } else if (scenario === 'aggregate-capacity') {
      const epoch = await repo.getEpoch();
      const items = Array.from({ length: 20000 }, (_, n) => ({
        id: id(n + 1),
        epoch,
        kind: 'note' as const,
        markdown: '',
        done: false,
        color: null,
        createdAt: 0,
        updatedAt: 0,
        placement: {
          parentId: null,
          deletedAt: null,
          restoreParentId: null,
          restoreIndex: null,
        },
      }));
      await db.notes.bulkAdd(items);
      await repo.loadWorkspace();
      await rejects(() => capture(20001));
      assert(
        (await db.notes.where('epoch').equals(epoch).count()) === 20000,
        'item capacity transaction rollback',
      );
      const drafts = items.flatMap((x) => [
        { epoch, key: x.id, markdown: '', revision: 0, updatedAt: 0 },
        {
          epoch,
          key: `compose:${x.id}`,
          markdown: '',
          revision: 0,
          updatedAt: 0,
        },
      ]);
      drafts.push(
        { epoch, key: 'compose', markdown: '', revision: 0, updatedAt: 0 },
        {
          epoch,
          key: 'compose:trash',
          markdown: '',
          revision: 0,
          updatedAt: 0,
        },
      );
      await db.drafts.bulkPut(drafts);
      assert(
        (await repo.loadWorkspace()).drafts.length === 40002,
        'maximum scoped draft set',
      );
      await db.recovery.add({
        id: crypto.randomUUID(),
        kind: 'source',
        itemId: id(20001),
        markdown: 'x'.repeat(MAX_SOURCE),
        reason: 'unknown',
        originEpoch: epoch,
        recordedAt: 0,
      });
      await repo.loadWorkspace();
      await rejects(() =>
        repo.saveItemSource(id(1), 'x'.repeat(MAX_SOURCE), {
          key: id(1),
          revision: 0,
        }),
      );
      assert(
        (await db.notes.get([epoch, id(1)]))?.markdown === '' &&
          (await db.pending.count()) === 0,
        'complete envelope recovery capacity rollback',
      );
    } else if (scenario === 'capacity') {
      await capture(1, 'x'.repeat(MAX_SOURCE));
      const before = await repo.loadWorkspace();
      await rejects(() =>
        repo.saveItemSource(
          id(1),
          '雪'.repeat(Math.floor(MAX_SOURCE / 3) + 1),
          { key: id(1), revision: 0 },
        ),
      );
      assert(
        (await repo.loadWorkspace()).items[0].markdown ===
          before.items[0].markdown,
        'UTF8 rollback',
      );
      await rejects(() =>
        repo.checkpointDraft('compose', 'x'.repeat(MAX_SOURCE + 1), 1),
      );
    }
    return 'ok';
  } finally {
    repo.close();
    await db.delete();
  }
}
