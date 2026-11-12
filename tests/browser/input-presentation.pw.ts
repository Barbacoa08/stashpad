import { test, expect, type Locator, type Page } from '@playwright/test';

const capture = (page: Page) =>
  page.getByRole('textbox', { name: 'Capture Markdown' });
const cards = (page: Page) => page.getByRole('article', { name: 'Saved note' });

async function checkEditor(editor: Locator) {
  await editor.focus();
  await expect(editor).toBeFocused();
  await expect(
    editor
      .locator('xpath=ancestor::div[contains(@class, "cm-editor")]')
      .locator('.cm-cursor'),
  ).toBeAttached();
  const presentation = await editor.evaluate((el) => {
    const root = el.closest('.cm-editor')!;
    const cursor = root.querySelector('.cm-cursor')!;
    const style = getComputedStyle(cursor);
    const outline = getComputedStyle(root);
    return {
      color: style.borderLeftColor,
      width: style.borderLeftWidth,
      outline: outline.outlineStyle,
      outlineColor: outline.outlineColor,
      background: getComputedStyle(el.closest('.composer, .note-card')!)
        .backgroundColor,
    };
  });
  const luminance = (color: string) => {
    const channels = color
      .match(/\d+/g)!
      .slice(0, 3)
      .map(Number)
      .map((value) => {
        const channel = value / 255;
        return channel <= 0.04045
          ? channel / 12.92
          : ((channel + 0.055) / 1.055) ** 2.4;
      });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const levels = [
    luminance(presentation.color),
    luminance(presentation.background),
  ].sort((a, b) => a - b);
  expect((levels[1] + 0.05) / (levels[0] + 0.05)).toBeGreaterThanOrEqual(3);
  expect(parseFloat(presentation.width)).toBeGreaterThan(0);
  if ((await editor.getAttribute('aria-label')) === 'Capture Markdown') {
    expect(presentation.outline).toBe('none');
    await expect(
      editor.locator('xpath=ancestor::section[contains(@class, "composer")]'),
    ).toHaveCSS('border-top-color', 'rgb(146, 202, 255)');
  } else {
    expect(presentation.outline).toBe('none');
    await expect(editor.locator('xpath=ancestor::article')).toHaveCSS(
      'border-top-color',
      'rgb(146, 202, 255)',
    );
  }
}

test('drawn caret and local focus remain visible in capture and inline editing', async ({
  page,
}) => {
  await page.goto('/?fixture');
  await capture(page).focus();
  await checkEditor(capture(page));
  await page.keyboard.insertText('Synthetic **source**');
  await capture(page).press('Enter');
  await cards(page).first().click();
  await page.keyboard.press('e');
  const inline = page.getByRole('textbox', { name: 'Edit Markdown' });
  await checkEditor(inline);
  await expect(inline).toHaveText('Synthetic **source**');
});

test('copy retains card selection without a stream ring or text range', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/?fixture');
  await capture(page).fill('Synthetic **copy**');
  await capture(page).press('Enter');
  const card = cards(page).first();
  await card.click();
  const stream = page.getByRole('region', { name: 'Note stream' });
  await expect(stream).toBeFocused();
  await page.keyboard.press('c');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    'Synthetic **copy**',
  );
  await expect(card).toHaveClass(/selected/);
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('');
  expect(await stream.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe(
    'none',
  );
  expect(
    await card.evaluate((el) => getComputedStyle(el).borderColor),
  ).not.toBe('rgba(0, 0, 0, 0)');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('e');
  await expect(
    page.getByRole('textbox', { name: 'Edit Markdown' }),
  ).toBeFocused();
  await page.keyboard.insertText('!');
  await expect(
    page.getByRole('textbox', { name: 'Edit Markdown' }),
  ).toContainText('!');
});

test('shortcut hints expose individual keys and plain notes have no marker', async ({
  page,
}) => {
  await page.goto('/?fixture');
  await capture(page).fill('Plain note');
  await capture(page).press('Enter');
  await expect(
    cards(page).first().getByRole('button', { name: 'Select note' }),
  ).toBeEmpty();
  const shortcuts = page.getByLabel('Keyboard shortcuts');
  await expect(
    shortcuts.locator('div').filter({ hasText: 'Search' }).locator('kbd'),
  ).toHaveText(['⌘', '/', '/']);
  await expect(
    shortcuts.locator('div').filter({ hasText: 'Select note' }).locator('kbd'),
  ).toHaveText(['↑', '↓']);
  await expect(
    shortcuts.locator('div').filter({ hasText: 'New stash' }).locator('kbd'),
  ).toHaveText(['⌘', 'N']);
});

for (const constrained of [false, true]) {
  test(`synthetic focus and shortcuts at ${constrained ? '800x600 150%' : 'wide'}`, async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.setViewportSize(
      constrained ? { width: 800, height: 600 } : { width: 1440, height: 900 },
    );
    await page.goto('/?fixture');
    if (constrained)
      await page.addStyleTag({
        content: ':root { font-size: 24px !important; }',
      });
    const stream = page.getByRole('region', { name: 'Note stream' });
    await stream.focus();
    expect(
      await stream.evaluate((el) => getComputedStyle(el).outlineStyle),
    ).not.toBe('none');
    await capture(page).fill('Synthetic focus view');
    await capture(page).press('Enter');
    if (constrained)
      await page.getByRole('button', { name: /^(Show|Hide) Details$/ }).click();
    await expect(page.getByRole('status')).toContainText('Saved');
    if (constrained)
      await page.getByRole('button', { name: /^(Show|Hide) Details$/ }).click();
    await cards(page).first().click();
    await expect(stream).toBeFocused();
    await page.keyboard.press('c');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      'Synthetic focus view',
    );
    await page.keyboard.press('ArrowDown');
    await expect(stream).toHaveCSS('outline-style', 'none');
    await expect(cards(page).first()).toHaveCSS('outline-style', 'solid');
    const composerRoot = page.locator('.composer .cm-editor');
    await expect(composerRoot).not.toHaveClass(/cm-focused/);
    await expect(composerRoot).toHaveCSS('outline-style', 'none');
    await expect(composerRoot.locator('.cm-cursor')).toHaveCSS(
      'display',
      'none',
    );
    await page.screenshot({
      path: `test-results/captures/input-presentation/input-corrected-${constrained ? 'small-150' : 'wide'}.png`,
    });
    await capture(page).focus();
    await expect(capture(page)).toBeFocused();
    await expect(composerRoot).toHaveClass(/cm-focused/);
    await expect(cards(page).first()).toHaveCSS('outline-style', 'none');
    await page.keyboard.insertText('continued');
    await expect(capture(page)).toHaveText('continued');
  });
}

test('shortcut descriptions are exposed as words in the accessibility tree', async ({
  page,
}) => {
  await page.goto('/?fixture');
  await expect(capture(page)).toBeVisible();
  const snapshot = await page.locator('body').ariaSnapshot();
  expect(snapshot).toContain('Search: Command slash, Command F, or slash');
  expect(snapshot).toContain('Shift Enter adds a line');
  expect(snapshot).toContain('Delete selected: Command Backspace');
});
