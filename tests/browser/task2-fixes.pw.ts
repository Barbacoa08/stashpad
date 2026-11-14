import { test, expect, type Page, type Locator } from '@playwright/test';
const capture = (page: Page) =>
  page.getByRole('textbox', { name: 'New note Markdown' });
const inline = (page: Page) =>
  page.getByRole('textbox', { name: 'Edit Markdown' });
const cards = (page: Page) => page.getByRole('article', { name: 'Saved note' });
async function replace(page: Page, editor: Locator, text: string) {
  await editor.focus();
  await editor.press('Meta+a');
  await page.keyboard.insertText(text);
}
async function prepare(page: Page, mode: 'capture' | 'inline') {
  await page.goto('/?fixture');
  await replace(page, capture(page), 'capture');
  if (mode === 'inline') {
    await capture(page).press('Enter');
    await cards(page)
      .getByRole('button', { name: 'Edit note', exact: true })
      .click();
    await replace(page, inline(page), 'capture edit');
  }
  return mode === 'inline' ? inline(page) : capture(page);
}
for (const mode of ['capture', 'inline'] as const) {
  test(`pending ${mode} save accepts successive keystrokes independently of status copy`, async ({
    page,
  }) => {
    const editor = await prepare(page, mode);
    await page.evaluate(() => (window as any).__test.delay());
    await editor.press('Enter');
    await editor.press('x');
    await editor.press('y');
    const expected = mode === 'inline' ? 'capture editxy' : 'capturexy';
    await expect(editor).toHaveText(expected);
    await expect(editor).toHaveAttribute('contenteditable', 'true');
    if (mode === 'inline') {
      await capture(page).focus();
      await capture(page).press('a');
      await capture(page).press('b');
      await expect(capture(page)).toHaveText('ab');
    }
    await page.evaluate(() => (window as any).__test.release());
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).__test.controller.state.operation),
      )
      .toBeNull();
    if (mode === 'capture') await expect(editor).toHaveText(expected);
    else await expect(inline(page)).toHaveCount(0);
    expect(
      await page.evaluate(
        () =>
          (window as any).__test.repo.snapshot.items.filter(
            (x: any) => x.kind === 'note',
          )[0].markdown,
      ),
    ).toBe(mode === 'inline' ? expected : 'capture');
    if (mode === 'inline') await expect(capture(page)).toHaveText('ab');
  });
  test(`pending ${mode} save preserves newer Search focus after acknowledgment`, async ({
    page,
  }) => {
    const editor = await prepare(page, mode);
    await page.evaluate(() => (window as any).__test.delay());
    await editor.press('Enter');
    const search = page.getByRole('searchbox', { name: 'Search saved notes' });
    await search.fill('cap');
    await expect(search).toBeFocused();
    await page.evaluate(() => (window as any).__test.release());
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as any).__test.repo.snapshot.items.filter(
              (x: any) => x.kind === 'note',
            )[0]?.markdown,
        ),
      )
      .toBe(mode === 'inline' ? 'capture edit' : 'capture');
    await expect(page.getByRole('status')).toHaveText('Saved');
    await expect(search).toBeFocused();
    await page.keyboard.insertText('t');
    await expect(search).toHaveValue('capt');
    await expect(capture(page)).toHaveText('');
    await expect(inline(page)).toHaveCount(0);
  });
}
test('rendered text selection protects Command Backspace while explicit Delete remains usable', async ({
  page,
}) => {
  await prepare(page, 'capture');
  await capture(page).press('Enter');
  await page.getByRole('region', { name: 'Note stream' }).focus();
  const paragraph = cards(page).locator('.markdown-view p');
  await paragraph.evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(
    'capture',
  );
  await page.keyboard.press('Meta+Backspace');
  await expect(cards(page)).toHaveCount(1);
  expect(
    await page.evaluate(
      () => (window as any).__test.repo.snapshot.undoDeleteIds,
    ),
  ).toEqual([]);
  await cards(page)
    .getByRole('button', { name: 'Delete note', exact: true })
    .click();
  await expect(cards(page)).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (window as any).__test.repo.snapshot.undoDeleteIds,
    ),
  ).toHaveLength(1);
});
test('button submission restores normal capture and inline-stream focus without a newer focus choice', async ({
  page,
}) => {
  await prepare(page, 'capture');
  await page.getByRole('button', { name: /^Save note/ }).click();
  await expect(capture(page)).toBeFocused();
  await cards(page)
    .getByRole('button', { name: 'Edit note', exact: true })
    .click();
  await replace(page, inline(page), 'edited');
  await inline(page).press('Enter');
  await expect(page.getByRole('region', { name: 'Note stream' })).toBeFocused();
  await expect(inline(page)).toHaveCount(0);
});
