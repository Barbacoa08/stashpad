import { it, expect } from 'vitest';
import { MemoryRepository } from '../fixtures/memory';
import { WorkspaceController } from '../../src/lib/workspace/controller';
const root = '00000000-0000-4000-8000-000000000001';
it('opens Trash as a separate location with its own compose draft and clears navigation search', async () => {
  const c = new WorkspaceController(new MemoryRepository());
  await c.start();
  c.editSource('Home draft');
  c.setQuery('live query');
  expect(await c.openLocation({ scope: 'trash', itemId: null })).toBe(true);
  expect(c.state.activeKey).toBe('compose:trash');
  expect(c.state.query).toBe('');
  c.editSource('Trash draft');
  await c.openStash(null);
  expect(c.state.source).toBe('Home draft');
  c.dispose();
});
it('Undo while viewing restored tree follows the live scope without losing its composer', async () => {
  const r = new MemoryRepository();
  await r.createChildStash({
    id: root,
    parent: { scope: 'live', itemId: null },
  });
  await r.deleteItem(root);
  const c = new WorkspaceController(r);
  await c.start();
  await c.openStash(root);
  c.editSource('tree draft');
  expect(await c.undoRemove()).toBe(true);
  expect(c.state.location).toEqual({ scope: 'live', itemId: root });
  expect(c.state.activeKey).toBe(`compose:${root}`);
  expect(c.state.source).toBe('tree draft');
  c.dispose();
});
for (const direction of ['delete', 'restore'])
  it(`lost capture acknowledgment reconciles the same child identity after owner ${direction}`, async () => {
    const r = new MemoryRepository();
    await r.createChildStash({
      id: root,
      parent: { scope: 'live', itemId: null },
    });
    if (direction === 'restore') await r.deleteItem(root);
    const capture = r.captureItem.bind(r);
    let lost = true;
    r.captureItem = async (request) => {
      const s = await capture(request);
      if (lost) {
        lost = false;
        throw Error('lost reply');
      }
      return s;
    };
    const c = new WorkspaceController(r);
    await c.start();
    await c.openStash(root);
    c.editSource('original child');
    expect(await c.save()).toBe(false);
    const child = r.snapshot.items.find((x) => x.id !== root)!;
    if (direction === 'delete') await c.remove(root);
    else await c.restoreItem(root);
    await c.openStash(root);
    c.editSource('newer draft');
    expect(await c.save()).toBe(true);
    expect(r.snapshot.items.filter((x) => x.id !== root)).toEqual([child]);
    expect(c.state.source).toBe('newer draft');
    c.dispose();
  });
