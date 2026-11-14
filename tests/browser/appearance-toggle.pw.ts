import { expect, test } from '@playwright/test';

test('icon appearance control orders Light, System, Dark and defaults to System', async ({
  page,
}) => {
  await page.goto('/?fixture');
  const group = page.getByRole('group', { name: 'Appearance', exact: true });
  const radios = group.getByRole('radio');
  await expect(radios).toHaveCount(3);
  await expect(radios.nth(0)).toHaveAccessibleName('Light');
  await expect(radios.nth(1)).toHaveAccessibleName('System');
  await expect(radios.nth(2)).toHaveAccessibleName('Dark');
  await expect(radios.nth(1)).toBeChecked();
  await expect(group.locator('svg')).toHaveCount(3);
  await expect(page.getByRole('combobox', { name: 'Appearance' })).toHaveCount(
    0,
  );
});

test('appearance arrow keys change only the preference and retain a single tab stop', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/?fixture');
  const group = page.getByRole('group', { name: 'Appearance', exact: true });
  const system = group.getByRole('radio', { name: 'System', exact: true });
  await system.focus();
  await page.keyboard.press('ArrowRight');
  const dark = group.getByRole('radio', { name: 'Dark', exact: true });
  await expect(dark).toBeFocused();
  await expect(dark).toBeChecked();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.keyboard.press('ArrowRight');
  const light = group.getByRole('radio', { name: 'Light', exact: true });
  await expect(light).toBeFocused();
  await expect(light).toBeChecked();
  await page.keyboard.press('ArrowRight');
  await expect(system).toBeFocused();
  await expect(system).toBeChecked();
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(system).toBeChecked();
  await page.keyboard.press('ArrowDown');
  await expect(dark).toBeChecked();
  await page.keyboard.press('ArrowUp');
  await expect(system).toBeChecked();
  await light.focus();
  await page.keyboard.press('Space');
  await expect(light).toBeChecked();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.keyboard.press('Tab');
  await expect(group.locator(':focus')).toHaveCount(0);
  await expect(page.getByRole('article')).toHaveCount(0);
});

for (const theme of ['light', 'dark']) {
  test(`${theme} icon control has stable geometry, visible focus, and usable targets at 150%`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 800, height: 600 });
    await page.goto('/?fixture');
    await page.addStyleTag({ content: ':root { font-size: 24px !important }' });
    const group = page.getByRole('group', { name: 'Appearance', exact: true });
    const radio = group.getByRole('radio', {
      name: theme === 'light' ? 'Light' : 'Dark',
      exact: true,
    });
    // Sidebar scrolling to reveal an offscreen footer is not layout shift.
    await group.scrollIntoViewIfNeeded();
    const before = await group.boundingBox();
    await radio.check();
    // Pointer focus need not match :focus-visible. Exercise real keyboard
    // navigation before checking the keyboard indicator.
    await radio.press('ArrowRight');
    await page.keyboard.press('ArrowLeft');
    await expect(radio).toBeChecked();
    expect(await group.boundingBox()).toEqual(before);
    const style = await radio.evaluate((input) => {
      const segment = input.nextElementSibling!;
      return {
        outline: getComputedStyle(segment).outlineStyle,
        width: segment.getBoundingClientRect().width,
        height: segment.getBoundingClientRect().height,
      };
    });
    expect(style.outline).toBe('solid');
    expect(style.width).toBeGreaterThanOrEqual(24);
    expect(style.height).toBeGreaterThanOrEqual(24);
  });
}
