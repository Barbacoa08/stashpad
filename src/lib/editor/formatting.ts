import {
  EditorSelection,
  StateField,
  StateEffect,
  type ChangeDesc,
  type EditorState,
  type Transaction,
  type ChangeSpec,
} from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';
import { isolateHistory, invertedEffects } from '@codemirror/commands';

type Target = {
  state: EditorState;
  composing: boolean;
  dispatch: (transaction: Transaction) => void;
};
type Style = 'bold' | 'italic';
type Span = {
  from: number;
  to: number;
  openTo: number;
  closeFrom: number;
  style: Style;
};

// Empty paired markers have no Markdown emphasis node. Track only pairs this
// command inserted, preserving their boundaries through nested formatting and
// typing, so literal stars and horizontal rules are never guessed at.
function mapPairs(pairs: readonly Span[], changes: ChangeDesc): Span[] {
  return pairs.map((pair) => ({
    ...pair,
    from: changes.mapPos(pair.from, 1),
    to: changes.mapPos(pair.to, -1),
    openTo: changes.mapPos(pair.openTo, -1),
    closeFrom: changes.mapPos(pair.closeFrom, 1),
  }));
}
const restorePairs = StateEffect.define<readonly Span[]>({ map: mapPairs });
const commandPairs = StateField.define<readonly Span[]>({
  create: () => [],
  update(previous, tr) {
    let pairs = mapPairs(previous, tr.changes);
    for (const effect of tr.effects)
      if (effect.is(restorePairs)) pairs = [...effect.value];
    return pairs.filter((pair) => {
      const marker = pair.style === 'bold' ? '**' : '*';
      return (
        pair.from >= 0 &&
        pair.from + marker.length === pair.openTo &&
        pair.openTo <= pair.closeFrom &&
        pair.closeFrom + marker.length === pair.to &&
        pair.to <= tr.newDoc.length &&
        tr.newDoc.sliceString(pair.from, pair.openTo) === marker &&
        tr.newDoc.sliceString(pair.closeFrom, pair.to) === marker
      );
    });
  },
});
export const formattingExtensions = [
  commandPairs,
  invertedEffects.of((tr) =>
    tr.docChanged ? [restorePairs.of(tr.startState.field(commandPairs))] : [],
  ),
];

/** Change markers only: replacing selected text would discard exact source separators. */
export function toggleMarkdownStyle(target: Target, style: Style): boolean {
  const { state } = target;
  // Consume the binding even when protected, so browser formatting cannot take over.
  if (target.composing || state.readOnly) return true;
  const ranges = state.selection.ranges;
  const tree = ensureSyntaxTree(state, state.doc.length, 100);
  if (!tree || tree.type.name !== 'Document') return true;
  const spans: Span[] = [...(state.field(commandPairs, false) ?? [])];
  let protectedCode = false;
  tree.iterate({
    enter(node) {
      if (['FencedCode', 'InlineCode', 'CodeBlock'].includes(node.name)) {
        if (
          ranges.some((r) =>
            r.empty
              ? r.from >= node.from && r.to <= node.to
              : r.from < node.to && r.to > node.from,
          )
        )
          protectedCode = true;
        return false;
      }
      if (node.name !== 'StrongEmphasis' && node.name !== 'Emphasis') return;
      const marks = node.node.getChildren('EmphasisMark');
      if (marks.length !== 2) return;
      spans.push({
        from: node.from,
        to: node.to,
        openTo: marks[0].to,
        closeFrom: marks[1].from,
        style: node.name === 'StrongEmphasis' ? 'bold' : 'italic',
      });
    },
  });
  if (protectedCode) return true;
  const marker = style === 'bold' ? '**' : '*';
  function includesCombinedMarkers(
    span: Span,
    from: number,
    to: number,
  ): boolean {
    if (from === span.from && to === span.to) return true;
    const outer = spans.find(
      (s) => s.openTo === span.from && s.closeFrom === span.to,
    );
    return outer ? includesCombinedMarkers(outer, from, to) : false;
  }
  function enclosingFor(range: (typeof ranges)[number]) {
    return spans
      .filter(
        (s) =>
          s.style === style &&
          ((range.from >= s.openTo && range.to <= s.closeFrom) ||
            includesCombinedMarkers(s, range.from, range.to)),
      )
      .sort((a, b) => a.to - a.from - (b.to - b.from))[0];
  }
  // A partial delimiter selection has no unambiguous style intent. In particular,
  // never insert into a marker another simultaneous range is about to remove.
  if (
    ranges.some(
      (range) =>
        !enclosingFor(range) &&
        spans.some((span) =>
          range.empty
            ? (range.from > span.from && range.from < span.openTo) ||
              (range.from > span.closeFrom && range.from < span.to)
            : !(range.from <= span.from && range.to >= span.to) &&
              ((range.from < span.openTo && range.to > span.from) ||
                (range.from < span.to && range.to > span.closeFrom)),
        ),
    )
  )
    return true;
  const removed = new Set<string>();
  const changes = state.changeByRange((range) => {
    const enclosing = enclosingFor(range);
    let edits: ChangeSpec;
    if (enclosing) {
      edits = [
        { from: enclosing.from, to: enclosing.openTo },
        { from: enclosing.closeFrom, to: enclosing.to },
      ].filter((edit) => {
        const key = `${edit.from}:${edit.to}`;
        if (removed.has(key)) return false;
        removed.add(key);
        return true;
      });
    } else if (range.empty) {
      edits = { from: range.from, insert: marker + marker };
    } else {
      edits = [
        { from: range.from, insert: marker },
        { from: range.to, insert: marker },
      ];
    }
    const local = state.changes(edits);
    const from = enclosing
      ? local.mapPos(range.from, 1)
      : range.from + marker.length;
    const to = enclosing
      ? local.mapPos(range.to, -1)
      : range.to + marker.length;
    return {
      changes: local,
      range: range.empty
        ? EditorSelection.cursor(from)
        : EditorSelection.range(
            range.anchor < range.head ? from : to,
            range.anchor < range.head ? to : from,
          ),
    };
  });
  const pairs = mapPairs(
    state.field(commandPairs, false) ?? [],
    changes.changes,
  );
  for (const range of ranges) {
    if (
      !range.empty ||
      spans.some(
        (s) =>
          s.style === style &&
          range.from >= s.openTo &&
          range.to <= s.closeFrom,
      )
    )
      continue;
    const from = changes.changes.mapPos(range.from, -1);
    pairs.push({
      from,
      to: from + marker.length * 2,
      openTo: from + marker.length,
      closeFrom: from + marker.length,
      style,
    });
  }
  target.dispatch(
    state.update(changes, {
      effects: restorePairs.of(pairs),
      sequential: true,
      annotations: isolateHistory.of('full'),
      userEvent: 'input.format',
      scrollIntoView: true,
    }),
  );
  // Remember the command's inside selection as the redo destination. CM's
  // default mapped cursor otherwise lands after an empty inserted marker pair.
  // This selection-only event creates no additional document Undo step.
  target.dispatch(
    target.state.update({
      selection: target.state.selection,
      userEvent: 'select.format',
    }),
  );
  return true;
}
