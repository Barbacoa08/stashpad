import { tick } from 'svelte';

// Cosmetic FLIP on real keyed cards, after the acknowledged order is rendered.
// Scheduling after tick leaves existing nearest-item visibility authoritative.
export function createReorderMotion(getStream: () => HTMLElement | undefined) {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const animations = new Set<Animation>();
  let frame = 0;
  let generation = 0;
  let disposed = false;
  const sizes = new Map<Element, { width: number; height: number }>();
  const observer = new ResizeObserver((entries) => {
    for (const { target } of entries) {
      const before = sizes.get(target),
        after = target.getBoundingClientRect();
      if (
        before &&
        (Math.abs(before.width - after.width) > 0.5 ||
          Math.abs(before.height - after.height) > 0.5)
      ) {
        cancel();
        break;
      }
    }
  });
  function cancel() {
    generation++;
    cancelAnimationFrame(frame);
    frame = 0;
    observer.disconnect();
    sizes.clear();
    // Never cancel descendants' animations, especially CodeMirror caret blinking.
    for (const animation of animations) animation.cancel();
    animations.clear();
  }
  function reorder(order: readonly string[]) {
    const stream = getStream();
    if (!stream || disposed) return;
    const rows = Array.from(
      stream.querySelectorAll<HTMLElement>(':scope > [data-entry-id]'),
    );
    const before = new Map(
      rows.map((row) => [
        row.dataset.entryId!,
        { node: row, rect: row.getBoundingClientRect() },
      ]),
    );
    // Read current visual positions before cancelling an interrupted movement.
    cancel();
    if (
      reduced.matches ||
      document.hidden ||
      order.length !== rows.length ||
      order.some((id) => !before.has(id)) ||
      rows.every((row, index) => row.dataset.entryId === order[index])
    )
      return;
    const token = generation;
    const scroll = {
      top: stream.scrollTop,
      left: stream.scrollLeft,
      x: window.scrollX,
      y: window.scrollY,
    };
    void tick().then(() => {
      if (token !== generation || disposed) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (
          token !== generation ||
          reduced.matches ||
          document.hidden ||
          stream !== getStream() ||
          !stream.isConnected ||
          scroll.top !== stream.scrollTop ||
          scroll.left !== stream.scrollLeft ||
          scroll.x !== window.scrollX ||
          scroll.y !== window.scrollY
        )
          return;
        const after = Array.from(
          stream.querySelectorAll<HTMLElement>(':scope > [data-entry-id]'),
        );
        if (
          after.length !== order.length ||
          after.some((row, index) => row !== before.get(order[index])?.node)
        )
          return;
        const rects = after.map((row) => row.getBoundingClientRect());
        // Content, wrapping, expansion, or editor geometry changed: settle instantly.
        if (
          after.some((row, index) => {
            const old = before.get(row.dataset.entryId!)!.rect,
              rect = rects[index];
            return (
              Math.abs(old.width - rect.width) > 0.5 ||
              Math.abs(old.height - rect.height) > 0.5
            );
          })
        )
          return;
        for (const node of [stream, ...after]) {
          const rect = node.getBoundingClientRect();
          sizes.set(node, { width: rect.width, height: rect.height });
          observer.observe(node);
        }
        after.forEach((row, index) => {
          const old = before.get(row.dataset.entryId!)!.rect,
            rect = rects[index];
          const x = old.left - rect.left,
            y = old.top - rect.top;
          if (Math.abs(x) < 0.5 && Math.abs(y) < 0.5) return;
          const animation = row.animate(
            [
              { transform: `translate(${x}px, ${y}px)` },
              { transform: 'translate(0px, 0px)' },
            ],
            { duration: 300, easing: 'cubic-bezier(0.333333, 1, 0.666667, 1)' },
          );
          animations.add(animation);
          // No finished promise: cancellation never creates a rejected task.
          animation.onfinish = animation.oncancel = () => {
            animations.delete(animation);
            if (!animations.size) {
              observer.disconnect();
              sizes.clear();
            }
          };
        });
      });
    });
  }
  window.addEventListener('scroll', cancel, true);
  window.addEventListener('resize', cancel);
  window.addEventListener('blur', cancel);
  document.addEventListener('visibilitychange', cancel);
  function preferenceChanged() {
    if (reduced.matches) cancel();
  }
  reduced.addEventListener('change', preferenceChanged);
  return {
    reorder,
    cancel,
    destroy() {
      disposed = true;
      cancel();
      window.removeEventListener('scroll', cancel, true);
      window.removeEventListener('resize', cancel);
      window.removeEventListener('blur', cancel);
      document.removeEventListener('visibilitychange', cancel);
      reduced.removeEventListener('change', preferenceChanged);
    },
  };
}
