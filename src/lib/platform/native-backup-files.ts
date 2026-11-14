import { invoke } from '@tauri-apps/api/core';
import type { BackupFiles } from './backup-files';

export const nativeBackupFiles: BackupFiles = {
  chooseRead: () => invoke<string | null>('backup_read_text'),
  chooseWrite: (text) => invoke<string | null>('backup_write_text', { text }),
  writeSafety: (text) => invoke<void>('backup_safety_text', { text }),
};
