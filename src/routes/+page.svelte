<script lang="ts">
  import { onMount } from 'svelte';
  import { getAppearance } from '../lib/platform/appearance-context';
  import Workspace from '#lib/components/Workspace.svelte';
  import type { CloseAdapter } from '../lib/platform/lifecycle';
  import type { Repository } from '../lib/platform/workspace';
  import type { AuthPort, SyncPort } from '../lib/sync/service-types';
  import type { WorkspaceController } from '../lib/workspace/controller';
  let auth: AuthPort | undefined = $state();
  let sync: SyncPort | undefined = $state();
  let repository: Repository | undefined = $state();
  let ready = $state<((c: WorkspaceController) => void) | undefined>();
  let windowAdapter: CloseAdapter | undefined = $state();
  const appearance = getAppearance();
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
    if (
      import.meta.env.DEV &&
      new URL(location.href).searchParams.has('authFixture')
    ) {
      const fixture = await import('../../tests/fixtures/auth-ui');
      auth = fixture.auth;
      sync = fixture.sync;
      fixture.install();
    }
    mounted = true;
  });
</script>

{#if mounted}<Workspace
    {repository}
    {auth}
    {sync}
    {windowAdapter}
    appearance={appearance.preference}
    onappearancechange={appearance.setPreference}
    onready={ready}
  />{/if}
