import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  encodeBackup,
  validateBackup,
} from '../../src/lib/domain/legacy-backup';
import { MAX_ENVELOPE } from '../../src/lib/domain/notes';
const old = () =>
  JSON.parse(
    readFileSync(new URL('../fixtures/valid-v1.json', import.meta.url), 'utf8'),
  );
const v2 = () => {
  const b = old();
  b.version = 2;
  b.workspace.stashes = [];
  b.workspace.notes.forEach((n: any) => (n.stashId = null));
  return b;
};
const v3 = () => {
  const b = v2();
  b.version = 3;
  b.workspace.notes.forEach((n: any, i: number) => (n.done = i % 2 === 0));
  return b;
};
it('normalizes strict V1 and V2 to V3 without changing source, drafts, Undo, or metadata', () => {
  for (const b of [old(), v2()]) {
    const expected = structuredClone(b.workspace);
    expected.stashes ??= [];
    expected.notes.forEach((n: any) => {
      n.stashId ??= null;
      n.done = false;
    });
    expect(validateBackup(JSON.stringify(b))).toEqual({
      ...b,
      version: 3,
      workspace: expected,
    });
    b.workspace.notes[0].done = false;
    expect(validateBackup(JSON.stringify(b))).toHaveProperty(
      'code',
      'invalid_backup',
    );
  }
});
it('requires exact boolean done in V3 and roundtrips both states', () => {
  const b = v3();
  expect(validateBackup(JSON.stringify(b))).toEqual(b);
  expect(JSON.parse(encodeBackup(b.workspace))).toMatchObject({
    version: 3,
    workspace: b.workspace,
  });
  for (const value of [undefined, null, 0, 1, 'false', [], {}]) {
    const changed = v3();
    changed.workspace.notes[0].done = value;
    expect(validateBackup(JSON.stringify(changed))).toHaveProperty(
      'code',
      'invalid_backup',
    );
  }
  b.workspace.notes[0].unknown = false;
  expect(validateBackup(JSON.stringify(b))).toHaveProperty(
    'code',
    'invalid_backup',
  );
});
it('includes converted completion metadata in the unchanged compact UTF8 capacity', () => {
  const b = v2();
  b.workspace.notes = [];
  b.workspace.drafts = [];
  b.workspace.undoDeleteId = null;
  for (let i = 0; i < 9; i++)
    b.workspace.notes.push({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      stashId: null,
      markdown: 'x'.repeat(1024 * 1024),
      createdAt: 0,
      updatedAt: 0,
      deletedAt: null,
    });
  b.workspace.drafts.push({
    key: 'compose',
    markdown: '',
    revision: 0,
    updatedAt: 0,
  });
  b.workspace.drafts[0].markdown = 'x'.repeat(
    MAX_ENVELOPE - Buffer.byteLength(JSON.stringify(b)),
  );
  expect(Buffer.byteLength(JSON.stringify(b))).toBe(MAX_ENVELOPE);
  expect(validateBackup(JSON.stringify(b))).toHaveProperty(
    'code',
    'invalid_backup',
  );
  b.version = 3;
  b.workspace.notes.forEach((n: any) => (n.done = false));
  const overhead = Buffer.byteLength(JSON.stringify(b)) - MAX_ENVELOPE;
  b.workspace.drafts[0].markdown =
    b.workspace.drafts[0].markdown.slice(overhead);
  expect(Buffer.byteLength(JSON.stringify(b))).toBe(MAX_ENVELOPE);
  expect(validateBackup(JSON.stringify(b))).toHaveProperty('version', 3);
  b.workspace.drafts[0].markdown += 'x';
  expect(validateBackup(JSON.stringify(b))).toHaveProperty(
    'code',
    'invalid_backup',
  );
});

it('shares strict owned V2 and completed V3 fixtures with the native validator', () => {
  const v2 = JSON.parse(
    readFileSync(new URL('../fixtures/valid-v2.json', import.meta.url), 'utf8'),
  );
  const v3 = JSON.parse(
    readFileSync(new URL('../fixtures/valid-v3.json', import.meta.url), 'utf8'),
  );
  const expected = structuredClone(v2);
  expected.version = 3;
  expected.workspace.notes.forEach((n: any) => (n.done = false));
  expect(validateBackup(JSON.stringify(v2))).toEqual(expected);
  expect(validateBackup(JSON.stringify(v3))).toEqual(v3);
  for (const version of [2, 3]) {
    for (const key of [
      'stashId',
      'deletedAt',
      'id',
      'markdown',
      'createdAt',
      'updatedAt',
    ]) {
      const b = structuredClone(version === 2 ? v2 : v3);
      delete b.workspace.notes[0][key];
      expect(validateBackup(JSON.stringify(b))).toHaveProperty(
        'code',
        'invalid_backup',
      );
    }
  }
});

it('enforces UTF8 source capacity on current completed notes', () => {
  const b = v3();
  b.workspace.notes[0].markdown = 'α'.repeat(512 * 1024);
  expect(validateBackup(JSON.stringify(b))).toHaveProperty('version', 3);
  b.workspace.notes[0].markdown += 'a';
  expect(validateBackup(JSON.stringify(b))).toHaveProperty(
    'code',
    'invalid_backup',
  );
});
