// Wry emits untrusted DOM side-button events and uses unprevented mouseup for
// URL history. Consume every phase, including when app history cannot move.
export function attachMouseHistory(
  target: Window,
  traverse: (direction: -1 | 1) => void,
): () => void {
  function handle(event: MouseEvent) {
    if (event.button !== 3 && event.button !== 4) return;
    event.preventDefault();
    if (event.type === 'mouseup') traverse(event.button === 3 ? -1 : 1);
  }
  const phases = ['mousedown', 'mouseup', 'auxclick'] as const;
  for (const phase of phases) target.addEventListener(phase, handle, true);
  return () => {
    for (const phase of phases) target.removeEventListener(phase, handle, true);
  };
}
