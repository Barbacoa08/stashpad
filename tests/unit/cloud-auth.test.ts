import { describe, expect, it } from 'vitest';
import {
  CloudAuthController,
  type AuthHost,
  type CloudLogin,
} from '../../src/lib/sync/auth';
import type { DXCUserInteraction, UserLogin } from 'dexie-cloud-addon';

function setup() {
  let interaction:
    ((prompt: DXCUserInteraction | undefined) => void) | undefined;
  let resolveLogin!: () => void;
  let rejectLogin!: (error: Error) => void;
  let cancelled = 0;
  let started = 0;
  const hints: unknown[] = [];
  const user: UserLogin = {
    claims: {},
    lastLogin: new Date(),
    isLoggedIn: false,
  };
  const api: CloudLogin = {
    currentUser: { getValue: () => user },
    userInteraction: {
      subscribe: (listener) => {
        interaction = listener;
        return {
          unsubscribe: () => {
            interaction = undefined;
          },
        };
      },
    },
    login: (hint) => {
      hints.push(hint);
      started++;
      return new Promise<void>((resolve, reject) => {
        resolveLogin = resolve;
        rejectLogin = reject;
      });
    },
  };
  let finishCount = 0;
  let join: { localNotes: number; cloudNotes: number } | null = null;
  let failFinish = false;
  let signedOut = 0;
  const host: AuthHost = {
    configured: true,
    accountExists: async () => true,
    prepareSignIn: async () => api,
    cancelSignIn: async () => {
      cancelled++;
    },
    finishSignIn: async () => {
      finishCount++;
      if (failFinish) throw new Error('Offline');
      return join;
    },
    acceptCloud: async () => {
      join = null;
    },
    signOut: async () => {
      signedOut++;
    },
  };
  const auth = new CloudAuthController(host);
  const tick = async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  };
  const otp = (invalid = false) =>
    interaction?.({
      type: 'otp',
      title: 'Code',
      fields: { otp: { type: 'text', label: 'Code' } },
      alerts: invalid
        ? [
            {
              type: 'error',
              messageCode: 'INVALID_OTP',
              message: 'Wrong code',
              messageParams: {},
            },
          ]
        : [
            {
              type: 'info',
              messageCode: 'OTP_SENT',
              message: 'Code sent',
              messageParams: {},
            },
          ],
      submitLabel: 'Submit',
      cancelLabel: 'Cancel',
      onSubmit: () => {},
      onCancel: () => rejectLogin(new Error('Cancelled')),
    });
  return {
    auth,
    host,
    tick,
    otp,
    hints,
    user,
    success: () => {
      user.isLoggedIn = true;
      resolveLogin();
    },
    prompt: (p: DXCUserInteraction) => interaction?.(p),
    failure: () => rejectLogin(new Error('Offline')),
    setJoin: () => {
      join = { localNotes: 2, cloudNotes: 3 };
    },
    setFailFinish: (value: boolean) => {
      failFinish = value;
    },
    counts: () => ({ started, cancelled, finishCount, signedOut }),
  };
}

describe('public Dexie login flow', () => {
  it('requests existing-user OTP once, and only enables the code after OTP_SENT', async () => {
    const f = setup();
    f.auth.showSignIn();
    const pending = f.auth.submitEmail(' dev@example.com ');
    await f.tick();
    expect(f.auth.state.phase).toBe('sending-code');
    await f.auth.submitEmail('other@example.com');
    expect(f.hints).toEqual([
      { email: 'dev@example.com', grant_type: 'otp', intent: 'login' },
    ]);
    f.otp();
    await pending;
    expect(f.auth.state).toMatchObject({
      phase: 'code',
      email: 'dev@example.com',
      canCancel: true,
    });
  });

  it('cancels an unknown-user retry instead of submitting to an intent-losing email prompt', async () => {
    const f = setup();
    f.auth.showSignIn();
    const pending = f.auth.submitEmail('dev@example.com');
    await f.tick();
    let submitted = false;
    f.prompt({
      type: 'email',
      title: 'Email',
      fields: { email: { type: 'text', placeholder: 'Email' } },
      alerts: [
        {
          type: 'error',
          messageCode: 'USER_NOT_REGISTERED',
          message: 'Unknown',
          messageParams: {},
        },
      ],
      submitLabel: 'Submit',
      cancelLabel: 'Cancel',
      onSubmit: () => {
        submitted = true;
      },
      onCancel: () => f.failure(),
    });
    await pending;
    await f.tick();
    expect(submitted).toBe(false);
    expect(f.auth.state).toMatchObject({
      phase: 'email',
      error: 'That account does not exist. Sign-up is coming soon.',
    });
    const second = f.auth.submitEmail('dev@example.com');
    await f.tick();
    f.otp();
    await second;
    expect(f.counts().started).toBe(2);
    expect(f.hints).toHaveLength(2);
  });

  it('blocks cancellation during verification and retains the challenge after an invalid code', async () => {
    const f = setup();
    f.auth.showSignIn();
    const email = f.auth.submitEmail('dev@example.com');
    await f.tick();
    f.otp();
    await email;
    const code = f.auth.submitCode('123456');
    await f.tick();
    expect(f.auth.state).toMatchObject({
      phase: 'verifying',
      canCancel: false,
    });
    f.auth.dismiss();
    expect(f.auth.state.open).toBe(true);
    f.otp(true);
    await code;
    expect(f.auth.state).toMatchObject({
      phase: 'code',
      email: 'dev@example.com',
      canCancel: true,
      error: 'That code is invalid or expired. Try again.',
    });
  });

  it('distinguishes authenticated-but-pending sync from completed sign-in', async () => {
    const f = setup();
    f.setFailFinish(true);
    f.auth.showSignIn();
    const email = f.auth.submitEmail('dev@example.com');
    await f.tick();
    f.otp();
    await email;
    const code = f.auth.submitCode('123456');
    f.success();
    await code;
    expect(f.auth.state).toMatchObject({
      phase: 'syncing',
      authenticated: true,
      open: true,
      error: 'Offline',
    });
    f.setFailFinish(false);
    await f.auth.retrySync();
    expect(f.auth.state).toMatchObject({
      phase: 'signed-in',
      authenticated: true,
      open: false,
    });
    expect(f.counts().started).toBe(1);
  });

  it('does not adopt a pre-existing cloud library until explicitly accepted', async () => {
    const f = setup();
    f.setJoin();
    f.auth.showSignIn();
    const email = f.auth.submitEmail('dev@example.com');
    await f.tick();
    f.otp();
    await email;
    const code = f.auth.submitCode('123456');
    f.success();
    await code;
    expect(f.auth.state).toMatchObject({
      phase: 'syncing',
      open: true,
      join: { localNotes: 2, cloudNotes: 3 },
    });
    await f.auth.acceptCloud();
    expect(f.auth.state).toMatchObject({
      phase: 'signed-in',
      open: false,
      join: null,
    });
  });

  it('settles cancellation before a new attempt and ignores late completion', async () => {
    const f = setup();
    f.auth.showSignIn();
    const first = f.auth.submitEmail('dev@example.com');
    await f.tick();
    f.otp();
    await first;
    f.auth.dismiss();
    await f.tick();
    expect(f.auth.state).toMatchObject({ open: false, authenticated: false });
    expect(f.counts().cancelled).toBe(1);
    f.auth.showSignIn();
    const next = f.auth.submitEmail('dev@example.com');
    await f.tick();
    f.otp();
    await next;
    expect(f.auth.state.phase).toBe('code');
    expect(f.counts().finishCount).toBe(0);
  });

  it('keeps authenticated state if preserving notes during sign-out fails', async () => {
    const host: AuthHost = {
      configured: true,
      accountExists: async () => true,
      prepareSignIn: async () => {
        throw Error('Unused');
      },
      cancelSignIn: async () => {},
      finishSignIn: async () => null,
      acceptCloud: async () => {},
      signOut: async () => {
        throw Error('Storage full');
      },
    };
    const auth = new CloudAuthController(host, true);
    await auth.signOut();
    expect(auth.state).toMatchObject({
      phase: 'signed-in',
      authenticated: true,
      error: 'Storage full',
    });
  });

  it('allows retrying interrupted cleanup instead of permanently disabling sign-in', async () => {
    let fail = true;
    const f = setup();
    // The session keeps its durable cleanup marker on failure, and must get
    // another opportunity to finish it before a new login can start.
    f.host.cancelSignIn = async () => {
      if (fail) throw Error('Offline cleanup');
    };
    f.auth.showSignIn();
    const email = f.auth.submitEmail('dev@example.com');
    await f.tick();
    f.otp();
    await email;
    f.auth.dismiss();
    await f.tick();
    fail = false;
    f.auth.showSignIn();
    const retry = f.auth.submitEmail('dev@example.com');
    await f.tick();
    f.otp();
    await retry;
    expect(f.auth.state.phase).toBe('code');
    expect(f.counts().started).toBe(2);
  });

  it('explicitly restarts a code challenge with login-only intent and the retained email', async () => {
    const f = setup();
    f.auth.showSignIn();
    const first = f.auth.submitEmail('dev@example.com');
    await f.tick();
    f.otp();
    await first;
    f.auth.restartSignIn();
    expect(f.auth.state).toMatchObject({
      phase: 'email',
      email: 'dev@example.com',
      open: true,
    });
    const second = f.auth.submitEmail('dev@example.com');
    await f.tick();
    f.otp();
    await second;
    expect(f.hints).toEqual([
      { email: 'dev@example.com', grant_type: 'otp', intent: 'login' },
      { email: 'dev@example.com', grant_type: 'otp', intent: 'login' },
    ]);
  });

  it('cancels an OTP prompt arriving after Close while its email request was in flight', async () => {
    const f = setup();
    f.auth.showSignIn();
    const email = f.auth.submitEmail('dev@example.com');
    await f.tick();
    f.auth.dismiss();
    f.otp();
    await email;
    await f.tick();
    expect(f.counts().cancelled).toBe(1);
    f.auth.showSignIn();
    const next = f.auth.submitEmail('next@example.com');
    await f.tick();
    expect(f.counts().started).toBe(2);
    f.otp();
    await next;
    expect(f.auth.state).toMatchObject({
      phase: 'code',
      email: 'next@example.com',
    });
  });

  it('settles a stale email submission waiting on cleanup without starting it in a newer modal', async () => {
    const f = setup();
    let release!: () => void;
    f.host.cancelSignIn = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    f.auth.showSignIn();
    const first = f.auth.submitEmail('first@example.com');
    await f.tick();
    f.otp();
    await first;
    f.auth.dismiss();
    await f.tick();
    f.auth.showSignIn();
    const stale = f.auth.submitEmail('stale@example.com');
    await f.tick();
    f.auth.restartSignIn();
    const latest = f.auth.submitEmail('latest@example.com');
    await f.tick();
    release();
    await f.tick();
    expect(f.hints).toEqual([
      { email: 'first@example.com', grant_type: 'otp', intent: 'login' },
      { email: 'latest@example.com', grant_type: 'otp', intent: 'login' },
    ]);
    await stale;
    f.otp();
    await latest;
    expect(f.auth.state).toMatchObject({
      phase: 'code',
      email: 'latest@example.com',
    });
  });

  it('retains pending-sync retry ownership when the sign-out preservation barrier fails', async () => {
    const f = setup();
    f.setFailFinish(true);
    f.auth.showSignIn();
    const email = f.auth.submitEmail('dev@example.com');
    await f.tick();
    f.otp();
    await email;
    const code = f.auth.submitCode('123456');
    f.success();
    await code;
    f.host.signOut = async () => {
      throw Error('Storage full');
    };
    await f.auth.signOut();
    expect(f.auth.state).toMatchObject({
      phase: 'syncing',
      open: true,
      authenticated: true,
      error: 'Storage full',
    });
    f.setFailFinish(false);
    await f.auth.retrySync();
    expect(f.auth.state).toMatchObject({ phase: 'signed-in', open: false });
    expect(f.counts().finishCount).toBe(2);
  });

  it('rejects an unlisted account before opening Dexie authentication or sending a code', async () => {
    const f = setup();
    f.host.accountExists = async () => false;
    f.auth.showSignIn();
    const pending = f.auth.submitEmail('unknown@example.invalid');
    await f.tick();
    expect(f.auth.state).toMatchObject({
      phase: 'email',
      error: 'That account does not exist. Sign-up is coming soon.',
    });
    expect(f.hints).toHaveLength(0);
    await pending;
  });

  it('retains email and blocks OTP when the account endpoint fails', async () => {
    const f = setup();
    f.host.accountExists = async () => {
      throw Error('Account check failed. Try again later.');
    };
    f.auth.showSignIn();
    const pending = f.auth.submitEmail('dev@example.com');
    await f.tick();
    expect(f.auth.state).toMatchObject({
      phase: 'email',
      email: 'dev@example.com',
      error: 'Account check failed. Try again later.',
    });
    expect(f.hints).toHaveLength(0);
    await pending;
  });

  it('cannot let a late account-check response change a newer login', async () => {
    const f = setup();
    let release!: (allowed: boolean) => void;
    f.host.accountExists = (email) =>
      email === 'old@example.invalid'
        ? new Promise((resolve) => {
            release = resolve;
          })
        : Promise.resolve(true);
    f.auth.showSignIn();
    const old = f.auth.submitEmail('old@example.invalid');
    await f.tick();
    f.auth.dismiss();
    f.auth.showSignIn();
    const current = f.auth.submitEmail('dev@example.com');
    await f.tick();
    f.otp();
    await current;
    release(false);
    await old;
    expect(f.auth.state).toMatchObject({
      phase: 'code',
      email: 'dev@example.com',
      error: null,
    });
    expect(f.hints).toHaveLength(1);
  });
});
