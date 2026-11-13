import type { CloseAdapter } from '../../src/lib/platform/lifecycle';
import { MemoryRepository } from './memory';
import { convertLegacy } from '../../src/lib/domain/backup';
import type { V3Workspace } from '../../src/lib/domain/notes';
import { visualNotes } from './visual';
import type { WorkspaceController } from '../../src/lib/workspace/controller';
let closeHandler: Parameters<CloseAdapter['onCloseRequested']>[0] | undefined;
const windowState = {
  hidden: 0,
  prevented: 0,
  hideAttempts: 0,
  failHide: false,
};
export const windowAdapter: CloseAdapter = {
  async onCloseRequested(handler) {
    closeHandler = handler;
    return () => {
      closeHandler = undefined;
    };
  },
  async hide() {
    windowState.hideAttempts++;
    if (windowState.failHide) throw new Error('Synthetic hide failure');
    windowState.hidden++;
  },
};
export const repository = new MemoryRepository();
if (new URL(location.href).searchParams.has('failLoad'))
  repository.fail = 'load';
if (new URL(location.href).searchParams.has('visual'))
  repository.snapshot.items = structuredClone(visualNotes);
let release: () => void = () => {};
let releaseCheckpoint: () => void = () => {};
export function ready(controller: WorkspaceController) {
  (window as any).__test = {
    repo: repository,
    windowState,
    requestClose() {
      if (!closeHandler)
        throw new Error('Close test listener is not registered');
      return closeHandler({
        preventDefault() {
          windowState.prevented++;
        },
      });
    },
    seedLegacy(s: V3Workspace) {
      repository.snapshot = convertLegacy(s);
    },
    controller,
    delay() {
      repository.delaySave = new Promise<void>((r) => (release = r));
    },
    delayCheckpoint() {
      repository.delayCheckpoint = new Promise<void>(
        (resolve) => (releaseCheckpoint = resolve),
      );
    },
    releaseCheckpoint() {
      releaseCheckpoint();
      repository.delayCheckpoint = null;
    },
    release() {
      release();
      repository.delaySave = null;
    },
  };
}
