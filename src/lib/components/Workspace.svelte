<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { isTauri } from '@tauri-apps/api/core';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import MarkdownEditor from './MarkdownEditor.svelte';
  import NoteList from './NoteList.svelte';
  import { WorkspaceController, type ViewState } from '../workspace/controller';
  import { nativeRepository, type Repository } from '../platform/workspace';
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
  let visibleNotes = $derived(
    filterNotes(viewState.snapshot.notes, viewState.query),
  );
  let editor = $state<MarkdownEditor>();
  let search = $state<HTMLInputElement>();
  let deleteConfirm = $state(false);
  let closeFailed = $state(false);
  let interactionBlocked = $derived(
    viewState.pending || !!viewState.preview || deleteConfirm || closeFailed,
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
      detach();
      unsubscribe();
      controller.dispose();
    };
  });
  async function navigate(id?: string) {
    const ok = id
      ? await controller.selectNote(id)
      : await controller.newNote();
    if (ok) {
      await tick();
      editor?.focus();
    }
  }
  function commands(event: KeyboardEvent) {
    if (
      event.isComposing ||
      !viewState.loaded ||
      deleteConfirm ||
      closeFailed ||
      viewState.preview
    )
      return;
    if (event.metaKey && event.key.toLowerCase() === 'n') {
      event.preventDefault();
      void navigate();
    } else if (event.metaKey && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      search?.focus();
    } else if (event.metaKey && event.key === 'Enter') {
      event.preventDefault();
      if (!viewState.preview) void controller.save();
    }
  }
  function searchKey(event: KeyboardEvent) {
    if (event.key === 'Escape' && !event.isComposing) {
      event.preventDefault();
      controller.setQuery('');
      editor?.focus();
    }
  }
  function remove() {
    if (controller.hasUnsavedDraft) deleteConfirm = true;
    else void controller.remove();
  }
  async function retryClose() {
    if (await controller.flush()) {
      closeFailed = false;
      if (isTauri()) await getCurrentWindow().destroy();
    }
  }
</script>

<svelte:window onkeydowncapture={commands} />
<main>
  <header>
    <h1>Stashpad Preview</h1>
    <span class="local-label">Local workspace</span>
  </header>
  {#if !viewState.loaded}<section aria-label="Workspace loading">
      <p role="status">{viewState.status}</p>
      {#if viewState.error}<p role="alert">{viewState.error}</p>
        <button onclick={() => controller.start()}
          >Retry loading workspace</button
        >{/if}
    </section>
  {:else}
    <div class="workspace">
      <aside aria-label="Notes and search">
        <label for="search">Search saved notes</label><input
          id="search"
          type="search"
          bind:this={search}
          value={viewState.query}
          oninput={(event) => controller.setQuery(event.currentTarget.value)}
          onkeydown={searchKey}
        /><button onclick={() => navigate()} disabled={interactionBlocked}
          >New note <kbd>⌘N</kbd></button
        ><NoteList
          notes={visibleNotes}
          selected={viewState.activeKey}
          onselect={navigate}
          disabled={interactionBlocked}
        />
      </aside>
      <section class="editing" aria-label="Note editor">
        <div class="editor-toolbar">
          <h2>{viewState.activeKey === 'compose' ? 'Compose' : 'Edit note'}</h2>
          <button
            onclick={() => controller.save()}
            disabled={interactionBlocked}>Save note <kbd>⌘↵</kbd></button
          ><button
            onclick={remove}
            disabled={viewState.activeKey === 'compose' || interactionBlocked}
            >Delete note</button
          ><button
            onclick={() => controller.undoRemove()}
            disabled={!viewState.snapshot.undoDeleteId || interactionBlocked}
            >Undo delete</button
          >
        </div>
        <MarkdownEditor
          bind:this={editor}
          contextKey={viewState.activeKey}
          source={viewState.source}
          onchange={(source) => controller.editSource(source)}
          readOnly={deleteConfirm ||
            closeFailed ||
            !!viewState.preview ||
            (viewState.pending && viewState.status !== 'Saving…')}
        />
        <p class="hint">
          Markdown stays visible. Enter adds a line. Save with ⌘Enter. Draft
          checkpoints after 300 ms.
        </p>
        <p role="status" aria-live="polite">{viewState.status}</p>
        {#if viewState.error}<div class="error">
            <p role="alert">{viewState.error}</p>
            <button
              disabled={interactionBlocked}
              onclick={() => controller.flush()}>Retry checkpoint</button
            ><button
              disabled={interactionBlocked}
              onclick={() => controller.save()}>Retry save</button
            >
          </div>{/if}
      </section>
    </div>
    <footer>
      <button onclick={() => controller.export()} disabled={interactionBlocked}
        >Export backup</button
      ><button
        onclick={() => controller.previewRestore()}
        disabled={interactionBlocked}>Restore backup</button
      ><span>Backups include notes, drafts, and deleted notes.</span>
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
            await controller.remove(true);
            editor?.focus();
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
            editor?.focus();
          }}
          disabled={viewState.pending}>Cancel restore</button
        ><button
          onclick={() => controller.restore(true)}
          disabled={viewState.pending}>Replace workspace</button
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
