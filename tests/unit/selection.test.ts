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
