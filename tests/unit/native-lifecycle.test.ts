import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearMocks, mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { emit, TauriEvent } from '@tauri-apps/api/event';
import { nativeCloseAdapter } from '../../src/lib/platform/native-lifecycle';
import { attachCloseGuard } from '../../src/lib/platform/lifecycle';

beforeEach(() => {
  vi.stubGlobal('window', { crypto: globalThis.crypto });
  mockWindows('main');
});
afterEach(() => {
  clearMocks();
  vi.unstubAllGlobals();
});

it('hides the application so the native app switcher can restore its retained windows', async () => {
  const commands: string[] = [];
  mockIPC((command) => {
    commands.push(command);
  });
  await nativeCloseAdapter.hide();
  expect(commands).toEqual(['plugin:app|app_hide']);
});

it('propagates application-hide rejection without closing or exiting and permits retry', async () => {
  const commands: string[] = [];
  let reject = true;
  mockIPC((command) => {
    commands.push(command);
    if (command === 'plugin:app|app_hide' && reject)
      throw new Error('Synthetic application-hide failure');
  });
  await expect(nativeCloseAdapter.hide()).rejects.toThrow(
    'Synthetic application-hide failure',
  );
  reject = false;
  await expect(nativeCloseAdapter.hide()).resolves.toBeUndefined();
  expect(commands).toEqual(['plugin:app|app_hide', 'plugin:app|app_hide']);
});

it('the SDK close event flushes before app-hide and never invokes its default window destroy', async () => {
  const operations: string[] = [];
  mockIPC(
    (command) => {
      operations.push(command);
    },
    { shouldMockEvents: true },
  );
  let release!: (ok: boolean) => void;
  const cleanup = attachCloseGuard(
    nativeCloseAdapter,
    () => {
      operations.push('flush');
      return new Promise<boolean>((resolve) => {
        release = resolve;
      });
    },
    () => operations.push('failed'),
  );
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await emit(TauriEvent.WINDOW_CLOSE_REQUESTED);
    await vi.waitFor(() => expect(operations).toEqual(['flush']));
    release(true);
    await vi.waitFor(() =>
      expect(operations).toEqual(['flush', 'plugin:app|app_hide']),
    );
  } finally {
    cleanup();
  }
});
