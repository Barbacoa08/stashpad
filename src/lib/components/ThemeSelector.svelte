<script lang="ts">
  import type { AppearancePreference } from '../platform/appearance';
  import Icon from './Icon.svelte';
  const choices = [
    { value: 'light', label: 'Light', icon: 'sun' },
    { value: 'system', label: 'System', icon: 'monitor' },
    { value: 'dark', label: 'Dark', icon: 'moon' },
  ] as const;
  let {
    preference,
    onchange,
  }: {
    preference: AppearancePreference;
    onchange: (preference: AppearancePreference) => void;
  } = $props();
  function arrow(event: KeyboardEvent, index: number) {
    if (
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.isComposing
    )
      return;
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0;
    if (!step) return;
    // WebKit's native radio navigation does not wrap consistently. Keep the
    // native semantics while giving this bounded group the APG arrow behavior.
    event.preventDefault();
    event.stopPropagation();
    const next = choices[(index + step + choices.length) % choices.length];
    const input = event.currentTarget as HTMLInputElement;
    input
      .closest('fieldset')
      ?.querySelector<HTMLInputElement>(`input[value="${next.value}"]`)
      ?.focus();
    onchange(next.value);
  }
</script>

<fieldset class="appearance-setting">
  <legend>Appearance</legend>
  <div class="appearance-options">
    {#each choices as choice, index}
      <label class="appearance-option" title={choice.label}>
        <input
          type="radio"
          name="appearance"
          value={choice.value}
          checked={preference === choice.value}
          aria-label={choice.label}
          onchange={() => onchange(choice.value)}
          onkeydown={(event) => arrow(event, index)}
        />
        <span class="appearance-segment"><Icon name={choice.icon} /></span>
      </label>
    {/each}
  </div>
</fieldset>
