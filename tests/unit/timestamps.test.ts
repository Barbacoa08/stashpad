import { describe, expect, it } from 'vitest';
import { timestampPresentation } from '../../src/lib/domain/timestamps';
describe('accepted timestamp presentation', () => {
  it('keeps ordinary dates locale-readable with a valid machine value', () => {
    expect(timestampPresentation(0).datetime).toBe('1970-01-01T00:00:00.000Z');
    expect(timestampPresentation(0).label).not.toBe('Date unavailable');
    expect(timestampPresentation(8640000000000000).datetime).toBe(
      '+275760-09-13T00:00:00.000Z',
    );
  });
  it('presents accepted out-of-Date-range timestamps without throwing or emitting invalid datetime', () => {
    for (const timestamp of [8640000000000001, Number.MAX_SAFE_INTEGER]) {
      expect(() => timestampPresentation(timestamp)).not.toThrow();
      expect(timestampPresentation(timestamp)).toEqual({
        label: 'Date unavailable',
        datetime: undefined,
      });
      expect(timestampPresentation(timestamp, 'full')).toEqual({
        label: 'Date unavailable',
        datetime: undefined,
      });
    }
  });
});
