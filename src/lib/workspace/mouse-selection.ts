/** Mouse-only sibling selection. Editor ownership is deliberately independent. */
export type MouseSelection = {
  ids: string[];
  primary: string;
  anchor: string;
};
export const emptyMouseSelection = (): MouseSelection => ({
  ids: [],
  primary: '',
  anchor: '',
});
export function mouseSelect(
  state: MouseSelection,
  displayed: readonly string[],
  target: string,
  modifiers: { metaKey?: boolean; shiftKey?: boolean },
): MouseSelection {
  const index = displayed.indexOf(target);
  if (index < 0) return state;
  const anchor = displayed.indexOf(state.anchor);
  if (modifiers.shiftKey && anchor >= 0) {
    return {
      ids: displayed.slice(
        Math.min(index, anchor),
        Math.max(index, anchor) + 1,
      ),
      primary: target,
      anchor: state.anchor,
    };
  }
  if (modifiers.metaKey && !modifiers.shiftKey) {
    const selected = new Set(state.ids);
    const removing = selected.has(target);
    const ids = displayed.filter((id) =>
      id === target ? !removing : selected.has(id),
    );
    const primary = removing
      ? ids.includes(state.primary)
        ? state.primary
        : (ids.at(-1) ?? '')
      : target;
    return {
      ids,
      primary,
      anchor: removing
        ? ids.includes(state.anchor)
          ? state.anchor
          : primary
        : target,
    };
  }
  return { ids: [target], primary: target, anchor: target };
}
export function reconcileMouseSelection(
  state: MouseSelection,
  displayed: readonly string[],
): MouseSelection {
  const selected = new Set(state.ids);
  const ids = displayed.filter((id) => selected.has(id));
  if (!ids.length) return emptyMouseSelection();
  return {
    ids,
    primary: ids.includes(state.primary) ? state.primary : ids.at(-1)!,
    anchor: displayed.includes(state.anchor) ? state.anchor : '',
  };
}

/** Collect selected siblings into a block and move it one unselected gap. */
export function reorderSelected(
  displayed: readonly string[],
  ids: readonly string[],
  direction: -1 | 1,
): string[] {
  const selected = new Set(ids);
  if (!selected.size) return [...displayed];
  const block = displayed.filter((id) => selected.has(id));
  if (block.length !== selected.size) return [...displayed];
  const remaining = displayed.filter((id) => !selected.has(id));
  const first = displayed.findIndex((id) => selected.has(id));
  const gap = Math.max(0, Math.min(remaining.length, first + direction));
  return [...remaining.slice(0, gap), ...block, ...remaining.slice(gap)];
}
