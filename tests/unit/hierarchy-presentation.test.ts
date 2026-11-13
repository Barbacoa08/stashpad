import { it, expect } from 'vitest';
import * as hierarchy from '../../src/lib/domain/hierarchy';
import {
  emptyWorkspace,
  type WorkspaceSnapshot,
} from '../../src/lib/domain/notes';
import { encodeBackup, validateBackup } from '../../src/lib/domain/backup';
import { item } from '../fixtures/items';
function acceptedDeepWorkspace(): WorkspaceSnapshot {
  const s = emptyWorkspace();
  for (let i = 0; i < 5000; i++) {
    s.items.push(
      item({
        id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        kind: 'stash',
        markdown: 'x'.repeat(200),
        parentId: s.items.at(-1)?.id ?? null,
      }),
    );
  }
  const owner = s.items.at(-1)!.id;
  for (let i = 0; i < 10000; i++)
    s.items.push(
      item({
        id: `00000000-0000-4001-8000-${String(i).padStart(12, '0')}`,
        parentId: owner,
        markdown: 'match',
        position: i,
      }),
    );
  return s;
}
it('bounds one deep displayed source location instead of emitting its complete ancestry', () => {
  const s = acceptedDeepWorkspace();
  const text = encodeBackup(s);
  expect(new TextEncoder().encode(text).length).toBeLessThan(6 * 1024 * 1024);
  expect(validateBackup(text)).toHaveProperty('version', 5);
  expect(
    Array.from(
      hierarchy.locationLabel(
        s.items.filter((x) => x.kind === 'stash'),
        s.items.at(-1)!.parentId,
      ),
    ).length,
  ).toBeLessThanOrEqual(96);
});
it('reuses bounded owner resolution for 10000 matches without building full prefix labels', () => {
  const s = acceptedDeepWorkspace(),
    stashes = s.items.filter((x) => x.kind === 'stash'),
    notes = s.items.filter((x) => x.kind === 'note'),
    view = hierarchy.createHierarchyPresentation(stashes);
  let sourceReads = 0;
  for (const stash of stashes) {
    const markdown = stash.markdown;
    Object.defineProperty(stash, 'markdown', {
      get() {
        sourceReads++;
        return markdown;
      },
    });
  }
  const first = view.label(notes[0].parentId);
  let total = 0;
  for (const note of notes) {
    const label = view.label(note.parentId);
    expect(label).toBe(first);
    total += Array.from(label.text).length;
  }
  expect(first.abbreviated).toBe(true);
  expect(first.depth).toBe(5000);
  expect(first.text).toContain('…');
  expect(total).toBeLessThanOrEqual(960000);
  expect(sourceReads).toBeLessThanOrEqual(2);
  const path = view.path(notes[0].parentId);
  expect(path).toHaveLength(5000);
  expect(path[0].id).toBe(stashes[0].id);
  expect(path.at(-1)?.id).toBe(notes[0].parentId);
  expect(view.label(null).text).toBe('Home');
});
it('keeps ordinary labels exact, handles Unicode boundaries, and rejects missing locations', () => {
  const stashes = [
    item({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      kind: 'stash',
      markdown: 'Projects',
    }),
    item({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      kind: 'stash',
      parentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      markdown: 'Ideas',
    }),
  ];
  let view = hierarchy.createHierarchyPresentation(stashes);
  expect(view.label(stashes[1].id)).toMatchObject({
    text: 'Home / Projects / Ideas',
    abbreviated: false,
    depth: 2,
  });
  stashes[1] = { ...stashes[1], markdown: '😀'.repeat(200) };
  view = hierarchy.createHierarchyPresentation(stashes);
  expect(Array.from(view.label(stashes[1].id).text).length).toBeLessThanOrEqual(
    96,
  );
  expect(view.label(stashes[1].id).text).not.toContain('\uFFFD');
  expect(() => view.label('missing')).toThrow();
});
