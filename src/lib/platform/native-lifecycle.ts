import { hide } from '@tauri-apps/api/app';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { CloseAdapter } from './lifecycle';

export const nativeCloseAdapter: CloseAdapter = {
  onCloseRequested: (handler) => getCurrentWindow().onCloseRequested(handler),
  hide,
};
