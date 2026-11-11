import { test, expect } from '@playwright/test';
const replace = async (page: import('@playwright/test').Page, text: string) => {
  const e = page.getByRole('textbox', { name: 'Markdown source' });
  await e.focus();
  await e.press('Meta+a');
  await page.keyboard.insertText(text);
};
const edit = (page: import('@playwright/test').Page) =>
  page.getByRole('textbox', { name: 'Markdown source' });
test.beforeEach(async ({ page }) => {
  await page.goto('/?fixture');
  await expect(edit(page)).toBeVisible();
});
test('visible live emphasis, combined markers, code fences, and dangling source', async ({
  page,
}) => {
  const editor = edit(page);
  const source =
    '*italic* **bold** ***both***\n\n```js\nconst value = "*literal*";\n```\n- one\n  - two\n*dangling';
  await replace(page, source);
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__test.controller.state.source),
    )
    .toBe(source);
  await expect(
    editor.locator('.cm-emphasis').getByText('italic', { exact: true }),
  ).toBeVisible();
  await expect(
    editor.locator('.cm-strong').getByText('bold', { exact: true }),
  ).toBeVisible();
  await expect(
    editor.locator('.cm-emphasis.cm-strong').getByText('both', { exact: true }),
  ).toBeVisible();
  await expect(
    editor
      .locator('.cm-line')
      .filter({ hasText: 'const value' })
      .locator('.cm-emphasis'),
  ).toHaveCount(0);
  await expect(
    editor
      .locator('.cm-line')
      .filter({ hasText: '*dangling' })
      .locator('.cm-emphasis'),
  ).toHaveCount(0);
  await replace(page, 'plain');
  await expect(editor.locator('.cm-emphasis')).toHaveCount(0);
});
test('Enter is multiline, source survives select/copy/paste and undo/redo', async ({
  page,
}) => {
  const editor = edit(page);
  await replace(page, 'α **bold**  ');
  await editor.press('End');
  await editor.press('Enter');
  await editor.press('x');
  await expect(editor).toHaveText('α **bold**  \nx');
  await editor.press('Meta+z');
  await expect(editor).not.toContainText('x');
  await editor.press('Meta+Shift+z');
  await expect(editor).toContainText('x');
  await expect(page.getByRole('button', { name: 'Saved notes' })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole('list', { name: 'Saved notes' }).getByRole('button'),
  ).toHaveCount(0);
});

test('clipboard copies exact Markdown, pastes it, and IME Enter never submits', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const editor = edit(page);
  const source =
    'α **bold**  \n- one\n  - nested\n```js\nlet x="*literal*";\n```\n';
  await replace(page, source);
  await editor.press('Meta+a');
  await editor.press('Meta+c');
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(source);
  await replace(page, '');
  await editor.press('Meta+v');
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__test.controller.state.source),
    )
    .toBe(source);
  await editor.dispatchEvent('keydown', {
    key: 'Enter',
    metaKey: true,
    isComposing: true,
  });
  await expect(
    page.getByRole('list', { name: 'Saved notes' }).getByRole('button'),
  ).toHaveCount(0);
});

test('Command Enter persists exact Markdown without adding a line', async ({
  page,
}) => {
  const editor = edit(page);
  const source = 'one\ntwo';
  await replace(page, source);
  await editor.press('Meta+Enter');
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).__test.repo.snapshot.notes[0]?.markdown,
      ),
    )
    .toBe(source);
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__test.controller.state.source),
    )
    .toBe(source);
});
