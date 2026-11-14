import { expect, test } from '@playwright/test';

for (const action of [
  'Retry and hide',
  'Keep window open',
  'Hide without saving',
])
  test(`failed close: ${action} retains draft, caret, and usable editor focus`, async ({
    page,
  }) => {
    await page.goto('/?fixture&lifecycle');
    const capture = page.getByRole('textbox', { name: 'New note Markdown' });
    await capture.waitFor();
    await page.evaluate(() => {
      (window as any).__test.repo.fail = 'checkpoint';
    });
    await capture.fill('synthetic close draft');
    await capture.press('ArrowLeft');
    await capture.press('ArrowLeft');
    const caret = await capture.evaluate(
      () => document.getSelection()?.anchorOffset,
    );
    await page.evaluate(() => (window as any).__test.requestClose());
    const recovery = page.getByRole('region', {
      name: 'Could not hide window',
    });
    await expect(recovery).toBeVisible();
    await expect(
      recovery.getByRole('button', { name: 'Retry and hide', exact: true }),
    ).toBeFocused();
    if (action === 'Retry and hide')
      await page.evaluate(() => {
        (window as any).__test.repo.fail = null;
      });
    await recovery.getByRole('button', { name: action, exact: true }).click();
    await expect(recovery).toHaveCount(0);
    await expect(capture).toBeFocused();
    await expect(capture).toHaveText('synthetic close draft');
    expect(
      await capture.evaluate(() => document.getSelection()?.anchorOffset),
    ).toBe(caret);
    const state = await page.evaluate(() => (window as any).__test.windowState);
    expect(state.prevented).toBe(1);
    expect(state.hidden).toBe(action === 'Keep window open' ? 0 : 1);
    await page.keyboard.insertText('!');
    await expect(capture).toHaveText('synthetic close dra!ft');
  });

test('successful close checkpoints the composer without recreating or clearing it', async ({
  page,
}) => {
  await page.goto('/?fixture&lifecycle');
  const capture = page.getByRole('textbox', { name: 'New note Markdown' });
  await capture.fill('**retained** source');
  await capture.press('ArrowLeft');
  const caret = await capture.evaluate(
    () => document.getSelection()?.anchorOffset,
  );
  await page.evaluate(() => (window as any).__test.requestClose());
  await expect(
    page.getByRole('region', { name: 'Could not hide window' }),
  ).toHaveCount(0);
  await expect(capture).toBeFocused();
  await expect(capture).toHaveText('**retained** source');
  expect(
    await capture.evaluate(() => document.getSelection()?.anchorOffset),
  ).toBe(caret);
  const result = await page.evaluate(() => {
    const t = (window as any).__test;
    return {
      state: t.windowState,
      draft: t.repo.snapshot.drafts.find((d: any) => d.key === 'compose')
        ?.markdown,
    };
  });
  expect(result.state.hidden).toBe(1);
  expect(result.draft).toBe('**retained** source');
});

test('a platform hide error offers recovery and successful retry returns focus to the editor', async ({
  page,
}) => {
  await page.goto('/?fixture&lifecycle');
  const capture = page.getByRole('textbox', { name: 'New note Markdown' });
  await capture.fill('retained after hide error');
  await page.evaluate(async () => {
    const t = (window as any).__test;
    t.windowState.failHide = true;
    await t.requestClose();
  });
  const recovery = page.getByRole('region', { name: 'Could not hide window' });
  await expect(recovery).toBeVisible();
  expect(
    await page.evaluate(() => (window as any).__test.windowState.hidden),
  ).toBe(0);
  await page.evaluate(() => {
    (window as any).__test.windowState.failHide = false;
  });
  await recovery.getByRole('button', { name: 'Retry and hide' }).click();
  await expect(recovery).toHaveCount(0);
  await expect(capture).toBeFocused();
  await expect(capture).toHaveText('retained after hide error');
  expect(
    await page.evaluate(() => (window as any).__test.windowState.hideAttempts),
  ).toBe(2);
});
