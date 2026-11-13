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
    for (const [index, id] of ids.entries())
      await t.repo.captureItem({
        id,
        location: { scope: 'live', itemId: null },
        markdown: `selection ${index}`,
        draft: { key: 'compose', revision: 0 },
      });
    await t.repo.createChildTree({
      id: crypto.randomUUID(),
      parent: { scope: 'live', itemId: ids[1] },
    });
    await t.controller.start();
    return ids;
  });
}
async function selected(page: Page) {
  return page
    .locator('.note-card.selected')
    .evaluateAll((cards) =>
      cards.map((entry) => entry.getAttribute('data-entry-id')),
    );
}

test('mouse ranges retain the original anchor across modifier release, shrink, reverse, and mixed kinds', async ({
  page,
}) => {
  const ids = await seed(page);
  await card(page, ids[1]).hover();
  await card(page, ids[1])
    .getByRole('button', { name: 'Reorder item', exact: true })
    .click();
  await card(page, ids[4]).hover();
  await card(page, ids[4])
    .getByRole('button', { name: 'Reorder item', exact: true })
    .click({ modifiers: ['Shift'] });
  await expect.poll(() => selected(page)).toEqual(ids.slice(1));
  await card(page, ids[2]).click({ modifiers: ['Shift'] });
  await expect.poll(() => selected(page)).toEqual(ids.slice(1, 3));
  await card(page, ids[0]).click({ modifiers: ['Shift'] });
  await expect.poll(() => selected(page)).toEqual(ids.slice(0, 2));
  await card(page, ids[3]).click();
  await expect.poll(() => selected(page)).toEqual([ids[3]]);
});

test('Command toggles membership while only the primary exposes single-item actions', async ({
  page,
}) => {
  const ids = await seed(page);
  await card(page, ids[0]).click();
  await card(page, ids[2]).hover();
  await card(page, ids[2])
    .getByRole('button', { name: 'Reorder item', exact: true })
    .click({ modifiers: ['Meta'] });
  await expect.poll(() => selected(page)).toEqual([ids[0], ids[2]]);
  await expect(
    card(page, ids[0]).getByRole('button', {
      name: 'Delete note',
      exact: true,
    }),
  ).toHaveCount(0);
  await card(page, ids[2])
    .getByRole('button', { name: 'Mark done', exact: true })
    .click();
  await expect(card(page, ids[2])).toHaveClass(/done/);
  await expect(card(page, ids[0])).not.toHaveClass(/done/);
  await page.getByRole('region', { name: 'Note stream' }).focus();
  await page.keyboard.press('e');
  await expect(
    page.getByRole('textbox', { name: 'Edit Markdown' }),
  ).toBeFocused();
  await expect.poll(() => selected(page)).toEqual([ids[2]]);
  await page.getByRole('textbox', { name: 'Edit Markdown' }).press('Escape');
  await card(page, ids[0]).click();
  await card(page, ids[2]).click({ modifiers: ['Meta'] });
  await card(page, ids[2]).hover();
  await card(page, ids[2])
    .getByRole('button', { name: 'Reorder item', exact: true })
    .click({ modifiers: ['Meta'] });
  await expect.poll(() => selected(page)).toEqual([ids[0]]);
  await card(page, ids[3]).click({ modifiers: ['Shift'] });
  await expect.poll(() => selected(page)).toEqual(ids.slice(0, 4));
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => selected(page)).toEqual([ids[4]]);
  await page.keyboard.press('Shift+ArrowUp');
  await expect.poll(() => selected(page)).toEqual([ids[4]]);
});

test('search selection stays one exact result and editing retains its text selection', async ({
  page,
}) => {
  const ids = await seed(page);
  await card(page, ids[0]).click();
  await card(page, ids[3]).click({ modifiers: ['Shift'] });
  await page.getByRole('searchbox').fill('selection');
  await card(page, ids[1]).click();
  await card(page, ids[3])
    .getByRole('button', { name: 'Select note', exact: true })
    .dispatchEvent('click', { metaKey: true });
  await expect.poll(() => selected(page)).toEqual([ids[3]]);
  await page.keyboard.press('e');
  const editor = page.getByRole('textbox', { name: 'Edit Markdown' });
  await editor.press('Meta+a');
  await editor.press('Shift+ArrowLeft');
  await expect(editor).toBeFocused();
  await expect.poll(() => selected(page)).toEqual([ids[3]]);
});

test('noncontiguous Command arrows collect a block and drag inserts the captured ordered block once', async ({
  page,
}) => {
  const ids = await seed(page);
  const order = () =>
    page
      .locator('.note-card')
      .evaluateAll((entries) =>
        entries.map((entry) => entry.getAttribute('data-entry-id')),
      );
  await page.evaluate(() => {
    const t = (window as any).__test,
      move = t.repo.moveItems.bind(t.repo);
    t.moves = [];
    t.repo.moveItems = async (request: any) => {
      t.moves.push(structuredClone(request));
      return move(request);
    };
  });
  await card(page, ids[1]).click();
  await card(page, ids[3]).click({ modifiers: ['Meta'] });
  const stream = page.getByRole('region', { name: 'Note stream' });
  await stream.focus();
  await page.keyboard.press('Meta+ArrowUp');
  await expect(stream).toBeFocused();
  await expect.poll(order).toEqual([ids[1], ids[3], ids[0], ids[2], ids[4]]);
  await expect.poll(() => selected(page)).toEqual([ids[1], ids[3]]);
  await page.keyboard.press('Meta+ArrowDown');
  await expect.poll(order).toEqual([ids[0], ids[1], ids[3], ids[2], ids[4]]);
  await expect.poll(() => selected(page)).toEqual([ids[1], ids[3]]);
  await expect(stream).toBeFocused();
  await expect(
    card(page, ids[3]).getByRole('button', { name: 'Mark done', exact: true }),
  ).toHaveCount(1);
  await expect(
    card(page, ids[1]).getByRole('button', { name: 'Mark done', exact: true }),
  ).toHaveCount(0);
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  await card(page, ids[1])
    .getByRole('button', { name: 'Reorder item', exact: true })
    .dispatchEvent('dragstart', { dataTransfer: transfer });
  await expect.poll(() => selected(page)).toEqual([ids[1], ids[3]]);
  const bounds = (await card(page, ids[4]).boundingBox())!;
  await card(page, ids[4]).dispatchEvent('dragover', {
    dataTransfer: transfer,
    clientY: bounds.y + bounds.height - 1,
  });
  await card(page, ids[4]).dispatchEvent('drop', {
    dataTransfer: transfer,
    clientY: bounds.y + bounds.height - 1,
  });
  await expect.poll(order).toEqual([ids[0], ids[2], ids[4], ids[1], ids[3]]);
  await expect.poll(() => selected(page)).toEqual([ids[1], ids[3]]);
  expect(
    await page.evaluate(() =>
      (window as any).__test.moves.map((request: any) => request.ids),
    ),
  ).toEqual([
    [ids[1], ids[3]],
    [ids[1], ids[3]],
    [ids[1], ids[3]],
  ]);
});

test('failed group movement retries captured membership after a newer selection without taking Search focus', async ({
  page,
}) => {
  const ids = await seed(page);
  await card(page, ids[1]).click();
  await card(page, ids[3]).click({ modifiers: ['Meta'] });
  await page.evaluate(() => {
    (window as any).__test.repo.fail = 'move';
  });
  await page.keyboard.press('Meta+ArrowUp');
  await expect(
    page.getByRole('button', { name: 'Retry action', exact: true }),
  ).toBeVisible();
  await card(page, ids[4]).click();
  await page.evaluate(() => {
    (window as any).__test.repo.fail = null;
  });
  await page.getByRole('button', { name: 'Retry action', exact: true }).click();
  await expect
    .poll(() =>
      page
        .locator('.note-card')
        .evaluateAll((entries) =>
          entries.map((entry) => entry.getAttribute('data-entry-id')),
        ),
    )
    .toEqual([ids[1], ids[3], ids[0], ids[2], ids[4]]);
  await expect.poll(() => selected(page)).toEqual([ids[4]]);
  await card(page, ids[1]).click();
  await card(page, ids[3]).click({ modifiers: ['Meta'] });
  await page.evaluate((id) => {
    const t = (window as any).__test;
    t.delay();
    t.controller.editContext(id, 'latest source before group move');
  }, ids[1]);
  await page.keyboard.press('Meta+ArrowDown');
  await page.getByRole('searchbox').fill('selection 0');
  await page.evaluate(() => (window as any).__test.release());
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__test.repo.snapshot.items
          .filter((item: any) => item.parentId === null)
          .sort((a: any, b: any) => a.position - b.position)
          .map((item: any) => item.id),
      ),
    )
    .toEqual([ids[0], ids[1], ids[3], ids[2], ids[4]]);
  await expect(page.getByRole('searchbox')).toBeFocused();
  await expect(page.getByRole('searchbox')).toHaveValue('selection 0');
  expect(
    await page.evaluate(
      (id) =>
        (window as any).__test.repo.snapshot.items.find(
          (item: any) => item.id === id,
        ).markdown,
      ids[1],
    ),
  ).toBe('latest source before group move');
});

test('an all-sibling selection has neutral keyboard boundaries and no unavailable reorder hint', async ({
  page,
}) => {
  const ids = await seed(page);
  await card(page, ids[0]).click();
  await card(page, ids[4]).click({ modifiers: ['Shift'] });
  await expect.poll(() => selected(page)).toEqual(ids);
  const before = await page.evaluate(() =>
    structuredClone((window as any).__test.repo.snapshot),
  );
  await page.keyboard.down('Meta');
  await expect(page.locator('.stream-command-hint')).toHaveText(
    '⌘N New tree · ⌘⌫ Delete',
  );
  await page.keyboard.up('Meta');
  await page.keyboard.press('Meta+ArrowUp');
  await page.keyboard.press('Meta+ArrowDown');
  expect(
    await page.evaluate(() => (window as any).__test.repo.snapshot),
  ).toEqual(before);
});
