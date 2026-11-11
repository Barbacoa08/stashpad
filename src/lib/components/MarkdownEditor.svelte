<script lang="ts">
  import { onMount } from 'svelte';
  import { EditorState, Transaction, Compartment } from '@codemirror/state';
  import {
    EditorView,
    keymap,
    lineNumbers,
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
  let {
    contextKey,
    source,
    readOnly = false,
    onchange,
  }: {
    contextKey: string;
    source: string;
    readOnly?: boolean;
    onchange: (source: string) => void;
  } = $props();
  let host: HTMLDivElement;
  let view = $state.raw<EditorView>();
  let applyingSource = false;
  let currentKey = '';
  const states = new Map<string, EditorState>();
  const editable = new Compartment();
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
  function makeEditorState(text: string) {
    return EditorState.create({
      doc: text,
      extensions: [
        lineNumbers(),
        drawSelection(),
        highlightActiveLine(),
        history(),
        indentOnInput(),
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
        EditorView.contentAttributes.of({
          'aria-label': 'Markdown source',
          'aria-multiline': 'true',
          spellcheck: 'false',
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !applyingSource)
            onchange(update.state.doc.toString());
        }),
        editable.of([
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
        ]),
      ],
    });
  }
  onMount(() => {
    currentKey = contextKey;
    view = new EditorView({ state: makeEditorState(source), parent: host });
    return () => {
      view?.destroy();
      view = undefined;
      states.clear();
    };
  });
  $effect(() => {
    const key = contextKey,
      text = source,
      disabled = readOnly;
    if (!view) return;
    if (key !== currentKey) {
      states.set(currentKey, view.state);
      const saved = states.get(key);
      view.setState(
        saved?.doc.toString() === text ? saved : makeEditorState(text),
      );
      currentKey = key;
    } else if (view.state.doc.toString() !== text) {
      applyingSource = true;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
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

<div class="markdown-editor" bind:this={host}></div>
