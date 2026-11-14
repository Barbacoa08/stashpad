<script lang="ts">
  let {
    name,
  }: {
    name:
      | 'back'
      | 'panel'
      | 'home'
      | 'search'
      | 'chevron'
      | 'download'
      | 'upload'
      | 'undo'
      | 'info'
      | 'sun'
      | 'monitor'
      | 'moon'
      | 'trash';
  } = $props();
</script>

<svg class="icon" viewBox="0 0 16 16" aria-hidden="true">
  {#if name === 'back'}<path d="m10 3-5 5 5 5" />
  {:else if name === 'panel'}<rect
      x="2"
      y="2.5"
      width="12"
      height="11"
      rx="1"
    /><path d="M10 2.5v11" />
  {:else if name === 'home'}<path
      d="M2 7.2 8 2l6 5.2M3.5 6.3V14h9V6.3M6.5 14v-4h3v4"
    />
  {:else if name === 'search'}<circle cx="7" cy="7" r="4.5" /><path
      d="m10.5 10.5 3.5 3.5"
    />
  {:else if name === 'chevron'}<path d="m6 3 5 5-5 5" />
  {:else if name === 'download'}<path d="M8 2v8m-3-3 3 3 3-3M3 11v3h10v-3" />
  {:else if name === 'upload'}<path d="M8 11V3M5 6l3-3 3 3M3 11v3h10v-3" />
  {:else if name === 'trash'}<path
      d="M2 4h12M6 4V2h4v2M4 4l.7 10h6.6L12 4M6.5 6.5v5M9.5 6.5v5"
    />
  {:else if name === 'undo'}<path
      d="M6 2.5 2.5 5.5 6 8.5M3 5.5h6a3 3 0 0 1 0 6"
    />
  {:else if name === 'sun'}<circle cx="8" cy="8" r="3" /><path
      d="M8 1v1M8 14v1M1 8h1M14 8h1M3 3l1 1M12 12l1 1M3 13l1-1M12 4l1-1"
    />
  {:else if name === 'monitor'}<rect
      x="1.5"
      y="2.5"
      width="13"
      height="9"
      rx="1"
    /><path d="M8 11.5V14M5.5 14h5" />
  {:else if name === 'moon'}<path
      d="M13.8 9.5A6 6 0 0 1 6.5 2.2 6 6 0 1 0 13.8 9.5Z"
    />
  {:else}<circle cx="8" cy="8" r="6" /><path d="M8 7v4M8 4.5v.1" />{/if}
</svg>
