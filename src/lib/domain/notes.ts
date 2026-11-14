export interface Draft {
  key: string;
  markdown: string;
  revision: number;
  updatedAt: number;
}
export interface AppError {
  code: string;
  message: string;
}
export const COLORS = [
  'red',
  'orange',
  'yellow',
  'green',
  'teal',
  'blue',
  'purple',
  'pink',
  'gray',
] as const;
export type ColorToken = (typeof COLORS)[number];
export interface Item {
  id: string;
  parentId: string | null;
  kind: 'note' | 'tree';
  markdown: string;
  done: boolean;
  color: ColorToken | null;
  position: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  restoreParentId: string | null;
  restoreIndex: number | null;
}
export interface Location {
  scope: 'live' | 'trash';
  itemId: string | null;
}
export interface WorkspaceSnapshot {
  items: Item[];
  drafts: Draft[];
  undoDeleteIds: string[];
}
export interface BackupV7 {
  format: 'scratchtree-alpha';
  version: 7;
  exportedAt: string;
  library: WorkspaceSnapshot;
}
export const emptyWorkspace = (): WorkspaceSnapshot => ({
  items: [],
  drafts: [],
  undoDeleteIds: [],
});
export const MAX_SOURCE = 1024 * 1024,
  MAX_ENVELOPE = 10 * 1024 * 1024;
