import type { Repository } from '../../src/lib/platform/workspace';
import type { CloseAdapter } from '../../src/lib/platform/lifecycle';
import { MemoryRepository } from './memory';
import type { Item, WorkspaceSnapshot } from '../../src/lib/domain/notes';
import { item } from './items';
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
export const repository: MemoryRepository &
  Pick<Repository, 'refreshFromRemote'> = new MemoryRepository();
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
    seed(
      s: Omit<WorkspaceSnapshot, 'items'> & {
        items: (Partial<Item> & Pick<Item, 'id'>)[];
      },
    ) {
      const ranks = new Map<string, number>();
      repository.snapshot = {
        ...s,
        items: s.items.map((x) => {
          const key = JSON.stringify([
            x.parentId ?? null,
            x.deletedAt == null ? 'live' : 'trash',
          ]);
          const position = ranks.get(key) ?? 0;
          ranks.set(key, position + 1);
          return item({ ...x, position: x.position ?? position });
        }),
      };
    },
    controller,
    async remoteReplace(snapshot: WorkspaceSnapshot) {
      repository.snapshot = structuredClone(snapshot);
      repository.refreshFromRemote = async () => ({
        workspace: structuredClone(snapshot),
        replaced: true,
        removedIds: [],
        originEpoch: 'fixture-prior-epoch',
      });
      try {
        return await controller.refreshFromRepository();
      } finally {
        delete repository.refreshFromRemote;
      }
    },
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
