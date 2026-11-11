<script lang="ts">
  import { untrack } from 'svelte';
  import type { HierarchyPresentation } from '../domain/hierarchy';
  import StashIcon from './StashIcon.svelte';
  let {
    presentation,
    currentId,
    disabled,
    onopen,
  }: {
    presentation: HierarchyPresentation;
    currentId: string | null;
    disabled: boolean;
    onopen: (id: string | null) => void;
  } = $props();
  let expanded = $state(new Set<string>());
  $effect(() => {
    const next = new Set(untrack(() => expanded));
    for (const stash of presentation.path(currentId)) next.add(stash.id);
    expanded = next;
  });
  let rows = $derived(presentation.rows(expanded));
</script>

<nav aria-label="Stashes" class="stash-navigation">
  <button
    class:current={currentId === null}
    aria-current={currentId === null ? 'page' : undefined}
    onclick={() => onopen(null)}
    {disabled}>Home</button
  >
  {#each rows as row (row.stash.id)}
    <div
      class="stash-row"
      style:padding-left={`${Math.min(row.depth, 2) * 8}px`}
    >
      {#if row.hasChildren}<button
          class="stash-expand"
          aria-label={`${expanded.has(row.stash.id) ? 'Collapse' : 'Expand'} stash ${row.stash.name}`}
          aria-expanded={expanded.has(row.stash.id)}
          {disabled}
          onclick={() => {
            const next = new Set(expanded);
            if (next.has(row.stash.id)) next.delete(row.stash.id);
            else next.add(row.stash.id);
            expanded = next;
          }}>{expanded.has(row.stash.id) ? '⌄' : '›'}</button
        >{:else}<span class="stash-expand-spacer" aria-hidden="true"
        ></span>{/if}
      <button
        class="stash-link"
        class:current={currentId === row.stash.id}
        aria-current={currentId === row.stash.id ? 'page' : undefined}
        aria-label={`Open stash ${row.stash.name}`}
        title={row.stash.name}
        {disabled}
        onclick={() => onopen(row.stash.id)}
        ><StashIcon /><span class="stash-name">{row.stash.name}</span
        >{#if row.depth >= 3}<span class="stash-level"
            >Level {row.depth + 1}</span
          >{/if}</button
      >
    </div>
  {/each}
</nav>
