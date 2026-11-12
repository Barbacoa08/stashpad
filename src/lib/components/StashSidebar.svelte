<script lang="ts">
  import { untrack } from 'svelte';
  import { itemLabel, type HierarchyPresentation } from '../domain/hierarchy';
  import Icon from './Icon.svelte';
  import StashIcon from './StashIcon.svelte';
  let {
    presentation,
    currentId,
    live = true,
    disabled,
    onopen,
  }: {
    presentation: HierarchyPresentation;
    currentId: string | null;
    live?: boolean;
    disabled: boolean;
    onopen: (id: string | null) => void;
  } = $props();
  let expanded = $state(new Set<string>());
  $effect(() => {
    const next = new Set(untrack(() => expanded));
    for (const stash of presentation.path(live ? currentId : null))
      next.add(stash.id);
    expanded = next;
  });
  let rows = $derived(presentation.rows(expanded));
</script>

<nav aria-label="Stashes" class="stash-navigation">
  <button
    class="home-link"
    class:current={live && currentId === null}
    aria-current={live && currentId === null ? 'page' : undefined}
    onclick={() => onopen(null)}
    {disabled}><Icon name="home" /> Home</button
  >
  {#each rows as row (row.stash.id)}
    <div
      class="stash-row"
      class:current={currentId === row.stash.id}
      style:padding-left={`${Math.min(row.depth, 2) * 8}px`}
    >
      {#if row.hasChildren}<button
          class="stash-expand"
          aria-label={`${expanded.has(row.stash.id) ? 'Collapse' : 'Expand'} stash ${itemLabel(row.stash)}`}
          aria-expanded={expanded.has(row.stash.id)}
          {disabled}
          onclick={() => {
            const next = new Set(expanded);
            if (next.has(row.stash.id)) next.delete(row.stash.id);
            else next.add(row.stash.id);
            expanded = next;
          }}
          ><span class:expanded={expanded.has(row.stash.id)}
            ><Icon name="chevron" /></span
          ></button
        >{:else}<span class="stash-expand-spacer" aria-hidden="true"
        ></span>{/if}
      <button
        class="stash-link"
        aria-current={currentId === row.stash.id ? 'page' : undefined}
        aria-label={`Open stash ${itemLabel(row.stash)}`}
        title={itemLabel(row.stash)}
        {disabled}
        onclick={() => onopen(row.stash.id)}
        ><StashIcon color={row.stash.color} /><span class="stash-name"
          >{itemLabel(row.stash)}</span
        >{#if row.depth >= 3}<span class="stash-level"
            >Level {row.depth + 1}</span
          >{/if}</button
      >
    </div>
  {/each}
</nav>
