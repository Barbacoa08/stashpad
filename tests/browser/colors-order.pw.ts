import { test, expect, type Page } from '@playwright/test';
const stream = (p: Page) => p.getByRole('region', { name: 'Note stream' });
const card = (p: Page, id: string) => p.locator(`[data-entry-id="${id}"]`);
const capture = (p: Page) =>
  p.getByRole('textbox', { name: 'Capture Markdown' });
async function seed(p: Page) {
  await p.goto('/?fixture');
  await capture(p).waitFor();
  return p.evaluate(async () => {
    const t = (window as any).__test;
    const ids = Array.from({ length: 6 }, () => crypto.randomUUID());
    for (const [i, markdown] of [
      'first **source**',
      'parent',
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
    for (const i of [4, 5])
      await t.repo.captureItem({
        id: ids[i],
        location: { scope: 'live', itemId: ids[1] },
        markdown: `child ${i}`,
        draft: { key: `compose:${ids[1]}`, revision: 0 },
      });
    await t.controller.start();
    return ids;
  });
}
async function order(p: Page) {
  return p
    .locator('.note-card')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-entry-id')));
}
async function snapshot(p: Page) {
  return p.evaluate(() =>
    structuredClone((window as any).__test.repo.snapshot),
  );
}

test('named color palette applies and resets without moving source, with keyboard and focus return', async ({
  page,
}) => {
  const ids = await seed(page);
  await card(page, ids[0]).click();
  const before = await card(page, ids[0]).locator('.note-body').boundingBox();
  await page.keyboard.press('l');
  const palette = page.getByRole('dialog', { name: 'Assign color' });
  await expect(palette).toBeVisible();
  await expect(
    palette.getByRole('radio', { name: 'Reset', exact: true }),
  ).toBeChecked();
  await palette
    .getByRole('radio', { name: 'Blue', exact: true })
    .press('Space');
  await expect(palette).toBeVisible();
  await palette.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(palette).toHaveCount(0);
  await expect(stream(page)).toBeFocused();
  expect(
    (await snapshot(page)).items.find((x: any) => x.id === ids[0]).color,
  ).toBe('blue');
  expect(await card(page, ids[0]).locator('.note-body').boundingBox()).toEqual(
    before,
  );
  await page.keyboard.press('l');
  await expect(
    palette.getByRole('radio', { name: 'Blue', exact: true }),
  ).toBeChecked();
  await page.keyboard.press('Escape');
  await expect(stream(page)).toBeFocused();
  await page.getByRole('button', { name: 'Assign color', exact: true }).click();
  await palette.getByRole('radio', { name: 'Reset', exact: true }).click();
  expect(
    (await snapshot(page)).items.find((x: any) => x.id === ids[0]).color,
  ).toBeNull();
  await expect(card(page, ids[0]).locator('.note-color')).toHaveCount(0);
});

test('Command arrows move mixed siblings and preserve selection, children, source, and boundary timestamps', async ({
  page,
}) => {
  const ids = await seed(page);
  const before = await snapshot(page);
  await card(page, ids[1]).click();
  await page.keyboard.press('Meta+ArrowUp');
  await expect.poll(() => order(page)).toEqual([ids[1], ids[0], ids[2]]);
  await expect(card(page, ids[1])).toHaveClass(/selected/);
  await expect(stream(page)).toBeFocused();
  const moved = await snapshot(page);
  for (const id of [ids[0], ids[2], ids[3], ids[4], ids[5]])
    expect(moved.items.find((x: any) => x.id === id).updatedAt).toBe(
      before.items.find((x: any) => x.id === id).updatedAt,
    );
  expect(moved.items.filter((x: any) => x.parentId === ids[1])).toEqual(
    before.items.filter((x: any) => x.parentId === ids[1]),
  );
  await page.evaluate(() => {
    (window as any).__test.repo.fail = 'reorder';
  });
  await page.keyboard.press('Meta+ArrowUp');
  expect(await snapshot(page)).toEqual(moved);
  await expect(
    page.getByRole('button', { name: 'Retry action', exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() => {
    (window as any).__test.repo.fail = null;
  });
  await page.keyboard.press('Meta+ArrowDown');
  await expect.poll(() => order(page)).toEqual([ids[0], ids[1], ids[2]]);
});

test('native radios browse with arrows, keep focus, expose current color, and Tab leaves the nonmodal palette', async ({
  page,
}) => {
  const ids = await seed(page);
  await card(page, ids[0]).click();
  await page.keyboard.press('l');
  const palette = page.getByRole('dialog', { name: 'Assign color' });
  await expect(
    palette.getByRole('radio', { name: 'Reset', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(
    palette.getByRole('radio', { name: 'Red', exact: true }),
  ).toBeChecked();
  await expect(
    palette.getByRole('radio', { name: 'Red', exact: true }),
  ).toBeFocused();
  await expect
    .poll(
      async () =>
        (await snapshot(page)).items.find((x: any) => x.id === ids[0]).color,
    )
    .toBe('red');
  await page.keyboard.press('ArrowRight');
  await expect(
    palette.getByRole('radio', { name: 'Orange', exact: true }),
  ).toBeFocused();
  await expect
    .poll(
      async () =>
        (await snapshot(page)).items.find((x: any) => x.id === ids[0]).color,
    )
    .toBe('orange');
  await page.keyboard.press('Tab');
  await expect(
    palette.getByRole('button', { name: 'Done', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(stream(page)).toBeFocused();
});

test('L and reorder guards preserve typing, selections, IME, repeats, modifiers, and normal editor Command arrows', async ({
  page,
}) => {
  const ids = await seed(page);
  await card(page, ids[0]).click();
  for (const init of [
    { key: 'l', isComposing: true },
    { key: 'l', repeat: true },
    { key: 'l', altKey: true },
    { key: 'l', ctrlKey: true },
    { key: 'l', metaKey: true },
    { key: 'L', shiftKey: true },
  ])
    await stream(page).dispatchEvent('keydown', init);
  await expect(page.getByRole('dialog', { name: 'Assign color' })).toHaveCount(
    0,
  );
  await card(page, ids[0])
    .locator('.markdown-view')
    .evaluate((el) => {
      const r = document.createRange();
      r.selectNodeContents(el);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(r);
    });
  await stream(page).dispatchEvent('keydown', { key: 'l' });
  await stream(page).dispatchEvent('keydown', {
    key: 'ArrowDown',
    metaKey: true,
  });
  await expect(page.getByRole('dialog', { name: 'Assign color' })).toHaveCount(
    0,
  );
  expect(await order(page)).toEqual(ids.slice(0, 3));
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  for (const init of [
    { key: 'ArrowDown', metaKey: true, repeat: true },
    { key: 'ArrowDown', metaKey: true, isComposing: true },
    { key: 'ArrowDown', metaKey: true, altKey: true },
  ])
    await stream(page).dispatchEvent('keydown', init);
  expect(await order(page)).toEqual(ids.slice(0, 3));
  await page.keyboard.press('e');
  const editor = page.getByRole('textbox', { name: 'Edit Markdown' });
  await editor.press('Meta+ArrowDown');
  await expect(editor).toBeFocused();
  expect(await order(page)).toEqual(ids.slice(0, 3));
  await editor.press('l');
  await expect(page.getByRole('dialog', { name: 'Assign color' })).toHaveCount(
    0,
  );
});

test('color failure retries the captured target and keeps latest source and capture intact after selection changes', async ({
  page,
}) => {
  const ids = await seed(page);
  await capture(page).fill('pending capture');
  await card(page, ids[0]).dblclick();
  await page
    .getByRole('textbox', { name: 'Edit Markdown' })
    .fill('latest\n**exact**');
  await page.evaluate(() => {
    (window as any).__test.repo.fail = 'save';
  });
  await stream(page).focus();
  await page.keyboard.press('l');
  const palette = page.getByRole('dialog', { name: 'Assign color' });
  await palette.getByRole('radio', { name: 'Purple', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Retry action', exact: true }),
  ).toBeVisible();
  await expect(
    palette.getByRole('radio', { name: 'Reset', exact: true }),
  ).toBeChecked();
  await palette.getByRole('button', { name: 'Done', exact: true }).click();
  await card(page, ids[2]).click();
  await page.evaluate(() => {
    (window as any).__test.repo.fail = null;
  });
  await page.getByRole('button', { name: 'Retry action', exact: true }).click();
  const s = await snapshot(page);
  expect(s.items.find((x: any) => x.id === ids[0])).toMatchObject({
    color: 'purple',
    markdown: 'latest\n**exact**',
  });
  expect(s.items.find((x: any) => x.id === ids[2]).color).toBeNull();
  expect(s.items).toHaveLength(6);
  await expect(capture(page)).toHaveText('pending capture');
});

test('color source-flush acknowledgment keeps captured target while newer Search owns focus', async ({
  page,
}) => {
  const ids = await seed(page);
  await card(page, ids[0]).click();
  await page.evaluate((id) => {
    const t = (window as any).__test;
    t.delay();
    t.controller.editContext(id, 'pending exact source');
  }, ids[0]);
  await page.keyboard.press('l');
  await page.getByRole('radio', { name: 'Teal', exact: true }).click();
  await page.getByRole('searchbox').fill('parent');
  await page.evaluate(() => (window as any).__test.release());
  await expect
    .poll(
      async () =>
        (await snapshot(page)).items.find((x: any) => x.id === ids[0]).color,
    )
    .toBe('teal');
  await expect(page.getByRole('searchbox')).toBeFocused();
  await expect(page.getByRole('searchbox')).toHaveValue('parent');
  expect(
    (await snapshot(page)).items.find((x: any) => x.id === ids[0]).markdown,
  ).toBe('pending exact source');
});

async function drag(
  p: Page,
  from: string,
  to: string,
  edge: 'before' | 'after',
  drop = true,
) {
  const dataTransfer = await p.evaluateHandle(() => new DataTransfer());
  await card(p, from)
    .getByRole('button', { name: 'Reorder item', exact: true })
    .dispatchEvent('dragstart', { dataTransfer });
  const box = (await card(p, to).boundingBox())!;
  const clientY = edge === 'before' ? box.y + 1 : box.y + box.height - 1;
  await card(p, to).dispatchEvent('dragover', { dataTransfer, clientY });
  if (drop) await card(p, to).dispatchEvent('drop', { dataTransfer, clientY });
  return { dataTransfer, clientY };
}

test('owned handle drag uses before/after final indices, keeps descendants, rejects foreign payloads and clears cancellation', async ({
  page,
}) => {
  const ids = await seed(page);
  const before = await snapshot(page);
  await drag(page, ids[0], ids[2], 'after');
  await expect.poll(() => order(page)).toEqual([ids[1], ids[2], ids[0]]);
  await expect(card(page, ids[0])).toHaveClass(/selected/);
  expect(
    (await snapshot(page)).items.filter((x: any) => x.parentId === ids[1]),
  ).toEqual(before.items.filter((x: any) => x.parentId === ids[1]));
  const moved = await snapshot(page);
  for (const payload of ['foreign', 'file', 'url']) {
    const dt = await page.evaluateHandle((kind) => {
      const dt = new DataTransfer();
      if (kind === 'file') dt.items.add(new File(['x'], 'x.txt'));
      else
        dt.setData(
          kind === 'url' ? 'text/uri-list' : 'application/x-stashpad-sibling',
          'foreign',
        );
      return dt;
    }, payload);
    await card(page, ids[2]).dispatchEvent('drop', { dataTransfer: dt });
    expect(await snapshot(page)).toEqual(moved);
  }
  const pending = await drag(page, ids[0], ids[1], 'before', false);
  await expect(card(page, ids[1])).toHaveClass(/drop-before/);
  await card(page, ids[0])
    .getByRole('button', { name: 'Reorder item', exact: true })
    .dispatchEvent('dragend');
  await expect(page.locator('.drop-before,.drop-after')).toHaveCount(0);
  await card(page, ids[1]).dispatchEvent('drop', {
    dataTransfer: pending.dataTransfer,
    clientY: pending.clientY,
  });
  expect(await snapshot(page)).toEqual(moved);
  await drag(page, ids[0], ids[1], 'before');
  await expect.poll(() => order(page)).toEqual(ids.slice(0, 3));
});

test('moves child and Trash sibling groups, preserves handle focus, flushes edit, and never reorders search', async ({
  page,
}) => {
  const ids = await seed(page);
  await card(page, ids[1]).click();
  await page.keyboard.press('ArrowRight');
  await card(page, ids[4]).dblclick();
  await page
    .getByRole('textbox', { name: 'Edit Markdown' })
    .fill('child latest **source**');
  const handle = card(page, ids[4]).getByRole('button', {
    name: 'Reorder item',
    exact: true,
  });
  await handle.focus();
  await handle.press('Meta+ArrowUp');
  await expect.poll(() => order(page)).toEqual([ids[4], ids[3], ids[5]]);
  await expect(handle).toBeFocused();
  expect(
    (await snapshot(page)).items.find((x: any) => x.id === ids[4]),
  ).toMatchObject({ parentId: ids[1], markdown: 'child latest **source**' });
  await page.getByRole('searchbox').fill('child');
  await card(page, ids[4]).click();
  const before = await snapshot(page);
  await page.keyboard.press('Meta+ArrowDown');
  expect(await snapshot(page)).toEqual(before);
  await expect(
    page.getByRole('region', { name: 'Workspace status' }),
  ).toContainText('Open the containing stash');
  await expect(
    page.getByRole('button', { name: 'Reorder item', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await card(page, ids[1]).click();
  await page.keyboard.press('Meta+Backspace');
  await card(page, ids[0]).click();
  await page.keyboard.press('Meta+Backspace');
  await page.getByRole('button', { name: 'Trash', exact: true }).click();
  await card(page, ids[0]).click();
  await page.keyboard.press('Meta+ArrowUp');
  await expect.poll(() => order(page)).toEqual([ids[0], ids[1]]);
  await card(page, ids[1]).click();
  await page.keyboard.press('ArrowRight');
  await card(page, ids[5]).click();
  await page.keyboard.press('Meta+ArrowUp');
  await expect.poll(() => order(page)).toEqual([ids[4], ids[5], ids[3]]);
});

test('move failure retries original destination after selection changes, without capture or focus theft on newer Search', async ({
  page,
}) => {
  const ids = await seed(page);
  await capture(page).fill('pending capture');
  await card(page, ids[0]).click();
  await page.evaluate(() => {
    (window as any).__test.repo.fail = 'reorder';
  });
  await page.keyboard.press('Meta+ArrowDown');
  await expect(
    page.getByRole('button', { name: 'Retry action', exact: true }),
  ).toBeVisible();
  await card(page, ids[2]).click();
  await page.evaluate(() => {
    (window as any).__test.repo.fail = null;
  });
  await page.getByRole('button', { name: 'Retry action', exact: true }).click();
  await expect.poll(() => order(page)).toEqual([ids[1], ids[0], ids[2]]);
  await expect(capture(page)).toHaveText('pending capture');
  await card(page, ids[0]).click();
  await page.evaluate((id) => {
    const t = (window as any).__test;
    t.delay();
    t.controller.editContext(id, 'source awaiting move');
  }, ids[0]);
  await page.keyboard.press('Meta+ArrowDown');
  await page.getByRole('searchbox').fill('parent');
  await page.evaluate(() => (window as any).__test.release());
  await expect
    .poll(
      async () =>
        (await snapshot(page)).items.find((x: any) => x.id === ids[0]).position,
    )
    .toBe(2);
  await expect(page.getByRole('searchbox')).toBeFocused();
  await expect(page.getByRole('searchbox')).toHaveValue('parent');
  expect((await snapshot(page)).items).toHaveLength(6);
});

test('drag identity is handle-only, rejects cross-parent and cross-scope reuse after navigation, and supports actual browser dragging', async ({
  page,
}) => {
  const ids = await seed(page);
  const noHandle = await page.evaluateHandle(() => new DataTransfer());
  await card(page, ids[0]).dispatchEvent('dragstart', {
    dataTransfer: noHandle,
  });
  await card(page, ids[2]).dispatchEvent('drop', { dataTransfer: noHandle });
  expect(await order(page)).toEqual(ids.slice(0, 3));
  const active = await drag(page, ids[0], ids[2], 'after', false);
  await page
    .getByRole('button', { name: 'Open stash parent', exact: true })
    .click();
  const before = await snapshot(page);
  await card(page, ids[5]).dispatchEvent('drop', {
    dataTransfer: active.dataTransfer,
  });
  expect(await snapshot(page)).toEqual(before);
  await expect(page.locator('.drop-before,.drop-after')).toHaveCount(0);
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  const pending = await drag(page, ids[0], ids[2], 'after', false);
  await card(page, ids[1]).click();
  await page.keyboard.press('Meta+Backspace');
  await page.getByRole('button', { name: 'Trash', exact: true }).click();
  const trashed = await snapshot(page);
  await card(page, ids[1]).dispatchEvent('drop', {
    dataTransfer: pending.dataTransfer,
  });
  expect(await snapshot(page)).toEqual(trashed);
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  const source = card(page, ids[0]).getByRole('button', {
    name: 'Reorder item',
    exact: true,
  });
  const target = card(page, ids[2]);
  await target.hover();
  const box = (await target.boundingBox())!;
  await source.dragTo(target, {
    targetPosition: { x: box.width / 2, y: box.height * 0.75 },
  });
  await expect.poll(() => order(page)).toEqual([ids[2], ids[0]]);
});

test('marker metadata survives done, promotion, Trash, Restore, and strict backup replacement', async ({
  page,
}) => {
  const ids = await seed(page);
  await card(page, ids[0]).click();
  await page.keyboard.press('l');
  await page.getByRole('radio', { name: 'Pink', exact: true }).click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.keyboard.press('x');
  await page.keyboard.press('ArrowRight');
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await expect(card(page, ids[0]).locator('.stash-icon')).toHaveCSS(
    'color',
    'rgb(216, 148, 189)',
  );
  await expect(
    page
      .getByRole('button', { name: 'Open stash first **source**', exact: true })
      .locator('.stash-icon'),
  ).toHaveCSS('color', 'rgb(216, 148, 189)');
  await card(page, ids[0]).click();
  await page.keyboard.press('Meta+Backspace');
  await page.getByRole('button', { name: 'Trash', exact: true }).click();
  await card(page, ids[0]).click();
  await expect(card(page, ids[0])).toHaveClass(/done/);
  await page.getByRole('button', { name: 'Restore item', exact: true }).click();
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await page
    .getByRole('button', { name: 'Export backup', exact: true })
    .click();
  const before = await snapshot(page);
  await page.evaluate(() => {
    const t = (window as any).__test;
    t.repo.restoreText = t.repo.exported;
  });
  await page
    .getByRole('button', { name: 'Restore backup', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Replace workspace', exact: true })
    .click();
  expect(await snapshot(page)).toEqual(before);
  await expect(card(page, ids[0]).locator('.stash-icon')).toHaveCSS(
    'color',
    'rgb(216, 148, 189)',
  );
});

for (const scale of [100, 150])
  test(`synthetic ${scale}% palette, markers, drag guides, and held hints retain geometry and accessible focus`, async ({
    page,
  }) => {
    await page.setViewportSize({
      width: scale === 100 ? 1440 : 800,
      height: 900,
    });
    const ids = await seed(page);
    if (scale === 150)
      await page.addStyleTag({ content: ':root{font-size:24px !important}' });
    await expect(page.locator('html')).toHaveCSS(
      'font-size',
      scale === 150 ? '24px' : '16px',
    );
    await card(page, ids[0]).click();
    const before = await card(page, ids[0]).locator('.note-body').boundingBox();
    if (scale === 150)
      await page.getByRole('button', { name: 'Details', exact: true }).click();
    await page
      .getByRole('button', { name: 'Assign color', exact: true })
      .click();
    await expect(
      page.getByRole('radio', { name: 'Reset', exact: true }),
    ).toBeFocused();
    await page.getByRole('radio', { name: 'Blue', exact: true }).click();
    await expect(
      page.getByRole('radio', { name: 'Blue', exact: true }),
    ).toBeChecked();
    await page.screenshot({
      path: `test-results/captures/colors-order/colors-order-palette-${scale}.png`,
    });
    await page.keyboard.press('Escape');
    await expect(
      page.getByRole('button', { name: 'Assign color', exact: true }),
    ).toBeFocused();
    if (scale === 150)
      await page.getByRole('button', { name: 'Details', exact: true }).click();
    expect(
      await card(page, ids[0]).locator('.note-body').boundingBox(),
    ).toEqual(before);
    await card(page, ids[0]).click();
    await page.keyboard.press('x');
    await page.keyboard.press('e');
    await expect(
      page.getByRole('textbox', { name: 'Edit Markdown' }),
    ).toContainText('first **source**');
    await page.screenshot({
      path: `test-results/captures/colors-order/colors-order-editing-${scale}.png`,
    });
    await page.getByRole('textbox', { name: 'Edit Markdown' }).press('Escape');
    const beforeHints = await card(page, ids[0]).boundingBox();
    await page.keyboard.down('Meta');
    await page.screenshot({
      path: `test-results/captures/colors-order/colors-order-hints-${scale}.png`,
    });
    expect(await card(page, ids[0]).boundingBox()).toEqual(beforeHints);
    await page.keyboard.up('Meta');
    await expect(page.locator('.command-hint')).toHaveCount(0);
    await drag(page, ids[0], ids[2], 'after', false);
    await expect(card(page, ids[2])).toHaveClass(/drop-after/);
    await page.screenshot({
      path: `test-results/captures/colors-order/colors-order-guide-${scale}.png`,
    });
    await card(page, ids[0])
      .getByRole('button', { name: 'Reorder item', exact: true })
      .dispatchEvent('dragend');
    await page.keyboard.press('Meta+Backspace');
    await page.getByRole('button', { name: 'Trash', exact: true }).click();
    await card(page, ids[0]).click();
    await page.keyboard.press('l');
    await expect(
      page.getByRole('radio', { name: 'Blue', exact: true }),
    ).toBeChecked();
    await page.screenshot({
      path: `test-results/captures/colors-order/colors-order-trash-${scale}.png`,
    });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(scale === 100 ? 1440 : 800);
  });

// Final-panel regression: held hints describe the existing shortcut guards.
test('held Command hides unavailable stream actions with no selected entry', async ({
  page,
}) => {
  await seed(page);
  await stream(page).focus();
  await page.keyboard.down('Meta');
  await expect(page.locator('.stream-command-hint')).toHaveText('⌘N New stash');
  await expect(page.locator('.home-command-hint')).toBeVisible();
  await page.keyboard.up('Meta');
  await expect(page.locator('.command-hint')).toHaveCount(0);
});

test('held Command updates stream hints on editor, Search, control, selection, and stream focus changes', async ({
  page,
}) => {
  const ids = await seed(page);
  await card(page, ids[1]).click();
  const before = await snapshot(page);
  await page.keyboard.press('e');
  const editor = page.getByRole('textbox', { name: 'Edit Markdown' });
  await expect(editor).toBeFocused();
  await page.keyboard.down('Meta');
  const hints = page.locator('.stream-command-hint');
  await expect(hints).toHaveText('⌘N New stash');
  await page.getByRole('searchbox').focus();
  await expect(hints).toHaveText('⌘N New stash');
  await stream(page).focus();
  await expect(hints).toHaveText('⌘N New stash · ⌘↑/↓ Reorder · ⌘⌫ Delete');
  await page
    .getByRole('button', { name: 'Export backup', exact: true })
    .focus();
  await expect(hints).toHaveText('⌘N New stash');
  await card(page, ids[0])
    .getByRole('button', { name: 'Reorder item', exact: true })
    .focus();
  await expect(hints).toHaveText('⌘N New stash · ⌘↓ Reorder');
  await stream(page).focus();
  await expect(hints).toContainText('Delete');
  await card(page, ids[1])
    .locator('.markdown-view')
    .evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
    });
  await expect(hints).toHaveText('⌘N New stash');
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await expect(hints).toContainText('Reorder');
  await page.keyboard.up('Meta');
  expect(await snapshot(page)).toEqual(before);
});

test('held Command advertises only possible sibling directions, no singleton or search reorder', async ({
  page,
}) => {
  const ids = await seed(page);
  const hints = page.locator('.stream-command-hint');
  for (const [index, keys] of ['⌘↓', '⌘↑/↓', '⌘↑'].entries()) {
    await card(page, ids[index]).click();
    await page.keyboard.down('Meta');
    await expect(hints).toHaveText(
      `⌘N New stash · ${keys} Reorder · ⌘⌫ Delete`,
    );
    await page.keyboard.up('Meta');
  }
  await page.getByRole('searchbox').fill('source');
  await card(page, ids[0]).click();
  await page.keyboard.down('Meta');
  await expect(hints).toHaveText('⌘N New stash · ⌘⌫ Delete');
  await page.keyboard.up('Meta');
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await card(page, ids[2]).click();
  await page.keyboard.press('ArrowRight');
  await capture(page).fill('only child');
  await capture(page).press('Enter');
  await stream(page).focus();
  await page.keyboard.down('Meta');
  await expect(hints).toHaveText('⌘N New stash · ⌘⌫ Delete');
  await page.keyboard.up('Meta');
});

for (const scale of [100, 150])
  test(`final-fix held Command available and unavailable hints preserve geometry at ${scale}%`, async ({
    page,
  }) => {
    await page.setViewportSize({
      width: scale === 100 ? 1440 : 800,
      height: 900,
    });
    const ids = await seed(page);
    if (scale === 150)
      await page.addStyleTag({ content: ':root{font-size:24px !important}' });
    await expect(page.locator('html')).toHaveCSS(
      'font-size',
      scale === 150 ? '24px' : '16px',
    );
    await card(page, ids[1]).click();
    const geometry = async () =>
      Promise.all([
        stream(page).boundingBox(),
        card(page, ids[1]).boundingBox(),
        page.locator('.stream-header').boundingBox(),
        capture(page).boundingBox(),
      ]);
    const before = await geometry();
    await page.keyboard.down('Meta');
    await expect(page.locator('.stream-command-hint')).toContainText('Reorder');
    expect(await geometry()).toEqual(before);
    await page.screenshot({
      path: `test-results/captures/final-fix/final-fix-available-${scale}.png`,
    });
    await page.getByRole('searchbox').focus();
    await expect(page.locator('.stream-command-hint')).toHaveText(
      '⌘N New stash',
    );
    expect(await geometry()).toEqual(before);
    await page.screenshot({
      path: `test-results/captures/final-fix/final-fix-unavailable-${scale}.png`,
    });
    await page.keyboard.up('Meta');
    await expect(page.locator('.command-hint')).toHaveCount(0);
    expect(await geometry()).toEqual(before);
    await page.keyboard.down('Meta');
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await expect(page.locator('.command-hint')).toHaveCount(0);
    await page.keyboard.up('Meta');
    await page.keyboard.down('Meta');
    await page.evaluate(() =>
      document.dispatchEvent(new Event('visibilitychange')),
    );
    await expect(page.locator('.command-hint')).toHaveCount(0);
    await page.keyboard.up('Meta');
  });

test('held hint focus observation tolerates focused-control removal and reordering without runtime errors', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  const ids = await seed(page);
  await card(page, ids[1]).click();
  await page.keyboard.press('l');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(stream(page)).toBeFocused();
  const handle = card(page, ids[1]).getByRole('button', {
    name: 'Reorder item',
    exact: true,
  });
  await handle.focus();
  await handle.press('Meta+ArrowUp');
  await expect.poll(() => order(page)).toEqual([ids[1], ids[0], ids[2]]);
  await expect(handle).toBeFocused();
  await card(page, ids[0]).click();
  await page.evaluate((id) => {
    const t = (window as any).__test;
    t.delay();
    t.controller.editContext(id, 'source during palette removal');
  }, ids[0]);
  await page.keyboard.press('l');
  await page.getByRole('radio', { name: 'Teal', exact: true }).click();
  await page.getByRole('searchbox').fill('parent');
  await page.evaluate(() => (window as any).__test.release());
  await expect
    .poll(
      async () =>
        (await snapshot(page)).items.find((x: any) => x.id === ids[0]).color,
    )
    .toBe('teal');
  await expect(page.getByRole('searchbox')).toBeFocused();
  expect(errors).toEqual([]);
});
