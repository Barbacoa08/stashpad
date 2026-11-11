/** Present accepted v1 timestamps without changing or narrowing stored values. */
export function timestampPresentation(
  timestamp: number,
  style: 'compact' | 'full' = 'compact',
): { label: string; datetime?: string } {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime()))
    return { label: 'Date unavailable', datetime: undefined };
  return {
    label: date.toLocaleString(
      undefined,
      style === 'compact'
        ? { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
        : undefined,
    ),
    datetime: date.toISOString(),
  };
}
