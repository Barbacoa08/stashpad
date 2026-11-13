import { test, expect, type Page } from '@playwright/test';

const card = (page: Page, id: string) =>
  page.locator(`[data-entry-id="${id}"]`);
const palette = (page: Page) =>
  page.getByRole('dialog', { name: 'Assign color' });
async function seed(page: Page) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/?fixture');
  await page.getByRole('textbox', { name: 'Capture Markdown' }).waitFor();
  return page.evaluate(async () => {
    const t = (window as any).__test;
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      const id = crypto.randomUUID();
      ids.push(id);
      await t.repo.captureItem({
        id,
        location: { scope: 'live', itemId: null },
        markdown: `Row ${i}\n\nSynthetic paragraph one.\n\nSynthetic paragraph two.`,
        draft: { key: 'compose', revision: 0 },
      });
    }
    await t.controller.start();
    return ids;
  });
}
async function expectAtRow(page: Page, id: string) {
  await expect(palette(page)).toBeVisible();
  const row = (await card(page, id).boundingBox())!;
  const popup = (await palette(page).boundingBox())!;
  expect(
    Math.min(
      Math.abs(popup.x - row.x - row.width),
      Math.abs(row.x - popup.x - popup.width),
      Math.abs(popup.x + popup.width - row.x - row.width),
    ),
  ).toBeLessThanOrEqual(9);
  await expect
    .poll(async () => {
      const row = (await card(page, id).boundingBox())!;
      const popup = (await palette(page).boundingBox())!;
      return Math.abs(popup.y - row.y);
    })
    .toBeLessThan(3);
}

// Fixed viewport coordinates must fail when the selected row changes.
for (const invocation of ['keyboard', 'Details'] as const)
  test(`${invocation} color picker anchors to each captured row`, async ({
    page,
  }) => {
    const ids = await seed(page);
    for (const id of [ids[0], ids[3]]) {
      await card(page, id).click();
      if (invocation === 'keyboard') await page.keyboard.press('l');
      else
        await page
          .getByRole('button', { name: 'Assign color', exact: true })
          .click();
      await expectAtRow(page, id);
      await page.keyboard.press('Escape');
    }
  });

test('picker tracks visible row scroll and dismisses a fully clipped row without taking Search focus', async ({
  page,
}) => {
  const ids = await seed(page);
  const id = ids[3];
  await card(page, id).click();
  await page.keyboard.press('l');
  await expectAtRow(page, id);
  await page.locator('.note-stream').evaluate((node) => {
    node.scrollTop += 80;
  });
  await expectAtRow(page, id);
  await page.locator('.note-stream').evaluate((node) => {
    const selected = node.querySelector('.note-card.selected')!;
    node.scrollTop +=
      selected.getBoundingClientRect().top -
      node.getBoundingClientRect().top +
      30;
  });
  await expect
    .poll(async () => {
      const popup = (await palette(page).boundingBox())!;
      const stream = (await page.locator('.note-stream').boundingBox())!;
      return Math.abs(popup.y - stream.y);
    })
    .toBeLessThan(3);
  const search = page.getByRole('searchbox');
  // A programmatic scroll must not leave a detached picker at its old coordinates.
  await page.locator('.note-stream').evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await expect(palette(page)).toHaveCount(0);
  await search.focus();
  await expect(search).toBeFocused();
});

test('bottom-edge picker stays bounded through resize, enlarged text, and failure expansion', async ({
  page,
}) => {
  const ids = await seed(page);
  const id = ids[11];
  await card(page, id).click();
  await page.keyboard.press('l');
  async function expectBounded() {
    await expect(palette(page)).toBeVisible();
    await expect
      .poll(async () => {
        const box = (await palette(page).boundingBox())!;
        const viewport = page.viewportSize()!;
        return (
          box.x >= 7 &&
          box.y >= 7 &&
          box.x + box.width <= viewport.width - 7 &&
          box.y + box.height <= viewport.height - 7
        );
      })
      .toBe(true);
  }
  await expectBounded();
  await page.setViewportSize({ width: 800, height: 600 });
  await page.addStyleTag({ content: ':root{font-size:24px!important}' });
  // Resizing can clip the selected row entirely, so reopen at its new visible location.
  await card(page, id).scrollIntoViewIfNeeded();
  if (!(await palette(page).count())) {
    await card(page, id).click();
    await page.keyboard.press('l');
  }
  await expectBounded();
  await page.evaluate(() => {
    (window as any).__test.repo.fail = 'color';
  });
  await palette(page)
    .getByRole('button', { name: 'Orange', exact: true })
    .click();
  await expect(palette(page).getByRole('alert')).toBeVisible();
  await expectBounded();
  const retry = page.getByRole('button', { name: 'Retry action', exact: true });
  await retry.scrollIntoViewIfNeeded();
  const popup = (await palette(page).boundingBox())!;
  const button = (await retry.boundingBox())!;
  expect(popup.y + popup.height).toBeLessThan(button.y);
  await expect(retry).toBeVisible();
});

test('earlier row growth repositions the picker without changing its captured target', async ({
  page,
}) => {
  const ids = await seed(page);
  const id = ids[3];
  await card(page, id).click();
  await page.keyboard.press('l');
  await expectAtRow(page, id);
  const before = (await card(page, id).boundingBox())!.y;
  await page.evaluate(async (id) => {
    const t = (window as any).__test;
    t.controller.editContext(
      id,
      'Synthetic expanded source\n\nExtra paragraph\n\nAnother paragraph\n\nAnd one more paragraph',
    );
    await t.controller.flush();
  }, ids[0]);
  await expect
    .poll(async () => (await card(page, id).boundingBox())!.y - before)
    .toBeGreaterThan(20);
  await expectAtRow(page, id);
  await palette(page)
    .getByRole('button', { name: 'Blue', exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          (window as any).__test.repo.snapshot.items.find(
            (item: any) => item.id === id,
          ).color,
        id,
      ),
    )
    .toBe('blue');
});

test('fully clipped pending choice retains its write and exact failure Retry after dismissal', async ({
  page,
}) => {
  const ids = await seed(page);
  const id = ids[3];
  await card(page, id).click();
  await page.evaluate(() => {
    const t = (window as any).__test;
    t.repo.fail = 'color';
    t.delay();
    t.controller.editContext(
      t.repo.snapshot.items[3].id,
      'Latest exact source before color',
    );
  });
  await page.keyboard.press('l');
  await palette(page).getByRole('button', { name: 'Red', exact: true }).click();
  await expect(palette(page).getByRole('grid')).toHaveAttribute(
    'aria-busy',
    'true',
  );
  await page.locator('.note-stream').evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await expect(palette(page)).toBeVisible();
  await page.evaluate(() => (window as any).__test.release());
  await expect(palette(page)).toHaveCount(0);
  await expect(
    page.getByRole('region', { name: 'Note stream' }),
  ).not.toBeFocused();
  await card(page, ids[11]).click();
  await page.evaluate(() => {
    (window as any).__test.repo.fail = null;
  });
  await page.getByRole('button', { name: 'Retry action', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          (window as any).__test.repo.snapshot.items.find(
            (item: any) => item.id === id,
          ).color,
        id,
      ),
    )
    .toBe('red');
  expect(
    await page.evaluate(
      (id) =>
        (window as any).__test.repo.snapshot.items.find(
          (item: any) => item.id === id,
        ).color,
      ids[11],
    ),
  ).toBeNull();
});

test('disconnected row dismisses its picker without returning focus to the stream', async ({
  page,
}) => {
  const ids = await seed(page);
  await card(page, ids[3]).click();
  await page.keyboard.press('l');
  await expectAtRow(page, ids[3]);
  await page.evaluate(
    (id) => (window as any).__test.controller.remove(id),
    ids[3],
  );
  await expect(palette(page)).toHaveCount(0);
  await expect(
    page.getByRole('region', { name: 'Note stream' }),
  ).not.toBeFocused();
});
