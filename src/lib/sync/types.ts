import type { Item } from '../domain/notes';

export type Placement = Pick<
  Item,
  'parentId' | 'deletedAt' | 'restoreParentId' | 'restoreIndex'
>;
export type SharedItem = Omit<
  Item,
  'parentId' | 'position' | 'deletedAt' | 'restoreParentId' | 'restoreIndex'
> & { epoch: string; placement: Placement };
// Wire epochs and order IDs are nonempty strings of at most 128 UTF-8 bytes.
export interface OrderRow {
  id: string;
  epoch: string;
  parentId: string | null;
  // Only Root has separate live/Trash groups; a parent has one sibling group.
  scope: 'live' | 'trash';
  ids: string[];
}
export interface PurgeRow {
  id: string;
  epoch: string;
  purgedAt: number;
}
export interface ProjectionNotice {
  kind: 'cycle' | 'orphan' | 'trash-root' | 'restore-parent';
  itemId: string;
}
