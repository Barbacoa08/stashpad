<script lang="ts">
  let {
    name,
  }: {
    name:
      'home' | 'search' | 'chevron' | 'download' | 'upload' | 'undo' | 'info';
  } = $props();
</script>

<svg class="icon" viewBox="0 0 16 16" aria-hidden="true">
  {#if name === 'home'}<path
      d="M2 7.2 8 2l6 5.2M3.5 6.3V14h9V6.3M6.5 14v-4h3v4"
    />
  {:else if name === 'search'}<circle cx="7" cy="7" r="4.5" /><path
      d="m10.5 10.5 3.5 3.5"
    />
  {:else if name === 'chevron'}<path d="m6 3 5 5-5 5" />
  {:else if name === 'download'}<path d="M8 2v8m-3-3 3 3 3-3M3 11v3h10v-3" />
  {:else if name === 'upload'}<path d="M8 11V3M5 6l3-3 3 3M3 11v3h10v-3" />
  {:else if name === 'undo'}<path d="M6 4 2.5 7 6 10M3 7h6a4 4 0 0 1 0 8" />
  {:else}<circle cx="8" cy="8" r="6" /><path d="M8 7v4M8 4.5v.1" />{/if}
</svg>
