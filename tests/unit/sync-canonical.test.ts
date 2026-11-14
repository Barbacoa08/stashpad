import { describe, expect, it } from 'vitest';
import { encodeBackup, validateBackup } from '../../src/lib/domain/backup';
import { MAX_SOURCE } from '../../src/lib/domain/notes';
import { projectLibrary } from '../../src/lib/sync/canonical';
import type { SharedItem, OrderRow, PurgeRow } from '../../src/lib/sync/types';

const epoch = 'current';
const id = (n: number) =>
  `00000000-0000-0000-0000-${n.toString(16).padStart(12, '0')}`;
const row = (n: number, changes: Partial<SharedItem> = {}): SharedItem => ({
  id: id(n),
  epoch,
  kind: 'note',
  markdown: `note ${n}`,
  done: false,
  color: null,
  createdAt: 1,
  updatedAt: 2,
  placement: {
    parentId: null,
    deletedAt: null,
    restoreParentId: null,
    restoreIndex: null,
  },
  ...changes,
});
const placed = (
  n: number,
  parent: number | null,
  deletedAt: number | null = null,
) =>
  row(n, {
    placement: {
      parentId: parent === null ? null : id(parent),
      deletedAt,
      restoreParentId: null,
      restoreIndex: null,
    },
  });
const order = (
  ids: number[],
  parent: number | null = null,
  scope: 'live' | 'trash' = 'live',
): OrderRow => ({
  id: `${scope}:${parent ?? 'root'}`,
  epoch,
  parentId: parent === null ? null : id(parent),
  scope,
  ids: ids.map(id),
});
const checked = (
  rows: SharedItem[],
  orders: OrderRow[] = [],
  purges: PurgeRow[] = [],
) => {
  const result = projectLibrary(rows, orders, purges, epoch);
  expect(
    validateBackup(
      encodeBackup({ items: result.items, drafts: [], undoDeleteIds: [] }),
    ),
  ).not.toHaveProperty('code');
  return result;
};

describe('shared projection', () => {
  it('rejects sparse order references instead of silently treating missing values as stale IDs', () => {
    const ids = [id(1), , id(2)] as string[];
    expect(() =>
      projectLibrary([row(1), row(2)], [{ ...order([]), ids }], [], epoch),
    ).toThrow();
  });

  it('uses exact reference spellings and deterministic created-time fallback', () => {
    const upper = 'ABCDEFAB-CDEF-ABCD-EFAB-CDEFABCDEFAB';
    const result = checked(
      [
        row(1, { id: upper }),
        row(2, {
          placement: {
            parentId: upper.toLowerCase(),
            deletedAt: null,
            restoreParentId: null,
            restoreIndex: null,
          },
        }),
        row(3, { createdAt: 0 }),
        row(4),
      ],
      [order([99])],
    );
    expect(result.items.find((x) => x.id === id(2))).toMatchObject({
      parentId: null,
      deletedAt: 2,
    });
    expect(result.items.find((x) => x.id === id(3))?.position).toBe(0);
    expect(result.items.find((x) => x.id === id(4))?.position).toBe(1);
    expect(result.items.find((x) => x.id === upper)?.position).toBe(2);
  });

  it('converges with tombstones and repairs a cycle independently from its incoming tail', () => {
    const rows = [
      placed(1, 2),
      placed(2, 1),
      placed(9, 1),
      placed(3, 4),
      row(4),
      row(5),
    ];
    const purges = [
      { id: id(4), epoch, purgedAt: 40 },
      { id: id(5), epoch, purgedAt: 50 },
    ];
    const before = structuredClone({ rows, purges });
    const first = checked(rows, [], purges);
    expect(first.purgedIds).toEqual([id(4), id(5)]);
    expect(first.items.find((x) => x.id === id(2))?.parentId).toBeNull();
    expect(first.items.find((x) => x.id === id(9))?.parentId).toBe(id(1));
    expect(checked(rows.toReversed(), [], purges.toReversed())).toEqual(first);
    expect({ rows, purges }).toEqual(before);
  });

  it('bounds epoch and order identifiers in UTF-8 without constraining their wire format', () => {
    expect(projectLibrary([], [], [], 'é'.repeat(64)).items).toEqual([]);
    expect(() => projectLibrary([], [], [], 'é'.repeat(65))).toThrow();
    expect(() =>
      projectLibrary([], [{ ...order([]), id: 'x'.repeat(129) }], [], epoch),
    ).toThrow();
    expect(() =>
      projectLibrary([row(1, { epoch: 'x'.repeat(129) })], [], [], epoch),
    ).toThrow();
  });

  it('converges across input permutations and appends concurrent children deterministically', () => {
    const rows = [
      row(1),
      placed(2, 1),
      placed(3, 1),
      row(4, { createdAt: 0 }),
      placed(5, 1),
    ];
    const orders = [order([3, 99, 3, 2], 1), order([1])];
    const expected = checked(rows, orders);
    expect(
      expected.items
        .filter((x) => x.parentId === id(1))
        .map((x) => [x.id, x.position]),
    ).toEqual([
      [id(2), 1],
      [id(3), 0],
      [id(5), 2],
    ]);
    expect(expected.items.find((x) => x.id === id(1))?.kind).toBe('tree');
    for (const variation of [
      rows.toReversed(),
      [rows[2], rows[0], rows[4], rows[1], rows[3]],
    ])
      expect(checked(variation, orders.toReversed())).toEqual(expected);
  });

  it('breaks each cycle at its greatest exact ID without dropping source', () => {
    const result = checked([
      placed(1, 2),
      placed(2, 3),
      placed(3, 1),
      placed(4, 4),
    ]);
    expect(result.items.map((x) => [x.id, x.parentId])).toEqual([
      [id(1), id(2)],
      [id(2), id(3)],
      [id(3), null],
      [id(4), null],
    ]);
    expect(result.notices).toEqual([
      { kind: 'cycle', itemId: id(3) },
      { kind: 'cycle', itemId: id(4) },
    ]);
    expect(
      checked([placed(4, 4), placed(3, 1), placed(2, 3), placed(1, 2)]),
    ).toEqual(result);
  });

  it('projects a 20,000-deep chain iteratively and promotes every owner', () => {
    const rows = Array.from({ length: 20000 }, (_, i) =>
      placed(i + 1, i === 19999 ? null : i + 2),
    );
    const result = checked(rows);
    expect(result.items).toHaveLength(20000);
    expect(result.items[0].kind).toBe('note');
    expect(result.items.slice(1).every((x) => x.kind === 'tree')).toBe(true);
    expect(result.notices).toEqual([]);
  });

  it('keeps independently deleted children in Trash after an ancestor restores', () => {
    const result = checked([
      placed(1, null),
      placed(2, 1, 9),
      placed(3, 2),
      placed(4, 2, 10),
    ]);
    expect(result.items.map((x) => [x.id, x.parentId, x.deletedAt])).toEqual([
      [id(1), null, null],
      [id(2), null, 9],
      [id(3), id(2), null],
      [id(4), id(2), 10],
    ]);
    expect(result.notices).toEqual([{ kind: 'trash-root', itemId: id(2) }]);
  });

  it('retains missing-parent and purged-parent children in Trash with valid restore ordinals', () => {
    const rows = [
      row(1),
      row(2, {
        placement: {
          parentId: id(1),
          deletedAt: 8,
          restoreParentId: id(1),
          restoreIndex: 7,
        },
      }),
      placed(3, 99),
      row(4, {
        placement: {
          parentId: null,
          deletedAt: 8,
          restoreParentId: id(99),
          restoreIndex: 5,
        },
      }),
    ];
    const result = checked(rows, [], [{ id: id(1), epoch, purgedAt: 15 }]);
    expect(result.purgedIds).toEqual([id(1)]);
    expect(
      result.items.map((x) => [
        x.id,
        x.parentId,
        x.deletedAt,
        x.restoreParentId,
        x.restoreIndex,
      ]),
    ).toEqual([
      [id(2), null, 15, null, 7],
      [id(3), null, 2, null, null],
      [id(4), null, 8, null, 5],
    ]);
    expect(result.notices).toEqual([
      { kind: 'orphan', itemId: id(2) },
      { kind: 'restore-parent', itemId: id(2) },
      { kind: 'orphan', itemId: id(3) },
      { kind: 'restore-parent', itemId: id(4) },
    ]);
  });

  it('separates live and Trash root order while retaining nested explicit deletion', () => {
    const result = checked(
      [
        placed(1, null),
        placed(2, null, 4),
        placed(3, null),
        placed(4, null, 5),
        placed(5, 2, 6),
      ],
      [order([3, 2, 1]), order([4, 2], null, 'trash'), order([5], 2, 'trash')],
    );
    expect(result.items.map((x) => x.position)).toEqual([1, 1, 0, 0, 0]);
    expect(result.items[4].parentId).toBe(id(2));
  });

  it('preserves uppercase UUID spelling, Unicode, code, CRLF, metadata, and every input', () => {
    const upper = 'ABCDEFAB-CDEF-ABCD-EFAB-CDEFABCDEFAB';
    const rows = [
      row(1, {
        id: upper,
        markdown: '# café 🐈\r\n```ts\r\nconst x = "λ";\r\n```',
        color: 'teal',
        done: true,
        createdAt: 0,
        updatedAt: 100,
      }),
      row(2, {
        placement: {
          parentId: upper,
          deletedAt: null,
          restoreParentId: null,
          restoreIndex: null,
        },
      }),
    ];
    const orders = [order([2, 2, 99])];
    const before = structuredClone({ rows, orders });
    const result = checked(rows, orders);
    expect(result.items.find((x) => x.id === upper)).toMatchObject({
      id: upper,
      markdown: rows[0].markdown,
      color: 'teal',
      done: true,
      createdAt: 0,
      updatedAt: 100,
      kind: 'tree',
    });
    expect(result.items.find((x) => x.id === id(2))?.updatedAt).toBe(2);
    expect({ rows, orders }).toEqual(before);
    result.items[0].markdown = 'changed output';
    expect({ rows, orders }).toEqual(before);
  });

  it('ignores valid retired epochs, including their tombstones and identical IDs', () => {
    const result = checked(
      [row(1), row(1, { epoch: 'retired', markdown: 'old' })],
      [{ ...order([1]), epoch: 'retired' }],
      [{ id: id(1), epoch: 'retired', purgedAt: 7 }],
    );
    expect(result.items.map((x) => x.markdown)).toEqual(['note 1']);
    expect(result.purgedIds).toEqual([]);
  });

  it.each([
    { id: 'invalid' },
    { epoch: '' },
    { kind: 'folder' },
    { markdown: 4 },
    { markdown: 'é'.repeat(MAX_SOURCE / 2 + 1) },
    { done: 1 },
    { color: 'cyan' },
    { createdAt: -1 },
    { updatedAt: 0 },
    { updatedAt: NaN },
    { extra: true },
    {
      placement: {
        parentId: 2,
        deletedAt: null,
        restoreParentId: null,
        restoreIndex: null,
      },
    },
    {
      placement: {
        parentId: null,
        deletedAt: -1,
        restoreParentId: null,
        restoreIndex: null,
      },
    },
    {
      placement: {
        parentId: null,
        deletedAt: null,
        restoreParentId: 'no',
        restoreIndex: null,
      },
    },
    {
      placement: {
        parentId: null,
        deletedAt: 2,
        restoreParentId: id(2),
        restoreIndex: null,
      },
    },
    {
      placement: {
        parentId: null,
        deletedAt: null,
        restoreParentId: null,
        restoreIndex: 2,
      },
    },
    {
      placement: {
        parentId: null,
        deletedAt: 2,
        restoreParentId: null,
        restoreIndex: 0.5,
      },
    },
  ])('rejects malformed item fields %#', (changes) => {
    expect(() =>
      projectLibrary([row(1, changes as Partial<SharedItem>)], [], [], epoch),
    ).toThrow();
  });

  it('rejects duplicate identities, including case aliases and filtered purged items', () => {
    const upper = 'ABCDEFAB-CDEF-ABCD-EFAB-CDEFABCDEFAB';
    for (const rows of [
      [row(1), row(1)],
      [row(1, { id: upper }), row(2, { id: upper.toLowerCase() })],
    ])
      expect(() => projectLibrary(rows, [], [], epoch)).toThrow();
    expect(() =>
      projectLibrary(
        [row(1), row(1)],
        [],
        [{ id: id(1), epoch, purgedAt: 2 }],
        epoch,
      ),
    ).toThrow();
    expect(() =>
      projectLibrary(
        [],
        [],
        [
          { id: id(1), epoch, purgedAt: 2 },
          { id: id(1), epoch, purgedAt: 3 },
        ],
        epoch,
      ),
    ).toThrow();
  });

  it('rejects conflicting order groups, duplicate order records, and malformed rows', () => {
    for (const orders of [
      [order([1]), order([2])],
      [order([1]), { ...order([2]), id: 'other' }],
      [order([1], 3), order([2], 3, 'trash')],
      [{ ...order([1]), ids: ['bad'] }],
      [{ ...order([1]), scope: 'other' }],
      [{ ...order([1]), parentId: 'bad' }],
      [{ ...order([1]), id: '' }],
    ])
      expect(() =>
        projectLibrary([], orders as OrderRow[], [], epoch),
      ).toThrow();
    for (const purges of [
      [{ id: 'bad', epoch, purgedAt: 3 }],
      [{ id: id(1), epoch, purgedAt: -1 }],
    ])
      expect(() => projectLibrary([], [], purges, epoch)).toThrow();
    expect(() => projectLibrary([], [], [], '')).toThrow();
    expect(() =>
      projectLibrary(
        [row(1, { epoch: 'old', done: 3 as unknown as boolean })],
        [],
        [],
        epoch,
      ),
    ).toThrow();
  });

  it('allows the exact source boundary but refuses more than 20,000 current items', () => {
    expect(
      checked([row(1, { markdown: 'x'.repeat(MAX_SOURCE) })]).items[0].markdown
        .length,
    ).toBe(MAX_SOURCE);
    expect(() =>
      projectLibrary(
        Array.from({ length: 20001 }, (_, i) => row(i + 1)),
        [],
        [],
        epoch,
      ),
    ).toThrow();
  });
});
