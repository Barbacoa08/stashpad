import { MemoryRepository } from './memory';
import { visualNotes } from './visual';
import type { WorkspaceController } from '../../src/lib/workspace/controller';
export const repository = new MemoryRepository();
if (new URL(location.href).searchParams.has('failLoad'))
  repository.fail = 'load';
if (new URL(location.href).searchParams.has('visual'))
  repository.snapshot.notes = structuredClone(visualNotes);
let release: () => void = () => {};
let releaseCheckpoint: () => void = () => {};
export function ready(controller: WorkspaceController) {
  (window as any).__test = {
    repo: repository,
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
