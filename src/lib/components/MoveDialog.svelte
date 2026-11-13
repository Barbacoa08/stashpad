<script lang="ts">
  import type { Location } from '../domain/notes';
  export type MoveDestination = {
    key: string;
    label: string;
    path: string;
    location: Location;
  };
  let {
    destinations,
    count,
    pending,
    error,
    locked,
    onconfirm,
    oncancel,
  }: {
    destinations: MoveDestination[];
    count: number;
    pending: boolean;
    error: string;
    locked: boolean;
    onconfirm: (location: Location) => void;
    oncancel: () => void;
  } = $props();
  let list = $state<HTMLElement>();
  let staged = $state(0);
  let dialog: HTMLDialogElement;
  function mount(node: HTMLDialogElement) {
    dialog = node;
    node.showModal();
    list?.focus();
    return { destroy: () => node.close() };
  }
  function confirm() {
    if (!pending && destinations[staged])
      onconfirm(destinations[staged].location);
  }
  function keydown(event: KeyboardEvent) {
    event.stopPropagation();
    if (event.isComposing) return;
    if (event.key === 'Tab') {
      const controls = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          '[tabindex="0"],button:not(:disabled)',
        ),
      );
      const index = controls.indexOf(document.activeElement as HTMLElement);
      event.preventDefault();
      const direction = event.shiftKey ? -1 : 1;
      const next =
        index < 0
          ? event.shiftKey
            ? controls.length - 1
            : 0
          : (index + direction + controls.length) % controls.length;
      controls[next]?.focus();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!pending) oncancel();
      return;
    }
    if (event.target !== list) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      if (!event.repeat) confirm();
    } else if (
      !pending &&
      !locked &&
      ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)
    ) {
      event.preventDefault();
      staged =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? destinations.length - 1
            : Math.max(
                0,
                Math.min(
                  destinations.length - 1,
                  staged + (event.key === 'ArrowDown' ? 1 : -1),
                ),
              );
      list
        ?.querySelector(`[data-candidate="${staged}"]`)
        ?.scrollIntoView({ block: 'nearest' });
    }
  }
</script>

<!-- Native dialog supplies modal background exclusion and Tab containment. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<dialog
  use:mount
  aria-label="Move items"
  aria-describedby="move-summary"
  aria-busy={pending}
  onkeydown={keydown}
  oncancel={(event) => {
    event.preventDefault();
    if (!pending) oncancel();
  }}
  onclick={(event) => {
    if (event.target !== dialog || pending) return;
    const bounds = dialog.getBoundingClientRect();
    if (
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom
    )
      oncancel();
  }}
>
  <h2>Move items</h2>
  <p id="move-summary">
    Choose a destination for {count}
    {count === 1 ? 'item' : 'items'}.
  </p>
  <!-- svelte-ignore a11y_interactive_supports_focus -->
  <div
    class="destinations"
    role="listbox"
    aria-label="Destination"
    tabindex="0"
    bind:this={list}
    aria-activedescendant={destinations.length
      ? `move-destination-${staged}`
      : undefined}
    aria-disabled={pending || locked}
  >
    {#each destinations as destination, index (destination.key)}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
      <div
        role="option"
        id={`move-destination-${index}`}
        data-candidate={index}
        aria-selected={staged === index}
        aria-label={destination.path
          ? `${destination.label}, ${destination.path}`
          : destination.label}
        class:staged={staged === index}
        onpointerdown={(event) => event.preventDefault()}
        onclick={() => {
          if (!pending && !locked) staged = index;
          list?.focus();
        }}
      >
        <span>{destination.label}</span>
        {#if destination.path}<small>{destination.path}</small>{/if}
      </div>
    {/each}
  </div>
  {#if !destinations.length}<p>No eligible destinations in this area.</p>{/if}
  {#if error}<p role="alert">{error}</p>{/if}
  <div class="actions">
    <button disabled={pending} onclick={oncancel}>Cancel</button>
    <button disabled={pending || !destinations.length} onclick={confirm}
      >{pending ? 'Moving…' : locked ? 'Retry move' : 'Move'}</button
    >
  </div>
</dialog>

<style>
  dialog {
    width: min(32rem, calc(100vw - 2rem));
    max-height: calc(100dvh - 2rem);
    box-sizing: border-box;
    overflow: auto;
    border: 1px solid #4b4b4b;
    border-radius: 0.75rem;
    padding: 1.25rem;
    background: #252525;
    color: #e7e7e7;
    box-shadow: 0 1rem 4rem #0009;
  }
  dialog::backdrop {
    background: #0009;
  }
  h2 {
    margin: 0 0 0.75rem;
    font-size: 1.15rem;
  }
  p {
    margin: 0.75rem 0;
  }
  .destinations {
    max-height: min(22rem, 50dvh);
    overflow: auto;
    border: 1px solid #555;
    border-radius: 0.4rem;
  }
  [role='option'] {
    padding: 0.65rem 0.75rem;
    cursor: pointer;
    overflow-wrap: anywhere;
  }
  [role='option'].staged {
    background: #3b526d;
    box-shadow: inset 3px 0 #95c6ff;
  }
  [role='option'] span,
  small {
    display: block;
  }
  small {
    color: #c0c0c0;
    margin-top: 0.2rem;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-top: 1rem;
  }
  button {
    border: 1px solid #666;
    border-radius: 0.35rem;
    color: inherit;
    background: #383838;
    padding: 0.5rem 0.85rem;
    font: inherit;
  }
  button:disabled {
    opacity: 0.6;
  }
  :focus-visible {
    outline: 2px solid #94c4ff;
    outline-offset: 2px;
  }
</style>
