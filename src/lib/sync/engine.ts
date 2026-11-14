import { uuid } from '../domain/validation';
import {
  canonicalJson,
  digest,
  preservePendingIntent,
  orderedIntents,
  type PendingIntent,
} from './intents';
import { liveQuery } from 'dexie';
import type { ScratchtreeDatabase } from './database';
import type { DexieRepository } from './repository';
import type { BackupFiles } from '../platform/backup-files';
import type { SyncPort, SyncState } from './service-types';
import {
  classifyOutcome,
  readRemoteRow,
  readRemoteOutcome,
  readRemoteLibrary,
  readRemoteEpoch,
  sharedKey,
  type SharedEnvelope,
  type RemoteLibrary,
} from './confirmation';
import {
  rawRecovery,
  rawViewValid,
  resolveIntent,
  cleanupResolvedWitness,
  recoveryChunks,
} from './recovery';
export interface SyncEngineOptions {
  db: ScratchtreeDatabase;
  repository: DexieRepository;
  files: BackupFiles;
  serialize: <T>(work: () => Promise<T>) => Promise<T>;
  onInvalidation: () => void | Promise<void>;
  fetch?: typeof fetch;
  now?: () => number;
  turnTimeoutMs?: number;
}
/** Session owns credentials, transport, the shared lifecycle queue, and database lifetime. */
export class SyncEngine implements SyncPort {
  private state: SyncState = {
    state: 'local-only',
    lastConfirmed: null,
    detail: null,
    recoveries: 0,
  };
  private listeners = new Set<(state: SyncState) => void>();
  private subscriptions: (() => void)[] = [];
  private closed = false;
  private scheduled = false;
  private rerun = false;
  private started = false;
  private baseline = false;
  private baselineEpoch: string | null = null;
  private baselineShared: SharedEnvelope | null = null;
  private active: AbortController | null = null;
  private generation = 0;
  private scanAfter = 0;
  private cleanupAfter = '';
  constructor(private options: SyncEngineOptions) {}
  subscribe(listener: (s: SyncState) => void) {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private patch(value: Partial<SyncState>) {
    if (this.closed) return;
    this.state = { ...this.state, ...value };
    for (const listener of this.listeners) listener(this.state);
  }
  start() {
    if (this.started || this.closed) return;
    this.started = true;
    this.subscriptions.push(
      this.options.repository.subscribeInvalidation(() => {
        this.invalidate();
        this.schedule();
      }),
    );
    const changes = liveQuery(() =>
      Promise.all([
        this.options.db.pending.toArray(),
        this.options.db.recovery.toArray(),
      ]),
    ).subscribe({
      next: () => this.schedule(),
      error: () =>
        this.patch({
          state: 'needs-sync',
          detail: 'Local sync state needs retry.',
        }),
    });
    this.subscriptions.push(() => changes.unsubscribe());
    if (this.options.db.cloudEnabled) {
      const a = this.options.db.cloud.events.syncComplete.subscribe(() =>
        this.schedule(),
      );
      const b = this.options.db.cloud.syncState.subscribe(() =>
        this.schedule(),
      );
      const c = this.options.db.cloud.webSocketStatus.subscribe(() =>
        this.schedule(),
      );
      this.subscriptions.push(
        () => a.unsubscribe(),
        () => b.unsubscribe(),
        () => c.unsubscribe(),
      );
    }
    this.schedule();
  }
  private invalidate() {
    if (this.closed) return;
    try {
      void Promise.resolve(this.options.onInvalidation()).catch(() =>
        this.patch({ state: 'needs-sync', detail: 'Remote notes need retry.' }),
      );
    } catch {
      this.patch({ state: 'needs-sync', detail: 'Remote notes need retry.' });
    }
  }
  private schedule() {
    if (this.closed) return;
    if (this.scheduled) {
      this.rerun = true;
      return;
    }
    this.scheduled = true;
    this.rerun = false;
    let more = false;
    void this.options
      .serialize(() => this.confirm())
      .then((value) => {
        more = value;
      })
      .catch(() =>
        this.patch({
          state: 'needs-sync',
          detail: 'Server confirmation needs retry.',
        }),
      )
      .finally(() => {
        this.scheduled = false;
        if (!this.closed && (more || this.rerun)) this.schedule();
      });
  }
  close() {
    this.closed = true;
    this.generation++;
    this.active?.abort();
    this.rerun = false;
    for (const unsubscribe of this.subscriptions) unsubscribe();
    this.subscriptions = [];
    this.listeners.clear();
  }
  retry() {
    return this.options
      .serialize(() => this.confirm())
      .then((more) => {
        if (more) this.schedule();
      });
  }
  private async confirm(): Promise<boolean> {
    if (this.closed) return false;
    const controller = new AbortController(),
      generation = ++this.generation;
    this.active = controller;
    const duration = Math.min(
      10000,
      Math.max(1, this.options.turnTimeoutMs ?? 10000),
    );
    const timer = setTimeout(() => controller.abort(), duration);
    try {
      const more = await this.confirmTurn(controller.signal);
      if (controller.signal.aborted && !this.closed) {
        this.patch({
          state: 'needs-sync',
          detail: 'Server confirmation timed out. Your work is retained.',
        });
        return false;
      }
      return (
        !controller.signal.aborted &&
        !this.closed &&
        generation === this.generation &&
        more === true
      );
    } catch {
      if (!this.closed)
        this.patch({
          state: 'needs-sync',
          detail: 'Server confirmation needs retry. Your work is retained.',
        });
      return false;
    } finally {
      clearTimeout(timer);
      if (this.active === controller) this.active = null;
    }
  }
  private async confirmTurn(signal: AbortSignal) {
    const { db, repository } = this.options;
    if (this.closed) return;
    const recoveries = await db.recovery.count();
    let local: Awaited<ReturnType<typeof rawViewValid>>;
    try {
      local = await rawViewValid(db, repository.libraryId);
      this.patch({ overflow: undefined });
    } catch {
      if (this.closed || signal.aborted) return false;
      const raw = await rawRecovery(db, repository.libraryId);
      this.patch({
        state: 'needs-sync',
        detail:
          'The merged library needs recovery. Export all raw notes before making corrections.',
        recoveries,
        overflow: { items: raw.notes.length },
      });
      return;
    }
    if (this.closed || signal.aborted) return false;
    if (!db.cloudEnabled) {
      this.patch({ state: 'local-only', detail: null, recoveries });
      return;
    }
    const currentEpoch = await repository.readCurrentEpoch();
    if (this.baselineEpoch !== currentEpoch) this.baseline = false;
    const user = db.cloud.currentUser.getValue(),
      databaseUrl = db.cloud.options?.databaseUrl;
    if (
      !user.isLoggedIn ||
      !user.accessToken ||
      !user.accessTokenExpiration ||
      !Number.isFinite(+user.accessTokenExpiration) ||
      +user.accessTokenExpiration <= (this.options.now?.() ?? Date.now()) ||
      !databaseUrl
    ) {
      this.patch({
        state: 'needs-sync',
        detail: 'Sign in to confirm shared notes.',
        recoveries,
      });
      return;
    }
    this.patch({ state: 'syncing', detail: null, recoveries });
    const options = {
      databaseUrl,
      token: user.accessToken,
      fetch: this.options.fetch,
      signal,
    };
    try {
      if (
        (await readRemoteEpoch(options, repository.libraryId)) !== currentEpoch
      )
        this.baseline = false;
      let proof = this.baseline ? this.baselineShared : null;
      let serverView: RemoteLibrary | null = null;
      const ordered = orderedIntents(await db.pending.toArray()).filter(
        (p) => p.localApplied,
      );
      let unvisited = ordered.filter((p) => p.sequence > this.scanAfter);
      if (!unvisited.length) {
        this.scanAfter = 0;
        unvisited = ordered;
      }
      const pending = unvisited.slice(0, 8);
      let more = unvisited.length > pending.length;
      for (const p of pending) {
        if (this.closed || signal.aborted) return false;
        if (!p.localApplied) continue;
        const witness = await readRemoteRow(options, 'witnesses', p.id);
        const remote = await readRemoteOutcome(
          { ...options, libraryId: repository.libraryId, epoch: p.epoch },
          p,
        );
        const result = await classifyOutcome(p, witness, remote);
        if (remote.shared) {
          serverView = remote;
          this.baseline = false;
          proof = null;
        }
        // A complete view is evidence only until a later observation contradicts it.
        if (remote.observed && serverView?.shared) {
          const observed = remote.observed,
            cached = serverView.shared;
          if (
            canonicalJson(
              cached.notes.find((row) => row.id === observed.id) ?? null,
            ) !== canonicalJson(observed.note) ||
            canonicalJson(
              cached.purges.find((row) => row.id === observed.id) ?? null,
            ) !== canonicalJson(observed.purge)
          )
            serverView = null;
        }
        if (result === 'superseded') {
          this.baseline = false;
          proof = null;
          serverView = null;
        } else if (result === 'matching' && remote.observed && proof) {
          const observed = remote.observed,
            target = local.shared.notes.find((row) => row.id === observed.id),
            purge =
              local.shared.purges.find((row) => row.id === observed.id) ?? null;
          if (
            target &&
            proof.notes.some((row) => row.id === observed.id) &&
            canonicalJson(target) === canonicalJson(observed.note) &&
            canonicalJson(purge) === canonicalJson(observed.purge)
          )
            proof = {
              ...proof,
              notes: proof.notes.map((row) =>
                row.id === observed.id ? target : row,
              ),
            };
          else {
            this.baseline = false;
            proof = null;
            serverView = null;
          }
        }
        if (this.closed || signal.aborted) return false;
        await resolveIntent(db, p, result, signal);
      }
      this.scanAfter = more ? (pending.at(-1)?.sequence ?? this.scanAfter) : 0;
      // The queue is yielded after eight intents and eight exact receipt attempts.
      const receipts = await db.device
        .where('key')
        .startsWith('resolved-witness:')
        .toArray();
      let available = receipts.filter((row) => row.key > this.cleanupAfter);
      if (!available.length) {
        this.cleanupAfter = '';
        available = receipts;
      }
      const cleanup = available.slice(0, 8);
      const moreCleanup = available.length > cleanup.length;
      more = more || moreCleanup;
      for (const row of cleanup) {
        if (this.closed || signal.aborted) return false;
        const value = row.value as { id?: unknown };
        if (typeof value.id !== 'string' || (await db.pending.get(value.id)))
          continue;
        try {
          const remote = await readRemoteRow(options, 'witnesses', value.id);
          if (this.closed || signal.aborted) return false;
          await cleanupResolvedWitness(db, value.id, remote, signal);
        } catch {
          if (signal.aborted)
            throw new Error(
              'Server confirmation was stopped.',
            ); /* A cleanup failure cannot revoke an earlier durable source acknowledgment. */
        }
      }
      this.cleanupAfter = moreCleanup
        ? (cleanup.at(-1)?.key ?? this.cleanupAfter)
        : '';
      let final = await rawViewValid(db, repository.libraryId);
      let evidenced = !!(
        this.baseline &&
        proof &&
        this.baselineEpoch === final.shared.epoch &&
        sharedKey(proof) === sharedKey(final.shared)
      );
      if (!evidenced) {
        const remote =
          serverView ??
          (await readRemoteLibrary({
            ...options,
            libraryId: repository.libraryId,
            epoch: final.shared.epoch,
          }));
        final = await rawViewValid(db, repository.libraryId);
        evidenced = !!(
          remote.shared &&
          remote.epoch === final.shared.epoch &&
          sharedKey(remote.shared) === sharedKey(final.shared) &&
          canonicalJson(remote.items) === canonicalJson(final.items) &&
          canonicalJson(remote.purgedIds) === canonicalJson(final.purgedIds)
        );
      }
      this.baseline = evidenced;
      this.baselineShared = evidenced ? final.shared : null;
      this.baselineEpoch = evidenced ? final.shared.epoch : null;
      const remaining = final.pendingCount;
      if (this.closed || signal.aborted) return false;
      this.patch({
        state: remaining || !this.baseline ? 'needs-sync' : 'up-to-date',
        detail:
          remaining || !this.baseline
            ? 'Some changes are awaiting server confirmation.'
            : final.recoveries
              ? 'Alternative input is retained in recovery.'
              : null,
        recoveries: final.recoveries,
        ...(!remaining && this.baseline
          ? { lastConfirmed: this.options.now?.() ?? Date.now() }
          : {}),
      });
      return more;
    } catch {
      if (this.closed) return false;
      this.patch({
        state: 'needs-sync',
        detail:
          'Server confirmation or the merged library needs retry. Your work is retained.',
        recoveries: await db.recovery.count(),
      });
      return false;
    }
  }
  async inspectOverflow() {
    return this.options.serialize(async () => {
      const raw = await rawRecovery(
        this.options.db,
        this.options.repository.libraryId,
      );
      let overflow = false;
      try {
        await rawViewValid(this.options.db, this.options.repository.libraryId);
      } catch {
        overflow = true;
      }
      return {
        epoch: raw.epoch,
        overflow,
        rows: raw.notes.flatMap((value) => {
          if (!value || typeof value !== 'object') return [];
          const row = value as { id?: unknown; markdown?: unknown };
          return uuid(row.id) && typeof row.markdown === 'string'
            ? [{ id: row.id, markdown: row.markdown }]
            : [];
        }),
      };
    });
  }
  async purgeOverflow(request: { epoch: string; ids: string[] }) {
    const captured = structuredClone(request);
    await this.options.serialize(async () => {
      const { db, repository } = this.options;
      if (this.closed) throw new Error('Sync is closed.');
      try {
        await rawViewValid(db, repository.libraryId);
        throw new Error('The library is valid. Use normal deletion.');
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === 'The library is valid. Use normal deletion.'
        )
          throw error;
      }
      if (
        !captured.ids.length ||
        captured.ids.some((id) => !uuid(id)) ||
        new Set(captured.ids).size !== captured.ids.length
      )
        throw new Error('Select exact recovery notes.');
      const raw = await rawRecovery(db, repository.libraryId);
      const available = new Set(
        raw.notes.map((value) => (value as { id: string }).id),
      );
      if (
        raw.epoch !== captured.epoch ||
        captured.ids.some((id) => !available.has(id))
      )
        throw new Error('The recovery selection changed.');
      const command = {
        kind: 'correctivePurge' as const,
        epoch: captured.epoch,
        ids: captured.ids,
      };
      const expected = { items: [], orders: [], purgedIds: captured.ids };
      const fingerprint = await digest({ epoch: captured.epoch, command });
      const existing = (
        await db.pending.where('fingerprint').equals(fingerprint).toArray()
      )[0];
      const intent: PendingIntent = existing ?? {
        id: crypto.randomUUID(),
        epoch: captured.epoch,
        fingerprint,
        digest: await digest({ command, expected }),
        recordedAt: Date.now(),
        command,
        expected,
        localApplied: false,
        sequence: 0,
      };
      // Preservation is committed separately before any replicated mutation.
      await preservePendingIntent(db, intent);
      await db.transaction(
        'rw',
        [db.libraries, db.notes, db.purges, db.witnesses, db.pending],
        async () => {
          if (
            (await db.libraries.get(repository.libraryId))?.epoch !==
            captured.epoch
          )
            throw new Error('The library was replaced.');
          for (const id of captured.ids) {
            if (!(await db.notes.get([captured.epoch, id])))
              throw new Error('The recovery selection changed.');
          }
          for (const id of captured.ids) {
            await db.notes.delete([captured.epoch, id]);
            await db.purges.put({
              id,
              epoch: captured.epoch,
              purgedAt: intent.recordedAt,
            });
          }
          await db.witnesses.put({
            id: intent.id,
            epoch: intent.epoch,
            digest: intent.digest,
            recordedAt: intent.recordedAt,
          });
          await db.pending.update(intent.id, { localApplied: true });
        },
      );
    });
    this.invalidate();
    this.schedule();
  }
  async exportRecovery() {
    await this.options.serialize(async () => {
      if (this.closed) return;
      const raw = await rawRecovery(
        this.options.db,
        this.options.repository.libraryId,
      );
      if (this.options.files.chooseRecoveryWrite) {
        await this.options.files.chooseRecoveryWrite(recoveryChunks(raw));
        return;
      }
      let text = '';
      let bytes = 0;
      for await (const chunk of recoveryChunks(raw)) {
        bytes += new TextEncoder().encode(chunk).length;
        if (bytes > 10 * 1024 * 1024)
          throw new Error(
            'This raw recovery needs the dedicated recovery file writer. Your rows are retained.',
          );
        text += chunk;
      }
      await this.options.files.chooseWrite(text);
    });
  }
}
