import { expect, test, type Page } from '@playwright/test';
const card = (page: Page, id: string) =>
  page.locator(`[data-entry-id="${id}"]`);
const capture = (page: Page) =>
  page.getByRole('textbox', { name: 'Capture Markdown' });
async function seed(page: Page) {
  await page.goto('/?fixture');
  await capture(page).waitFor();
  return page.evaluate(async () => {
    const t = (window as any).__test;
    const ids = Array.from({ length: 5 }, () => crypto.randomUUID());
    for (const [index, markdown] of [
      'purge parent',
      'surviving sibling',
      'empty source',
    ].entries())
      await t.repo.captureItem({
        id: ids[index],
        location: { scope: 'live', itemId: null },
        markdown,
        draft: { key: 'compose', revision: 0 },
      });
    await t.repo.createChildStash({
      id: ids[3],
      parent: { scope: 'live', itemId: ids[0] },
    });
    await t.repo.captureItem({
      id: ids[4],
      location: { scope: 'live', itemId: ids[0] },
      markdown: 'detached survivor',
      draft: { key: `compose:${ids[0]}`, revision: 0 },
    });
    await t.repo.deleteItem(ids[4]);
    await t.controller.start();
    return ids;
  });
}
async function snapshot(page: Page) {
  return page.evaluate(() =>
    structuredClone((window as any).__test.repo.snapshot),
  );
}

test('Trash Delete permanently removes exactly the captured tree, leaves detached roots and ordinary Undo, and selects next ordinal', async ({
  page,
}) => {
  const ids = await seed(page);
  await card(page, ids[0]).click();
  await page.keyboard.press('Meta+Backspace');
  await page.getByRole('button', { name: 'Trash', exact: true }).click();
  await card(page, ids[0]).click();
  await card(page, ids[0])
    .getByRole('button', { name: 'Permanently delete stash', exact: true })
    .click();
  await expect
    .poll(async () =>
      (await snapshot(page)).items.map((item: any) => item.id).sort(),
    )
    .toEqual([ids[1], ids[2], ids[4]].sort());
  await expect(card(page, ids[4])).toHaveClass(/selected/);
  expect((await snapshot(page)).undoDeleteIds).toEqual([]);
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await card(page, ids[1]).click();
  await page.keyboard.press('Meta+Backspace');
  await page.keyboard.press('Meta+z');
  await expect(card(page, ids[1])).toHaveClass(/selected/);
});

test('permanent-delete failure retries the original target after selection changes without submitting capture', async ({
  page,
}) => {
  const ids = await seed(page);
  await card(page, ids[0]).click();
  await page.keyboard.press('Meta+Backspace');
  await page.getByRole('button', { name: 'Trash', exact: true }).click();
  await capture(page).fill('retain trash draft');
  await card(page, ids[0]).click();
  await page.evaluate(() => {
    (window as any).__test.repo.fail = 'purge';
  });
  await page.keyboard.press('Meta+Backspace');
  await expect(
    page.getByRole('button', { name: 'Retry action', exact: true }),
  ).toBeVisible();
  await card(page, ids[4]).click();
  await page.evaluate(() => {
    (window as any).__test.repo.fail = null;
  });
  await page.getByRole('button', { name: 'Retry action', exact: true }).click();
  await expect(card(page, ids[0])).toHaveCount(0);
  await expect(card(page, ids[4])).toHaveClass(/selected/);
  await expect(capture(page)).toHaveText('retain trash draft');
});

for (const exit of [
  'parent',
  'sidebar',
  'breadcrumb',
  'history',
  'side-button',
] as const)
  test(`empty stash demotes only after successful ${exit} exit and history never promotes it`, async ({
    page,
  }) => {
    const ids = await seed(page);
    await card(page, ids[2]).click();
    await page.keyboard.press('ArrowRight');
    await expect
      .poll(
        async () =>
          (await snapshot(page)).items.find((item: any) => item.id === ids[2])
            .kind,
      )
      .toBe('stash');
    await capture(page).fill('owner draft survives demotion');
    if (exit === 'parent')
      await page.keyboard
        .press('Escape')
        .then(() => page.keyboard.press('ArrowLeft'));
    else if (exit === 'sidebar')
      await page.getByRole('button', { name: 'Home', exact: true }).click();
    else if (exit === 'breadcrumb')
      await page
        .getByRole('button', { name: 'Go to Home', exact: true })
        .click();
    else if (exit === 'history')
      await page.getByRole('button', { name: 'Back', exact: true }).click();
    else
      await page.evaluate(() =>
        window.dispatchEvent(
          new MouseEvent('mouseup', {
            button: 3,
            bubbles: true,
            cancelable: true,
          }),
        ),
      );
    await expect
      .poll(
        async () =>
          (await snapshot(page)).items.find((item: any) => item.id === ids[2])
            .kind,
      )
      .toBe('note');
    await expect(card(page, ids[2])).toBeVisible();
    await expect(
      page.getByRole('button', {
        name: 'Open stash empty source',
        exact: true,
      }),
    ).toHaveCount(0);
    expect(
      (await snapshot(page)).drafts.some(
        (draft: any) =>
          draft.key === `compose:${ids[2]}` &&
          draft.markdown === 'owner draft survives demotion',
      ),
    ).toBe(true);
    await expect(
      page.getByRole('button', { name: 'Forward', exact: true }),
    ).toBeDisabled();
  });

test('queued empty A to B to C exits demote actual origins and transient B never becomes a history visit', async ({
  page,
}) => {
  await page.goto('/?fixture');
  await capture(page).waitFor();
  const ids = await page.evaluate(async () => {
    const t = (window as any).__test;
    const ids = Array.from({ length: 3 }, () => crypto.randomUUID());
    for (const [index, id] of ids.entries()) {
      await t.repo.captureItem({
        id,
        location: { scope: 'live', itemId: null },
        markdown: `queued ${['A', 'B', 'C'][index]}`,
        draft: { key: 'compose', revision: 0 },
      });
      await t.repo.promoteItem(id);
    }
    await t.controller.start();
    const transition = t.repo.transitionLocation.bind(t.repo);
    t.repo.transitionLocation = async (request: any) => {
      const result = await transition(request);
      if (request.to.itemId === ids[1] && !t.delayedB) {
        t.delayedB = true;
        await new Promise<void>((release) => {
          t.releaseB = release;
        });
      }
      return result;
    };
    return ids;
  });
  await card(page, ids[0]).click();
  await page.keyboard.press('ArrowRight');
  await page
    .getByRole('button', { name: 'Open stash queued B', exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => !!(window as any).__test.releaseB))
    .toBe(true);
  await page
    .getByRole('button', { name: 'Open stash queued C', exact: true })
    .click();
  await page.evaluate(() => (window as any).__test.releaseB());
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__test.controller.state.stashId),
    )
    .toBe(ids[2]);
  expect(
    (await snapshot(page)).items
      .filter((item: any) => ids.slice(0, 2).includes(item.id))
      .map((item: any) => item.kind),
  ).toEqual(['note', 'note']);
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await card(page, ids[1]).click();
  await page.keyboard.press('ArrowRight');
  await capture(page).fill('keep B available for history');
  await capture(page).press('Enter');
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  const back = page.getByRole('button', { name: 'Back', exact: true });
  await back.click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__test.controller.state.stashId),
    )
    .toBe(ids[1]);
  await back.click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__test.controller.state.stashId),
    )
    .toBeNull();
  await back.click();
  await expect(back).toBeDisabled();
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__test.controller.state.stashId),
    )
    .toBeNull();
});

test('older uncertain purge Retry stays distinct from a newer failed palette choice and retains its exact color continuation', async ({
  page,
}) => {
  const ids = await seed(page);
  await card(page, ids[0]).click();
  await page.keyboard.press('Meta+Backspace');
  await page.getByRole('button', { name: 'Trash', exact: true }).click();
  await page.evaluate(() => {
    const t = (window as any).__test,
      purge = t.repo.purgeItem.bind(t.repo);
    t.purgeCalls = 0;
    t.repo.purgeItem = async (request: any) => {
      const result = await purge(request);
      if (++t.purgeCalls === 1)
        throw new Error('Synthetic lost purge acknowledgment');
      return result;
    };
  });
  await card(page, ids[0]).click();
  await page.keyboard.press('Meta+Backspace');
  await expect(page.getByRole('alert')).toContainText(
    'lost purge acknowledgment',
  );
  await card(page, ids[4]).click();
  await page.evaluate(() => {
    (window as any).__test.repo.fail = 'color';
  });
  await page.keyboard.press('l');
  const palette = page.getByRole('dialog', { name: 'Assign color' });
  await palette.getByRole('button', { name: 'Red', exact: true }).click();
  await expect(palette.getByRole('alert')).toContainText('failure');
  const feedback = page.getByRole('region', { name: 'Workspace status' });
  // The currently available generic action acknowledges purge, not this color.
  await expect(feedback).not.toContainText('Retry color:');
  await page.evaluate(() => {
    (window as any).__test.repo.fail = null;
  });
  const retry = page.getByRole('button', { name: 'Retry action', exact: true });
  await retry.dispatchEvent('click');
  await expect
    .poll(() => page.evaluate(() => (window as any).__test.purgeCalls))
    .toBe(2);
  await expect(card(page, ids[0])).toHaveCount(0);
  await expect(palette).toBeVisible();
  await expect(feedback).toContainText('Retry color: Red');
  expect(
    await page.evaluate(
      (id) =>
        (window as any).__test.repo.snapshot.items.find(
          (item: any) => item.id === id,
        ).color,
      ids[4],
    ),
  ).toBeNull();
  await page.evaluate(() => {
    const t = (window as any).__test,
      color = t.repo.setItemColor.bind(t.repo);
    t.repo.setItemColor = async (...args: any[]) => {
      await new Promise<void>((release) => {
        t.releaseColor = release;
      });
      return color(...args);
    };
  });
  await retry.dispatchEvent('click');
  await expect(
    palette.getByRole('grid', { name: 'Item color' }),
  ).toHaveAttribute('aria-busy', 'true');
  await page.getByRole('searchbox').fill('newer search');
  await page.evaluate(() => (window as any).__test.releaseColor());
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          (window as any).__test.repo.snapshot.items.find(
            (item: any) => item.id === id,
          ).color,
        ids[4],
      ),
    )
    .toBe('red');
  await expect(palette).toHaveCount(0);
  await expect(page.getByRole('searchbox')).toBeFocused();
  await expect(page.getByRole('searchbox')).toHaveValue('newer search');
});
