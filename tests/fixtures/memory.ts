import type {
  Repository,
  RestorePreview,
} from '../../src/lib/platform/workspace';
import {
  emptyWorkspace,
  type WorkspaceSnapshot,
} from '../../src/lib/domain/notes';
import { validateBackup, encodeBackup } from '../../src/lib/domain/backup';
export class MemoryRepository implements Repository {
  snapshot = emptyWorkspace();
  fail: string | null = null;
  delaySave: Promise<void> | null = null;
  delayCheckpoint: Promise<void> | null = null;
  checkpointCalls = 0;
  failCheckpointCall: number | null = null;
  restoreText: string | null = null;
  exported: string | null = null;
  staged: WorkspaceSnapshot | null = null;
  cancelExport = false;
  cancelRestore = false;
  private check(op: string) {
    if (this.fail === op)
      throw {
        code: 'test_failure',
        message: 'Synthetic local ' + op + ' failure. Retry.',
      };
  }
  private commit(s: WorkspaceSnapshot) {
    const checked = validateBackup(encodeBackup(s));
    if ('code' in checked) throw checked;
    this.snapshot = structuredClone(s);
    return structuredClone(s);
  }
  async loadWorkspace() {
    this.check('load');
    return structuredClone(this.snapshot);
  }
  async checkpointDraft(key: string, markdown: string, revision: number) {
    const call = ++this.checkpointCalls;
    await this.delayCheckpoint;
    if (call === this.failCheckpointCall)
      throw {
        code: 'test_failure',
        message: 'Synthetic local checkpoint failure. Retry.',
      };
    this.check('checkpoint');
    const s = structuredClone(this.snapshot);
    const old = s.drafts.find((d) => d.key === key);
    if (!old || revision > old.revision) {
      s.drafts = s.drafts.filter((d) => d.key !== key);
      s.drafts.push({ key, markdown, revision, updatedAt: Date.now() });
    }
    return this.commit(s);
  }
  async saveNote(
    id: string | null,
    markdown: string,
    draftKey: string,
    draftRevision: number,
  ) {
    await this.delaySave;
    this.check('save');
    if (!markdown.trim())
      throw {
        code: 'empty_note',
        message: 'Enter non-whitespace text before saving.',
      };
    const s = structuredClone(this.snapshot);
    const n = s.notes.find((n) => n.id === id);
    if (n) {
      n.markdown = markdown;
      n.updatedAt = Math.max(Date.now(), n.updatedAt + 1);
    } else
      s.notes.push({
        id: crypto.randomUUID(),
        markdown,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        deletedAt: null,
      });
    s.drafts = s.drafts.filter(
      (d) => d.key !== draftKey || d.revision > draftRevision,
    );
    return this.commit(s);
  }
  async deleteNote(id: string) {
    this.check('delete');
    const s = structuredClone(this.snapshot);
    const n = s.notes.find((n) => n.id === id);
    if (n) n.deletedAt = Date.now();
    s.drafts = s.drafts.filter((d) => d.key !== id);
    s.undoDeleteId = id;
    return this.commit(s);
  }
  async undoDelete() {
    this.check('undo');
    const s = structuredClone(this.snapshot);
    const n = s.notes.find((n) => n.id === s.undoDeleteId);
    if (n) n.deletedAt = null;
    s.undoDeleteId = null;
    return this.commit(s);
  }
  async exportBackup() {
    this.check('export');
    if (this.cancelExport) return null;
    this.exported = encodeBackup(this.snapshot);
    return 'synthetic-backup.json';
  }
  async previewRestore(): Promise<RestorePreview | null> {
    this.check('preview');
    if (this.cancelRestore || !this.restoreText) return null;
    const b = validateBackup(this.restoreText);
    if ('code' in b) throw b;
    this.staged = b.workspace;
    return {
      token: 'synthetic-token',
      notes: b.workspace.notes.length,
      drafts: b.workspace.drafts.length,
      warning:
        'Replace the entire local workspace. A safety backup is required.',
    };
  }
  async confirmRestore(_token: string, confirm: boolean) {
    this.check('restore');
    if (!confirm) {
      this.staged = null;
      return null;
    }
    if (!this.staged) throw Error('No preview');
    const s = this.commit(this.staged);
    this.staged = null;
    return s;
  }
}
