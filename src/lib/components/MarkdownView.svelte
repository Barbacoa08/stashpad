<script lang="ts">
  import { onMount } from 'svelte';
  import { renderMarkdown, externalUrl } from '../domain/markdown';
  let { source, onopen }: { source: string; onopen: (url: string) => void } =
    $props();
  let host: HTMLDivElement;
  const html = $derived(renderMarkdown(source));
  onMount(() => {
    function activate(event: MouseEvent) {
      const anchor = (event.target as Element).closest('a');
      if (!anchor) return;
      event.preventDefault();
      event.stopPropagation();
      const url = externalUrl(anchor.getAttribute('data-external-url') ?? '');
      if (url && event.type === 'click') onopen(url);
    }
    host.addEventListener('click', activate);
    host.addEventListener('auxclick', activate);
    return () => {
      host.removeEventListener('click', activate);
      host.removeEventListener('auxclick', activate);
    };
  });
</script>

<div class="markdown-view" bind:this={host}>{@html html}</div>
