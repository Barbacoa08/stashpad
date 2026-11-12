import { describe, it, expect } from 'vitest';
import {
  EditorSelection,
  EditorState,
  type Transaction,
} from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { history, undo, redo } from '@codemirror/commands';
import { editorSource, sourceExtensions } from '../../src/lib/editor/source';
import {
  toggleMarkdownStyle,
  formattingExtensions,
} from '../../src/lib/editor/formatting';

function editor(source: string, anchor = 0, head = anchor, readOnly = false) {
  let state = EditorState.create({
    doc: source,
    selection: { anchor, head },
    extensions: [
      markdown(),
      formattingExtensions,
      history(),
      sourceExtensions(source),
      EditorState.allowMultipleSelections.of(true),
      EditorState.readOnly.of(readOnly),
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
describe('source Markdown formatting', () => {
  for (const [style, marker] of [
    ['bold', '**'],
    ['italic', '*'],
  ] as const) {
    it(`${style} wraps reversed selection, preserves separators, and isolates Undo/Redo`, () => {
      const source = 'one\r\ntwo\nthree\rfour';
      const e = editor(source, 18, 0);
      toggleMarkdownStyle(e, style);
      expect(editorSource(e.state)).toBe(marker + source + marker);
      expect(e.state.selection.main.anchor).toBe(18 + marker.length);
      expect(e.state.selection.main.head).toBe(marker.length);
      expect(undo(e)).toBe(true);
      expect(editorSource(e.state)).toBe(source);
      expect(e.state.selection.main.anchor).toBe(18);
      expect(redo(e)).toBe(true);
      expect(editorSource(e.state)).toBe(marker + source + marker);
      expect(e.state.selection.main.anchor).toBe(18 + marker.length);
      expect(e.state.selection.main.head).toBe(marker.length);
      toggleMarkdownStyle(e, style);
      expect(editorSource(e.state)).toBe(source);
    });
    it(`${style} inserts paired markers at an empty caret`, () => {
      const e = editor('word', 2);
      toggleMarkdownStyle(e, style);
      expect(editorSource(e.state)).toBe('wo' + marker + marker + 'rd');
      expect(e.state.selection.main.head).toBe(2 + marker.length);
      toggleMarkdownStyle(e, style);
      expect(editorSource(e.state)).toBe('word');
      expect(e.state.selection.main.head).toBe(2);
      undo(e);
      expect(editorSource(e.state)).toBe('wo' + marker + marker + 'rd');
      toggleMarkdownStyle(e, style);
      expect(editorSource(e.state)).toBe('word');
    });
    it(`${style} removes enclosing syntax at an empty caret and with marker selection`, () => {
      for (const [anchor, head] of [
        [marker.length + 1, marker.length + 1],
        [0, 4 + marker.length * 2],
      ]) {
        const e = editor(marker + 'word' + marker, anchor, head);
        toggleMarkdownStyle(e, style);
        expect(editorSource(e.state)).toBe('word');
      }
    });
  }
  for (const [source, style, expected] of [
    ['***word***', 'bold', '*word*'],
    ['***word***', 'italic', '**word**'],
    ['**a *word* b**', 'bold', 'a *word* b'],
    ['*a **word** b*', 'italic', 'a **word** b'],
    ['__word__', 'bold', 'word'],
    ['_word_', 'italic', 'word'],
  ] as const)
    it(`removes only ${style} in ${source}`, () => {
      const e = editor(source, source.indexOf('word') + 1);
      toggleMarkdownStyle(e, style);
      expect(editorSource(e.state)).toBe(expected);
    });
  for (const [source, anchor, head, style] of [
    ['*word*', 1, 5, 'bold'],
    ['**word**', 2, 6, 'italic'],
  ] as const)
    it(`combines ${style} with ${source} and removes one at a time`, () => {
      const e = editor(source, anchor, head);
      toggleMarkdownStyle(e, style);
      expect(editorSource(e.state)).toBe('***word***');
      expect(
        e.state.sliceDoc(
          e.state.selection.main.from,
          e.state.selection.main.to,
        ),
      ).toBe('word');
      toggleMarkdownStyle(e, style);
      expect(editorSource(e.state)).toBe(source);
    });
  for (const [outer, inner] of [
    ['bold', 'italic'],
    ['italic', 'bold'],
  ] as const) {
    for (const removeOuterFirst of [false, true]) {
      it(`retains ${outer}/${inner} empty-caret intent when removing ${removeOuterFirst ? 'outer' : 'inner'} first, with Undo/Redo`, () => {
        const e = editor('word', 2);
        toggleMarkdownStyle(e, outer);
        toggleMarkdownStyle(e, inner);
        expect(editorSource(e.state)).toBe('wo******rd');
        expect(e.state.selection.main.head).toBe(5);
        const firstOff = removeOuterFirst ? outer : inner;
        const secondOff = removeOuterFirst ? inner : outer;
        const remainingMarker = secondOff === 'bold' ? '**' : '*';
        const remaining = 'wo' + remainingMarker + remainingMarker + 'rd';
        toggleMarkdownStyle(e, firstOff);
        expect(editorSource(e.state)).toBe(remaining);
        expect(e.state.selection.main.head).toBe(2 + remainingMarker.length);
        toggleMarkdownStyle(e, secondOff);
        expect(editorSource(e.state)).toBe('word');
        expect(e.state.selection.main.head).toBe(2);
        expect(undo(e)).toBe(true);
        expect(editorSource(e.state)).toBe(remaining);
        expect(e.state.selection.main.head).toBe(2 + remainingMarker.length);
        expect(undo(e)).toBe(true);
        expect(editorSource(e.state)).toBe('wo******rd');
        expect(e.state.selection.main.head).toBe(5);
        expect(redo(e)).toBe(true);
        expect(editorSource(e.state)).toBe(remaining);
        expect(e.state.selection.main.head).toBe(2 + remainingMarker.length);
        expect(redo(e)).toBe(true);
        expect(editorSource(e.state)).toBe('word');
        expect(e.state.selection.main.head).toBe(2);
      });
    }
  }
  for (const [source, style, marker] of [
    ['a *word* b', 'bold', '**'],
    ['a **word** b', 'italic', '*'],
  ] as const) {
    it(`wraps whole selection containing complete inner delimiters with ${style}`, () => {
      const e = editor(source, source.length, 0);
      toggleMarkdownStyle(e, style);
      expect(editorSource(e.state)).toBe(marker + source + marker);
      expect(e.state.selection.main.anchor).toBe(source.length + marker.length);
      expect(e.state.selection.main.head).toBe(marker.length);
      expect(
        e.state.sliceDoc(
          e.state.selection.main.from,
          e.state.selection.main.to,
        ),
      ).toBe(source);
      expect(undo(e)).toBe(true);
      expect(editorSource(e.state)).toBe(source);
      expect(e.state.selection.main.anchor).toBe(source.length);
      expect(e.state.selection.main.head).toBe(0);
      expect(redo(e)).toBe(true);
      expect(editorSource(e.state)).toBe(marker + source + marker);
      toggleMarkdownStyle(e, style);
      expect(editorSource(e.state)).toBe(source);
    });
  }
  it('removes a nested style when the selection includes all combined markers', () => {
    const e = editor('***word***', 0, 10);
    toggleMarkdownStyle(e, 'bold');
    expect(editorSource(e.state)).toBe('*word*');
    expect(
      e.state.sliceDoc(e.state.selection.main.from, e.state.selection.main.to),
    ).toBe('*word*');
  });
  it('one invocation stays separate from preceding and following typing', () => {
    const e = editor('word', 0, 4);
    e.dispatch(
      e.state.update({
        changes: { from: 4, insert: '!' },
        userEvent: 'input.type',
      }),
    );
    toggleMarkdownStyle(e, 'bold');
    e.dispatch(
      e.state.update({
        changes: { from: e.state.doc.length, insert: '?' },
        userEvent: 'input.type',
      }),
    );
    undo(e);
    expect(editorSource(e.state)).toBe('**word**!');
    undo(e);
    expect(editorSource(e.state)).toBe('word!');
    undo(e);
    expect(editorSource(e.state)).toBe('word');
  });
  it('handles adjacent selections and deduplicates enclosing removals', () => {
    const e = editor('**one two**', 3);
    e.select(
      EditorSelection.create([
        EditorSelection.cursor(3),
        EditorSelection.cursor(8),
      ]),
    );
    toggleMarkdownStyle(e, 'bold');
    expect(editorSource(e.state)).toBe('one two');
    expect(e.state.selection.ranges.map((r) => r.head)).toEqual([1, 6]);
    const adjacent = editor('abcd');
    adjacent.select(
      EditorSelection.create([
        EditorSelection.range(0, 2),
        EditorSelection.range(2, 4),
      ]),
    );
    toggleMarkdownStyle(adjacent, 'bold');
    expect(editorSource(adjacent.state)).toBe('**ab****cd**');
    expect(
      adjacent.state.selection.ranges.map((r) =>
        adjacent.state.sliceDoc(r.from, r.to),
      ),
    ).toEqual(['ab', 'cd']);
  });
  it('retains empty-pair intent through redo and typing Undo without treating literal stars as a prior command', () => {
    const e = editor('word', 2);
    toggleMarkdownStyle(e, 'bold');
    undo(e);
    redo(e);
    expect(e.state.selection.main.head).toBe(4);
    e.dispatch(
      e.state.update({
        changes: { from: 4, insert: 'x' },
        selection: { anchor: 5 },
        userEvent: 'input.type',
      }),
    );
    undo(e);
    toggleMarkdownStyle(e, 'bold');
    expect(editorSource(e.state)).toBe('word');
    const literal = editor('****', 2);
    toggleMarkdownStyle(literal, 'bold');
    expect(editorSource(literal.state)).toBe('********');
  });
  it('leaves ambiguous partial-marker multiselections unchanged instead of colliding with removal', () => {
    const e = editor('**word**');
    e.select(
      EditorSelection.create([
        EditorSelection.cursor(1),
        EditorSelection.cursor(4),
      ]),
    );
    toggleMarkdownStyle(e, 'bold');
    expect(editorSource(e.state)).toBe('**word**');
  });
  it('does not mistake escaped and literal stars for enclosing formatting', () => {
    const e = editor('\\*word*', 3);
    toggleMarkdownStyle(e, 'italic');
    expect(editorSource(e.state)).toBe('\\*w**ord*');
    const literal = editor('a*b', 1, 2);
    toggleMarkdownStyle(literal, 'bold');
    expect(editorSource(literal.state)).toBe('a*****b');
  });
  for (const source of [
    '`code`',
    '```js\ncode\n```',
    '    code',
    'before `code` after',
  ])
    it(`consumes shortcuts without changing selected code: ${JSON.stringify(source)}`, () => {
      const e = editor(source, 0, source.length);
      expect(toggleMarkdownStyle(e, 'bold')).toBe(true);
      expect(editorSource(e.state)).toBe(source);
    });
  it('leaves all ranges untouched when any range touches code', () => {
    const e = editor('text `code`');
    e.select(
      EditorSelection.create([
        EditorSelection.range(0, 4),
        EditorSelection.cursor(7),
      ]),
    );
    toggleMarkdownStyle(e, 'italic');
    expect(editorSource(e.state)).toBe('text `code`');
  });
  it('does not mutate read-only, composing, or unparsed states', () => {
    const readonly = editor('word', 0, 4, true);
    toggleMarkdownStyle(readonly, 'bold');
    expect(editorSource(readonly.state)).toBe('word');
    const composing = editor('word', 0, 4);
    composing.composing = true;
    toggleMarkdownStyle(composing, 'bold');
    expect(editorSource(composing.state)).toBe('word');
    let state = EditorState.create({ doc: 'word' });
    toggleMarkdownStyle(
      {
        state,
        composing: false,
        dispatch: (tr) => {
          state = tr.state;
        },
      },
      'bold',
    );
    expect(state.doc.toString()).toBe('word');
  });
});
