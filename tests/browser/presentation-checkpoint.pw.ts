import { test, expect } from '@playwright/test';

for (const constrained of [false, true]) {
  test(`composer and compact cards reserve geometry at ${constrained ? '150%' : 'normal'}`, async ({
    page,
  }) => {
    await page.setViewportSize(
      constrained ? { width: 800, height: 600 } : { width: 1440, height: 900 },
    );
    await page.goto('/?fixture');
    if (constrained)
      await page.addStyleTag({
        content: ':root { font-size: 24px !important }',
      });
    const capture = page.getByRole('textbox', { name: 'New note Markdown' });
    await capture.waitFor();
    await page.evaluate(async () => {
      const t = (window as any).__test;
      t.seed({
        items: [
          {
            id: '00000000-0000-4000-8000-000000000001',
            kind: 'tree',
            markdown: '<Plain tree>',
            parentId: null,
            createdAt: 1,
            updatedAt: 1,
          },

          {
            id: '00000000-0000-4000-8000-000000000002',
            parentId: null,
            markdown: 'Plain note',
            createdAt: 2,
            updatedAt: 2,
            done: false,
            deletedAt: null,
          },
        ],
        drafts: [],
        undoDeleteIds: [],
      });
      await t.controller.start();
    });
    const composer = page.locator('.composer');
    const before = await composer.boundingBox();
    await capture.focus();
    const after = await composer.boundingBox();
    expect(after).toEqual(before);
    await expect(composer).toHaveCSS('border-top-width', '2px');
    await expect(page.locator('.composer .cm-editor')).toHaveCSS(
      'outline-style',
      'none',
    );
    expect(
      await composer.evaluate((el) => {
        const outer = el.getBoundingClientRect();
        return [
          ...el.querySelectorAll('.cm-editor, .hint, .composer-toolbar'),
        ].every((child) => {
          const r = child.getBoundingClientRect();
          return (
            r.left >= outer.left &&
            r.right <= outer.right &&
            r.top >= outer.top &&
            r.bottom <= outer.bottom
          );
        });
      }),
    ).toBe(true);
    const tree = page.getByRole('article', { name: 'Tree <Plain tree>' });
    const note = page.getByRole('article', { name: 'Saved note' });
    const treeBox = (await tree.boundingBox())!;
    const noteBox = (await note.boundingBox())!;
    expect(Math.abs(treeBox.height - noteBox.height)).toBeLessThanOrEqual(1);
    const baselines = await Promise.all([
      tree
        .locator('.markdown-view p')
        .evaluate((el) => el.getBoundingClientRect().top),
      note
        .locator('.markdown-view p')
        .evaluate((el) => el.getBoundingClientRect().top),
    ]);
    expect(
      Math.abs(baselines[0] - treeBox.y - (baselines[1] - noteBox.y)),
    ).toBeLessThanOrEqual(1);
    await tree.click();
    await expect(tree).toHaveCSS('border-top-width', '2px');
    expect(await tree.boundingBox()).toEqual(treeBox);
    expect(await note.boundingBox()).toEqual(noteBox);
    expect(
      await tree.getByRole('button', { name: 'Edit tree' }).evaluate((el) => {
        const r = el.getBoundingClientRect(),
          card = el.closest('article')!.getBoundingClientRect();
        return (
          r.top >= card.top + 2 &&
          r.bottom <= card.bottom - 2 &&
          r.left >= card.left + 2 &&
          r.right <= card.right - 2
        );
      }),
    ).toBe(true);
    await expect(tree.locator('.tree-icon')).toHaveCount(1);
    await expect(tree.locator('.markdown-view p')).toHaveText('<Plain tree>');
    await expect(
      page.getByRole('navigation', { name: 'Breadcrumbs' }),
    ).toBeVisible();
    await expect(page.locator('.capture-destination')).toHaveCount(0);
    await expect(page.locator('.app-header h1')).toContainText('Root');
    await expect(page.locator('.details-rail > h2')).toHaveText(
      'Details and shortcuts',
    );
    await page.screenshot({
      path: `test-results/captures/presentation-checkpoint/presentation-${constrained ? 'constrained' : 'wide'}.png`,
    });
  });
}
