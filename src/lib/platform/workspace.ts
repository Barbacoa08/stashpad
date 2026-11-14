import { invoke } from '@tauri-apps/api/core';
import type { WorkspaceSnapshot, Location, ColorToken } from '../domain/notes';
export interface RestorePreview {
  token: string;
  notes: number;
  drafts: number;
  trees: number;
  warning: string;
}
export interface DraftAck {
  key: string;
  revision: number;
}
export interface CaptureItem {
  id: string;
  location: Location;
  markdown: string;
  draft: DraftAck;
}
export interface CreateChildTree {
  id: string;
  parent: Location;
  leave?: Location;
}
export interface ReorderItem {
  id: string;
  group: Location;
  toIndex: number;
}
export interface PurgeItem {
  id: string;
  location: Location;
  expectedSubtreeIds: string[];
}
export interface PurgeResult {
  workspace: WorkspaceSnapshot;
  removedIds: string[];
}
export interface TransitionLocation {
  from: Location;
  to: Location;
  promoteDestination: boolean;
}
export type StructuralItem = Pick<
  import('../domain/notes').Item,
  | 'id'
  | 'parentId'
  | 'kind'
  | 'position'
  | 'deletedAt'
  | 'restoreParentId'
  | 'restoreIndex'
>;
export interface StructuralProof {
  before: StructuralItem[];
  after: StructuralItem[];
}
export interface UndoDeleteRequest {
  ids: string[];
  proof: StructuralProof;
}
export interface MoveItems {
  proof?: StructuralProof;
  deletedAt?: number;
  ids: string[];
  from: Location;
  to: Location;
  beforeFrom: string[];
  beforeTo: string[];
  afterFrom: string[];
  afterTo: string[];
}
export interface Repository {
  loadWorkspace(): Promise<WorkspaceSnapshot>;
  checkpointDraft(
    key: string,
    markdown: string,
    revision: number,
  ): Promise<WorkspaceSnapshot>;
  discardDraft(key: string): Promise<WorkspaceSnapshot>;
  saveItemSource(
    id: string,
    markdown: string,
    draft: DraftAck,
  ): Promise<WorkspaceSnapshot>;
  captureItem(request: CaptureItem): Promise<WorkspaceSnapshot>;
  createChildTree(request: CreateChildTree): Promise<WorkspaceSnapshot>;
  promoteItem(id: string): Promise<WorkspaceSnapshot>;
  deleteItem(id: string, leave?: Location): Promise<WorkspaceSnapshot>;
  purgeItem(request: PurgeItem): Promise<PurgeResult>;
  transitionLocation(request: TransitionLocation): Promise<WorkspaceSnapshot>;
  moveItems(request: MoveItems): Promise<WorkspaceSnapshot>;
  restoreItem(id: string): Promise<WorkspaceSnapshot>;
  undoDelete(request: UndoDeleteRequest): Promise<WorkspaceSnapshot>;
  setItemDone(id: string, done: boolean): Promise<WorkspaceSnapshot>;
  setItemColor(
    id: string,
    color: ColorToken | null,
  ): Promise<WorkspaceSnapshot>;
  reorderItem(request: ReorderItem): Promise<WorkspaceSnapshot>;
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
  discardDraft: (key) => invoke('draft_discard', { key }),
  saveItemSource: (id, markdown, draft) =>
    invoke('item_save_source', { id, markdown, draft }),
  captureItem: (request) => invoke('item_capture', { request }),
  createChildTree: (request) => invoke('item_create_child_tree', { request }),
  promoteItem: (id) => invoke('item_promote', { id }),
  deleteItem: (id, leave) => invoke('item_delete', { id, leave }),
  purgeItem: (request) => invoke('item_purge', { request }),
  transitionLocation: (request) => invoke('workspace_transition', { request }),
  moveItems: (request) => invoke('items_move', { request }),
  restoreItem: (id) => invoke('item_restore', { id }),
  undoDelete: (request) => invoke('item_undo_delete', { request }),
  setItemDone: (id, done) => invoke('item_set_done', { id, done }),
  setItemColor: (id, color) => invoke('item_set_color', { id, color }),
  reorderItem: (request) => invoke('item_reorder', { request }),
  exportBackup: () => invoke('backup_export'),
  previewRestore: () => invoke('backup_preview_restore'),
  confirmRestore: (token, confirm) =>
    invoke('backup_confirm_restore', { token, confirm }),
};
