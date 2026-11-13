import { expect, it } from 'vitest';
import {
  emptyMouseSelection,
  mouseSelect,
  reconcileMouseSelection,
} from '../../src/lib/workspace/mouse-selection';

const displayed = ['note-a', 'stash-b', 'note-c', 'stash-d', 'note-e'];

it('plain click replaces membership and establishes the primary and range anchor', () => {
  const first = mouseSelect(emptyMouseSelection(), displayed, 'note-a', {});
  const second = mouseSelect(first, displayed, 'stash-d', {});
  expect(second).toEqual({
    ids: ['stash-d'],
    primary: 'stash-d',
    anchor: 'stash-d',
  });
});

it('Command-click toggles exact IDs and keeps selected membership in displayed order', () => {
  let state = mouseSelect(emptyMouseSelection(), displayed, 'stash-d', {});
  state = mouseSelect(state, displayed, 'note-a', { metaKey: true });
  expect(state).toEqual({
    ids: ['note-a', 'stash-d'],
    primary: 'note-a',
    anchor: 'note-a',
  });
  state = mouseSelect(state, displayed, 'stash-d', { metaKey: true });
  expect(state).toEqual({
    ids: ['note-a'],
    primary: 'note-a',
    anchor: 'note-a',
  });
  state = mouseSelect(state, displayed, 'note-a', { metaKey: true });
  expect(state).toEqual({ ids: [], primary: '', anchor: '' });
});

it('Shift grows and shrinks the inclusive mixed-kind range from the unchanged original anchor', () => {
  let state = mouseSelect(emptyMouseSelection(), displayed, 'stash-b', {});
  state = mouseSelect(state, displayed, 'note-e', { shiftKey: true });
  expect(state).toEqual({
    ids: ['stash-b', 'note-c', 'stash-d', 'note-e'],
    primary: 'note-e',
    anchor: 'stash-b',
  });
  state = mouseSelect(state, displayed, 'note-c', { shiftKey: true });
  expect(state).toEqual({
    ids: ['stash-b', 'note-c'],
    primary: 'note-c',
    anchor: 'stash-b',
  });
  state = mouseSelect(state, displayed, 'note-a', { shiftKey: true });
  expect(state).toEqual({
    ids: ['note-a', 'stash-b'],
    primary: 'note-a',
    anchor: 'stash-b',
  });
});

it('Shift without a visible anchor selects one and ignores targets outside displayed siblings', () => {
  let state = mouseSelect(emptyMouseSelection(), displayed, 'note-c', {
    shiftKey: true,
  });
  expect(state).toEqual({
    ids: ['note-c'],
    primary: 'note-c',
    anchor: 'note-c',
  });
  state = mouseSelect(state, ['note-a', 'stash-d'], 'stash-d', {
    shiftKey: true,
  });
  expect(state).toEqual({
    ids: ['stash-d'],
    primary: 'stash-d',
    anchor: 'stash-d',
  });
  expect(mouseSelect(state, displayed, 'other-owner', {})).toEqual(state);
});

it('reconciliation drops removed members and invalidates hidden anchors without selecting unrelated items', () => {
  let state = mouseSelect(emptyMouseSelection(), displayed, 'stash-b', {});
  state = mouseSelect(state, displayed, 'stash-d', { shiftKey: true });
  expect(
    reconcileMouseSelection(state, ['note-a', 'note-c', 'note-e']),
  ).toEqual({ ids: ['note-c'], primary: 'note-c', anchor: '' });
  expect(reconcileMouseSelection(state, ['note-a'])).toEqual(
    emptyMouseSelection(),
  );
});

it('removing the selected anchor moves the anchor to a surviving primary before the next range', () => {
  let state = mouseSelect(emptyMouseSelection(), displayed, 'note-a', {});
  state = mouseSelect(state, displayed, 'stash-d', { metaKey: true });
  state = mouseSelect(state, displayed, 'stash-d', { metaKey: true });
  expect(state).toEqual({
    ids: ['note-a'],
    primary: 'note-a',
    anchor: 'note-a',
  });
  expect(mouseSelect(state, displayed, 'note-c', { shiftKey: true })).toEqual({
    ids: ['note-a', 'stash-b', 'note-c'],
    primary: 'note-c',
    anchor: 'note-a',
  });
});

it('Command arrows collect separated selections before moving the block', async () => {
  const { reorderSelected } =
    await import('../../src/lib/workspace/mouse-selection');
  expect(reorderSelected(displayed, ['stash-d', 'stash-b'], -1)).toEqual([
    'stash-b',
    'stash-d',
    'note-a',
    'note-c',
    'note-e',
  ]);
  expect(reorderSelected(displayed, ['stash-b', 'stash-d'], 1)).toEqual([
    'note-a',
    'note-c',
    'stash-b',
    'stash-d',
    'note-e',
  ]);
});

it('clamps blocks at boundaries and moves contiguous blocks one gap at a time', async () => {
  const { reorderSelected } =
    await import('../../src/lib/workspace/mouse-selection');
  expect(reorderSelected(displayed, ['note-a', 'note-c'], -1)).toEqual([
    'note-a',
    'note-c',
    'stash-b',
    'stash-d',
    'note-e',
  ]);
  expect(reorderSelected(displayed, ['note-a', 'stash-b'], -1)).toEqual(
    displayed,
  );
  expect(reorderSelected(displayed, ['stash-d', 'note-e'], 1)).toEqual(
    displayed,
  );
  const once = reorderSelected(displayed, ['stash-b', 'stash-d'], 1);
  expect(reorderSelected(once, ['stash-b', 'stash-d'], 1)).toEqual([
    'note-a',
    'note-c',
    'note-e',
    'stash-b',
    'stash-d',
  ]);
  expect(reorderSelected(displayed, [], 1)).toEqual(displayed);
  expect(reorderSelected(displayed, displayed, 1)).toEqual(displayed);
  expect(reorderSelected(displayed, ['stash-b', 'missing'], 1)).toEqual(
    displayed,
  );
});

it('checks large selected groups with a linear number of displayed-array reads', async () => {
  const { reorderSelected } =
    await import('../../src/lib/workspace/mouse-selection');
  for (const width of [200, 600]) {
    const entries = Array.from(
      { length: width },
      (_, index) => `item-${index}`,
    );
    let reads = 0;
    const observed = new Proxy(entries, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^(0|[1-9]\d*)$/.test(property))
          reads++;
        return Reflect.get(target, property, receiver);
      },
    });
    reorderSelected(observed, entries.slice(0, width - 1), 1);
    expect(reads).toBeLessThan(20 * width);
  }
});
