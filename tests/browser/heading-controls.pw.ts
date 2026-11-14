import { test, expect, type Page } from '@playwright/test';

async function seed(page: Page, source: string) {
  await page.goto('/?fixture');
  await page.getByRole('textbox', { name: 'New note Markdown' }).waitFor();
  await page.evaluate(async (markdown) => {
    const t = (window as any).__test;
    await t.repo.captureItem({
      id: crypto.randomUUID(),
      location: { scope: 'live', itemId: null },
      markdown,
      draft: { key: 'compose', revision: 1 },
    });
    await t.controller.start();
  }, source);
}

test('saved and editable headings retain six distinct visual levels', async ({
  page,
}) => {
  const source =
    [1, 2, 3, 4, 5, 6].map((n) => `${'#'.repeat(n)} Level ${n}`).join('\n\n') +
    '\n\n```\n# code\n```';
  await seed(page, source);
  const card = page.getByRole('article', { name: 'Saved note' });
  const sizes = ['20px', '18px', '16px', '14px', '13px', '13px'];
  for (let n = 1; n <= 6; n++) {
    const h = card.locator(`.markdown-view h${n}`);
    await expect(h).toHaveCSS('font-size', sizes[n - 1]);
    await expect(h).toHaveCSS(
      'font-weight',
      n === 1 ? '750' : n === 6 ? '600' : '700',
    );
    await expect(h).toHaveCSS('font-style', n === 6 ? 'italic' : 'normal');
  }
  await card.click();
  await page.keyboard.press('e');
  const editor = page.getByRole('textbox', { name: 'Edit Markdown' });
  expect((await editor.locator('.cm-line').allTextContents()).join('\n')).toBe(
    source,
  );
  for (let n = 1; n <= 6; n++) {
    const line = editor.locator('.cm-line').filter({ hasText: `Level ${n}` });
    await expect(line.locator(`.cm-heading-${n}`).last()).toHaveCSS(
      'font-size',
      sizes[n - 1],
    );
    await expect(line).toContainText(`${'#'.repeat(n)} Level ${n}`);
  }
  await expect(
    editor
      .locator('.cm-line')
      .filter({ hasText: '# code' })
      .locator('[class*="cm-heading-"]'),
  ).toHaveCount(0);
});

test('overflow uses a full-width trailing-chevron button at narrow text scaling', async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await seed(
    page,
    Array.from({ length: 80 }, (_, n) => `Line ${n}`).join('\n\n'),
  );
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '150%';
  });
  const card = page.getByRole('article', { name: 'Saved note' });
  const button = card.getByRole('button', { name: 'Expand note' });
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  const widths = await button.evaluate((el) => [
    el.getBoundingClientRect().width,
    el.parentElement!.querySelector('.note-body')!.getBoundingClientRect()
      .width,
  ]);
  expect(widths[0]).toBeCloseTo(widths[1], 0);
  await expect(button.locator('.note-expand-chevron')).toHaveCount(1);
  await button.focus();
  await page.keyboard.press('Enter');
  await expect(
    card.getByRole('button', { name: 'Collapse note' }),
  ).toHaveAttribute('aria-expanded', 'true');
  await expect(
    card.getByRole('button', { name: 'Collapse note' }),
  ).toBeFocused();
  await page.keyboard.press('Space');
  await expect(button).toHaveAttribute('aria-expanded', 'false');
});
