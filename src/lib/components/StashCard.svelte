<script lang="ts">
  import type { Stash } from '../domain/notes';
  import StashIcon from './StashIcon.svelte';
  import { timestampPresentation } from '../domain/timestamps';
  let {
    stash,
    selected,
    disabled,
    onselect,
    onopen,
    onrename,
  }: {
    stash: Stash;
    selected: boolean;
    disabled: boolean;
    onselect: (event: MouseEvent) => void;
    onopen: () => void;
    onrename: () => void;
  } = $props();
  let updated = $derived(timestampPresentation(stash.updatedAt));
</script>

<!-- The stream owns arrow/Enter navigation; each card also has explicit named actions. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<article
  class="note-card stash-card"
  class:selected
  data-entry-id={stash.id}
  aria-label={`Stash ${stash.name}`}
  onclick={onselect}
  ondblclick={(event) => {
    if (!(event.target as Element).closest('button')) onopen();
  }}
>
  <span class="stash-card-icon"><StashIcon /></span>
  <button class="stash-open" {disabled} onclick={onopen}>{stash.name}</button>
  <div class="note-meta">
    <time datetime={updated.datetime}>{updated.label}</time>
    {#if selected}<button
        {disabled}
        onclick={onrename}
        aria-label="Rename stash">Rename</button
      >{/if}
  </div>
</article>
