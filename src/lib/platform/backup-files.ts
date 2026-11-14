/** Native file dialogs and atomic file writes; cancellation returns null. */
export interface BackupFiles {
  chooseRead(): Promise<string | null>;
  chooseWrite(text: string): Promise<string | null>;
  writeSafety(text: string): Promise<void>;
}
