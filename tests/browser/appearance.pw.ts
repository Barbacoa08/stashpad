import { expect, test, type Page } from '@playwright/test';

async function openEditor(page: Page) {
  await page.goto('/?fixture&visual');
  await page.getByRole('textbox', { name: 'New note Markdown' }).waitFor();
}

test('saved appearance is applied before the application starts', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.addInitScript(() =>
    localStorage.setItem('scratchtree.appearance', 'dark'),
  );
  // Hold the application bootstrap back while allowing the synchronous
  // preference script to run, so a later mount cannot hide a first-paint bug.
  await page.route('**/*', (route) => {
    const request = route.request();
    if (
      request.resourceType() === 'script' &&
      !new URL(request.url()).pathname.endsWith('/appearance.js')
    )
      return route.abort();
    return route.continue();
  });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark');
  await expect(page.getByRole('combobox', { name: 'Appearance' })).toHaveCount(
    0,
  );
});

test('appearance follows the system and explicit choices persist across reload', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await openEditor(page);
  const appearance = page.getByRole('combobox', {
    name: 'Appearance',
    exact: true,
  });
  await expect(appearance).toHaveValue('system');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await appearance.selectOption('light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.reload();
  await expect(appearance).toHaveValue('light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await appearance.selectOption('system');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('switching appearance preserves composer source and its Undo history', async ({
  page,
}) => {
  await openEditor(page);
  const editor = page.getByRole('textbox', { name: 'New note Markdown' });
  await editor.fill('Unfinished Markdown');
  await editor.press('Meta+a');
  // Formatting is an isolated Undo event, unlike adjacent typing, which
  // CodeMirror can legitimately combine into a single history entry.
  await editor.press('Meta+b');
  const original = await editor.elementHandle();
  const appearance = page.getByRole('combobox', {
    name: 'Appearance',
    exact: true,
  });
  for (const theme of ['light', 'dark']) {
    await appearance.selectOption(theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(editor).toHaveText('**Unfinished Markdown**');
    expect(
      await editor.evaluate((node, prior) => node === prior, original),
    ).toBe(true);
  }
  await editor.focus();
  await page.keyboard.press('Meta+z');
  await expect(editor).toHaveText('Unfinished Markdown');
});

for (const theme of ['light', 'dark']) {
  test(`${theme} appearance has readable surfaces and can capture and edit Markdown`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 960 });
    await openEditor(page);
    await page
      .getByRole('combobox', { name: 'Appearance', exact: true })
      .selectOption(theme);
    const root = page.locator('html');
    await expect(root).toHaveAttribute('data-theme', theme);
    await expect(root).toHaveCSS('color-scheme', theme);
    const background = await root.evaluate((el) =>
      getComputedStyle(el)
        .backgroundColor.match(/[\d.]+/g)!
        .slice(0, 3)
        .map(Number),
    );
    for (const channel of background) {
      if (theme === 'light') expect(channel).toBeGreaterThan(200);
      else expect(channel).toBeLessThan(60);
    }
    const contrast = await page
      .locator('.note-card')
      .first()
      .evaluate((card) => {
        function luminance(color: string) {
          const channels = color
            .match(/[\d.]+/g)!
            .slice(0, 3)
            .map(Number)
            .map((n) => {
              n /= 255;
              return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
            });
          return (
            channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
          );
        }
        const style = getComputedStyle(card);
        const foreground = luminance(style.color);
        const background = luminance(style.backgroundColor);
        return (
          (Math.max(foreground, background) + 0.05) /
          (Math.min(foreground, background) + 0.05)
        );
      });
    expect(contrast).toBeGreaterThanOrEqual(4.5);
    const editor = page.getByRole('textbox', { name: 'New note Markdown' });
    await editor.fill('A **clear** idea with `visible Markdown`');
    await editor.press('Enter');
    const card = page.getByRole('article').last();
    await expect(card).toContainText('A clear idea with visible Markdown');
    await card.dblclick();
    const inline = card.getByRole('textbox');
    await expect(inline).toHaveText('A **clear** idea with `visible Markdown`');
    await expect(inline).toBeFocused();
    await page.screenshot({
      path: `test-results/captures/appearance/${theme}-editing.png`,
    });
    await inline.press('Escape');
    await page.screenshot({
      path: `test-results/captures/appearance/${theme}-overview.png`,
    });
  });
}
