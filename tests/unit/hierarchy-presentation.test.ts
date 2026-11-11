import { it, expect } from 'vitest';
import * as hierarchy from '../../src/lib/domain/hierarchy';
import {
  emptyWorkspace,
  type WorkspaceSnapshot,
} from '../../src/lib/domain/notes';
import { encodeBackup, validateBackup } from '../../src/lib/domain/backup';
function acceptedDeepWorkspace(): WorkspaceSnapshot {
  const s = emptyWorkspace();
  for (let i = 0; i < 5000; i++) {
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    s.stashes.push({
      id,
      name: 'x'.repeat(200),
      parentId: s.stashes.at(-1)?.id ?? null,
      createdAt: 0,
      updatedAt: 0,
    });
  }
  const owner = s.stashes.at(-1)!.id;
  for (let i = 0; i < 10000; i++)
    s.notes.push({
      id: `00000000-0000-4001-8000-${String(i).padStart(12, '0')}`,
      stashId: owner,
      markdown: 'match',
      createdAt: 0,
      updatedAt: 0,
      done: false,
      deletedAt: null,
    });
  return s;
}
it('bounds one deep displayed location instead of emitting its complete ancestry', () => {
  const s = acceptedDeepWorkspace();
  const text = encodeBackup(s);
  expect(new TextEncoder().encode(text).length).toBeLessThan(4 * 1024 * 1024);
  expect(validateBackup(text)).toHaveProperty('version', 3);
  expect(
    Array.from(hierarchy.locationLabel(s.stashes, s.notes[0].stashId)).length,
  ).toBeLessThanOrEqual(96);
});
it('reuses bounded owner resolution for 10000 matches without building full prefix labels', () => {
  const s = acceptedDeepWorkspace();
  expect(hierarchy).toHaveProperty('createHierarchyPresentation');
  const view = hierarchy.createHierarchyPresentation(s.stashes);
  let nameReads = 0;
  for (const stash of s.stashes) {
    const name = stash.name;
    Object.defineProperty(stash, 'name', {
      get() {
        nameReads++;
        return name;
      },
    });
  }
  const first = view.label(s.notes[0].stashId);
  let total = 0;
  for (const note of s.notes) {
    const label = view.label(note.stashId);
    expect(label).toBe(first);
    total += Array.from(label.text).length;
  }
  expect(first.abbreviated).toBe(true);
  expect(first.depth).toBe(5000);
  expect(first.text).toContain('…');
  expect(total).toBeLessThanOrEqual(960000);
  expect(nameReads).toBeLessThanOrEqual(2);
  const path = view.path(s.notes[0].stashId);
  expect(path).toHaveLength(5000);
  expect(path[0].id).toBe(s.stashes[0].id);
  expect(path.at(-1)?.id).toBe(s.notes[0].stashId);
  expect(view.label(null).text).toBe('Home');
});
it('keeps ordinary labels exact, handles Unicode boundaries, and rejects missing locations', () => {
  expect(hierarchy).toHaveProperty('createHierarchyPresentation');
  const s = emptyWorkspace();
  s.stashes.push({
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    name: 'Projects',
    parentId: null,
    createdAt: 0,
    updatedAt: 0,
  });
  s.stashes.push({
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    name: 'Ideas',
    parentId: s.stashes[0].id,
    createdAt: 1,
    updatedAt: 1,
  });
  let view = hierarchy.createHierarchyPresentation(s.stashes);
  expect(view.label(s.stashes[1].id)).toMatchObject({
    text: 'Home / Projects / Ideas',
    abbreviated: false,
    depth: 2,
  });
  s.stashes[1] = { ...s.stashes[1], name: '😀'.repeat(200) };
  view = hierarchy.createHierarchyPresentation(s.stashes);
  expect(
    Array.from(view.label(s.stashes[1].id).text).length,
  ).toBeLessThanOrEqual(96);
  expect(view.label(s.stashes[1].id).text).not.toContain('\uFFFD');
  expect(() => view.label('missing')).toThrow();
});
