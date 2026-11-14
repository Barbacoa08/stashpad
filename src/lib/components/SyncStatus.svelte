<script lang="ts">
  import type { SyncPort, SyncState } from '../sync/service-types';
  import Icon from './Icon.svelte';
  let { sync, value }: { sync: SyncPort; value: SyncState } = $props();
  let expanded = $state(false);
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
          onclick={() => void sync.retry()}>Retry sync</button
        >{/if}
      {#if value.recoveries > 0}<p>
          {value.recoveries} recovery {value.recoveries === 1
            ? 'item'
            : 'items'}
        </p>
        <button onclick={() => void sync.exportRecovery()}
          >Export recovery</button
        >{/if}
    </div>
  {/if}
</div>
