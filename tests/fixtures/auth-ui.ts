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
    setSync({ detail: 'Recovery export requested.' });
  },
};
export function install() {
  Object.assign(window, { authUiFixture: { setAuth, setSync } });
}
