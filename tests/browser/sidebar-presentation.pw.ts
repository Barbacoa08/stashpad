import { expect, test } from '@playwright/test';

for (const large of [false, true]) {
  test(`sidebar search reserves focus geometry at ${large ? '150%' : '100%'}`, async ({
    page,
  }) => {
    await page.setViewportSize(
      large ? { width: 800, height: 600 } : { width: 1440, height: 900 },
    );
    await page.goto('/?fixture');
    await page.getByRole('textbox', { name: 'Capture Markdown' }).waitFor();
    if (large)
      await page.addStyleTag({
        content: ':root { font-size: 24px !important }',
      });
    const sidebar = page.getByRole('complementary', {
      name: 'Workspace navigation',
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
      sidebar.getByRole('button', { name: 'New stash', exact: true }),
    ).toHaveCount(0);
    await expect(
      sidebar.getByRole('button', { name: 'New note', exact: true }),
    ).toHaveCount(0);
    await expect(page.getByLabel('Keyboard shortcuts')).toContainText(
      'New stash',
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
    await page.getByRole('textbox', { name: 'Capture Markdown' }).waitFor();
    if (large)
      await page.addStyleTag({
        content: ':root { font-size: 24px !important }',
      });
    await page.keyboard.press('Meta+n');
    await page.keyboard.press('Meta+n');
    const row = page
      .locator('.stash-row')
      .filter({ has: page.getByRole('button', { name: /Collapse stash/ }) })
      .first();
    const dimensions = await row.evaluate((el) => {
      const box = (selector: string) => {
        const r = el.querySelector(selector)!.getBoundingClientRect();
        return { width: r.width, height: r.height, center: r.y + r.height / 2 };
      };
      return {
        chevron: box('.stash-expand svg'),
        stack: box('.stash-link svg'),
        label: box('.stash-name'),
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
      name: 'Workspace navigation',
    });
    for (const selector of [
      '.sidebar-search',
      '.stash-navigation > button',
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
    await page.getByRole('textbox', { name: 'Capture Markdown' }).waitFor();
    if (large)
      await page.addStyleTag({
        content: ':root { font-size: 24px !important }',
      });
    for (let i = 0; i < 5; i++) await page.keyboard.press('Meta+n');
    const row = page
      .locator('.stash-row')
      .filter({ has: page.locator('.stash-level', { hasText: 'Level 4' }) });
    await expect(
      row.getByRole('button', { name: /Collapse stash/ }),
    ).toBeVisible();
    const centers = await row.evaluate((el) => {
      const center = (selector: string) => {
        const r = el.querySelector(selector)!.getBoundingClientRect();
        return r.y + r.height / 2;
      };
      return {
        chevron: center('.stash-expand svg'),
        stack: center('.stash-link svg'),
        name: center('.stash-name'),
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
