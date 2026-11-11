import { test, expect, type Page } from '@playwright/test';
const editor = (page: Page) =>
  page.getByRole('textbox', { name: 'Edit Markdown' });
const capture = (page: Page) =>
  page.getByRole('textbox', { name: 'Capture Markdown' });
const current = (page: Page) =>
  page.evaluate(() => (window as any).__test.controller.state.source);
for (const [name, source] of [
  ['LF', 'line 1\nline 2\nline 3'],
  ['CRLF', 'line 1\r\nline 2\r\nline 3'],
  ['mixed', 'line 1\r\nline 2\nline 3\rline 4'],
] as const)
  test(`${name} source keeps separators through edit, copy, resume, save, and newline history`, async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/?fixture');
    await expect(capture(page)).toBeVisible();
    await page.evaluate(async (markdown) => {
      const t = (window as any).__test;
      t.repo.snapshot.notes = [
        {
          id: '00000000-0000-4000-8000-000000000001',
          markdown,
          createdAt: 0,
          updatedAt: 0,
          stashId: null,
          done: false,
          deletedAt: null,
        },
      ];
      await t.controller.start();
    }, source);
    await page
      .getByRole('button', { name: 'Select note', exact: true })
      .click();
    await page.getByRole('button', { name: 'Edit note', exact: true }).click();
    await editor(page).press('Meta+a');
    await editor(page).press('Meta+c');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      source,
    );
    await editor(page).focus();
    await editor(page).press('Meta+Home');
    await editor(page).press('End');
    await editor(page).press('x');
    const edited = source.replace('line 1', 'line 1x');
    await expect.poll(() => current(page)).toBe(edited);
    await editor(page).press('Meta+z');
    await expect.poll(() => current(page)).toBe(source);
    await editor(page).press('Meta+Shift+z');
    await expect.poll(() => current(page)).toBe(edited);
    await page.getByRole('button', { name: /New note/ }).click();
    await page.getByRole('button', { name: 'Edit note', exact: true }).click();
    await page.keyboard.insertText('y');
    await expect
      .poll(() => current(page))
      .toBe(source.replace('line 1', 'line 1xy'));
    await editor(page).press('Meta+z');
    await expect.poll(() => current(page)).toBe(edited);
    await editor(page).press('Meta+a');
    await editor(page).press('Meta+c');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      edited,
    );
    await editor(page).press('Enter');
    expect(
      await page.evaluate(
        () => (window as any).__test.repo.snapshot.notes[0].markdown,
      ),
    ).toBe(edited);
    await page.getByRole('button', { name: 'Edit note', exact: true }).click();
    await editor(page).press('Meta+Home');
    await editor(page).press('End');
    await editor(page).press('Shift+Enter');
    const separator = name === 'LF' ? '\n' : '\r\n';
    const inserted = edited.replace('line 1x', 'line 1x' + separator);
    await expect.poll(() => current(page)).toBe(inserted);
    await editor(page).press('Meta+z');
    await expect.poll(() => current(page)).toBe(edited);
    await editor(page).press('Meta+Shift+z');
    await expect.poll(() => current(page)).toBe(inserted);
    await editor(page).press('Backspace');
    await expect.poll(() => current(page)).toBe(edited);
    await editor(page).press('Meta+z');
    await expect.poll(() => current(page)).toBe(inserted);
    await editor(page).press('Meta+Shift+z');
    await expect.poll(() => current(page)).toBe(edited);
  });
test('raw mixed clipboard payload keeps separators when available before normalization', async ({
  page,
}) => {
  await page.goto('/?fixture');
  await expect(capture(page)).toBeVisible();
  const source = 'paste\r\nsecond\nthird\rlast';
  await capture(page).focus();
  await capture(page).evaluate((node, text) => {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    node.dispatchEvent(
      new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      }),
    );
  }, source);
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__test.controller.sourceFor('compose'),
      ),
    )
    .toBe(source);
  await capture(page).press('Enter');
  expect(
    await page.evaluate(
      () => (window as any).__test.repo.snapshot.notes[0].markdown,
    ),
  ).toBe(source);
});

test('raw text input preserves the separators exposed by the browser beforeinput payload', async ({
  page,
}) => {
  await page.goto('/?fixture');
  await expect(capture(page)).toBeVisible();
  const source = 'typed\r\nsecond\nthird\rlast';
  await capture(page).evaluate((node) =>
    node.addEventListener(
      'beforeinput',
      (event) => {
        (window as any).__rawInput = (event as InputEvent).data;
      },
      { once: true },
    ),
  );
  await capture(page).focus();
  await page.keyboard.insertText(source);
  const payload = await page.evaluate(() => (window as any).__rawInput);
  expect(payload).toBe(source);
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__test.controller.sourceFor('compose'),
      ),
    )
    .toBe(source);
});
