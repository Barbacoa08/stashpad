import { describe, expect, it, vi } from 'vitest';
import { encodeBackup, validateBackup } from '../../src/lib/domain/backup';
import { validateSnapshot } from '../../src/lib/domain/validation';
import {
  MAX_ENVELOPE,
  MAX_SOURCE,
  type WorkspaceSnapshot,
} from '../../src/lib/domain/notes';
import {
  encodeCloudBackup,
  validateCloudBackup,
  type BackupV8,
  type RecoveryRecord,
} from '../../src/lib/sync/backup';
import { item } from '../fixtures/items';

const live = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
const trash = 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB';
const nested = 'CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC';
const gone = 'DDDDDDDD-DDDD-4DDD-8DDD-DDDDDDDDDDDD';
const recoveryId = 'EEEEEEEE-EEEE-4EEE-8EEE-EEEEEEEEEEEE';
const exportedAt = '2026-11-14T00:00:00.000Z';
const source =
  'α 🪴 **bold**  \r\n```ts\r\nconst x = 1;\n```\r\n- one\n  - two\r\n';
const snapshot = (): WorkspaceSnapshot => ({
  items: [
    item({ id: live, kind: 'tree', markdown: source }),
    item({
      id: trash,
      kind: 'tree',
      markdown: 'Trash tree',
      deletedAt: 1,
      restoreParentId: live,
      restoreIndex: 0,
    }),
    item({
      id: nested,
      parentId: trash,
      markdown: 'independently deleted',
      deletedAt: 2,
      restoreParentId: live,
      restoreIndex: 1,
    }),
  ],
  drafts: [
    { key: live, markdown: source, revision: 7, updatedAt: 8 },
    { key: 'compose', markdown: 'root\r\n', revision: 1, updatedAt: 2 },
    { key: 'compose:trash', markdown: 'trash\n', revision: 2, updatedAt: 3 },
    { key: `compose:${live}`, markdown: 'child', revision: 3, updatedAt: 4 },
  ],
  undoDeleteIds: [nested, trash],
});
const record = (): Extract<RecoveryRecord, { kind: 'source' }> => ({
  id: recoveryId,
  kind: 'source',
  reason: 'purged',
  itemId: gone,
  originEpoch: 'old-epoch',
  markdown: source,
  recordedAt: 10,
});
const input = (): Omit<BackupV8, 'format' | 'version' | 'exportedAt'> => {
  const s = snapshot();
  return {
    library: { items: s.items, purgedIds: [gone] },
    device: {
      drafts: s.drafts,
      undoDeleteIds: s.undoDeleteIds,
      recovery: [record()],
    },
  };
};
const envelope = () => ({
  format: 'scratchtree',
  version: 8,
  exportedAt,
  ...input(),
});
const rejected = (value: unknown) =>
  expect(validateCloudBackup(JSON.stringify(value))).toHaveProperty(
    'code',
    'invalid_backup',
  );

describe('format-neutral snapshot policy', () => {
  it('accepts exact uppercase IDs, independent Trash roots, and local draft identities without a file envelope', () => {
    const s = snapshot(),
      before = structuredClone(s);
    expect(validateSnapshot(s)).toEqual(before);
    expect(s).toEqual(before);
    expect(validateBackup(encodeBackup(s))).toHaveProperty('library', before);
  });
  it('rejects unknown fields and exact-case dangling references without mutating input', () => {
    const s = snapshot();
    s.items[1].restoreParentId = live.toLowerCase();
    const before = structuredClone(s);
    expect(validateSnapshot(s)).toHaveProperty('code', 'invalid_backup');
    expect(s).toEqual(before);
    expect(
      validateSnapshot({ ...snapshot(), provider: 'secret' }),
    ).toHaveProperty('code');
  });
});

describe('strict current-only portable cloud backup', () => {
  it('encodes only the V8 envelope and preserves exact Markdown, local Undo, drafts, and the sole purged source', () => {
    const value = input(),
      before = structuredClone(value);
    const text = encodeCloudBackup(value, exportedAt);
    expect(JSON.parse(text)).toEqual(envelope());
    expect(validateCloudBackup(text)).toEqual(envelope());
    expect(value).toEqual(before);
  });
  it('validates recovery snapshot references independently of the current library', () => {
    const b = envelope();
    b.device.recovery = [
      {
        id: recoveryId,
        kind: 'library',
        reason: 'replaced',
        originEpoch: 'old-epoch',
        recordedAt: 10,
        snapshot: {
          items: [item({ id: gone, markdown: source })],
          drafts: [{ key: gone, markdown: '', revision: 0, updatedAt: 0 }],
          undoDeleteIds: [],
        },
      },
    ];
    expect(validateCloudBackup(JSON.stringify(b))).toEqual(b);
    const recovery = b.device.recovery[0];
    if (recovery.kind !== 'library')
      throw new Error('Expected library recovery');
    recovery.snapshot.drafts[0].key = live;
    rejected(b);
  });
  it.each([live, 'compose', 'compose:trash', `compose:${gone}`])(
    'preserves exact recoverable draft identity %s even when its owner is absent',
    (draftKey) => {
      const b = envelope();
      b.device.recovery = [
        {
          id: recoveryId,
          kind: 'draft',
          reason: 'purged',
          originEpoch: 'old-epoch',
          recordedAt: 10,
          draftKey,
          markdown: '',
        },
      ];
      expect(validateCloudBackup(JSON.stringify(b))).toEqual(b);
    },
  );
  it.each([
    'format',
    'version7',
    'future',
    'exportedAt',
    'extraEnvelope',
    'extraLibrary',
    'extraDevice',
    'providerItem',
    'duplicateItemCase',
    'duplicatePurgedCase',
    'invalidPurged',
    'purgedOverlapCase',
    'danglingDraft',
    'draftCase',
    'danglingParent',
    'undoCase',
    'duplicateUndo',
    'sourceBytes',
    'extraRecovery',
    'duplicateRecoveryCase',
    'recoveryId',
    'recoveryReason',
    'recoveryEpoch',
    'recoveryEpochBytes',
    'recoveryTime',
    'sourceIdentity',
    'sourceSnapshot',
    'draftIdentity',
    'draftNullIdentity',
    'libraryMarkdown',
    'libraryItem',
    'librarySnapshot',
    'recoveryBytes',
  ])('rejects %s', (change) => {
    const b = structuredClone(envelope()) as any;
    const r = b.device.recovery[0];
    if (change === 'format') b.format = 'scratchtree-alpha';
    if (change === 'version7') b.version = 7;
    if (change === 'future') b.version = 9;
    if (change === 'exportedAt') b.exportedAt = '2026-02-30T00:00:00.000Z';
    if (change === 'extraEnvelope') b.credentials = 'forbidden';
    if (change === 'extraLibrary') b.library.realmId = 'forbidden';
    if (change === 'extraDevice') b.device.witness = 'forbidden';
    if (change === 'providerItem') b.library.items[0].owner = 'forbidden';
    if (change === 'duplicateItemCase')
      b.library.items.push({
        ...b.library.items[0],
        id: live.toLowerCase(),
        position: 1,
      });
    if (change === 'duplicatePurgedCase')
      b.library.purgedIds.push(gone.toLowerCase());
    if (change === 'invalidPurged') b.library.purgedIds = ['not-an-id'];
    if (change === 'purgedOverlapCase')
      b.library.purgedIds = [live.toLowerCase()];
    if (change === 'danglingDraft') b.device.drafts[0].key = gone;
    if (change === 'draftCase') b.device.drafts[0].key = live.toLowerCase();
    if (change === 'danglingParent') b.library.items[0].parentId = gone;
    if (change === 'undoCase') b.device.undoDeleteIds[0] = nested.toLowerCase();
    if (change === 'duplicateUndo') b.device.undoDeleteIds.push(nested);
    if (change === 'sourceBytes')
      b.library.items[0].markdown = 'α'.repeat(MAX_SOURCE / 2) + 'x';
    if (change === 'extraRecovery') r.rawSdkJson = {};
    if (change === 'duplicateRecoveryCase')
      b.device.recovery.push({ ...r, id: recoveryId.toLowerCase() });
    if (change === 'recoveryId') r.id = 'invalid';
    if (change === 'recoveryReason') r.reason = 'lost';
    if (change === 'recoveryEpoch') r.originEpoch = '';
    if (change === 'recoveryEpochBytes') r.originEpoch = 'α'.repeat(65);
    if (change === 'recoveryTime') r.recordedAt = -1;
    if (change === 'sourceIdentity') r.itemId = 'compose';
    if (change === 'sourceSnapshot') r.snapshot = snapshot();
    if (change === 'draftIdentity') {
      r.kind = 'draft';
      delete r.itemId;
      r.draftKey = 'compose:invalid';
    }
    if (change === 'draftNullIdentity') {
      r.kind = 'draft';
      delete r.itemId;
      r.draftKey = null;
    }
    if (change === 'libraryMarkdown') {
      r.kind = 'library';
      delete r.itemId;
      r.snapshot = snapshot();
    }
    if (change === 'libraryItem') {
      r.kind = 'library';
      delete r.markdown;
      r.snapshot = snapshot();
    }
    if (change === 'librarySnapshot') {
      r.kind = 'library';
      delete r.markdown;
      delete r.itemId;
    }
    if (change === 'recoveryBytes') r.markdown = 'x'.repeat(MAX_SOURCE + 1);
    rejected(b);
  });
  it('rejects old backups, malformed JSON, and oversized raw input', () => {
    expect(validateCloudBackup(encodeBackup(snapshot()))).toHaveProperty(
      'code',
    );
    expect(validateCloudBackup('{')).toHaveProperty('code');
    expect(validateCloudBackup(' '.repeat(MAX_ENVELOPE + 1))).toHaveProperty(
      'code',
    );
  });
  it('accepts source UTF-8 at its exact limit and rejects the next byte', () => {
    const b = envelope();
    b.library.items[0].markdown = 'α'.repeat(MAX_SOURCE / 2);
    expect(validateCloudBackup(JSON.stringify(b))).toEqual(b);
    b.library.items[0].markdown += 'x';
    rejected(b);
  });
  it('counts all stored items including Trash, and validates a maximum-depth hierarchy iteratively', () => {
    const b = envelope();
    b.device = { drafts: [], undoDeleteIds: [], recovery: [] };
    b.library.items = Array.from({ length: 20000 }, (_, i) =>
      item({
        id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        kind: 'tree',
        parentId: i
          ? `00000000-0000-4000-8000-${String(i - 1).padStart(12, '0')}`
          : null,
        deletedAt: i ? null : 1,
      }),
    );
    expect(validateCloudBackup(JSON.stringify(b))).toEqual(b);
    b.library.items.push(item({ id: live }));
    rejected(b);
  });
  it('accepts all 40,002 scoped drafts and rejects the next draft before references can hide excess capacity', () => {
    const b = envelope();
    b.library.items = Array.from({ length: 20000 }, (_, i) =>
      item({
        id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        position: i,
      }),
    );
    b.device = {
      drafts: [
        'compose',
        'compose:trash',
        ...b.library.items.flatMap((x) => [x.id, `compose:${x.id}`]),
      ].map((key) => ({ key, markdown: '', revision: 0, updatedAt: 0 })),
      undoDeleteIds: [],
      recovery: [],
    };
    expect(validateCloudBackup(JSON.stringify(b))).toEqual(b);
    b.device.drafts.push({
      key: gone,
      markdown: '',
      revision: 0,
      updatedAt: 0,
    });
    rejected(b);
  });
  it('includes recovery and all metadata in the exact complete compact envelope limit without truncation', () => {
    const b = envelope();
    b.library.items = Array.from({ length: 9 }, (_, i) =>
      item({
        id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        position: i,
        markdown: 'x'.repeat(MAX_SOURCE),
      }),
    );
    b.device.drafts = [];
    b.device.undoDeleteIds = [];
    const recovery = b.device.recovery[0];
    if (recovery.kind !== 'source') throw new Error('Expected source recovery');
    recovery.markdown = '';
    recovery.markdown = 'x'.repeat(
      MAX_ENVELOPE - Buffer.byteLength(JSON.stringify(b)),
    );
    expect(Buffer.byteLength(JSON.stringify(b))).toBe(MAX_ENVELOPE);
    expect(validateCloudBackup(JSON.stringify(b))).toEqual(b);
    const encoded = encodeCloudBackup(
      { library: b.library, device: b.device },
      exportedAt,
    );
    expect(Buffer.byteLength(encoded)).toBe(MAX_ENVELOPE);
    expect(JSON.parse(encoded)).toEqual(b);
    recovery.markdown += 'x';
    rejected(b);
    expect(() =>
      encodeCloudBackup({ library: b.library, device: b.device }, exportedAt),
    ).toThrow();
  });
  it.each([true, false])(
    'owns the export timestamp when a full validated backup is supplied (explicit: %s)',
    (explicit) => {
      const backup = validateCloudBackup(JSON.stringify(envelope()));
      if ('code' in backup) throw new Error(backup.message);
      const now = '2026-11-15T01:02:03.004Z';
      vi.useFakeTimers();
      vi.setSystemTime(new Date(now));
      try {
        const text = explicit
          ? encodeCloudBackup(backup, now)
          : encodeCloudBackup(backup);
        expect(JSON.parse(text)).toEqual({ ...envelope(), exportedAt: now });
        expect(backup.exportedAt).toBe(exportedAt);
      } finally {
        vi.useRealTimers();
      }
    },
  );
  it('owns format and version while retaining unknown-field rejection', () => {
    const value = {
      ...input(),
      format: 'obsolete',
      version: 7,
      exportedAt: 'old',
    };
    expect(JSON.parse(encodeCloudBackup(value, exportedAt))).toEqual(
      envelope(),
    );
    const unknown = { ...value, credentials: 'forbidden' };
    expect(() => encodeCloudBackup(unknown, exportedAt)).toThrow();
  });
  it('rejects invalid exports before returning a backup and retains caller input', () => {
    const value = input();
    value.library.purgedIds.push(live);
    const before = structuredClone(value);
    expect(() => encodeCloudBackup(value, exportedAt)).toThrow();
    expect(value).toEqual(before);
  });
});
