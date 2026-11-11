import { describe, it, expect } from 'vitest';
import { filterNotes } from '../../src/lib/domain/search';
const notes = [
  {
    id: 'b',
    markdown: '**Alpha**',
    createdAt: 0,
    updatedAt: 2,
    deletedAt: null,
  },
  {
    id: 'a',
    markdown: 'ALPHA beta',
    createdAt: 0,
    updatedAt: 2,
    deletedAt: null,
  },
  { id: 'c', markdown: 'alpha', createdAt: 0, updatedAt: 3, deletedAt: 3 },
];
describe('saved-source search', () => {
  it('trims, ignores case, excludes deleted, and sorts ties', () =>
    expect(filterNotes(notes, ' ALpHa ').map((n) => n.id)).toEqual(['a', 'b']));
  it('matches original delimiters and empty query', () => {
    expect(filterNotes(notes, '**')).toHaveLength(1);
    expect(filterNotes(notes, '')).toHaveLength(2);
    expect(filterNotes(notes, 'missing')).toEqual([]);
  });
});
