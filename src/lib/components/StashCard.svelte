<script lang="ts">
  import type { Stash } from '../domain/notes';
  import StashIcon from './StashIcon.svelte';
  let {
    stash,
    count,
    selected,
    disabled,
    onselect,
    onopen,
    onrename,
  }: {
    stash: Stash;
    count: number;
    selected: boolean;
    disabled: boolean;
    onselect: (event: MouseEvent) => void;
    onopen: () => void;
    onrename: () => void;
  } = $props();
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
  <StashIcon />
  <div class="stash-card-body">
    <button class="stash-open" {disabled} onclick={onopen}>{stash.name}</button>
    <p>{count} {count === 1 ? 'item' : 'items'}</p>
  </div>
  {#if selected}<button {disabled} onclick={onrename} aria-label="Rename stash"
      >Rename</button
    >{/if}
</article>
