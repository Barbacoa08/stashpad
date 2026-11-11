<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { stashName } from '../domain/hierarchy';
  let {
    title,
    initial = '',
    busy,
    error,
    onsubmit,
    oncancel,
  }: {
    title: string;
    initial?: string;
    busy: boolean;
    error: string;
    onsubmit: (name: string) => Promise<void>;
    oncancel: () => void;
  } = $props();
  let name = $state(untrack(() => initial)),
    localError = $state(''),
    input: HTMLInputElement;
  onMount(() => {
    input.focus();
    input.select();
  });
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (busy) return;
    try {
      stashName(name);
      localError = '';
      await onsubmit(name);
    } catch (e) {
      localError = (e as Error).message;
    }
  }
  function keys(event: KeyboardEvent) {
    if (event.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (!busy) oncancel();
    }
    if (event.key === 'Tab') {
      const dialog = input.closest('[role="dialog"]')!;
      const controls = Array.from(
        dialog.querySelectorAll<HTMLElement>('input,button:not(:disabled)'),
      );
      const first = controls[0],
        last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  }
</script>

<!-- Focus is trapped within the named modal and restored by its caller. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="confirmation stash-dialog"
  role="dialog"
  tabindex="-1"
  aria-modal="true"
  aria-label={title}
  onkeydown={keys}
>
  <h2>{title}</h2>
  <form onsubmit={submit}>
    <label for="stash-name">Stash name</label><input
      id="stash-name"
      bind:this={input}
      bind:value={name}
      disabled={busy}
      autocomplete="off"
    />
    <p role="alert">{localError || error}</p>
    <div class="note-actions">
      <button type="button" disabled={busy} onclick={oncancel}>Cancel</button
      ><button type="submit" disabled={busy}
        >{title === 'New stash' ? 'Create stash' : 'Rename stash'}</button
      >
    </div>
  </form>
</div>
