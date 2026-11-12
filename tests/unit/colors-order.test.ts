import { expect, it } from 'vitest';
import { MemoryRepository } from '../fixtures/memory';
import { WorkspaceController } from '../../src/lib/workspace/controller';
import { directEntries } from '../../src/lib/domain/hierarchy';
const a = '00000000-0000-4000-8000-000000000001',
  b = '00000000-0000-4000-8000-000000000002',
  d = '00000000-0000-4000-8000-000000000003';
const home = { scope: 'live' as const, itemId: null };
async function setup() {
  const r = new MemoryRepository();
  for (const id of [a, b])
    await r.captureItem({
      id,
      location: home,
      markdown: id === a ? 'first' : 'second',
      draft: { key: 'compose', revision: 0 },
    });
  await r.createChildStash({ id: d, parent: { scope: 'live', itemId: a } });
  const c = new WorkspaceController(r);
  await c.start();
  return { r, c };
}
for (const op of ['color', 'reorder'] as const)
  it(`${op} flush failure retries captured exact intent and never captures the composer`, async () => {
    const { r, c } = await setup();
    await c.selectNote(a);
    c.editSource('latest\r\n**source**');
    r.fail = 'save';
    const request = { id: a, group: { ...home }, toIndex: 1 };
    expect(
      await (op === 'color'
        ? c.setItemColor(a, 'purple')
        : c.reorderItem(request)),
    ).toBe(false);
    request.id = b;
    request.group.scope = 'trash' as 'live';
    request.toIndex = 0;
    expect(c.state.mutationRetry).toBe(true);
    c.setQuery('newer query');
    r.fail = null;
    expect(await c.retryMutation()).toBe(true);
    expect(r.snapshot.items).toHaveLength(3);
    expect(r.snapshot.items.find((x) => x.id === a)).toMatchObject({
      markdown: 'latest\r\n**source**',
      color: op === 'color' ? 'purple' : null,
      parentId: null,
    });
    expect(r.snapshot.items.find((x) => x.id === d)?.parentId).toBe(a);
    expect(directEntries(r.snapshot, home).map((x) => x.id)).toEqual(
      op === 'reorder' ? [b, a] : [a, b],
    );
    expect(c.state.query).toBe('newer query');
    c.dispose();
  });
it('same color and same index preserve all timestamps and strict foreign-group rejection preserves the envelope', async () => {
  const { r, c } = await setup();
  await c.setItemColor(a, 'blue');
  const before = structuredClone(r.snapshot);
  await c.setItemColor(a, 'blue');
  await c.reorderItem({ id: a, group: home, toIndex: 0 });
  expect(r.snapshot).toEqual(before);
  expect(
    await c.reorderItem({
      id: a,
      group: { scope: 'live', itemId: a },
      toIndex: 0,
    }),
  ).toBe(false);
  expect(r.snapshot).toEqual(before);
  c.dispose();
});
it('color and order retain drafts, descendants, completion, and metadata through promotion, Trash, restore, and backup replacement', async () => {
  const { r, c } = await setup();
  c.editSource('pending capture');
  await c.flush();
  await c.setNoteDone(b, true);
  await c.setItemColor(b, 'pink');
  await c.enterItem(b);
  await c.openStash(null);
  await c.reorderItem({ id: b, group: home, toIndex: 0 });
  await c.remove(b);
  await c.setItemColor(b, 'teal');
  await c.restoreItem(b);
  const before = structuredClone(r.snapshot);
  await c.export();
  r.restoreText = r.exported;
  await c.previewRestore();
  expect(await c.restore()).toBe(true);
  expect(r.snapshot).toEqual(before);
  expect(r.snapshot.items.find((x) => x.id === b)).toMatchObject({
    color: 'teal',
    done: true,
    kind: 'stash',
    position: 0,
  });
  expect(r.snapshot.drafts.some((x) => x.markdown === 'pending capture')).toBe(
    true,
  );
  c.dispose();
});

import {
  SiblingDrag,
  siblingDragType,
} from '../../src/lib/workspace/sibling-drag';
import { item } from '../fixtures/items';
const e = '00000000-0000-4000-8000-000000000004';
const dragSnapshot = {
  items: [
    item({ id: a, kind: 'stash' }),
    item({ id: b, position: 1 }),
    item({ id: d, position: 2 }),
    item({ id: e, parentId: a }),
  ],
  drafts: [],
  undoDeleteId: null,
};
for (const [source, target, edge, want] of [
  [a, d, 'after', 2],
  [d, a, 'before', 0],
  [a, d, 'before', 1],
  [d, a, 'after', 1],
  [a, b, 'before', null],
  [b, a, 'after', null],
] as const)
  it(`owned drag ${source.slice(-1)} ${edge} ${target.slice(-1)} maps to final index ${want}`, () => {
    const drag = new SiblingDrag();
    const token = drag.begin(source, home);
    const r = drag.drop(
      dragSnapshot,
      home,
      '',
      target,
      edge,
      [siblingDragType],
      token,
    );
    expect(r).toEqual(
      want === null ? null : { id: source, group: home, toIndex: want },
    );
    expect(
      drag.preview(dragSnapshot, home, '', target, edge, [siblingDragType]),
    ).toBeNull();
  });
it('rejects foreign tokens, files/URLs, cross-parent targets, changed scopes, search, cancellation, and unowned payloads', () => {
  const drag = new SiblingDrag();
  expect(
    drag.drop(dragSnapshot, home, '', d, 'after', [siblingDragType], 'foreign'),
  ).toBeNull();
  const token = drag.begin(a, home);
  for (const types of [
    [],
    ['text/uri-list'],
    [siblingDragType, 'Files'],
    [siblingDragType, 'text/plain'],
  ])
    expect(drag.preview(dragSnapshot, home, '', d, 'after', types)).toBeNull();
  expect(
    drag.preview(dragSnapshot, home, 'query', d, 'after', [siblingDragType]),
  ).toBeNull();
  expect(
    drag.preview(
      dragSnapshot,
      { scope: 'trash', itemId: null },
      '',
      d,
      'after',
      [siblingDragType],
    ),
  ).toBeNull();
  expect(
    drag.preview(dragSnapshot, home, '', e, 'after', [siblingDragType]),
  ).toBeNull();
  expect(
    drag.drop(
      dragSnapshot,
      home,
      '',
      d,
      'after',
      [siblingDragType],
      token + 'foreign',
    ),
  ).toBeNull();
  drag.begin(a, home);
  drag.clear();
  expect(
    drag.preview(dragSnapshot, home, '', d, 'after', [siblingDragType]),
  ).toBeNull();
});
it('rechecks the source actual location instead of trusting its captured drag group', () => {
  const drag = new SiblingDrag();
  drag.begin(b, home);
  const changed = structuredClone(dragSnapshot);
  changed.items.find((x) => x.id === b)!.parentId = a;
  expect(
    drag.preview(changed, home, '', d, 'after', [siblingDragType]),
  ).toBeNull();
});

for (const operation of ['color', 'reorder'] as const)
  it(`repository ${operation} failure retries only the intended metadata`, async () => {
    const { r, c } = await setup();
    c.editSource('capture survives');
    await c.flush();
    r.fail = operation;
    expect(
      await (operation === 'color'
        ? c.setItemColor(b, 'gray')
        : c.reorderItem({ id: b, group: home, toIndex: 0 })),
    ).toBe(false);
    expect(r.snapshot.items.find((x) => x.id === b)?.color).toBeNull();
    r.fail = null;
    expect(await c.retryMutation()).toBe(true);
    expect(r.snapshot.items).toHaveLength(3);
    expect(c.state.source).toBe('capture survives');
    expect(r.snapshot.items.find((x) => x.id === b)).toMatchObject(
      operation === 'color' ? { color: 'gray' } : { position: 0 },
    );
    c.dispose();
  });

it('opaque retry ownership changes for a replacement failure and clears after success', async () => {
  const { r, c } = await setup();
  expect(c.mutationRetryIdentity).toBeNull();
  r.fail = 'color';
  expect(await c.setItemColor(a, 'red')).toBe(false);
  const colorRetry = c.mutationRetryIdentity;
  expect(colorRetry).not.toBeNull();
  c.setQuery('newer view');
  expect(c.mutationRetryIdentity).toBe(colorRetry);
  expect(await c.retryMutation()).toBe(false);
  expect(c.mutationRetryIdentity).not.toBe(colorRetry);
  const repeatedColor = c.mutationRetryIdentity;
  r.fail = 'reorder';
  expect(await c.reorderItem({ id: b, group: home, toIndex: 0 })).toBe(false);
  expect(c.mutationRetryIdentity).not.toBe(repeatedColor);
  r.fail = null;
  expect(await c.retryMutation()).toBe(true);
  expect(c.mutationRetryIdentity).toBeNull();
  expect(r.snapshot.items.find((x) => x.id === a)?.color).toBeNull();
  c.dispose();
});
