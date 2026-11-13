import { expect, it } from 'vitest';
import { item } from '../fixtures/items';
import {
  SiblingDrag,
  siblingDragType,
} from '../../src/lib/workspace/sibling-drag';
import type { WorkspaceSnapshot } from '../../src/lib/domain/notes';
const home = { scope: 'live' as const, itemId: null };
const ids = Array.from(
  { length: 5 },
  (_, index) =>
    `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
);
const snapshot: WorkspaceSnapshot = {
  items: ids.map((id, position) => item({ id, position })),
  drafts: [],
  undoDeleteIds: [],
};

it('removes the whole noncontiguous selected group before computing the insertion gap', () => {
  const drag = new SiblingDrag();
  const token = drag.begin([ids[1], ids[3]], home);
  expect(
    drag.drop(snapshot, home, '', ids[4], 'after', [siblingDragType], token),
  ).toEqual({ ids: [ids[1], ids[3]], group: home, toIndex: 3 });
});
it('captures group membership independently of later selection mutation and rejects dropping on any member', () => {
  const drag = new SiblingDrag();
  const selected = [ids[1], ids[3]];
  const token = drag.begin(selected, home);
  selected.splice(0, 2, ids[0]);
  expect(
    drag.preview(snapshot, home, '', ids[1], 'before', [siblingDragType]),
  ).toBeNull();
  expect(
    drag.drop(snapshot, home, '', ids[0], 'before', [siblingDragType], token),
  ).toEqual({ ids: [ids[1], ids[3]], group: home, toIndex: 0 });
});
it('rejects stale, foreign-owner, duplicate, reordered-source, and invalidated group drags', () => {
  for (const selected of [
    [ids[1], ids[1]],
    [ids[3], ids[1]],
    [ids[1], 'missing'],
  ]) {
    const drag = new SiblingDrag();
    drag.begin(selected, home);
    expect(
      drag.preview(snapshot, home, '', ids[0], 'before', [siblingDragType]),
    ).toBeNull();
  }
  const drag = new SiblingDrag();
  drag.begin([ids[1], ids[3]], home);
  const changed = structuredClone(snapshot);
  changed.items[3].parentId = ids[1];
  expect(
    drag.preview(changed, home, '', ids[0], 'before', [siblingDragType]),
  ).toBeNull();
  drag.invalidate();
  expect(
    drag.preview(snapshot, home, '', ids[0], 'before', [siblingDragType]),
  ).toBeNull();
});
it('treats a selected block already at the requested gap as neutral', () => {
  const drag = new SiblingDrag();
  drag.begin([ids[1], ids[2]], home);
  expect(
    drag.preview(snapshot, home, '', ids[3], 'before', [siblingDragType]),
  ).toBeNull();
});
