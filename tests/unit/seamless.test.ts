import { afterEach, expect, it, vi } from 'vitest';
import { WorkspaceController } from '../../src/lib/workspace/controller';
import { MemoryRepository } from '../fixtures/memory';
const controllers: WorkspaceController[] = [];
afterEach(() => {
  controllers.forEach((c) => c.dispose());
  vi.useRealTimers();
});
async function setup() {
  const repo = new MemoryRepository(),
    c = new WorkspaceController(repo);
  controllers.push(c);
  await c.start();
  c.editSource('saved');
  await c.save();
  const id = repo.snapshot.notes[0].id;
  await c.selectNote(id);
  return { repo, c, id };
}
it('idle edits coalesce into saved source without leaving the active editor, and capture remains explicit', async () => {
  const { repo, c, id } = await setup();
  vi.useFakeTimers();
  c.editSource('first');
  await vi.advanceTimersByTimeAsync(250);
  c.editSource('latest\r\n');
  await vi.advanceTimersByTimeAsync(299);
  expect(repo.snapshot.notes[0].markdown).toBe('saved');
  await vi.advanceTimersByTimeAsync(1);
  expect(repo.snapshot.notes[0].markdown).toBe('latest\r\n');
  expect(c.state.activeKey).toBe(id);
  expect(c.state.source).toBe('latest\r\n');
  c.editContext('compose', 'capture');
  await vi.advanceTimersByTimeAsync(300);
  expect(repo.snapshot.notes).toHaveLength(1);
  expect(repo.snapshot.drafts[0].markdown).toBe('capture');
});
it('flush drains newer inline revisions during a delayed acknowledgment without changing owner or active edit', async () => {
  const { repo, c, id } = await setup();
  c.editSource('first');
  let release!: () => void;
  repo.delaySave = new Promise<void>((r) => (release = r));
  const pending = c.flush();
  await new Promise((r) => setTimeout(r, 0));
  c.editSource('latest\r\n\n');
  release();
  expect(await pending).toBe(true);
  expect(repo.snapshot.notes[0].markdown).toBe('latest\r\n\n');
  expect(c.state.activeKey).toBe(id);
  expect(c.state.source).toBe('latest\r\n\n');
});
it('failed inline flush keeps source and a recovery draft, prevents navigation, and retry commits an empty existing note', async () => {
  const { repo, c, id } = await setup();
  c.editSource('');
  repo.fail = 'save';
  expect(await c.newNote()).toBe(false);
  expect(c.state.activeKey).toBe(id);
  expect(c.state.source).toBe('');
  expect(repo.snapshot.notes[0].markdown).toBe('saved');
  expect(repo.snapshot.drafts.find((d) => d.key === id)?.markdown).toBe('');
  repo.fail = null;
  expect(await c.newNote()).toBe(true);
  expect(repo.snapshot.notes[0]).toMatchObject({
    id,
    markdown: '',
    stashId: null,
  });
});
it('Escape finish keeps changes and delete/Undo retains latest visible source', async () => {
  const { repo, c, id } = await setup();
  c.editSource('finished');
  expect(await c.finishEdit()).toBe(true);
  expect(repo.snapshot.notes[0].markdown).toBe('finished');
  await c.selectNote(id);
  c.editSource('latest before delete');
  expect(await c.remove()).toBe(true);
  expect(repo.snapshot.notes[0].deletedAt).not.toBeNull();
  await c.undoRemove();
  expect(repo.snapshot.notes[0].markdown).toBe('latest before delete');
});
it('export and restore preview flush note source rather than leaving only an edit draft', async () => {
  const { repo, c } = await setup();
  c.editSource('exported\r\n');
  expect(await c.export()).toBe(true);
  expect(JSON.parse(repo.exported!).workspace.notes[0].markdown).toBe(
    'exported\r\n',
  );
  c.editSource('before preview');
  await c.previewRestore();
  expect(repo.snapshot.notes[0].markdown).toBe('before preview');
});
it('one pending instant creation creates one Untitled stash in the open parent and preserves the latest inline source', async () => {
  const { repo, c, id } = await setup();
  c.editSource('before new stash');
  let release!: () => void;
  repo.delayCreate = new Promise<void>((r) => (release = r));
  const first = c.createStash('Untitled'),
    second = c.createStash('Untitled');
  await new Promise((r) => setTimeout(r, 0));
  release();
  expect(await first).toBe(true);
  expect(await second).toBe(true);
  expect(repo.snapshot.stashes).toHaveLength(1);
  expect(repo.snapshot.stashes[0].parentId).toBeNull();
  expect(repo.snapshot.notes.find((n) => n.id === id)?.markdown).toBe(
    'before new stash',
  );
});

it('failed latest-source delete leaves the original note alive, retains the revision, and retry/Undo restores it exactly', async () => {
  const { repo, c, id } = await setup();
  c.editSource(' \r\n\n');
  repo.fail = 'save';
  expect(await c.remove()).toBe(false);
  expect(repo.snapshot.notes[0].deletedAt).toBeNull();
  expect(c.state.source).toBe(' \r\n\n');
  repo.fail = null;
  expect(await c.remove()).toBe(true);
  await c.undoRemove();
  expect(repo.snapshot.notes[0]).toMatchObject({
    id,
    markdown: ' \r\n\n',
    done: false,
    deletedAt: null,
  });
});
it('normal close drains late inline input before destroying and keeps the window open on commit failure', async () => {
  const { attachCloseGuard } = await import('../../src/lib/platform/lifecycle');
  const { repo, c } = await setup();
  c.editSource('pending');
  let release!: () => void;
  repo.delaySave = new Promise<void>((r) => (release = r));
  let handler!: (e: { preventDefault(): void }) => void | Promise<void>;
  let destroyed: string | undefined,
    failed = 0;
  const detach = attachCloseGuard(
    {
      onCloseRequested: async (fn) => {
        handler = fn;
        return () => {};
      },
      destroy: async () => {
        destroyed = repo.snapshot.notes[0].markdown;
      },
    },
    () => c.flush(),
    () => failed++,
  );
  await Promise.resolve();
  const closing = handler({ preventDefault() {} });
  await new Promise((r) => setTimeout(r, 0));
  c.editSource('latest close\r\n');
  release();
  await closing;
  expect(destroyed).toBe('latest close\r\n');
  c.editSource('retained after failed close');
  repo.fail = 'save';
  destroyed = undefined;
  await handler({ preventDefault() {} });
  expect(destroyed).toBeUndefined();
  expect(failed).toBe(1);
  expect(c.state.source).toBe('retained after failed close');
  detach();
});

it('delayed creation retains a newer search query rather than clearing a later user intent', async () => {
  const { repo, c } = await setup();
  let release!: () => void;
  repo.delayCreate = new Promise<void>((r) => (release = r));
  c.setQuery('previous');
  const pending = c.createStash('Untitled');
  await new Promise((r) => setTimeout(r, 0));
  c.setQuery('new intent');
  release();
  await pending;
  expect(c.state.query).toBe('new intent');
});

for (const action of ['finish', 'navigate', 'close'] as const)
  it(`recovered existing edit commits without new typing on ${action}, while its owner's compose remains a draft`, async () => {
    const repo = new MemoryRepository();
    const owner = (await repo.createStash('Owner', null)).stashes[0].id;
    const id = (
      await repo.saveNote(null, 'old saved', `compose:${owner}`, 1, owner)
    ).notes[0].id;
    await repo.checkpointDraft(id, 'recovered edit\r\n', 7);
    await repo.checkpointDraft(`compose:${owner}`, 'recovered capture\n', 4);
    const c = new WorkspaceController(repo);
    controllers.push(c);
    await c.start();
    await c.selectNote(id);
    expect(c.state.source).toBe('recovered edit\r\n');
    expect(
      await (action === 'finish'
        ? c.finishEdit()
        : action === 'navigate'
          ? c.openStash(null)
          : c.flush()),
    ).toBe(true);
    expect(repo.snapshot.notes[0]).toMatchObject({
      id,
      stashId: owner,
      markdown: 'recovered edit\r\n',
    });
    expect(repo.snapshot.drafts).toEqual([
      expect.objectContaining({
        key: `compose:${owner}`,
        markdown: 'recovered capture\n',
        revision: 4,
      }),
    ]);
  });

for (const laterTyping of [false, true])
  it(`newer retain-edit intent invalidates a delayed blur finish without losing source; later typing=${laterTyping}`, async () => {
    const { repo, c, id } = await setup();
    c.retainEdit(id);
    c.editSource('latest visible source');
    let release!: () => void;
    repo.delaySave = new Promise<void>((r) => (release = r));
    const leaving = c.finishEdit(id, 'blur');
    await new Promise((r) => setTimeout(r, 0));
    c.retainEdit(id);
    if (laterTyping) c.editSource('latest visible source!');
    release();
    expect(await leaving).toBe(true);
    expect(c.state.activeKey).toBe(id);
    expect(c.state.source).toBe(
      laterTyping ? 'latest visible source!' : 'latest visible source',
    );
    expect(repo.snapshot.notes[0].markdown).toBe(
      laterTyping ? 'latest visible source!' : 'latest visible source',
    );
    expect(repo.snapshot.notes).toHaveLength(1);
    expect(repo.snapshot.notes[0].stashId).toBeNull();
    expect(await c.finishEdit(id, 'blur')).toBe(true);
    expect(c.state.activeKey).toBe('compose');
  });
it('newer retain-edit intent does not cancel an explicit finish', async () => {
  const { repo, c, id } = await setup();
  c.retainEdit(id);
  c.editSource('explicit latest');
  let release!: () => void;
  repo.delaySave = new Promise<void>((r) => (release = r));
  const finishing = c.finishEdit(id);
  await new Promise((r) => setTimeout(r, 0));
  c.retainEdit(id);
  c.editSource('explicit newer');
  release();
  expect(await finishing).toBe(true);
  expect(c.state.activeKey).toBe('compose');
  expect(repo.snapshot.notes[0].markdown).toBe('explicit newer');
});
