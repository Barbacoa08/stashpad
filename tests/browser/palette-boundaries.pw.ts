import { test, expect, type Page } from '@playwright/test';

async function seed(page: Page) {
  await page.goto('/?fixture');
  await page.getByRole('textbox', { name: 'Capture Markdown' }).waitFor();
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

// Removing boundary handling must break the WebKit wrap assertions, while ordinary
// native inputs still own checked state, Space, and non-boundary navigation.
for (const [start, key, next, color] of [
  ['Reset', 'ArrowRight', 'Red', 'red'],
  ['Reset', 'ArrowDown', 'Red', 'red'],
  ['Red', 'ArrowLeft', 'Reset', null],
  ['Red', 'ArrowUp', 'Reset', null],
] as const)
  test(`palette wraps ${start} ${key} to ${next} with native checked state and saved color`, async ({
    page,
  }) => {
    const id = await seed(page);
    const body = page.locator(`[data-entry-id="${id}"] .note-body`);
    const before = await body.boundingBox();
    await page.keyboard.press('l');
    const palette = page.getByRole('dialog', { name: 'Assign color' });
    const initial = palette.getByRole('radio', { name: start, exact: true });
    if (start === 'Red') {
      await initial.press('Space');
      await expect.poll(() => savedColor(page, id)).toBe('red');
    }
    await expect(initial).toBeFocused();
    await initial.press(key);
    const target = palette.getByRole('radio', { name: next, exact: true });
    await expect(target).toBeChecked();
    await expect(target).toBeFocused();
    await expect(palette.locator('input:checked')).toHaveCount(1);
    await expect.poll(() => savedColor(page, id)).toBe(color);
    expect(await body.boundingBox()).toEqual(before);
  });

// Capturing only activeElement fails on Mac pointer activation, which need not
// focus the clicked button. Both explicit close actions must use the invoker.
for (const close of ['Escape', 'Done'] as const)
  test(`pointer-opened palette ${close} returns to its actual invoker`, async ({
    page,
  }) => {
    await seed(page);
    const invoker = page.getByRole('button', {
      name: 'Assign color',
      exact: true,
    });
    await invoker.click();
    const palette = page.getByRole('dialog', { name: 'Assign color' });
    await expect(
      palette.getByRole('radio', { name: 'Reset', exact: true }),
    ).toBeFocused();
    if (close === 'Escape') await page.keyboard.press('Escape');
    else
      await palette.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(palette).toHaveCount(0);
    await expect(invoker).toBeFocused();
  });

test('wrapped color choice blocks further radio changes while pending and restores saved state after failed acknowledgment', async ({
  page,
}) => {
  const id = await seed(page);
  await page.evaluate((id) => {
    const t = (window as any).__test;
    t.delay();
    t.repo.fail = 'color';
    t.controller.editContext(id, 'latest **pending** source');
  }, id);
  await page.keyboard.press('l');
  const palette = page.getByRole('dialog', { name: 'Assign color' });
  const reset = palette.getByRole('radio', { name: 'Reset', exact: true });
  const red = palette.getByRole('radio', { name: 'Red', exact: true });
  await reset.press('ArrowRight');
  await expect(palette.locator('fieldset')).toHaveAttribute(
    'aria-busy',
    'true',
  );
  await expect(red).toBeChecked();
  await red.press('ArrowLeft');
  await red.press('Space');
  await expect(red).toBeChecked();
  expect(await savedColor(page, id)).toBeNull();
  await page.evaluate(() => (window as any).__test.release());
  await expect(
    page.getByRole('button', { name: 'Retry action', exact: true }),
  ).toBeVisible();
  await expect(reset).toBeChecked();
  await expect(red).toBeFocused();
  await expect(palette.locator('fieldset')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await page.evaluate(() => ((window as any).__test.repo.fail = null));
  const retry = page.getByRole('button', { name: 'Retry action', exact: true });
  await retry.focus();
  await retry.press('Enter');
  await expect.poll(() => savedColor(page, id)).toBe('red');
  expect(
    await page.evaluate(
      (id) =>
        (window as any).__test.repo.snapshot.items.find((x: any) => x.id === id)
          .markdown,
      id,
    ),
  ).toBe('latest **pending** source');
  await expect(palette).toHaveCount(0);
});

test('wrapped choice acknowledgment preserves newer Search input and focus', async ({
  page,
}) => {
  const id = await seed(page);
  await page.evaluate((id) => {
    const t = (window as any).__test;
    t.delay();
    t.controller.editContext(id, 'latest exact source');
  }, id);
  await page.keyboard.press('l');
  await page
    .getByRole('radio', { name: 'Reset', exact: true })
    .press('ArrowRight');
  const search = page.getByRole('searchbox');
  await search.fill('newer search');
  await page.evaluate(() => (window as any).__test.release());
  await expect.poll(() => savedColor(page, id)).toBe('red');
  await expect(search).toBeFocused();
  await expect(search).toHaveValue('newer search');
  await expect(page.getByRole('dialog', { name: 'Assign color' })).toHaveCount(
    0,
  );
});

// Palette tab stops must remain reachable even when Mac WebKit skips implicit
// control tab stops. Forward/backward Tab must not become a focus trap.
test('palette Tab reaches Done, Shift Tab returns to the checked radio, and another Tab leaves', async ({
  page,
}) => {
  const id = await seed(page);
  await page.keyboard.press('l');
  const palette = page.getByRole('dialog', { name: 'Assign color' });
  const gray = palette.getByRole('radio', { name: 'Gray', exact: true });
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => savedColor(page, id)).toBe('gray');
  await expect(gray).toBeFocused();
  await page.keyboard.press('Tab');
  const done = palette.getByRole('button', { name: 'Done', exact: true });
  await expect(done).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(gray).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(done).toBeFocused();
  await page.keyboard.press('Tab');
  await expect
    .poll(() =>
      palette.evaluateAll((panels) =>
        panels.some((panel) => panel.contains(document.activeElement)),
      ),
    )
    .toBe(false);
});

for (const phase of ['pending', 'failed'] as const)
  test(`Tab from the focused boundary radio reaches Done during ${phase} color acknowledgment`, async ({
    page,
  }) => {
    const id = await seed(page);
    await page.evaluate((id) => {
      const t = (window as any).__test;
      t.delay();
      t.repo.fail = 'color';
      t.controller.editContext(id, 'latest **Tab acknowledgment** source');
    }, id);
    await page.keyboard.press('l');
    await page.keyboard.press('ArrowRight');
    const palette = page.getByRole('dialog', { name: 'Assign color' });
    const red = palette.getByRole('radio', { name: 'Red', exact: true });
    const reset = palette.getByRole('radio', { name: 'Reset', exact: true });
    await expect(palette.locator('fieldset')).toHaveAttribute(
      'aria-busy',
      'true',
    );
    await expect(red).toBeChecked();
    if (phase === 'failed') {
      await page.evaluate(() => (window as any).__test.release());
      await expect(palette.locator('fieldset')).toHaveAttribute(
        'aria-busy',
        'false',
      );
      await expect(reset).toBeChecked();
    }
    await expect(red).toBeFocused();
    expect(await savedColor(page, id)).toBeNull();
    await page.keyboard.press('Tab');
    const done = palette.getByRole('button', { name: 'Done', exact: true });
    await expect(done).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    if (phase === 'failed') {
      await expect(reset).toBeFocused();
      await expect(reset).toBeChecked();
    } else {
      await expect(red).toBeFocused();
      await expect(red).toBeChecked();
    }
    await page.keyboard.press('Tab');
    await expect(done).toBeFocused();
    if (phase === 'pending') {
      await page.evaluate(() => (window as any).__test.release());
      await expect(reset).toBeChecked();
      await expect(done).toBeFocused();
    }
    await page.keyboard.press('Tab');
    await expect
      .poll(() =>
        palette.evaluateAll((panels) =>
          panels.some((panel) => panel.contains(document.activeElement)),
        ),
      )
      .toBe(false);
  });
