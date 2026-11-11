import { test, expect } from '@playwright/test';
const replace = async (page: import('@playwright/test').Page, text: string) => {
  const e = page.getByRole('textbox', { name: 'Capture Markdown' });
  await e.focus();
  await e.press('Meta+a');
  await page.keyboard.insertText(text);
};
const edit = (page: import('@playwright/test').Page) =>
  page.getByRole('textbox', { name: 'Capture Markdown' });
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
      format: 'stashpad-alpha',
      version: 1,
      exportedAt: '2026-11-10T00:00:00.000Z',
      workspace: {
        notes: [],
        drafts: [
          {
            key: 'compose',
            markdown: 'restored capture',
            revision: 1,
            updatedAt: 0,
          },
        ],
        undoDeleteId: null,
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
    .getByRole('button', { name: 'Replace workspace', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText('failure');
  await expect(edit(page)).toHaveText('retained compose');
  await page.evaluate(() => {
    (window as any).__test.repo.fail = null;
  });
  await page
    .getByRole('button', { name: 'Replace workspace', exact: true })
    .click();
  await expect(edit(page)).toHaveText('restored capture');
  await expect(page.getByRole('status')).toHaveText('Workspace restored');
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
  await expect(page.getByRole('alert')).toContainText('version 1');
  await expect(edit(page)).toHaveText('prior input');
});
