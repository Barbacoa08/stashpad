<script lang="ts">
  import { tick } from 'svelte';
  import type { HierarchyPresentation } from '../domain/hierarchy';
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
  let path = $derived(presentation.path(currentId));
  let navigation: HTMLElement;
  $effect(() => {
    path;
    void tick().then(() => {
      if (navigation) navigation.scrollLeft = navigation.scrollWidth;
    });
  });
</script>

<nav bind:this={navigation} aria-label="Breadcrumbs" class="breadcrumbs">
  <button
    {disabled}
    aria-current={currentId === null ? 'page' : undefined}
    onclick={() => onopen(null)}>Home</button
  >
  {#each path as stash (stash.id)}<span aria-hidden="true">/</span><button
      {disabled}
      aria-current={stash.id === currentId ? 'page' : undefined}
      title={stash.name}
      onclick={() => onopen(stash.id)}>{stash.name}</button
    >{/each}
</nav>
