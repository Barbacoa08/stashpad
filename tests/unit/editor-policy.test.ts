import { describe, it, expect } from 'vitest';
import {
  EditorSelection,
  EditorState,
  type Transaction,
} from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { javascript } from '@codemirror/lang-javascript';
import { history, undo } from '@codemirror/commands';
import { sourceExtensions, editorSource } from '../../src/lib/editor/source';
import {
  fencedSelection,
  enterKey,
  captureUp,
} from '../../src/lib/editor/policy';
function editor(
  doc: string,
  anchor = doc.replace(/\r\n?/g, '\n').length,
  head = anchor,
) {
  let state = EditorState.create({
    doc,
    selection: { anchor, head },
    extensions: [
      markdown({ codeLanguages: () => javascript().language }),
      history(),
      sourceExtensions(doc),
      EditorState.allowMultipleSelections.of(true),
    ],
  });
  return {
    get state() {
      return state;
    },
    composing: false,
    dispatch(tr: Transaction) {
      state = tr.state;
    },
    select(selection: EditorSelection) {
      state = state.update({ selection }).state;
    },
  };
}
describe('fenced Markdown key policy with actual syntax trees', () => {
  for (const source of [
    '```js\nconst x = 1;\n```',
    '~~~ts\nx\n~~~',
    '```\nunclosed\n',
    '> ```js\n> x\n> ```',
    '- ```js\n  x\n  ```',
    '```\n```',
  ])
    it(`protects every fence line and boundary: ${JSON.stringify(source)}`, () => {
      const e = editor(source);
      for (let line = 1; line <= e.state.doc.lines; line++)
        for (const pos of [
          e.state.doc.line(line).from,
          e.state.doc.line(line).to,
        ]) {
          e.select(EditorSelection.single(pos));
          expect(fencedSelection(e.state), `${line}:${pos}`).toBe(true);
        }
    });
  for (const source of [
    'ordinary',
    '`inline code`',
    '\\`escaped inline\\`',
    '    indented code',
    '```\nx\n```\noutside',
    '~~~\nx\n~~~\n',
  ])
    it(`outside fences submits while Shift Enter inserts: ${JSON.stringify(source)}`, () => {
      const e = editor(source);
      let submits = 0;
      expect(fencedSelection(e.state)).toBe(false);
      expect(enterKey(e, false, false, () => submits++)).toBe(true);
      expect(submits).toBe(1);
      enterKey(e, true, false, () => submits++);
      expect(submits).toBe(1);
      expect(editorSource(e.state)).toContain('\n');
    });
  for (const [source, expected] of [
    ['> ```js\n> x\n> ```', '> ```js\n> x\n> \n> ```'],
    ['- ```js\n  x\n  ```', '- ```js\n  x\n  \n  ```'],
    ['- > ```js\n  > x\n  > ```', '- > ```js\n  > x\n  > \n  > ```'],
  ])
    it(`continues only the fenced container: ${JSON.stringify(source)}`, () => {
      const e = editor(source, source.indexOf('x') + 1);
      enterKey(e, false, false, () => {
        throw Error('must not submit');
      });
      expect(editorSource(e.state)).toBe(expected);
      expect(fencedSelection(e.state)).toBe(true);
      expect(undo(e)).toBe(true);
      expect(editorSource(e.state)).toBe(source);
    });
  it('protects a spanning selection and any fenced cursor among multiple selections', () => {
    const e = editor('before\n```js\nx\n```\nafter', 0, 24);
    expect(fencedSelection(e.state)).toBe(true);
    e.select(
      EditorSelection.create([
        EditorSelection.cursor(0),
        EditorSelection.cursor(14),
      ]),
    );
    expect(fencedSelection(e.state)).toBe(true);
    let submits = 0;
    enterKey(e, false, false, () => submits++);
    expect(submits).toBe(0);
  });
  it('newline and Undo preserve mixed source separators and the exact selection replacement', () => {
    const e = editor('```js\r\nx\n```', 7);
    let submits = 0;
    enterKey(e, false, false, () => submits++);
    expect(submits).toBe(0);
    expect(editorSource(e.state)).toBe('```js\r\nx\r\n\n```');
    expect(undo(e)).toBe(true);
    expect(editorSource(e.state)).toBe('```js\r\nx\n```');
  });
  it('closing EOF inserts outside newline, then next Enter submits', () => {
    const e = editor('```\nx\n```');
    let submits = 0;
    enterKey(e, false, false, () => submits++);
    expect(editorSource(e.state)).toBe('```\nx\n```\n');
    expect(fencedSelection(e.state)).toBe(false);
    enterKey(e, false, false, () => submits++);
    expect(submits).toBe(1);
  });
  it('never submits without Markdown parser coverage', () => {
    expect(fencedSelection(EditorState.create({ doc: '```\nx' }))).toBe(true);
  });
  it('leaves composing and read-only input untouched', () => {
    const e = editor('```\nx');
    let submits = 0;
    e.composing = true;
    expect(enterKey(e, false, false, () => submits++)).toBe(false);
    e.composing = false;
    expect(enterKey(e, false, true, () => submits++)).toBe(false);
    expect(submits).toBe(0);
    expect(editorSource(e.state)).toBe('```\nx');
  });
});
describe('capture-only Up boundary policy', () => {
  it('calls navigation only for one empty zero selection and consumes only a real target', () => {
    const e = editor('draft', 0);
    let calls = 0;
    expect(
      captureUp(e, false, () => {
        calls++;
        return true;
      }),
    ).toBe(true);
    expect(calls).toBe(1);
    expect(captureUp(e, false, () => false)).toBe(false);
    for (const selection of [
      EditorSelection.single(1),
      EditorSelection.single(0, 2),
      EditorSelection.create([
        EditorSelection.cursor(0),
        EditorSelection.cursor(2),
      ]),
    ]) {
      e.select(selection);
      expect(
        captureUp(e, false, () => {
          throw Error('must not navigate');
        }),
      ).toBe(false);
    }
    e.select(EditorSelection.single(0));
    e.composing = true;
    expect(captureUp(e, false, () => true)).toBe(false);
    e.composing = false;
    expect(captureUp(e, true, () => true)).toBe(false);
  });
});
