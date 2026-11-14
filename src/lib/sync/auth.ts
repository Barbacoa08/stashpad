import type Dexie from 'dexie';
import type { DXCUserInteraction } from 'dexie-cloud-addon';
import type { AuthPort, AuthState } from './service-types';

/** Only documented, public addon authentication surfaces are used here. */
export type CloudLogin = Pick<Dexie['cloud'], 'login'> & {
  currentUser: Pick<Dexie['cloud']['currentUser'], 'getValue'>;
  userInteraction: {
    subscribe(listener: (prompt: DXCUserInteraction | undefined) => void): {
      unsubscribe(): void;
    };
  };
};
type Join = NonNullable<AuthState['join']>;
/** The session owns durable data, account binding, transport, and lifecycle serialization. */
export interface AuthHost {
  configured: boolean;
  prepareSignIn(): Promise<CloudLogin>;
  cancelSignIn(): Promise<void>;
  finishSignIn(): Promise<Join | null>;
  acceptCloud(): Promise<void>;
  signOut(): Promise<void>;
}
type Attempt = {
  generation: number;
  cancelled: boolean;
  prompt?: DXCUserInteraction;
  login?: Promise<void>;
  start?: Promise<void>;
  unsubscribe?: () => void;
  waiters: Set<() => void>;
  promptError: boolean;
};
const unknownAccount = 'That account does not exist. Sign-up is coming soon.';
const message = (error: unknown) =>
  error instanceof Error ? error.message : 'Sign-in failed. Please try again.';

/** One OTP attempt at a time; a provider retry never silently drops login-only intent. */
export class CloudAuthController implements AuthPort {
  state: AuthState;
  private listeners = new Set<(state: AuthState) => void>();
  private attempt?: Attempt;
  private cleanup: Promise<void> = Promise.resolve();
  private finishing = false;
  private generation = 0;
  constructor(
    private host: AuthHost,
    authenticated = false,
  ) {
    this.state = {
      phase: authenticated ? 'signed-in' : 'signed-out',
      authenticated,
      configured: host.configured,
      open: false,
      email: '',
      error: null,
      canCancel: true,
      join: null,
    };
  }
  subscribe(listener: (state: AuthState) => void) {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private patch(patch: Partial<AuthState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }
  private current(attempt: Attempt) {
    return (
      this.attempt === attempt &&
      !attempt.cancelled &&
      attempt.generation === this.generation
    );
  }
  private settle(attempt: Attempt) {
    for (const resolve of attempt.waiters) resolve();
    attempt.waiters.clear();
  }
  private wait(attempt: Attempt) {
    return new Promise<void>((resolve) => attempt.waiters.add(resolve));
  }
  private cancelPrompt(attempt: Attempt) {
    const prompt = attempt.prompt;
    attempt.prompt = undefined;
    prompt?.onCancel();
  }
  showSignIn() {
    if (!this.state.configured || this.state.authenticated || this.state.open)
      return;
    this.generation++;
    this.patch({ open: true, phase: 'email', error: null, canCancel: true });
  }
  private cancelAttempt() {
    const attempt = this.attempt;
    if (!attempt) return this.cleanup;
    if (attempt.cancelled) {
      // A failed cleanup remains the session's durable responsibility. A fresh
      // user attempt explicitly retries it before opening another login flow.
      this.cleanup = this.cleanup.catch(() => this.host.cancelSignIn());
      return this.cleanup;
    }
    attempt.cancelled = true;
    this.cancelPrompt(attempt);
    this.settle(attempt);
    this.cleanup = this.cleanup.then(async () => {
      await attempt.start;
      this.cancelPrompt(attempt);
      await attempt.login;
      attempt.unsubscribe?.();
      await this.host.cancelSignIn();
    });
    return this.cleanup;
  }
  dismiss() {
    if (!this.state.canCancel) return;
    if (!this.state.authenticated) {
      const generation = ++this.generation;
      void this.cancelAttempt().catch((error) => {
        if (generation === this.generation)
          this.patch({ error: message(error) });
      });
      this.patch({ phase: 'signed-out' });
    }
    this.patch({ open: false });
  }
  restartSignIn() {
    if (!this.state.canCancel || this.state.authenticated) return;
    const generation = ++this.generation;
    void this.cancelAttempt().catch((error) => {
      if (generation === this.generation) this.patch({ error: message(error) });
    });
    this.patch({ phase: 'email', open: true, error: null, canCancel: true });
  }
  async submitEmail(email: string) {
    email = email.trim();
    if (
      this.state.phase !== 'email' ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    )
      return;
    const generation = ++this.generation;
    this.patch({ phase: 'sending-code', email, error: null, canCancel: true });
    try {
      await this.cancelAttempt();
    } catch (error) {
      if (generation === this.generation)
        this.patch({ phase: 'email', error: message(error) });
      return;
    }
    if (generation !== this.generation || !this.state.open) return;
    const attempt: Attempt = {
      generation,
      cancelled: false,
      waiters: new Set(),
      promptError: false,
    };
    this.attempt = attempt;
    const ready = this.wait(attempt);
    attempt.start = (async () => {
      try {
        const api = await this.host.prepareSignIn();
        if (!this.current(attempt)) {
          this.settle(attempt);
          return;
        }
        if (api.currentUser.getValue().isLoggedIn)
          throw new Error(
            'Finish the previous sign-out before signing in again.',
          );
        const subscription = api.userInteraction.subscribe((prompt) => {
          if (!prompt) return;
          if (this.current(attempt)) this.prompt(attempt, prompt);
          else prompt.onCancel();
        });
        attempt.unsubscribe = () => subscription.unsubscribe();
        attempt.login = api
          .login({ email, grant_type: 'otp', intent: 'login' })
          .then(async () => {
            if (!this.current(attempt)) return;
            if (!api.currentUser.getValue().isLoggedIn)
              throw new Error(
                'Authentication was not completed. Send a new code.',
              );
            this.patch({
              phase: 'syncing',
              authenticated: true,
              error: null,
              canCancel: true,
            });
            await this.finish(attempt);
          })
          .catch((error) => {
            if (this.current(attempt) && !attempt.promptError)
              this.patch({
                phase: 'email',
                error: message(error),
                canCancel: true,
              });
          })
          .finally(() => {
            attempt.unsubscribe?.();
            this.settle(attempt);
          });
      } catch (error) {
        attempt.unsubscribe?.();
        if (this.current(attempt))
          this.patch({
            phase: 'email',
            error: message(error),
            canCancel: true,
          });
        this.settle(attempt);
      }
    })();
    await ready;
  }
  private prompt(attempt: Attempt, prompt: DXCUserInteraction) {
    const codes = new Set(prompt.alerts.map((alert) => alert.messageCode));
    attempt.prompt = prompt;
    if (codes.has('USER_NOT_REGISTERED') || codes.has('USER_NOT_ACCEPTED')) {
      attempt.promptError = true;
      this.patch({ phase: 'email', error: unknownAccount, canCancel: true });
      this.cancelPrompt(attempt);
      this.settle(attempt);
      return;
    }
    if (
      prompt.type === 'otp' &&
      (codes.has('OTP_SENT') || codes.has('INVALID_OTP'))
    ) {
      this.patch({
        phase: 'code',
        canCancel: true,
        error: codes.has('INVALID_OTP')
          ? 'That code is invalid or expired. Try again.'
          : null,
      });
      this.settle(attempt);
      return;
    }
    // An unexpected provider prompt cannot be safely resubmitted as an OTP challenge.
    attempt.promptError = true;
    this.patch({
      phase: 'email',
      error: 'Sign-in could not finish. Send a new code.',
      canCancel: true,
    });
    this.cancelPrompt(attempt);
    this.settle(attempt);
  }
  async submitCode(code: string) {
    const attempt = this.attempt;
    if (
      !attempt ||
      !this.current(attempt) ||
      this.state.phase !== 'code' ||
      !code.trim() ||
      attempt.prompt?.type !== 'otp'
    )
      return;
    const ready = this.wait(attempt);
    this.patch({ phase: 'verifying', error: null, canCancel: false });
    attempt.prompt.onSubmit({ otp: code.trim() });
    await ready;
  }
  private async finish(attempt?: Attempt) {
    if (this.finishing) return;
    this.finishing = true;
    try {
      const join = await this.host.finishSignIn();
      if (attempt && !this.current(attempt)) return;
      if (join)
        this.patch({ join, phase: 'syncing', error: null, canCancel: true });
      else
        this.patch({
          join: null,
          phase: 'signed-in',
          authenticated: true,
          open: false,
          error: null,
          canCancel: true,
        });
    } catch (error) {
      if (!attempt || this.current(attempt))
        this.patch({
          phase: 'syncing',
          error: message(error),
          canCancel: true,
        });
    } finally {
      this.finishing = false;
    }
  }
  async retrySync() {
    if (
      !this.state.authenticated ||
      this.finishing ||
      this.state.phase !== 'syncing' ||
      this.state.join
    )
      return;
    this.patch({ error: null });
    await this.finish(this.attempt);
  }
  async acceptCloud() {
    if (!this.state.join || this.finishing) return;
    this.finishing = true;
    this.patch({ canCancel: false, error: null });
    try {
      await this.host.acceptCloud();
      this.patch({
        phase: 'signed-in',
        open: false,
        join: null,
        authenticated: true,
        canCancel: true,
      });
    } catch (error) {
      this.patch({ error: message(error), canCancel: true });
    } finally {
      this.finishing = false;
    }
  }
  async signOut() {
    if (
      !this.state.authenticated ||
      this.state.phase === 'signing-out' ||
      !this.state.canCancel ||
      this.finishing
    )
      return;
    const previous = this.state;
    this.patch({ phase: 'signing-out', error: null, canCancel: false });
    try {
      await this.host.signOut();
      this.generation++;
      if (this.attempt) {
        this.attempt.cancelled = true;
        this.settle(this.attempt);
      }
      this.patch({
        phase: 'signed-out',
        authenticated: false,
        open: false,
        join: null,
        canCancel: true,
      });
    } catch (error) {
      this.patch({ ...previous, error: message(error) });
    }
  }
}
