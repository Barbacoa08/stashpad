import { expect, it } from 'vitest';
import { encodeBackup, validateBackup } from '../../src/lib/domain/backup';
import { MAX_SOURCE, MAX_ENVELOPE } from '../../src/lib/domain/notes';
import { item } from '../fixtures/items';
const id = '11111111-1111-4111-8111-111111111111';
const library = () => ({
  items: [item({ id, done: true, markdown: '**done**\r\nnext\n' })],
  drafts: [],
  undoDeleteIds: [],
});
it('roundtrips completion in version-7 library without rewriting source', () => {
  const s = library();
  expect(validateBackup(encodeBackup(s))).toHaveProperty('library', s);
  for (const done of [false, true]) {
    s.items[0].done = done;
    expect(validateBackup(encodeBackup(s))).toHaveProperty('library', s);
  }
  for (const done of [undefined, null, 0, 1, 'false', [], {}]) {
    const b = JSON.parse(encodeBackup(s));
    b.library.items[0].done = done;
    expect(validateBackup(JSON.stringify(b))).toHaveProperty(
      'code',
      'invalid_backup',
    );
  }
});
it('enforces UTF-8 source capacity including a completed note and draft', () => {
  const s = library();
  s.items[0].markdown = 'α'.repeat(MAX_SOURCE / 2);
  expect(validateBackup(encodeBackup(s))).toHaveProperty('library', s);
  s.items[0].markdown += 'a';
  expect(validateBackup(encodeBackup(s))).toHaveProperty('code');
});
it('includes completion, drafts, and envelope metadata in exact compact capacity', () => {
  const s = {
    items: Array.from({ length: 9 }, (_, i) =>
      item({
        id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        position: i,
        done: i % 2 === 0,
        markdown: 'x'.repeat(MAX_SOURCE),
      }),
    ),
    drafts: [{ key: 'compose', markdown: '', revision: 0, updatedAt: 0 }],
    undoDeleteIds: [],
  };
  s.drafts[0].markdown = 'x'.repeat(
    MAX_ENVELOPE - Buffer.byteLength(encodeBackup(s)),
  );
  expect(Buffer.byteLength(encodeBackup(s))).toBe(MAX_ENVELOPE);
  expect(validateBackup(encodeBackup(s))).toHaveProperty('library', s);
  s.drafts[0].markdown += 'x';
  expect(validateBackup(encodeBackup(s))).toHaveProperty('code');
});
