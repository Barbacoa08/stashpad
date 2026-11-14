import { expect, test } from '@playwright/test';

for (const large of [false, true]) {
  test(`sidebar search reserves focus geometry at ${large ? '150%' : '100%'}`, async ({
    page,
  }) => {
    await page.setViewportSize(
      large ? { width: 800, height: 600 } : { width: 1440, height: 900 },
    );
    await page.goto('/?fixture');
    await page.getByRole('textbox', { name: 'New note Markdown' }).waitFor();
    if (large)
      await page.addStyleTag({
        content: ':root { font-size: 24px !important }',
      });
    const sidebar = page.getByRole('complementary', {
      name: 'Editor navigation',
    });
    const search = page.getByRole('searchbox', { name: 'Search saved notes' });
    const wrapper = sidebar.locator('.sidebar-search');
    const measure = () =>
      wrapper.evaluate((el) => {
        const input = el.querySelector('input')!;
        const icon = el.querySelector('svg')!;
        const home = el.parentElement!.querySelector('nav button')!;
        const rect = (e: Element) => {
          const r = e.getBoundingClientRect();
          return [r.x, r.y, r.width, r.height];
        };
        const placeholder = getComputedStyle(input, '::placeholder');
        return {
          wrapper: rect(el),
          input: rect(input),
          icon: rect(icon),
          home: rect(home),
          placeholder: {
            color: placeholder.color,
            opacity: placeholder.opacity,
            display: placeholder.display,
          },
        };
      });
    const before = await measure();
    if (!large) {
      const titlebar = await page.locator('.app-header').boundingBox();
      // The unified title strip reserves the native-safe top row for all columns.
      expect(
        before.wrapper[1] - (titlebar!.y + titlebar!.height),
      ).toBeLessThanOrEqual(8);
      expect(before.wrapper[1]).toBeGreaterThanOrEqual(
        titlebar!.y + titlebar!.height,
      );
    }
    await search.focus();
    const focused = await measure();
    expect(focused).toEqual(before);
    expect(focused.placeholder.opacity).not.toBe('0');
    expect(focused.placeholder.color).not.toBe('rgba(0, 0, 0, 0)');
    expect(focused.placeholder.display).not.toBe('none');
    expect(
      await wrapper.evaluate((el) => getComputedStyle(el).borderColor),
    ).not.toBe('rgba(0, 0, 0, 0)');
    expect(
      await search.evaluate((el) => getComputedStyle(el).outlineStyle),
    ).toBe('none');
    await search.fill('example');
    expect((await measure()).wrapper).toEqual(before.wrapper);
    await search.fill('');
    await search.blur();
    expect(await measure()).toEqual(before);
    await expect(
      sidebar.getByRole('button', { name: 'New tree', exact: true }),
    ).toHaveCount(0);
    await expect(
      sidebar.getByRole('button', { name: 'New note', exact: true }),
    ).toHaveCount(0);
    await expect(page.getByLabel('Keyboard shortcuts')).toContainText(
      'New tree',
    );
    await expect(page.getByLabel('Keyboard shortcuts')).toContainText('Space');
  });
}

for (const large of [false, true]) {
  test(`sidebar icons and labels align at ${large ? '150%' : '100%'}`, async ({
    page,
  }) => {
    await page.setViewportSize(
      large ? { width: 800, height: 600 } : { width: 1440, height: 900 },
    );
    await page.goto('/?fixture');
    await page.getByRole('textbox', { name: 'New note Markdown' }).waitFor();
    if (large)
      await page.addStyleTag({
        content: ':root { font-size: 24px !important }',
      });
    await page.keyboard.press('Meta+n');
    await page.keyboard.press('Meta+n');
    const row = page
      .locator('.tree-row')
      .filter({ has: page.getByRole('button', { name: /Collapse tree/ }) })
      .first();
    const dimensions = await row.evaluate((el) => {
      const box = (selector: string) => {
        const r = el.querySelector(selector)!.getBoundingClientRect();
        return { width: r.width, height: r.height, center: r.y + r.height / 2 };
      };
      return {
        chevron: box('.tree-expand svg'),
        stack: box('.tree-link svg'),
        label: box('.tree-name'),
      };
    });
    expect(dimensions.chevron.width).toBe(dimensions.stack.width);
    expect(dimensions.chevron.height).toBe(dimensions.stack.height);
    expect(
      Math.abs(dimensions.chevron.center - dimensions.stack.center),
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(dimensions.label.center - dimensions.stack.center),
    ).toBeLessThanOrEqual(1);
    const sidebar = page.getByRole('complementary', {
      name: 'Editor navigation',
    });
    for (const selector of [
      '.sidebar-search',
      '.tree-navigation > button',
      '.backup-actions button:last-child',
    ]) {
      const centers = await sidebar.locator(selector).evaluate((el) => {
        const svg = el.querySelector('svg')!.getBoundingClientRect();
        const range = document.createRange();
        const text = Array.from(el.childNodes).find(
          (node) =>
            node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
        );
        if (text) range.selectNodeContents(text);
        const label = text
          ? range.getBoundingClientRect()
          : el.querySelector('input')!.getBoundingClientRect();
        return [svg.y + svg.height / 2, label.y + label.height / 2];
      });
      expect(Math.abs(centers[0] - centers[1])).toBeLessThanOrEqual(2);
    }
    await sidebar.getByRole('searchbox').focus();
    await page.screenshot({
      path: `test-results/captures/sidebar-presentation/sidebar-focus-${large ? '150' : 'wide'}.png`,
    });
    await row.hover();
    await page.screenshot({
      path: `test-results/captures/sidebar-presentation/sidebar-hover-${large ? '150' : 'wide'}.png`,
    });
  });
}

for (const large of [false, true]) {
  test(`expandable deep row aligns its primary content at ${large ? '150%' : '100%'}`, async ({
    page,
  }) => {
    await page.setViewportSize(
      large ? { width: 800, height: 600 } : { width: 1440, height: 900 },
    );
    await page.goto('/?fixture');
    await page.getByRole('textbox', { name: 'New note Markdown' }).waitFor();
    if (large)
      await page.addStyleTag({
        content: ':root { font-size: 24px !important }',
      });
    for (let i = 0; i < 5; i++) await page.keyboard.press('Meta+n');
    const row = page
      .locator('.tree-row')
      .filter({ has: page.locator('.tree-level', { hasText: 'Level 4' }) });
    await expect(
      row.getByRole('button', { name: /Collapse tree/ }),
    ).toBeVisible();
    const centers = await row.evaluate((el) => {
      const center = (selector: string) => {
        const r = el.querySelector(selector)!.getBoundingClientRect();
        return r.y + r.height / 2;
      };
      return {
        chevron: center('.tree-expand svg'),
        stack: center('.tree-link svg'),
        name: center('.tree-name'),
      };
    });
    expect(Math.abs(centers.chevron - centers.stack)).toBeLessThanOrEqual(1);
    expect(Math.abs(centers.stack - centers.name)).toBeLessThanOrEqual(1);
    await row.hover();
    await page.screenshot({
      path: `test-results/captures/sidebar-presentation/sidebar-deep-${large ? '150' : 'wide'}.png`,
    });
  });
}

test('tree creation and note capture have distinct shortcuts and preserve the draft', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.goto('/?fixture');
  const editor = page.getByRole('region', {
    name: 'Notes editor',
    exact: true,
  });
  const capture = editor.getByRole('textbox', {
    name: 'New note Markdown',
    exact: true,
  });
  await capture.fill('unfinished **draft');
  await expect(page.getByRole('status')).toHaveText('Draft saved');
  await expect(page.getByRole('article')).toHaveCount(0);
  const shortcuts = page.getByLabel('Keyboard shortcuts');
  await expect(
    shortcuts.locator('div').filter({ hasText: 'New tree' }),
  ).toContainText('N');
  await expect(
    shortcuts.locator('div').filter({ hasText: 'Write a note' }),
  ).toContainText('Space');
  await page.getByRole('region', { name: 'Note stream', exact: true }).focus();
  await page.keyboard.press('Space');
  await expect(capture).toBeFocused();
  await expect(capture).toHaveText('unfinished **draft');
  await page.keyboard.press('Meta+n');
  await expect(
    page.getByRole('button', { name: 'Open tree Untitled', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('searchbox', { name: 'Search saved notes' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Root', exact: true }).click();
  await expect(capture).toHaveText('unfinished **draft');
  await expect(editor.locator('.stream-header')).toContainText('1 note');
});
