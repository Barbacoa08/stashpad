import { test, expect, type Page } from '@playwright/test';
const capture = (p: Page) =>
  p.getByRole('textbox', { name: 'Capture Markdown' });
const inline = (p: Page) => p.getByRole('textbox', { name: 'Edit Markdown' });
const stream = (p: Page) => p.getByRole('region', { name: 'Note stream' });
async function seed(p: Page, sources: string[]) {
  await p.goto('/?fixture');
  await capture(p).waitFor();
  await p.evaluate(async (sources) => {
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
test('autosave keeps editor caret and undo; Escape/Enter keep changes, same selection, and immediate E', async ({
  page,
}) => {
  await seed(page, ['**original**']);
  const card = page.locator('.note-card[data-kind="note"]');
  await card.click();
  await page.keyboard.press('e');
  await inline(page).press('End');
  await page.keyboard.insertText('!');
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).__test.repo.snapshot.items.filter(
            (x: any) => x.kind === 'note',
          )[0].markdown,
      ),
    )
    .toBe('**original**!');
  await expect(inline(page)).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.insertText('X');
  await page.keyboard.press('Meta+z');
  await expect(inline(page)).toHaveText('**original**!');
  await page.keyboard.press('Escape');
  await expect(inline(page)).toHaveCount(0);
  await expect(stream(page)).toBeFocused();
  await expect(card).toHaveClass(/selected/);
  await page.keyboard.press('e');
  await expect(inline(page)).toBeFocused();
  await inline(page).fill('');
  await inline(page).press('Enter');
  await expect(inline(page)).toHaveCount(0);
  await expect(card).toHaveCount(1);
  await page.keyboard.press('e');
  await expect(inline(page)).toHaveText('');
  await expect(inline(page)).toBeFocused();
  await expect(card.locator('.cm-cursor')).toBeAttached();
  expect(
    await inline(page).evaluate((el) => el.getBoundingClientRect().height),
  ).toBeGreaterThan(10);
  expect(
    await card.evaluate((el) => el.getBoundingClientRect().height),
  ).toBeGreaterThan(30);
  await page.keyboard.insertText('replacement');
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).__test.repo.snapshot.items.filter(
            (x: any) => x.kind === 'note',
          )[0].markdown,
      ),
    )
    .toBe('replacement');
});
test('click-away preserves actual new target after delayed save and failure retains visible source', async ({
  page,
}) => {
  await seed(page, ['first', 'second']);
  const cards = page.locator('.note-card[data-kind="note"]');
  await cards.first().click();
  await page.keyboard.press('e');
  await page.evaluate(() => (window as any).__test.delay());
  await inline(page).fill('latest first');
  await cards.last().click();
  await expect(cards.last()).toHaveClass(/selected/);
  await page.getByRole('searchbox').fill('second');
  await page.evaluate(() => (window as any).__test.release());
  await expect(inline(page)).toHaveCount(0);
  await expect(page.getByRole('searchbox')).toBeFocused();
  await page.getByRole('searchbox').fill('');
  await cards.first().click();
  await page.keyboard.press('e');
  await page.evaluate(() => ((window as any).__test.repo.fail = 'save'));
  await inline(page).fill('retained failure');
  await capture(page).focus();
  await expect(page.getByRole('alert')).toContainText('failure');
  await expect(inline(page)).toHaveText('retained failure');
  await page.evaluate(() => ((window as any).__test.repo.fail = null));
  await page.getByRole('button', { name: 'Retry checkpoint' }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).__test.repo.snapshot.items.filter(
            (x: any) => x.kind === 'note',
          )[0].markdown,
      ),
    )
    .toBe('retained failure');
});
test('instant Untitled creation uses open parent, deduplicates pending request, and arrows continuously restore exact selection', async ({
  page,
}) => {
  await seed(page, []);
  await page.keyboard.press('Meta+n');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(capture(page)).toBeFocused();
  const parent = await page.evaluate(
    () => (window as any).__test.controller.state.ownerId,
  );
  await page.keyboard.press('Meta+n');
  const child = await page.evaluate(
    () => (window as any).__test.controller.state.ownerId,
  );
  await page.keyboard.press('Meta+n');
  const leaf = await page.evaluate(
    () => (window as any).__test.controller.state.ownerId,
  );
  await capture(page).press('Escape');
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator(`[data-entry-id="${leaf}"]`)).toHaveClass(
    /selected/,
  );
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator(`[data-entry-id="${child}"]`)).toHaveClass(
    /selected/,
  );
  await page.keyboard.press('ArrowRight');
  await expect(page.locator(`[data-entry-id="${leaf}"]`)).toHaveClass(
    /selected/,
  );
  await page.keyboard.press('ArrowRight');
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__test.controller.state.ownerId),
    )
    .toBe(leaf);
  await capture(page).press('Escape');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Meta+n');
  await expect(capture(page)).toBeFocused();
  const created = await page.evaluate(() =>
    (window as any).__test.repo.snapshot.items
      .filter((x: any) => x.kind === 'tree')
      .at(-1),
  );
  expect(created.parentId).toBe(child);
  await capture(page).fill('arrows stay editing');
  await capture(page).press('ArrowLeft');
  await expect(capture(page)).toHaveText('arrows stay editing');
});
for (const large of [false, true])
  test(`inline mode preserves real card/body/neighbor/viewport geometry at 150%=${large}`, async ({
    page,
  }) => {
    await page.setViewportSize(
      large ? { width: 800, height: 600 } : { width: 1440, height: 900 },
    );
    await seed(page, [
      '**emphasis**',
      '- one\n- two',
      '```js\nconst value = 1;\n```',
      '[wrapped source](https://example.com/a/very/long/path/for/internal/source/scrolling) '.repeat(
        16,
      ),
      'neighbor',
    ]);
    if (large)
      await page.addStyleTag({ content: ':root{font-size:24px!important}' });
    const cards = page.locator('.note-card[data-kind="note"]');
    for (let i = 0; i < 4; i++) {
      const card = cards.nth(i);
      await card.scrollIntoViewIfNeeded();
      await card.click({ position: { x: 4, y: 4 } });
      const measure = () =>
        page.evaluate(() => ({
          cards: [
            ...document.querySelectorAll('.note-card[data-kind="note"]'),
          ].map((n) => {
            const r = n.getBoundingClientRect();
            return { x: r.x, y: r.y, w: r.width, h: r.height };
          }),
          bodies: [...document.querySelectorAll('.note-body')].map((n) => {
            const r = n.getBoundingClientRect();
            return { x: r.x, y: r.y, w: r.width, h: r.height };
          }),
          scroll: document.querySelector('.note-stream')!.scrollTop,
        }));
      const before = await measure();
      await page.keyboard.press('e');
      await expect(inline(page)).toBeFocused();
      expect(await measure()).toEqual(before);
      await expect(card.locator('.cm-editor')).toHaveCSS(
        'outline-style',
        'none',
      );
      await expect(card.getByRole('button', { name: 'Save edit' })).toHaveCount(
        0,
      );
      await expect(card.locator('time')).toBeVisible();
      if (i === 3) {
        expect(
          await card
            .locator('.cm-scroller')
            .evaluate((el) => el.scrollHeight > el.clientHeight),
        ).toBe(true);
        await card
          .locator('.cm-scroller')
          .evaluate((el) => (el.scrollTop = el.scrollHeight));
        expect(await measure()).toEqual(before);
      }
      await page.keyboard.press('Escape');
      await expect(inline(page)).toHaveCount(0);
      expect(await measure()).toEqual(before);
    }
    await cards.first().click();
    await page.keyboard.press('e');
    await page.screenshot({
      path: `test-results/captures/seamless/task-2-edit-${large ? '150' : 'wide'}.png`,
    });
  });

test('pending instant creation is idempotent and honors a newer Search focus', async ({
  page,
}) => {
  await seed(page, ['saved']);
  await page.locator('.note-card[data-kind="note"]').click();
  await page.keyboard.press('e');
  await inline(page).fill('latest before creation');
  await page.evaluate(() => {
    const t = (window as any).__test;
    t.repo.delayCreate = new Promise<void>((r) => (t.releaseCreate = r));
  });
  await page.keyboard.press('Meta+n');
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__test.controller.state.operation),
    )
    .toBe('create-tree');
  await page.keyboard.press('Meta+n');
  await page.getByRole('searchbox').fill('new intent');
  await page.evaluate(() => (window as any).__test.releaseCreate());
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).__test.repo.snapshot.items.filter(
            (x: any) => x.kind === 'tree',
          ).length,
      ),
    )
    .toBe(2);
  await expect(page.getByRole('searchbox')).toBeFocused();
  await expect(page.getByRole('searchbox')).toHaveValue('new intent');
  expect(
    await page.evaluate(
      () =>
        (window as any).__test.repo.snapshot.items.filter(
          (x: any) => x.kind === 'tree' && x.markdown !== 'Untitled',
        )[0].markdown,
    ),
  ).toBe('latest before creation');
});
test('selected deletion, empty child, and replacement reset navigation memory while search opens the exact owner', async ({
  page,
}) => {
  await seed(page, []);
  await page.evaluate(async () => {
    const t = (window as any).__test;
    const parent = crypto.randomUUID(),
      child = crypto.randomUUID();
    await t.repo.createChildTree({
      id: parent,
      parent: { scope: 'live', itemId: null },
    });
    await t.repo.saveItemSource(parent, 'Parent', { key: parent, revision: 0 });
    await t.repo.createChildTree({
      id: child,
      parent: { scope: 'live', itemId: parent },
    });
    await t.repo.saveItemSource(child, 'Child', { key: child, revision: 0 });
    for (const markdown of ['owned first', 'owned second'])
      await t.repo.captureItem({
        id: crypto.randomUUID(),
        location: { scope: 'live', itemId: parent },
        markdown,
        draft: { key: `compose:${parent}`, revision: 1 },
      });
    t.repo.snapshot.items
      .filter((x: any) => x.kind === 'tree')
      .forEach((s: any, i: number) => (s.createdAt = i));
    t.repo.snapshot.items
      .filter((x: any) => x.kind === 'note')
      .forEach((n: any, i: number) => (n.createdAt = i + 2));
    await t.controller.start();
  });
  await page.locator('.note-card[data-kind="tree"]').click();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('article', { name: 'Tree Child' })).toHaveClass(
    /selected/,
  );
  const childId = await page
    .getByRole('article', { name: 'Tree Child' })
    .getAttribute('data-entry-id');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.note-card[data-kind="note"]')).toHaveCount(0);
  await capture(page).press('Escape');
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator(`[data-entry-id="${childId}"]`)).toHaveClass(
    /selected/,
  );
  await expect(page.locator(`[data-entry-id="${childId}"]`)).toHaveAttribute(
    'data-kind',
    'note',
  );
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  const removed = await page
    .locator('.note-card[data-kind="note"].selected')
    .getAttribute('data-entry-id');
  await page.keyboard.press('Meta+Backspace');
  await expect(page.locator(`[data-entry-id="${removed}"]`)).toHaveCount(0);
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowRight');
  await expect(
    page.locator('.note-card[data-kind="note"].selected'),
  ).toHaveCount(1);
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
  await capture(page).press('Escape');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator(`[data-entry-id="${childId}"]`)).toHaveClass(
    /selected/,
  );
  await expect(page.locator(`[data-entry-id="${childId}"]`)).toHaveAttribute(
    'data-kind',
    'note',
  );
  await page.getByRole('button', { name: 'Root', exact: true }).click();
  await page.getByRole('searchbox').fill('owned');
  const found = page.getByRole('article', { name: 'Saved note' });
  await found.click();
  await page.keyboard.press('e');
  const ownership = await page.evaluate(() => {
    const c = (window as any).__test.controller;
    return [
      c.state.snapshot.items.find(
        (x: any) => x.kind === 'tree' && x.markdown === 'Parent',
      ).id,
      c.state.snapshot.items.find((n: any) => n.id === c.state.activeKey)
        .parentId,
    ];
  });
  expect(ownership[0]).toBe(ownership[1]);
});

for (const laterTyping of [false, true])
  test(`same-editor refocus supersedes delayed blur exit; later typing=${laterTyping}`, async ({
    page,
  }) => {
    await seed(page, ['original']);
    const card = page.locator('.note-card[data-kind="note"]');
    await card.locator('.note-body').click();
    await page.keyboard.press('e');
    await page.evaluate(() => (window as any).__test.delay());
    await inline(page).fill('latest visible source');
    const retained = await inline(page).elementHandle();
    const id = await card.getAttribute('data-note-id');
    await capture(page).click();
    await expect(capture(page)).toBeFocused();
    await inline(page).click();
    await inline(page).press('End');
    if (laterTyping) await page.keyboard.insertText('!');
    const expected = laterTyping
      ? 'latest visible source!'
      : 'latest visible source';
    const caret = await inline(page).evaluate(() => ({
      anchor: window.getSelection()?.anchorOffset,
      focus: window.getSelection()?.focusOffset,
    }));
    await expect(inline(page)).toBeFocused();
    expect(
      await page.evaluate(
        () =>
          (window as any).__test.repo.snapshot.items.filter(
            (x: any) => x.kind === 'note',
          )[0].markdown,
      ),
    ).toBe('original');
    await page.evaluate(() => (window as any).__test.release());
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as any).__test.repo.snapshot.items.filter(
              (x: any) => x.kind === 'note',
            )[0].markdown,
        ),
      )
      .toBe(expected);
    await expect(inline(page)).toBeFocused();
    expect(await retained!.evaluate((el) => el.isConnected)).toBe(true);
    expect(
      await inline(page).evaluate(() => ({
        anchor: window.getSelection()?.anchorOffset,
        focus: window.getSelection()?.focusOffset,
      })),
    ).toEqual(caret);
    await expect(card.locator('.cm-cursor')).toBeAttached();
    expect(
      await page.evaluate(
        () => (window as any).__test.controller.state.activeKey,
      ),
    ).toBe(id);
    await expect(inline(page)).toHaveText(expected);
    expect(
      await page.evaluate(
        () =>
          (window as any).__test.repo.snapshot.items.filter(
            (x: any) => x.kind === 'note',
          ).length,
      ),
    ).toBe(1);
    // A subsequent real blur still finishes, and explicit keys retain their meaning.
    await capture(page).click();
    await expect(inline(page)).toHaveCount(0);
    await expect(capture(page)).toBeFocused();
    await card.getByRole('button', { name: 'Edit note', exact: true }).click();
    await inline(page).press(laterTyping ? 'Enter' : 'Escape');
    await expect(inline(page)).toHaveCount(0);
    await expect(stream(page)).toBeFocused();
  });
