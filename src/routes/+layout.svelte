<script lang="ts">
  import { onMount, type Snippet } from 'svelte';
  import { isTauri } from '@tauri-apps/api/core';
  import { setTheme } from '@tauri-apps/api/app';
  import {
    appearanceStorageKey,
    createAppearanceController,
    type AppearancePreference,
  } from '../lib/platform/appearance';
  import { provideAppearance } from '../lib/platform/appearance-context';
  import '#lib/app.css';

  let { children }: { children: Snippet } = $props();
  let preference = $state<AppearancePreference>('system');
  let controller: ReturnType<typeof createAppearanceController> | undefined;
  provideAppearance({
    get preference() {
      return preference;
    },
    setPreference: (next) => controller?.setPreference(next),
  });
  onMount(() => {
    controller = createAppearanceController({
      read: () => localStorage.getItem(appearanceStorageKey),
      write: (next) => localStorage.setItem(appearanceStorageKey, next),
      media: matchMedia('(prefers-color-scheme: dark)'),
      apply: (theme, next) => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.dataset.appearance = next;
        document.documentElement.style.colorScheme = theme;
        preference = next;
      },
      nativeTheme: isTauri() ? setTheme : undefined,
    });
    return () => controller?.dispose();
  });
</script>

{@render children()}
