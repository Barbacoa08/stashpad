import { test, expect, type Page } from '@playwright/test';
const capture = (p: Page) =>
  p.getByRole('textbox', { name: 'New note Markdown' });
async function child(p: Page, label: string) {
  await p.keyboard.press('Meta+n');
  await expect(capture(p)).toBeFocused();
  return p.evaluate(async (label) => {
    const c = (window as any).__test.controller;
    const id = c.state.ownerId;
    c.editContext(id, label);
    await c.flush();
    // History tests revisit saved containers; empty-container exits are covered separately.
    c.editSource('saved child for history');
    await c.save();
    return id;
  }, label);
}
test('history follows successful visits and ancestor clicks flush source', async ({
  page,
}) => {
  await page.goto('/?fixture');
  await expect(capture(page)).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Back', exact: true }),
  ).toBeDisabled();
  const parent = await child(page, 'Parent'),
    nested = await child(page, 'Nested');
  await capture(page).fill('nested draft');
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__test.controller.state.ownerId),
    )
    .toBe(parent);
  await page.getByRole('button', { name: 'Forward', exact: true }).click();
  await expect(capture(page)).toHaveText('nested draft');
  await page
    .getByRole('navigation', { name: 'Breadcrumbs' })
    .getByRole('button', { name: 'Go to Parent', exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__test.controller.state.ownerId),
    )
    .toBe(parent);
  expect(nested).not.toBe(parent);
});
test('Details defaults respond until choice; collapse frees width and keeps errors reachable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.goto('/?fixture');
  await expect(capture(page)).toBeVisible();
  const toggle = page.getByRole('button', {
    name: 'Hide Details',
    exact: true,
  });
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const before = (await page.locator('.notes-column').boundingBox())!.width;
  await toggle.click();
  await expect(
    page.getByRole('complementary', { name: 'Note details' }),
  ).toBeHidden();
  expect(
    (await page.locator('.notes-column').boundingBox())!.width,
  ).toBeGreaterThan(before + 150);
  await page.setViewportSize({ width: 800, height: 600 });
  await page.setViewportSize({ width: 1400, height: 800 });
  await expect(
    page.getByRole('button', { name: 'Show Details', exact: true }),
  ).toHaveAttribute('aria-expanded', 'false');
  await page.evaluate(() => {
    (window as any).__test.repo.fail = 'checkpoint';
  });
  await capture(page).fill('retained');
  await page.getByRole('button', { name: 'Root', exact: true }).first().click();
  await expect(page.getByRole('alert')).toContainText('failure');
  await expect(
    page.getByRole('button', { name: 'Retry action' }),
  ).toBeVisible();
  await expect(capture(page)).toHaveText('retained');
});
const back = (p: Page) => p.getByRole('button', { name: 'Back', exact: true });
const forward = (p: Page) =>
  p.getByRole('button', { name: 'Forward', exact: true });
const at = (p: Page) =>
  p.evaluate(() => (window as any).__test.controller.state.location);
async function failCheckpoint(p: Page) {
  await p.evaluate(() => {
    (window as any).__test.repo.fail = 'checkpoint';
  });
}
async function allowCheckpoint(p: Page) {
  await p.evaluate(() => {
    (window as any).__test.repo.fail = null;
  });
}
test('failed Back commits its cursor only after generic Retry and preserves newer Search', async ({
  page,
}) => {
  await page.goto('/?fixture');
  await expect(capture(page)).toBeVisible();
  const parent = await child(page, 'Parent');
  const nested = await child(page, 'Nested');
  await failCheckpoint(page);
  await capture(page).fill('exact failed draft');
  await back(page).click();
  await expect(page.getByRole('alert')).toContainText('failure');
  expect((await at(page)).itemId).toBe(nested);
  await expect(forward(page)).toBeDisabled();
  await allowCheckpoint(page);
  await page.evaluate(() => (window as any).__test.delayCheckpoint());
  await page.getByRole('button', { name: 'Retry action', exact: true }).click();
  await page.getByRole('searchbox').fill('new search');
  await page.evaluate(() => (window as any).__test.releaseCheckpoint());
  await expect.poll(() => at(page)).toEqual({ scope: 'live', itemId: parent });
  await expect(page.getByRole('searchbox')).toBeFocused();
  await expect(page.getByRole('searchbox')).toHaveValue('new search');
  await forward(page).click();
  await expect(capture(page)).toHaveText('exact failed draft');
});
test('ordinary failed navigation Retry records exactly one successful visit', async ({
  page,
}) => {
  await page.goto('/?fixture');
  await expect(capture(page)).toBeVisible();
  const parent = await child(page, 'Parent');
  const nested = await child(page, 'Nested');
  await failCheckpoint(page);
  await capture(page).fill('preserved');
  await page
    .getByRole('navigation', { name: 'Breadcrumbs' })
    .getByRole('button', { name: 'Go to Parent', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText('failure');
  expect((await at(page)).itemId).toBe(nested);
  await allowCheckpoint(page);
  await page.getByRole('button', { name: 'Retry action', exact: true }).click();
  await expect.poll(() => at(page)).toEqual({ scope: 'live', itemId: parent });
  await back(page).click();
  await expect.poll(() => at(page)).toEqual({ scope: 'live', itemId: nested });
  await forward(page).click();
  await expect.poll(() => at(page)).toEqual({ scope: 'live', itemId: parent });
  await expect(forward(page)).toBeDisabled();
});
test('new navigation supersedes delayed Back without moving its pointer or taking Search focus', async ({
  page,
}) => {
  await page.goto('/?fixture');
  await expect(capture(page)).toBeVisible();
  await child(page, 'Parent');
  const nested = await child(page, 'Nested');
  await page.evaluate(() => (window as any).__test.delayCheckpoint());
  await capture(page).fill('retained nested');
  await back(page).click();
  await page
    .getByRole('navigation', { name: 'Breadcrumbs' })
    .getByRole('button', { name: 'Go to Root', exact: true })
    .click();
  await page.getByRole('searchbox').fill('newer');
  await page.evaluate(() => (window as any).__test.releaseCheckpoint());
  await expect.poll(() => at(page)).toEqual({ scope: 'live', itemId: null });
  await expect(page.getByRole('searchbox')).toBeFocused();
  await back(page).click();
  await expect.poll(() => at(page)).toEqual({ scope: 'live', itemId: nested });
  await expect(capture(page)).toHaveText('retained nested');
});
test('history skips deleted recorded live scope without promoting or retargeting into Trash', async ({
  page,
}) => {
  await page.goto('/?fixture');
  await expect(capture(page)).toBeVisible();
  const parent = await child(page, 'Parent');
  await child(page, 'Nested');
  await page
    .getByRole('navigation', { name: 'Breadcrumbs' })
    .getByRole('button', { name: 'Go to Root', exact: true })
    .click();
  await page.evaluate(async (parent) => {
    const t = (window as any).__test;
    await t.controller.remove(parent);
    t.repo.promoteItem = () => {
      throw new Error('history must not promote');
    };
  }, parent);
  await back(page).click();
  await expect.poll(() => at(page)).toEqual({ scope: 'live', itemId: null });
  await expect(back(page)).toBeDisabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
});
test('structural restore reconciles the current slot; Trash breadcrumb stops at explicit deleted root', async ({
  page,
}) => {
  await page.goto('/?fixture');
  await expect(capture(page)).toBeVisible();
  const parent = await child(page, 'Parent');
  const nested = await child(page, 'Nested');
  await page.evaluate(async (parent) => {
    await (window as any).__test.controller.remove(parent);
  }, parent);
  await expect.poll(() => at(page)).toEqual({ scope: 'live', itemId: null });
  await page.getByRole('button', { name: 'Trash', exact: true }).click();
  await page.evaluate(async (nested) => {
    await (window as any).__test.controller.openLocation({
      scope: 'trash',
      itemId: nested,
    });
  }, nested);
  const crumb = page.getByRole('navigation', { name: 'Breadcrumbs' });
  await expect(crumb.getByRole('button')).toHaveText([
    'Trash',
    'Parent',
    'Nested',
  ]);
  await page.evaluate(async (parent) => {
    await (window as any).__test.controller.restoreItem(parent);
  }, parent);
  await expect.poll(() => at(page)).toEqual({ scope: 'live', itemId: nested });
  await back(page).click();
  await expect.poll(() => at(page)).toEqual({ scope: 'trash', itemId: null });
  await forward(page).click();
  await expect.poll(() => at(page)).toEqual({ scope: 'live', itemId: nested });
  await expect(forward(page)).toBeDisabled();
});
test('successful full backup replacement resets all session visits', async ({
  page,
}) => {
  await page.goto('/?fixture');
  await expect(capture(page)).toBeVisible();
  await child(page, 'Parent');
  await page.evaluate(() => {
    (window as any).__test.repo.restoreText = JSON.stringify({
      format: 'scratchtree-alpha',
      version: 7,
      exportedAt: '2026-11-11T00:00:00.000Z',
      library: {
        items: [],
        drafts: [
          { key: 'compose', markdown: 'restored', revision: 1, updatedAt: 0 },
        ],
        undoDeleteIds: [],
      },
    });
  });
  await page
    .getByRole('button', { name: 'Restore backup', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Replace library', exact: true })
    .click();
  await expect(capture(page)).toHaveText('restored');
  await expect(back(page)).toBeDisabled();
  await expect(forward(page)).toBeDisabled();
});
test('responsive default hides focused rail safely, reopening preserves Search, explicit choice survives resize', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.goto('/?fixture');
  await expect(capture(page)).toBeVisible();
  const rail = page.getByRole('complementary', { name: 'Note details' });
  await rail.focus();
  await page.setViewportSize({ width: 800, height: 600 });
  const toggle = page.getByRole('button', {
    name: 'Show Details',
    exact: true,
  });
  await expect(toggle).toBeFocused();
  await expect(rail).toBeHidden();
  await page.getByRole('searchbox').focus();
  await page.setViewportSize({ width: 1400, height: 800 });
  await expect(rail).toBeVisible();
  await expect(page.getByRole('searchbox')).toBeFocused();
  await page.getByRole('button', { name: 'Hide Details', exact: true }).click();
  await page.setViewportSize({ width: 800, height: 600 });
  await page.getByRole('button', { name: 'Show Details', exact: true }).click();
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.setViewportSize({ width: 800, height: 600 });
  await expect(rail).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Hide Details', exact: true }),
  ).toHaveAttribute('aria-expanded', 'true');
});
test('bounded deep breadcrumbs and controls fit 800 by 600 at 150 percent; browser shows no fake native controls', async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto('/?fixture');
  await expect(capture(page)).toBeVisible();
  await page.evaluate(async () => {
    const t = (window as any).__test;
    let parent = null;
    for (let i = 0; i < 30; i++) {
      const id = crypto.randomUUID();
      await t.repo.createChildTree({
        id,
        parent: { scope: 'live', itemId: parent },
      });
      await t.repo.saveItemSource(
        id,
        'Long level ' + i + ' ' + 'wide '.repeat(20),
        { key: id, revision: 1 },
      );
      parent = id;
    }
    await t.controller.start();
    await t.controller.openLocation({ scope: 'live', itemId: parent });
  });
  await page.addStyleTag({ content: ':root{font-size:24px!important}' });
  const crumb = page.getByRole('navigation', { name: 'Breadcrumbs' });
  await expect(crumb.getByRole('button')).toHaveCount(3);
  await expect(crumb.getByLabel('28 ancestors omitted')).toBeVisible();
  for (const button of await page.locator('.app-header button').all()) {
    const r = await button.boundingBox();
    expect(r!.width).toBeGreaterThan(10);
    expect(r!.x).toBeGreaterThanOrEqual(0);
    expect(r!.x + r!.width).toBeLessThanOrEqual(800);
    expect(
      await button.evaluate((el) => !!el.closest('[data-tauri-drag-region]')),
    ).toBe(false);
  }
  await expect(page.locator('.native-controls-inset')).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    800,
  );
  await page.getByRole('button', { name: 'Show Details', exact: true }).click();
  await page.screenshot({ path: 'captures/task4-narrow-150.png' });
  await page.getByRole('button', { name: 'Hide Details', exact: true }).click();
  await crumb.getByRole('button', { name: 'Go to Root', exact: true }).click();
  await expect.poll(() => at(page)).toEqual({ scope: 'live', itemId: null });
});
test('Root and Trash roots are distinct successful visits', async ({
  page,
}) => {
  await page.goto('/?fixture');
  await expect(capture(page)).toBeVisible();
  await page.getByRole('button', { name: 'Trash', exact: true }).click();
  await expect(back(page)).toBeEnabled();
  await back(page).click();
  await expect.poll(() => at(page)).toEqual({ scope: 'live', itemId: null });
  await forward(page).click();
  await expect.poll(() => at(page)).toEqual({ scope: 'trash', itemId: null });
});
test('right-side status retains explanation when expanded; collapsed retry remains visible without moving the editor', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.goto('/?fixture');
  await expect(capture(page)).toBeVisible();
  const status = page.getByRole('region', { name: 'Editor status' });
  await expect(status).toContainText('Notes and drafts on this Mac.');
  expect(
    await status.evaluate((el) =>
      el.closest('.details-pane')?.classList.contains('open'),
    ),
  ).toBe(true);
  await page.getByRole('button', { name: 'Hide Details', exact: true }).click();
  const rect = await page.locator('.notes-column').boundingBox();
  await failCheckpoint(page);
  await capture(page).fill('source retained');
  await page.getByRole('button', { name: 'Root', exact: true }).first().click();
  await expect(page.getByRole('alert')).toContainText('failure');
  const retry = page.getByRole('button', { name: 'Retry action', exact: true });
  await expect(retry).toBeVisible();
  expect(await page.locator('.notes-column').boundingBox()).toEqual(rect);
  const box = (await status.boundingBox())!;
  expect(box.x + box.width).toBeGreaterThan(1300);
  expect(box.y).toBeGreaterThan(30);
  await retry.focus();
  await page
    .getByRole('button', { name: 'Show Details', exact: true })
    .dispatchEvent('click');
  await expect(retry).toBeFocused();
  await expect(status).toContainText('Notes and drafts on this Mac.');
  await page
    .getByRole('button', { name: 'Hide Details', exact: true })
    .dispatchEvent('click');
  await expect(retry).toBeFocused();
  await expect(retry).toBeVisible();
});
test('collapsed narrow 150 percent color failure keeps pointer Retry clear of the open picker and targets its exact item', async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto('/?fixture');
  await expect(capture(page)).toBeVisible();
  await page.addStyleTag({ content: ':root{font-size:24px!important}' });
  await capture(page).fill('bounded palette item **source**');
  await capture(page).press('Enter');
  const note = page.getByRole('article', { name: 'Saved note' });
  await note.click();
  const id = await note.getAttribute('data-entry-id');
  const geometry = await page.locator('.notes-column').boundingBox();
  await page.evaluate(() => {
    (window as any).__test.repo.fail = 'color';
  });
  await page.keyboard.press('l');
  const palette = page.getByRole('dialog', { name: 'Assign color' });
  await palette.getByRole('button', { name: 'Red', exact: true }).click();
  await expect(palette.getByRole('alert')).toContainText('failure');
  const status = page.getByRole('region', { name: 'Editor status' });
  await expect(status).toContainText('Red for bounded palette item');
  await expect(status).not.toContainText(id!);
  const retry = page.getByRole('button', { name: 'Retry action', exact: true });
  await retry.scrollIntoViewIfNeeded();
  const p = (await palette.boundingBox())!,
    r = (await retry.boundingBox())!;
  expect(p.y + p.height).toBeLessThan(r.y);
  expect(await page.locator('.notes-column').boundingBox()).toEqual(geometry);
  await page.screenshot({
    path: 'captures/task4-palette-retry-narrow-150.png',
  });
  await page.evaluate(() => {
    (window as any).__test.repo.fail = null;
  });
  await retry.click();
  await expect(palette).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          (window as any).__test.repo.snapshot.items.find(
            (x: any) => x.id === id,
          ).color,
        id,
      ),
    )
    .toBe('red');
  await expect(note).toContainText('bounded palette item source');
});

test('collapsed session preference retains visible Retry focus across breakpoints', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.goto('/?fixture');
  await expect(capture(page)).toBeVisible();
  await page.getByRole('button', { name: 'Hide Details', exact: true }).click();
  await failCheckpoint(page);
  await capture(page).fill('retained');
  await page.getByRole('button', { name: 'Root', exact: true }).click();
  const retry = page.getByRole('button', { name: 'Retry action', exact: true });
  await retry.focus();
  await page.setViewportSize({ width: 800, height: 600 });
  await expect(retry).toBeFocused();
  await page.setViewportSize({ width: 1400, height: 800 });
  await expect(retry).toBeFocused();
});
test('failed Back is superseded by a newer visit before its captured Retry', async ({
  page,
}) => {
  await page.goto('/?fixture');
  await expect(capture(page)).toBeVisible();
  const parent = await child(page, 'Parent');
  await child(page, 'Nested');
  await failCheckpoint(page);
  await capture(page).fill('nested retained');
  await back(page).click();
  await expect(page.getByRole('alert')).toContainText('failure');
  await allowCheckpoint(page);
  await page
    .getByRole('navigation', { name: 'Breadcrumbs' })
    .getByRole('button', { name: 'Go to Root', exact: true })
    .click();
  await page.getByRole('button', { name: 'Retry action', exact: true }).click();
  await expect.poll(() => at(page)).toEqual({ scope: 'live', itemId: parent });
  await expect(forward(page)).toBeDisabled();
  await back(page).click();
  await expect.poll(() => at(page)).toEqual({ scope: 'live', itemId: null });
});
test('Right promotion records one visit and history never promotes on traversal', async ({
  page,
}) => {
  await page.goto('/?fixture');
  await expect(capture(page)).toBeVisible();
  await capture(page).fill('source **promoted**');
  await capture(page).press('Enter');
  const note = page.getByRole('article', { name: 'Saved note' });
  const id = await note.getAttribute('data-entry-id');
  await note.click();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => at(page)).toEqual({ scope: 'live', itemId: id });
  await capture(page).fill('saved child for history');
  await capture(page).press('Enter');
  await capture(page).fill('owned draft');
  await page.evaluate(() => {
    (window as any).__test.repo.promoteItem = () => {
      throw new Error('traversal must never promote');
    };
  });
  await back(page).click();
  await expect(back(page)).toBeDisabled();
  await expect.poll(() => at(page)).toEqual({ scope: 'live', itemId: null });
  await forward(page).click();
  await expect(capture(page)).toHaveText('owned draft');
  await expect(forward(page)).toBeDisabled();
  expect(
    await page.evaluate(
      (id) =>
        (window as any).__test.repo.snapshot.items.find((x: any) => x.id === id)
          .markdown,
      id,
    ),
  ).toBe('source **promoted**');
});
test('cancelled restore and failed replacement preserve the current session visits', async ({
  page,
}) => {
  await page.goto('/?fixture');
  await expect(capture(page)).toBeVisible();
  const parent = await child(page, 'Parent');
  await page.evaluate(() => {
    (window as any).__test.repo.restoreText = JSON.stringify({
      format: 'scratchtree-alpha',
      version: 7,
      exportedAt: '2026-11-11T00:00:00.000Z',
      library: { items: [], drafts: [], undoDeleteIds: [] },
    });
  });
  await page
    .getByRole('button', { name: 'Restore backup', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Cancel restore', exact: true })
    .click();
  await expect(back(page)).toBeEnabled();
  expect((await at(page)).itemId).toBe(parent);
  await page
    .getByRole('button', { name: 'Restore backup', exact: true })
    .click();
  await page.evaluate(() => {
    (window as any).__test.repo.fail = 'restore';
  });
  await page
    .getByRole('button', { name: 'Replace library', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText('failure');
  expect((await at(page)).itemId).toBe(parent);
  await page.evaluate(() => {
    (window as any).__test.repo.fail = null;
  });
  await page
    .getByRole('button', { name: 'Cancel restore', exact: true })
    .click();
  await back(page).click();
  await expect.poll(() => at(page)).toEqual({ scope: 'live', itemId: null });
  await forward(page).click();
  await expect.poll(() => at(page)).toEqual({ scope: 'live', itemId: parent });
});
test('restoring a recorded Trash destination makes that forward visit stale without retargeting to live', async ({
  page,
}) => {
  await page.goto('/?fixture');
  await expect(capture(page)).toBeVisible();
  const parent = await child(page, 'Parent');
  await page.evaluate(async (id) => {
    const c = (window as any).__test.controller;
    await c.remove(id);
    await c.openLocation({ scope: 'trash', itemId: null });
    await c.openLocation({ scope: 'trash', itemId: id });
  }, parent);
  await back(page).click();
  await expect.poll(() => at(page)).toEqual({ scope: 'trash', itemId: null });
  await page.evaluate(async (id) => {
    await (window as any).__test.controller.restoreItem(id);
  }, parent);
  await expect(forward(page)).toBeDisabled();
  await expect.poll(() => at(page)).toEqual({ scope: 'trash', itemId: null });
});

test('expanded recovery Retry retains focus through automatic collapse and reopening', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.goto('/?fixture');
  await expect(capture(page)).toBeVisible();
  const rail = page.getByRole('complementary', { name: 'Note details' });
  await expect(rail).toBeVisible();
  await failCheckpoint(page);
  await capture(page).fill('exact retained recovery draft');
  await page.getByRole('button', { name: 'Root', exact: true }).click();
  const retry = page.getByRole('button', { name: 'Retry action', exact: true });
  await retry.focus();
  await page.setViewportSize({ width: 800, height: 600 });
  await expect(rail).toBeHidden();
  await expect(retry).toBeVisible();
  await expect(retry).toBeFocused();
  await expect(capture(page)).toHaveText('exact retained recovery draft');
  await expect(page.getByRole('alert')).toContainText('checkpoint failure');
  await page.setViewportSize({ width: 1400, height: 800 });
  await expect(rail).toBeVisible();
  await expect(retry).toBeFocused();
  await expect(capture(page)).toHaveText('exact retained recovery draft');
});
test('manual collapse relocates focus only from the hidden rail body', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.goto('/?fixture');
  await expect(capture(page)).toBeVisible();
  const rail = page.getByRole('complementary', { name: 'Note details' });
  await rail.focus();
  await page
    .getByRole('button', { name: 'Hide Details', exact: true })
    .dispatchEvent('click');
  await expect(rail).toBeHidden();
  await expect(
    page.getByRole('button', { name: 'Show Details', exact: true }),
  ).toBeFocused();
});
