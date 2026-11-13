import { test, expect } from '@playwright/test';

for (const large of [false, true]) {
  test(`Root remains a single destination above a nonfocusable separator at ${large ? '150%' : '100%'}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(
      large ? { width: 800, height: 600 } : { width: 1440, height: 900 },
    );
    await page.goto('/?fixture');
    await page.getByRole('textbox', { name: 'Capture Markdown' }).waitFor();
    if (large)
      await page.addStyleTag({
        content: ':root { font-size: 24px !important }',
      });
    const navigation = page.getByRole('navigation', { name: 'Stashes' });
    const root = navigation.getByRole('button', { name: 'Root', exact: true });
    await expect(root).toHaveAttribute('aria-current', 'page');
    await expect(root).not.toHaveAttribute('aria-expanded');
    await expect(root.locator('svg[aria-hidden="true"]')).toHaveCount(1);
    const separator = navigation.getByRole('separator');
    await expect(separator).toBeVisible();
    const rootBounds = (await root.boundingBox())!;
    const separatorBounds = (await separator.boundingBox())!;
    expect(separatorBounds.y).toBeGreaterThanOrEqual(
      rootBounds.y + rootBounds.height,
    );
    expect(separatorBounds.x).toBe(rootBounds.x);
    expect(separatorBounds.width).toBe(rootBounds.width);
    await page.screenshot({
      path: testInfo.outputPath(`root-${large ? '150' : '100'}.png`),
    });
    expect(
      await separator.evaluate((el) => ({
        previous: el.previousElementSibling?.textContent?.trim(),
        next: el.nextElementSibling,
        tabIndex: (el as HTMLElement).tabIndex,
      })),
    ).toEqual({ previous: 'Root', next: null, tabIndex: -1 });
    await root.focus();
    await page.keyboard.press('Tab');
    await expect(separator).not.toBeFocused();
    await page.keyboard.press('Meta+n');
    await expect(root).toBeVisible();
    await expect(root).not.toHaveAttribute('aria-current');
    await expect(separator).toBeVisible();
    await expect(
      navigation.getByRole('button', {
        name: /^(Expand|Collapse) stash Root$/,
      }),
    ).toHaveCount(0);
    await root.click();
    await expect(root).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('h1')).toHaveText('Root');
    await page.getByRole('searchbox').fill('no matching saved source');
    await expect(root).toBeVisible();
    await page.getByRole('button', { name: 'Trash', exact: true }).click();
    await expect(root).toBeVisible();
    await expect(root).not.toHaveAttribute('aria-current');
    await root.click();
    await expect(root).toHaveAttribute('aria-current', 'page');
  });
}

test('Root separator stays above child rows without intercepting keyboard navigation', async ({
  page,
  browserName,
}) => {
  await page.goto('/?fixture');
  await page.getByRole('textbox', { name: 'Capture Markdown' }).waitFor();
  await page.keyboard.press('Meta+n');
  await page.evaluate(async () => {
    const t = (window as any).__test;
    const id = t.controller.state.stashId;
    t.controller.editContext(id, 'Root child');
    await t.controller.flush();
    t.controller.editSource('saved child');
    await t.controller.save();
  });
  const navigation = page.getByRole('navigation', { name: 'Stashes' });
  const root = navigation.getByRole('button', { name: 'Root', exact: true });
  const child = navigation.getByRole('button', {
    name: 'Open stash Root child',
    exact: true,
  });
  await expect(navigation.getByRole('separator')).toBeVisible();
  expect(
    await navigation
      .getByRole('separator')
      .evaluate((el) => el.nextElementSibling?.classList.contains('stash-row')),
  ).toBe(true);
  await root.focus();
  await expect(root).toBeFocused();
  // WebKit uses Option-Tab to include buttons in sequential keyboard navigation.
  await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab');
  await expect(child).toBeFocused();
  await page
    .getByRole('navigation', { name: 'Breadcrumbs' })
    .getByRole('button', { name: 'Go to Root', exact: true })
    .click();
  await expect(root).toHaveAttribute('aria-current', 'page');
  await child.click();
  await page
    .getByRole('textbox', { name: 'Capture Markdown' })
    .fill('Home fixture bytes');
  await page.keyboard.press('Meta+1');
  await expect(page.locator('h1')).toHaveText('Root');
  await child.click();
  await expect(
    page.getByRole('textbox', { name: 'Capture Markdown' }),
  ).toHaveText('Home fixture bytes');
});

test('M presents Root paths while physical Home and End still stage destinations without writing', async ({
  page,
}) => {
  await page.goto('/?fixture');
  const capture = page.getByRole('textbox', { name: 'Capture Markdown' });
  await capture.fill('Home source bytes');
  await capture.press('Enter');
  await page.getByRole('region', { name: 'Note stream' }).focus();
  await page.keyboard.press('m');
  const dialog = page.getByRole('dialog', { name: 'Move items' });
  await expect(dialog).toContainText('Trash when their parent moves to Root.');
  const root = dialog.getByRole('option', { name: 'Root', exact: true });
  const trash = dialog.getByRole('option', { name: 'Trash', exact: true });
  await page.keyboard.press('End');
  await expect(trash).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Home');
  await expect(root).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      (window as any).__test.repo.snapshot.items.map((x: any) => ({
        markdown: x.markdown,
        parentId: x.parentId,
      })),
    ),
  ).toEqual([{ markdown: 'Home source bytes', parentId: null }]);
});
