import { expect, test, type Page, type Locator } from '@playwright/test';
const capture = (p: Page) =>
  p.getByRole('textbox', { name: 'New note Markdown' });
const card = (p: Page, id: string) => p.locator(`[data-entry-id="${id}"]`);
async function seed(p: Page) {
  await p.goto('/?fixture');
  await capture(p).waitFor();
  return p.evaluate(async () => {
    const t = (window as any).__test;
    const ids = Array.from({ length: 4 }, () => crypto.randomUUID());
    for (const [i, markdown] of ['first **source**', 'tree', 'last'].entries())
      await t.repo.captureItem({
        id: ids[i],
        location: { scope: 'live', itemId: null },
        markdown,
        draft: { key: 'compose', revision: 0 },
      });
    await t.repo.createChildTree({
      id: ids[3],
      parent: { scope: 'live', itemId: ids[1] },
    });
    await t.controller.start();
    return ids;
  });
}
const box = (l: Locator) =>
  l.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
for (const scale of [100, 150]) {
  test(`one equal-inset slot preserves body geometry and keyboard reorder at ${scale}%`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({
      width: scale === 100 ? 1440 : 800,
      height: 900,
    });
    const ids = await seed(page);
    if (scale === 150)
      await page.addStyleTag({ content: ':root{font-size:24px!important}' });
    const measurements: unknown[] = [];
    await page.mouse.move(0, 0);
    for (const id of ids.slice(0, 2)) {
      const item = card(page, id),
        handle = item.getByRole('button', {
          name: 'Reorder note',
          exact: true,
        });
      const before = await box(item.locator('.note-body'));
      const geometry = await item.evaluate((el) => {
        const outer = el.getBoundingClientRect(),
          handle = el.querySelector('.drag-handle')!.getBoundingClientRect(),
          body = el.querySelector('.note-body')!.getBoundingClientRect();
        return {
          left:
            handle.left -
            outer.left -
            parseFloat(getComputedStyle(el).borderLeftWidth),
          right: body.left - handle.right,
        };
      });
      measurements.push({
        kind: id === ids[0] ? 'note' : 'tree',
        ...geometry,
        body: before,
        slot: await box(handle),
      });
      expect(Math.abs(geometry.left - geometry.right)).toBeLessThanOrEqual(0.1);
      await item.hover();
      await expect(handle).toHaveCSS('opacity', '1');
      expect(await box(item.locator('.note-body'))).toEqual(before);
      if (id === ids[1])
        await expect(item.locator('.note-select')).toHaveCSS('opacity', '0');
      await item.click({ position: { x: 80, y: 15 } });
      await page.mouse.move(0, 0);
      await item.locator('.note-select').focus();
      await page.keyboard.press(
        testInfo.project.name.startsWith('webkit') ? 'Alt+Tab' : 'Tab',
      );
      await expect(handle).toBeFocused();
      await expect(handle).toHaveCSS('outline-style', 'solid');
      if (id === ids[1]) {
        await expect(item.locator('.note-select')).toHaveCSS('opacity', '1');
        await expect(handle.locator('span')).toHaveCSS('opacity', '0');
        await item.locator('.note-select').focus();
        await item.hover();
        await expect(item.locator('.tree-icon')).toHaveCSS(
          'visibility',
          'hidden',
        );
        await expect(handle.locator('span')).toHaveCSS('opacity', '1');
        await page.mouse.move(0, 0);
        await page.keyboard.press(
          testInfo.project.name.startsWith('webkit') ? 'Alt+Tab' : 'Tab',
        );
      }
      expect(await box(item.locator('.note-body'))).toEqual(before);
    }
    const handle = card(page, ids[1]).getByRole('button', {
      name: 'Reorder note',
      exact: true,
    });
    await handle.press('Meta+ArrowUp');
    await expect
      .poll(() =>
        page
          .locator('.note-card')
          .evaluateAll((els) =>
            els.map((el) => el.getAttribute('data-entry-id')),
          ),
      )
      .toEqual([ids[1], ids[0], ids[2]]);
    await expect(handle).toBeFocused();
    await testInfo.attach('slot-geometry', {
      body: JSON.stringify(measurements, null, 2),
      contentType: 'application/json',
    });
    await page.screenshot({ path: testInfo.outputPath(`slot-${scale}.png`) });
  });
  test(`sidebar centers and flat Root surface share one scroll container at ${scale}%`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({
      width: scale === 100 ? 1440 : 800,
      height: 600,
    });
    await seed(page);
    if (scale === 150)
      await page.addStyleTag({ content: ':root{font-size:24px!important}' });
    const centers = await page.locator('.sidebar').evaluate((el) =>
      [
        '.sidebar-search svg',
        '.tree-navigation > button svg',
        '.tree-row .tree-icon',
      ].map((s) => {
        const r = el.querySelector(s)!.getBoundingClientRect();
        return r.left + r.width / 2;
      }),
    );
    expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(
      0.1,
    );
    const home = page.getByRole('button', { name: 'Root', exact: true });
    expect(await home.evaluate((el) => getComputedStyle(el).borderColor)).toBe(
      'rgba(0, 0, 0, 0)',
    );
    expect(
      await page
        .locator('.sidebar')
        .evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft)),
    ).toBe(6);
    for (let i = 0; i < 18; i++) await page.keyboard.press('Meta+n');
    const nav = page.getByRole('navigation', { name: 'Trees' });
    await expect(nav).toHaveCSS('overflow-y', 'visible');
    const deep = page
      .locator('.tree-row')
      .filter({ has: page.locator('.tree-level', { hasText: 'Level 4' }) });
    const primary = await deep.evaluate((el) =>
      ['.tree-expand svg', '.tree-icon', '.tree-name'].map((s) => {
        const r = el.querySelector(s)!.getBoundingClientRect();
        return r.top + r.height / 2;
      }),
    );
    expect(Math.max(...primary) - Math.min(...primary)).toBeLessThanOrEqual(1);
    await page
      .getByRole('button', { name: 'Export backup', exact: true })
      .focus();
    expect(
      await page.locator('.sidebar').evaluate((el) => el.scrollTop),
    ).toBeGreaterThan(0);
    await testInfo.attach('sidebar-geometry', {
      body: JSON.stringify({ centers, primary }, null, 2),
      contentType: 'application/json',
    });
    await page.screenshot({
      path: testInfo.outputPath(`sidebar-${scale}.png`),
    });
  });
}
// Synthetic effect accessors model an incoming OS copy proposal, then exercise real DOM handlers.
// Browser-created transfers do not faithfully retain effectAllowed/dropEffect themselves.
async function owned(p: Page, id: string) {
  await card(p, id)
    .getByRole('button', { name: 'Reorder note', exact: true })
    .evaluate((el) => {
      const transfer = new DataTransfer();
      let effect = 'copy';
      Object.defineProperty(transfer, 'dropEffect', {
        get: () => effect,
        set: (v) => {
          effect = v;
        },
      });
      (window as any).__ownedTransfer = transfer;
      el.dispatchEvent(
        new DragEvent('dragstart', {
          dataTransfer: transfer,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
}
async function over(target: Locator, edge: 'before' | 'after' = 'after') {
  return target.evaluate((el, edge) => {
    const transfer = (window as any).__ownedTransfer as DataTransfer;
    transfer.dropEffect = 'copy';
    const r = el.getBoundingClientRect(),
      event = new DragEvent('dragover', {
        dataTransfer: transfer,
        bubbles: true,
        cancelable: true,
        clientX: r.left + 4,
        clientY: r.top + r.height * (edge === 'after' ? 0.75 : 0.25),
      });
    el.dispatchEvent(event);
    return { effect: transfer.dropEffect, prevented: event.defaultPrevented };
  }, edge);
}
test('owned self, adjacent, nested editor, and background drags reject copy while valid sibling move retains guide', async ({
  page,
}) => {
  const ids = await seed(page);
  await card(page, ids[0]).dblclick();
  await page.evaluate(() => (window as any).__test.controller.flush());
  const before = await page.evaluate(() =>
    structuredClone((window as any).__test.repo.snapshot),
  );
  await owned(page, ids[0]);
  for (const target of [
    card(page, ids[0]),
    card(page, ids[0]).locator('.cm-line'),
    capture(page).locator('.cm-line'),
    page.locator('.note-stream'),
    page.locator('.sidebar'),
    page.locator('.app-header'),
    page.locator('.composer-toolbar'),
  ]) {
    expect(await over(target)).toEqual({ effect: 'none', prevented: true });
    await expect(page.locator('.drop-before,.drop-after')).toHaveCount(0);
  }
  expect(await over(card(page, ids[1]), 'before')).toEqual({
    effect: 'none',
    prevented: true,
  });
  expect(await over(card(page, ids[2]))).toEqual({
    effect: 'move',
    prevented: true,
  });
  await expect(card(page, ids[2])).toHaveClass(/drop-after/);
  expect(await over(capture(page).locator('.cm-line'))).toEqual({
    effect: 'none',
    prevented: true,
  });
  await expect(page.locator('.drop-before,.drop-after')).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      structuredClone((window as any).__test.repo.snapshot),
    ),
  ).toEqual(before);
  await expect(page.getByRole('textbox', { name: 'Edit Markdown' })).toHaveText(
    'first **source**',
  );
});
for (const kind of ['note', 'tree'] as const)
  test(`actual drag starts throughout the revealed ${kind} slot and preserves exact source/ownership`, async ({
    page,
  }) => {
    const ids = await seed(page),
      sourceId = kind === 'note' ? ids[0] : ids[1];
    const before = await page.evaluate(() =>
      structuredClone((window as any).__test.repo.snapshot),
    );
    const source = card(page, sourceId),
      target = card(page, ids[2]);
    await source.hover();
    const bounds = (await target.boundingBox())!;
    await source
      .getByRole('button', { name: 'Reorder note', exact: true })
      .dragTo(target, {
        sourcePosition: { x: 2, y: 2 },
        targetPosition: { x: bounds.width / 2, y: bounds.height * 0.75 },
      });
    await expect
      .poll(() =>
        page
          .locator('.note-card')
          .evaluateAll((els) =>
            els.map((el) => el.getAttribute('data-entry-id')),
          ),
      )
      .toEqual(
        kind === 'note' ? [ids[1], ids[2], ids[0]] : [ids[0], ids[2], ids[1]],
      );
    const after = await page.evaluate(() =>
      structuredClone((window as any).__test.repo.snapshot),
    );
    const content = (s: any) =>
      s.items.map(({ id, markdown, parentId, kind, done, color }: any) => ({
        id,
        markdown,
        parentId,
        kind,
        done,
        color,
      }));
    expect(content(after)).toEqual(content(before));
    expect(after.drafts).toEqual(before.drafts);
    expect(after.undoDeleteIds).toEqual(before.undoDeleteIds);
  });
test('view cancellation keeps owned rejection feedback until dragend without reviving movement authority', async ({
  page,
}) => {
  const ids = await seed(page);
  await owned(page, ids[0]);
  await page.getByRole('searchbox').fill('last');
  await expect(page.locator('.note-card')).toHaveCount(1);
  expect(await over(page.locator('.sidebar'))).toEqual({
    effect: 'none',
    prevented: true,
  });
  await page.getByRole('button', { name: 'Root', exact: true }).click();
  expect(await over(card(page, ids[2]))).toEqual({
    effect: 'none',
    prevented: true,
  });
  const before = await page.evaluate(() =>
    structuredClone((window as any).__test.repo.snapshot),
  );
  await card(page, ids[2]).evaluate((el) => {
    const r = el.getBoundingClientRect();
    el.dispatchEvent(
      new DragEvent('drop', {
        dataTransfer: (window as any).__ownedTransfer,
        bubbles: true,
        cancelable: true,
        clientY: r.bottom - 2,
      }),
    );
  });
  expect(
    await page.evaluate(() =>
      structuredClone((window as any).__test.repo.snapshot),
    ),
  ).toEqual(before);
  await card(page, ids[0])
    .getByRole('button', { name: 'Reorder note', exact: true })
    .dispatchEvent('dragend');
  expect(await over(page.locator('.sidebar'))).toEqual({
    effect: 'copy',
    prevented: false,
  });
});
test('saved fixed color marks selection while editing retains the blue border and source geometry', async ({
  page,
}) => {
  const ids = await seed(page),
    item = card(page, ids[0]);
  await page.evaluate(
    async (id) => (window as any).__test.controller.setItemColor(id, 'pink'),
    ids[0],
  );
  await item.click({ position: { x: 4, y: 4 } });
  const before = await box(item.locator('.note-body'));
  await expect(item).toHaveCSS('border-color', 'rgb(216, 148, 189)');
  await page.keyboard.press('e');
  await expect(item).toHaveCSS('border-color', 'rgb(146, 202, 255)');
  expect(await box(item.locator('.note-body'))).toEqual(before);
  await expect(page.getByRole('textbox', { name: 'Edit Markdown' })).toHaveText(
    'first **source**',
  );
  await page.keyboard.press('Escape');
  await expect(item).toHaveCSS('border-color', 'rgb(216, 148, 189)');
});
