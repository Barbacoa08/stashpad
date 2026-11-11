import { test, expect } from '@playwright/test';

test('stream scrolls independently and constrained text remains reachable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto('/?fixture&visual');
  await page.addStyleTag({ content: ':root { font-size: 24px !important; }' });
  const stream = page.getByRole('region', { name: 'Note stream' });
  const composer = page.getByRole('textbox', { name: 'Capture Markdown' });
  await expect(composer).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save note' })).toBeVisible();
  const bounds = await page.evaluate(() => ({
    page:
      document.documentElement.scrollWidth <=
      document.documentElement.clientWidth,
    stream: (() => {
      const s = document.querySelector('.note-stream')!;
      return s.scrollHeight > s.clientHeight;
    })(),
    code: [...document.querySelectorAll('.code-block')].every(
      (el) =>
        el.getBoundingClientRect().right <=
        el.closest('.note-card[data-kind="note"]')!.getBoundingClientRect()
          .right +
          1,
    ),
  }));
  expect(bounds).toEqual({ page: true, stream: true, code: true });
  const backup = page.getByRole('button', { name: 'Export backup' });
  await backup.scrollIntoViewIfNeeded();
  const backupBox = await backup.boundingBox();
  expect(
    backupBox && backupBox.y >= 0 && backupBox.y + backupBox.height <= 600,
  ).toBe(true);
  await backup.focus();
  await expect(backup).toBeFocused();
  await page.getByRole('region', { name: 'Note stream' }).focus();
  await page.keyboard.press('Space');
  await expect(composer).toBeFocused();
  const before = await composer.boundingBox();
  await stream.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  expect((await composer.boundingBox())?.y).toBe(before?.y);
  await page.getByRole('button', { name: 'Select note' }).last().focus();
  await expect(
    page.getByRole('button', { name: 'Select note' }).last(),
  ).toBeFocused();
  expect(
    await page
      .getByRole('button', { name: 'Select note' })
      .last()
      .evaluate((el) => getComputedStyle(el).outlineStyle),
  ).not.toBe('none');
});
