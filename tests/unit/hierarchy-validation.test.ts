import { it, expect } from 'vitest';
import { validateBackup, encodeBackup } from '../../src/lib/domain/backup';
import { item } from '../fixtures/items';
it('accepts a complete current hierarchy before replacement', () => {
  const library = {
    items: [
      item({
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        kind: 'tree',
        markdown: 'Parent',
      }),
    ],
    drafts: [],
    undoDeleteIds: [],
  };
  expect(validateBackup(encodeBackup(library))).toHaveProperty(
    'library',
    library,
  );
});
