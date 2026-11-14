import { test, expect, type Page } from '@playwright/test';
const card = (page: Page) => page.getByRole('article', { name: 'Saved note' });
const stream = (page: Page) =>
  page.getByRole('region', { name: 'Note stream' });
async function capture(page: Page, source = 'Task **source**') {
  const edit = page.getByRole('textbox', { name: 'New note Markdown' });
  await edit.fill(source);
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect(card(page)).toHaveCount(1);
}
test('X toggles once, preserves saved Markdown, stays searchable, and leaves editing legible', async ({
  page,
}) => {
  await page.goto('/?fixture');
  await capture(page);
  await stream(page).focus();
  await page.keyboard.press('x');
  await expect(card(page)).toHaveClass(/done/);
  await expect(
    page.getByRole('button', { name: 'Mark done', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await stream(page).dispatchEvent('keydown', { key: 'x', repeat: true });
  await expect(card(page)).toHaveClass(/done/);
  await page.getByRole('searchbox').fill('source');
  await expect(card(page)).toHaveCount(1);
  await page.getByRole('button', { name: 'Edit note', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Edit Markdown' });
  await expect(editor).toHaveText('Task **source**');
  expect(
    await editor.evaluate((el) => getComputedStyle(el).textDecorationLine),
  ).not.toContain('line-through');
  await editor.press('End');
  await editor.press('x');
  await editor.press('Escape');
  await expect(card(page)).toHaveClass(/done/);
  await page.getByRole('button', { name: 'Mark done', exact: true }).click();
  await expect(card(page)).not.toHaveClass(/done/);
});
test('X leaves typing, IME, DOM ranges, and modifiers alone, and toggles selected containers', async ({
  page,
}) => {
  await page.goto('/?fixture');
  await capture(page);
  await stream(page).focus();
  for (const init of [
    { key: 'x', isComposing: true },
    { key: 'x', altKey: true },
    { key: 'x', metaKey: true },
    { key: 'x', ctrlKey: true },
    { key: 'X', shiftKey: true },
  ])
    await stream(page).dispatchEvent('keydown', init);
  await expect(card(page)).not.toHaveClass(/done/);
  await card(page)
    .locator('.markdown-view')
    .evaluate((el) => {
      const r = document.createRange();
      r.selectNodeContents(el);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(r);
    });
  await stream(page).dispatchEvent('keydown', { key: 'x' });
  await expect(card(page)).not.toHaveClass(/done/);
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await page.getByRole('searchbox').fill('x');
  await expect(page.getByRole('searchbox')).toHaveValue('x');
  await page.getByRole('searchbox').press('Escape');
  await page.keyboard.press('Meta+n');
  // A saved child keeps this destination a tree when it is exited.
  await capture(page, 'container child');
  await page.getByRole('button', { name: 'Root', exact: true }).click();
  const tree = page.locator('.note-card[data-kind="tree"]');
  await tree.locator('.note-body').click();
  await page.keyboard.press('x');
  await expect(tree).toHaveClass(/done/);
});
test('completion failure has its own narrow retry, preserving capture and latest source through delete/Undo/export/restore', async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto('/?fixture');
  await capture(page);
  await page
    .getByRole('textbox', { name: 'New note Markdown' })
    .fill('Pending capture');
  await page.evaluate(() => {
    (window as any).__test.repo.fail = 'completion';
  });
  await stream(page).focus();
  await page.keyboard.press('x');
  await expect(page.getByRole('alert')).toContainText('failure');
  await page.getByRole('button', { name: /^(Show|Hide) Details$/ }).click();
  await expect(
    page.getByRole('region', { name: 'Editor status' }),
  ).toContainText('completion failure');
  await expect(
    page.getByRole('button', { name: 'Retry save', exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() => {
    (window as any).__test.repo.fail = null;
  });
  await page
    .getByRole('button', { name: 'Retry completion', exact: true })
    .click();
  await expect(card(page)).toHaveClass(/done/);
  await expect(card(page)).toHaveCount(1);
  await expect(
    page.getByRole('textbox', { name: 'New note Markdown' }),
  ).toHaveText('Pending capture');
  await page.getByRole('button', { name: /^(Show|Hide) Details$/ }).click();
  await page.getByRole('button', { name: 'Edit note', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Edit Markdown' })
    .fill('latest **exact** source');
  await page.getByRole('textbox', { name: 'Edit Markdown' }).press('Escape');
  await page.keyboard.press('Meta+Backspace');
  await expect(card(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo delete', exact: true }).click();
  await expect(card(page)).toHaveClass(/done/);
  await page
    .getByRole('button', { name: 'Export backup', exact: true })
    .click();
  await page.evaluate(() => {
    const t = (window as any).__test;
    const b = JSON.parse(t.repo.exported);
    if (b.version !== 7 || b.library.items[0].done !== true)
      throw Error('completion absent');
    t.repo.restoreText = t.repo.exported;
  });
  await page
    .getByRole('button', { name: 'Restore backup', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Replace library', exact: true })
    .click();
  await expect(card(page)).toHaveClass(/done/);
  await expect(card(page)).toContainText('latest exact source');
});

test('source-flush failure retains visible source and completion-specific retry without focus theft', async ({
  page,
}) => {
  await page.goto('/?fixture');
  await capture(page);
  await page.getByRole('button', { name: 'Edit note', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Edit Markdown' });
  await editor.fill('Latest **source**');
  await page.evaluate(() => {
    (window as any).__test.repo.fail = 'save';
  });
  await stream(page).focus();
  await page.keyboard.press('x');
  await expect(
    page.getByRole('button', { name: 'Retry completion', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Editor status' }),
  ).toContainText('save failure');
  await expect(editor).toHaveText('Latest **source**');
  await expect(card(page)).not.toHaveClass(/done/);
  await page.evaluate(() => {
    (window as any).__test.repo.fail = null;
  });
  await page
    .getByRole('button', { name: 'Retry completion', exact: true })
    .click();
  await expect(card(page)).toHaveClass(/done/);
  await expect(editor).toHaveText('Latest **source**');
  expect(
    await page.evaluate(
      () =>
        (window as any).__test.repo.snapshot.items.filter(
          (x: any) => x.kind === 'note',
        )[0].markdown,
    ),
  ).toBe('Latest **source**');
});
test('completion acknowledgment retains newer search focus, query, and capture context', async ({
  page,
}) => {
  await page.goto('/?fixture');
  await capture(page);
  await page.evaluate(() => {
    const t = (window as any).__test;
    t.delay();
    t.controller.editContext(
      t.repo.snapshot.items.filter((x: any) => x.kind === 'note')[0].id,
      'Latest pending source',
    );
  });
  await stream(page).focus();
  await page.keyboard.press('x');
  await page.getByRole('searchbox').fill('Latest');
  await page.evaluate(() => (window as any).__test.release());
  await expect(card(page)).toHaveClass(/done/);
  await expect(page.getByRole('searchbox')).toBeFocused();
  await expect(page.getByRole('searchbox')).toHaveValue('Latest');
  expect(
    await page.evaluate(
      () =>
        (window as any).__test.repo.snapshot.items.filter(
          (x: any) => x.kind === 'note',
        )[0].markdown,
    ),
  ).toBe('Latest pending source');
});
for (const scale of [100, 150])
  test(`completion synthetic ${scale}% evidence preserves card geometry and legible source`, async ({
    page,
  }) => {
    await page.setViewportSize({
      width: scale === 100 ? 1440 : 800,
      height: 900,
    });
    await page.goto('/?fixture&visual');
    if (scale === 150)
      await page.addStyleTag({ content: 'html{font-size:150%}' });
    const first = card(page).first();
    await first.locator('.note-body').click();
    const before = await first.boundingBox();
    await page.keyboard.press('x');
    await expect(first).toHaveClass(/done/);
    const after = await first.boundingBox();
    expect(after?.height).toBe(before?.height);
    await page.screenshot({
      path: `test-results/captures/completion/task3-completed-${scale}.png`,
    });
    await first.getByRole('button', { name: 'Edit note', exact: true }).click();
    await expect(
      page.getByRole('textbox', { name: 'Edit Markdown' }),
    ).toContainText('Markdown stays **bold**');
    await page.screenshot({
      path: `test-results/captures/completion/task3-editing-${scale}.png`,
    });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(scale === 100 ? 1440 : 800);
  });

test('stable toggle label preserves pressed state, next-action title, Space activation, and X', async ({
  page,
}) => {
  await page.goto('/?fixture');
  await capture(page);
  const toggle = page.getByRole('button', { name: 'Mark done', exact: true });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(toggle).toHaveAttribute('title', 'Mark done (X)');
  const before = await card(page).boundingBox();
  await toggle.focus();
  await toggle.press('Space');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle).toHaveAttribute('title', 'Mark not done (X)');
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAccessibleName('Mark done');
  expect((await card(page).boundingBox())?.height).toBe(before?.height);
  await stream(page).focus();
  await page.keyboard.press('x');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(toggle).toHaveAccessibleName('Mark done');
  await expect(stream(page)).toBeFocused();
});
