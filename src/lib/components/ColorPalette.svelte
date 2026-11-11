<script lang="ts">
  import { onMount } from 'svelte';
  import { COLORS, type ColorToken } from '../domain/notes';
  import { markerColors } from '../workspace/colors';
  let {
    color,
    disabled,
    onchoose,
    onclose,
  }: {
    color: ColorToken | null;
    disabled: boolean;
    onchoose: (color: ColorToken | null) => Promise<boolean>;
    onclose: (returnFocus: boolean) => void;
  } = $props();
  let panel: HTMLDivElement;
  onMount(() => {
    panel.querySelector<HTMLInputElement>('input:checked')?.focus();
  });
  async function choose(choice: ColorToken | null) {
    if (await onchoose(choice)) return;
    // Native radios change before acknowledgment; failed writes keep the saved choice.
    if (panel.isConnected)
      for (const input of panel.querySelectorAll<HTMLInputElement>('input'))
        input.checked = input.value === (color ?? 'reset');
  }
  function outside(event: PointerEvent) {
    if (event.target instanceof Node && !panel.contains(event.target))
      onclose(false);
  }
  function keys(event: KeyboardEvent) {
    if (
      disabled &&
      [' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(
        event.key,
      )
    ) {
      event.preventDefault();
      return;
    }
    if (
      !event.isComposing &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      event.target instanceof HTMLInputElement &&
      event.target.type === 'radio'
    ) {
      if (event.key === 'Tab') {
        // Focus and the acknowledged checked radio can differ during a write.
        event.preventDefault();
        panel.querySelector<HTMLButtonElement>('button')?.focus();
        return;
      }
      const radios = Array.from(
        panel.querySelectorAll<HTMLInputElement>('input'),
      );
      const index = radios.indexOf(event.target);
      const next =
        index === radios.length - 1 &&
        ['ArrowRight', 'ArrowDown'].includes(event.key)
          ? radios[0]
          : index === 0 && ['ArrowLeft', 'ArrowUp'].includes(event.key)
            ? radios.at(-1)
            : undefined;
      // WebKit stops at group boundaries; retain native navigation everywhere else.
      if (next) {
        event.preventDefault();
        next.focus();
        next.click();
      }
    }
    if (event.key === 'Escape' && !event.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      onclose(true);
    }
  }
</script>

<svelte:window onpointerdown={outside} />
<!-- Nonmodal: native radio navigation and Tab remain available. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="color-palette"
  role="dialog"
  tabindex="-1"
  aria-label="Assign color"
  bind:this={panel}
  onkeydown={keys}
  onfocusout={(event) => {
    if (
      event.relatedTarget instanceof Node &&
      !panel.contains(event.relatedTarget)
    )
      onclose(false);
  }}
>
  <fieldset aria-disabled={disabled} aria-busy={disabled}>
    <legend>Assign color</legend>
    <div class="color-choices">
      {#each [...COLORS, null] as choice}
        <label>
          <input
            type="radio"
            name="item-color"
            value={choice ?? 'reset'}
            checked={color === choice}
            tabindex="0"
            onclick={(event) => {
              if (disabled) event.preventDefault();
            }}
            onchange={() => {
              if (!disabled) void choose(choice);
            }}
          />
          <span
            class="color-swatch"
            style:background={choice ? markerColors[choice] : 'transparent'}
            aria-hidden="true"
          ></span>
          {choice ? choice[0].toUpperCase() + choice.slice(1) : 'Reset'}
        </label>
      {/each}
    </div>
  </fieldset>
  <button tabindex="0" onclick={() => onclose(true)}>Done</button>
</div>
