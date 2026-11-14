import type { Placement } from './types';
import type { BackupV8 } from './backup';
import type { ColorToken, Location, Item } from '../domain/notes';
import type {
  CaptureItem,
  CreateChildTree,
  DraftAck,
  MoveItems,
  PurgeItem,
  ReorderItem,
  TransitionLocation,
  UndoDeleteRequest,
  StructuralItem,
} from '../platform/workspace';
/** Captured caller input, never retargeted from newer selection or navigation. */
export type IntentCommand =
  | { kind: 'saveItemSource'; id: string; markdown: string; draft: DraftAck }
  | { kind: 'captureItem'; request: CaptureItem }
  | { kind: 'createChildTree'; request: CreateChildTree }
  | { kind: 'promoteItem'; id: string }
  | { kind: 'deleteItem'; id: string; leave?: Location }
  | { kind: 'purgeItem'; request: PurgeItem }
  | { kind: 'transitionLocation'; request: TransitionLocation }
  | { kind: 'moveItems'; request: MoveItems }
  | { kind: 'restoreItem'; id: string }
  | { kind: 'undoDelete'; request: UndoDeleteRequest }
  | { kind: 'setItemDone'; id: string; done: boolean }
  | { kind: 'setItemColor'; id: string; color: ColorToken | null }
  | { kind: 'reorderItem'; request: ReorderItem }
  | {
      kind: 'replaceLibrary';
      previousEpoch: string;
      newEpoch: string;
      backup: BackupV8;
    };
/** Only actual operation-owned changes are retained; unchanged Markdown is absent. */
export type ItemFieldDeltas = {
  [
    K in Exclude<keyof Item, 'id' | 'markdown' | 'createdAt' | keyof Placement>
  ]?: {
    before: Item[K];
    after: Item[K];
  };
};
interface OutcomeIdentity {
  id: string;
  /** Complete projected Item digest for auditing, not universal outcome equality. */
  digest: string;
}
export type ItemOutcome =
  | (OutcomeIdentity & {
      kind: 'create';
      structural: StructuralItem;
      item: Item;
    })
  | (OutcomeIdentity & {
      kind: 'update';
      structural: StructuralItem;
      fields: ItemFieldDeltas;
      /** One captured atomic parent/deletion/restore value, matching the wire write. */
      placement?: { before: Placement; after: Placement };
      /** Exact source remains in the captured command and device recovery. */
      source?: { beforeDigest: string; afterDigest: string };
    })
  | (OutcomeIdentity & {
      kind: 'purge';
      structural: null;
      before: StructuralItem;
    });
export interface ExpectedOutcome {
  items: ItemOutcome[];
  purgedIds: string[];
  orders: { group: Location; ids: string[] }[];
}
export interface PendingIntent {
  id: string;
  epoch: string;
  /** SHA-256 of {epoch, command}; stable while an unacknowledged local retry exists. */
  fingerprint: string;
  /** SHA-256 of {command, expected}; the replicated witness has this exact digest. */
  digest: string;
  /** Captured once before the preservation barrier; retry never refreshes it. */
  recordedAt: number;
  command: IntentCommand;
  expected: ExpectedOutcome;
  /** Local atomic application only; this never means server acceptance. */
  localApplied: boolean;
}
export interface IntentWitness {
  id: string;
  epoch: string;
  digest: string;
  recordedAt: number;
}
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry) =>
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.keys(entry)
            .sort()
            .map((key) => [key, entry[key]]),
        )
      : entry,
  );
}
export async function digest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalJson(value)),
  );
  return Array.from(new Uint8Array(bytes), (x) =>
    x.toString(16).padStart(2, '0'),
  ).join('');
}
