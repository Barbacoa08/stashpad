export interface Stash {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: number;
  updatedAt: number;
}
export interface Note {
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
export interface LegacyNote extends Omit<Note, 'stashId'> {}
export interface LegacyWorkspace extends Omit<
  WorkspaceSnapshot,
  'stashes' | 'notes'
> {
  notes: LegacyNote[];
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
