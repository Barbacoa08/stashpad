<script lang="ts">
  import { onMount } from 'svelte';
  import Workspace from '#lib/components/Workspace.svelte';
  import '#lib/app.css';
  import type { CloseAdapter } from '../lib/platform/lifecycle';
  import type { Repository } from '../lib/platform/workspace';
  import type { WorkspaceController } from '../lib/workspace/controller';
  let repository: Repository | undefined = $state();
  let ready = $state<((c: WorkspaceController) => void) | undefined>();
  let windowAdapter: CloseAdapter | undefined = $state();
  let mounted = $state(false);
  onMount(async () => {
    if (
      import.meta.env.DEV &&
      new URL(location.href).searchParams.has('fixture')
    ) {
      const fixture = await import('../../tests/fixtures/browser');
      repository = fixture.repository;
      ready = fixture.ready;
      if (new URL(location.href).searchParams.has('lifecycle'))
        windowAdapter = fixture.windowAdapter;
    }
    mounted = true;
  });
</script>

{#if mounted}<Workspace {repository} {windowAdapter} onready={ready} />{/if}
