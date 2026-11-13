import { test, expect, type Page } from '@playwright/test';
const capture = (p: Page) =>
  p.getByRole('textbox', { name: 'Capture Markdown' });
const edit = (p: Page) => p.getByRole('textbox', { name: 'Edit Markdown' });
const stream = (p: Page) => p.getByRole('region', { name: 'Note stream' });
const card = (p: Page, id: string) => p.locator(`[data-entry-id="${id}"]`);
const trash = (p: Page) =>
  p.getByRole('button', { name: 'Trash', exact: true });
const restore = (p: Page) =>
  p.getByRole('button', { name: 'Restore item', exact: true });
async function seed(p: Page) {
  await p.goto('/?fixture');
  await capture(p).waitFor();
  return p.evaluate(async () => {
    const t = (window as any).__test;
    const ids = Array.from({ length: 5 }, () => crypto.randomUUID());
    for (const [i, markdown] of [
      'first',
      'parent **source**',
      'last',
    ].entries())
      await t.repo.captureItem({
        id: ids[i],
        location: { scope: 'live', itemId: null },
        markdown,
        draft: { key: 'compose', revision: 0 },
      });
    await t.repo.createChildStash({
      id: ids[3],
      parent: { scope: 'live', itemId: ids[1] },
    });
    await t.repo.saveItemSource(ids[3], 'nested stash', {
      key: ids[3],
      revision: 0,
    });
    await t.repo.captureItem({
      id: ids[4],
      location: { scope: 'live', itemId: ids[1] },
      markdown: 'child match',
      draft: { key: `compose:${ids[1]}`, revision: 0 },
    });
    await t.controller.start();
    return ids;
  });
}
async function deleteParent(p: Page, ids: string[]) {
  await card(p, ids[1]).click();
  await p.keyboard.press('Meta+Backspace');
  await expect(card(p, ids[1])).toHaveCount(0);
  await trash(p).click();
  await expect(p.locator('h1')).toHaveText('Trash');
}
test('Trash opens retained trees with ordinary editing, capture, keyboard commands, and exact histories across restore', async ({
  page,
}) => {
  const ids = await seed(page);
  await card(page, ids[1]).dblclick();
  await edit(page).press('Meta+End');
  await page.keyboard.insertText(' appended');
  await edit(page).press('Escape');
  await card(page, ids[1]).click();
  await page.keyboard.press('ArrowRight');
  await capture(page).fill('unsaved child capture');
  await page.keyboard.press('Meta+1');
  await deleteParent(page, ids);
  await expect(
    page.getByRole('button', {
      name: 'Open stash parent **source** appended',
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('complementary', { name: 'Note details' }),
  ).toContainText('at least 90 days');
  await expect(
    page.getByRole('complementary', { name: 'Note details' }),
  ).toContainText('Automatic permanent cleanup is not enabled yet.');
  await card(page, ids[1]).click();
  await page.keyboard.press('e');
  await page.keyboard.insertText('!');
  await expect(edit(page)).toHaveText('parent **source** appended!');
  await edit(page).press('Meta+z');
  await expect(edit(page)).toHaveText('parent **source** appended');
  await edit(page).press('Escape');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('h1')).toHaveText(
    'Trash / parent **source** appended',
  );
  await expect(capture(page)).toHaveText('unsaved child capture');
  await card(page, ids[4]).click();
  await page.keyboard.press('x');
  await expect(
    card(page, ids[4]).getByRole('button', { name: 'Mark done' }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('e');
  await edit(page).fill('```js\ncode\n```');
  await edit(page).press('Meta+End');
  await edit(page).press('Enter');
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__test.controller.state.source),
    )
    .toBe('```js\ncode\n```\n');
  await edit(page).press('Escape');
  await stream(page).press('ArrowLeft');
  await expect(card(page, ids[1])).toHaveClass(/selected/);
  await restore(page).click();
  await expect(card(page, ids[1])).toHaveCount(0);
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await card(page, ids[1]).click();
  await page.keyboard.press('ArrowRight');
  await expect(capture(page)).toHaveText('unsaved child capture');
  expect(
    await page.evaluate(
      () => (window as any).__test.repo.snapshot.items.length,
    ),
  ).toBe(5);
});
test('deleting an inherited Trash child permanently removes it while parent Restore preserves surviving children', async ({
  page,
}) => {
  const ids = await seed(page);
  await deleteParent(page, ids);
  await card(page, ids[1]).click();
  await page.keyboard.press('ArrowRight');
  await card(page, ids[3]).click();
  await expect(
    page.getByRole('complementary', { name: 'Note details' }),
  ).toContainText('Inherited from');
  await page.keyboard.press('Meta+Backspace');
  await expect(card(page, ids[3])).toHaveCount(0);
  await expect(card(page, ids[4])).toHaveClass(/selected/);
  await stream(page).press('ArrowLeft');
  await card(page, ids[1]).click();
  await restore(page).click();
  await expect(capture(page)).toBeFocused();
  const state = await page.evaluate(() => (window as any).__test.repo.snapshot);
  expect(state.items.some((item: any) => item.id === ids[3])).toBe(false);
  expect(state.items.find((item: any) => item.id === ids[4]).parentId).toBe(
    ids[1],
  );
  expect(state.undoDeleteIds).toEqual([]);
});
test('Trash search stays scoped with bounded paths, restores inherited tree to Home, and preserves capture destination', async ({
  page,
}) => {
  const ids = await seed(page);
  await deleteParent(page, ids);
  await card(page, ids[1]).click();
  await page.keyboard.press('ArrowRight');
  await page.getByRole('searchbox').fill('child match');
  await expect(card(page, ids[4])).toContainText('Trash / parent **source**');
  await card(page, ids[4]).click();
  await restore(page).click();
  await expect(page.getByRole('searchbox')).toHaveValue('child match');
  await expect(page.locator('h1')).toHaveText('Trash / parent **source**');
  await expect(card(page, ids[4])).toHaveCount(0);
  await page.keyboard.press('Meta+1');
  await page.getByRole('searchbox').fill('child match');
  await expect(card(page, ids[4])).toBeVisible();
  await page.getByRole('searchbox').fill('parent');
  await expect(stream(page).getByRole('article')).toHaveCount(0);
});
test('restoring the open Trash tree through search follows its valid live location and Back returns Home', async ({
  page,
}) => {
  const ids = await seed(page);
  await deleteParent(page, ids);
  await card(page, ids[1]).click();
  await page.keyboard.press('ArrowRight');
  await page.getByRole('searchbox').fill('parent');
  await card(page, ids[1]).dblclick();
  await edit(page).fill('parent revised');
  await restore(page).click();
  await expect(page.locator('h1')).toHaveText('Home / parent revised');
  await card(page, ids[1]).click();
  await page.keyboard.press('e');
  await expect(edit(page)).toHaveText('parent revised');
  await edit(page).press('Escape');
  await stream(page).press('ArrowLeft');
  await expect(page.locator('h1')).toHaveText('Home');
  await expect(card(page, ids[1])).toHaveClass(/selected/);
});
test('Restore failure retries captured target, flushes source, keeps draft, and respects newer Search focus', async ({
  page,
}) => {
  const ids = await seed(page);
  await deleteParent(page, ids);
  await card(page, ids[1]).dblclick();
  await edit(page).fill('latest parent');
  await capture(page).fill('unsubmitted Trash capture');
  await page.evaluate(
    () => ((window as any).__test.repo.fail = 'restore-item'),
  );
  await restore(page).click();
  await expect(
    page.getByRole('button', { name: 'Retry action', exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    const t = (window as any).__test;
    t.repo.fail = null;
    const original = t.repo.restoreItem.bind(t.repo);
    t.repo.restoreItem = async (id: string) => {
      await new Promise<void>((r) => (t.releaseRestore = r));
      return original(id);
    };
  });
  await page.getByRole('button', { name: 'Retry action', exact: true }).click();
  await page.getByRole('searchbox').fill('newer query');
  await page.evaluate(() => (window as any).__test.releaseRestore());
  await expect(page.getByRole('searchbox')).toBeFocused();
  await expect(page.getByRole('searchbox')).toHaveValue('newer query');
  await expect(capture(page)).toHaveText('unsubmitted Trash capture');
  const s = await page.evaluate(() => (window as any).__test.repo.snapshot);
  expect(s.items).toHaveLength(5);
  expect(s.items.find((x: any) => x.id === ids[1])).toMatchObject({
    markdown: 'latest parent',
    deletedAt: null,
  });
});
for (const index of [0, 1, 2])
  test(`mixed live deletion ordinal ${index} selects successor or previous`, async ({
    page,
  }) => {
    const ids = await seed(page);
    await card(page, ids[index]).click();
    await page.keyboard.press('Meta+Backspace');
    await expect(card(page, ids[index === 2 ? 1 : index + 1])).toHaveClass(
      /selected/,
    );
    await expect(stream(page)).toBeFocused();
  });
test('fresh Trash capture restores Home append; only item restore focuses capture', async ({
  page,
}) => {
  await seed(page);
  await trash(page).click();
  await capture(page).fill('fresh retained note');
  await capture(page).press('Enter');
  const id = await page.evaluate(
    () =>
      (window as any).__test.repo.snapshot.items.find(
        (x: any) => x.markdown === 'fresh retained note',
      ).id,
  );
  await card(page, id).click();
  await restore(page).click();
  await expect(capture(page)).toBeFocused();
  await page.keyboard.press('Meta+1');
  await expect(stream(page).getByRole('article').last()).toHaveAttribute(
    'data-entry-id',
    id,
  );
});

test('Trash navigation failure retains its own destination and source for Retry action', async ({
  page,
}) => {
  const ids = await seed(page);
  await card(page, ids[0]).dblclick();
  await edit(page).fill('unsaved live source');
  await page.evaluate(() => ((window as any).__test.repo.fail = 'save'));
  await trash(page).click();
  await expect(page.locator('h1')).toHaveText('Home');
  await expect(
    page.getByRole('button', { name: 'Retry action', exact: true }),
  ).toBeVisible();
  await page.evaluate(() => ((window as any).__test.repo.fail = null));
  await page.getByRole('button', { name: 'Retry action', exact: true }).click();
  await expect(page.locator('h1')).toHaveText('Trash');
  expect(
    await page.evaluate(
      () => (window as any).__test.repo.snapshot.items[0].markdown,
    ),
  ).toBe('unsaved live source');
});

test('Undo from Trash root removes restored selection and focuses capture when empty', async ({
  page,
}) => {
  const ids = await seed(page);
  await deleteParent(page, ids);
  await card(page, ids[1]).click();
  await page.getByRole('button', { name: 'Undo delete', exact: true }).click();
  await expect(capture(page)).toBeFocused();
  await capture(page).press('Escape');
  await stream(page).press('e');
  await expect(edit(page)).toHaveCount(0);
});
test('Trash Command-N uses selected note parent, promotes atomically, and Back remembers both scopes', async ({
  page,
}) => {
  const ids = await seed(page);
  await deleteParent(page, ids);
  await card(page, ids[1]).click();
  await page.keyboard.press('ArrowRight');
  await card(page, ids[4]).click();
  await page.keyboard.press('Meta+n');
  await expect(capture(page)).toBeFocused();
  const s = await page.evaluate(() => (window as any).__test.repo.snapshot);
  expect(s.items.find((x: any) => x.id === ids[4]).kind).toBe('stash');
  expect(s.items.filter((x: any) => x.parentId === ids[4])).toHaveLength(1);
  await capture(page).press('Escape');
  await stream(page).press('ArrowLeft');
  await expect(
    card(page, s.items.find((x: any) => x.parentId === ids[4]).id),
  ).toHaveClass(/selected/);
  await stream(page).press('ArrowLeft');
  await expect(page.locator('h1')).toHaveText('Trash / parent **source**');
  await expect(card(page, ids[4])).toHaveClass(/selected/);
  await stream(page).press('ArrowLeft');
  await expect(page.locator('h1')).toHaveText('Trash');
  await expect(card(page, ids[1])).toHaveClass(/selected/);
});
test('Restore uses remembered live parent and clamps ordinal; unavailable parent falls back Home', async ({
  page,
}) => {
  const ids = await seed(page);
  await page.evaluate(async (ids) => {
    const t = (window as any).__test;
    await t.controller.remove(ids[4]);
    await t.controller.remove(ids[3]);
  }, ids);
  await trash(page).click();
  await card(page, ids[4]).click();
  await restore(page).click();
  expect(
    await page.evaluate(
      (id) =>
        (window as any).__test.repo.snapshot.items.find((x: any) => x.id === id)
          .parentId,
      ids[4],
    ),
  ).toBe(ids[1]);
  await page.evaluate(async (id) => {
    await (window as any).__test.controller.remove(id);
  }, ids[1]);
  await card(page, ids[3]).click();
  await restore(page).click();
  const item = await page.evaluate(
    (id) =>
      (window as any).__test.repo.snapshot.items.find((x: any) => x.id === id),
    ids[3],
  );
  expect(item).toMatchObject({ parentId: null, deletedAt: null, position: 0 });
});
test('only mixed item deletion focuses capture without submitting its draft', async ({
  page,
}) => {
  const ids = await seed(page);
  for (const id of ids.slice(0, 3)) {
    await card(page, id).click();
    await page.keyboard.press('Meta+Backspace');
  }
  await expect(capture(page)).toBeFocused();
  expect(
    await page.evaluate(
      () => (window as any).__test.repo.snapshot.items.length,
    ),
  ).toBe(5);
});
for (const large of [false, true])
  test(`Trash details and sidebar single scroller at ${large ? '150' : 'normal'} text`, async ({
    page,
  }) => {
    await page.setViewportSize(
      large ? { width: 800, height: 650 } : { width: 1440, height: 900 },
    );
    const ids = await seed(page);
    if (large)
      await page.addStyleTag({
        content: ':root { font-size: 24px !important }',
      });
    await deleteParent(page, ids);
    await card(page, ids[1]).click();
    const details = page.getByRole('complementary', { name: 'Note details' });
    if (large) {
      await expect(details).toBeHidden();
      await page.getByRole('button', { name: /^(Show|Hide) Details$/ }).click();
    }
    await expect(restore(page)).toBeVisible();
    await page.screenshot({
      path: `test-results/captures/trash/details-${large ? '150' : 'normal'}.png`,
    });
    if (large)
      await page.getByRole('button', { name: /^(Show|Hide) Details$/ }).click();
    await page.evaluate(async () => {
      const t = (window as any).__test;
      for (let i = 0; i < 30; i++) {
        const id = crypto.randomUUID();
        await t.repo.createChildStash({
          id,
          parent: { scope: 'live', itemId: null },
        });
        await t.repo.saveItemSource(id, `Synthetic stash ${i}`, {
          key: id,
          revision: 0,
        });
      }
      await t.controller.start();
    });
    const sidebar = page.getByRole('complementary', {
      name: 'Workspace navigation',
    });
    const overflow = await sidebar.evaluate((el) => ({
      self: getComputedStyle(el).overflowY,
      overflowing: el.scrollHeight > el.clientHeight,
      inner: [...el.querySelectorAll('*')].filter(
        (x) =>
          ['auto', 'scroll'].includes(getComputedStyle(x).overflowY) &&
          x.scrollHeight > x.clientHeight,
      ).length,
    }));
    expect(overflow).toEqual({ self: 'auto', overflowing: true, inner: 0 });
    await trash(page).scrollIntoViewIfNeeded();
    await expect(trash(page)).toBeVisible();
    await page.screenshot({
      path: `test-results/captures/trash/sidebar-${large ? '150' : 'normal'}.png`,
    });
  });

test('Trash formatting and copy use actual source with Undo, and navigation restores live versus Trash selection', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const ids = await seed(page);
  await deleteParent(page, ids);
  await card(page, ids[1]).click();
  await page.keyboard.press('ArrowRight');
  await card(page, ids[4]).click();
  await page.keyboard.press('e');
  await edit(page).press('Meta+a');
  await edit(page).press('Meta+b');
  await expect(edit(page)).toHaveText('**child match**');
  await edit(page).press('Meta+z');
  await expect(edit(page)).toHaveText('child match');
  await edit(page).press('Escape');
  await stream(page).press('c');
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe('child match');
  await page.keyboard.press('Meta+1');
  await expect(card(page, ids[2])).toHaveClass(/selected/);
  await trash(page).click();
  await expect(card(page, ids[1])).toHaveClass(/selected/);
  await page.keyboard.press('ArrowRight');
  await expect(card(page, ids[4])).toHaveClass(/selected/);
});
