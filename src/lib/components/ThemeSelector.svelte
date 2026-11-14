<script lang="ts">
  import type { AppearancePreference } from '../platform/appearance';
  let {
    preference,
    onchange,
  }: {
    preference: AppearancePreference;
    onchange: (preference: AppearancePreference) => void;
  } = $props();
</script>

<div class="appearance-setting">
  <label for="appearance">Appearance</label>
  <select
    id="appearance"
    value={preference}
    onchange={(event) =>
      onchange(event.currentTarget.value as AppearancePreference)}
  >
    <option value="system">System</option>
    <option value="light">Light</option>
    <option value="dark">Dark</option>
  </select>
</div>
