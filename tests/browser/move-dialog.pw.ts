import { test, expect, type Page } from '@playwright/test';
const card = (page: Page, id: string) =>
  page.locator(`[data-entry-id="${id}"]`);
const capture = (page: Page) =>
  page.getByRole('textbox', { name: 'Capture Markdown' });
async function seed(page: Page) {
  await page.goto('/?fixture');
  await capture(page).waitFor();
  return page.evaluate(async () => {
    const t = (window as any).__test;
    const ids = Array.from({ length: 4 }, () => crypto.randomUUID());
    for (const [index, markdown] of [
      'move source',
      'destination alpha',
      'destination beta',
    ].entries())
      await t.repo.captureItem({
        id: ids[index],
        location: { scope: 'live', itemId: null },
        markdown,
        draft: { key: 'compose', revision: 0 },
      });
    await t.repo.createChildStash({
      id: ids[3],
      parent: { scope: 'live', itemId: ids[1] },
    });
    await t.repo.promoteItem(ids[2]);
    await t.controller.start();
    return ids;
  });
}
async function snapshot(page: Page) {
  return page.evaluate(() =>
    structuredClone((window as any).__test.repo.snapshot),
  );
}

test('M stages destinations without writing, traps focus, and cancels from Escape and backdrop', async ({
  page,
}) => {
  const ids = await seed(page);
  await card(page, ids[0]).click();
  const before = await snapshot(page);
  await page.keyboard.press('m');
  const dialog = page.getByRole('dialog', { name: 'Move items' });
  await expect(dialog).toBeVisible();
  const list = dialog.getByRole('listbox', { name: 'Destination' });
  await expect(list).toBeFocused();
  await dialog
    .getByRole('option', { name: 'destination alpha, Home', exact: true })
    .click();
  expect(await snapshot(page)).toEqual(before);
  await page.keyboard.press('ArrowDown');
  expect(await snapshot(page)).toEqual(before);
  await page.keyboard.press('Tab');
  await expect(
    dialog.getByRole('button', { name: 'Cancel', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(
    dialog.getByRole('button', { name: 'Move', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(list).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(
    dialog.getByRole('button', { name: 'Move', exact: true }),
  ).toBeFocused();
  expect(
    await dialog.evaluate((element) =>
      element.contains(document.activeElement),
    ),
  ).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Note stream' })).toBeFocused();
  await page.keyboard.press('m');
  await page.mouse.click(2, 2);
  await expect(dialog).toHaveCount(0);
  expect(await snapshot(page)).toEqual(before);
});

test('Enter confirms the captured selected source block once and excludes selected descendants as destinations', async ({
  page,
}) => {
  const ids = await seed(page);
  await card(page, ids[0]).click();
  await card(page, ids[1]).click({ modifiers: ['Meta'] });
  await page.keyboard.press('m');
  const dialog = page.getByRole('dialog', { name: 'Move items' });
  await expect(
    dialog.getByRole('option', {
      name: 'destination alpha, Home',
      exact: true,
    }),
  ).toHaveCount(0);
  await dialog
    .getByRole('option', { name: 'destination beta, Home', exact: true })
    .click();
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(async () =>
      (await snapshot(page)).items
        .filter((item: any) => item.parentId === ids[2])
        .sort((a: any, b: any) => a.position - b.position)
        .map((item: any) => item.id),
    )
    .toEqual(ids.slice(0, 2));
  expect(
    (await snapshot(page)).items.find((item: any) => item.id === ids[3])
      .parentId,
  ).toBe(ids[1]);
});

test('failed modal movement retains the exact destination for Retry and ignores later staging', async ({
  page,
}) => {
  const ids = await seed(page);
  await card(page, ids[0]).click();
  await page.keyboard.press('m');
  const dialog = page.getByRole('dialog', { name: 'Move items' });
  await dialog
    .getByRole('option', { name: 'destination alpha, Home', exact: true })
    .click();
  await page.evaluate(() => {
    (window as any).__test.repo.fail = 'move';
  });
  await dialog.getByRole('button', { name: 'Move', exact: true }).click();
  await expect(
    dialog.getByRole('button', { name: 'Retry move', exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole('option', { name: 'destination beta, Home', exact: true }),
  ).toBeDisabled();
  await dialog
    .getByRole('option', { name: 'destination beta, Home', exact: true })
    .dispatchEvent('click');
  await dialog.getByRole('listbox', { name: 'Destination' }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(
    dialog.getByRole('option', {
      name: 'destination alpha, Home',
      exact: true,
    }),
  ).toHaveAttribute('aria-selected', 'true');
  await page.evaluate(() => {
    (window as any).__test.repo.fail = null;
  });
  await dialog.getByRole('button', { name: 'Retry move', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(
      async () =>
        (await snapshot(page)).items.find((item: any) => item.id === ids[0])
          .parentId,
    )
    .toBe(ids[1]);
});

test('pending modal movement commits once and cannot be presented as cancelled', async ({
  page,
}) => {
  const ids = await seed(page);
  await card(page, ids[0]).click();
  await page.evaluate(() => {
    const t = (window as any).__test,
      move = t.repo.moveItems.bind(t.repo);
    t.moveCalls = 0;
    t.repo.moveItems = async (request: any) => {
      t.moveCalls++;
      await new Promise<void>((release) => {
        t.releaseMove = release;
      });
      return move(request);
    };
  });
  await page.keyboard.press('m');
  const dialog = page.getByRole('dialog', { name: 'Move items' });
  await dialog
    .getByRole('option', { name: 'destination alpha, Home', exact: true })
    .click();
  await page.keyboard.press('Enter');
  await expect(
    dialog.getByRole('button', { name: 'Moving…', exact: true }),
  ).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => (window as any).__test.moveCalls)).toBe(1);
  await page.evaluate(() => (window as any).__test.releaseMove());
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(
      async () =>
        (await snapshot(page)).items.find((item: any) => item.id === ids[0])
          .parentId,
    )
    .toBe(ids[1]);
});

for (const scale of [100, 150])
  test(`destination dialog stays reachable with long labels at ${scale}% text`, async ({
    page,
  }) => {
    await page.setViewportSize({
      width: scale === 100 ? 1440 : 800,
      height: scale === 100 ? 900 : 600,
    });
    const ids = await seed(page);
    await page.evaluate(async (id) => {
      const t = (window as any).__test;
      t.repo.snapshot.items.find((item: any) => item.id === id).markdown =
        'A destination with a deliberately long synthetic first line '.repeat(
          8,
        );
      await t.controller.start();
    }, ids[1]);
    if (scale === 150)
      await page.addStyleTag({ content: ':root{font-size:24px !important}' });
    await card(page, ids[0]).click();
    await page.keyboard.press('m');
    const dialog = page.getByRole('dialog', { name: 'Move items' });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: 'Move', exact: true }),
    ).toBeInViewport();
    const bounds = (await dialog.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(
      scale === 100 ? 1440 : 800,
    );
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(
      scale === 100 ? 900 : 600,
    );
    await page.screenshot({
      path: test.info().outputPath(`move-dialog-${scale}.png`),
    });
  });

test('a stale staged destination explains the failure inside the modal without moving source', async ({
  page,
}) => {
  const ids = await seed(page);
  await card(page, ids[0]).click();
  await page.keyboard.press('m');
  const dialog = page.getByRole('dialog', { name: 'Move items' });
  await dialog
    .getByRole('option', { name: 'destination alpha, Home', exact: true })
    .click();
  await page.evaluate(async (id) => {
    const t = (window as any).__test;
    await t.repo.deleteItem(id);
    await t.controller.start();
  }, ids[1]);
  await dialog.getByRole('button', { name: 'Move', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('destination');
  expect(
    (await snapshot(page)).items.find((item: any) => item.id === ids[0])
      .parentId,
  ).toBeNull();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test('Trash movement offers only Trash destinations and Restore remains the route to Home', async ({
  page,
}) => {
  const ids = await seed(page);
  await page.evaluate(async (ids) => {
    const t = (window as any).__test;
    for (const id of ids.slice(0, 3)) await t.repo.deleteItem(id);
    await t.controller.start();
  }, ids);
  await page.getByRole('button', { name: 'Trash', exact: true }).click();
  await card(page, ids[0]).click();
  await page.keyboard.press('m');
  const dialog = page.getByRole('dialog', { name: 'Move items' });
  await expect(
    dialog.getByRole('option', { name: 'Home', exact: true }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole('option', { name: 'Trash', exact: true }),
  ).toBeVisible();
  await dialog
    .getByRole('option', { name: 'destination alpha, Trash', exact: true })
    .click();
  await dialog.getByRole('button', { name: 'Move', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(
      async () =>
        (await snapshot(page)).items.find((item: any) => item.id === ids[0])
          .parentId,
    )
    .toBe(ids[1]);
  await card(page, ids[1]).click();
  await page.keyboard.press('ArrowRight');
  await card(page, ids[0]).click();
  await page.getByRole('button', { name: 'Restore item', exact: true }).click();
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await expect(card(page, ids[0])).toBeVisible();
});

test('duplicate destination names expose their ancestry, stage without writing, and Enter moves to the chosen exact owner', async ({
  page,
}) => {
  const ids = await seed(page);
  const duplicates = await page.evaluate(async (ids) => {
    const t = (window as any).__test;
    const duplicates = [crypto.randomUUID(), crypto.randomUUID()];
    for (const [index, id] of duplicates.entries()) {
      await t.repo.createChildStash({
        id,
        parent: { scope: 'live', itemId: ids[index + 1] },
      });
      await t.repo.saveItemSource(id, 'Shared destination', {
        key: id,
        revision: 1,
      });
    }
    await t.controller.start();
    return duplicates;
  }, ids);
  await card(page, ids[0]).click();
  const before = await snapshot(page);
  await page.keyboard.press('m');
  const dialog = page.getByRole('dialog', { name: 'Move items' });
  const alpha = dialog.getByRole('option', {
    name: 'Shared destination, Home / destination alpha',
    exact: true,
  });
  const beta = dialog.getByRole('option', {
    name: 'Shared destination, Home / destination beta',
    exact: true,
  });
  await expect(alpha).toBeVisible();
  await expect(beta).toBeVisible();
  await beta.click();
  await expect(beta).toHaveAttribute('aria-selected', 'true');
  expect(await snapshot(page)).toEqual(before);
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(
      async () =>
        (await snapshot(page)).items.find((item: any) => item.id === ids[0])
          .parentId,
    )
    .toBe(duplicates[1]);
  expect(
    (await snapshot(page)).items.find((item: any) => item.id === duplicates[0])
      .parentId,
  ).toBe(ids[1]);
});
