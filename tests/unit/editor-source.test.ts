import { describe, it, expect } from 'vitest';
import { EditorState, Transaction } from '@codemirror/state';
import { history, undo, redo, isolateHistory } from '@codemirror/commands';
import { EditorView } from '@codemirror/view';
import {
  sourceExtensions,
  editorSource,
  sourceReplacement,
} from '../../src/lib/editor/source';
function workspace(source: string) {
  let state = EditorState.create({
    doc: source,
    extensions: [history(), sourceExtensions(source)],
  });
  const target = {
    get state() {
      return state;
    },
    dispatch(tr: Transaction) {
      state = tr.state;
    },
  };
  return {
    get state() {
      return state;
    },
    change(from: number, to: number, text: string) {
      state = state.update({
        changes: { from, to, insert: text },
        annotations: isolateHistory.of('full'),
        userEvent: 'input.type',
      }).state;
    },
    undo() {
      return undo(target);
    },
    redo() {
      return redo(target);
    },
  };
}
describe('exact editor source bridge', () => {
  for (const source of [
    'one\ntwo\nthree',
    'one\r\ntwo\r\nthree',
    'one\r\ntwo\nthree\rfour',
  ])
    it(`round-trips untouched separators through edits and history: ${JSON.stringify(source)}`, () => {
      const w = workspace(source);
      expect(editorSource(w.state)).toBe(source);
      w.change(3, 3, 'x');
      expect(editorSource(w.state)).toBe(source.replace('one', 'onex'));
      expect(w.undo()).toBe(true);
      expect(editorSource(w.state)).toBe(source);
      expect(w.redo()).toBe(true);
      expect(editorSource(w.state)).toBe(source.replace('one', 'onex'));
    });
  it('deleting and restoring a mixed separator keeps that separator through undo/redo', () => {
    const w = workspace('a\r\nb\nc\rd');
    w.change(3, 4, '');
    expect(editorSource(w.state)).toBe('a\r\nbc\rd');
    w.undo();
    expect(editorSource(w.state)).toBe('a\r\nb\nc\rd');
    w.redo();
    expect(editorSource(w.state)).toBe('a\r\nbc\rd');
  });
  it('new logical lines use the existing first separator, while explicit replacement retains its supplied separators', () => {
    const w = workspace('a\r\nb\nc');
    w.change(1, 1, '\n');
    expect(editorSource(w.state)).toBe('a\r\n\r\nb\nc');
    w.undo();
    expect(editorSource(w.state)).toBe('a\r\nb\nc');
    const replaced = w.state.update(
      sourceReplacement(w.state, 'x\ny\r\nz'),
    ).state;
    expect(editorSource(replaced)).toBe('x\ny\r\nz');
    expect(editorSource(replaced, 1, 4)).toBe('\ny\r\n');
  });
  it('retains raw paste separators before CM normalization and standard selection-copy output', () => {
    const w = workspace('start');
    const raw = 'a\r\nb\nc\rd';
    for (const filter of w.state.facet(EditorView.clipboardInputFilter))
      filter(raw, w.state);
    const pasted = w.state.update({
      changes: { from: 0, to: 5, insert: raw },
      selection: { anchor: 0, head: 7 },
      userEvent: 'input.paste',
    }).state;
    expect(editorSource(pasted)).toBe(raw);
    let copied = pasted.sliceDoc();
    for (const filter of pasted.facet(EditorView.clipboardOutputFilter))
      copied = filter(copied, pasted);
    expect(copied).toBe(raw);
  });
});

it('uses CM grouped undo/redo to restore two different removed separators', () => {
  let state = EditorState.create({
    doc: 'a\r\nb\nc',
    extensions: [
      history({ joinToEvent: () => true }),
      sourceExtensions('a\r\nb\nc'),
    ],
  });
  state = state.update({
    changes: { from: 1, to: 2 },
    userEvent: 'delete.backward',
  }).state;
  state = state.update({
    changes: { from: 2, to: 3 },
    userEvent: 'delete.backward',
  }).state;
  const target = {
    get state() {
      return state;
    },
    dispatch(tr: Transaction) {
      state = tr.state;
    },
  };
  expect(editorSource(state)).toBe('abc');
  expect(undo(target)).toBe(true);
  expect(editorSource(state)).toBe('a\r\nb\nc');
  expect(redo(target)).toBe(true);
  expect(editorSource(state)).toBe('abc');
});
