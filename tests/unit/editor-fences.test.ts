import { describe, expect, it } from 'vitest';
import {
  EditorSelection,
  EditorState,
  Transaction,
  type Extension,
} from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { history, isolateHistory, redo, undo } from '@codemirror/commands';
import { fenceCompletion } from '../../src/lib/editor/fences';
import {
  editorSource,
  sourceExtensions,
  sourceReplacement,
} from '../../src/lib/editor/source';
import { enterKey } from '../../src/lib/editor/policy';

function editor(
  source = '',
  anchor = source.replace(/\r\n?/g, '\n').length,
  extra: Extension = [],
) {
  let state = EditorState.create({
    doc: source,
    selection: { anchor },
    extensions: [
      markdown(),
      history(),
      sourceExtensions(source),
      fenceCompletion,
      EditorState.allowMultipleSelections.of(true),
      extra,
    ],
  });
  const target = {
    get state() {
      return state;
    },
    composing: false,
    dispatch(tr: Transaction) {
      state = tr.state;
    },
    type(text: string, event = 'input.type') {
      state = state.update(state.replaceSelection(text), {
        userEvent: event,
      }).state;
    },
    select(selection: EditorSelection) {
      state = state.update({ selection }).state;
    },
    replace(text: string) {
      state = state.update(sourceReplacement(state, text)).state;
    },
    separate() {
      state = state.update({ annotations: isolateHistory.of('full') }).state;
    },
    get source() {
      return editorSource(state);
    },
    undo() {
      return undo(target);
    },
    redo() {
      return redo(target);
    },
  };
  return target;
}

describe('bounded typed Markdown fence completion', () => {
  for (const [before, anchor, input, expected, caret] of [
    ['', 0, '```', '```\n```', 3],
    ['``', 2, '`', '```\n```', 3],
    [' ', 1, '```', ' ```\n ```', 4],
    ['  ``', 4, '`', '  ```\n  ```', 5],
    ['   ``', 5, '`', '   ```\n   ```', 6],
    ['`closed`\n``', 11, '`', '`closed`\n```\n```', 12],
    ['before\n``\nafter', 9, '`', 'before\n```\n```\nafter', 10],
    ['before\r\n``\r\nafter', 9, '`', 'before\r\n```\r\n```\r\nafter', 10],
    [
      'before\r\n``\nafter\rlast',
      9,
      '`',
      'before\r\n```\r\n```\nafter\rlast',
      10,
    ],
  ] as const)
    it(`pairs only the opening line and preserves surrounding source: ${JSON.stringify(before)}`, () => {
      const e = editor(before, anchor);
      e.type(input);
      expect(e.source).toBe(expected);
      expect(e.state.selection.main.head).toBe(caret);
      expect(e.undo()).toBe(true);
      expect(e.source).toBe(before);
      expect(e.redo()).toBe(true);
      expect(e.source).toBe(expected);
    });

  it('third input and generated closer are atomic, while earlier typing can have separate history', () => {
    const e = editor();
    e.type('``');
    e.separate();
    e.type('`');
    expect(e.source).toBe('```\n```');
    e.undo();
    expect(e.source).toBe('``');
    e.redo();
    expect(e.source).toBe('```\n```');
  });

  it('keeps info typing on the opener and existing Enter variants in the body', () => {
    const e = editor();
    e.type('```');
    e.type('js');
    for (const shift of [false, true, false])
      expect(
        enterKey(e, shift, false, () => {
          throw Error('must not submit');
        }),
      ).toBe(true);
    expect(e.source).toBe('```js\n\n\n\n```');
    expect(e.state.selection.main.head).toBe(8);
  });

  for (const [before, anchor, expected] of [
    ['`open\n``\nend`', 8, '`open\n```\nend`'],
    ['`open\r\n``\r\nend`', 8, '`open\r\n```\r\nend`'],
    ['`open\r\n``\nend`\rlast', 8, '`open\r\n```\nend`\rlast'],
    ['text `open\n``\nend`', 13, 'text `open\n```\nend`'],
    ['``open\n``\nend``', 9, '``open\n```\nend``'],
  ] as const)
    it(`preserves an initial multiline inline-code context and exact Undo: ${JSON.stringify(before)}`, () => {
      const e = editor(before, anchor);
      expect(
        ensureSyntaxTree(e.state, e.state.doc.length, 100)?.toString(),
      ).toContain('InlineCode');
      e.type('`');
      expect(e.source).toBe(expected);
      expect(e.state.selection.main.head).toBe(anchor + 1);
      expect(e.undo()).toBe(true);
      expect(e.source).toBe(before);
      expect(e.redo()).toBe(true);
      expect(e.source).toBe(expected);
    });

  for (const [before, anchor, input, expected] of [
    ['', 0, '````', '````'],
    ['', 0, '`````', '`````'],
    ['````', 4, '`', '`````'],
    ['inline ``', 9, '`', 'inline ```'],
    ['``right', 2, '`', '```right'],
    ['    ``', 6, '`', '    ```'],
    ['> ``', 4, '`', '> ```'],
    ['- ``', 4, '`', '- ```'],
    ['- item\n  ``', 11, '`', '- item\n  ```'],
    ['~~~\n``\n~~~', 6, '`', '~~~\n```\n~~~'],
    ['```\n``\n```', 6, '`', '```\n```\n```'],
    ['```\nx\n``', 8, '`', '```\nx\n```'],
    ['``\nexisting\n```', 2, '`', '```\nexisting\n```'],
    ['``\nexisting\n````', 2, '`', '```\nexisting\n````'],
    ['', 0, '~~~', '~~~'],
  ] as const)
    it(`leaves unsupported or already closed context literal: ${JSON.stringify(before)} + ${input}`, () => {
      const e = editor(before, anchor);
      e.type(input);
      expect(e.source).toBe(expected);
    });

  for (const event of [
    'input.paste',
    'move.drop',
    'input.type.compose',
    'input.type.compose.start',
    'input',
    undefined,
  ])
    it(`does not pair non-typed provenance: ${event}`, () => {
      const e = editor('``');
      if (event === undefined) e.replace('```');
      else e.type('`', event);
      expect(e.source).toBe('```');
    });

  it('does not pair read-only, selected, or multicaret transactions', () => {
    const locked = editor('``', 2, EditorState.readOnly.of(true));
    locked.type('`');
    expect(locked.source).toBe('```');
    const selected = editor('``x');
    selected.select(EditorSelection.single(2, 3));
    selected.type('`');
    expect(selected.source).toBe('```');
    const multiple = editor('``\n``');
    multiple.select(
      EditorSelection.create([
        EditorSelection.cursor(2),
        EditorSelection.cursor(5),
      ]),
    );
    multiple.type('`');
    expect(multiple.source).toBe('```\n```');
  });

  it('extends only a consecutive owned pair, preserving indentation and exact history', () => {
    const e = editor('  ``');
    e.type('`');
    e.type('`');
    e.type('``');
    expect(e.source).toBe('  ``````\n  ``````');
    expect(e.state.selection.main.head).toBe(8);
    e.undo();
    expect(e.source).toBe('  ``');
    e.redo();
    expect(e.source).toBe('  ``````\n  ``````');
  });

  it('never extends a preexisting closer, and movement or info typing ends ownership', () => {
    const existing = editor('``\nx\n```', 2);
    existing.type('`');
    existing.type('`');
    expect(existing.source).toBe('````\nx\n```');
    const moved = editor();
    moved.type('```');
    moved.select(EditorSelection.single(2));
    moved.select(EditorSelection.single(3));
    moved.type('`');
    expect(moved.source).toBe('````\n```');
    const info = editor();
    info.type('```');
    info.type('js');
    info.type('`');
    expect(info.source).toBe('```js`\n```');
  });
});
