import { test, expect, type Page } from '@playwright/test';

async function seed(page: Page) {
  await page.goto('/?fixture');
  await page.getByRole('textbox', { name: 'New note Markdown' }).waitFor();
  const id = await page.evaluate(async () => {
    const t = (window as any).__test;
    const id = crypto.randomUUID();
    await t.repo.captureItem({
      id,
      location: { scope: 'live', itemId: null },
      markdown: 'palette **source**',
      draft: { key: 'compose', revision: 0 },
    });
    await t.controller.start();
    return id;
  });
  await page.locator(`[data-entry-id="${id}"]`).click();
  return id;
}
async function savedColor(page: Page, id: string) {
  return page.evaluate(
    (id) =>
      (window as any).__test.repo.snapshot.items.find((x: any) => x.id === id)
        .color,
    id,
  );
}

// These layout-grid cases supersede the former immediate radio/Done contract.
// Losing row/column navigation or writing on arrows must fail these assertions.
for (const [start, key, next] of [
  ['Red', 'ArrowRight', 'Orange'],
  ['Red', 'ArrowDown', 'Yellow'],
  ['Yellow', 'ArrowUp', 'Red'],
  ['Orange', 'ArrowLeft', 'Red'],
  ['Red', 'ArrowLeft', 'Red'],
  ['Red', 'ArrowUp', 'Red'],
  ['Orange', 'ArrowRight', 'Orange'],
  ['Reset', 'ArrowDown', 'Reset'],
  ['Gray', 'ArrowLeft', 'Gray'],
  ['Gray', 'ArrowDown', 'Gray'],
] as const)
  test(`staged grid ${start} ${key} focuses ${next} without saving`, async ({
    page,
  }) => {
    const id = await seed(page);
    await page.evaluate(
      async ({ id, start }) => {
        await (window as any).__test.controller.setItemColor(
          id,
          start?.toLowerCase() ?? null,
        );
      },
      { id, start: start === 'Reset' ? null : start },
    );
    await page.keyboard.press('l');
    const palette = page.getByRole('dialog', { name: 'Assign color' });
    const grid = palette.getByRole('grid', { name: 'Note color' });
    await expect(grid).toBeVisible();
    await expect(grid.getByRole('row')).toHaveCount(5);
    await expect(grid.getByRole('gridcell')).toHaveCount(10);
    await expect(grid.getByRole('button')).toHaveCount(10);
    await expect(grid.locator('button[tabindex="0"]')).toHaveCount(1);
    const body = page.locator(`[data-entry-id="${id}"] .note-body`);
    const before = await body.boundingBox();
    const saved = grid.getByRole('button', { name: start, exact: true });
    await expect(saved).toBeFocused();
    await saved.press(key);
    await expect(
      grid.getByRole('button', { name: next, exact: true }),
    ).toBeFocused();
    await expect(saved).toHaveAttribute('aria-pressed', 'true');
    await expect(grid.locator('[aria-pressed="true"]')).toHaveCount(1);
    expect(await savedColor(page, id)).toBe(
      start === 'Reset' ? null : (start?.toLowerCase() ?? null),
    );
    await page.keyboard.press('Escape');
    await expect(palette).toHaveCount(0);
    expect(await body.boundingBox()).toEqual(before);
    await expect(
      page.getByRole('region', { name: 'Note stream' }),
    ).toBeFocused();
  });

for (const action of ['Escape', 'Enter', 'Space', 'click'] as const)
  test(`pointer invoker returns after ${action}, with exact acknowledged choice`, async ({
    page,
  }) => {
    const id = await seed(page);
    const invoker = page.getByRole('button', {
      name: 'Assign color',
      exact: true,
    });
    await invoker.click();
    const palette = page.getByRole('dialog', { name: 'Assign color' });
    await expect(
      palette.getByRole('button', { name: 'Reset', exact: true }),
    ).toBeFocused();
    const red = palette.getByRole('button', { name: 'Red', exact: true });
    await red.focus();
    if (action === 'click') await red.click();
    else await red.press(action);
    await expect(palette).toHaveCount(0);
    await expect(invoker).toBeFocused();
    expect(await savedColor(page, id)).toBe(action === 'Escape' ? null : 'red');
  });

for (const exit of ['Escape', 'Tab', 'outside'] as const)
  test(`failed choice ${exit} dismissal preserves captured Retry and newer Search focus`, async ({
    page,
  }) => {
    const id = await seed(page);
    await page.evaluate((id) => {
      const t = (window as any).__test;
      t.repo.fail = 'color';
      t.controller.editContext(id, 'latest **pending** source');
    }, id);
    await page.keyboard.press('l');
    const palette = page.getByRole('dialog', { name: 'Assign color' });
    const red = palette.getByRole('button', { name: 'Red', exact: true });
    await red.click();
    await expect(palette.getByRole('alert')).toContainText('failure');
    await expect(red).toBeFocused();
    await expect(
      palette.getByRole('button', { name: 'Reset', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    if (exit === 'outside') await page.getByRole('searchbox').click();
    else await red.press(exit);
    await expect(palette).toHaveCount(0);
    expect(await savedColor(page, id)).toBeNull();
    await expect(
      page.getByRole('status').filter({ hasText: 'Retry color' }),
    ).toContainText('Red');
    await page.evaluate(() => {
      const t = (window as any).__test;
      t.repo.fail = null;
      t.delay();
      t.controller.editContext(
        t.repo.snapshot.items[0].id,
        'retry exact source',
      );
    });
    const retry = page.getByRole('button', {
      name: 'Retry action',
      exact: true,
    });
    await retry.click();
    const search = page.getByRole('searchbox');
    await search.fill('newer search');
    await page.evaluate(() => (window as any).__test.release());
    await expect.poll(() => savedColor(page, id)).toBe('red');
    await expect(search).toBeFocused();
    await expect(search).toHaveValue('newer search');
    expect(
      await page.evaluate(
        (id) =>
          (window as any).__test.repo.snapshot.items.find(
            (x: any) => x.id === id,
          ).markdown,
        id,
      ),
    ).toBe('retry exact source');
  });

for (const exit of ['Escape', 'Tab', 'outside'] as const)
  test(`pending choice freezes submission and ${exit} cannot cancel its exact write`, async ({
    page,
  }) => {
    const id = await seed(page);
    await page.evaluate((id) => {
      const t = (window as any).__test;
      t.delay();
      t.controller.editContext(id, 'latest exact source');
    }, id);
    await page.keyboard.press('l');
    const palette = page.getByRole('dialog', { name: 'Assign color' });
    const red = palette.getByRole('button', { name: 'Red', exact: true });
    await red.click();
    await expect(palette.getByRole('grid')).toHaveAttribute(
      'aria-busy',
      'true',
    );
    await red.press('ArrowRight');
    await red.press('Enter');
    expect(await savedColor(page, id)).toBeNull();
    if (exit === 'outside')
      await page.getByRole('searchbox').fill('newer search');
    else await red.press(exit);
    await expect(palette).toBeVisible();
    await page.evaluate(() => (window as any).__test.release());
    await expect.poll(() => savedColor(page, id)).toBe('red');
    await expect(palette).toHaveCount(0);
    if (exit === 'outside')
      await expect(page.getByRole('searchbox')).toBeFocused();
    expect(
      await page.evaluate(
        (id) =>
          (window as any).__test.repo.snapshot.items.find(
            (x: any) => x.id === id,
          ).markdown,
        id,
      ),
    ).toBe('latest exact source');
  });

for (const key of ['Tab', 'Shift+Tab'])
  test(`${key} leaves the single-tab-stop grid without saving or trapping focus`, async ({
    page,
  }) => {
    const id = await seed(page);
    await page.keyboard.press('l');
    const palette = page.getByRole('dialog', { name: 'Assign color' });
    await palette
      .getByRole('button', { name: 'Reset', exact: true })
      .press(key);
    await expect(palette).toHaveCount(0);
    expect(await savedColor(page, id)).toBeNull();
  });

for (const retryPath of ['submit', 'global'] as const)
  test(`${retryPath} retry closes its own failed session only after success`, async ({
    page,
  }) => {
    const id = await seed(page);
    await page.evaluate(() => ((window as any).__test.repo.fail = 'color'));
    await page.keyboard.press('l');
    const palette = page.getByRole('dialog', { name: 'Assign color' });
    const orange = palette.getByRole('button', { name: 'Orange', exact: true });
    await orange.focus();
    await orange.press('Enter');
    await expect(palette.getByRole('alert')).toContainText('failure');
    await page.evaluate(() => ((window as any).__test.repo.fail = null));
    if (retryPath === 'submit') await orange.press('Enter');
    else
      await page
        .getByRole('button', { name: 'Retry action', exact: true })
        .dispatchEvent('click');
    await expect.poll(() => savedColor(page, id)).toBe('orange');
    await expect(palette).toHaveCount(0);
    await expect(
      page.getByRole('region', { name: 'Note stream' }),
    ).toBeFocused();
  });

test('older global Retry leaves a newer staged session and focus intact', async ({
  page,
}) => {
  const id = await seed(page);
  await page.evaluate(() => ((window as any).__test.repo.fail = 'color'));
  await page.keyboard.press('l');
  const palette = page.getByRole('dialog', { name: 'Assign color' });
  await palette.getByRole('button', { name: 'Red', exact: true }).click();
  await expect(palette.getByRole('alert')).toContainText('failure');
  await page.keyboard.press('Escape');
  await page.keyboard.press('l');
  const purple = palette.getByRole('button', { name: 'Purple', exact: true });
  await purple.focus();
  await page.evaluate(() => ((window as any).__test.repo.fail = null));
  await page
    .getByRole('button', { name: 'Retry action', exact: true })
    .dispatchEvent('click');
  await expect.poll(() => savedColor(page, id)).toBe('red');
  await expect(palette).toBeVisible();
  await expect(purple).toBeFocused();
  await expect(
    palette.getByRole('button', { name: 'Red', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  expect(await savedColor(page, id)).toBe('red');
});

test('delayed metadata acknowledgment freezes the captured choice and writes once', async ({
  page,
}) => {
  const id = await seed(page);
  await page.evaluate(() => {
    const t = (window as any).__test;
    let release!: () => void;
    const waiting = new Promise<void>((r) => {
      release = r;
    });
    const original = t.repo.setItemColor.bind(t.repo);
    t.colorCalls = 0;
    t.releaseColor = release;
    t.repo.setItemColor = async (...args: any[]) => {
      t.colorCalls++;
      await waiting;
      return original(...args);
    };
  });
  await page.keyboard.press('l');
  const palette = page.getByRole('dialog', { name: 'Assign color' });
  const blue = palette.getByRole('button', { name: 'Blue', exact: true });
  await blue.click();
  await expect(palette.getByRole('grid')).toHaveAttribute('aria-busy', 'true');
  await blue.press('ArrowLeft');
  await blue.press('Space');
  await palette
    .getByRole('button', { name: 'Red', exact: true })
    .dispatchEvent('click');
  await blue.press('Escape');
  await expect(palette).toBeVisible();
  await page.getByRole('searchbox').fill('new focus');
  await expect(palette).toBeVisible();
  await page.evaluate(() => (window as any).__test.releaseColor());
  await expect.poll(() => savedColor(page, id)).toBe('blue');
  await expect(palette).toHaveCount(0);
  await expect(page.getByRole('searchbox')).toBeFocused();
  expect(await page.evaluate(() => (window as any).__test.colorCalls)).toBe(1);
});

test('same-session global Retry is pending until acknowledgment without trapping external focus', async ({
  page,
}) => {
  const id = await seed(page);
  await page.evaluate(() => ((window as any).__test.repo.fail = 'color'));
  await page.keyboard.press('l');
  const palette = page.getByRole('dialog', { name: 'Assign color' });
  await palette.getByRole('button', { name: 'Red', exact: true }).click();
  await expect(palette.getByRole('alert')).toContainText('failure');
  await page.evaluate((id) => {
    const t = (window as any).__test;
    t.repo.fail = null;
    t.delay();
    t.controller.editContext(id, 'global retry pending source');
  }, id);
  await page
    .getByRole('button', { name: 'Retry action', exact: true })
    .dispatchEvent('click');
  await expect(palette.getByRole('grid')).toHaveAttribute('aria-busy', 'true');
  const search = page.getByRole('searchbox');
  await search.fill('new focus');
  await expect(palette).toBeVisible();
  await page.evaluate(() => (window as any).__test.release());
  await expect.poll(() => savedColor(page, id)).toBe('red');
  await expect(palette).toHaveCount(0);
  await expect(search).toBeFocused();
});
