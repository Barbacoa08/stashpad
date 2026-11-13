<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import type { ColorToken, Location } from '../domain/notes';
  import type { EditorState } from '@codemirror/state';
  import { isTauri } from '@tauri-apps/api/core';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import MarkdownEditor from './MarkdownEditor.svelte';
  import ItemCard from './ItemCard.svelte';
  import ColorPalette from './ColorPalette.svelte';
  import MoveDialog, { type MoveDestination } from './MoveDialog.svelte';
  import { SiblingDrag, siblingDragType } from '../workspace/sibling-drag';
  import { createReorderMotion } from '../workspace/reorder-motion';
  import type { MoveItems } from '../platform/workspace';
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
  import {
    NavigationHistory,
    breadcrumbs,
    historyLocationValidator,
  } from '../workspace/navigation-history';
  import { LocationSelection } from '../workspace/selection';
  import {
    emptyMouseSelection,
    mouseSelect,
    reconcileMouseSelection,
    reorderSelected,
    type MouseSelection,
  } from '../workspace/mouse-selection';
  import { WorkspaceController, type ViewState } from '../workspace/controller';
  import { nativeRepository, type Repository } from '../platform/workspace';
  import { copyMarkdown, openExternal } from '../platform/actions';
  import { filterNotes } from '../domain/search';
  import { timestampPresentation } from '../domain/timestamps';
  import { attachCloseGuard, type CloseAdapter } from '../platform/lifecycle';
  import { attachMouseHistory } from '../platform/mouse-history';
  let {
    repository = nativeRepository,
    onready,
    windowAdapter,
  }: {
    repository?: Repository;
    windowAdapter?: CloseAdapter;
    onready?: (controller: WorkspaceController) => void;
  } = $props();
  const controller = new WorkspaceController(untrack(() => repository));
  let viewState: ViewState = $state(controller.state);
  let mouseSelection = $state<MouseSelection>(emptyMouseSelection());
  let selected = $derived(mouseSelection.primary);
  let selectedIds = $derived(new Set(mouseSelection.ids));
  function setSelected(id: string) {
    mouseSelection = id
      ? { ids: [id], primary: id, anchor: id }
      : emptyMouseSelection();
  }
  let undoPending = $state(false);
  let undoRetry: {
    ids: string[];
    identity: object;
    epoch: number;
    interaction: number;
  } | null = null;
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
  type PaletteSession = {
    session: number;
    id: string;
    anchor: HTMLElement;
    returnTo: HTMLElement | null;
    pending: boolean;
    error: string;
  };
  let palette = $state<PaletteSession | null>(null);
  type MoveSession = {
    session: number;
    ids: string[];
    primary: string;
    returnTo: HTMLElement | null;
    destinations: MoveDestination[];
    pending: boolean;
    error: string;
    request: MoveItems | null;
  };
  let moveSession = $state<MoveSession | null>(null);
  let moveSequence = 0;
  let paletteSequence = 0;
  let paletteRetry = $state.raw<{
    session: number;
    id: string;
    label: string;
    color: ColorToken | null;
    identity: object;
    epoch: number;
  } | null>(null);
  const siblingDrag = new SiblingDrag();
  let dragGuide = $state<{ id: string; edge: 'before' | 'after' } | null>(null);
  function clearDrag() {
    siblingDrag.clear();
    dragGuide = null;
  }
  function defaultOwnedDragOver(event: DragEvent) {
    const transfer = event.dataTransfer;
    if (!transfer || !siblingDrag.owns(Array.from(transfer.types))) return;
    event.preventDefault();
    transfer.dropEffect = 'none';
    dragGuide = null;
  }
  function finishOwnedDragOver(event: DragEvent) {
    const transfer = event.dataTransfer;
    // A child editor must not turn a rejected sibling move into text-copy feedback.
    if (transfer && siblingDrag.owns(Array.from(transfer.types)) && !dragGuide)
      transfer.dropEffect = 'none';
  }
  function rejectFileDrop(event: DragEvent) {
    const transfer = event.dataTransfer;
    if (
      !transfer ||
      (!transfer.files.length && !Array.from(transfer.types).includes('Files'))
    )
      return;
    // CodeMirror otherwise reads dropped files as source before a bubble fallback.
    event.preventDefault();
    event.stopPropagation();
    clearDrag();
  }
  function cancelUnhandledDrop(event: DragEvent) {
    // Editor text and owned card drops run first; background drops must not navigate.
    event.preventDefault();
    clearDrag();
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
  let reorderMotion: ReturnType<typeof createReorderMotion> | undefined;
  let closeFailed = $state(false);
  let closeReturnFocus: HTMLElement | null = null;
  let detailsOpen = $state(false);
  let detailsChoice: boolean | null = null;
  let nativeChrome = $state(false);
  const navigation = new NavigationHistory();
  let historyRevision = $state(0);
  let backVisit = $derived.by(() => {
    void historyRevision;
    return navigation.target(-1, validVisit);
  });
  let forwardVisit = $derived.by(() => {
    void historyRevision;
    return navigation.target(1, validVisit);
  });
  let crumbs = $derived(
    breadcrumbs(viewState.snapshot.items, viewState.location),
  );
  let commandHeld = $state(false);
  let hintFocus = $state.raw<EventTarget | null>(null);
  let hintTextSelected = $state(false);
  let detailsToggle = $state<HTMLButtonElement>();
  let detailsRail = $state<HTMLElement>();
  let detailsPane = $state<HTMLElement>();
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
    siblingDrag.invalidate();
    dragGuide = null;
    untrack(() => {
      if (!palette?.pending) palette = null;
    });
  });
  let scopes = $derived(scopeIndex(viewState.snapshot.items));
  let validVisit = $derived(
    historyLocationValidator(viewState.snapshot.items, scopes),
  );
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
      viewState.location.scope === 'trash' ? 'Trash' : 'Root',
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
  $effect(() => {
    void metadataView;
    untrack(() => {
      if (mouseSelection.ids.length > 1) setSelected(selected);
    });
  });
  $effect(() => {
    const valid = shownEntries.map((entry) => entry.id);
    untrack(() => {
      const next = reconcileMouseSelection(mouseSelection, valid);
      if (JSON.stringify(next) !== JSON.stringify(mouseSelection))
        mouseSelection = next;
    });
  });
  let modal = $derived(!!viewState.preview || closeFailed || !!moveSession);
  let blocked = $derived(
    (viewState.operation !== null && viewState.operation !== 'save') || modal,
  );
  let navigationBlocked = $derived(
    modal ||
      (viewState.operation !== null &&
        !['save', 'navigate', 'promote'].includes(viewState.operation)),
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
      const before = siblings.map((item) => item.id);
      const ids = id
        ? selectedIds.has(id)
          ? before.filter((entry) => selectedIds.has(entry))
          : [id]
        : [];
      const up = reorderSelected(before, ids, -1).some(
        (entry, index) => entry !== before[index],
      );
      const down = reorderSelected(before, ids, 1).some(
        (entry, index) => entry !== before[index],
      );
      if (up || down)
        hints.push(`⌘${up && down ? '↑/↓' : up ? '↑' : '↓'} Reorder`);
    }
    if (selectedVisible && !typing && !hintTextSelected)
      hints.push(
        viewState.location.scope === 'trash'
          ? '⌘⌫ Permanently delete'
          : '⌘⌫ Delete',
      );
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
    exact = false,
    traversing = false,
  ) {
    if (navigationBlocked) return;
    if (!traversing) navigation.cancel();
    const request = ++interaction,
      focus = observeSubmissionFocus();
    selection.remember(viewState.location, selected);
    try {
      if (
        await (id === null || exact
          ? controller.openLocation({ scope, itemId: id })
          : controller.enterItem(id))
      ) {
        if (request !== interaction) return;
        // A successful visit to an equal-valued root has no location-change patch.
        if (traversing && navigation.acknowledge(controller.state.location))
          historyRevision++;
        setSelected(
          selection.open(
            controller.state.location,
            directEntries(
              controller.state.snapshot,
              controller.state.location,
            ).map((e) => e.id),
            preferred,
          ),
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
    navigation.cancel();
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
        setSelected('');
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
    const detachMouseHistory = attachMouseHistory(window, traverseHistory);
    reorderMotion = createReorderMotion(() => stream);
    let previous = controller.state;
    navigation.reset(previous.location);
    const unsubscribe = controller.subscribe((next) => {
      const locationChanged =
        next.location.scope !== previous.location.scope ||
        next.location.itemId !== previous.location.itemId;
      // Capture only acknowledged sibling-order changes before Svelte moves the
      // existing keyed cards. Source saves and other snapshot changes only settle.
      if (
        locationChanged ||
        next.query !== previous.query ||
        next.activeKey !== previous.activeKey ||
        next.buffers !== previous.buffers
      )
        reorderMotion?.cancel();
      if (next.snapshot !== previous.snapshot) {
        const before = directEntries(previous.snapshot, previous.location);
        const after = directEntries(next.snapshot, next.location);
        const old = new Map(before.map((item) => [item.id, item]));
        const siblingReorder =
          (next.operation === 'reorder' || next.operation === 'move') &&
          !next.query.trim() &&
          !locationChanged &&
          before.length === after.length &&
          after.every((item) => {
            const prior = old.get(item.id);
            return (
              prior &&
              prior.markdown === item.markdown &&
              prior.kind === item.kind &&
              prior.parentId === item.parentId &&
              prior.done === item.done &&
              prior.color === item.color &&
              prior.deletedAt === item.deletedAt
            );
          });
        if (siblingReorder)
          reorderMotion?.reorder(after.map((item) => item.id));
        else reorderMotion?.cancel();
      }
      // Subscribe sees each patch synchronously; Svelte effects can coalesce the
      // operation/location/finally patches and lose the structural cause.
      if (locationChanged && next.operation !== 'navigation-reconcile') {
        const structural =
          next.operation === 'delete' ||
          next.operation === 'purge' ||
          next.operation === 'move' ||
          next.operation === 'restore-item' ||
          (next.location.itemId !== null &&
            next.location.itemId === previous.location.itemId &&
            next.location.scope !== previous.location.scope);
        if (structural) navigation.reconcile(next.location);
        else if (!navigation.acknowledge(next.location))
          navigation.visit(next.location);
      }
      if (
        next.purgedItemIds !== previous.purgedItemIds &&
        next.purgedItemIds.length
      ) {
        const removed = new Set(next.purgedItemIds);
        for (const id of removed) {
          editorStates.delete(id);
          editorStates.delete(`compose:${id}`);
        }
        editHeights = Object.fromEntries(
          Object.entries(editHeights).filter(([id]) => !removed.has(id)),
        );
        expandedNotes = Object.fromEntries(
          Object.entries(expandedNotes).filter(([id]) => !removed.has(id)),
        );
        composerEpochs = Object.fromEntries(
          Object.entries(composerEpochs).filter(
            ([key]) =>
              !removed.has(key.startsWith('compose:') ? key.slice(8) : key),
          ),
        );
        if (selectedEditingContext && removed.has(selectedEditingContext.id))
          selectedEditingContext = null;
      }
      previous = next;
      viewState = next;
      historyRevision++;
    });
    nativeChrome = isTauri();
    void controller.start().then(() => onready?.(controller));
    // CSS can drop activeElement to body before the breakpoint event arrives.
    // Remember only the current focus, and let any newer real target take precedence.
    const detailsMedia = window.matchMedia('(max-width: 1050px)');
    let narrow = detailsMedia.matches;
    detailsOpen = !narrow;
    let focused: HTMLElement | null = null;
    function rememberFocus(event: FocusEvent) {
      if (
        closeFailed &&
        event.target instanceof HTMLElement &&
        event.target !== document.body &&
        !event.target.closest('[data-close-recovery]')
      )
        closeReturnFocus = event.target;
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
      const open = detailsChoice ?? !detailsMedia.matches;
      if (
        detailsOpen &&
        !open &&
        target?.isConnected &&
        detailsRail?.contains(target)
      )
        detailsToggle?.focus();
      detailsOpen = open;
      narrow = detailsMedia.matches;
    }
    // Capture only global navigation keys before CodeMirror's comment keymap.
    window.addEventListener('keydown', globalCommands, true);
    window.addEventListener('keyup', releaseCommand);
    window.addEventListener('blur', clearCommand);
    window.addEventListener('dragend', clearDrag);
    window.addEventListener('dragover', defaultOwnedDragOver, true);
    window.addEventListener('dragover', finishOwnedDragOver);
    window.addEventListener('drop', rejectFileDrop, true);
    window.addEventListener('drop', cancelUnhandledDrop);
    document.addEventListener('visibilitychange', clearCommand);
    updateHintContext();
    document.addEventListener('focusin', updateHintContext);
    document.addEventListener('focusout', updateHintContext);
    document.addEventListener('selectionchange', updateHintContext);
    document.addEventListener('focusin', rememberFocus);
    document.addEventListener('focusout', forgetFocus);
    detailsMedia.addEventListener('change', respondToDetailsWidth);
    let detach = () => {};
    if (windowAdapter || isTauri())
      detach = attachCloseGuard(
        {
          onCloseRequested: (handler) =>
            windowAdapter
              ? windowAdapter.onCloseRequested(handler)
              : getCurrentWindow().onCloseRequested(handler),
          hide: hideWindow,
        },
        () => controller.flush(),
        showCloseFailure,
      );
    return () => {
      disposed = true;
      detachMouseHistory();
      reorderMotion?.destroy();
      clearCommand();
      clearDrag();
      window.removeEventListener('dragend', clearDrag);
      window.removeEventListener('dragover', defaultOwnedDragOver, true);
      window.removeEventListener('dragover', finishOwnedDragOver);
      window.removeEventListener('drop', rejectFileDrop, true);
      window.removeEventListener('drop', cancelUnhandledDrop);
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
        setSelected(id);
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
        setSelected(
          controller.state.snapshot.items.find((n) => !known.has(n.id))?.id ??
            selected,
        );
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
    selectCard(event, id);
  }
  function selectionPointer(event: PointerEvent) {
    if (
      (event.metaKey || event.shiftKey) &&
      !blocked &&
      (!(event.target as Element).closest('button') ||
        !!(event.target as Element).closest('.note-select,.drag-handle')) &&
      !(event.target as Element).closest(
        'a,input,textarea,[contenteditable="true"]',
      ) &&
      !window.getSelection()?.toString()
    )
      event.preventDefault();
  }
  function selectCard(event: MouseEvent, id: string) {
    if (blocked) return;
    ++interaction;
    const siblings = directEntries(viewState.snapshot, viewState.location).map(
      (entry) => entry.id,
    );
    mouseSelection =
      viewState.query.trim() || !siblings.includes(id)
        ? { ids: [id], primary: id, anchor: id }
        : mouseSelect(mouseSelection, siblings, id, event);
    selection.remember(viewState.location, selected);
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
  async function remove(id = selected) {
    if (!id || blocked) return;
    const ordinal = shownEntries.findIndex((x) => x.id === id),
      request = ++interaction,
      focus = observeSubmissionFocus();
    try {
      const purge =
        scopes.get(id) === 'trash' ? controller.capturePurge(id) : null;
      if (
        !(await (purge
          ? controller.purgeItem(purge)
          : controller.remove(id))) ||
        request !== interaction
      )
        return;
      const entries = currentEntries();
      setSelected(
        entries[Math.min(Math.max(ordinal, 0), entries.length - 1)]?.id ?? '',
      );
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
      setSelected('');
      await tick();
      if (focus.mayRestore()) stream?.focus();
    } finally {
      focus.stop();
    }
  }
  async function retryAction() {
    if (blocked || undoPending) return;
    clearDrag();
    const ordinal = shownEntries.findIndex((x) => x.id === selected),
      before = JSON.stringify(controller.state.location),
      request = ++interaction,
      focus = observeSubmissionFocus();
    let undoing = false;
    try {
      const undo =
        undoRetry?.identity === controller.mutationRetryIdentity &&
        undoRetry.epoch === workspaceEpoch
          ? undoRetry
          : null;
      const ownsUndoSelection = undo?.interaction === request - 1;
      if (undo) undoPending = undoing = true;
      const retry =
        paletteRetry?.identity === controller.mutationRetryIdentity &&
        paletteRetry.epoch === workspaceEpoch
          ? paletteRetry
          : null;
      if (retry && palette?.session === retry.session) {
        palette.pending = true;
        palette.error = '';
      }
      const ok = await controller.retryMutation();
      if (undo) {
        if (ok) undoRetry = null;
        else if (controller.commandRetryIdentity)
          undoRetry = {
            ...undo,
            identity: controller.commandRetryIdentity,
            interaction: ownsUndoSelection ? request : undo.interaction,
          };
      }
      if (retry) {
        if (palette?.session === retry.session) {
          palette.pending = false;
          palette.error = ok ? '' : controller.state.error;
        }
        if (ok) {
          paletteRetry = null;
          if (palette?.session === retry.session)
            closePalette(focus.mayRestore(), retry.session);
        } else if (controller.mutationRetryIdentity) {
          paletteRetry = {
            ...retry,
            identity: controller.mutationRetryIdentity,
          };
        }
        // Color retry owns no selection, navigation, or focus continuation.
        return;
      }
      if (!ok || request !== interaction) return;
      if (navigation.acknowledge(controller.state.location)) historyRevision++;
      const entries = currentEntries();
      const restored = ownsUndoSelection
        ? undo?.ids.find((id) => entries.some((entry) => entry.id === id))
        : undefined;
      if (restored) setSelected(restored);
      else if (before !== JSON.stringify(controller.state.location))
        setSelected(
          selection.open(
            controller.state.location,
            entries.map((x) => x.id),
          ),
        );
      else if (!entries.some((x) => x.id === selected))
        setSelected(
          entries[Math.min(Math.max(ordinal, 0), entries.length - 1)]?.id ?? '',
        );
      await tick();
      // An unrelated retry must not dismiss the open palette by moving focus.
      if (focus.mayRestore() && !palette) {
        if (selected) stream?.focus();
        else composer?.focus();
      }
      scrollSelection();
    } finally {
      if (undoing) undoPending = false;
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
        setSelected(
          entries[Math.min(Math.max(ordinal, 0), entries.length - 1)]?.id ?? '',
        );
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
    if (blocked || undoPending) return;
    undoPending = true;
    clearDrag();
    const ids = [...controller.state.snapshot.undoDeleteIds],
      epoch = workspaceEpoch,
      ordinal = shownEntries.findIndex((x) => x.id === selected),
      request = ++interaction,
      focus = observeSubmissionFocus();
    try {
      const ok = await controller.undoRemove();
      if (!ok && epoch === workspaceEpoch && controller.commandRetryIdentity)
        undoRetry = {
          ids,
          identity: controller.commandRetryIdentity,
          epoch,
          interaction: request,
        };
      if (!ok || epoch !== workspaceEpoch || request !== interaction) return;
      undoRetry = null;
      const entries = currentEntries();
      const restored = ids.find((id) => entries.some((x) => x.id === id));
      if (restored) setSelected(restored);
      else if (!entries.some((x) => x.id === selected))
        setSelected(
          entries[Math.min(Math.max(ordinal, 0), entries.length - 1)]?.id ?? '',
        );
      selection.remember(controller.state.location, selected);
      await tick();
      scrollSelection();
      if (focus.mayRestore()) {
        if (selected) stream?.focus();
        else composer?.focus();
      }
    } finally {
      undoPending = false;
      focus.stop();
    }
  }
  function openPalette(invoker?: HTMLElement) {
    if (
      blocked ||
      !selectedNote ||
      !shownEntries.some((x) => x.id === selected)
    )
      return;
    const anchor = stream?.querySelector<HTMLElement>(
      `[data-entry-id="${selectedNote.id}"]`,
    );
    if (!anchor) return;
    palette = {
      anchor,
      session: ++paletteSequence,
      id: selectedNote.id,
      pending: false,
      error: '',
      returnTo:
        invoker ??
        (document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null),
    };
  }
  function closePalette(returnFocus: boolean, session = palette?.session) {
    const previous = palette;
    if (!previous || previous.session !== session || previous.pending) return;
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
    const current = palette;
    if (!current || current.pending || blocked) return;
    const session = current.session,
      epoch = workspaceEpoch;
    const label = itemLabel(
      viewState.snapshot.items.find((x) => x.id === current.id)!,
    );
    const focus = observeSubmissionFocus();
    current.pending = true;
    current.error = '';
    try {
      const ok = await controller.setItemColor(current.id, color);
      if (epoch !== workspaceEpoch) return;
      if (ok) {
        paletteRetry = null;
        if (palette?.session === session) {
          palette.pending = false;
          closePalette(focus.mayRestore(), session);
        }
      } else {
        if (controller.commandRetryIdentity)
          paletteRetry = {
            session,
            id: current.id,
            label,
            color,
            identity: controller.commandRetryIdentity,
            epoch,
          };
        if (palette?.session === session) {
          palette.pending = false;
          palette.error = controller.state.error;
        }
      }
    } finally {
      focus.stop();
    }
  }
  function selectedGroup(id: string) {
    return selectedIds.has(id)
      ? directEntries(controller.state.snapshot, controller.state.location)
          .filter((item) => selectedIds.has(item.id))
          .map((item) => item.id)
      : [id];
  }
  function captureMove(ids: string[], to: Location, toIndex: number) {
    try {
      return controller.captureMove(ids, to, toIndex);
    } catch {
      controller.feedback(
        '',
        'These items can no longer move to that destination.',
      );
      return null;
    }
  }
  async function executeMove(
    request: MoveItems,
    primary = selected,
    session?: MoveSession,
  ) {
    if ((blocked && moveSession !== session) || viewState.query.trim()) return;
    const intent = ++interaction,
      epoch = workspaceEpoch,
      before = JSON.stringify(controller.state.location),
      query = controller.state.query,
      ordinal = shownEntries.findIndex((item) => item.id === primary),
      original = document.activeElement,
      focus = observeSubmissionFocus();
    if (session) {
      session.pending = true;
      session.error = '';
    }
    try {
      const ok = await controller.moveItems($state.snapshot(request));
      if (epoch !== workspaceEpoch) return;
      if (!ok) {
        if (session && moveSession?.session === session.session) {
          session.pending = false;
          session.error = controller.state.error;
        }
        return;
      }
      if (session && moveSession?.session === session.session) {
        session.pending = false;
        moveSession = null;
      }
      if (
        intent !== interaction ||
        before !== JSON.stringify(controller.state.location) ||
        query !== controller.state.query
      )
        return;
      const entries = currentEntries(),
        valid = entries.map((item) => item.id),
        moving = new Set(request.ids),
        ids = valid.filter((id) => moving.has(id));
      if (ids.length)
        mouseSelection = {
          ids,
          primary: ids.includes(primary) ? primary : ids[0],
          anchor: ids.includes(mouseSelection.anchor)
            ? mouseSelection.anchor
            : ids[0],
        };
      else
        setSelected(
          entries[Math.min(Math.max(ordinal, 0), entries.length - 1)]?.id ?? '',
        );
      selection.remember(controller.state.location, selected);
      await tick();
      scrollSelection();
      if (focus.mayRestore()) {
        if (
          session?.returnTo?.isConnected &&
          session.returnTo.getClientRects().length
        )
          session.returnTo.focus();
        else if (
          original instanceof HTMLButtonElement &&
          original.classList.contains('drag-handle') &&
          original.isConnected
        )
          original.focus();
        else if (selected) stream?.focus();
        else composer?.focus();
      }
    } finally {
      focus.stop();
    }
  }
  function openMove() {
    if (blocked || !selected || viewState.query.trim()) {
      if (viewState.query.trim())
        controller.feedback(
          'Open the containing stash to move search results.',
        );
      return;
    }
    const ids = selectedGroup(selected),
      excluded = new Set(ids),
      snapshot = viewState.snapshot;
    if (!ids.length) {
      controller.feedback('Open the containing stash to move this item.');
      return;
    }
    const children = new Map<string, string[]>();
    for (const item of snapshot.items)
      if (item.parentId) {
        const group = children.get(item.parentId);
        if (group) group.push(item.id);
        else children.set(item.parentId, [item.id]);
      }
    const pending = [...ids];
    for (let index = 0; index < pending.length; index++)
      for (const id of children.get(pending[index]) ?? [])
        if (!excluded.has(id)) {
          excluded.add(id);
          pending.push(id);
        }
    const destinations: MoveDestination[] = [];
    for (const scope of ['live', 'trash'] as const) {
      const stashes = snapshot.items.filter(
        (item) => item.kind === 'stash' && scopes.get(item.id) === scope,
      );
      const rootLabel = scope === 'live' ? 'Root' : 'Trash';
      const presentation = createHierarchyPresentation(stashes, rootLabel);
      destinations.push(
        {
          key: scope,
          label: rootLabel,
          path: '',
          location: { scope, itemId: null },
        },
        ...stashes
          .filter((item) => !excluded.has(item.id))
          .map((item) => ({
            key: item.id,
            label: itemLabel(item),
            path: presentation.label(item.parentId).text,
            location: { scope, itemId: item.id },
          })),
      );
    }
    palette = null;
    moveSession = {
      session: ++moveSequence,
      ids,
      primary: selected,
      destinations,
      pending: false,
      error: '',
      request: null,
      returnTo:
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null,
    };
  }
  function cancelMove() {
    const session = moveSession;
    if (!session || session.pending) return;
    const focus = observeSubmissionFocus();
    moveSession = null;
    void tick().then(() => {
      try {
        if (moveSession || !focus.mayRestore()) return;
        if (
          session.returnTo?.isConnected &&
          session.returnTo.getClientRects().length
        )
          session.returnTo.focus();
        else stream?.focus();
      } finally {
        focus.stop();
      }
    });
  }
  function confirmMove(to: Location) {
    const session = moveSession;
    if (!session || session.pending) return;
    const moving = new Set(session.ids);
    const remaining = directEntries(viewState.snapshot, to).filter(
      (item) => !moving.has(item.id),
    );
    const request =
      session.request ?? captureMove(session.ids, to, remaining.length);
    if (!request) {
      session.error =
        'This destination is no longer available. Choose another destination or cancel.';
      return;
    }
    session.request = request;
    void executeMove(request, session.primary, session);
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
    const ids = selectedGroup(id),
      before = siblings.map((item) => item.id);
    const after = reorderSelected(
      before,
      ids,
      event.key === 'ArrowUp' ? -1 : 1,
    );
    if (after.every((item, index) => item === before[index])) return;
    try {
      void executeMove(
        controller.captureReorder(ids, after),
        selectedIds.has(id) ? selected : id,
      );
    } catch {
      controller.feedback(
        '',
        'These items can no longer be reordered together.',
      );
    }
  }
  function startDrag(event: DragEvent, id: string) {
    reorderMotion?.cancel();
    if (blocked || viewState.query.trim() || !event.dataTransfer) {
      event.preventDefault();
      return;
    }
    ++interaction;
    if (!selectedIds.has(id)) setSelected(id);
    selection.remember(viewState.location, selected);
    const token = siblingDrag.begin(
      selectedGroup(id),
      controller.state.location,
    );
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
    if (request) {
      const captured = captureMove(request.ids, request.group, request.toIndex);
      if (captured) void executeMove(captured);
    }
  }
  function focusInline(options?: { end?: boolean }) {
    noteBodies[controller.state.activeKey]?.focus(options);
  }
  function capturePrevious() {
    if (blocked) return false;
    const note = shownEntries.filter((x) => x.kind === 'note').at(-1);
    if (!note) return false;
    ++interaction;
    setSelected(note.id);
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
      (blocked && !(event.key === '1' && !navigationBlocked)) ||
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
      (blocked &&
        (navigationBlocked ||
          !['arrowleft', 'arrowright', 'enter'].includes(
            event.key.toLowerCase(),
          ))) ||
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
        key === 'z' &&
        !undoPending &&
        viewState.operation === null &&
        !event.repeat &&
        !isTyping(event.target) &&
        !window.getSelection()?.toString() &&
        viewState.snapshot.undoDeleteIds.length
      ) {
        event.preventDefault();
        void undoDelete();
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
    if (
      isTyping(event.target) ||
      (blocked &&
        (navigationBlocked ||
          !['arrowleft', 'arrowright', 'enter'].includes(key))) ||
      window.getSelection()?.toString()
    )
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
    } else if (key === 'm' && selectedNote && !event.repeat) {
      event.preventDefault();
      openMove();
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
        setSelected(next.id);
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
    detailsChoice = !detailsOpen;
    detailsOpen = detailsChoice;
  }
  function traverseHistory(direction: -1 | 1) {
    if (navigationBlocked) return;
    const visit = navigation.begin(direction, validVisit);
    if (visit)
      void openStash(
        visit.location.itemId,
        undefined,
        visit.location.scope,
        true,
        true,
      );
  }
  function showCloseFailure() {
    if (!closeFailed)
      closeReturnFocus =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    closeFailed = true;
  }
  async function dismissCloseFailure() {
    const active = document.activeElement;
    const target = closeReturnFocus;
    const restore =
      closeFailed &&
      (active === document.body || active?.closest('[data-close-recovery]'));
    const focus = observeSubmissionFocus();
    closeFailed = false;
    closeReturnFocus = null;
    try {
      // The recovery panel makes editors read-only; re-enable before focusing.
      await tick();
      if (restore && target?.isConnected && focus.mayRestore())
        target.focus({ preventScroll: true });
    } finally {
      focus.stop();
    }
  }
  async function hideWindow() {
    if (windowAdapter) await windowAdapter.hide();
    else await getCurrentWindow().hide();
    await dismissCloseFailure();
  }
  async function retryClose() {
    try {
      if (await controller.flush()) await hideWindow();
    } catch {
      showCloseFailure();
    }
  }
  async function hideWithoutSaving() {
    try {
      await hideWindow();
    } catch {
      showCloseFailure();
    }
  }
</script>

<svelte:window onkeydown={commands} />
{#snippet feedback(compact: boolean)}
  <section
    class="workspace-feedback"
    class:compact
    class:sr-only={compact &&
      !viewState.error &&
      !viewState.completionRetry &&
      !viewState.mutationRetry}
    aria-label="Workspace status"
  >
    <h2 class:sr-only={compact}><Icon name="info" /> Local activity</h2>
    {#if !compact}<p>Notes and drafts on this Mac.</p>{/if}
    <p role="status" aria-live="polite">{viewState.status}</p>
    <p role="alert">{viewState.error}</p>
    {#if paletteRetry && viewState.mutationRetry && paletteRetry.epoch === workspaceEpoch && paletteRetry.identity === controller.mutationRetryIdentity}
      <p role="status">
        Retry color: {paletteRetry.color
          ? paletteRetry.color[0].toUpperCase() + paletteRetry.color.slice(1)
          : 'Reset'} for {paletteRetry.label}.
      </p>
    {/if}
    {#if viewState.completionRetry}<button
        disabled={blocked}
        onclick={() => controller.retryCompletion()}>Retry completion</button
      >
    {:else if viewState.mutationRetry}<button
        disabled={blocked}
        onclick={() => void retryAction()}>Retry action</button
      >
    {:else if viewState.error}<button
        disabled={blocked}
        onclick={() => controller.flush()}>Retry checkpoint</button
      ><button disabled={blocked} onclick={() => submit(viewState.activeKey)}
        >Retry save</button
      >{/if}
  </section>
{/snippet}
<main
  class:native-chrome={nativeChrome}
  class:color-save-pending={viewState.operation === 'color' && !modal}
>
  <header class="app-header">
    <div class="native-controls-inset" aria-hidden="true"></div>
    <button
      class="toolbar-button"
      aria-label="Back"
      title="Back"
      disabled={navigationBlocked || !backVisit}
      data-unavailable={!backVisit ? '' : undefined}
      onclick={() => traverseHistory(-1)}><Icon name="back" /></button
    >
    <button
      class="toolbar-button"
      aria-label="Forward"
      title="Forward"
      disabled={navigationBlocked || !forwardVisit}
      data-unavailable={!forwardVisit ? '' : undefined}
      onclick={() => traverseHistory(1)}><Icon name="chevron" /></button
    >
    <h1 class="sr-only" title={destination}>{destination}</h1>
    <nav class="breadcrumbs" aria-label="Breadcrumbs">
      {#each crumbs as crumb, index}
        {#if index}<span class="breadcrumb-separator" aria-hidden="true">/</span
          >{/if}
        {#if crumb.location}
          <button
            aria-label={'Go to ' + crumb.label}
            aria-current={crumb.current ? 'page' : undefined}
            disabled={navigationBlocked}
            title={crumb.label}
            onclick={() =>
              void openStash(
                crumb.location!.itemId,
                undefined,
                crumb.location!.scope,
                true,
              )}>{crumb.label}</button
          >
        {:else}<span
            class="breadcrumb-omission"
            aria-label={crumb.label}
            title={crumb.label}>…</span
          >{/if}
      {/each}
    </nav>
    <div class="titlebar-drag" data-tauri-drag-region aria-hidden="true"></div>
    {#if viewState.loaded}<button
        class="details-toggle toolbar-button"
        bind:this={detailsToggle}
        aria-label={detailsOpen ? 'Hide Details' : 'Show Details'}
        title={detailsOpen ? 'Hide Details' : 'Show Details'}
        aria-expanded={detailsOpen}
        aria-controls="workspace-details"
        onclick={toggleDetails}><Icon name="panel" /></button
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
    <div class="workspace" class:details-open={detailsOpen}>
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
            disabled={navigationBlocked}
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
            disabled={navigationBlocked}><Icon name="trash" /> Trash</button
          >
          <button onclick={() => controller.export()} disabled={blocked}
            ><Icon name="download" /> Export backup</button
          ><button
            onclick={() => controller.previewRestore()}
            disabled={blocked}><Icon name="upload" /> Restore backup</button
          ><button
            onclick={() => void undoDelete()}
            disabled={!viewState.snapshot.undoDeleteIds.length ||
              undoPending ||
              blocked}
            data-unavailable={!viewState.snapshot.undoDeleteIds.length ||
            undoPending
              ? ''
              : undefined}><Icon name="undo" /> Undo delete</button
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
        <p class="sr-only" aria-live="polite">
          {mouseSelection.ids.length}
          {mouseSelection.ids.length === 1 ? 'item selected' : 'items selected'}
        </p>
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
              selected={selectedIds.has(entry.id)}
              primary={selected === entry.id}
              permanent={scopes.get(entry.id) === 'trash'}
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
              onselectbutton={(event) => selectCard(event, entry.id)}
              onhandleselect={(event) => {
                if (
                  event.metaKey ||
                  event.shiftKey ||
                  !selectedIds.has(entry.id)
                )
                  selectCard(event, entry.id);
              }}
              onselectionpointer={selectionPointer}
              onedit={() => void edit(entry.id)}
              ondelete={() => void remove(entry.id)}
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
      <div
        class="details-pane"
        class:open={detailsOpen}
        bind:this={detailsPane}
      >
        <aside
          id="workspace-details"
          class="details-rail"
          bind:this={detailsRail}
          tabindex="-1"
          class:open={detailsOpen}
          hidden={!detailsOpen}
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
            <button
              onclick={(event) => openPalette(event.currentTarget)}
              disabled={blocked}>Assign color</button
            >
            <p>Color: {selectedNote.color ?? 'None'}</p>
            {#if viewState.query.trim()}<p>
                Open the containing stash to reorder search results.
              </p>{/if}
          {/if}
          {#if viewState.location.scope === 'trash'}
            <section aria-label="Trash details">
              <h2>Trash</h2>
              <p>
                Items are retained for at least 90 days unless you permanently
                delete them. Delete here permanently removes the item and its
                children, with no Undo. Automatic permanent cleanup is not
                enabled yet.
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
                <button
                  onclick={() => void restoreSelected()}
                  disabled={blocked}>Restore item</button
                >
                <p>
                  {selectedNote.deletedAt === null
                    ? 'Restore this item and its children to Root.'
                    : 'Restore to its remembered live parent, or Root if unavailable.'}
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
              <span>Root</span><span class="shortcut-keys"
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
            <div><span>Move selected items</span><kbd>M</kbd></div>
            <div>
              <span aria-hidden="true">Reorder siblings</span><span
                class="sr-only"
                >Reorder siblings: Command Up or Command Down</span
              ><span class="shortcut-keys" aria-hidden="true"
                ><kbd>⌘</kbd><kbd>↑</kbd><kbd>↓</kbd></span
              >
            </div>
            <div>
              <span aria-hidden="true"
                >{viewState.location.scope === 'trash'
                  ? 'Permanently delete selected'
                  : 'Delete selected'}</span
              ><span class="sr-only"
                >{viewState.location.scope === 'trash'
                  ? 'Permanently delete selected: Command Backspace'
                  : 'Delete selected: Command Backspace'}</span
              ><span class="shortcut-keys" aria-hidden="true"
                ><kbd>⌘</kbd><kbd>⌫</kbd></span
              >
            </div>
            <div>
              <span aria-hidden="true">Undo delete</span><span class="sr-only"
                >Undo delete outside text editing: Command Z</span
              ><span class="shortcut-keys" aria-hidden="true"
                ><kbd>⌘</kbd><kbd>Z</kbd></span
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
        </aside>
        {@render feedback(!detailsOpen)}
      </div>
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
              navigation.reset(controller.state.location);
              historyRevision++;
              composerEpochs = {};
              setSelected('');
              await tick();
              editorStates.clear();
              selection.clear();
              composer?.focus();
            }
          }}
          disabled={viewState.operation !== null}>Replace workspace</button
        >
      </section>{/if}
    {#each palette ? [palette] : [] as session (session.session)}
      {@const target = viewState.snapshot.items.find(
        (x) => x.id === session.id,
      )}
      {#if target}<ColorPalette
          anchor={session.anchor}
          color={target.color}
          disabled={session.pending || blocked}
          error={session.error}
          onchoose={chooseColor}
          onclose={(returnFocus) => closePalette(returnFocus, session.session)}
        />{/if}
    {/each}
    {#if closeFailed}<section
        data-close-recovery
        class="confirmation"
        aria-label="Could not hide window"
      >
        <h2>Could not hide window</h2>
        <p>
          Your notes and drafts are still here. Retry saving and hiding, or keep
          the window open. If you hide without saving, unsaved input stays in
          memory until you quit.
        </p>
        <button use:focusChoice onclick={retryClose}>Retry and hide</button
        ><button onclick={dismissCloseFailure}>Keep window open</button><button
          onclick={hideWithoutSaving}>Hide without saving</button
        >
      </section>{/if}
  {/if}
</main>

{#if moveSession}
  <MoveDialog
    destinations={moveSession.destinations}
    count={moveSession.ids.length}
    pending={moveSession.pending}
    error={moveSession.error}
    locked={!!moveSession.request}
    onconfirm={confirmMove}
    oncancel={cancelMove}
  />
{/if}
