import { describe, it, expect } from 'vitest';
import { filterNotes } from '../../src/lib/domain/search';
const notes = [
  {
    id: 'b',
    markdown: '**Alpha**',
    createdAt: 0,
    updatedAt: 2,
    stashId: null,
    done: false,
    deletedAt: null,
  },
  {
    id: 'a',
    markdown: 'ALPHA beta',
    createdAt: 0,
    updatedAt: 2,
    stashId: null,
    done: false,
    deletedAt: null,
  },
  {
    id: 'c',
    markdown: 'alpha',
    createdAt: 0,
    updatedAt: 3,
    stashId: null,
    done: false,
    deletedAt: 3,
  },
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
it('keeps capture order after edits, appends newer captures, and breaks creation ties by ID', () => {
  const source = [
    {
      id: 'b',
      markdown: 'one',
      createdAt: 1,
      updatedAt: 100,
      stashId: null,
      done: false,
      deletedAt: null,
    },
    {
      id: 'c',
      markdown: 'two',
      createdAt: 2,
      updatedAt: 2,
      stashId: null,
      done: false,
      deletedAt: null,
    },
    {
      id: 'a',
      markdown: 'tie',
      createdAt: 1,
      updatedAt: 1,
      stashId: null,
      done: false,
      deletedAt: null,
    },
  ];
  expect(filterNotes(source, '').map((n) => n.id)).toEqual(['a', 'b', 'c']);
});
