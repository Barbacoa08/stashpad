import Dexie, { type Table } from 'dexie';
import dexieCloud from 'dexie-cloud-addon';
import type { Draft } from '../domain/notes';
import type { StructuralItem } from '../platform/workspace';
import type { SharedItem, OrderRow, PurgeRow } from './types';
import type { RecoveryRecord } from './backup';
import type { PendingIntent, IntentWitness } from './intents';
export interface DatabaseOptions {
  name: string;
  databaseUrl?: string;
  automaticSync?: boolean;
}
export interface LibraryRow {
  id: string;
  epoch: string;
}
export interface DraftRow extends Draft {
  epoch: string;
}
export interface UndoRow {
  epoch: string;
  ids: string[];
  facts: StructuralItem[];
}
export interface DeviceRow {
  key: string;
  value: unknown;
}
/** Current-only storage. Compound epoch keys preserve retired rows without cross-epoch writes. */
export class ScratchtreeDatabase extends Dexie {
  readonly cloudEnabled: boolean;
  notes!: Table<SharedItem, [string, string]>;
  orders!: Table<OrderRow, [string, string]>;
  purges!: Table<PurgeRow, [string, string]>;
  libraries!: Table<LibraryRow, string>;
  witnesses!: Table<IntentWitness, string>;
  drafts!: Table<DraftRow, [string, string]>;
  undo!: Table<UndoRow, string>;
  recovery!: Table<RecoveryRecord, string>;
  pending!: Table<PendingIntent, string>;
  device!: Table<DeviceRow, string>;
  constructor(options: DatabaseOptions) {
    super(options.name, options.databaseUrl ? { addons: [dexieCloud] } : {});
    this.cloudEnabled = !!options.databaseUrl;
    this.version(1).stores({
      notes: '[epoch+id],epoch',
      orders: '[epoch+id],epoch',
      purges: '[epoch+id],epoch',
      libraries: 'id',
      witnesses: 'id,epoch',
      deviceDrafts: '[epoch+key],epoch',
      deviceUndo: 'epoch',
      deviceRecovery: 'id',
      devicePending: 'id,epoch,fingerprint',
      deviceState: 'key',
    });
    this.drafts = this.table('deviceDrafts');
    this.undo = this.table('deviceUndo');
    this.recovery = this.table('deviceRecovery');
    this.pending = this.table('devicePending');
    this.device = this.table('deviceState');
    if (options.databaseUrl)
      this.cloud.configure({
        databaseUrl: options.databaseUrl,
        requireAuth: false,
        customLoginGui: true,
        tryUseServiceWorker: false,
        unsyncedTables: [
          'deviceDrafts',
          'deviceUndo',
          'deviceRecovery',
          'devicePending',
          'deviceState',
        ],
        largeStringThreshold: Infinity,
        socialAuth: false,
        disableEagerSync: !options.automaticSync,
        disableWebSocket: !options.automaticSync,
      });
  }
}
