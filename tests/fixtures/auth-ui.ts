import type {
  AuthPort,
  AuthState,
  SyncPort,
  SyncState,
} from '../../src/lib/sync/service-types';
let authState: AuthState = {
  phase: 'signed-out',
  open: false,
  email: '',
  error: null,
  canCancel: true,
  authenticated: false,
  configured: true,
};
let syncState: SyncState = {
  state: 'local-only',
  lastConfirmed: null,
  detail: null,
  recoveries: 0,
};
const authListeners = new Set<(state: AuthState) => void>();
let failRecovery = false;
let replaceAfterPurge = false;
let lastPurge: { epoch: string; ids: string[] } | null = null;
let overflowEpoch = 'captured-epoch';
let overflowRows = [
  {
    id: '00000000-0000-4000-8000-000000000001',
    markdown: 'Synthetic oversized note',
  },
];
const syncListeners = new Set<(state: SyncState) => void>();
function setAuth(patch: Partial<AuthState>) {
  authState = { ...authState, ...patch };
  authListeners.forEach((fn) => fn(authState));
}
function setSync(patch: Partial<SyncState>) {
  syncState = { ...syncState, ...patch };
  syncListeners.forEach((fn) => fn(syncState));
}
export const auth: AuthPort = {
  subscribe(fn) {
    authListeners.add(fn);
    fn(authState);
    return () => authListeners.delete(fn);
  },
  showSignIn() {
    setAuth({ open: true, phase: 'email', error: null });
  },
  async submitEmail(email) {
    setAuth({ phase: 'sending-code', email });
  },
  async submitCode() {
    setAuth({ phase: 'verifying', canCancel: false });
  },
  restartSignIn() {
    setAuth({ phase: 'email', error: null });
  },
  dismiss() {
    if (authState.canCancel) setAuth({ open: false });
  },
  async signOut() {
    setAuth({ phase: 'signed-out', authenticated: false });
  },
  async acceptCloud() {
    setAuth({ join: null, error: 'Synced notes selected.' });
  },
  async retrySync() {
    setAuth({ error: null });
  },
};
export const sync: SyncPort = {
  subscribe(fn) {
    syncListeners.add(fn);
    fn(syncState);
    return () => syncListeners.delete(fn);
  },
  async retry() {
    setSync({ state: 'syncing' });
  },
  async exportRecovery() {
    if (failRecovery) throw new Error('Synthetic export failure');
    setSync({ detail: 'Recovery export requested.' });
  },
  async inspectOverflow() {
    return { epoch: overflowEpoch, overflow: true, rows: overflowRows };
  },
  async purgeOverflow(request) {
    lastPurge = structuredClone(request);
    if (request.epoch !== overflowEpoch) throw new Error('Wrong epoch');
    if (replaceAfterPurge) {
      overflowEpoch = 'replacement-epoch';
      overflowRows = [{ id: overflowRows[0].id, markdown: 'New epoch note' }];
      return;
    }
    overflowRows = overflowRows.filter((row) => !request.ids.includes(row.id));
    setSync({ detail: 'Selected raw notes removed.', overflow: undefined });
  },
};
export function install() {
  Object.assign(window, {
    authUiFixture: {
      setAuth,
      setSync,
      setRows(rows: typeof overflowRows) {
        overflowRows = rows;
      },
      lastPurge() {
        return lastPurge;
      },
      replaceDuringPurge() {
        replaceAfterPurge = true;
      },
      failRecovery(value: boolean) {
        failRecovery = value;
      },
    },
  });
}
