<script lang="ts">
  import { onMount } from 'svelte';
  import Workspace from '#lib/components/Workspace.svelte';
  import '#lib/app.css';
  import type { Repository } from '../lib/platform/workspace';
  import type { WorkspaceController } from '../lib/workspace/controller';
  let repository: Repository | undefined = $state();
  let ready = $state<((c: WorkspaceController) => void) | undefined>();
  let mounted = $state(false);
  onMount(async () => {
    if (
      import.meta.env.DEV &&
      new URL(location.href).searchParams.has('fixture')
    ) {
      const fixture = await import('../../tests/fixtures/browser');
      repository = fixture.repository;
      ready = fixture.ready;
    }
    mounted = true;
  });
</script>

{#if mounted}<Workspace {repository} onready={ready} />{/if}
