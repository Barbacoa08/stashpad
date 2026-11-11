import { invoke } from '@tauri-apps/api/core';
import type { WorkspaceSnapshot } from '../domain/notes';
export interface RestorePreview {
  token: string;
  notes: number;
  drafts: number;
  warning: string;
}
export interface Repository {
  loadWorkspace(): Promise<WorkspaceSnapshot>;
  checkpointDraft(
    key: string,
    markdown: string,
    revision: number,
  ): Promise<WorkspaceSnapshot>;
  saveNote(
    id: string | null,
    markdown: string,
    draftKey: string,
    draftRevision: number,
  ): Promise<WorkspaceSnapshot>;
  discardDraft(key: string): Promise<WorkspaceSnapshot>;
  deleteNote(id: string): Promise<WorkspaceSnapshot>;
  undoDelete(): Promise<WorkspaceSnapshot>;
  exportBackup(): Promise<string | null>;
  previewRestore(): Promise<RestorePreview | null>;
  confirmRestore(
    token: string,
    confirm: boolean,
  ): Promise<WorkspaceSnapshot | null>;
}
export const nativeRepository: Repository = {
  loadWorkspace: () => invoke('workspace_load'),
  checkpointDraft: (key, markdown, revision) =>
    invoke('draft_checkpoint', { key, markdown, revision }),
  saveNote: (id, markdown, draftKey, draftRevision) =>
    invoke('note_save', { id, markdown, draftKey, draftRevision }),
  discardDraft: (key) => invoke('draft_discard', { key }),
  deleteNote: (id) => invoke('note_delete', { id }),
  undoDelete: () => invoke('note_undo_delete'),
  exportBackup: () => invoke('backup_export'),
  previewRestore: () => invoke('backup_preview_restore'),
  confirmRestore: (token, confirm) =>
    invoke('backup_confirm_restore', { token, confirm }),
};
