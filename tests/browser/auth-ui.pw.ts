import { expect, test } from '@playwright/test';

test('sign-in starts with both fields and a disabled code', async ({
  page,
}) => {
  await page.goto('/?fixture&authFixture');
  await page.getByRole('button', { name: 'Sign in / sign up' }).click();
  const dialog = page.getByRole('dialog', { name: 'Sign in / sign up' });
  await expect(dialog.getByLabel('Email')).toBeEnabled();
  await expect(dialog.getByLabel('Code')).toBeDisabled();
  await expect(
    dialog.getByRole('button', { name: 'Send code' }),
  ).toBeDisabled();
});

test('challenge retains input, locks cancellation while verifying, and returns focus', async ({
  page,
}) => {
  await page.goto('/?fixture&authFixture');
  const trigger = page.getByRole('button', { name: 'Sign in / sign up' });
  await trigger.click();
  const dialog = page.getByRole('dialog');
  const email = dialog.getByLabel('Email');
  const code = dialog.getByLabel('Code');
  await email.fill('synthetic@example.test');
  await dialog.getByRole('button', { name: 'Send code' }).click();
  await expect(dialog.getByText('Sending code…')).toBeVisible();
  await expect(email).toHaveValue('synthetic@example.test');
  await page.evaluate(() =>
    (window as any).authUiFixture.setAuth({ phase: 'code' }),
  );
  await expect(code).toBeFocused();
  await expect(email).toBeDisabled();
  await code.fill('123456');
  await page.evaluate(() =>
    (window as any).authUiFixture.setAuth({ error: 'Wrong code' }),
  );
  await expect(dialog.getByRole('alert')).toHaveText('Wrong code');
  await expect(code).toHaveValue('123456');
  await dialog.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(
    dialog.getByText('Finishing sign in. Please wait.'),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await page.evaluate(() =>
    (window as any).authUiFixture.setAuth({
      phase: 'syncing',
      authenticated: true,
      canCancel: true,
      error: 'Network unavailable',
    }),
  );
  await expect(
    dialog.getByText('Signed in. Initial sync is pending.'),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeFocused();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(trigger).toBeVisible();
});

test('sync status distinguishes unknown confirmation and exposes recovery', async ({
  page,
}) => {
  await page.goto('/?fixture&authFixture');
  await page.getByRole('button', { name: 'Local only' }).click();
  await expect(page.getByText('No sync confirmed yet.')).toBeVisible();
  await page.evaluate(() =>
    (window as any).authUiFixture.setSync({
      state: 'needs-sync',
      detail: 'Offline',
      recoveries: 1,
      lastConfirmed: 1700000000000,
    }),
  );
  await expect(page.getByText('Offline', { exact: true })).toBeVisible();
  await expect(page.getByText(/Last confirmed:/)).toBeVisible();
  await page.getByRole('button', { name: 'Export recovery' }).click();
  await expect(page.getByText('Recovery export requested.')).toBeVisible();
  await page.getByRole('button', { name: 'Retry sync' }).click();
  await expect(page.getByRole('button', { name: 'Syncing' })).toBeVisible();
});

test('unknown email and cancellation keep the challenge editable', async ({
  page,
}) => {
  await page.goto('/?fixture&authFixture');
  const trigger = page.getByRole('button', { name: 'Sign in / sign up' });
  await trigger.click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Email').fill('unknown@example.test');
  await dialog.getByRole('button', { name: 'Send code' }).click();
  await page.evaluate(() =>
    (window as any).authUiFixture.setAuth({
      phase: 'email',
      error: 'That account does not exist. Sign-up is coming soon.',
    }),
  );
  await expect(dialog.getByRole('alert')).toContainText('does not exist');
  await expect(dialog.getByLabel('Email')).toHaveValue('unknown@example.test');
  await expect(dialog.getByLabel('Code')).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
});

test('footer order, themes, focus trap, and screenshots', async ({ page }) => {
  await page.goto('/?fixture&authFixture');
  const nav = page.getByRole('complementary', { name: 'Editor navigation' });
  await expect(
    nav.getByRole('button', { name: 'Sign in / sign up' }),
  ).toBeVisible();
  const names = await nav
    .locator('.backup-actions button, .auth-footer button')
    .allTextContents();
  expect(names.map((name) => name.trim())).toEqual([
    'Trash',
    'Export backup',
    'Restore backup',
    'Undo delete',
    'Sign in / sign up',
  ]);
  await expect(nav.locator('.auth-footer')).toHaveCSS(
    'border-top-width',
    '1px',
  );
  await expect(nav.locator('.appearance-setting')).toHaveCSS(
    'border-top-width',
    '1px',
  );
  for (const theme of ['Light', 'Dark', 'System']) {
    await nav.getByRole('radio', { name: theme }).check();
    await page.getByRole('button', { name: 'Sign in / sign up' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel('Email')).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused();
    await page.screenshot({
      path: `.projects/2026-11-14-dexie-cloud-implementation/auth-${theme.toLowerCase()}.png`,
    });
    await page.keyboard.press('Escape');
  }
});

test('collapsed details keeps sync recovery accessible', async ({ page }) => {
  await page.goto('/?fixture&authFixture');
  await expect(page.getByRole('button', { name: 'Local only' })).toBeVisible();
  await page.evaluate(() =>
    (window as any).authUiFixture.setSync({
      state: 'needs-sync',
      detail: 'Offline',
      recoveries: 1,
    }),
  );
  await page.getByRole('button', { name: 'Hide Details' }).click();
  await page.getByRole('button', { name: 'Needs sync' }).click();
  await expect(page.getByText('Offline', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Export recovery' }),
  ).toBeVisible();
});

test('joining requires an explicit choice and explains recovery', async ({
  page,
}) => {
  await page.goto('/?fixture&authFixture');
  await page.getByRole('button', { name: 'Sign in / sign up' }).click();
  await page.evaluate(() =>
    (window as any).authUiFixture.setAuth({
      phase: 'syncing',
      authenticated: true,
      join: { localNotes: 2, cloudNotes: 3 },
    }),
  );
  const dialog = page.getByRole('dialog');
  await expect(
    dialog.getByText('This Mac has 2 notes. Synced notes: 3.'),
  ).toBeVisible();
  await expect(
    dialog.getByText('This Mac’s notes will be kept in recovery.'),
  ).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: 'Use synced notes' }),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Use synced notes' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Synced notes selected.');
});

test('retained email can be resubmitted and restart clears a prior challenge', async ({
  page,
}) => {
  await page.goto('/?fixture&authFixture');
  const trigger = page.getByRole('button', { name: 'Sign in / sign up' });
  await trigger.click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('Email').fill('retained@example.test');
  await dialog.getByRole('button', { name: 'Send code' }).click();
  await page.evaluate(() =>
    (window as any).authUiFixture.setAuth({
      phase: 'email',
      error: 'Try again',
    }),
  );
  await dialog.getByRole('button', { name: 'Close' }).click();
  await trigger.click();
  dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Email')).toHaveValue('retained@example.test');
  await expect(dialog.getByRole('button', { name: 'Send code' })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Send code' }).click();
  await page.evaluate(() =>
    (window as any).authUiFixture.setAuth({ phase: 'code' }),
  );
  await dialog.getByLabel('Code').fill('123');
  await page.evaluate(() =>
    (window as any).authUiFixture.setAuth({ error: 'Invalid code' }),
  );
  await expect(dialog.getByLabel('Code')).toHaveValue('123');
  await dialog.getByRole('button', { name: 'Start over' }).click();
  await expect(dialog.getByLabel('Email')).toBeEnabled();
  await dialog.getByRole('button', { name: 'Send code' }).click();
  await page.evaluate(() =>
    (window as any).authUiFixture.setAuth({ phase: 'code' }),
  );
  await expect(dialog.getByLabel('Code')).toHaveValue('');
});

test('backdrop respects bounds and verification has a focus target', async ({
  page,
}) => {
  await page.goto('/?fixture&authFixture');
  const trigger = page.getByRole('button', { name: 'Sign in / sign up' });
  await trigger.click();
  const dialog = page.getByRole('dialog');
  const box = (await dialog.boundingBox())!;
  await page.mouse.click(box.x + 3, box.y + 3);
  await expect(dialog).toBeVisible();
  await page.evaluate(() =>
    (window as any).authUiFixture.setAuth({
      phase: 'verifying',
      canCancel: false,
    }),
  );
  await expect(
    dialog.getByText('Finishing sign in. Please wait.'),
  ).toBeFocused();
  await page.mouse.click(1, 1);
  await expect(dialog).toBeVisible();
  await page.evaluate(() =>
    (window as any).authUiFixture.setAuth({ phase: 'email', canCancel: true }),
  );
  await page.mouse.click(1, 1);
  await expect(dialog).toBeHidden();
});

test('unavailable explanation and compact needs-sync are discoverable', async ({
  page,
}) => {
  await page.goto('/?fixture&authFixture');
  await page.getByRole('button', { name: 'Local only' }).waitFor();
  await page.evaluate(() =>
    (window as any).authUiFixture.setAuth({ configured: false }),
  );
  await expect(page.getByText('Sign in is not configured.')).toBeVisible();
  await expect(page.locator('#auth-unavailable')).not.toHaveClass('sr-only');
  await page.evaluate(() =>
    (window as any).authUiFixture.setSync({
      state: 'needs-sync',
      detail: null,
      recoveries: 0,
    }),
  );
  await page.getByRole('button', { name: 'Hide Details' }).click();
  await expect(page.getByRole('button', { name: 'Needs sync' })).toBeVisible();
});

test('restore preview blocks auth until its decision settles', async ({
  page,
}) => {
  await page.goto('/?fixture&authFixture');
  const trigger = page.getByRole('button', { name: 'Sign in / sign up' });
  await trigger.waitFor();
  await page.getByRole('button', { name: 'Export backup' }).click();
  await page.evaluate(() => {
    const t = (window as any).__test;
    t.repo.restoreText = t.repo.exported;
  });
  await page.getByRole('button', { name: 'Restore backup' }).click();
  await expect(
    page.getByRole('button', { name: 'Cancel restore' }),
  ).toBeVisible();
  await expect(trigger).toBeDisabled();
  await trigger.dispatchEvent('click');
  await expect(
    page.getByRole('dialog', { name: 'Sign in / sign up' }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Cancel restore' }).click();
  await expect(trigger).toBeEnabled();
});
