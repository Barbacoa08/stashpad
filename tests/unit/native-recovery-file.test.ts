import { describe, expect, it } from 'vitest';
import type { invoke } from '@tauri-apps/api/core';
import { createNativeBackupFiles } from '../../src/lib/platform/native-backup-files';

function nativeFile(cancelled = false, appendFailure = false) {
  let committed = 'prior';
  let temporary = '';
  let aborted = false;
  const call: typeof invoke = async <T>(command: string, args = {}) => {
    const value = args as Record<string, unknown>;
    let result: unknown;
    switch (command) {
      case 'recovery_begin':
        result = cancelled ? null : 'captured-job';
        break;
      case 'recovery_append':
        expect(value.id).toBe('captured-job');
        if (appendFailure) throw new Error('Write failed');
        temporary += value.chunk;
        break;
      case 'recovery_finish':
        committed = temporary;
        temporary = '';
        result = 'recovery.json';
        break;
      case 'recovery_abort':
        temporary = '';
        aborted = true;
        break;
      default:
        throw new Error('Unexpected native command');
    }
    return result as T;
  };
  return {
    files: createNativeBackupFiles(call),
    state: () => ({ committed, temporary, aborted }),
  };
}
describe('native recovery stream adapter', () => {
  it('writes the complete exact stream before publishing', async () => {
    const native = nativeFile();
    async function* chunks() {
      yield 'α\r\n';
      yield '🦀';
    }
    expect(await native.files.chooseRecoveryWrite!(chunks())).toBe(
      'recovery.json',
    );
    expect(native.state()).toEqual({
      committed: 'α\r\n🦀',
      temporary: '',
      aborted: false,
    });
  });
  it('does not consume the stream after a cancelled save dialog', async () => {
    const native = nativeFile(true);
    let consumed = false;
    async function* chunks() {
      consumed = true;
      yield 'source';
    }
    expect(await native.files.chooseRecoveryWrite!(chunks())).toBeNull();
    expect(consumed).toBe(false);
    expect(native.state().committed).toBe('prior');
  });
  it('aborts an interrupted generator without publishing a partial file', async () => {
    const native = nativeFile();
    async function* chunks() {
      yield 'first';
      throw new Error('Read failed');
    }
    await expect(native.files.chooseRecoveryWrite!(chunks())).rejects.toThrow(
      'Read failed',
    );
    expect(native.state()).toEqual({
      committed: 'prior',
      temporary: '',
      aborted: true,
    });
  });
  it('closes the producer and aborts after a native write failure', async () => {
    const native = nativeFile(false, true);
    let closed = false;
    async function* chunks() {
      try {
        yield 'first';
        yield 'second';
      } finally {
        closed = true;
      }
    }
    await expect(native.files.chooseRecoveryWrite!(chunks())).rejects.toThrow(
      'Write failed',
    );
    expect(closed).toBe(true);
    expect(native.state()).toEqual({
      committed: 'prior',
      temporary: '',
      aborted: true,
    });
  });
});
