import { test, expect, type Page } from '@playwright/test';
const compose = (p: Page) =>
  p.getByRole('textbox', { name: 'Capture Markdown' });
const inline = (p: Page) => p.getByRole('textbox', { name: 'Edit Markdown' });
async function replace(p: Page, text: string, edit = compose(p)) {
  await edit.focus();
  await edit.press('Meta+a');
  await p.keyboard.insertText(text);
}
const cards = (p: Page) => p.getByRole('article', { name: 'Saved note' });
test.beforeEach(async ({ page }) => {
  await page.goto('/?fixture');
});
test('Enter captures exact source, renders full Markdown, and keeps a cleared focused composer', async ({
  page,
}) => {
  await replace(page, ' **bold**  ');
  await compose(page).press('Enter');
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page).locator('strong')).toHaveText('bold');
  await expect(compose(page)).toHaveText('');
  await expect(compose(page)).toBeFocused();
  expect(
    await page.evaluate(
      () => (window as any).__test.repo.snapshot.notes[0].markdown,
    ),
  ).toBe(' **bold**  ');
  await replace(page, ' \n ');
  await compose(page).press('Enter');
  await expect(cards(page)).toHaveCount(1);
});
test('inline edit resumes, preserves source/caret/undo, and ordinary cancellation removes only its draft', async ({
  page,
}) => {
  await replace(page, '**saved**');
  await compose(page).press('Enter');
  await replace(page, 'capture draft');
  await cards(page)
    .getByRole('button', { name: 'Edit note', exact: true })
    .click();
  await replace(page, '*unfinished*', inline(page));
  await inline(page).press('Home');
  await inline(page).press('ArrowRight');
  await page.getByRole('button', { name: /^New note/ }).click();
  await expect(compose(page)).toHaveText('capture draft');
  await cards(page)
    .getByRole('button', { name: 'Edit note', exact: true })
    .click();
  await page.keyboard.insertText('X');
  await expect(inline(page)).toHaveText('*Xunfinished*');
  await inline(page).press('Meta+z');
  await expect(inline(page)).toHaveText('*unfinished*');
  await inline(page).press('Escape');
  await expect(inline(page)).toHaveCount(0);
  await expect(cards(page).locator('strong')).toHaveText('saved');
  expect(
    await page.evaluate(() =>
      (window as any).__test.repo.snapshot.drafts.filter(
        (d: any) => d.key !== 'compose',
      ),
    ),
  ).toEqual([]);
  await expect(compose(page)).toHaveText('capture draft');
});
test('Shift Enter continues a list; Cmd Enter submits; composing Enter and shortcut letters remain input', async ({
  page,
}) => {
  await replace(page, '- one');
  await compose(page).press('Shift+Enter');
  await page.keyboard.insertText('two');
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__test.controller.sourceFor('compose'),
      ),
    )
    .toBe('- one\n- two');
  await compose(page).dispatchEvent('keydown', {
    key: 'Enter',
    isComposing: true,
  });
  await expect(cards(page)).toHaveCount(0);
  await compose(page).press('Meta+Enter');
  await expect(cards(page).locator('li')).toHaveCount(2);
  await replace(page, 'e c / ');
  await expect(compose(page)).toHaveText('e c / ');
  await compose(page).press('Escape');
  await page.keyboard.press('Space');
  await expect(compose(page)).toBeFocused();
  await page.keyboard.press('Meta+f');
  await expect(page.getByRole('searchbox')).toBeFocused();
  await page.getByRole('searchbox').fill('ec');
  await page.getByRole('searchbox').press('Escape');
  await expect(page.getByRole('searchbox')).toHaveValue('');
  await expect(page.getByRole('region', { name: 'Note stream' })).toBeFocused();
});
test('selection commands edit/copy/delete only outside inputs, and copy uses exact visible source', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await replace(page, 'α **first**  ');
  await compose(page).press('Enter');
  await replace(page, 'second');
  await compose(page).press('Enter');
  await compose(page).press('Escape');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('e');
  await expect(inline(page)).toBeVisible();
  await replace(page, 'draft  \n', inline(page));
  await cards(page)
    .filter({ has: inline(page) })
    .getByRole('button', { name: 'Copy Markdown' })
    .click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    'draft  \n',
  );
  await inline(page).press('Enter');
  await expect(inline(page)).toHaveCount(0);
  await compose(page).press('Escape');
  await page.keyboard.press('c');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    'draft  \n',
  );
  await page.keyboard.press('Meta+Backspace');
  await expect(cards(page)).toHaveCount(1);
  await page.getByRole('button', { name: 'Undo delete', exact: true }).click();
  await expect(cards(page)).toHaveCount(2);
});
test('search retains an active edit outside results and inert content cannot fetch or navigate', async ({
  page,
}) => {
  const requests: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('tracker.invalid')) requests.push(r.url());
  });
  await replace(
    page,
    'alpha\n\n![tracking](https://tracker.invalid/x)\n<script>alert(1)</script>\n\n[unsafe](file:///tmp/x)',
  );
  await compose(page).press('Enter');
  await cards(page).dblclick();
  await replace(page, 'draft', inline(page));
  await page.getByRole('searchbox').fill('missing');
  await expect(inline(page)).toBeVisible();
  await expect(page.getByText('Editing outside search results')).toBeVisible();
  await inline(page).press('Escape');
  await page.getByRole('searchbox').fill('');
  await expect(cards(page).locator('img,script,a')).toHaveCount(0);
  expect(requests).toEqual([]);
  expect(page.url()).toContain('?fixture');
});

test('composition Enter bypasses submission without cancelling the browser composition commit', async ({
  page,
}) => {
  await replace(page, '入力');
  const result = await compose(page).evaluate((node) => {
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
    node.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(result).toBe(false);
  await expect(cards(page)).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      (window as any).__test.controller.sourceFor('compose'),
    ),
  ).toBe('入力');
});

test('saved multiline highlighting keeps distinct code lines, with safe explicit link activation', async ({
  page,
}) => {
  await replace(
    page,
    '```js\n/* multi\n line */\nconst x = "<tag>";\n```\n\n[Reference](https://example.com/docs)',
  );
  await compose(page).press('Enter');
  await expect(cards(page).locator('.code-line')).toHaveCount(3);
  await expect(cards(page).locator('.code-line .code-line')).toHaveCount(0);
  await page.evaluate(() => {
    (window as any).__opens = [];
    window.open = ((url: string) => {
      (window as any).__opens.push(url);
      return null;
    }) as any;
  });
  const link = cards(page).getByRole('link', { name: 'Reference' });
  await link.click({ button: 'middle' });
  expect(await page.evaluate(() => (window as any).__opens)).toEqual([]);
  await link.focus();
  await link.press('Enter');
  expect(await page.evaluate(() => (window as any).__opens)).toEqual([
    'https://example.com/docs',
  ]);
  expect(page.url()).toContain('?fixture');
  await expect(inline(page)).toHaveCount(0);
});

test('delayed capture appends visibly while retaining later typing and editing keeps its stream position', async ({
  page,
}) => {
  await page.goto('/?fixture&visual');
  await page
    .getByRole('region', { name: 'Note stream' })
    .evaluate((node) => (node.scrollTop = 0));
  await replace(page, 'new captured card');
  await page.evaluate(() => (window as any).__test.delay());
  await compose(page).press('Enter');
  await replace(page, 'later capture');
  await page.evaluate(() => (window as any).__test.release());
  const captured = cards(page).filter({ hasText: 'new captured card' });
  await expect(captured).toBeInViewport();
  await expect(compose(page)).toHaveText('later capture');
  await expect(compose(page)).toBeFocused();
  await captured
    .getByRole('button', { name: 'Edit note', exact: true })
    .click();
  await replace(page, 'revised captured card', inline(page));
  await inline(page).press('Enter');
  await expect(cards(page).last()).toContainText('revised captured card');
  await expect(compose(page)).toHaveText('later capture');
});
