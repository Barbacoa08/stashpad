import { expect, test, type Page } from '@playwright/test';

async function seed(page: Page, source: string, tree = false) {
  await page.goto('/?fixture');
  await page.getByRole('textbox', { name: 'New note Markdown' }).waitFor();
  await page.evaluate(
    async ({ markdown, tree }) => {
      const t = (window as any).__test;
      t.seed({
        items: [
          {
            id: crypto.randomUUID(),
            markdown,
            kind: tree ? 'tree' : 'note',
            color: 'green',
          },
        ],
        drafts: [],
        undoDeleteIds: [],
      });
      await t.controller.start();
    },
    { markdown: source, tree },
  );
}

async function centerDifference(page: Page, selector: string) {
  return page.locator('.note-card').evaluate((card, target) => {
    const line = card.querySelector(target)!;
    const rect = line.getBoundingClientRect();
    const lineCenter =
      rect.top + parseFloat(getComputedStyle(line).lineHeight) / 2;
    const slot = card.querySelector('.item-slot')!.getBoundingClientRect();
    return Math.abs(slot.top + slot.height / 2 - lineCenter);
  }, selector);
}

for (const [name, source, selector] of [
  ['plain', 'Plain text\n\nSecond paragraph', '.note-rendered p'],
  ...Array.from({ length: 6 }, (_, i) => [
    `heading ${i + 1}`,
    `${'#'.repeat(i + 1)} Heading\n\nBody text`,
    `.note-rendered h${i + 1}`,
  ]),
  [
    'fenced code',
    '```js\nconst x = 1;\nconst y = 2;\n```',
    '.note-rendered .code-line',
  ],
  ['blank first code line', '```\n\nsecond\n```', '.note-rendered .code-line'],
] as const) {
  test(`marker and shared grip center on the first ${name} line`, async ({
    page,
  }) => {
    await seed(page, source, name.startsWith('heading'));
    await expect
      .poll(() => centerDifference(page, selector))
      .toBeLessThanOrEqual(1.25);
    const slot = page.locator('.item-slot');
    const before = await slot.boundingBox();
    await page.locator('.note-card').hover();
    expect(await slot.boundingBox()).toEqual(before);
    const gap = await page.locator('.drag-handle').evaluate((node) => {
      const a = node.getBoundingClientRect();
      const b = node.parentElement!.getBoundingClientRect();
      return Math.abs(a.top + a.height / 2 - b.top - b.height / 2);
    });
    expect(gap).toBeLessThanOrEqual(0.1);
  });
}

test('wrapped headings align to the first line and update after text scaling', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 850, height: 700 });
  await seed(
    page,
    '# A long heading that wraps across several lines in this narrow note card\n\nBody text',
    true,
  );
  await expect
    .poll(() => centerDifference(page, '.note-rendered h1'))
    .toBeLessThanOrEqual(1.25);
  await page.addStyleTag({ content: ':root { font-size: 24px !important; }' });
  await expect
    .poll(() => centerDifference(page, '.note-rendered h1'))
    .toBeLessThanOrEqual(1.25);
  await page.screenshot({ path: testInfo.outputPath('first-line-scaled.png') });
});

test('same-height Markdown changes update the first-line anchor without a resize', async ({
  page,
}) => {
  await seed(page, '# Heading\n\nPlain text', true);
  await expect
    .poll(() => centerDifference(page, '.note-rendered h1'))
    .toBeLessThanOrEqual(1.25);
  const before = await page.locator('.note-body').boundingBox();
  await page.evaluate(async () => {
    const t = (window as any).__test;
    t.repo.snapshot.items[0].markdown = 'Plain text\n\n# Heading';
    await t.controller.start();
  });
  await expect(
    page.locator('.note-rendered .markdown-view > :first-child'),
  ).toHaveText('Plain text');
  expect((await page.locator('.note-body').boundingBox())!.height).toBeCloseTo(
    before!.height,
    1,
  );
  await expect
    .poll(() => centerDifference(page, '.note-rendered p'))
    .toBeLessThanOrEqual(1.25);
});

test('inline formatting and font scaling keep the shared slot centered on the first edit line', async ({
  page,
}) => {
  await seed(page, 'Plain source');
  await page.locator('.note-card').click();
  await page.keyboard.press('e');
  const editor = page.getByRole('textbox', { name: 'Edit Markdown' });
  await editor.press('Meta+a');
  await page.keyboard.insertText('# Live heading');
  const heading = editor.locator('.cm-heading-1').first();
  await expect(heading).toBeVisible();
  async function difference() {
    return page.locator('.note-card').evaluate((card) => {
      const text = card.querySelector('.cm-heading-1')!.getBoundingClientRect();
      const slot = card.querySelector('.item-slot')!.getBoundingClientRect();
      return Math.abs(slot.top + slot.height / 2 - text.top - text.height / 2);
    });
  }
  await expect.poll(difference).toBeLessThanOrEqual(1.25);
  await page.addStyleTag({ content: ':root { font-size: 24px !important; }' });
  await expect.poll(difference).toBeLessThanOrEqual(1.25);
  await editor.press('Escape');
  await expect
    .poll(() => centerDifference(page, '.note-rendered h1'))
    .toBeLessThanOrEqual(1.25);
});

test('returning to the first virtualized edit line refreshes its scaled anchor', async ({
  page,
}) => {
  await seed(
    page,
    '# First heading\n\n' +
      Array.from({ length: 300 }, (_, i) => `Source line ${i}`).join('\n'),
  );
  await page.locator('.note-card').click();
  await page.keyboard.press('e');
  const editor = page.getByRole('textbox', { name: 'Edit Markdown' });
  await expect(editor).toBeFocused();
  await expect
    .poll(() =>
      editor.evaluate(
        (node) =>
          node.closest('.cm-editor')!.querySelector('.cm-scroller')!.scrollTop,
      ),
    )
    .toBeGreaterThan(500);
  await page.addStyleTag({ content: ':root { font-size: 24px !important; }' });
  await editor.press('Meta+Home');
  await expect(editor.locator('.cm-heading-1').first()).toBeVisible();
  await expect
    .poll(() =>
      page.locator('.note-card').evaluate((card) => {
        const text = card
          .querySelector('.cm-heading-1')!
          .getBoundingClientRect();
        const slot = card.querySelector('.item-slot')!.getBoundingClientRect();
        return Math.abs(
          slot.top + slot.height / 2 - text.top - text.height / 2,
        );
      }),
    )
    .toBeLessThanOrEqual(1.25);
});

for (const prefix of ['', '  ']) {
  test(`${prefix ? 'a whitespace-only' : 'an empty'} first editor line keeps its own marker anchor`, async ({
    page,
  }) => {
    await seed(page, prefix + '\nSecond source line');
    await page.locator('.note-card').click();
    await page.keyboard.press('e');
    await expect(
      page.getByRole('textbox', { name: 'Edit Markdown' }),
    ).toBeFocused();
    // E focuses the source end; reveal the first line before comparing its viewport box.
    await page
      .getByRole('textbox', { name: 'Edit Markdown' })
      .press('Meta+Home');
    await expect
      .poll(() =>
        page.locator('.note-card').evaluate((card) => {
          const line = card.querySelector('.cm-line')!.getBoundingClientRect();
          // The slot stays at the document's first-line origin while the editor scrolls.
          const scroll = card.querySelector('.cm-scroller')!.scrollTop;
          const slot = card
            .querySelector('.item-slot')!
            .getBoundingClientRect();
          return Math.abs(
            slot.top + slot.height / 2 - line.top - line.height / 2 - scroll,
          );
        }),
      )
      .toBeLessThanOrEqual(1.25);
  });
}
