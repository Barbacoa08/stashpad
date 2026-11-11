export interface Note {
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
  notes: Note[];
  drafts: Draft[];
  undoDeleteId: string | null;
}
export interface BackupV1 {
  format: 'stashpad-alpha';
  version: 1;
  exportedAt: string;
  workspace: WorkspaceSnapshot;
}
export interface AppError {
  code: string;
  message: string;
}
export const emptyWorkspace = (): WorkspaceSnapshot => ({
  notes: [],
  drafts: [],
  undoDeleteId: null,
});
export const MAX_SOURCE = 1024 * 1024,
  MAX_ENVELOPE = 10 * 1024 * 1024;
