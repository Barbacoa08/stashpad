import { test, expect } from '@playwright/test';

for (const scale of [1, 1.5]) {
  test(`compact palette geometry at ${scale * 100}% text`, async ({
    page,
    browserName,
  }) => {
    await page.goto('/?fixture');
    await page.getByRole('textbox', { name: 'Capture Markdown' }).waitFor();
    await page.evaluate(async (scale) => {
      document.documentElement.style.fontSize = `${16 * scale}px`;
      const t = (window as any).__test;
      const id = crypto.randomUUID();
      await t.repo.captureItem({
        id,
        location: { scope: 'live', itemId: null },
        markdown: 'Synthetic palette',
        draft: { key: 'compose', revision: 0 },
      });
      await t.controller.start();
      document.querySelector<HTMLElement>(`[data-entry-id="${id}"]`)!.click();
      await t.controller.setItemColor(id, 'red');
    }, scale);
    await page.keyboard.press('l');
    const palette = page.getByRole('dialog', { name: 'Assign color' });
    const grid = palette.getByRole('grid');
    await expect(grid.getByRole('row')).toHaveCount(5);
    const buttons = grid.getByRole('button');
    await expect(buttons).toHaveCount(10);
    const panel = (await palette.boundingBox())!;
    expect(panel.width).toBeLessThanOrEqual(76 * scale);
    expect(panel.height).toBeLessThanOrEqual(164 * scale);
    expect(panel.x + panel.width).toBeLessThanOrEqual(1280);
    expect(panel.y + panel.height).toBeLessThanOrEqual(720);
    const boxes = await buttons.evaluateAll((nodes) =>
      nodes.map((node) => {
        const r = node.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      }),
    );
    for (let i = 0; i < boxes.length; i++) {
      expect(boxes[i].width).toBeGreaterThanOrEqual(24);
      expect(boxes[i].height).toBeGreaterThanOrEqual(24);
      expect(boxes[i].height).toBeLessThanOrEqual(26 * scale);
      if (i % 2 === 1) {
        expect(boxes[i].y).toBe(boxes[i - 1].y);
        expect(boxes[i].x).toBeGreaterThanOrEqual(
          boxes[i - 1].x + boxes[i - 1].width,
        );
      }
      if (i >= 2)
        expect(boxes[i].y).toBeGreaterThanOrEqual(
          boxes[i - 2].y + boxes[i - 2].height,
        );
    }
    const red = buttons.filter({ hasText: '✓' });
    const swatch = (await red.locator('.color-swatch').boundingBox())!;
    const check = (await red.locator('.color-saved').boundingBox())!;
    expect(
      Math.abs(swatch.x + swatch.width / 2 - (check.x + check.width / 2)),
    ).toBeLessThan(2);
    expect(
      Math.abs(swatch.y + swatch.height / 2 - (check.y + check.height / 2)),
    ).toBeLessThan(2);
    await expect(buttons.getByText('↺')).toBeVisible();
    if (process.env.PALETTE_CAPTURE_DIR)
      await palette.screenshot({
        path: `${process.env.PALETTE_CAPTURE_DIR}/${browserName}-${scale}.png`,
      });
    await palette.getByRole('button', { name: 'Reset' }).click();
    await page.keyboard.press('l');
    const reset = palette.getByRole('button', { name: 'Reset' });
    await expect(reset).toHaveAttribute('aria-pressed', 'true');
    await expect(reset.getByText('↺')).toBeVisible();
    await expect(reset.getByText('✓')).toBeVisible();
    if (process.env.PALETTE_CAPTURE_DIR)
      await palette.screenshot({
        path: `${process.env.PALETTE_CAPTURE_DIR}/${browserName}-${scale}-reset.png`,
      });
    await page.evaluate(() => {
      (window as any).__test.repo.fail = 'color';
    });
    await palette.getByRole('button', { name: 'Orange' }).click();
    await expect(palette.getByRole('alert')).toBeVisible();
    if (process.env.PALETTE_CAPTURE_DIR)
      await palette.screenshot({
        path: `${process.env.PALETTE_CAPTURE_DIR}/${browserName}-${scale}-error.png`,
      });
  });
}
