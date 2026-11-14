import type { Item } from '../../src/lib/domain/notes';
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
