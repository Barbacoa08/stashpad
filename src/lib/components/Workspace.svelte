<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import type { ColorToken, Location } from '../domain/notes';
  import type { EditorState } from '@codemirror/state';
  import { isTauri } from '@tauri-apps/api/core';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import MarkdownEditor from './MarkdownEditor.svelte';
  import ItemCard from './ItemCard.svelte';
  import ColorPalette from './ColorPalette.svelte';
  import { SiblingDrag, siblingDragType } from '../workspace/sibling-drag';
  import type { ReorderItem } from '../platform/workspace';
  import Icon from './Icon.svelte';
  import StashSidebar from './StashSidebar.svelte';
  import {
    composeKey,
    composeOwner,
    directEntries,
    createHierarchyPresentation,
    effectiveScope,
    scopeIndex,
    itemLabel,
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
    const live = new Set(viewState.snapshot.items.map((n) => n.id));
    const stale = Object.keys(expandedNotes).filter((id) => !live.has(id));
    if (stale.length)
      expandedNotes = Object.fromEntries(
        Object.entries(expandedNotes).filter(([id]) => live.has(id)),
      );
  });
  let palette = $state<{ id: string; returnTo: HTMLElement | null } | null>(
    null,
  );
  const siblingDrag = new SiblingDrag();
  let dragGuide = $state<{ id: string; edge: 'before' | 'after' } | null>(null);
  function clearDrag() {
    siblingDrag.clear();
    dragGuide = null;
  }
  let interaction = 0;
  let creating = false;
  let composer = $state<MarkdownEditor>();
  let noteBodies = $state<Record<string, ItemCard | undefined>>({});
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
  let commandHeld = $state(false);
  let hintFocus = $state.raw<EventTarget | null>(null);
  let hintTextSelected = $state(false);
  let detailsToggle = $state<HTMLButtonElement>();
  let detailsRail = $state<HTMLElement>();
  let composerEpochs = $state<Record<string, number>>({});
  let workspaceEpoch = $state(0);
  let captureKey = $derived(composeKey(viewState.location));
  let metadataView = $derived(
    JSON.stringify([
      captureKey,
      viewState.location.scope,
      viewState.query,
      workspaceEpoch,
    ]),
  );
  $effect(() => {
    // A drag belongs to one exact view, including its search and replacement epoch.
    void metadataView;
    clearDrag();
    palette = null;
  });
  let scopes = $derived(scopeIndex(viewState.snapshot.items));
  let hierarchy = $derived(
    createHierarchyPresentation(
      viewState.snapshot.items.filter(
        (x) => x.kind === 'stash' && scopes.get(x.id) === 'live',
      ),
    ),
  );
  let locationHierarchy = $derived(
    createHierarchyPresentation(
      viewState.snapshot.items.filter(
        (x) =>
          x.kind === 'stash' && scopes.get(x.id) === viewState.location.scope,
      ),
      viewState.location.scope === 'trash' ? 'Trash' : 'Home',
    ),
  );
  let deletionRoot = $derived.by(() => {
    let item = selectedNote ?? currentStash;
    const index = new Map(viewState.snapshot.items.map((x) => [x.id, x]));
    while (item && item.deletedAt === null && item.parentId !== null)
      item = index.get(item.parentId);
    return item?.deletedAt !== null ? item : undefined;
  });
  let currentStash = $derived(
    viewState.stashId === null
      ? undefined
      : viewState.snapshot.items.find((x) => x.id === viewState.stashId),
  );
  let destination = $derived(locationHierarchy.label(viewState.stashId).text);
  const editorStates = new Map<string, EditorState>();
  const focusRequestCleanups = new Set<() => void>();
  let disposed = false;
  let visibleNotes = $derived(
    filterNotes(
      viewState.snapshot.items,
      viewState.query,
      viewState.location.scope,
    ).filter((n) => viewState.query.trim() || n.parentId === viewState.stashId),
  );
  let activeNote = $derived(
    viewState.snapshot.items.find((n) => n.id === viewState.activeKey),
  );
  let shownNotes = $derived(
    activeNote && !visibleNotes.some((n) => n.id === activeNote!.id)
      ? [activeNote, ...visibleNotes]
      : visibleNotes,
  );
  let shownEntries = $derived.by(() => {
    if (viewState.query.trim()) return shownNotes;
    const entries = directEntries(viewState.snapshot, viewState.location);
    return activeNote && !entries.some((x) => x.id === activeNote.id)
      ? [activeNote, ...entries]
      : entries;
  });
  let modal = $derived(!!viewState.preview || closeFailed);
  let blocked = $derived(
    (viewState.operation !== null && viewState.operation !== 'save') || modal,
  );
  let editorReadOnly = $derived(
    modal || (viewState.operation !== null && viewState.operation !== 'save'),
  );
  let selectedNote = $derived(
    viewState.snapshot.items.find((n) => n.id === selected),
  );
  let showCommandHints = $derived(
    commandHeld && viewState.loaded && !blocked && !palette,
  );
  let streamCommandHint = $derived.by(() => {
    const hints = ['⌘N New stash'];
    const selectedVisible = shownEntries.some((x) => x.id === selected);
    const typing = isTyping(hintFocus);
    // Handles have their own Command-arrow binding; other controls use the
    // existing window command's typing guard, including for Delete.
    const handleId =
      hintFocus instanceof Element && hintFocus.closest('.drag-handle')
        ? hintFocus.closest('[data-entry-id]')?.getAttribute('data-entry-id')
        : null;
    if (!hintTextSelected && !viewState.query.trim()) {
      const id = handleId ?? (!typing && selectedVisible ? selected : null);
      const siblings = directEntries(viewState.snapshot, viewState.location);
      const index = siblings.findIndex((x) => x.id === id);
      const up = index > 0;
      const down = index >= 0 && index < siblings.length - 1;
      if (up || down)
        hints.push(`⌘${up && down ? '↑/↓' : up ? '↑' : '↓'} Reorder`);
    }
    if (selectedVisible && !typing && !hintTextSelected)
      hints.push('⌘⌫ Delete');
    return hints.join(' · ');
  });
  function updateHintContext() {
    // DOM removal/reordering can emit blur during a Svelte render. Observe
    // the settled focus outside that render, without retaining stale targets.
    queueMicrotask(() => {
      if (disposed) return;
      hintFocus = document.activeElement;
      hintTextSelected = !!window.getSelection()?.toString();
    });
  }
  function scrollSelection() {
    stream
      ?.querySelector(`[data-entry-id="${selected}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }
  async function openStash(
    id: string | null,
    preferred?: string,
    scope: Location['scope'] = 'live',
  ) {
    if (blocked) return;
    const request = ++interaction,
      focus = observeSubmissionFocus();
    selection.remember(viewState.location, selected);
    try {
      if (
        await (id === null
          ? controller.openLocation({ scope, itemId: null })
          : controller.enterItem(id))
      ) {
        if (request !== interaction) return;
        selected = selection.open(
          controller.state.location,
          directEntries(
            controller.state.snapshot,
            controller.state.location,
          ).map((e) => e.id),
          preferred,
        );
        await tick();
        scrollSelection();
        if (focus.mayRestore()) {
          if (selected) stream?.focus();
          else composer?.focus();
        }
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
    selection.remember(viewState.location, selected);
    try {
      if (
        await controller.createStash(
          shownEntries.some((x) => x.id === selected) ? selected : undefined,
        )
      ) {
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
    // Capture only global navigation keys before CodeMirror's comment keymap.
    window.addEventListener('keydown', globalCommands, true);
    window.addEventListener('keyup', releaseCommand);
    window.addEventListener('blur', clearCommand);
    window.addEventListener('dragend', clearDrag);
    window.addEventListener('drop', clearDrag);
    document.addEventListener('visibilitychange', clearCommand);
    updateHintContext();
    document.addEventListener('focusin', updateHintContext);
    document.addEventListener('focusout', updateHintContext);
    document.addEventListener('selectionchange', updateHintContext);
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
      clearCommand();
      clearDrag();
      window.removeEventListener('dragend', clearDrag);
      window.removeEventListener('drop', clearDrag);
      window.removeEventListener('keydown', globalCommands, true);
      window.removeEventListener('keyup', releaseCommand);
      window.removeEventListener('blur', clearCommand);
      document.removeEventListener('visibilitychange', clearCommand);
      for (const cleanup of focusRequestCleanups) cleanup();
      document.removeEventListener('focusin', updateHintContext);
      document.removeEventListener('focusout', updateHintContext);
      document.removeEventListener('selectionchange', updateHintContext);
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
  async function edit(id: string, end = false) {
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
        if (focus.mayRestore()) focusInline({ end });
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
      const known = new Set(viewState.snapshot.items.map((n) => n.id));
      const ok = await controller.save(key);
      if (!ok || disposed) return;
      if (composeOwner(key)) {
        if (!controller.sourceFor(key))
          composerEpochs = {
            ...composerEpochs,
            [key]: (composerEpochs[key] ?? 0) + 1,
          };
        selected =
          controller.state.snapshot.items.find((n) => !known.has(n.id))?.id ??
          selected;
      }
      await tick();
      if (composeOwner(key)) {
        stream
          ?.querySelector(`[data-note-id="${selected}"]`)
          ?.scrollIntoView({ block: 'nearest' });
        if (focus.mayRestore() && composeKey(controller.state.location) === key)
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
          : (viewState.snapshot.items.find((n) => n.id === id)?.markdown ?? ''),
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
    selection.remember(viewState.location, id);
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
  function currentEntries() {
    const state = controller.state;
    return state.query.trim()
      ? filterNotes(state.snapshot.items, state.query, state.location.scope)
      : directEntries(state.snapshot, state.location);
  }
  async function remove() {
    if (!selectedNote || blocked) return;
    const id = selected,
      ordinal = shownEntries.findIndex((x) => x.id === id),
      request = ++interaction,
      focus = observeSubmissionFocus();
    try {
      if (!(await controller.remove(id)) || request !== interaction) return;
      const entries = currentEntries();
      selected =
        entries[Math.min(Math.max(ordinal, 0), entries.length - 1)]?.id ?? '';
      selection.remember(controller.state.location, selected);
      await tick();
      if (focus.mayRestore()) {
        if (selected) stream?.focus();
        else composer?.focus();
      }
      scrollSelection();
    } finally {
      focus.stop();
    }
  }
  async function clearStreamSelection(event: MouseEvent) {
    if (
      event.target !== event.currentTarget ||
      blocked ||
      window.getSelection()?.toString()
    )
      return;
    const request = ++interaction,
      focus = observeSubmissionFocus();
    try {
      if (!(await controller.finishEdit()) || request !== interaction) return;
      selected = '';
      await tick();
      if (focus.mayRestore()) stream?.focus();
    } finally {
      focus.stop();
    }
  }
  async function retryAction() {
    if (blocked) return;
    clearDrag();
    const ordinal = shownEntries.findIndex((x) => x.id === selected),
      before = JSON.stringify(controller.state.location),
      request = ++interaction,
      focus = observeSubmissionFocus();
    try {
      if (!(await controller.retryMutation()) || request !== interaction)
        return;
      const entries = currentEntries();
      if (before !== JSON.stringify(controller.state.location))
        selected = selection.open(
          controller.state.location,
          entries.map((x) => x.id),
        );
      else if (!entries.some((x) => x.id === selected))
        selected =
          entries[Math.min(Math.max(ordinal, 0), entries.length - 1)]?.id ?? '';
      await tick();
      if (focus.mayRestore()) {
        if (selected) stream?.focus();
        else composer?.focus();
      }
      scrollSelection();
    } finally {
      focus.stop();
    }
  }
  async function restoreSelected() {
    if (!selectedNote || blocked) return;
    clearDrag();
    const id = selectedNote.id,
      ordinal = shownEntries.findIndex((x) => x.id === id),
      request = ++interaction,
      focus = observeSubmissionFocus();
    try {
      if (!(await controller.restoreItem(id)) || request !== interaction)
        return;
      const entries = currentEntries();
      if (!entries.some((x) => x.id === selected))
        selected =
          entries[Math.min(Math.max(ordinal, 0), entries.length - 1)]?.id ?? '';
      selection.remember(controller.state.location, selected);
      await tick();
      if (focus.mayRestore()) {
        if (controller.state.activeKey === selected && selected) focusInline();
        else if (selected) stream?.focus();
        else composer?.focus();
      }
      scrollSelection();
    } finally {
      focus.stop();
    }
  }
  async function undoDelete() {
    if (blocked) return;
    clearDrag();
    const id = controller.state.snapshot.undoDeleteId,
      ordinal = shownEntries.findIndex((x) => x.id === selected),
      request = ++interaction,
      focus = observeSubmissionFocus();
    try {
      if (!(await controller.undoRemove()) || request !== interaction) return;
      const entries = currentEntries();
      if (id && entries.some((x) => x.id === id)) selected = id;
      else if (!entries.some((x) => x.id === selected))
        selected =
          entries[Math.min(Math.max(ordinal, 0), entries.length - 1)]?.id ?? '';
      selection.remember(controller.state.location, selected);
      await tick();
      scrollSelection();
      if (focus.mayRestore()) {
        if (selected) stream?.focus();
        else composer?.focus();
      }
    } finally {
      focus.stop();
    }
  }
  function openPalette() {
    if (
      blocked ||
      !selectedNote ||
      !shownEntries.some((x) => x.id === selected)
    )
      return;
    palette = {
      id: selectedNote.id,
      returnTo:
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null,
    };
  }
  function closePalette(returnFocus: boolean) {
    const previous = palette;
    palette = null;
    if (returnFocus && previous) {
      if (
        previous.returnTo?.isConnected &&
        previous.returnTo.getClientRects().length
      )
        previous.returnTo.focus();
      else stream?.focus();
    }
  }
  async function chooseColor(color: ColorToken | null) {
    const id = palette?.id;
    return !!id && !blocked && controller.setItemColor(id, color);
  }
  async function moveItem(request: ReorderItem) {
    if (blocked || viewState.query.trim()) return;
    const intent = ++interaction,
      before = JSON.stringify(controller.state.location),
      query = controller.state.query;
    const original = document.activeElement,
      focus = observeSubmissionFocus();
    try {
      if (
        !(await controller.reorderItem(request)) ||
        intent !== interaction ||
        before !== JSON.stringify(controller.state.location) ||
        query !== controller.state.query
      )
        return;
      selected = request.id;
      selection.remember(controller.state.location, selected);
      await tick();
      scrollSelection();
      if (focus.mayRestore()) {
        if (
          original instanceof HTMLButtonElement &&
          original.classList.contains('drag-handle') &&
          original.isConnected
        )
          original.focus();
        else stream?.focus();
      }
    } finally {
      focus.stop();
    }
  }
  function moveKey(event: KeyboardEvent, id: string) {
    if (
      !event.metaKey ||
      event.altKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.repeat ||
      event.isComposing ||
      event.defaultPrevented ||
      blocked ||
      window.getSelection()?.toString() ||
      !['ArrowUp', 'ArrowDown'].includes(event.key)
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    if (viewState.query.trim()) {
      controller.feedback(
        'Open the containing stash to reorder search results.',
      );
      return;
    }
    const siblings = directEntries(
      controller.state.snapshot,
      controller.state.location,
    );
    const from = siblings.findIndex((x) => x.id === id),
      toIndex = from + (event.key === 'ArrowUp' ? -1 : 1);
    if (from < 0 || toIndex < 0 || toIndex >= siblings.length) return;
    void moveItem({ id, group: { ...controller.state.location }, toIndex });
  }
  function startDrag(event: DragEvent, id: string) {
    if (blocked || viewState.query.trim() || !event.dataTransfer) {
      event.preventDefault();
      return;
    }
    ++interaction;
    selected = id;
    selection.remember(viewState.location, id);
    const token = siblingDrag.begin(id, controller.state.location);
    event.dataTransfer.clearData();
    event.dataTransfer.setData(siblingDragType, token);
    event.dataTransfer.effectAllowed = 'move';
    event.stopPropagation();
  }
  function dropPosition(event: DragEvent): 'before' | 'after' {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
  }
  function dragOver(event: DragEvent, id: string) {
    const edge = dropPosition(event),
      transfer = event.dataTransfer;
    if (
      blocked ||
      !transfer ||
      !siblingDrag.preview(
        controller.state.snapshot,
        controller.state.location,
        controller.state.query,
        id,
        edge,
        Array.from(transfer.types),
      )
    ) {
      dragGuide = null;
      return;
    }
    event.preventDefault();
    transfer.dropEffect = 'move';
    dragGuide = { id, edge };
  }
  function dropItem(event: DragEvent, id: string) {
    const transfer = event.dataTransfer;
    const request =
      transfer && !blocked
        ? siblingDrag.drop(
            controller.state.snapshot,
            controller.state.location,
            controller.state.query,
            id,
            dropPosition(event),
            Array.from(transfer.types),
            transfer.getData(siblingDragType),
          )
        : null;
    clearDrag();
    // Never let files, URLs, or foreign HTML replace the workspace document.
    event.preventDefault();
    event.stopPropagation();
    if (request) void moveItem(request);
  }
  function focusInline(options?: { end?: boolean }) {
    noteBodies[controller.state.activeKey]?.focus(options);
  }
  function capturePrevious() {
    if (blocked) return false;
    const note = shownEntries.filter((x) => x.kind === 'note').at(-1);
    if (!note) return false;
    ++interaction;
    selected = note.id;
    selection.remember(viewState.location, selected);
    stream?.focus();
    scrollSelection();
    return true;
  }
  function clearCommand() {
    commandHeld = false;
  }
  function releaseCommand(event: KeyboardEvent) {
    if (event.key === 'Meta' || !event.metaKey) clearCommand();
  }
  function globalCommands(event: KeyboardEvent) {
    if (event.key === 'Meta' && !event.isComposing) commandHeld = true;
    if (
      event.defaultPrevented ||
      event.isComposing ||
      !viewState.loaded ||
      blocked ||
      palette ||
      !event.metaKey ||
      event.altKey ||
      event.ctrlKey ||
      event.shiftKey
    )
      return;
    if (event.key === '/') {
      event.preventDefault();
      event.stopPropagation();
      search?.focus();
      void controller.flush();
    } else if (event.key === '1') {
      event.preventDefault();
      event.stopPropagation();
      void openStash(null);
    }
  }
  function commands(event: KeyboardEvent) {
    if (
      event.isComposing ||
      palette ||
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
      if (
        (key === 'arrowup' || key === 'arrowdown') &&
        !isTyping(event.target)
      ) {
        moveKey(event, selected);
      } else if (key === 'n') {
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
      void edit(selected, true);
    } else if (key === 'l' && selectedNote && !event.repeat) {
      event.preventDefault();
      openPalette();
    } else if (key === 'x' && selectedNote && !event.repeat) {
      event.preventDefault();
      void controller.setNoteDone(selectedNote.id, !selectedNote.done);
    } else if (key === 'c' && selectedNote) {
      event.preventDefault();
      void copy(selected);
    } else if ((key === 'enter' || key === 'arrowright') && selectedNote) {
      event.preventDefault();
      void openStash(selectedNote.id);
    } else if (key === 'arrowleft' && viewState.stashId !== null) {
      event.preventDefault();
      void openStash(
        currentStash?.parentId ?? null,
        viewState.stashId,
        viewState.location.scope,
      );
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
        selection.remember(viewState.location, selected);
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
          {#if showCommandHints}<span class="command-hint" aria-hidden="true"
              >⌘/</span
            >{/if}
        </div>
        <div class="navigation-hint-anchor">
          <StashSidebar
            presentation={hierarchy}
            currentId={viewState.stashId}
            live={viewState.location.scope === 'live'}
            disabled={blocked}
            onopen={(id) => void openStash(id)}
          />
          {#if showCommandHints}<span
              class="command-hint home-command-hint"
              aria-hidden="true">⌘1</span
            >{/if}
        </div>
        <div class="backup-actions">
          <button
            onclick={() => void openStash(null, undefined, 'trash')}
            aria-current={viewState.location.scope === 'trash'
              ? 'page'
              : undefined}
            disabled={blocked}><Icon name="trash" /> Trash</button
          >
          <button onclick={() => controller.export()} disabled={blocked}
            ><Icon name="download" /> Export backup</button
          ><button
            onclick={() => controller.previewRestore()}
            disabled={blocked}><Icon name="upload" /> Restore backup</button
          ><button
            onclick={() => void undoDelete()}
            disabled={!viewState.snapshot.undoDeleteId || blocked}
            ><Icon name="undo" /> Undo delete</button
          >
        </div>
      </aside>
      <section class="notes-column" aria-label="Notes workspace">
        <div class="stream-header">
          {#if showCommandHints}<span
              class="command-hint stream-command-hint"
              aria-hidden="true">{streamCommandHint}</span
            >{/if}
          <span
            >{visibleNotes.length}
            {visibleNotes.length === 1 ? 'note' : 'notes'}</span
          >
        </div>
        <!-- The focusable region is the keyboard navigation surface; card selection has named controls. -->
        <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
        <section
          class="note-stream"
          aria-label="Note stream"
          tabindex="0"
          bind:this={stream}
          onclick={(event) => void clearStreamSelection(event)}
        >
          {#each shownEntries as entry (entry.id)}
            <ItemCard
              bind:this={noteBodies[entry.id]}
              item={entry}
              reorderable={!viewState.query.trim()}
              dropEdge={dragGuide?.id === entry.id ? dragGuide.edge : null}
              ondragstart={(event) => startDrag(event, entry.id)}
              ondragend={clearDrag}
              ondragover={(event) => dragOver(event, entry.id)}
              ondragleave={(event) => {
                if (
                  !(event.relatedTarget instanceof Node) ||
                  !(event.currentTarget as HTMLElement).contains(
                    event.relatedTarget,
                  )
                )
                  dragGuide = null;
              }}
              ondrop={(event) => dropItem(event, entry.id)}
              onmovekey={(event) => moveKey(event, entry.id)}
              selected={selected === entry.id}
              editing={viewState.activeKey === entry.id}
              source={viewState.buffers[entry.id]?.source ?? entry.markdown}
              baseline={editHeights[entry.id]}
              states={editorStates}
              readOnly={editorReadOnly}
              disabled={blocked}
              expanded={expandedNotes[entry.id] ?? false}
              outsideSearch={viewState.activeKey === entry.id &&
                !visibleNotes.some((x) => x.id === entry.id)}
              location={viewState.query.trim()
                ? locationHierarchy.label(entry.parentId).text
                : ''}
              onselect={(event) => cardClick(event, entry.id)}
              ondoubleclick={(event) => cardDoubleClick(event, entry.id)}
              onselectbutton={() => {
                ++interaction;
                selected = entry.id;
                selection.remember(viewState.location, selected);
                if (activeNote && activeNote.id !== entry.id)
                  leaveEdit(activeNote.id);
                stream?.focus();
              }}
              onedit={() => void edit(entry.id)}
              ondelete={() => void remove()}
              oncopy={() => void copy(entry.id)}
              ondone={() => void controller.setNoteDone(entry.id, !entry.done)}
              onsource={(source) => controller.editContext(entry.id, source)}
              onsubmit={() => void submit(entry.id)}
              onfinish={() => void finishEdit()}
              onblur={() => leaveEdit(entry.id)}
              onfocus={() => controller.retainEdit(entry.id)}
              oncontext={(fenced) => {
                inlineFenced = fenced;
                selectedEditingContext = { id: entry.id, fenced };
              }}
              onopen={(url) => void open(url)}
              onexpand={(expanded) =>
                (expandedNotes = { ...expandedNotes, [entry.id]: expanded })}
            />
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
          </p>
          <button onclick={openPalette} disabled={blocked}>Assign color</button>
          <p>Color: {selectedNote.color ?? 'None'}</p>
          {#if viewState.query.trim()}<p>
              Open the containing stash to reorder search results.
            </p>{/if}
        {/if}
        {#if viewState.location.scope === 'trash'}
          <section aria-label="Trash details">
            <h2>Trash</h2>
            <p>
              Items are retained for at least 90 days. Automatic permanent
              cleanup is not enabled yet.
            </p>
            {#if deletionRoot}{@const deleted = timestampPresentation(
                deletionRoot.deletedAt!,
                'full',
              )}
              <p>
                {selectedNote && selectedNote.id !== deletionRoot.id
                  ? `Inherited from ${itemLabel(deletionRoot)} · Deleted`
                  : 'Deleted'}
                <time datetime={deleted.datetime}>{deleted.label}</time>
              </p>
            {/if}
            {#if selectedNote && scopes.get(selectedNote.id) === 'trash'}
              <button onclick={() => void restoreSelected()} disabled={blocked}
                >Restore item</button
              >
              <p>
                {selectedNote.deletedAt === null
                  ? 'Restore this item and its children to Home.'
                  : 'Restore to its remembered live parent, or Home if unavailable.'}
              </p>
            {/if}
          </section>
        {/if}
        <div class="shortcut-list" aria-label="Keyboard shortcuts">
          <div>
            <span>New stash</span><span class="shortcut-keys"
              ><kbd>⌘</kbd><kbd>N</kbd></span
            >
          </div>
          <div>
            <span>Home</span><span class="shortcut-keys"
              ><kbd>⌘</kbd><kbd>1</kbd></span
            >
          </div>
          <div>
            <span>Bold / Italic</span><span class="shortcut-keys"
              ><kbd>⌘</kbd><kbd>B</kbd><span>/</span><kbd>⌘</kbd><kbd>I</kbd
              ></span
            >
          </div>
          <div><span>New note / Focus capture</span><kbd>Space</kbd></div>
          <div>
            <span aria-hidden="true">Search</span><span class="sr-only"
              >Search: Command slash, Command F, or slash</span
            ><span class="shortcut-keys" aria-hidden="true"
              ><kbd>⌘</kbd><kbd>/</kbd><span aria-hidden="true">/</span><kbd
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
          <div><span>Assign color</span><kbd>L</kbd></div>
          <div>
            <span aria-hidden="true">Reorder siblings</span><span
              class="sr-only">Reorder siblings: Command Up or Command Down</span
            ><span class="shortcut-keys" aria-hidden="true"
              ><kbd>⌘</kbd><kbd>↑</kbd><kbd>↓</kbd></span
            >
          </div>
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
          {:else if viewState.mutationRetry}<button
              disabled={blocked}
              onclick={() => void retryAction()}>Retry action</button
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
    {#if palette}{@const target = viewState.snapshot.items.find(
        (x) => x.id === palette!.id,
      )}
      {#if target}<ColorPalette
          color={target.color}
          disabled={blocked}
          onchoose={chooseColor}
          onclose={closePalette}
        />{/if}
    {/if}
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
