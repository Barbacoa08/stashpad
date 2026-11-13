import { test, expect, type Page } from '@playwright/test';
const capture = (page: Page) =>
  page.getByRole('textbox', { name: 'Capture Markdown' });
const inline = (page: Page) =>
  page.getByRole('textbox', { name: 'Edit Markdown' });
const stream = (page: Page) =>
  page.getByRole('region', { name: 'Note stream' });
const cards = (page: Page) => page.getByRole('article', { name: 'Saved note' });
const search = (page: Page) =>
  page.getByRole('searchbox', { name: 'Search saved notes' });
for (const mode of ['capture', 'inline'] as const) {
  test(`${mode} bold/italic use actual source, preserve selection, and Undo independently`, async ({
    page,
  }) => {
    await page.goto('/?fixture');
    await capture(page).fill('word');
    let editor = capture(page);
    if (mode === 'inline') {
      await editor.press('Enter');
      await stream(page).focus();
      await page.keyboard.press('e');
      editor = inline(page);
    }
    await editor.press('Meta+a');
    await editor.press('Meta+b');
    await expect(editor).toHaveText('**word**');
    expect(await page.evaluate(() => getSelection()?.toString())).toBe('word');
    await editor.press('Meta+i');
    await expect(editor).toHaveText('***word***');
    await editor.press('Meta+z');
    await expect(editor).toHaveText('**word**');
    await editor.press('Meta+Shift+z');
    await expect(editor).toHaveText('***word***');
    await editor.press('Meta+b');
    await expect(editor).toHaveText('*word*');
    await editor.press('ArrowRight');
    await editor.press('ArrowLeft');
    await editor.press('Meta+i');
    await expect(editor).toHaveText('word');
    await editor.press('Meta+a');
    await page.keyboard.insertText('`code`');
    await editor.press('Meta+a');
    await editor.press('Meta+b');
    await expect(editor).toHaveText('`code`');
    await editor.dispatchEvent('compositionstart');
    await editor.dispatchEvent('keydown', {
      key: 'b',
      metaKey: true,
      isComposing: true,
    });
    await editor.dispatchEvent('compositionend');
    // CodeMirror view 6.43.15 intentionally ignores Safari's first key for
    // 100 ms after compositionend (ignoreDuringComposition), covering reversed
    // IME confirmation-event order. These synthetic Enter/Escape commands are
    // a later user action, so let that real guard expire before sending them.
    await page.waitForTimeout(120);
    await expect(editor).toHaveText('`code`');
    if (mode === 'inline') {
      await editor.press('Escape');
      expect(
        await page.evaluate(
          () =>
            (window as any).__test.repo.snapshot.items.filter(
              (x: any) => x.kind === 'note',
            )[0].markdown,
        ),
      ).toBe('`code`');
    } else {
      await editor.press('Enter');
      await expect(cards(page)).toHaveCount(1);
    }
  });
}
test('E always places caret at source end while cached Undo and autosave caret survive', async ({
  page,
}) => {
  await page.goto('/?fixture');
  await capture(page).fill('first\nlast');
  await capture(page).press('Meta+Enter');
  await stream(page).focus();
  await page.keyboard.press('e');
  await page.keyboard.insertText('!');
  await expect(inline(page)).toHaveText('firstlast!');
  await inline(page).press('Home');
  await page.keyboard.insertText('x');
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).__test.repo.snapshot.items.filter(
            (x: any) => x.kind === 'note',
          )[0].markdown,
      ),
    )
    .toBe('first\nxlast!');
  await page.keyboard.insertText('y');
  await inline(page).press('Escape');
  await page.keyboard.press('e');
  await page.keyboard.insertText('END');
  await expect(inline(page)).toHaveText('firstxylast!END');
  await inline(page).press('Meta+z');
  await expect(inline(page)).toHaveText('firstxylast!');
  await inline(page).press('Meta+z');
  await expect(inline(page)).toHaveText('firstlast!');
});
test('Command slash searches and Command 1 goes Home from an editor without losing drafts or edits', async ({
  page,
}) => {
  await page.goto('/?fixture');
  await capture(page).fill('saved');
  await capture(page).press('Enter');
  await stream(page).focus();
  await page.keyboard.press('e');
  await page.keyboard.insertText(' latest');
  await inline(page).press('Meta+/');
  await expect(search(page)).toBeFocused();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).__test.repo.snapshot.items.filter(
            (x: any) => x.kind === 'note',
          )[0].markdown,
      ),
    )
    .toBe('saved latest');
  await search(page).press('Escape');
  await stream(page).dispatchEvent('click');
  await page.keyboard.press('Meta+n');
  await expect(capture(page)).toBeFocused();
  await capture(page).fill('stash draft');
  await capture(page).press('Meta+1');
  await expect(page.locator('h1')).toHaveText('Home');
  await expect(stream(page)).toBeFocused();
  // Exiting the empty container demotes it, but its exact composer survives.
  await expect(cards(page)).toHaveCount(2);
  const demoted = cards(page).filter({ hasText: 'Untitled' });
  const id = await demoted.getAttribute('data-entry-id');
  await expect(demoted).toHaveAttribute('data-kind', 'note');
  await demoted.click();
  await page.keyboard.press('ArrowRight');
  await expect(capture(page)).toHaveText('stash draft');
  expect(
    await page.evaluate(
      () => (window as any).__test.controller.state.location.itemId,
    ),
  ).toBe(id);
  expect(
    await page.evaluate(
      () =>
        (window as any).__test.repo.snapshot.items.filter(
          (x: any) => x.kind === 'note',
        ).length,
    ),
  ).toBe(1);
});
for (const scale of [100, 150])
  test(`held Command hints are anchored, noninteractive, and shift no layout at ${scale}%`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto('/?fixture&visual');
    await page.evaluate(
      (scale) => (document.documentElement.style.fontSize = `${scale}%`),
      scale,
    );
    await capture(page).focus();
    const geometry = () =>
      page.evaluate(() =>
        [
          ...document.querySelectorAll(
            '.sidebar-search,.stash-navigation,.note-stream,.composer',
          ),
        ].map((n) => ({
          rect: n.getBoundingClientRect().toJSON(),
          scroll: n.scrollTop,
        })),
      );
    const before = await geometry();
    await page.keyboard.down('Meta');
    await expect(
      page.locator('.command-hint').filter({ hasText: '⌘/' }),
    ).toBeVisible();
    await expect(
      page.locator('.command-hint').filter({ hasText: '⌘1' }),
    ).toBeVisible();
    expect(await geometry()).toEqual(before);
    await expect(capture(page)).toBeFocused();
    expect(
      await page
        .locator('.command-hint')
        .first()
        .evaluate((n) => getComputedStyle(n).pointerEvents),
    ).toBe('none');
    await page.keyboard.up('Meta');
    await expect(page.locator('.command-hint')).toHaveCount(0);
    await page.keyboard.down('Meta');
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await expect(page.locator('.command-hint')).toHaveCount(0);
    await page.keyboard.up('Meta');
    await page.keyboard.down('Meta');
    await page.evaluate(() =>
      document.dispatchEvent(new Event('visibilitychange')),
    );
    await expect(page.locator('.command-hint')).toHaveCount(0);
    await page.keyboard.up('Meta');
  });
