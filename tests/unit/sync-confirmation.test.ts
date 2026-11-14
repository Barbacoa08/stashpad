import { describe, expect, it } from 'vitest';
import {
  classifyOutcome,
  readRemoteLibrary,
  readRemoteRow,
} from '../../src/lib/sync/confirmation';
import { digest, type PendingIntent } from '../../src/lib/sync/intents';
import type { Item } from '../../src/lib/domain/notes';
const id = '00000000-0000-4000-8000-000000000001';
const item: Item = {
  id,
  parentId: null,
  kind: 'note',
  markdown: 'new',
  done: false,
  color: null,
  position: 0,
  createdAt: 1,
  updatedAt: 2,
  deletedAt: null,
  restoreParentId: null,
  restoreIndex: null,
};
async function intent(): Promise<PendingIntent> {
  return {
    id: crypto.randomUUID(),
    epoch: 'epoch',
    fingerprint: 'fingerprint',
    digest: 'receipt',
    recordedAt: 2,
    localApplied: true,
    sequence: 1,
    command: {
      kind: 'saveItemSource',
      id,
      markdown: 'new',
      draft: { key: id, revision: 1 },
    },
    expected: {
      items: [
        {
          id,
          digest: 'audit',
          kind: 'update',
          structural: item,
          fields: { updatedAt: { before: 1, after: 2 } },
          source: {
            beforeDigest: await digest('old'),
            afterDigest: await digest('new'),
          },
        },
      ],
      purgedIds: [],
      orders: [],
    },
  };
}
const remote = (
  items: Item[],
): { epoch: string; items: Item[]; purgedIds: string[] } => ({
  epoch: 'epoch',
  items,
  purgedIds: [],
});
describe('operation-owned confirmation', () => {
  it('does not mistake admission or missing/no-op source for success', async () => {
    const p = await intent();
    expect(await classifyOutcome(p, null, remote([item]))).toBe('unknown');
    expect(
      await classifyOutcome(
        p,
        { id: p.id, epoch: p.epoch, digest: p.digest, recordedAt: 2 },
        remote([]),
      ),
    ).toBe('superseded');
  });
  it('ignores unrelated metadata while requiring exact source and receipt', async () => {
    const p = await intent(),
      witness = { id: p.id, epoch: p.epoch, digest: p.digest, recordedAt: 2 };
    expect(
      await classifyOutcome(
        p,
        witness,
        remote([{ ...item, done: true, updatedAt: 9 }]),
      ),
    ).toBe('matching');
    expect(
      await classifyOutcome(
        p,
        witness,
        remote([{ ...item, markdown: 'newer' }]),
      ),
    ).toBe('superseded');
    expect(
      await classifyOutcome(p, { ...witness, digest: 'wrong' }, remote([item])),
    ).toBe('unknown');
  });
  it('checks desired field and projected kind rather than whole item audit digest', async () => {
    const p = await intent();
    p.command = { kind: 'setItemDone', id, done: true };
    p.expected.items = [
      {
        id,
        digest: 'audit',
        kind: 'update',
        structural: item,
        fields: { done: { before: false, after: true } },
      },
    ];
    const w = { id: p.id, epoch: p.epoch, digest: p.digest, recordedAt: 2 };
    expect(
      await classifyOutcome(
        p,
        w,
        remote([{ ...item, done: true, markdown: 'concurrent' }]),
      ),
    ).toBe('matching');
    expect(await classifyOutcome(p, w, remote([item]))).toBe('superseded');
  });
  it('requires exact captured tombstones and ignores concurrent unknown siblings in relative ordering', async () => {
    const p = await intent();
    p.command = {
      kind: 'purgeItem',
      request: {
        id,
        location: { scope: 'trash', itemId: null },
        expectedSubtreeIds: [id],
      },
    };
    p.expected = { items: [], purgedIds: [id], orders: [] };
    const w = { id: p.id, epoch: p.epoch, digest: p.digest, recordedAt: 2 };
    expect(await classifyOutcome(p, w, remote([]))).toBe('superseded');
    expect(
      await classifyOutcome(p, w, { ...remote([]), purgedIds: [id] }),
    ).toBe('matching');
  });
  it('fails closed on malformed server rows or lost replies', async () => {
    const p = await intent();
    const fetcher = async () => new Response(JSON.stringify({ id: 'bad' }));
    await expect(
      readRemoteLibrary({
        databaseUrl: 'https://example.invalid',
        token: 'private',
        libraryId: 'test',
        epoch: p.epoch,
        fetch: fetcher,
      }),
    ).rejects.toThrow();
  });
});

it('a documented filtered fallback accepts only the exact simple or compound row after 422', async () => {
  for (const key of ['library', ['epoch', id]] as (
    string | [string, string]
  )[]) {
    const row =
      typeof key === 'string'
        ? { id: key, epoch: 'epoch' }
        : { id: key[1], epoch: key[0] };
    let calls = 0;
    const fetcher = async () =>
      ++calls === 1
        ? new Response('unregistered', { status: 422 })
        : new Response(JSON.stringify([row]));
    expect(
      await readRemoteRow(
        {
          databaseUrl: 'https://example.invalid',
          token: 'private',
          fetch: fetcher,
        },
        'notes',
        key,
      ),
    ).toEqual(row);
  }
});
it('filtered fallback rejects ambiguous and wrong-epoch results and never masks auth rejection', async () => {
  for (const values of [
    [{ id, epoch: 'other' }],
    [
      { id, epoch: 'epoch' },
      { id, epoch: 'epoch' },
    ],
  ]) {
    let calls = 0;
    const fetcher = async () =>
      ++calls === 1
        ? new Response('', { status: 422 })
        : new Response(JSON.stringify(values));
    await expect(
      readRemoteRow(
        {
          databaseUrl: 'https://example.invalid',
          token: 'private',
          fetch: fetcher,
        },
        'notes',
        ['epoch', id],
      ),
    ).rejects.toThrow();
  }
  let calls = 0;
  await expect(
    readRemoteRow(
      {
        databaseUrl: 'https://example.invalid',
        token: 'private',
        fetch: async () => {
          calls++;
          return new Response('', { status: 401 });
        },
      },
      'notes',
      ['epoch', id],
    ),
  ).rejects.toThrow();
  expect(calls).toBe(1);
});
it('streams oversized raw Unicode recovery as exact bounded chunks distinct from normal backup', async () => {
  const { recoveryChunks } = await import('../../src/lib/sync/recovery');
  const raw = {
    format: 'scratchtree-raw-recovery' as const,
    version: 1 as const,
    exportedAt: new Date(0).toISOString(),
    libraryId: 'test',
    epoch: 'epoch',
    notes: Array.from({ length: 12 }, () => ({
      markdown: '雪😀'.repeat(160000),
    })),
    orders: [],
    purges: [],
    drafts: [],
    pending: [],
    recovery: [],
    buffers: [],
    journal: { sequence: 0, sources: [] },
  };
  const chunks: string[] = [];
  for await (const chunk of recoveryChunks(raw)) {
    expect(new TextEncoder().encode(chunk).length).toBeLessThanOrEqual(
      1024 * 1024,
    );
    expect(/[\uD800-\uDBFF]$/.test(chunk)).toBe(false);
    expect(/^[\uDC00-\uDFFF]/.test(chunk)).toBe(false);
    chunks.push(chunk);
  }
  const text = chunks.join('');
  expect(new TextEncoder().encode(text).length).toBeGreaterThan(
    10 * 1024 * 1024,
  );
  expect(JSON.parse(text)).toEqual(raw);
});
it('an admitted creation requires exact identity/source while unrelated later completion/color may change', async () => {
  const p = await intent();
  p.command = {
    kind: 'captureItem',
    request: {
      id,
      location: { scope: 'live', itemId: null },
      markdown: 'new',
      draft: { key: 'compose', revision: 0 },
    },
  };
  p.expected = {
    items: [{ id, digest: 'audit', kind: 'create', structural: item, item }],
    orders: [],
    purgedIds: [],
  };
  const witness = {
    id: p.id,
    epoch: p.epoch,
    digest: p.digest,
    recordedAt: p.recordedAt,
  };
  expect(
    await classifyOutcome(
      p,
      witness,
      remote([{ ...item, done: true, color: 'blue', updatedAt: 90 }]),
    ),
  ).toBe('matching');
  expect(
    await classifyOutcome(
      p,
      witness,
      remote([{ ...item, markdown: 'superseded' }]),
    ),
  ).toBe('superseded');
});
it('relative sibling order ignores new unknown siblings and rejects reversed known siblings', async () => {
  const p = await intent(),
    second = '00000000-0000-4000-8000-000000000002',
    third = '00000000-0000-4000-8000-000000000003';
  p.command = {
    kind: 'reorderItem',
    request: { id, group: { scope: 'live', itemId: null }, toIndex: 1 },
  };
  p.expected = {
    items: [],
    purgedIds: [],
    orders: [{ group: { scope: 'live', itemId: null }, ids: [second, id] }],
  };
  const witness = {
    id: p.id,
    epoch: p.epoch,
    digest: p.digest,
    recordedAt: p.recordedAt,
  };
  expect(
    await classifyOutcome(
      p,
      witness,
      remote([
        { ...item, id: second, position: 0 },
        { ...item, id: third, position: 1 },
        { ...item, position: 2 },
      ]),
    ),
  ).toBe('matching');
  expect(
    await classifyOutcome(
      p,
      witness,
      remote([
        { ...item, position: 0 },
        { ...item, id: second, position: 1 },
      ]),
    ),
  ).toBe('superseded');
});
it('neutral commands still require their captured canonical target/source/property', async () => {
  const commands: PendingIntent['command'][] = [
    {
      kind: 'captureItem',
      request: {
        id,
        location: { scope: 'live', itemId: null },
        markdown: 'new',
        draft: { key: 'compose', revision: 1 },
      },
    },
    {
      kind: 'createChildTree',
      request: { id, parent: { scope: 'live', itemId: null } },
    },
    { kind: 'setItemDone', id, done: true },
    { kind: 'setItemColor', id, color: 'red' },
    { kind: 'promoteItem', id },
    {
      kind: 'transitionLocation',
      request: {
        from: { scope: 'live', itemId: null },
        to: { scope: 'live', itemId: id },
        promoteDestination: true,
      },
    },
  ];
  for (const command of commands) {
    const p = await intent();
    p.command = command;
    p.expected = { items: [], orders: [], purgedIds: [] };
    const witness = {
      id: p.id,
      epoch: p.epoch,
      digest: p.digest,
      recordedAt: p.recordedAt,
    };
    expect(await classifyOutcome(p, witness, remote([])), command.kind).toBe(
      'superseded',
    );
    expect(
      await classifyOutcome(p, witness, { ...remote([]), purgedIds: [id] }),
      command.kind,
    ).toBe('superseded');
    const matching = {
      ...item,
      markdown: command.kind === 'createChildTree' ? 'Untitled' : 'new',
      done: true,
      color: 'red' as const,
      kind: 'tree' as const,
    };
    expect(
      await classifyOutcome(p, witness, remote([matching])),
      command.kind,
    ).toBe('matching');
    const wrong =
      command.kind === 'setItemDone'
        ? { ...matching, done: false }
        : command.kind === 'setItemColor'
          ? { ...matching, color: null }
          : command.kind === 'promoteItem' ||
              command.kind === 'transitionLocation'
            ? { ...matching, kind: 'note' as const }
            : { ...matching, markdown: 'different' };
    expect(
      await classifyOutcome(p, witness, remote([wrong])),
      command.kind,
    ).toBe('superseded');
  }
});
it('neutral structural commands require their captured postconditions rather than an admitted empty delta', async () => {
  const root = { scope: 'live', itemId: null } as const,
    trash = { scope: 'trash', itemId: null } as const,
    deleted = { ...item, deletedAt: 5, restoreIndex: 0 };
  const cases: {
    command: PendingIntent['command'];
    wrong: ReturnType<typeof remote>;
    right: ReturnType<typeof remote>;
  }[] = [
    {
      command: { kind: 'deleteItem', id },
      wrong: remote([item]),
      right: remote([deleted]),
    },
    {
      command: { kind: 'restoreItem', id },
      wrong: remote([deleted]),
      right: remote([item]),
    },
    {
      command: {
        kind: 'purgeItem',
        request: { id, location: trash, expectedSubtreeIds: [id] },
      },
      wrong: remote([]),
      right: { ...remote([]), purgedIds: [id] },
    },
    {
      command: { kind: 'correctivePurge', epoch: 'epoch', ids: [id] },
      wrong: remote([]),
      right: { ...remote([]), purgedIds: [id] },
    },
    {
      command: {
        kind: 'undoDelete',
        request: { ids: [id], proof: { before: [deleted], after: [item] } },
      },
      wrong: remote([deleted]),
      right: remote([item]),
    },
    {
      command: {
        kind: 'reorderItem',
        request: { id, group: root, toIndex: 0 },
      },
      wrong: remote([
        { ...item, position: 1 },
        { ...item, id: '00000000-0000-4000-8000-000000000002', position: 0 },
      ]),
      right: remote([item]),
    },
    {
      command: {
        kind: 'moveItems',
        request: {
          ids: [id],
          from: root,
          to: trash,
          beforeFrom: [id],
          beforeTo: [],
          afterFrom: [],
          afterTo: [id],
        },
      },
      wrong: remote([item]),
      right: remote([deleted]),
    },
  ];
  for (const entry of cases) {
    const p = await intent();
    p.command = entry.command;
    p.expected = { items: [], orders: [], purgedIds: [] };
    const witness = {
      id: p.id,
      epoch: p.epoch,
      digest: p.digest,
      recordedAt: p.recordedAt,
    };
    expect(await classifyOutcome(p, witness, entry.wrong), p.command.kind).toBe(
      'superseded',
    );
    expect(await classifyOutcome(p, witness, entry.right), p.command.kind).toBe(
      'matching',
    );
  }
});
