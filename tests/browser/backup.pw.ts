import { test, expect } from '@playwright/test';
const replace = async (page: import('@playwright/test').Page, text: string) => {
  const e = page.getByRole('textbox', { name: 'New note Markdown' });
  await e.focus();
  await e.press('Meta+a');
  await page.keyboard.insertText(text);
};
const edit = (page: import('@playwright/test').Page) =>
  page.getByRole('textbox', { name: 'New note Markdown' });
test('dialog cancellations are neutral, and restore confirmation resets state only on success', async ({
  page,
}) => {
  await page.goto('/?fixture');
  await replace(page, 'retained compose');
  await page.evaluate(() => {
    (window as any).__test.repo.cancelExport = true;
  });
  await page
    .getByRole('button', { name: 'Export backup', exact: true })
    .click();
  await expect(page.getByRole('status')).toHaveText('Export cancelled');
  await expect(edit(page)).toHaveText('retained compose');
  await page.evaluate(() => {
    const t = (window as any).__test;
    t.repo.restoreText = JSON.stringify({
      format: 'scratchtree-alpha',
      version: 7,
      exportedAt: '2026-11-10T00:00:00.000Z',
      library: {
        items: [],
        drafts: [
          {
            key: 'compose',
            markdown: 'restored capture',
            revision: 1,
            updatedAt: 0,
          },
        ],
        undoDeleteIds: [],
      },
    });
  });
  await page
    .getByRole('button', { name: 'Restore backup', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Cancel restore', exact: true })
    .click();
  await expect(edit(page)).toHaveText('retained compose');
  await page
    .getByRole('button', { name: 'Restore backup', exact: true })
    .click();
  await page.evaluate(() => {
    (window as any).__test.repo.fail = 'restore';
  });
  await page
    .getByRole('button', { name: 'Replace library', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText('failure');
  await expect(edit(page)).toHaveText('retained compose');
  await page.evaluate(() => {
    (window as any).__test.repo.fail = null;
  });
  await page
    .getByRole('button', { name: 'Replace library', exact: true })
    .click();
  await expect(edit(page)).toHaveText('restored capture');
  await expect(page.getByRole('status')).toHaveText('Library restored');
});
test('invalid backup reports a safe error before replacement', async ({
  page,
}) => {
  await page.goto('/?fixture');
  await replace(page, 'prior input');
  await page.evaluate(() => {
    (window as any).__test.repo.restoreText = '{"version":99}';
  });
  await page
    .getByRole('button', { name: 'Restore backup', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText('Invalid');
  await expect(edit(page)).toHaveText('prior input');
});

test('restore preview includes tree source and Trash notes in its total without adding the subtotal again', async ({
  page,
}) => {
  await page.goto('/?fixture');
  await edit(page).waitFor();
  await page.evaluate(async () => {
    const t = (window as any).__test;
    const tree = crypto.randomUUID(),
      child = crypto.randomUUID();
    await t.repo.createChildTree({
      id: tree,
      parent: { scope: 'live', itemId: null },
    });
    await t.repo.captureItem({
      id: child,
      location: { scope: 'live', itemId: tree },
      markdown: 'child source',
      draft: { key: `compose:${tree}`, revision: 0 },
    });
    await t.repo.deleteItem(tree);
    t.repo.restoreText = JSON.stringify({
      format: 'scratchtree-alpha',
      version: 7,
      exportedAt: '2026-11-13T00:00:00.000Z',
      library: t.repo.snapshot,
    });
    await t.controller.start();
  });
  await page
    .getByRole('button', { name: 'Restore backup', exact: true })
    .click();
  const confirmation = page.getByRole('region', {
    name: 'Replace library?',
    exact: true,
  });
  await expect(confirmation).toContainText(
    '2 notes, including 1 tree, and 0 drafts.',
  );
  await expect(confirmation).toContainText('including Trash and drafts');
  await confirmation.getByRole('button', { name: 'Cancel restore' }).click();
  await page.getByRole('button', { name: 'Trash', exact: true }).click();
  await page.getByRole('article').click();
  await page.getByRole('button', { name: 'Restore note', exact: true }).click();
  await page.getByRole('button', { name: 'Root', exact: true }).click();
  await expect(
    page.getByRole('article', { name: 'Tree Untitled', exact: true }),
  ).toBeVisible();
});
