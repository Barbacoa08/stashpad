<script lang="ts">
  import { onMount } from 'svelte';
  import {
    EditorState,
    Transaction,
    Compartment,
    Prec,
    StateEffect,
  } from '@codemirror/state';
  import {
    EditorView,
    keymap,
    drawSelection,
    highlightActiveLine,
  } from '@codemirror/view';
  import {
    history,
    historyKeymap,
    defaultKeymap,
    indentWithTab,
  } from '@codemirror/commands';
  import { markdown, markdownKeymap } from '@codemirror/lang-markdown';
  import { javascript } from '@codemirror/lang-javascript';
  import { json } from '@codemirror/lang-json';
  import {
    syntaxHighlighting,
    HighlightStyle,
    indentOnInput,
  } from '@codemirror/language';
  import { tags } from '@lezer/highlight';
  import {
    sourceExtensions,
    editorSource,
    sourceReplacement,
  } from '../editor/source';
  import {
    toggleMarkdownStyle,
    formattingExtensions,
  } from '../editor/formatting';
  import { enterKey, fencedSelection, captureUp } from '../editor/policy';
  import { fenceCompletion } from '../editor/fences';
  let {
    contextKey,
    label,
    source,
    readOnly = false,
    onchange,
    onsubmit,
    oncancel,
    onblur,
    onfocus,
    states,
    onup,
    oncontext,
    ongeometry,
  }: {
    contextKey: string;
    label: string;
    states?: Map<string, EditorState>;
    onup?: () => boolean;
    oncontext?: (fenced: boolean) => void;
    ongeometry?: (height: number) => void;
    onsubmit: () => void;
    oncancel: () => void;
    onblur?: () => void;
    onfocus?: () => void;
    source: string;
    readOnly?: boolean;
    onchange: (source: string) => void;
  } = $props();
  let host: HTMLDivElement;
  let view = $state.raw<EditorView>();
  let applyingSource = false;
  let currentStates: Map<string, EditorState> | undefined;
  let currentKey = '';
  const editable = new Compartment();
  let lastContext: boolean | undefined;
  function reportContext(state: EditorState) {
    const next = fencedSelection(state);
    if (next !== lastContext) {
      lastContext = next;
      oncontext?.(next);
    }
  }
  function measure(editor: EditorView) {
    if (!ongeometry) return;
    editor.requestMeasure({
      key: host,
      read: (view) => view.contentHeight,
      write: (height) => ongeometry?.(height),
    });
  }
  const styles = HighlightStyle.define([
    { tag: tags.keyword, color: 'var(--editor-keyword)' },
    { tag: tags.string, color: 'var(--editor-string)' },
    { tag: tags.number, color: 'var(--editor-number)' },
    { tag: tags.comment, color: 'var(--editor-comment)' },
    { tag: tags.emphasis, class: 'cm-emphasis' },
    { tag: tags.strong, class: 'cm-strong' },
    { tag: tags.monospace, class: 'cm-code' },
    { tag: tags.heading1, class: 'cm-heading-1' },
    { tag: tags.heading2, class: 'cm-heading-2' },
    { tag: tags.heading3, class: 'cm-heading-3' },
    { tag: tags.heading4, class: 'cm-heading-4' },
    { tag: tags.heading5, class: 'cm-heading-5' },
    { tag: tags.heading6, class: 'cm-heading-6' },
    { tag: tags.processingInstruction, class: 'cm-marker' },
    { tag: tags.link, class: 'cm-link' },
    { tag: tags.list, class: 'cm-list' },
  ]);
  function extensions(text: string) {
    return [
      drawSelection(),
      EditorView.theme({
        '.cm-cursor, .cm-dropCursor': {
          borderLeftColor: 'var(--caret)',
          marginLeft: '0',
        },
      }),
      highlightActiveLine(),
      history(),
      formattingExtensions,
      sourceExtensions(text),
      fenceCompletion,
      indentOnInput(),
      Prec.highest(
        keymap.of([
          {
            key: 'Mod-b',
            run: (v) => toggleMarkdownStyle(v, 'bold'),
            preventDefault: true,
          },
          {
            key: 'Mod-i',
            run: (v) => toggleMarkdownStyle(v, 'italic'),
            preventDefault: true,
          },
          { key: 'Enter', run: (v) => enterKey(v, false, readOnly, onsubmit) },
          {
            key: 'Mod-Enter',
            run: (v) => enterKey(v, false, readOnly, onsubmit),
          },
          {
            key: 'Shift-Enter',
            run: (v) => enterKey(v, true, readOnly, onsubmit),
          },
          { key: 'ArrowUp', run: (v) => captureUp(v, readOnly, onup) },
          {
            key: 'Escape',
            run: (v) => {
              if (v.composing || readOnly) return false;
              oncancel();
              return true;
            },
          },
        ]),
      ),

      keymap.of([
        ...markdownKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        indentWithTab,
      ]),
      markdown({
        codeLanguages: (info) => {
          const lang = info.trim().split(/\s/)[0].toLowerCase();
          return /^(js|javascript|ts|typescript)$/.test(lang)
            ? javascript({
                typescript: lang === 'ts' || lang === 'typescript',
              }).language
            : lang === 'json'
              ? json().language
              : null;
        },
      }),

      syntaxHighlighting(styles),
      EditorView.lineWrapping,
      EditorView.domEventHandlers({
        focus: () => {
          onfocus?.();
        },
        blur: (event) => {
          if (
            !(event.relatedTarget instanceof Node) ||
            !host.contains(event.relatedTarget)
          )
            onblur?.();
        },
      }),
      EditorView.contentAttributes.of({
        'aria-label': label,
        'aria-multiline': 'true',
        spellcheck: 'false',
      }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged || update.selectionSet || update.viewportChanged)
          reportContext(update.state);
        if (update.docChanged || update.geometryChanged) measure(update.view);
        if (update.docChanged && !applyingSource)
          onchange(editorSource(update.state));
      }),
      editable.of([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    ];
  }
  function makeEditorState(text: string) {
    return EditorState.create({ doc: text, extensions: extensions(text) });
  }
  function restoreState(saved: EditorState | undefined, text: string) {
    return saved && editorSource(saved) === text
      ? saved.update({ effects: StateEffect.reconfigure.of(extensions(text)) })
          .state
      : makeEditorState(text);
  }
  onMount(() => {
    // A capturing listener bypasses app/editor shortcuts without preventDefault:
    // the browser must still commit its IME candidate on Enter.
    function composingEnter(event: KeyboardEvent) {
      if (
        (event.key === 'Enter' ||
          ((event.metaKey || event.ctrlKey) && /^[bi]$/i.test(event.key))) &&
        (event.isComposing || view?.composing)
      )
        event.stopPropagation();
    }
    host.addEventListener('keydown', composingEnter, true);
    currentKey = contextKey;
    currentStates = states;
    const saved = currentStates?.get(contextKey);
    view = new EditorView({
      state: restoreState(saved, source),
      parent: host,
    });
    reportContext(view.state);
    measure(view);
    return () => {
      host.removeEventListener('keydown', composingEnter, true);
      if (view) currentStates?.set(currentKey, view.state);
      view?.destroy();
      view = undefined;
    };
  });
  $effect(() => {
    const key = contextKey,
      text = source,
      disabled = readOnly;
    if (!view) return;
    if (key !== currentKey || states !== currentStates) {
      currentStates?.set(currentKey, view.state);
      currentStates = states;
      const saved = currentStates?.get(key);
      view.setState(restoreState(saved, text));
      currentKey = key;
      lastContext = undefined;
      reportContext(view.state);
      measure(view);
    } else if (editorSource(view.state) !== text) {
      applyingSource = true;
      view.dispatch({
        ...sourceReplacement(view.state, text),
        annotations: Transaction.addToHistory.of(false),
      });
      applyingSource = false;
    }
    view.dispatch({
      effects: editable.reconfigure([
        EditorState.readOnly.of(disabled),
        EditorView.editable.of(!disabled),
      ]),
    });
    view.contentDOM.setAttribute('aria-readonly', String(disabled));
  });
  export function focus(options?: { end?: boolean }) {
    if (view && options?.end)
      view.dispatch({
        selection: { anchor: view.state.doc.length },
        scrollIntoView: true,
      });
    view?.focus();
  }
</script>

<div
  class="markdown-editor"
  class:empty-capture={label === 'New note Markdown' && !source}
  bind:this={host}
></div>
