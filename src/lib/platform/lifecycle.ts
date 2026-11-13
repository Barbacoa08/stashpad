export interface CloseAdapter {
  onCloseRequested(
    handler: (event: { preventDefault(): void }) => void | Promise<void>,
  ): Promise<() => void>;
  hide(): Promise<void>;
}
export function attachCloseGuard(
  adapter: CloseAdapter,
  flush: () => Promise<boolean>,
  failed: () => void,
) {
  let disposed = false,
    busy = false,
    unlisten: (() => void) | undefined;
  adapter
    .onCloseRequested(async (event) => {
      event.preventDefault();
      if (disposed || busy) return;
      busy = true;
      try {
        if (await flush()) {
          if (!disposed) await adapter.hide();
        } else if (!disposed) failed();
      } catch {
        if (!disposed) failed();
      } finally {
        busy = false;
      }
    })
    .then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    })
    .catch(() => {
      if (!disposed) failed();
    });
  return () => {
    if (disposed) return;
    disposed = true;
    unlisten?.();
    unlisten = undefined;
  };
}
