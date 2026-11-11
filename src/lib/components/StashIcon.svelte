<script lang="ts">
  import type { ColorToken } from '../domain/notes';
  import { markerColors } from '../workspace/colors';
  let { color = null }: { color?: ColorToken | null } = $props();
</script>

<!-- Locally authored, decorative stack symbol for actual stash containers. -->
<svg
  style:color={color ? markerColors[color] : undefined}
  class="stash-icon"
  viewBox="0 0 24 24"
  aria-hidden="true"
  focusable="false"
  ><path d="m4 8 8-4 8 4-8 4zM4 12l8 4 8-4M4 16l8 4 8-4" /></svg
>
