import { test, expect, type Page } from '@playwright/test';
const capture = (p: Page) =>
  p.getByRole('textbox', { name: 'Capture Markdown' });
const inline = (p: Page) => p.getByRole('textbox', { name: 'Edit Markdown' });
const stream = (p: Page) => p.getByRole('region', { name: 'Note stream' });
async function seed(page: Page, sources: string[]) {
  await page.goto('/?fixture');
  await capture(page).waitFor();
  await page.evaluate(async (sources) => {
    const t = (window as any).__test;
    for (const source of sources)
      await t.repo.captureItem({
        id: crypto.randomUUID(),
        location: { scope: 'live', itemId: null },
        markdown: source,
        draft: { key: 'compose', revision: 1 },
      });
    t.repo.snapshot.items
      .filter((x: any) => x.kind === 'note')
      .forEach((n: any, i: number) => (n.createdAt = i));
    await t.controller.start();
  }, sources);
}
for (const mode of ['capture', 'inline'] as const) {
  test(`${mode} fence Enter variants preserve source and contextual hints until outside`, async ({
    page,
  }) => {
    await seed(page, mode === 'inline' ? ['```js\nconst x = 1;\n```'] : []);
    if (mode === 'inline') {
      await page.getByRole('article', { name: 'Saved note' }).click();
      await page.keyboard.press('e');
    }
    const editor = mode === 'inline' ? inline(page) : capture(page);
    const saveButton = page.getByRole('button', {
      name: 'Save note',
      exact: true,
    });
    if (mode === 'capture') {
      await expect(saveButton).toHaveAttribute('title', 'Save note (Enter)');
      await editor.fill('```js\nconst x = 1;\n```');
    }
    await editor.press('Meta+Home');
    await editor.press('ArrowDown');
    await editor.press('End');
    const hint =
      mode === 'inline'
        ? page.getByLabel('Inline editing keys')
        : page.locator('.composer .hint');
    await expect(hint).toContainText('Enter adds a code line');
    if (mode === 'capture')
      await expect(saveButton).toHaveAttribute('title', 'Save note');
    for (const key of ['Enter', 'Shift+Enter', 'Meta+Enter']) {
      await editor.press(key);
      await expect(editor).toBeFocused();
      await expect(editor.locator('.cm-line')).toHaveCount(
        4 + ['Enter', 'Shift+Enter', 'Meta+Enter'].indexOf(key),
      );
    }
    await editor.press('Meta+z');
    await editor.press('Meta+z');
    await editor.press('Meta+z');
    await expect(editor).toHaveText('```jsconst x = 1;```');
    if (mode === 'inline')
      await page.screenshot({
        path: 'test-results/captures/developer-editing/task-2-code-wide.png',
      });
    await editor.press('Meta+End');
    await editor.press('Enter');
    await expect(editor).toBeFocused();
    await expect(hint).toContainText(
      mode === 'inline' ? 'Enter finishes editing' : 'Enter saves',
    );
    if (mode === 'capture')
      await expect(saveButton).toHaveAttribute('title', 'Save note (Enter)');
    await editor.press('Enter');
    if (mode === 'inline') {
      await expect(inline(page)).toHaveCount(0);
      await expect(stream(page)).toBeFocused();
    } else await expect(capture(page)).toHaveText('');
    expect(
      await page.evaluate(
        () =>
          (window as any).__test.repo.snapshot.items.filter(
            (x: any) => x.kind === 'note',
          )[0].markdown,
      ),
    ).toBe('```js\nconst x = 1;\n```\n');
  });
}
test('capture Up at zero selects last visible note, skips child tree, and retains draft history and Escape selection', async ({
  page,
}) => {
  await seed(page, ['first', 'last']);
  await page.evaluate(async () => {
    const t = (window as any).__test;
    const id = crypto.randomUUID();
    await t.repo.createChildTree({
      id,
      parent: { scope: 'live', itemId: null },
    });
    await t.repo.saveItemSource(id, 'Later tree', { key: id, revision: 0 });
    t.repo.snapshot.items.filter((x: any) => x.kind === 'tree')[0].createdAt =
      100;
    await t.controller.start();
  });
  await page.getByRole('article', { name: 'Saved note' }).first().click();
  await capture(page).fill('draft');
  await capture(page).press('Escape');
  await expect(
    page.getByRole('article', { name: 'Saved note' }).first(),
  ).toHaveClass(/selected/);
  await capture(page).focus();
  await capture(page).press('Meta+Home');
  await capture(page).press('ArrowUp');
  await expect(stream(page)).toBeFocused();
  await expect(
    page.getByRole('article', { name: 'Saved note' }).last(),
  ).toHaveClass(/selected/);
  await page.keyboard.press('Space');
  await expect(capture(page)).toHaveText('draft');
  await page.keyboard.insertText('X');
  await capture(page).press('Meta+z');
  await expect(capture(page)).toHaveText('draft');
  await capture(page).press('End');
  await capture(page).press('ArrowUp');
  await expect(capture(page)).toBeFocused();
  await capture(page).press('Meta+a');
  await capture(page).press('ArrowUp');
  await expect(capture(page)).toBeFocused();
  await page.getByRole('searchbox').fill('first');
  await capture(page).focus();
  await capture(page).press('Meta+Home');
  await capture(page).press('ArrowUp');
  await expect(stream(page)).toBeFocused();
  await expect(page.getByRole('article', { name: 'Saved note' })).toHaveClass(
    /selected/,
  );
  await expect(page.getByRole('searchbox')).toHaveValue('first');
  await page.getByRole('searchbox').fill('no result');
  await capture(page).focus();
  await capture(page).press('Meta+Home');
  await capture(page).press('ArrowUp');
  await expect(capture(page)).toBeFocused();
  await page.getByRole('button', { name: 'Root', exact: true }).click();
  await page.keyboard.press('Meta+n');
  await capture(page).fill('child draft');
  await page.getByRole('button', { name: 'Root', exact: true }).click();
  await page.keyboard.press('Space');
  await expect(capture(page)).toHaveText('draft');
  await page.keyboard.insertText('Q');
  await capture(page).press('Meta+z');
  await expect(capture(page)).toHaveText('draft');
});
for (const large of [false, true])
  test(`note bounds and actual edit growth survive acknowledgment at 150%=${large}`, async ({
    page,
  }) => {
    await page.setViewportSize(
      large ? { width: 800, height: 600 } : { width: 1440, height: 900 },
    );
    await seed(page, [
      '[short](https://example.com/' + 'long-source/'.repeat(90) + ')',
      'neighbor',
      'line\n\n'.repeat(90),
    ]);
    if (large)
      await page.addStyleTag({ content: ':root{font-size:24px!important}' });
    const first = page.getByRole('article', { name: 'Saved note' }).first(),
      body = first.locator('.note-body');
    await first.click();
    const before = await body.boundingBox();
    await page.keyboard.press('e');
    await expect(inline(page)).toBeFocused();
    expect(await body.boundingBox()).toEqual(before);
    await inline(page).press('Meta+End');
    await page.keyboard.insertText('\nnew line\n'.repeat(8));
    await expect
      .poll(async () => (await body.boundingBox())!.height)
      .toBeGreaterThan(before!.height);
    const grown = (await body.boundingBox())!.height;
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as any).__test.repo.snapshot.items
            .filter((x: any) => x.kind === 'note')[0]
            .markdown.includes('new line'),
        ),
      )
      .toBe(true);
    expect((await body.boundingBox())!.height).toBe(grown);
    const cap = large ? 576 : 384;
    expect(grown).toBeLessThanOrEqual(cap);
    await expect
      .poll(() =>
        first.locator('.cm-cursor').evaluate((cursor) => {
          const rect = cursor.getBoundingClientRect(),
            viewport = cursor.closest('.note-stream')!.getBoundingClientRect();
          return (
            rect.top >= viewport.top - 1 && rect.bottom <= viewport.bottom + 1
          );
        }),
      )
      .toBe(true);

    await page.screenshot({
      path: `test-results/captures/developer-editing/task-2-edit-${large ? '150' : 'wide'}.png`,
    });
    await inline(page).press('Escape');
    const last = page.getByRole('article', { name: 'Saved note' }).last();
    await expect(last.locator('.note-body')).toHaveCSS(
      'max-height',
      `${cap}px`,
    );
    const expand = last.getByRole('button', {
      name: 'Expand note',
      exact: true,
    });
    await expect(expand).toHaveAttribute('aria-expanded', 'false');
    expect(
      (await last.locator('.note-body').boundingBox())!.height,
    ).toBeLessThanOrEqual(cap);
    await expand.click();
    await expect(
      last.getByRole('button', { name: 'Collapse note', exact: true }),
    ).toHaveAttribute('aria-expanded', 'true');
    expect(
      (await last.locator('.note-body').boundingBox())!.height,
    ).toBeGreaterThan(cap);
    expect(
      (await last.locator('.note-body').boundingBox())!.height,
    ).toBeLessThanOrEqual(cap * 2);
    expect(
      await last
        .locator('.note-body')
        .evaluate((e) => e.scrollHeight > e.clientHeight),
    ).toBe(true);
    await last
      .getByRole('button', { name: 'Collapse note', exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `test-results/captures/developer-editing/task-2-expanded-${large ? '150' : 'wide'}.png`,
    });
    const expandedHeight = (await last.locator('.note-body').boundingBox())!
      .height;
    await last.locator('.note-body').click();
    await page.keyboard.press('e');
    await expect(inline(page)).toBeFocused();
    expect((await last.locator('.note-body').boundingBox())!.height).toBe(
      expandedHeight,
    );
    await expect(last.locator('.note-body')).toHaveCSS('overflow-y', 'hidden');
    expect(
      await last
        .locator('.cm-scroller')
        .evaluate((e) => e.scrollHeight > e.clientHeight),
    ).toBe(true);
    await last
      .getByRole('button', { name: 'Collapse note', exact: true })
      .click();
    await expect(inline(page)).toBeFocused();
    expect(
      (await last.locator('.note-body').boundingBox())!.height,
    ).toBeLessThanOrEqual(cap);
    await inline(page).press('Escape');
  });

test('unchanged edit baseline follows a constrained resize and late text scaling', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const source =
    'A few **styled words** and a [short link](https://example.com/long/source/path). '.repeat(
      16,
    );
  await seed(page, [source, source]);
  const notes = page.getByRole('article', { name: 'Saved note' });
  await notes.first().locator('.note-body').click();
  await page.keyboard.press('e');
  await expect(inline(page)).toBeFocused();
  await page.setViewportSize({ width: 800, height: 600 });
  await page.addStyleTag({ content: ':root{font-size:24px!important}' });
  await expect
    .poll(
      async () =>
        (await notes.first().locator('.note-body').boundingBox())!.height,
    )
    .toBe((await notes.last().locator('.note-body').boundingBox())!.height);
  expect(
    await notes
      .first()
      .locator('.note-body')
      .evaluate((e) => e.scrollHeight > e.clientHeight),
  ).toBe(false);
  await inline(page).press('Escape');
  await expect(inline(page)).toHaveCount(0);
});

test('expansion uses exact note identity across filters and survives deletion/Undo and resets on backup replacement', async ({
  page,
}) => {
  await seed(page, ['paragraph\n\n'.repeat(90), 'neighbor']);
  const first = page.getByRole('article', { name: 'Saved note' }).first();
  await first.getByRole('button', { name: 'Expand note', exact: true }).click();
  await page.getByRole('searchbox').fill('neighbor');
  await page.getByRole('searchbox').fill('');
  await expect(
    first.getByRole('button', { name: 'Collapse note', exact: true }),
  ).toHaveAttribute('aria-expanded', 'true');
  await first.locator('.note-body').click();
  await page.keyboard.press('Meta+Backspace');
  await page.getByRole('button', { name: 'Undo delete', exact: true }).click();
  await expect(
    first.getByRole('button', { name: 'Collapse note', exact: true }),
  ).toHaveAttribute('aria-expanded', 'true');
  await page.evaluate(() => {
    const t = (window as any).__test;
    t.repo.restoreText = JSON.stringify({
      format: 'scratchtree-alpha',
      version: 7,
      exportedAt: '2026-11-11T00:00:00.000Z',
      library: t.repo.snapshot,
    });
  });
  await page
    .getByRole('button', { name: 'Restore backup', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Replace workspace', exact: true })
    .click();
  await expect(
    first.getByRole('button', { name: 'Expand note', exact: true }),
  ).toHaveAttribute('aria-expanded', 'false');
});

for (const mode of ['capture', 'inline'] as const)
  test(`${mode} selections and composing Enter never submit fenced source`, async ({
    page,
  }) => {
    await seed(
      page,
      mode === 'inline' ? ['before\n> ```js\n> x\n> ```\nafter'] : [],
    );
    if (mode === 'inline') {
      await page.getByRole('article', { name: 'Saved note' }).click();
      await page.keyboard.press('e');
    }
    const editor = mode === 'inline' ? inline(page) : capture(page);
    const source = 'before\n> ```js\n> x\n> ```\nafter';
    if (mode === 'capture') await editor.fill(source);
    await editor.press('Meta+Home');
    const hint =
      mode === 'capture'
        ? page.locator('.composer .hint')
        : page.getByLabel('Inline editing keys');
    await expect(hint).toContainText(
      mode === 'capture' ? 'Enter saves' : 'Enter finishes editing',
    );
    await editor.press('ArrowDown');
    await expect(hint).toContainText('Enter adds a code line');
    const prevented = await editor.evaluate(
      (node) =>
        !node.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Enter',
            isComposing: true,
            bubbles: true,
            cancelable: true,
          }),
        ),
    );
    expect(prevented).toBe(false);
    await expect(editor).toBeFocused();
    await editor.press('Meta+a');
    await editor.press('Enter');
    await expect(editor).toBeFocused();
    expect(
      await page.evaluate(
        () =>
          (window as any).__test.repo.snapshot.items.filter(
            (x: any) => x.kind === 'note',
          ).length,
      ),
    ).toBe(mode === 'capture' ? 0 : 1);
    await editor.press('Meta+z');
    await expect
      .poll(() =>
        page.evaluate((mode) => {
          const c = (window as any).__test.controller;
          return c.sourceFor(
            mode === 'capture' ? 'compose' : c.state.activeKey,
          );
        }, mode),
      )
      .toBe(source);
  });

for (const activation of ['click', 'keyboard'] as const)
  test(`narrow code Details ${activation} finishes source and retains truthful selected-note guidance`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 800, height: 600 });
    await seed(page, [
      '```js\nconst value = "synthetic";\n```',
      'another note',
    ]);
    await page.addStyleTag({ content: ':root{font-size:24px!important}' });
    const first = page.getByRole('article', { name: 'Saved note' }).first();
    await first.locator('.note-body').click();
    await page.keyboard.press('e');
    await inline(page).press('Meta+Home');
    await inline(page).press('ArrowDown');
    await inline(page).press('End');
    await page.keyboard.insertText('!');
    const details = page.getByRole('button', { name: /^(Show|Hide) Details$/ });
    if (activation === 'click') await details.click();
    else {
      await details.focus();
      await details.press('Enter');
    }
    await expect(inline(page)).toHaveCount(0);
    await expect(details).toBeFocused();
    const hint = page.getByLabel('Inline editing keys');
    await expect(hint).toContainText('Selected note editing');
    await expect(hint).toContainText('Enter adds a code line');
    expect(
      await page.evaluate(
        () =>
          (window as any).__test.repo.snapshot.items.filter(
            (x: any) => x.kind === 'note',
          )[0].markdown,
      ),
    ).toBe('```js\nconst value = "synthetic";!\n```');
    if (activation === 'click')
      await page.screenshot({
        path: 'test-results/captures/developer-editing/task-2-code-hint-150.png',
      });
    await details.click();
    await first.locator('.note-body').click();
    await page.keyboard.press('e');
    await expect(inline(page)).toBeFocused();
    await page.keyboard.insertText('Q');
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).__test.controller.state.source),
      )
      .toBe('```js\nconst value = "synthetic";!\n```Q');
    await inline(page).press('Meta+z');
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).__test.controller.state.source),
      )
      .toBe('```js\nconst value = "synthetic";!\n```');
    await inline(page).press('Escape');
    await page
      .getByRole('article', { name: 'Saved note' })
      .last()
      .locator('.note-body')
      .click();
    await details.click();
    await expect(hint).toHaveCount(0);
  });
