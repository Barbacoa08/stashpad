import type { Item, V3Workspace } from '../../src/lib/domain/notes';
import { convertLegacy } from '../../src/lib/domain/backup';
export function item(fields: Partial<Item> & Pick<Item, 'id'>): Item {
  return {
    parentId: null,
    kind: 'note',
    markdown: '',
    done: false,
    color: null,
    position: 0,
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    restoreParentId: null,
    restoreIndex: null,
    ...fields,
  };
}
/** Explicit frozen fixture conversion; never used by application repositories. */
export const legacyFixture = (s: V3Workspace) => convertLegacy(s);
