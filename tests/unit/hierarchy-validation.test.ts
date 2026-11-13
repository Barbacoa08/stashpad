import { it, expect } from 'vitest';
import { validateBackup } from '../../src/lib/domain/backup';
it('accepts complete version2 hierarchy before replacement', () => {
  expect(
    validateBackup(
      JSON.stringify({
        format: 'stashpad-alpha',
        version: 2,
        exportedAt: '2026-11-11T00:00:00.000Z',
        workspace: {
          stashes: [
            {
              id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              name: 'Parent',
              parentId: null,
              createdAt: 0,
              updatedAt: 0,
            },
          ],
          notes: [],
          drafts: [],
          undoDeleteId: null,
        },
      }),
    ),
  ).toHaveProperty('version', 6);
});
