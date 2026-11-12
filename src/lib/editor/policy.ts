import {
  EditorSelection,
  type EditorState,
  type Transaction,
} from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';
import { insertNewline } from '@codemirror/commands';
import { insertNewlineContinueMarkup } from '@codemirror/lang-markdown';

type Target = {
  state: EditorState;
  composing: boolean;
  dispatch: (transaction: Transaction) => void;
};

/** Delimiter lines and all selected fence content are protected, including mounted languages. */
export function fencedSelection(state: EditorState): boolean {
  const ranges = state.selection.ranges.map((range) => ({
    from: state.doc.lineAt(range.from).from,
    to: state.doc.lineAt(range.to).to,
  }));
  const end = Math.max(...ranges.map((range) => range.to));
  const tree = ensureSyntaxTree(state, end, 100);
  // An unavailable/incomplete parse must never turn a code newline into a save.
  if (!tree || tree.type.name !== 'Document') return true;
  let fenced = false;
  tree.iterate({
    from: Math.min(...ranges.map((range) => range.from)),
    to: end,
    enter(node) {
      if (node.name === 'FencedCode') {
        if (
          ranges.some((range) => range.from <= node.to && range.to >= node.from)
        )
          fenced = true;
        return false;
      }
    },
  });
  return fenced;
}

/** Continue only the syntax-derived outer container, without list renumbering or source trimming. */
function fencedNewline(target: Target): boolean {
  const { state } = target;
  const tree = ensureSyntaxTree(
    state,
    Math.max(...state.selection.ranges.map((r) => state.doc.lineAt(r.to).to)),
    100,
  );
  const changes = state.changeByRange((range) => {
    const line = state.doc.lineAt(range.from);
    let prefix = '';
    tree?.iterate({
      from: line.from,
      to: line.to,
      enter(node) {
        if (node.name !== 'FencedCode') return;
        if (node.from > line.to || node.to < line.from) return false;
        const opening = state.doc.lineAt(node.from);
        const chars = state.doc.sliceString(opening.from, node.from).split('');
        for (
          let ancestor = node.node.parent;
          ancestor;
          ancestor = ancestor.parent
        ) {
          if (ancestor.name !== 'ListItem') continue;
          const mark = ancestor.getChild('ListMark');
          if (mark && mark.from >= opening.from && mark.to <= node.from)
            for (let pos = mark.from; pos < mark.to; pos++)
              chars[pos - opening.from] = ' ';
        }
        prefix = chars.join('');
        return false;
      },
    });
    return {
      changes: {
        from: range.from,
        to: range.to,
        insert: state.lineBreak + prefix,
      },
      range: EditorSelection.cursor(range.from + 1 + prefix.length),
    };
  });
  target.dispatch(
    state.update(changes, { scrollIntoView: true, userEvent: 'input' }),
  );
  return true;
}

export function enterKey(
  target: Target,
  shift: boolean,
  readOnly: boolean,
  submit: () => void,
): boolean {
  if (target.composing || readOnly) return false;
  if (fencedSelection(target.state)) return fencedNewline(target);
  if (shift)
    return insertNewlineContinueMarkup(target) || insertNewline(target);
  submit();
  return true;
}

export function captureUp(
  target: Target,
  readOnly: boolean,
  navigate?: () => boolean,
): boolean {
  const { ranges } = target.state.selection;
  if (
    target.composing ||
    readOnly ||
    ranges.length !== 1 ||
    !ranges[0].empty ||
    ranges[0].head !== 0
  )
    return false;
  return navigate?.() ?? false;
}
