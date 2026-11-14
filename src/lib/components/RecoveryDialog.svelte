<script lang="ts">
  import { tick } from 'svelte';
  type Inspection = {
    epoch: string;
    overflow: boolean;
    rows: { id: string; markdown: string }[];
  };
  let {
    inspection,
    pending,
    error,
    onremove,
    onclose,
  }: {
    inspection: Inspection;
    pending: boolean;
    error: string;
    onremove: (request: { epoch: string; ids: string[] }) => void;
    onclose: () => void;
  } = $props();
  let dialog: HTMLDialogElement;
  let selectionEpoch: string | undefined;
  let selected = $state<string[]>([]);
  let page = $state(0);
  let inspected = $state<string | null>(null);
  let status = $state<HTMLElement>();
  const pageSize = 50;
  let pages = $derived(
    Math.max(1, Math.ceil(inspection.rows.length / pageSize)),
  );
  let visible = $derived(
    inspection.rows.slice(
      Math.min(page, pages - 1) * pageSize,
      (Math.min(page, pages - 1) + 1) * pageSize,
    ),
  );
  let available = $derived(new Set(inspection.rows.map((row) => row.id)));
  let chosen = $derived(selected.filter((id) => available.has(id)));
  $effect(() => {
    if (inspection.epoch !== selectionEpoch) {
      selectionEpoch = inspection.epoch;
      selected = [];
      inspected = null;
      page = 0;
    }
  });
  function mount(node: HTMLDialogElement) {
    dialog = node;
    node.showModal();
    return { destroy: () => node.close() };
  }
  $effect(() => {
    if (pending) void tick().then(() => status?.focus());
  });
  function keydown(event: KeyboardEvent) {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!pending) onclose();
    }
    if (event.key !== 'Tab') return;
    const controls = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'input:not(:disabled),button:not(:disabled),textarea:not(:disabled)',
      ),
    );
    const i = controls.indexOf(document.activeElement as HTMLElement);
    if (!controls.length) {
      event.preventDefault();
      return;
    }
    if (
      i < 0 ||
      (event.shiftKey && i === 0) ||
      (!event.shiftKey && i === controls.length - 1)
    ) {
      event.preventDefault();
      controls[event.shiftKey ? controls.length - 1 : 0].focus();
    }
  }
</script>

<dialog
  class="auth-dialog recovery-dialog"
  use:mount
  aria-labelledby="raw-recovery-title"
  onkeydown={keydown}
  oncancel={(event) => {
    event.preventDefault();
    if (!pending) onclose();
  }}
>
  <h2 id="raw-recovery-title">Recover merged notes</h2>
  <p>
    Export recovery before removing notes. Removal here is permanent and syncs
    to your other Macs.
  </p>
  {#if !inspection.overflow}<p>
      The library is within its limits. Continue editing normally.
    </p>{/if}
  {#if !inspection.rows.length}<p>No raw notes remain.</p>{:else}
    <fieldset disabled={pending || !inspection.overflow}>
      <legend>Select raw notes to remove</legend>
      <div class="raw-notes">
        {#each visible as row, index (row.id)}
          <div class="raw-row">
            <label
              ><input
                type="checkbox"
                checked={chosen.includes(row.id)}
                onchange={(event) => {
                  selected = event.currentTarget.checked
                    ? [...chosen, row.id]
                    : chosen.filter((id) => id !== row.id);
                }}
              /><span
                >{row.markdown.trim().split(/\r?\n/)[0]?.slice(0, 160) ||
                  'Empty note'}</span
              ></label
            >
            <button
              type="button"
              onclick={() => (inspected = row.id)}
              aria-label={`Inspect raw Markdown for note ${Math.min(page, pages - 1) * pageSize + index + 1}`}
              aria-pressed={inspected === row.id}>Inspect raw Markdown</button
            >
          </div>
        {/each}
      </div>
    </fieldset>
    {#if inspected && inspection.rows.find((row) => row.id === inspected)}
      <label for="raw-markdown">Raw Markdown</label>
      <textarea
        id="raw-markdown"
        readonly
        value={inspection.rows.find((row) => row.id === inspected)?.markdown ??
          ''}></textarea>
    {/if}
    {#if pages > 1}<nav aria-label="Recovery pages">
        <button disabled={pending || page === 0} onclick={() => page--}
          >Previous</button
        ><span>Page {Math.min(page, pages - 1) + 1} of {pages}</span><button
          disabled={pending || page >= pages - 1}
          onclick={() => page++}>Next</button
        >
      </nav>{/if}
  {/if}
  <p role="status" tabindex="-1" bind:this={status}>
    {pending
      ? 'Removing selected notes. Please wait.'
      : `${chosen.length} selected`}
  </p>
  {#if error}<p role="alert">{error}</p>{/if}
  <div class="auth-actions">
    <button disabled={pending} onclick={onclose}>Close</button><button
      disabled={pending || !inspection.overflow || !chosen.length}
      onclick={() => onremove({ epoch: inspection.epoch, ids: [...chosen] })}
      >Permanently remove selected</button
    >
  </div>
</dialog>

<style>
  .recovery-dialog {
    max-width: min(38rem, calc(100vw - 2rem));
    max-height: calc(100dvh - 2rem);
    overflow-y: auto;
  }
  fieldset {
    min-width: 0;
    border: 1px solid var(--border);
  }
  .raw-notes {
    max-height: 18rem;
    overflow-y: auto;
  }
  label {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    padding: 0.4rem 0;
    overflow-wrap: anywhere;
  }
  label input {
    width: auto;
    flex: none;
  }
  .raw-row {
    border-bottom: 1px solid var(--border);
    padding-bottom: 0.4rem;
  }
  textarea {
    display: block;
    width: 100%;
    max-width: 100%;
    height: 10rem;
    resize: vertical;
    white-space: pre;
  }
  nav {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .auth-actions {
    flex-wrap: wrap;
  }
</style>
