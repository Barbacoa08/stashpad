import {
  EditorState,
  StateField,
  StateEffect,
  MapMode,
  type Extension,
  type TransactionSpec,
  type ChangeDesc,
} from '@codemirror/state';
import { invertedEffects } from '@codemirror/commands';
import { EditorView } from '@codemirror/view';

type Separator = '\n' | '\r\n' | '\r';
interface SourceBreak {
  position: number;
  separator: Separator;
}

/** Metadata uses CM's logical positions: every source separator occupies one position. */
function sourceBreaks(source: string): SourceBreak[] {
  const result: SourceBreak[] = [];
  let rawOffset = 0,
    logicalOffset = 0;
  for (const match of source.matchAll(/\r\n?|\n/g)) {
    const position = logicalOffset + match.index - rawOffset;
    result.push({ position, separator: match[0] as Separator });
    rawOffset = match.index + match[0].length;
    logicalOffset = position + 1;
  }
  return result;
}
function mappedBreaks(
  breaks: readonly SourceBreak[],
  changes: ChangeDesc,
): SourceBreak[] {
  return breaks.flatMap((entry) => {
    const position = changes.mapPos(entry.position, 1, MapMode.TrackAfter);
    return position === null ? [] : [{ ...entry, position }];
  });
}
const restoreBreaks = StateEffect.define<readonly SourceBreak[]>({
  map: mappedBreaks,
});
const separators = StateField.define<readonly SourceBreak[]>({
  create: (state) => sourceBreaks(state.doc.toString()),
  update(previous, tr) {
    if (
      !tr.docChanged &&
      !tr.effects.some((effect) => effect.is(restoreBreaks))
    )
      return previous;
    const next = new Map(
      mappedBreaks(previous, tr.changes).map((entry) => [
        entry.position,
        entry,
      ]),
    );
    const preferred = previous[0]?.separator ?? '\n';
    tr.changes.iterChanges((_from, _to, from, _end, inserted) => {
      for (const entry of sourceBreaks(inserted.toString())) {
        const position = from + entry.position;
        next.set(position, { position, separator: preferred });
      }
    });
    for (const effect of tr.effects)
      if (effect.is(restoreBreaks)) {
        for (const entry of effect.value) {
          if (
            tr.newDoc.sliceString(entry.position, entry.position + 1) === '\n'
          )
            next.set(entry.position, entry);
        }
      }
    return [...next.values()].sort((a, b) => a.position - b.position);
  },
});

/** Serialize a logical range using its exact source separators, including mixed endings. */
export function editorSource(
  state: EditorState,
  from = 0,
  to = state.doc.length,
): string {
  const breaks = state.field(separators);
  let index = 0;
  while (index < breaks.length && breaks[index].position < from) index++;
  return state.doc
    .sliceString(from, to)
    .replace(/\n/g, () => breaks[index++].separator);
}
/** External source synchronization supplies its raw metadata in the same transaction. */
export function sourceReplacement(
  state: EditorState,
  source: string,
): TransactionSpec {
  return {
    changes: { from: 0, to: state.doc.length, insert: source },
    effects: restoreBreaks.of(sourceBreaks(source)),
  };
}

export function sourceExtensions(source: string): Extension {
  let rawInput: string | null = null;
  return [
    separators.init(() => sourceBreaks(source)),
    invertedEffects.of((tr) => {
      // Only removed separators need history effects; the document changes remain CM's.
      const removed = tr.startState
        .field(separators)
        .filter(
          (entry) =>
            tr.changes.mapPos(entry.position, 1, MapMode.TrackAfter) === null,
        );
      return removed.length ? [restoreBreaks.of(removed)] : [];
    }),
    EditorView.clipboardOutputFilter.of((text, state) => {
      const ranges = state.selection.ranges.filter((range) => !range.empty);
      // Preserve CM's ordinary line-wise copy when no range is selected.
      return ranges.length
        ? ranges
            .map((range) => editorSource(state, range.from, range.to))
            .join(state.lineBreak)
        : text;
    }),
    EditorView.clipboardInputFilter.of((text) => {
      rawInput = text;
      return text;
    }),
    EditorView.domEventObservers({
      beforeinput: (event) => {
        rawInput = event.data;
      },
    }),
    EditorState.transactionExtender.of((tr) => {
      if (!tr.docChanged) return null;
      const raw = rawInput;
      rawInput = null;
      if (
        raw === null ||
        !(tr.isUserEvent('input') || tr.isUserEvent('move.drop'))
      )
        return null;
      const normalized = raw.replace(/\r\n?|\n/g, '\n');
      const overrides: SourceBreak[] = [];
      tr.changes.iterChanges((_from, _to, from, _end, inserted) => {
        if (inserted.toString() === normalized)
          overrides.push(
            ...sourceBreaks(raw).map((entry) => ({
              ...entry,
              position: from + entry.position,
            })),
          );
      });
      return overrides.length ? { effects: restoreBreaks.of(overrides) } : null;
    }),
  ];
}
