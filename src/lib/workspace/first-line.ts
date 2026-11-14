/** Viewport center of the first displayed text line, including an empty code row. */
export function firstLineCenter(root: Element): number | null {
  const first = root.firstElementChild;
  if (first?.tagName === 'HR') {
    const rect = first.getBoundingClientRect();
    return rect.top + rect.height / 2;
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const codeLine = node.parentElement?.closest('.code-line');
    if (codeLine) {
      const rect = codeLine.getBoundingClientRect();
      return rect.top + rect.height / 2;
    }
    const offset = node.textContent?.search(/\S/) ?? -1;
    if (offset < 0) continue;
    const range = document.createRange();
    range.setStart(node, offset);
    range.setEnd(node, offset + 1);
    const rect = range.getClientRects()[0];
    if (rect?.height) return rect.top + rect.height / 2;
  }
  return null;
}
