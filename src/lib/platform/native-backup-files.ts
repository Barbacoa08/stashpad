import { invoke } from '@tauri-apps/api/core';
import type { BackupFiles } from './backup-files';

export function createNativeBackupFiles(
  call: typeof invoke = invoke,
): BackupFiles {
  return {
    chooseRead: () => call<string | null>('backup_read_text'),
    chooseWrite: (text) => call<string | null>('backup_write_text', { text }),
    writeSafety: (text) => call<void>('backup_safety_text', { text }),
    chooseRecoveryWrite: async (chunks) => {
      const id = await call<string | null>('recovery_begin');
      if (id === null) return null;
      try {
        let index = 0;
        for await (const chunk of chunks) {
          await call<void>('recovery_append', { id, index, chunk });
          index++;
        }
        return await call<string>('recovery_finish', { id });
      } catch (error) {
        await call<void>('recovery_abort', { id }).catch(() => {});
        throw error;
      }
    },
  };
}
export const nativeBackupFiles = createNativeBackupFiles();
