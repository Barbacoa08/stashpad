<script lang="ts">
  import type { SyncPort, SyncState } from '../sync/service-types';
  import Icon from './Icon.svelte';
  import RecoveryDialog from './RecoveryDialog.svelte';
  import { tick, onDestroy } from 'svelte';
  let {
    sync,
    value,
    onattentionchange = () => {},
    onmodalchange = () => {},
  }: {
    sync: SyncPort;
    value: SyncState;
    onattentionchange?: (active: boolean) => void;
    onmodalchange?: (active: boolean) => void;
  } = $props();
  let alive = true;
  let expanded = $state(false);
  let busy = $state(false);
  let error = $state('');
  let toggle = $state<HTMLButtonElement>();
  let inspection = $state<Awaited<
    ReturnType<NonNullable<SyncPort['inspectOverflow']>>
  > | null>(null);
  $effect(() => onattentionchange(expanded || busy || !!error || !!inspection));
  onDestroy(() => {
    alive = false;
    onattentionchange(false);
    onmodalchange(false);
  });
  async function perform(action: () => Promise<void>) {
    if (busy) return;
    busy = true;
    error = '';
    try {
      await action();
    } catch (cause) {
      error =
        cause instanceof Error
          ? cause.message
          : 'The operation could not finish. Please try again.';
    } finally {
      busy = false;
    }
  }
  function closeRecovery() {
    if (busy) return;
    inspection = null;
    onmodalchange(false);
    error = '';
    void tick().then(() => {
      if (alive && !inspection) toggle?.focus();
    });
  }
  async function removeRaw(request: { epoch: string; ids: string[] }) {
    await perform(async () => {
      if (!sync.purgeOverflow || !sync.inspectOverflow) return;
      await sync.purgeOverflow(structuredClone(request));
      inspection = await sync.inspectOverflow();
    });
  }
  const labels = {
    'local-only': 'Local only',
    'needs-sync': 'Needs sync',
    syncing: 'Syncing',
    'up-to-date': 'Up to date',
  };
</script>

<div class="sync-status">
  <button
    class="sync-status-toggle"
    bind:this={toggle}
    aria-expanded={expanded}
    onclick={() => (expanded = !expanded)}
    ><Icon
      name={value.state === 'local-only'
        ? 'monitor'
        : value.state === 'needs-sync'
          ? 'warning'
          : value.state === 'syncing'
            ? 'sync'
            : 'check'}
    /><span aria-live="polite">{labels[value.state]}</span></button
  >
  {#if expanded}
    <div class="sync-status-details">
      <p>
        {value.lastConfirmed === null
          ? 'No sync confirmed yet.'
          : `Last confirmed: ${new Date(value.lastConfirmed).toLocaleString()}`}
      </p>
      {#if value.detail}<p>{value.detail}</p>{/if}
      {#if value.state === 'needs-sync'}<button
          disabled={busy}
          onclick={() => void perform(() => sync.retry())}>Retry sync</button
        >{/if}
      {#if value.recoveries > 0}<p>
          {value.recoveries} recovery {value.recoveries === 1
            ? 'item'
            : 'items'}
        </p>
      {/if}
      {#if value.recoveries > 0 || value.overflow}<button
          disabled={busy}
          onclick={() => void perform(() => sync.exportRecovery())}
          >Export recovery</button
        >{/if}
      {#if value.overflow && sync.inspectOverflow && sync.purgeOverflow}<button
          disabled={busy}
          onclick={() =>
            void perform(async () => {
              const result = await sync.inspectOverflow!();
              if (!alive) return;
              onmodalchange(true);
              inspection = result;
            })}>Review raw notes</button
        >{/if}
      {#if error && !inspection}<p role="alert">{error}</p>{/if}
    </div>
  {/if}
</div>

{#if inspection}<RecoveryDialog
    {inspection}
    pending={busy}
    {error}
    onremove={(request) => void removeRaw(request)}
    onclose={closeRecovery}
  />{/if}
