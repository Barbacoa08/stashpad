<script lang="ts">
  import type { EditorState } from '@codemirror/state';
  import type { Item } from '../domain/notes';
  import { itemLabel } from '../domain/hierarchy';
  import TreeIcon from './TreeIcon.svelte';
  import { markerColors } from '../workspace/colors';
  import { timestampPresentation } from '../domain/timestamps';
  import NoteBody from './NoteBody.svelte';
  let {
    item,
    selected,
    primary,
    permanent,
    editing,
    source,
    baseline,
    states,
    readOnly,
    disabled,
    expanded,
    outsideSearch,
    location,
    onselect,
    ondoubleclick,
    onselectbutton,
    onhandleselect,
    onselectionpointer,
    onedit,
    ondelete,
    oncopy,
    ondone,
    onsource,
    onsubmit,
    onfinish,
    onblur,
    onfocus,
    oncontext,
    onopen,
    onexpand,
    reorderable,
    dropEdge,
    ondragstart,
    ondragend,
    ondragover,
    ondragleave,
    ondrop,
    onmovekey,
  }: {
    item: Item;
    selected: boolean;
    primary: boolean;
    permanent: boolean;
    editing: boolean;
    source: string;
    baseline?: number;
    states: Map<string, EditorState>;
    readOnly: boolean;
    disabled: boolean;
    expanded: boolean;
    outsideSearch: boolean;
    location: string;
    onselect: (event: MouseEvent) => void;
    ondoubleclick: (event: MouseEvent) => void;
    onselectbutton: (event: MouseEvent) => void;
    onhandleselect: (event: MouseEvent) => void;
    onselectionpointer: (event: PointerEvent) => void;
    onedit: () => void;
    ondelete: () => void;
    oncopy: () => void;
    ondone: () => void;
    onsource: (source: string) => void;
    onsubmit: () => void;
    onfinish: () => void;
    onblur: () => void;
    onfocus: () => void;
    oncontext: (fenced: boolean) => void;
    onopen: (url: string) => void;
    onexpand: (expanded: boolean) => void;
    reorderable: boolean;
    dropEdge: 'before' | 'after' | null;
    ondragstart: (event: DragEvent) => void;
    ondragend: () => void;
    ondragover: (event: DragEvent) => void;
    ondragleave: (event: DragEvent) => void;
    ondrop: (event: DragEvent) => void;
    onmovekey: (event: KeyboardEvent) => void;
  } = $props();
  let body = $state<NoteBody>();
  let updated = $derived(timestampPresentation(item.updatedAt));
  export function focus(options?: { end?: boolean }) {
    body?.focus(options);
  }
</script>

<!-- Selection and actions are separate from rendered content and links. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<article
  aria-label={item.kind === 'tree' ? `Tree ${itemLabel(item)}` : 'Saved note'}
  class:selected
  class="note-card"
  class:editing
  class:drop-before={dropEdge === 'before'}
  class:drop-after={dropEdge === 'after'}
  {ondragover}
  {ondragleave}
  {ondrop}
  class:done={item.done}
  data-note-id={item.id}
  style:--selection-color={item.color ? markerColors[item.color] : undefined}
  data-kind={item.kind}
  data-entry-id={item.id}
  onclick={onselect}
  onpointerdown={onselectionpointer}
  ondblclick={ondoubleclick}
>
  <div class="item-slot">
    <button
      class="note-select"
      aria-pressed={selected}
      {disabled}
      onclick={onselectbutton}
      aria-label={item.kind === 'tree' ? 'Select tree' : 'Select note'}
      title={item.kind === 'tree' ? 'Select tree' : 'Select note'}
      >{#if item.kind === 'tree'}<TreeIcon
          color={item.color}
        />{:else if item.color}<span
          class="note-color"
          style:background={markerColors[item.color]}
          aria-hidden="true"
        ></span>{/if}</button
    >
    {#if reorderable}<button
        class="drag-handle"
        draggable="true"
        {disabled}
        aria-label="Reorder item"
        title="Drag to reorder · Command Up/Down"
        onclick={onhandleselect}
        {ondragstart}
        {ondragend}
        onkeydown={onmovekey}
        ><span aria-hidden="true"
          ><svg viewBox="0 0 16 16"
            ><path
              d="M5 3h.01M11 3h.01M5 8h.01M11 8h.01M5 13h.01M11 13h.01"
            /></svg
          ></span
        ></button
      >{/if}
  </div>
  {#if item.done}<span class="sr-only">Done</span>{/if}
  <div class="note-meta">
    <time datetime={updated.datetime}>{updated.label}</time>
    {#if primary && !editing}<div class="card-actions">
        {#if !editing}<button
            {disabled}
            onclick={onedit}
            aria-label={item.kind === 'tree' ? 'Edit tree' : 'Edit note'}
            title={item.kind === 'tree' ? 'Edit tree' : 'Edit note'}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true"
              ><path d="m3 10 7-7 3 3-7 7-4 1zM9 4l3 3" /></svg
            >
          </button>{/if}
        <button
          {disabled}
          onclick={() => ondone()}
          aria-label="Mark done"
          title={item.done ? 'Mark not done (X)' : 'Mark done (X)'}
          aria-pressed={item.done}
          ><svg viewBox="0 0 16 16" aria-hidden="true"
            ><path d="M3 3h10v10H3z" />{#if item.done}<path
                d="m5 8 2 2 4-4"
              />{/if}</svg
          ></button
        >
        <button
          {disabled}
          onclick={oncopy}
          aria-label="Copy Markdown"
          title="Copy Markdown"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true"
            ><path d="M6 5h7v9H6zM3 11H2V2h7v1" /></svg
          >
        </button>
        <button
          {disabled}
          onclick={ondelete}
          aria-label={permanent
            ? item.kind === 'tree'
              ? 'Permanently delete tree'
              : 'Permanently delete note'
            : item.kind === 'tree'
              ? 'Delete tree'
              : 'Delete note'}
          title={permanent
            ? 'Permanently delete this item and its children'
            : item.kind === 'tree'
              ? 'Delete tree'
              : 'Delete note'}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true"
            ><path d="M3 4h10M6 4V2h4v2M4 4l1 10h6l1-10M7 6v6M9 6v6" /></svg
          >
        </button>
      </div>{/if}
  </div>
  {#if location}<p class="note-location">{location}</p>{/if}
  {#if outsideSearch}<p class="editing-outside">
      Editing outside search results
    </p>{/if}
  <NoteBody
    bind:this={body}
    {expanded}
    {onexpand}
    id={item.id}
    markdown={item.markdown}
    {source}
    {editing}
    {baseline}
    {states}
    {readOnly}
    onchange={onsource}
    {onsubmit}
    oncancel={onfinish}
    {onblur}
    {onfocus}
    {oncontext}
    {onopen}
  />
</article>
