<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import type { EditorState } from '@codemirror/state';
  import { isTauri } from '@tauri-apps/api/core';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import MarkdownEditor from './MarkdownEditor.svelte';
  import NoteBody from './NoteBody.svelte';
  import Icon from './Icon.svelte';
  import StashSidebar from './StashSidebar.svelte';
  import StashCard from './StashCard.svelte';
  import StashDialog from './StashDialog.svelte';
  import {
    composeKey,
    composeOwner,
    directEntries,
    createHierarchyPresentation,
  } from '../domain/hierarchy';
  import { LocationSelection } from '../workspace/selection';
  import { WorkspaceController, type ViewState } from '../workspace/controller';
  import { nativeRepository, type Repository } from '../platform/workspace';
  import { copyMarkdown, openExternal } from '../platform/actions';
  import { filterNotes } from '../domain/search';
  import { timestampPresentation } from '../domain/timestamps';
  import { attachCloseGuard } from '../platform/lifecycle';
  let {
    repository = nativeRepository,
    onready,
  }: {
    repository?: Repository;
    onready?: (controller: WorkspaceController) => void;
  } = $props();
  const controller = new WorkspaceController(untrack(() => repository));
  let viewState: ViewState = $state(controller.state);
  let selected = $state('');
  const selection = new LocationSelection();
  let editHeights = $state<Record<string, number>>({});
  let expandedNotes = $state<Record<string, boolean>>({});
  $effect(() => {
    const live = new Set(
      viewState.snapshot.notes
        .filter((n) => n.deletedAt === null)
        .map((n) => n.id),
    );
    const stale = Object.keys(expandedNotes).filter((id) => !live.has(id));
    if (stale.length)
      expandedNotes = Object.fromEntries(
        Object.entries(expandedNotes).filter(([id]) => live.has(id)),
      );
  });
  let interaction = 0;
  let creating = false;
  let composer = $state<MarkdownEditor>();
  let noteBodies = $state<Record<string, NoteBody | undefined>>({});
  let captureFenced = $state(false);
  let inlineFenced = $state(false);
  let selectedEditingContext = $state<{ id: string; fenced: boolean } | null>(
    null,
  );
  $effect(() => {
    if (
      selectedEditingContext &&
      selectedEditingContext.id !== selectedNote?.id
    )
      selectedEditingContext = null;
  });
  let search = $state<HTMLInputElement>();
  let stream = $state<HTMLElement>();
  let closeFailed = $state(false);
  let detailsOpen = $state(false);
  let detailsToggle = $state<HTMLButtonElement>();
  let detailsRail = $state<HTMLElement>();
  let composerEpochs = $state<Record<string, number>>({});
  let workspaceEpoch = $state(0);
  let stashDialog = $state<{ id: string; name: string } | null>(null);
  let dialogFocus: HTMLElement | null = null;
  let captureKey = $derived(composeKey(viewState.stashId));
  let hierarchy = $derived(
    createHierarchyPresentation(viewState.snapshot.stashes),
  );
  let currentStash = $derived(
    viewState.stashId === null
      ? undefined
      : hierarchy.index.get(viewState.stashId),
  );
  let destination = $derived(hierarchy.label(viewState.stashId).text);
  const editorStates = new Map<string, EditorState>();
  const focusRequestCleanups = new Set<() => void>();
  let disposed = false;
  let visibleNotes = $derived(
    filterNotes(viewState.snapshot.notes, viewState.query).filter(
      (n) => viewState.query.trim() || n.stashId === viewState.stashId,
    ),
  );
  let activeNote = $derived(
    viewState.snapshot.notes.find(
      (n) => n.id === viewState.activeKey && n.deletedAt === null,
    ),
  );
  let shownNotes = $derived(
    activeNote && !visibleNotes.some((n) => n.id === activeNote!.id)
      ? [activeNote, ...visibleNotes]
      : visibleNotes,
  );
  let shownEntries = $derived.by(() => {
    if (viewState.query.trim())
      return shownNotes.map((note) => ({ ...note, kind: 'note' as const }));
    const entries = directEntries(viewState.snapshot, viewState.stashId);
    return activeNote && !entries.some((x) => x.id === activeNote.id)
      ? [{ ...activeNote, kind: 'note' as const }, ...entries]
      : entries;
  });
  let modal = $derived(!!viewState.preview || closeFailed || !!stashDialog);
  let blocked = $derived(
    (viewState.operation !== null && viewState.operation !== 'save') || modal,
  );
  let editorReadOnly = $derived(
    modal || (viewState.operation !== null && viewState.operation !== 'save'),
  );
  let selectedNote = $derived(
    viewState.snapshot.notes.find(
      (n) => n.id === selected && n.deletedAt === null,
    ),
  );
  let selectedStash = $derived(
    viewState.snapshot.stashes.find((s) => s.id === selected),
  );
  function scrollSelection() {
    stream
      ?.querySelector(`[data-entry-id="${selected}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }
  async function openStash(id: string | null, preferred?: string) {
    if (blocked) return;
    const request = ++interaction,
      focus = observeSubmissionFocus();
    selection.remember(viewState.stashId, selected);
    try {
      if (await controller.openStash(id)) {
        if (request !== interaction) return;
        selected = selection.open(
          id,
          directEntries(controller.state.snapshot, id).map((e) => e.id),
          preferred,
        );
        await tick();
        scrollSelection();
        if (focus.mayRestore()) stream?.focus();
      }
    } finally {
      focus.stop();
    }
  }
  async function createStash() {
    if (blocked || creating) return;
    creating = true;
    const request = ++interaction,
      focus = observeSubmissionFocus();
    selection.remember(viewState.stashId, selected);
    try {
      if (await controller.createStash('Untitled')) {
        if (request !== interaction) return;
        selected = '';
        await tick();
        if (focus.mayRestore()) composer?.focus();
      }
    } finally {
      creating = false;
      focus.stop();
    }
  }
  function nameStash(id: string) {
    if (blocked) return;
    dialogFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    stashDialog = {
      id,
      name: viewState.snapshot.stashes.find((s) => s.id === id)?.name ?? '',
    };
  }
  async function closeStashDialog() {
    stashDialog = null;
    await tick();
    if (dialogFocus?.closest('.composer')) composer?.focus();
    else if (dialogFocus?.closest('.note-card .markdown-editor')) focusInline();
    else if (dialogFocus?.isConnected) dialogFocus.focus();
    else stream?.focus();
  }
  async function saveStash(name: string) {
    if (!stashDialog) return;
    if (await controller.renameStash(stashDialog.id, name)) {
      stashDialog = null;
      await tick();
      if (dialogFocus?.isConnected) dialogFocus.focus();
      else stream?.focus();
    }
  }
  function focusChoice(node: HTMLButtonElement) {
    node.focus();
  }
  onMount(() => {
    const unsubscribe = controller.subscribe((next) => (viewState = next));
    void controller.start().then(() => onready?.(controller));
    // CSS can drop activeElement to body before the breakpoint event arrives.
    // Remember only the current focus, and let any newer real target take precedence.
    const detailsMedia = window.matchMedia('(max-width: 1050px)');
    let narrow = detailsMedia.matches;
    let focused: HTMLElement | null = null;
    function rememberFocus(event: FocusEvent) {
      if (
        event.target instanceof HTMLElement &&
        (event.target !== document.body || detailsMedia.matches === narrow)
      )
        focused = event.target;
    }
    function forgetFocus(event: FocusEvent) {
      if (event.target !== focused) return;
      if (event.relatedTarget instanceof HTMLElement)
        focused = event.relatedTarget;
      else if (
        detailsMedia.matches === narrow &&
        focused?.getClientRects().length
      )
        focused = null;
    }
    function respondToDetailsWidth() {
      const active = document.activeElement;
      const target =
        active instanceof HTMLElement &&
        active !== document.body &&
        active !== document.documentElement
          ? active
          : focused;
      if (target?.isConnected) {
        if (
          detailsMedia.matches &&
          !detailsOpen &&
          detailsRail?.contains(target)
        )
          detailsToggle?.focus();
        else if (!detailsMedia.matches && target === detailsToggle)
          detailsRail?.focus();
      }
      narrow = detailsMedia.matches;
    }
    document.addEventListener('focusin', rememberFocus);
    document.addEventListener('focusout', forgetFocus);
    detailsMedia.addEventListener('change', respondToDetailsWidth);
    let detach = () => {};
    if (isTauri())
      detach = attachCloseGuard(
        getCurrentWindow(),
        () => controller.flush(),
        () => (closeFailed = true),
      );
    return () => {
      disposed = true;
      for (const cleanup of focusRequestCleanups) cleanup();
      document.removeEventListener('focusin', rememberFocus);
      document.removeEventListener('focusout', forgetFocus);
      detailsMedia.removeEventListener('change', respondToDetailsWidth);
      detach();
      unsubscribe();
      controller.dispose();
    };
  });
  async function compose() {
    if (blocked) return;
    const request = ++interaction,
      focus = observeSubmissionFocus();
    try {
      if (await controller.newNote()) {
        await tick();
        if (request === interaction && focus.mayRestore()) composer?.focus();
      }
    } finally {
      focus.stop();
    }
  }
  async function edit(id: string) {
    if (blocked) return;
    const request = ++interaction,
      focus = observeSubmissionFocus();
    const body = stream?.querySelector(`[data-note-id="${id}"] .note-body`);
    if (body)
      editHeights = {
        ...editHeights,
        [id]: body.getBoundingClientRect().height,
      };
    try {
      if (await controller.selectNote(id)) {
        if (request !== interaction) return;
        selected = id;
        await tick();
        if (focus.mayRestore()) focusInline();
      }
    } finally {
      focus.stop();
    }
  }
  // Blur owns no focus continuation: the newly clicked control/card owns it.
  function leaveEdit(key: string) {
    void controller.finishEdit(key, 'blur');
  }
  function observeSubmissionFocus() {
    const original = document.activeElement;
    let moved = false;
    function observe(event: FocusEvent) {
      // Disabled submit buttons and removed inline editors can fall back to body.
      // A newer focus on an actual target, including Search, owns the continuation.
      if (
        event.target instanceof Element &&
        event.target !== original &&
        event.target !== document.body &&
        event.target !== document.documentElement
      )
        moved = true;
    }
    function stop() {
      document.removeEventListener('focusin', observe);
      focusRequestCleanups.delete(stop);
    }
    document.addEventListener('focusin', observe);
    focusRequestCleanups.add(stop);
    return { mayRestore: () => !moved && !disposed, stop };
  }
  async function submit(key: string) {
    if (blocked) return;
    const focus = observeSubmissionFocus();
    try {
      const known = new Set(viewState.snapshot.notes.map((n) => n.id));
      const ok = await controller.save(key);
      if (!ok || disposed) return;
      if (composeOwner(key)) {
        if (!controller.sourceFor(key))
          composerEpochs = {
            ...composerEpochs,
            [key]: (composerEpochs[key] ?? 0) + 1,
          };
        selected =
          controller.state.snapshot.notes.find((n) => !known.has(n.id))?.id ??
          selected;
      }
      await tick();
      if (composeOwner(key)) {
        stream
          ?.querySelector(`[data-note-id="${selected}"]`)
          ?.scrollIntoView({ block: 'nearest' });
        if (focus.mayRestore() && composeKey(controller.state.stashId) === key)
          composer?.focus();
      } else if (focus.mayRestore()) {
        if (controller.state.activeKey === key) focusInline();
        else stream?.focus();
      }
    } finally {
      focus.stop();
    }
  }
  async function finishEdit() {
    if (blocked) return;
    const key = viewState.activeKey;
    const focus = observeSubmissionFocus();
    try {
      if (await controller.finishEdit(key)) {
        await tick();
        if (focus.mayRestore()) stream?.focus();
      }
    } finally {
      focus.stop();
    }
  }
  async function copy(id: string) {
    try {
      await copyMarkdown(
        id === viewState.activeKey
          ? controller.sourceFor(id)
          : (viewState.snapshot.notes.find((n) => n.id === id)?.markdown ?? ''),
      );
      controller.feedback('Markdown copied');
    } catch {
      controller.feedback(
        '',
        'Copy failed. Your source is unchanged; retry Copy Markdown.',
      );
    }
  }
  async function open(url: string) {
    if (modal) return;
    try {
      await openExternal(url);
      controller.feedback('Opened external link');
    } catch {
      controller.feedback('', 'The external link could not be opened.');
    }
  }
  function cardClick(event: MouseEvent, id: string) {
    if (
      blocked ||
      (event.target as Element).closest(
        'a,button,input,textarea,[contenteditable="true"]',
      ) ||
      window.getSelection()?.toString()
    )
      return;
    ++interaction;
    selected = id;
    selection.remember(viewState.stashId, id);
    if (activeNote && activeNote.id !== id) leaveEdit(activeNote.id);
    stream?.focus();
  }
  function cardDoubleClick(event: MouseEvent, id: string) {
    if (
      (event.target as Element).closest(
        'a,button,input,textarea,[contenteditable="true"]',
      )
    )
      return;
    void edit(id);
  }
  async function remove() {
    if (!selectedNote || blocked) return;
    if (
      viewState.activeKey !== selected &&
      !(await controller.selectNote(selected))
    )
      return;
    if (!(await controller.remove())) return;
    selected = selection.open(
      viewState.stashId,
      directEntries(controller.state.snapshot, viewState.stashId).map(
        (e) => e.id,
      ),
    );
    await tick();
    stream?.focus();
    scrollSelection();
  }
  function focusInline() {
    noteBodies[controller.state.activeKey]?.focus();
  }
  function capturePrevious() {
    if (blocked) return false;
    const note = visibleNotes.at(-1);
    if (!note) return false;
    ++interaction;
    selected = note.id;
    selection.remember(viewState.stashId, selected);
    stream?.focus();
    scrollSelection();
    return true;
  }
  function commands(event: KeyboardEvent) {
    if (
      event.isComposing ||
      event.defaultPrevented ||
      !viewState.loaded ||
      blocked ||
      event.altKey ||
      event.ctrlKey ||
      event.shiftKey
    )
      return;
    const key = event.key.toLowerCase();
    if (event.metaKey) {
      if (key === 'n') {
        event.preventDefault();
        void createStash();
      } else if (key === 'f') {
        event.preventDefault();
        search?.focus();
      } else if (
        key === 'backspace' &&
        !isTyping(event.target) &&
        !window.getSelection()?.toString()
      ) {
        event.preventDefault();
        void remove();
      }
      return;
    }
    if (isTyping(event.target) || blocked || window.getSelection()?.toString())
      return;
    if (key === ' ') {
      event.preventDefault();
      void compose();
    } else if (key === '/') {
      event.preventDefault();
      search?.focus();
    } else if (key === 'e' && selectedNote) {
      event.preventDefault();
      void edit(selected);
    } else if (key === 'x' && selectedNote && !event.repeat) {
      event.preventDefault();
      void controller.setNoteDone(selectedNote.id, !selectedNote.done);
    } else if (key === 'c' && selectedNote) {
      event.preventDefault();
      void copy(selected);
    } else if ((key === 'enter' || key === 'arrowright') && selectedStash) {
      event.preventDefault();
      void openStash(selectedStash.id);
    } else if (key === 'arrowleft' && viewState.stashId !== null) {
      event.preventDefault();
      void openStash(currentStash?.parentId ?? null, viewState.stashId);
    } else if (key === 'arrowup' || key === 'arrowdown') {
      event.preventDefault();
      const index = shownEntries.findIndex((n) => n.id === selected);
      const next =
        shownEntries[
          Math.max(
            0,
            Math.min(
              shownEntries.length - 1,
              index + (key === 'arrowup' ? -1 : 1),
            ),
          )
        ];
      if (next) {
        ++interaction;
        selected = next.id;
        selection.remember(viewState.stashId, selected);
        stream
          ?.querySelector(`[data-entry-id="${next.id}"]`)
          ?.scrollIntoView({ block: 'nearest' });
      }
    }
  }
  function isTyping(target: EventTarget | null) {
    return (
      target instanceof Element &&
      !!target.closest(
        'input,textarea,select,button,a,[contenteditable="true"],[role="textbox"]',
      )
    );
  }
  function searchKey(event: KeyboardEvent) {
    if (event.key === 'Escape' && !event.isComposing) {
      event.preventDefault();
      controller.setQuery('');
      stream?.focus();
    }
  }
  function toggleDetails() {
    if (detailsOpen && detailsRail?.contains(document.activeElement))
      detailsToggle?.focus();
    detailsOpen = !detailsOpen;
  }
  async function retryClose() {
    if (await controller.flush()) {
      closeFailed = false;
      if (isTauri()) await getCurrentWindow().destroy();
    }
  }
</script>

<svelte:window onkeydown={commands} />
<main>
  <header class="app-header">
    <h1 title={destination}>{destination}</h1>
    <span class="local-label">Local workspace</span>
    {#if viewState.loaded}<button
        class="details-toggle"
        bind:this={detailsToggle}
        aria-expanded={detailsOpen}
        aria-controls="workspace-details"
        onclick={toggleDetails}
        >Details{#if viewState.error}
          <span role="status">· error</span>{/if}</button
      >{/if}
  </header>
  {#if !viewState.loaded}
    <section aria-label="Workspace loading">
      <p role="status">{viewState.status}</p>
      {#if viewState.error}<p role="alert">{viewState.error}</p>
        <button onclick={() => controller.start()}
          >Retry loading workspace</button
        >{/if}
    </section>
  {:else}
    <div
      class="narrow-announcement"
      class:open={detailsOpen}
      aria-live="polite"
      aria-atomic="true"
    >
      {viewState.error || viewState.status}
    </div>
    <div class="workspace">
      <aside class="sidebar" aria-label="Workspace navigation">
        <div class="sidebar-search">
          <label class="sr-only" for="search">Search saved notes</label>
          <Icon name="search" />
          <input
            id="search"
            type="search"
            placeholder="Search"
            bind:this={search}
            value={viewState.query}
            oninput={(event) => controller.setQuery(event.currentTarget.value)}
            onkeydown={searchKey}
            disabled={modal}
          />
        </div>
        <StashSidebar
          presentation={hierarchy}
          currentId={viewState.stashId}
          disabled={blocked}
          onopen={(id) => void openStash(id)}
        />
        <button onclick={() => void createStash()} disabled={blocked}
          >New stash</button
        >
        <button onclick={compose} disabled={blocked}>New note</button>
        <div class="backup-actions">
          <button onclick={() => controller.export()} disabled={blocked}
            ><Icon name="download" /> Export backup</button
          ><button
            onclick={() => controller.previewRestore()}
            disabled={blocked}><Icon name="upload" /> Restore backup</button
          ><button
            onclick={() => controller.undoRemove()}
            disabled={!viewState.snapshot.undoDeleteId || blocked}
            ><Icon name="undo" /> Undo delete</button
          >
        </div>
      </aside>
      <section class="notes-column" aria-label="Notes workspace">
        <div class="stream-header">
          <span
            >{visibleNotes.length}
            {visibleNotes.length === 1 ? 'note' : 'notes'}</span
          >
        </div>
        <!-- The focusable region is the keyboard navigation surface; card selection has named controls. -->
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <section
          class="note-stream"
          aria-label="Note stream"
          tabindex="0"
          bind:this={stream}
        >
          {#each shownEntries as entry (entry.id)}
            {#if entry.kind === 'stash'}
              <StashCard
                stash={entry}
                selected={selected === entry.id}
                disabled={blocked}
                onselect={(event) => cardClick(event, entry.id)}
                onopen={() => void openStash(entry.id)}
                onrename={() => nameStash(entry.id)}
              />
            {:else}
              {@const note = entry}
              {@const updated = timestampPresentation(note.updatedAt)}
              <!-- Selection and actions are separate from rendered content and links. -->
              <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
              <article
                aria-label="Saved note"
                class:selected={selected === note.id}
                class="note-card"
                class:editing={viewState.activeKey === note.id}
                class:done={note.done}
                data-note-id={note.id}
                data-entry-id={note.id}
                onclick={(event) => cardClick(event, note.id)}
                ondblclick={(event) => cardDoubleClick(event, note.id)}
              >
                <button
                  class="note-select"
                  aria-pressed={selected === note.id}
                  disabled={blocked}
                  onclick={() => {
                    ++interaction;
                    selected = note.id;
                    selection.remember(viewState.stashId, selected);
                    if (activeNote && activeNote.id !== note.id)
                      leaveEdit(activeNote.id);
                    stream?.focus();
                  }}
                  aria-label="Select note"
                  title="Select note"
                ></button>
                {#if note.done}<span class="sr-only">Done</span>{/if}
                <div class="note-meta">
                  <time datetime={updated.datetime}>{updated.label}</time>
                  {#if selected === note.id && viewState.activeKey !== note.id}<div
                      class="card-actions"
                    >
                      {#if viewState.activeKey !== note.id}<button
                          disabled={blocked}
                          onclick={() => edit(note.id)}
                          aria-label="Edit note"
                          title="Edit note"
                        >
                          <svg viewBox="0 0 16 16" aria-hidden="true"
                            ><path d="m3 10 7-7 3 3-7 7-4 1zM9 4l3 3" /></svg
                          >
                        </button>{/if}
                      <button
                        disabled={blocked}
                        onclick={() =>
                          controller.setNoteDone(note.id, !note.done)}
                        aria-label="Mark done"
                        title={note.done
                          ? 'Mark not done (X)'
                          : 'Mark done (X)'}
                        aria-pressed={note.done}
                        ><svg viewBox="0 0 16 16" aria-hidden="true"
                          ><path d="M3 3h10v10H3z" />{#if note.done}<path
                              d="m5 8 2 2 4-4"
                            />{/if}</svg
                        ></button
                      >
                      <button
                        disabled={blocked}
                        onclick={() => copy(note.id)}
                        aria-label="Copy Markdown"
                        title="Copy Markdown"
                      >
                        <svg viewBox="0 0 16 16" aria-hidden="true"
                          ><path d="M6 5h7v9H6zM3 11H2V2h7v1" /></svg
                        >
                      </button>
                      <button
                        disabled={blocked}
                        onclick={remove}
                        aria-label="Delete note"
                        title="Delete note"
                      >
                        <svg viewBox="0 0 16 16" aria-hidden="true"
                          ><path
                            d="M3 4h10M6 4V2h4v2M4 4l1 10h6l1-10M7 6v6M9 6v6"
                          /></svg
                        >
                      </button>
                    </div>{/if}
                </div>
                {#if viewState.query.trim()}<p class="note-location">
                    {hierarchy.label(note.stashId).text}
                  </p>{/if}
                {#if viewState.activeKey === note.id && !visibleNotes.some((n) => n.id === note.id)}<p
                    class="editing-outside"
                  >
                    Editing outside search results
                  </p>{/if}
                <NoteBody
                  bind:this={noteBodies[note.id]}
                  expanded={expandedNotes[note.id] ?? false}
                  onexpand={(expanded) =>
                    (expandedNotes = { ...expandedNotes, [note.id]: expanded })}
                  id={note.id}
                  markdown={note.markdown}
                  source={viewState.buffers[note.id]?.source ?? note.markdown}
                  editing={viewState.activeKey === note.id}
                  baseline={editHeights[note.id]}
                  states={editorStates}
                  readOnly={editorReadOnly}
                  onchange={(source) => controller.editContext(note.id, source)}
                  onsubmit={() => submit(note.id)}
                  oncancel={finishEdit}
                  onblur={() => leaveEdit(note.id)}
                  onfocus={() => controller.retainEdit(note.id)}
                  oncontext={(fenced) => {
                    inlineFenced = fenced;
                    selectedEditingContext = { id: note.id, fenced };
                  }}
                  onopen={open}
                />
              </article>
            {/if}
          {/each}
          {#if !shownEntries.length}<p class="empty-stream">
              {viewState.query
                ? 'No saved notes match your search.'
                : 'Capture your first note below.'}
            </p>{/if}
        </section>
        <section class="composer" aria-label="Capture note">
          <div class="composer-toolbar">
            <button
              onclick={() => submit(captureKey)}
              disabled={blocked}
              aria-label="Save note"
              title={captureFenced ? 'Save note' : 'Save note (Enter)'}
              >➤</button
            >
          </div>
          <MarkdownEditor
            bind:this={composer}
            label="Capture Markdown"
            contextKey={captureKey +
              ':workspace:' +
              workspaceEpoch +
              ':epoch:' +
              (composerEpochs[captureKey] ?? 0)}
            states={editorStates}
            source={viewState.buffers[captureKey]?.source ?? ''}
            readOnly={editorReadOnly}
            onchange={(source) => controller.editContext(captureKey, source)}
            onsubmit={() => submit(captureKey)}
            oncancel={() => stream?.focus()}
            onup={capturePrevious}
            oncontext={(fenced) => (captureFenced = fenced)}
          />
          <p class="hint">
            {#if captureFenced}
              Enter adds a code line · Move outside code to save
            {:else}
              <span
                ><span class="sr-only">Enter saves</span><span
                  aria-hidden="true"><kbd>Enter</kbd> saves</span
                ></span
              >
              ·
              <span
                ><span class="sr-only">Shift Enter adds a line</span><span
                  aria-hidden="true"
                  ><span class="shortcut-keys"
                    ><kbd>Shift</kbd><kbd>Enter</kbd></span
                  > adds a line</span
                ></span
              >
            {/if}
            ·
            <span
              ><span class="sr-only">Escape returns to notes</span><span
                aria-hidden="true"><kbd>Esc</kbd> returns to notes</span
              ></span
            >
          </p>
        </section>
      </section>
      <aside
        id="workspace-details"
        class="details-rail"
        bind:this={detailsRail}
        tabindex="-1"
        class:open={detailsOpen}
        aria-label="Note details"
      >
        <h2>Details and shortcuts</h2>
        <p>
          {visibleNotes.length}
          {visibleNotes.length === 1 ? 'note' : 'notes'} · Local workspace
        </p>
        {#if selectedNote}{@const created = timestampPresentation(
            selectedNote.createdAt,
            'full',
          )}
          <p>
            Created <time datetime={created.datetime}>{created.label}</time>
          </p>{/if}
        <div class="shortcut-list" aria-label="Keyboard shortcuts">
          <div>
            <span>New stash</span><span class="shortcut-keys"
              ><kbd>⌘</kbd><kbd>N</kbd></span
            >
          </div>
          <div><span>New note / Focus capture</span><kbd>Space</kbd></div>
          <div>
            <span aria-hidden="true">Search</span><span class="sr-only"
              >Search: Command F or slash</span
            ><span class="shortcut-keys" aria-hidden="true"
              ><kbd>⌘</kbd><kbd>F</kbd><span aria-hidden="true">/</span><kbd
                >/</kbd
              ></span
            >
          </div>
          <div>
            <span aria-hidden="true">Select note</span><span class="sr-only"
              >Select note: up or down arrow</span
            ><span class="shortcut-keys" aria-hidden="true"
              ><kbd>↑</kbd><kbd>↓</kbd></span
            >
          </div>
          <div>
            <span aria-hidden="true">Edit / Copy</span><span class="sr-only"
              >Edit: E; Copy: C</span
            ><span class="shortcut-keys" aria-hidden="true"
              ><kbd>E</kbd><span aria-hidden="true">/</span><kbd>C</kbd></span
            >
          </div>
          <div><span>Mark done / not done</span><kbd>X</kbd></div>
          <div>
            <span aria-hidden="true">Delete selected</span><span class="sr-only"
              >Delete selected: Command Backspace</span
            ><span class="shortcut-keys" aria-hidden="true"
              ><kbd>⌘</kbd><kbd>⌫</kbd></span
            >
          </div>
        </div>
        {#if activeNote || (selectedNote && selectedEditingContext?.id === selectedNote.id)}<p
            class="inline-hint"
            aria-label="Inline editing keys"
          >
            <strong
              >{activeNote
                ? 'Editing shortcuts'
                : 'Selected note editing'}</strong
            ><br />
            {(activeNote ? inlineFenced : selectedEditingContext?.fenced)
              ? 'Enter adds a code line · Move outside code to finish editing'
              : 'Enter finishes editing · Shift Enter adds a line'}
          </p>{/if}
        <section class="workspace-feedback" aria-label="Workspace status">
          <h2><Icon name="info" /> Workspace status</h2>
          <p>
            Shows the latest local action, including this device’s note saves
            and capture draft checkpoints. It does not indicate online
            synchronization.
          </p>
          <p role="status" aria-live="polite">{viewState.status}</p>
          <p role="alert">{viewState.error}</p>
          {#if viewState.completionRetry}<button
              disabled={blocked}
              onclick={() => controller.retryCompletion()}
              >Retry completion</button
            >
          {:else if viewState.error}<button
              disabled={blocked}
              onclick={() => controller.flush()}>Retry checkpoint</button
            ><button
              disabled={blocked}
              onclick={() => submit(viewState.activeKey)}>Retry save</button
            >{/if}
        </section>
      </aside>
    </div>
    {#if stashDialog}<StashDialog
        title="Rename stash"
        initial={stashDialog.name}
        busy={viewState.operation !== null}
        error={viewState.error}
        onsubmit={saveStash}
        oncancel={() => void closeStashDialog()}
      />{/if}
    {#if viewState.preview}<section
        class="confirmation"
        aria-label="Replace workspace?"
      >
        <h2>Replace workspace?</h2>
        <p>
          {viewState.preview.notes} notes, {viewState.preview.stashes} stashes, and
          {viewState.preview.drafts} drafts.
        </p>
        <p>{viewState.preview.warning}</p>
        <button
          use:focusChoice
          onclick={async () => {
            await controller.restore(false);
            await tick();
            composer?.focus();
          }}
          disabled={viewState.operation !== null}>Cancel restore</button
        ><button
          onclick={async () => {
            if (await controller.restore(true)) {
              selectedEditingContext = null;
              expandedNotes = {};
              editHeights = {};
              workspaceEpoch++;
              composerEpochs = {};
              selected = '';
              await tick();
              editorStates.clear();
              selection.clear();
              composer?.focus();
            }
          }}
          disabled={viewState.operation !== null}>Replace workspace</button
        >
      </section>{/if}
    {#if closeFailed}<section
        class="confirmation"
        aria-label="Draft could not be saved"
      >
        <h2>Draft could not be saved</h2>
        <p>
          The window stays open. Retry the checkpoint, or explicitly discard
          uncheckpointed input and close.
        </p>
        <button use:focusChoice onclick={retryClose}>Retry and close</button
        ><button onclick={() => (closeFailed = false)}>Keep window open</button
        ><button onclick={() => getCurrentWindow().destroy()}
          >Discard and close</button
        >
      </section>{/if}
  {/if}
</main>
