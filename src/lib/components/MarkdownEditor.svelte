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
  import { enterKey, fencedSelection, captureUp } from '../editor/policy';
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
    { tag: tags.keyword, color: '#d5a6ff' },
    { tag: tags.string, color: '#a9d4a4' },
    { tag: tags.number, color: '#e5be8a' },
    { tag: tags.comment, color: '#a2aebf' },
    { tag: tags.emphasis, class: 'cm-emphasis' },
    { tag: tags.strong, class: 'cm-strong' },
    { tag: tags.monospace, class: 'cm-code' },
    { tag: tags.heading, class: 'cm-heading' },
    { tag: tags.processingInstruction, class: 'cm-marker' },
    { tag: tags.link, class: 'cm-link' },
    { tag: tags.list, class: 'cm-list' },
  ]);
  function extensions(text: string) {
    return [
      drawSelection(),
      EditorView.theme({
        '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#fff' },
      }),
      highlightActiveLine(),
      history(),
      sourceExtensions(text),
      indentOnInput(),
      Prec.highest(
        keymap.of([
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
      if (event.key === 'Enter' && (event.isComposing || view?.composing))
        event.stopPropagation();
    }
    host.addEventListener('keydown', composingEnter, true);
    currentKey = contextKey;
    const saved = states?.get(contextKey);
    view = new EditorView({
      state: restoreState(saved, source),
      parent: host,
    });
    reportContext(view.state);
    measure(view);
    return () => {
      host.removeEventListener('keydown', composingEnter, true);
      if (view) states?.set(currentKey, view.state);
      view?.destroy();
      view = undefined;
    };
  });
  $effect(() => {
    const key = contextKey,
      text = source,
      disabled = readOnly;
    if (!view) return;
    if (key !== currentKey) {
      states?.set(currentKey, view.state);
      const saved = states?.get(key);
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
  export function focus() {
    view?.focus();
  }
</script>

<div
  class="markdown-editor"
  class:empty-capture={label === 'Capture Markdown' && !source}
  bind:this={host}
></div>
