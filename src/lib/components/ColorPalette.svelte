<script lang="ts">
  import { onMount } from 'svelte';
  import { COLORS, type ColorToken } from '../domain/notes';
  import { markerColors } from '../workspace/colors';
  let {
    anchor,
    color,
    disabled,
    error,
    onchoose,
    onclose,
  }: {
    anchor: HTMLElement;
    color: ColorToken | null;
    disabled: boolean;
    error: string;
    onchoose: (color: ColorToken | null) => Promise<void>;
    onclose: (returnFocus: boolean) => void;
  } = $props();
  const choices = [...COLORS, null];
  let candidate = $state(0);
  let panel: HTMLDivElement;
  let reposition = () => {};
  // Recheck clipping after a pending write settles, even if the popup size is unchanged.
  $effect(() => {
    disabled;
    error;
    reposition();
  });
  onMount(() => {
    candidate = choices.indexOf(color);
    const ancestors: HTMLElement[] = [];
    for (
      let parent = anchor.parentElement;
      parent;
      parent = parent.parentElement
    )
      ancestors.push(parent);
    let frame = 0;
    function position() {
      frame = 0;
      const row = anchor.getBoundingClientRect();
      let left = Math.max(0, row.left),
        right = Math.min(window.innerWidth, row.right),
        top = Math.max(0, row.top),
        bottom = Math.min(window.innerHeight, row.bottom);
      for (const parent of ancestors) {
        const style = getComputedStyle(parent);
        const rect = parent.getBoundingClientRect();
        if (/auto|scroll|hidden|clip/.test(style.overflowX)) {
          left = Math.max(left, rect.left + parent.clientLeft);
          right = Math.min(
            right,
            rect.left + parent.clientLeft + parent.clientWidth,
          );
        }
        if (/auto|scroll|hidden|clip/.test(style.overflowY)) {
          top = Math.max(top, rect.top + parent.clientTop);
          bottom = Math.min(
            bottom,
            rect.top + parent.clientTop + parent.clientHeight,
          );
        }
      }
      if (!anchor.isConnected || right <= left || bottom <= top) {
        // Existing close policy keeps a submitted write alive, without returning focus.
        onclose(false);
        return;
      }
      const gap = 8;
      const recovery = document.querySelector<HTMLElement>(
        '.workspace-feedback.compact:not(.sr-only)',
      );
      const lowerEdge = Math.min(
        window.innerHeight - gap,
        recovery ? recovery.getBoundingClientRect().top - gap : Infinity,
      );
      panel.style.maxHeight = `${Math.max(24, lowerEdge - gap)}px`;
      const popup = panel.getBoundingClientRect();
      const x =
        right + gap + popup.width <= window.innerWidth - gap
          ? right + gap
          : left - gap - popup.width >= gap
            ? left - gap - popup.width
            : right - popup.width;
      panel.style.left = `${Math.max(gap, Math.min(x, window.innerWidth - gap - popup.width))}px`;
      panel.style.top = `${Math.max(gap, Math.min(top, lowerEdge - popup.height))}px`;
      panel.style.visibility = 'visible';
    }
    function schedulePosition() {
      if (!frame) frame = requestAnimationFrame(position);
    }
    reposition = schedulePosition;
    const resize = new ResizeObserver(schedulePosition);
    for (const node of [anchor, panel, ...ancestors]) resize.observe(node);
    document
      .querySelectorAll('.workspace-feedback')
      .forEach((node) => resize.observe(node));
    const mutation = new MutationObserver(schedulePosition);
    if (anchor.parentElement)
      mutation.observe(anchor.parentElement, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    window.addEventListener('scroll', schedulePosition, true);
    window.addEventListener('resize', schedulePosition);
    position();
    focusCandidate();
    return () => {
      reposition = () => {};
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutation.disconnect();
      window.removeEventListener('scroll', schedulePosition, true);
      window.removeEventListener('resize', schedulePosition);
    };
  });
  function focusCandidate() {
    panel.querySelectorAll<HTMLButtonElement>('button')[candidate]?.focus();
  }
  function outside(event: PointerEvent) {
    if (event.target instanceof Node && !panel.contains(event.target))
      onclose(false);
  }
  function keys(event: KeyboardEvent) {
    if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey)
      return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onclose(true);
      return;
    }
    // Tab uses the browser's normal page order; dismissal never returns focus.
    if (event.key === 'Tab') {
      setTimeout(() => onclose(false), 0);
      return;
    }
    if (event.shiftKey) return;
    if (
      [
        'ArrowUp',
        'ArrowDown',
        'ArrowLeft',
        'ArrowRight',
        'Home',
        'End',
      ].includes(event.key)
    ) {
      event.preventDefault();
      if (disabled) return;
      if (event.key === 'ArrowLeft' && candidate % 2 === 1) candidate--;
      if (event.key === 'ArrowRight' && candidate % 2 === 0) candidate++;
      if (event.key === 'ArrowUp' && candidate >= 2) candidate -= 2;
      if (event.key === 'ArrowDown' && candidate < 8) candidate += 2;
      if (event.key === 'Home') candidate -= candidate % 2;
      if (event.key === 'End') candidate += 1 - (candidate % 2);
      focusCandidate();
    }
    if (disabled && [' ', 'Enter'].includes(event.key)) event.preventDefault();
  }
  function name(choice: ColorToken | null) {
    return choice ? choice[0].toUpperCase() + choice.slice(1) : 'Reset';
  }
</script>

<svelte:window onpointerdown={outside} />
<!-- Nonmodal layout grid: arrows stage focus, native button activation commits. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="color-palette"
  style="left: 0; top: 0; visibility: hidden"
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
  <p class="sr-only" id="color-palette-instructions">
    Arrows preview a choice. Enter or Space applies it. Escape cancels. Pressed
    marks the saved color.
  </p>
  <div
    class="color-choices"
    role="grid"
    aria-label="Item color"
    aria-describedby="color-palette-instructions"
    aria-disabled={disabled}
    aria-busy={disabled}
  >
    {#each [0, 2, 4, 6, 8] as row}
      <div class="color-row" role="row">
        {#each choices.slice(row, row + 2) as choice, column}
          <div role="gridcell">
            <button
              class="color-choice"
              class:saved={color === choice}
              aria-label={name(choice)}
              aria-pressed={color === choice}
              aria-disabled={disabled}
              tabindex={candidate === row + column ? 0 : -1}
              onfocus={() => {
                if (!disabled) candidate = row + column;
              }}
              onclick={(event) => {
                if (disabled) {
                  event.preventDefault();
                  return;
                }
                candidate = row + column;
                // Mac pointer activation need not focus a button by default.
                event.currentTarget.focus();
                void onchoose(choice);
              }}
            >
              <span
                class="color-swatch"
                class:color-reset={choice === null}
                style:background={choice ? markerColors[choice] : 'transparent'}
                aria-hidden="true">{choice === null ? '↺' : ''}</span
              >
              <span class="color-saved" aria-hidden="true"
                >{color === choice ? '✓' : ''}</span
              >
            </button>
          </div>
        {/each}
      </div>
    {/each}
  </div>
  {#if error}<p role="alert">{error}</p>{/if}
</div>
