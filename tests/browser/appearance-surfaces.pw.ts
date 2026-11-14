import { expect, test, type Locator } from '@playwright/test';

async function expectSurface(surface: Locator, theme: string) {
  const channels = await surface.evaluate((el) =>
    getComputedStyle(el)
      .backgroundColor.match(/[\d.]+/g)!
      .slice(0, 3)
      .map(Number),
  );
  for (const channel of channels) {
    if (theme === 'light') expect(channel).toBeGreaterThan(200);
    else expect(channel).toBeLessThan(60);
  }
}

for (const theme of ['light', 'dark']) {
  test(`${theme} palette and move dialog remain usable at 150% text`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 800, height: 600 });
    await page.goto('/?fixture');
    const appearance = page.getByRole('combobox', { name: 'Appearance' });
    await appearance.selectOption(theme);
    await page.addStyleTag({ content: ':root { font-size: 24px !important }' });
    await appearance.focus();
    await expect(appearance).toBeFocused();
    const capture = page.getByRole('textbox', { name: 'New note Markdown' });
    await capture.fill('A **theme** example');
    await capture.press('Enter');
    const card = page.getByRole('article').first();
    await card.click();
    await page.keyboard.press('x');
    await expect(card).toHaveClass(/done/);
    await page.keyboard.press('l');
    const palette = page.getByRole('dialog', { name: 'Assign color' });
    await expectSurface(palette, theme);
    const paletteBox = (await palette.boundingBox())!;
    expect(paletteBox.x).toBeGreaterThanOrEqual(0);
    expect(paletteBox.y).toBeGreaterThanOrEqual(0);
    expect(paletteBox.x + paletteBox.width).toBeLessThanOrEqual(800);
    expect(paletteBox.y + paletteBox.height).toBeLessThanOrEqual(600);
    await palette.getByRole('button', { name: 'Blue', exact: true }).click();
    await expect(palette).toHaveCount(0);
    await page.keyboard.press('m');
    const move = page.getByRole('dialog', { name: 'Move notes' });
    await expectSurface(move, theme);
    await expect(
      move.getByRole('listbox', { name: 'Destination' }),
    ).toBeFocused();
    const dialogBox = (await move.boundingBox())!;
    expect(dialogBox.x).toBeGreaterThanOrEqual(0);
    expect(dialogBox.y).toBeGreaterThanOrEqual(0);
    expect(dialogBox.x + dialogBox.width).toBeLessThanOrEqual(800);
    expect(dialogBox.y + dialogBox.height).toBeLessThanOrEqual(600);
    await page.keyboard.press('Escape');
    await expect(move).toHaveCount(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(800);
  });
}
