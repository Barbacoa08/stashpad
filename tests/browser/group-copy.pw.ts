import { expect, test, type Page } from '@playwright/test';

const card = (page: Page, id: string) =>
  page.locator(`[data-entry-id="${id}"]`);
const sources = [
  '  first **Markdown**\r\nnext  ',
  '# Tree source',
  '```js\nconst x = 1;\n```\n',
];
async function seed(page: Page) {
  await page.addInitScript(() => {
    (window as any).__copies = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        async writeText(text: string) {
          if ((window as any).__copyFails) throw new Error('Clipboard denied');
          (window as any).__copies.push(text);
        },
      },
    });
  });
  await page.goto('/?fixture');
  await page.getByRole('textbox', { name: 'New note Markdown' }).waitFor();
  return page.evaluate(async (markdown) => {
    const t = (window as any).__test;
    const ids = Array.from({ length: 4 }, () => crypto.randomUUID());
    t.seed({
      items: [
        ...markdown.map((source, index) => ({
          id: ids[index],
          markdown: source,
          kind: index === 1 ? 'tree' : 'note',
          position: index,
          createdAt: 3 - index,
        })),
        { id: ids[3], parentId: ids[1], markdown: 'Do not copy descendants' },
      ],
      drafts: [],
      undoDeleteIds: [],
    });
    await t.controller.start();
    return ids;
  }, sources);
}
const copies = (page: Page) => page.evaluate(() => (window as any).__copies);
const selected = (page: Page) =>
  page
    .locator('.note-card.selected')
    .evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-entry-id')),
    );

test('C copies nonadjacent selections in displayed order with one newline and exact source', async ({
  page,
}) => {
  const ids = await seed(page);
  await card(page, ids[2]).click();
  await card(page, ids[0]).click({ modifiers: ['Meta'] });
  await page.getByRole('region', { name: 'Note stream' }).focus();
  await page.keyboard.press('c');
  await expect
    .poll(() => copies(page))
    .toEqual([sources[0] + '\n' + sources[2]]);
  await expect.poll(() => selected(page)).toEqual([ids[0], ids[2]]);
});

test('Copy Markdown copies the selected tree source and sibling, excluding descendants', async ({
  page,
}) => {
  const ids = await seed(page);
  await card(page, ids[1]).click();
  await card(page, ids[2]).click({ modifiers: ['Meta'] });
  await card(page, ids[2])
    .getByRole('button', { name: 'Copy Markdown', exact: true })
    .click();
  await expect
    .poll(() => copies(page))
    .toEqual([sources[1] + '\n' + sources[2]]);
});

test('copy failure preserves group selection and exact source', async ({
  page,
}) => {
  const ids = await seed(page);
  await card(page, ids[0]).click();
  await card(page, ids[2]).click({ modifiers: ['Meta'] });
  await page.evaluate(() => {
    (window as any).__copyFails = true;
  });
  await page.getByRole('region', { name: 'Note stream' }).focus();
  await page.keyboard.press('c');
  await expect(
    page.getByText(
      'Copy failed. Your source is unchanged; retry Copy Markdown.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect.poll(() => selected(page)).toEqual([ids[0], ids[2]]);
  expect(
    await page.evaluate(() =>
      (window as any).__test.repo.snapshot.items
        .slice(0, 3)
        .map((item: any) => item.markdown),
    ),
  ).toEqual(sources);
  await page.evaluate(() => {
    (window as any).__copyFails = false;
  });
  await page.keyboard.press('c');
  await expect
    .poll(() => copies(page))
    .toEqual([sources[0] + '\n' + sources[2]]);
});

test('typing C in an editor does not invoke card copying', async ({ page }) => {
  const ids = await seed(page);
  await card(page, ids[0]).click();
  await page.keyboard.press('e');
  const editor = page.getByRole('textbox', { name: 'Edit Markdown' });
  await expect(editor).toBeFocused();
  await editor.press('c');
  expect(await copies(page)).toEqual([]);
});
