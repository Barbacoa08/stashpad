import { test, expect } from '@playwright/test';

test('remote full replacement resets composer Undo and navigation for reused identities', async ({
  page,
}) => {
  await page.goto('/?fixture');
  const composer = page.getByRole('textbox', { name: 'New note Markdown' });
  await composer.waitFor();
  await composer.fill('Previous draft');
  await composer.press('End');
  await page.keyboard.insertText(' typed');
  await page.evaluate(async () => {
    await (window as any).__test.controller.flush();
  });
  await page.evaluate(async () => {
    await (window as any).__test.remoteReplace({
      items: [],
      drafts: [
        { key: 'compose', markdown: 'Fresh draft', revision: 1, updatedAt: 1 },
      ],
      undoDeleteIds: [],
    });
  });
  await expect(composer).toHaveText('Fresh draft');
  await composer.focus();
  await composer.press('Meta+z');
  await expect(composer).toHaveText('Fresh draft');
});

test('replacement clears earlier valid tree visits even when IDs are reused', async ({
  page,
}) => {
  await page.goto('/?fixture');
  await page.getByRole('textbox', { name: 'New note Markdown' }).waitFor();
  await page.evaluate(async () => {
    const t = (window as any).__test;
    t.seed({
      items: [
        {
          id: '00000000-0000-4000-8000-000000000001',
          markdown: 'Parent',
          kind: 'tree',
        },
        {
          id: '00000000-0000-4000-8000-000000000002',
          markdown: 'Child',
          kind: 'tree',
          parentId: '00000000-0000-4000-8000-000000000001',
        },
      ],
      drafts: [],
      undoDeleteIds: [],
    });
    await t.controller.start();
  });
  await page
    .locator(
      '[data-entry-id="00000000-0000-4000-8000-000000000001"] .note-body',
    )
    .click();
  await page.keyboard.press('ArrowRight');
  await expect(
    page.locator('[data-entry-id="00000000-0000-4000-8000-000000000002"]'),
  ).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(
    page.getByRole('button', { name: 'Back', exact: true }),
  ).toBeEnabled();
  await page.evaluate(async () => {
    const t = (window as any).__test;
    await t.remoteReplace(structuredClone(t.repo.snapshot));
  });
  await expect(
    page.getByRole('button', { name: 'Back', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Forward', exact: true }),
  ).toBeDisabled();
});
