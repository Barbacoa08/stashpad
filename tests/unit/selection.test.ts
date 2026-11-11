import { expect, it } from 'vitest';
import { LocationSelection } from '../../src/lib/workspace/selection';
it('remembers exact IDs per location, prefers exited stash, rejects deleted entries, and clears on restore', () => {
  const selection = new LocationSelection();
  selection.remember(null, 'Parent');
  selection.remember('Parent', 'child');
  expect(selection.open(null, ['Parent', 'other'])).toBe('Parent');
  expect(selection.open('Parent', ['first', 'child'])).toBe('child');
  expect(selection.open('Parent', ['first', 'CHILD'])).toBe('first');
  expect(selection.open('empty', [])).toBe('');
  expect(selection.open(null, ['Parent', 'other'], 'other')).toBe('other');
  selection.clear();
  expect(selection.open(null, ['first', 'Parent'])).toBe('first');
});
it('keeps Home and Trash-root memory distinct while container identity survives scope changes', () => {
  const s = new LocationSelection();
  s.remember({ scope: 'live', itemId: null }, 'home');
  s.remember({ scope: 'trash', itemId: null }, 'trash');
  expect(s.open({ scope: 'live', itemId: null }, ['home', 'trash'])).toBe(
    'home',
  );
  expect(s.open({ scope: 'trash', itemId: null }, ['home', 'trash'])).toBe(
    'trash',
  );
  s.remember({ scope: 'live', itemId: 'owner' }, 'child');
  expect(s.open({ scope: 'trash', itemId: 'owner' }, ['other', 'child'])).toBe(
    'child',
  );
});
