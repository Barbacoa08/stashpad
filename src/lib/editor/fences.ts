import {
  EditorState,
  StateEffect,
  StateField,
  Transaction,
} from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';

type OwnedFence = { head: number; closeEnd: number };
const ownFence = StateEffect.define<OwnedFence>();
// Ownership lasts only through consecutive typed backticks. Navigation, source
// replacement, composition, and all other edits release it, without stored data.
const ownedFence = StateField.define<OwnedFence | null>({
  create: () => null,
  update(previous, tr) {
    for (const effect of tr.effects)
      if (effect.is(ownFence)) return effect.value;
    return tr.docChanged || tr.selection ? null : previous;
  },
});

/** Pair only a genuinely typed, plain, top-level opening backtick fence. */
export const fenceCompletion = [
  ownedFence,
  EditorState.transactionFilter.of((tr) => {
    const state = tr.startState;
    const selection = state.selection;
    if (
      tr.annotation(Transaction.userEvent) !== 'input.type' ||
      state.readOnly ||
      selection.ranges.length !== 1 ||
      !selection.main.empty ||
      !tr.docChanged
    )
      return tr;

    let input = '',
      count = 0;
    tr.changes.iterChanges((from, to, _newFrom, _newTo, inserted) => {
      count++;
      if (from === to && from === selection.main.head)
        input = inserted.toString();
    });
    if (count !== 1 || !/^`+$/.test(input)) return tr;
    const head = selection.main.head + input.length;
    if (
      tr.newSelection.ranges.length !== 1 ||
      !tr.newSelection.main.empty ||
      tr.newSelection.main.head !== head
    )
      return tr;

    const owned = state.field(ownedFence);
    if (owned && owned.head === selection.main.head) {
      const closeEnd = tr.changes.mapPos(owned.closeEnd, 1);
      return [
        tr,
        {
          changes: { from: closeEnd, insert: input },
          selection: tr.newSelection,
          effects: ownFence.of({ head, closeEnd: closeEnd + input.length }),
          sequential: true,
        },
      ];
    }

    const line = tr.newDoc.lineAt(head);
    const opening = /^( {0,3})```$/.exec(line.text);
    if (!opening || head !== line.to || input.length > 3) return tr;
    // A candidate fence can split an existing multiline code span. Protect its
    // original context, including input immediately after its closing mark.
    const initialTree = ensureSyntaxTree(state, state.doc.length, 100);
    if (!initialTree || initialTree.type.name !== 'Document') return tr;
    for (
      let context = initialTree.resolveInner(selection.main.head, -1);
      context;
      context = context.parent!
    )
      if (context.name === 'InlineCode') return tr;
    // Parsing the candidate distinguishes openers from closers, fenced content,
    // and list/quote continuations, and recognizes any valid existing closer.
    const tree = ensureSyntaxTree(tr.state, tr.newDoc.length, 100);
    if (!tree || tree.type.name !== 'Document') return tr;
    const opener = line.from + opening[1].length;
    const block = tree.topNode.childAfter(opener);
    if (
      !block ||
      block.name !== 'FencedCode' ||
      block.from !== opener ||
      block.getChildren('CodeMark').length !== 1
    )
      return tr;
    const closer = '\n' + opening[1] + '```';
    return [
      tr,
      {
        changes: { from: head, insert: closer },
        selection: tr.newSelection,
        effects: ownFence.of({ head, closeEnd: head + closer.length }),
        sequential: true,
      },
    ];
  }),
];
