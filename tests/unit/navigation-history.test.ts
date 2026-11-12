import { expect, it } from 'vitest';
import { item } from '../fixtures/items';
import * as api from '../../src/lib/workspace/navigation-history';
import type { Item, Location } from '../../src/lib/domain/notes';
it('commits only acknowledged visits, truncates branches, bounds, and resets', () => {
  const h = new api.NavigationHistory();
  const home: Location = { scope: 'live', itemId: null };
  h.visit(home);
  h.visit(home);
  expect(h.entries).toHaveLength(1);
  for (let i = 0; i < 110; i++) h.visit({ scope: 'live', itemId: String(i) });
  expect(h.entries).toHaveLength(100);
  expect(h.cursor).toBe(99);
  expect(h.entries[0].itemId).toBe('10');
  const intent = h.begin(-1, () => true);
  expect(h.cursor).toBe(99);
  expect(h.acknowledge(intent!.location)).toBe(true);
  expect(h.cursor).toBe(98);
  h.visit(home);
  expect(h.entries.at(-1)).toEqual(home);
  expect(h.target(1, () => true)).toBeNull();
  h.reset(home);
  expect(h.entries).toEqual([home]);
  expect(h.target(-1, () => true)).toBeNull();
});
it('skips missing and changed scopes, reconciles without appending, and supersedes pending traversal', () => {
  const home: Location = { scope: 'live', itemId: null },
    trash: Location = { scope: 'trash', itemId: null };
  const a = item({ id: 'a', kind: 'stash' });
  const h = new api.NavigationHistory();
  h.visit(home);
  h.visit({ scope: 'live', itemId: a.id });
  h.visit(trash);
  const valid = (at: Location) => api.historyLocationValidator([a])(at);
  a.deletedAt = 10;
  expect(h.target(-1, valid)!.location).toEqual(home);
  const pending = h.begin(-1, valid);
  h.cancel();
  expect(h.acknowledge(pending!.location)).toBe(false);
  h.reconcile(home);
  expect(h.entries).toHaveLength(3);
  expect(h.entries[h.cursor]).toEqual(home);
  expect(
    api.historyLocationValidator([item({ id: a.id })])({
      scope: 'live',
      itemId: a.id,
    }),
  ).toBe(false);
});
it('projects root and final two ancestors with explicit omitted depth, within recorded scope', () => {
  const items: Item[] = [];
  for (let i = 0; i < 20; i++)
    items.push(
      item({
        id: String(i),
        kind: 'stash',
        parentId: items.at(-1)?.id ?? null,
        markdown: 'x'.repeat(100),
      }),
    );
  const crumbs = api.breadcrumbs(items, { scope: 'live', itemId: '19' });
  expect(crumbs.map((x) => x.location?.itemId)).toEqual([
    null,
    undefined,
    '18',
    '19',
  ]);
  expect(crumbs[1].label).toBe('18 ancestors omitted');
  expect(crumbs.at(-1)!.label.length).toBeLessThanOrEqual(32);
  items[10].deletedAt = 10;
  const scoped = api.breadcrumbs(items, { scope: 'trash', itemId: '11' });
  expect(scoped.map((x) => x.location?.itemId)).toEqual([null, '10', '11']);
  expect(scoped[0].label).toBe('Trash');
});

it('matches exact identities/scopes and rejects missing or non-container visits', () => {
  const at: Location = { scope: 'live', itemId: 'A' };
  const valid = api.historyLocationValidator([
    item({ id: 'A', kind: 'stash' }),
    item({ id: 'note' }),
  ]);
  expect(valid(at)).toBe(true);
  expect(valid({ ...at, itemId: 'a' })).toBe(false);
  expect(valid({ ...at, itemId: 'missing' })).toBe(false);
  expect(valid({ ...at, itemId: 'note' })).toBe(false);
  expect(valid({ ...at, scope: 'trash' })).toBe(false);
  expect(valid({ scope: 'trash', itemId: null })).toBe(true);
  const h = new api.NavigationHistory();
  h.visit({ scope: 'live', itemId: null });
  h.visit(at);
  h.begin(-1, valid);
  expect(h.acknowledge({ scope: 'trash', itemId: null })).toBe(false);
  expect(h.cursor).toBe(1);
  h.reset(at);
  expect(h.acknowledge({ scope: 'live', itemId: null })).toBe(false);
});
