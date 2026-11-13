<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import type { EditorState } from '@codemirror/state';
  import MarkdownEditor from './MarkdownEditor.svelte';
  import MarkdownView from './MarkdownView.svelte';
  let {
    id,
    markdown,
    source,
    editing,
    baseline,
    readOnly,
    states,
    onchange,
    onsubmit,
    oncancel,
    onblur,
    onfocus,
    onopen,
    oncontext,
    expanded,
    onexpand,
  }: {
    expanded: boolean;
    onexpand: (expanded: boolean) => void;
    id: string;
    markdown: string;
    source: string;
    editing: boolean;
    baseline?: number;
    readOnly: boolean;
    states: Map<string, EditorState>;
    onchange: (source: string) => void;
    onsubmit: () => void;
    oncancel: () => void;
    onblur: () => void;
    onfocus: () => void;
    onopen: (url: string) => void;
    oncontext: (fenced: boolean) => void;
  } = $props();
  let body: HTMLDivElement;
  let editor = $state<MarkdownEditor>();
  let rendered: HTMLDivElement | undefined = $state();
  let baselineMirror: HTMLDivElement | undefined = $state();
  let overflow = $state(false);
  let naturalHeight = $state(0);
  let cap = $state(384);
  let changed = $state(false);
  let entrySource = $state('');
  let wasEditing = false;
  let savedOverflow = false;
  let savedBaseline = $state(0);
  let activeCap = $derived(cap * (expanded ? 2 : 1));
  let height = $derived(
    editing
      ? Math.min(
          activeCap,
          changed ? Math.max(savedBaseline, naturalHeight) : savedBaseline,
        )
      : undefined,
  );
  // Change intent belongs to the edit session, never to the latest autosave snapshot.
  $effect.pre(() => {
    const active = editing;
    if (active && !wasEditing) {
      entrySource = untrack(() => source);
      savedBaseline = untrack(
        () => baseline ?? body?.getBoundingClientRect().height ?? 0,
      );
      savedOverflow = untrack(() => overflow);
      changed = false;
    }
    wasEditing = active;
  });
  $effect(() => {
    if (editing && source !== entrySource) changed = true;
  });
  function measure() {
    if (!body) return;
    const nextCap =
      parseFloat(getComputedStyle(body).getPropertyValue('--note-cap')) *
      parseFloat(getComputedStyle(document.documentElement).fontSize);
    cap = nextCap;
    if (!editing && rendered) {
      naturalHeight = rendered.getBoundingClientRect().height;
      overflow = naturalHeight > cap + 1;
      if (!overflow && expanded) onexpand(false);
    } else if (changed) {
      overflow = naturalHeight > cap + 1;
    } else overflow = savedOverflow;
  }
  $effect(() => {
    const node = rendered;
    if (!node) return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    measure();
    return () => observer.disconnect();
  });
  $effect(() => {
    naturalHeight;
    changed;
    editing;
    measure();
  });
  $effect(() => {
    const node = baselineMirror;
    if (!node) return;
    function resizeBaseline() {
      // This rendered-source mirror reacts to wrapping, text scaling, and late fonts.
      // It never uses the taller raw editor source as the entry footprint.
      const minimum = parseFloat(getComputedStyle(body).minHeight);
      savedBaseline = Math.max(minimum, node!.getBoundingClientRect().height);
      savedOverflow = savedBaseline > cap + 1;
      if (!changed) overflow = savedOverflow;
    }
    const observer = new ResizeObserver(resizeBaseline);
    observer.observe(node);
    resizeBaseline();
    return () => observer.disconnect();
  });
  onMount(() => {
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    observer.observe(document.documentElement);
    let disposed = false;
    void document.fonts.ready.then(() => {
      if (!disposed) measure();
    });
    return () => {
      disposed = true;
      observer.disconnect();
    };
  });
  export function focus(options?: { end?: boolean }) {
    editor?.focus(options);
  }
  function grow(next: number) {
    if (naturalHeight !== next) naturalHeight = next;
  }
</script>

<div
  class="note-body"
  class:body-editing={editing}
  class:expanded
  bind:this={body}
  style:height={height === undefined ? undefined : `${height}px`}
>
  {#if editing}
    <div
      class="note-baseline"
      bind:this={baselineMirror}
      aria-hidden="true"
      inert
    >
      <MarkdownView source={entrySource} onopen={() => {}} />
    </div>
    <MarkdownEditor
      bind:this={editor}
      label="Edit Markdown"
      contextKey={id}
      {states}
      {source}
      {readOnly}
      {onchange}
      {onsubmit}
      {oncancel}
      {onblur}
      {onfocus}
      {oncontext}
      ongeometry={grow}
    />
  {:else}
    <div class="note-rendered" bind:this={rendered}>
      <MarkdownView source={markdown} {onopen} />
    </div>
  {/if}
</div>
{#if overflow}
  <button
    class="note-expand"
    aria-label={expanded ? 'Collapse note' : 'Expand note'}
    aria-expanded={expanded}
    disabled={readOnly}
    onmousedown={(event) => event.preventDefault()}
    onclick={() => {
      onexpand(!expanded);
    }}
    >{expanded ? 'Collapse' : 'Expand'}<span
      class="note-expand-chevron"
      class:up={expanded}
      aria-hidden="true"
    ></span></button
  >
{/if}
