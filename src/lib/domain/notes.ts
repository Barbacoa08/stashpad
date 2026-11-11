export interface Stash {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: number;
  updatedAt: number;
}
export interface Note {
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
export interface WorkspaceSnapshot {
  stashes: Stash[];
  notes: Note[];
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
  stashes: Stash[];
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
  workspace: WorkspaceSnapshot;
}
export interface AppError {
  code: string;
  message: string;
}
export const emptyWorkspace = (): WorkspaceSnapshot => ({
  stashes: [],
  notes: [],
  drafts: [],
  undoDeleteId: null,
});
export const MAX_SOURCE = 1024 * 1024,
  MAX_ENVELOPE = 10 * 1024 * 1024;
