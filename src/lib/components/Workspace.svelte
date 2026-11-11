<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import type { EditorState } from '@codemirror/state';
  import { isTauri } from '@tauri-apps/api/core';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import MarkdownEditor from './MarkdownEditor.svelte';
  import MarkdownView from './MarkdownView.svelte';
  import { WorkspaceController, type ViewState } from '../workspace/controller';
  import { nativeRepository, type Repository } from '../platform/workspace';
  import { copyMarkdown, openExternal } from '../platform/actions';
  import { filterNotes } from '../domain/search';
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
  let composer = $state<MarkdownEditor>();
  let editor = $state<MarkdownEditor>();
  let search = $state<HTMLInputElement>();
  let stream = $state<HTMLElement>();
  let deleteConfirm = $state(false);
  let closeFailed = $state(false);
  let composerEpoch = $state(0);
  const editorStates = new Map<string, EditorState>();
  const focusRequestCleanups = new Set<() => void>();
  let disposed = false;
  let visibleNotes = $derived(
    filterNotes(viewState.snapshot.notes, viewState.query),
  );
  let activeNote = $derived(
    viewState.snapshot.notes.find(
      (n) => n.id === viewState.activeKey && !n.deletedAt,
    ),
  );
  let shownNotes = $derived(
    activeNote && !visibleNotes.some((n) => n.id === activeNote!.id)
      ? [activeNote, ...visibleNotes]
      : visibleNotes,
  );
  let modal = $derived(!!viewState.preview || deleteConfirm || closeFailed);
  let blocked = $derived(viewState.operation !== null || modal);
  let editorReadOnly = $derived(
    modal || (viewState.operation !== null && viewState.operation !== 'save'),
  );
  let selectedNote = $derived(
    viewState.snapshot.notes.find((n) => n.id === selected && !n.deletedAt),
  );
  function focusChoice(node: HTMLButtonElement) {
    node.focus();
  }
  onMount(() => {
    const unsubscribe = controller.subscribe((next) => (viewState = next));
    void controller.start().then(() => onready?.(controller));
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
      detach();
      unsubscribe();
      controller.dispose();
    };
  });
  async function compose() {
    if (blocked) return;
    if (await controller.newNote()) {
      await tick();
      composer?.focus();
    }
  }
  async function edit(id: string) {
    if (blocked) return;
    if (await controller.selectNote(id)) {
      selected = id;
      await tick();
      editor?.focus();
    }
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
      if (key === 'compose') {
        if (!controller.sourceFor('compose')) composerEpoch++;
        selected =
          controller.state.snapshot.notes.find((n) => !known.has(n.id))?.id ??
          selected;
      }
      await tick();
      if (key !== 'compose' && controller.state.activeKey === 'compose')
        editorStates.delete(key);
      if (key === 'compose') {
        stream
          ?.querySelector(`[data-note-id="${selected}"]`)
          ?.scrollIntoView({ block: 'nearest' });
        if (focus.mayRestore()) composer?.focus();
      } else if (focus.mayRestore()) {
        if (controller.state.activeKey === key) editor?.focus();
        else stream?.focus();
      }
    } finally {
      focus.stop();
    }
  }
  async function cancelEdit() {
    if (blocked) return;
    const key = viewState.activeKey;
    if (await controller.cancelEdit()) {
      await tick();
      editorStates.delete(key);
      stream?.focus();
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
    selected = id;
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
    if (!selected || blocked) return;
    if (
      viewState.activeKey !== selected &&
      !(await controller.selectNote(selected))
    )
      return;
    if (controller.hasUnsavedDraft) deleteConfirm = true;
    else {
      if (!(await controller.remove())) return;
      selected = '';
      await tick();
      stream?.focus();
    }
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
        void compose();
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
    } else if (key === 'c' && selectedNote) {
      event.preventDefault();
      void copy(selected);
    } else if (key === 'arrowup' || key === 'arrowdown') {
      event.preventDefault();
      const index = visibleNotes.findIndex((n) => n.id === selected);
      const next =
        visibleNotes[
          Math.max(
            0,
            Math.min(
              visibleNotes.length - 1,
              index + (key === 'arrowup' ? -1 : 1),
            ),
          )
        ];
      if (next) {
        selected = next.id;
        stream
          ?.querySelector(`[data-note-id="${next.id}"]`)
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
    <h1>Stashpad Preview</h1>
    <span class="local-label">Local workspace</span>
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
    <div class="workspace">
      <aside class="sidebar" aria-label="Workspace navigation">
        <h2>Home / Notes</h2>
        <button onclick={compose} disabled={blocked}
          >New note <kbd>⌘N</kbd></button
        >
        <label for="search">Search saved notes</label><input
          id="search"
          type="search"
          bind:this={search}
          value={viewState.query}
          oninput={(event) => controller.setQuery(event.currentTarget.value)}
          onkeydown={searchKey}
          disabled={modal}
        />
        <p class="hint">
          ⌘F or / Search · Space Capture<br />↑ ↓ Select · E Edit · C Copy<br
          />⌘⌫ Delete selected note
        </p>
        <div class="backup-actions">
          <button onclick={() => controller.export()} disabled={blocked}
            >Export backup</button
          ><button
            onclick={() => controller.previewRestore()}
            disabled={blocked}>Restore backup</button
          ><button
            onclick={() => controller.undoRemove()}
            disabled={!viewState.snapshot.undoDeleteId || blocked}
            >Undo delete</button
          >
        </div>
      </aside>
      <section class="notes-column" aria-label="Notes workspace">
        <div class="stream-header">
          <h2>Notes</h2>
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
          {#each shownNotes as note (note.id)}
            <!-- Selection and actions are separate from rendered content and links. -->
            <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
            <article
              aria-label="Saved note"
              class:selected={selected === note.id}
              class="note-card"
              data-note-id={note.id}
              onclick={(event) => cardClick(event, note.id)}
              ondblclick={(event) => cardDoubleClick(event, note.id)}
            >
              <div class="note-meta">
                <button
                  aria-pressed={selected === note.id}
                  disabled={blocked}
                  onclick={() => {
                    selected = note.id;
                    stream?.focus();
                  }}>Select note</button
                ><time datetime={new Date(note.updatedAt).toISOString()}
                  >{new Date(note.updatedAt).toLocaleString(undefined, {
                    month: 'short',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit',
                  })}</time
                >{#if viewState.snapshot.drafts.some((d) => d.key === note.id)}<span
                    >Unfinished edit</span
                  >{/if}
              </div>
              {#if viewState.activeKey === note.id}
                {#if !visibleNotes.some((n) => n.id === note.id)}<p
                    class="editing-outside"
                  >
                    Editing outside search results
                  </p>{/if}
                <MarkdownEditor
                  bind:this={editor}
                  label="Edit Markdown"
                  contextKey={note.id}
                  states={editorStates}
                  source={viewState.buffers[note.id]?.source ?? note.markdown}
                  readOnly={editorReadOnly}
                  onchange={(source) => controller.editContext(note.id, source)}
                  onsubmit={() => submit(note.id)}
                  oncancel={cancelEdit}
                />
                <div class="note-actions">
                  <button disabled={blocked} onclick={() => submit(note.id)}
                    >Save edit</button
                  ><button disabled={blocked} onclick={cancelEdit}
                    >Cancel edit</button
                  >
                </div>
              {:else}<MarkdownView source={note.markdown} onopen={open} />{/if}
              {#if selected === note.id}<div class="note-actions">
                  {#if viewState.activeKey !== note.id}<button
                      disabled={blocked}
                      onclick={() => edit(note.id)}>Edit note</button
                    >{/if}<button
                    disabled={blocked}
                    onclick={() => copy(note.id)}>Copy Markdown</button
                  ><button disabled={blocked} onclick={remove}
                    >Delete note</button
                  >
                </div>{/if}
            </article>
          {/each}
          {#if !shownNotes.length}<p class="empty-stream">
              {viewState.query
                ? 'No saved notes match your search.'
                : 'Capture your first note below.'}
            </p>{/if}
        </section>
        <section class="composer" aria-label="Capture note">
          <div class="composer-toolbar">
            <h2>Capture</h2>
            <button onclick={() => submit('compose')} disabled={blocked}
              >Save note <kbd>↵</kbd></button
            >
          </div>
          <MarkdownEditor
            bind:this={composer}
            label="Capture Markdown"
            contextKey={'compose:' + composerEpoch}
            source={viewState.buffers.compose?.source ?? ''}
            readOnly={editorReadOnly}
            onchange={(source) => controller.editContext('compose', source)}
            onsubmit={() => submit('compose')}
            oncancel={() => stream?.focus()}
          />
          <p class="hint">
            Enter saves · Shift+Enter adds a line · ⌘Enter saves · Esc returns
            to notes
          </p>
        </section>
      </section>
      <aside class="details-rail" aria-label="Note details">
        <h2>Local notes</h2>
        <p>
          Markdown source stays editable. Select a card to edit, copy, or delete
          it.
        </p>
        {#if selectedNote}<p>
            Created {new Date(selectedNote.createdAt).toLocaleString()}
          </p>{/if}
      </aside>
    </div>
    <footer class="workspace-feedback">
      <p role="status" aria-live="polite">{viewState.status}</p>
      <p role="alert">{viewState.error}</p>
      {#if viewState.error}<button
          disabled={blocked}
          onclick={() => controller.flush()}>Retry checkpoint</button
        ><button disabled={blocked} onclick={() => submit(viewState.activeKey)}
          >Retry save</button
        >{/if}
    </footer>
    {#if deleteConfirm}<section
        class="confirmation"
        aria-label="Discard unsaved draft?"
      >
        <h2>Discard unsaved draft?</h2>
        <p>
          Delete the saved note and discard its unfinished edit? Undo restores
          only the saved source.
        </p>
        <button
          use:focusChoice
          onclick={async () => {
            deleteConfirm = false;
            await tick();
            editor?.focus();
          }}>Keep editing</button
        ><button
          onclick={async () => {
            deleteConfirm = false;
            const key = viewState.activeKey;
            if (!(await controller.remove(true))) return;
            selected = '';
            await tick();
            editorStates.delete(key);
            stream?.focus();
          }}>Discard draft and delete</button
        >
      </section>{/if}
    {#if viewState.preview}<section
        class="confirmation"
        aria-label="Replace workspace?"
      >
        <h2>Replace workspace?</h2>
        <p>
          {viewState.preview.notes} notes and {viewState.preview.drafts} drafts.
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
              composerEpoch++;
              selected = '';
              await tick();
              editorStates.clear();
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
