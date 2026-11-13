export interface LegacyStash {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: number;
  updatedAt: number;
}
export interface V3Note {
  done: boolean;
  stashId: string | null;
  id: string;
  markdown: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}
export interface Draft {
  key: string;
  markdown: string;
  revision: number;
  updatedAt: number;
}
export interface V3Workspace {
  stashes: LegacyStash[];
  notes: V3Note[];
  drafts: Draft[];
  undoDeleteId: string | null;
}
// Frozen legacy wire shapes must not inherit new current-note fields.
export interface LegacyNote {
  id: string;
  markdown: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}
export interface LegacyWorkspace {
  notes: LegacyNote[];
  drafts: Draft[];
  undoDeleteId: string | null;
}
export interface V2Note extends LegacyNote {
  stashId: string | null;
}
export interface V2Workspace {
  stashes: LegacyStash[];
  notes: V2Note[];
  drafts: Draft[];
  undoDeleteId: string | null;
}
export interface BackupV1 {
  format: 'stashpad-alpha';
  version: 1;
  exportedAt: string;
  workspace: LegacyWorkspace;
}
export interface BackupV2 {
  format: 'stashpad-alpha';
  version: 2;
  exportedAt: string;
  workspace: V2Workspace;
}
export interface BackupV3 {
  format: 'stashpad-alpha';
  version: 3;
  exportedAt: string;
  workspace: V3Workspace;
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
  kind: 'note' | 'stash';
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
// Frozen V4 wire fields and semantic validation must remain independent of current Item.
export interface V4Item {
  id: string;
  parentId: string | null;
  kind: 'note' | 'stash';
  markdown: string;
  done: boolean;
  color:
    | 'red'
    | 'orange'
    | 'yellow'
    | 'green'
    | 'teal'
    | 'blue'
    | 'purple'
    | 'pink'
    | 'gray'
    | null;
  position: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  restoreParentId: string | null;
  restoreIndex: number | null;
}
export interface V4Workspace {
  items: V4Item[];
  drafts: Draft[];
  undoDeleteId: string | null;
}
export interface BackupV4 {
  format: 'stashpad-alpha';
  version: 4;
  exportedAt: string;
  workspace: V4Workspace;
}
export interface V5Item {
  id: string;
  parentId: string | null;
  kind: 'note' | 'stash';
  markdown: string;
  done: boolean;
  color:
    | 'red'
    | 'orange'
    | 'yellow'
    | 'green'
    | 'teal'
    | 'blue'
    | 'purple'
    | 'pink'
    | 'gray'
    | null;
  position: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  restoreParentId: string | null;
  restoreIndex: number | null;
}
export interface V5Workspace {
  items: V5Item[];
  drafts: Draft[];
  undoDeleteId: string | null;
}
export interface BackupV5 {
  format: 'stashpad-alpha';
  version: 5;
  exportedAt: string;
  workspace: V5Workspace;
}
export interface BackupV6 {
  format: 'stashpad-alpha';
  version: 6;
  exportedAt: string;
  workspace: WorkspaceSnapshot;
}
export const emptyWorkspace = (): WorkspaceSnapshot => ({
  items: [],
  drafts: [],
  undoDeleteIds: [],
});
export const MAX_SOURCE = 1024 * 1024,
  MAX_ENVELOPE = 10 * 1024 * 1024;
