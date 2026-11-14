import { test, expect, type Page } from '@playwright/test';
const capture = (page: Page) =>
  page.getByRole('textbox', { name: 'New note Markdown' });
const inline = (page: Page) =>
  page.getByRole('textbox', { name: 'Edit Markdown' });
const cards = (page: Page) => page.getByRole('article', { name: 'Saved note' });
async function write(page: Page, text: string) {
  await capture(page).focus();
  await capture(page).press('Meta+a');
  await page.keyboard.insertText(text);
  await capture(page).press('Enter');
  await expect(capture(page)).toHaveText('');
}
test('accepted maximum-safe timestamps remain accessible through restore and normal opening', async ({
  page,
}) => {
  await page.goto('/?fixture');
  await expect(capture(page)).toBeVisible();
  await page.evaluate(() => {
    (window as any).__test.repo.restoreText = JSON.stringify({
      format: 'scratchtree-alpha',
      version: 7,
      exportedAt: '2026-11-10T00:00:00.000Z',
      library: {
        items: [
          {
            id: '00000000-0000-4000-8000-000000000001',
            markdown: '**boundary source**  ',
            parentId: null,
            kind: 'note',
            done: false,
            color: null,
            position: 0,
            restoreParentId: null,
            restoreIndex: null,
            createdAt: Number.MAX_SAFE_INTEGER,
            updatedAt: Number.MAX_SAFE_INTEGER,
            deletedAt: null,
          },
        ],
        drafts: [],
        undoDeleteIds: [],
      },
    });
  });
  await page
    .getByRole('button', { name: 'Restore backup', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Replace library?' }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Replace library', exact: true })
    .click();
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page)).toContainText('Date unavailable');
  expect(
    await cards(page).locator('time').first().getAttribute('datetime'),
  ).toBeNull();
  await cards(page).locator('.note-body').click();
  await expect(
    page.getByRole('complementary', { name: 'Note details' }),
  ).toContainText('Created Date unavailable');
  await page.evaluate(async () => {
    await (window as any).__test.controller.start();
  });
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page).locator('strong')).toHaveText('boundary source');
  expect(
    await page.evaluate(
      () =>
        (window as any).__test.repo.snapshot.items.filter(
          (x: any) => x.kind === 'note',
        )[0],
    ),
  ).toMatchObject({
    createdAt: Number.MAX_SAFE_INTEGER,
    updatedAt: Number.MAX_SAFE_INTEGER,
    markdown: '**boundary source**  ',
  });
  await cards(page)
    .getByRole('button', { name: 'Edit note', exact: true })
    .click();
  expect(
    await page.evaluate(() => (window as any).__test.controller.state.source),
  ).toBe('**boundary source**  ');
});
for (const constrained of [false, true])
  test(`selected actions preserve single-line and longer geometry; 150%=${constrained}`, async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.setViewportSize(
      constrained ? { width: 800, height: 600 } : { width: 1145, height: 900 },
    );
    await page.goto('/?fixture');
    if (constrained)
      await page.addStyleTag({ content: ':root {font-size:24px !important;}' });
    await write(
      page,
      'A longer **synthetic** note with enough ordinary text to wrap naturally in a constrained stream.\n\nAnother paragraph stays visible.',
    );
    await write(page, 'Single-line note');
    await write(page, 'Following note');
    const geometry = () =>
      cards(page).evaluateAll((nodes) =>
        nodes.map((node) => ({
          height: node.getBoundingClientRect().height,
          top: (node as HTMLElement).offsetTop,
        })),
      );
    const baseline = await geometry();
    if (!constrained) {
      expect(baseline[1].height).toBeGreaterThanOrEqual(34);
      expect(baseline[1].height).toBeLessThanOrEqual(36);
    }
    const suffix = constrained ? 'small-150' : 'wide';
    await page.screenshot({
      path: `test-results/captures/final-fixes/visual-residual-${suffix}-normal.png`,
    });
    for (const index of [0, 1]) {
      await cards(page).nth(index).locator('.note-body').click();
      expect(await geometry()).toEqual(baseline);
      const card = cards(page).nth(index);
      await card
        .getByRole('button', { name: 'Select note', exact: true })
        .focus();
      for (const name of [
        'Reorder note',
        'Edit note',
        'Mark done',
        'Copy Markdown',
        'Delete note',
      ]) {
        await page.keyboard.press('Tab');
        const action = card.getByRole('button', { name, exact: true });
        await expect(action).toBeFocused();
        expect(
          await action.evaluate((node) => getComputedStyle(node).outlineStyle),
        ).not.toBe('none');
        const visible = await action.evaluate((el) => {
          const target = el.getBoundingClientRect();
          const viewport = el.closest('.note-stream')!.getBoundingClientRect();
          return (
            target.top >= viewport.top &&
            target.bottom <= viewport.bottom &&
            target.left >= viewport.left &&
            target.right <= viewport.right
          );
        });
        expect(visible).toBe(true);
      }
      const bounds = await card.evaluate((node) => {
        const actions = [...node.querySelectorAll('.card-actions button')].map(
          (el) => el.getBoundingClientRect(),
        );
        const card = node.getBoundingClientRect(),
          body = node.querySelector('.markdown-view')!.getBoundingClientRect();
        return {
          contained:
            actions.length === 4 &&
            actions.every(
              (r) =>
                r.left >= card.left &&
                r.right <= card.right &&
                r.top >= card.top &&
                r.bottom <= card.bottom,
            ),
          separate: actions.every(
            (r, i) =>
              r.left >= body.right &&
              actions.every(
                (other, j) =>
                  i === j || r.right <= other.left || other.right <= r.left,
              ),
          ),
        };
      });
      expect(bounds).toEqual({ contained: true, separate: true });
    }
    await page.screenshot({
      path: `test-results/captures/final-fixes/visual-residual-${suffix}-selected.png`,
    });
    const selected = cards(page).nth(1);
    await selected
      .getByRole('button', { name: 'Copy Markdown', exact: true })
      .click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      'Single-line note',
    );
    await selected
      .getByRole('button', { name: 'Edit note', exact: true })
      .press('Enter');
    await expect(inline(page)).toBeFocused();
    await expect(selected.locator('time')).toBeVisible();
    await expect(
      selected.getByRole('button', { name: 'Save edit' }),
    ).toHaveCount(0);
    await page.screenshot({
      path: `test-results/captures/final-fixes/inline-action-${suffix}.png`,
    });
    await inline(page).press('Enter');
    await selected
      .getByRole('button', { name: 'Edit note', exact: true })
      .click();
    await inline(page).press('Escape');
    await selected
      .getByRole('button', { name: 'Delete note', exact: true })
      .click();
    await expect(cards(page)).toHaveCount(2);
    await page
      .getByRole('button', { name: 'Undo delete', exact: true })
      .click();
    await expect(cards(page)).toHaveCount(3);
  });
